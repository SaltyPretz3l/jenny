'use strict';

/**
 * chat-proposal-binding - the authority/Git/command binding captured when a model proposes an
 * inline Git or command action (row 59 checkpoint 3, contract C3). The binding is stored verbatim
 * on the proposal record; `recheckGitBinding` recaptures it at decision time so any drift between
 * proposal and acceptance makes the proposal stale instead of acting on changed work.
 *
 * Every capture resolves `{ok:true, binding}` or `{ok:false, reason, cause_code}` with reason one
 * of invalid_request | capacity | authority_changed | unavailable. Nothing here logs command text,
 * paths or tokens, and nothing here executes anything.
 */

const fsPromises = require('fs/promises');
const nodePath = require('path');

const { captureGitFacts, sha256Hex } = require('./chat-proposal-git-facts');

const fail = (reason, cause_code) => ({ ok: false, reason, cause_code });

function shellForBackend(backend, platform = process.platform) {
  if (backend === 'docker') return '/bin/sh';
  if (backend === 'native') return platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  return null;
}

function commandSandboxEnabled(backendService) {
  return backendService?.commandSandbox?.enabled === true
    || backendService?.configService?.getState?.()?.commandSandbox?.enabled === true;
}

// Project-authority failures keep one shape: stale -> authority_changed, anything else unavailable.
function authorityFailure(error) {
  const code = String(error?.reason || error?.code || '');
  if (/stale/i.test(code) || /stale/i.test(String(error?.message || ''))) return fail('authority_changed', 'authority_stale');
  if (/not_found|invalid_project/i.test(code)) return fail('invalid_request', 'session_unbound');
  return fail('unavailable', 'authority_unavailable');
}

function trustedFailure(error) {
  if (error?.code === 'run_mode_changed') return fail('authority_changed', 'run_mode_changed');
  if (/authority/i.test(String(error?.message || ''))) return fail('authority_changed', 'authority_stale');
  return fail('unavailable', 'execution_unavailable');
}

function cleanToken(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * C3 common fields. Returns `{ok:true, binding, authority}`; `binding.git` and `binding.command`
 * are null for the kind-specific captures to fill.
 */
function captureCommonBinding({ backendService, sessionId, trusted = null } = {}) {
  const owner = backendService?.projectAuthority;
  if (typeof owner?.captureSession !== 'function') return fail('unavailable', 'authority_unavailable');
  if (typeof trusted?.assertCurrent === 'function') {
    try {
      trusted.assertCurrent();
    } catch (error) {
      return trustedFailure(error);
    }
  }
  let authority;
  try {
    authority = owner.captureSession(sessionId);
  } catch (error) {
    return authorityFailure(error);
  }
  const rootId = cleanToken(authority?.root_id);
  if (!rootId || !cleanToken(authority?.root_path)) return fail('invalid_request', 'no_workspace');
  const revision = authority.root_revision;
  if (!Number.isSafeInteger(revision)) return fail('unavailable', 'authority_unavailable');

  const summary = backendService.sessionStore?.getSessionSummary?.(sessionId) || null;
  const planMode = trusted ? trusted.mode === 'plan' : (summary?.plan_mode === true || summary?.run_mode === 'plan');
  const readOnly = trusted ? trusted.readOnly === true : (planMode || summary?.run_mode === 'propose');
  return {
    ok: true,
    authority,
    binding: {
      source_project_id: cleanToken(authority.project_id),
      workspace_id: rootId,
      root_identity: { root_id: rootId, device_id: authority.device_id ?? null, inode: authority.inode ?? null },
      authority_revision: revision,
      run_mode: planMode ? 'plan' : 'agent',
      restrictions: { read_only: readOnly, plan_mode: planMode },
      model: cleanToken(summary?.preferred_model),
      effort: cleanToken(summary?.reasoning_effort),
      git: null,
      command: null,
    },
  };
}

function authorityStillCurrent(backendService, authority) {
  try {
    backendService.projectAuthority.requireCurrent?.(authority);
    return null;
  } catch (_error) {
    return fail('authority_changed', 'authority_stale');
  }
}

async function captureGitProposalBinding({
  backendService, sessionId, trusted = null, paths, signal = null, budget, now, fs, path,
} = {}) {
  const common = captureCommonBinding({ backendService, sessionId, trusted });
  if (!common.ok) return common;
  let gitService;
  try {
    gitService = backendService.resolveProjectWorkspaceServices?.(common.authority, { sessionId })?.workspaceGitService;
  } catch (error) {
    return authorityFailure(error);
  }
  if (!gitService) return fail('invalid_request', 'git_unavailable');
  const facts = await captureGitFacts({ gitService, paths, signal, budget, now, fs, path });
  if (!facts.ok) return facts;
  const drifted = authorityStillCurrent(backendService, common.authority);
  if (drifted) return drifted;
  return { ok: true, binding: { ...common.binding, git: facts.git } };
}

// Realpath containment of the command cwd: it must exist, be a directory and stay inside the root.
async function resolveCommandCwd(rootPath, cwd, { fs, path }) {
  const value = cwd === undefined || cwd === null ? '.' : cwd;
  if (typeof value !== 'string' || /[\0\r\n]/.test(value) || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)
    || (path.sep === '\\' && value.includes('\\'))) return fail('invalid_request', 'field_cwd');
  const segments = value.split('/').filter((segment) => segment && segment !== '.');
  if (segments.includes('..')) return fail('invalid_request', 'field_cwd');
  let rootReal;
  let real;
  try {
    rootReal = await fs.realpath(rootPath);
    real = await fs.realpath(path.resolve(rootReal, ...segments));
  } catch (error) {
    return fail('invalid_request', error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'cwd_not_found' : 'cwd_unreadable');
  }
  const relative = path.relative(rootReal, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return fail('invalid_request', 'cwd_outside_workspace');
  try {
    if (!(await fs.stat(real)).isDirectory()) return fail('invalid_request', 'cwd_not_directory');
  } catch (_error) {
    return fail('invalid_request', 'cwd_unreadable');
  }
  return { ok: true, cwd: segments.length ? segments.join('/') : '.' };
}

async function captureCommandProposalBinding({
  backendService, sessionId, trusted = null, cwd, command, platform = process.platform,
  fs = fsPromises, path = nodePath,
} = {}) {
  if (typeof command !== 'string' || !command || command.includes('\0')) return fail('invalid_request', 'field_command');
  const common = captureCommonBinding({ backendService, sessionId, trusted });
  if (!common.ok) return common;
  const resolved = await resolveCommandCwd(common.authority.root_path, cwd, { fs, path });
  if (!resolved.ok) return resolved;
  const backend = commandSandboxEnabled(backendService) ? 'docker' : 'native';
  const drifted = authorityStillCurrent(backendService, common.authority);
  if (drifted) return drifted;
  return {
    ok: true,
    binding: {
      ...common.binding,
      command: {
        backend,
        shell: shellForBackend(backend, platform),
        cwd: resolved.cwd,
        command_sha256: sha256Hex(Buffer.from(command, 'utf8')),
      },
    },
  };
}

const PATH_CAUSES = new Set(['path_not_changed', 'path_outside_workspace', 'path_not_file', 'path_unreadable', 'field_paths']);

function recheckCause(failure) {
  if (failure.reason === 'authority_changed') return failure.cause_code === 'root_changed' ? 'root_changed' : 'authority_stale';
  if (failure.reason === 'capacity') return 'binding_budget';
  if (failure.reason === 'invalid_request') return PATH_CAUSES.has(failure.cause_code) ? 'paths_changed' : 'root_changed';
  return 'unavailable';
}

// Root identity, then authority revision: the drift shared by Git and command rechecks.
function commonDrift(stored, current) {
  if (current.workspace_id !== stored.workspace_id
    || current.source_project_id !== stored.source_project_id
    || current.root_identity.root_id !== stored.root_identity?.root_id
    || current.root_identity.device_id !== stored.root_identity?.device_id
    || current.root_identity.inode !== stored.root_identity?.inode) {
    return { ok: false, cause_code: 'root_changed' };
  }
  if (current.authority_revision !== stored.authority_revision) return { ok: false, cause_code: 'authority_stale' };
  return null;
}

/**
 * Recapture a Git binding and compare it with the stored one. `{ok:true}` only when the root,
 * authority revision, ref, HEAD and every selected-path fingerprint are unchanged; otherwise
 * `{ok:false, cause_code}` with root_changed | authority_stale | ref_changed | head_changed |
 * paths_changed (plus binding_budget | unavailable when the recapture itself could not finish).
 */
async function recheckGitBinding(record, { backendService, signal = null, budget, now, fs, path } = {}) {
  const stored = record?.binding;
  const storedPaths = Array.isArray(stored?.git?.paths) ? stored.git.paths.map((fact) => fact?.path) : null;
  if (!stored?.git || !storedPaths || typeof record?.source_session_id !== 'string') {
    return { ok: false, cause_code: 'binding_missing' };
  }
  const common = captureCommonBinding({ backendService, sessionId: record.source_session_id });
  if (!common.ok) return { ok: false, cause_code: recheckCause(common) };
  const drift = commonDrift(stored, common.binding);
  if (drift) return drift;
  const recaptured = await captureGitProposalBinding({
    backendService, sessionId: record.source_session_id, paths: storedPaths, signal, budget, now, fs, path,
  });
  if (!recaptured.ok) return { ok: false, cause_code: recheckCause(recaptured) };
  const current = recaptured.binding.git;
  if (current.ref !== stored.git.ref) return { ok: false, cause_code: 'ref_changed' };
  if (current.head !== stored.git.head) return { ok: false, cause_code: 'head_changed' };
  if (current.fingerprint !== stored.git.fingerprint) return { ok: false, cause_code: 'paths_changed' };
  return { ok: true };
}

const CWD_CAUSES = new Set(['field_cwd', 'cwd_not_found', 'cwd_outside_workspace', 'cwd_not_directory']);

/**
 * Recapture the command binding for the stored cwd and command and compare it with the stored
 * one. `{ok:true}` only when the root, authority revision, backend, shell, cwd and command hash
 * are all unchanged; otherwise `{ok:false, cause_code}` with root_changed | authority_stale |
 * backend_changed | shell_changed | cwd_changed | command_changed, or `unavailable` when the
 * recapture itself could not finish. Reads only; nothing here executes the command.
 */
async function recheckCommandBinding(record, {
  backendService, platform = process.platform, fs = fsPromises, path = nodePath,
} = {}) {
  const stored = record?.binding;
  const command = record?.normalized_input?.command;
  if (!stored?.command || typeof command !== 'string' || typeof record?.source_session_id !== 'string') {
    return { ok: false, cause_code: 'binding_missing' };
  }
  if (sha256Hex(Buffer.from(command, 'utf8')) !== stored.command.command_sha256) {
    return { ok: false, cause_code: 'command_changed' };
  }
  const common = captureCommonBinding({ backendService, sessionId: record.source_session_id });
  if (!common.ok) return { ok: false, cause_code: recheckCause(common) };
  const drift = commonDrift(stored, common.binding);
  if (drift) return drift;
  const recaptured = await captureCommandProposalBinding({
    backendService, sessionId: record.source_session_id, cwd: stored.command.cwd, command, platform, fs, path,
  });
  if (!recaptured.ok) {
    if (recaptured.reason !== 'invalid_request') return { ok: false, cause_code: recheckCause(recaptured) };
    if (recaptured.cause_code === 'cwd_unreadable') return { ok: false, cause_code: 'unavailable' };
    return { ok: false, cause_code: CWD_CAUSES.has(recaptured.cause_code) ? 'cwd_changed' : 'root_changed' };
  }
  const current = recaptured.binding.command;
  if (current.backend !== stored.command.backend) return { ok: false, cause_code: 'backend_changed' };
  if (current.shell !== stored.command.shell) return { ok: false, cause_code: 'shell_changed' };
  if (current.cwd !== stored.command.cwd) return { ok: false, cause_code: 'cwd_changed' };
  if (current.command_sha256 !== stored.command.command_sha256) return { ok: false, cause_code: 'command_changed' };
  return { ok: true };
}

module.exports = {
  captureCommonBinding,
  captureCommandProposalBinding,
  captureGitProposalBinding,
  recheckCommandBinding,
  recheckGitBinding,
  shellForBackend,
};
