/* services/workspace-git-sandbox-checkpoint.js - the checkpoint core bound to
 * an explicit root for the synced-workspace restore points (row 106).
 *
 * The turn-checkpoint owner (WorkspaceGitService) is bound to the IDE root and
 * the `workspace_git` flag. A sandboxed command's restore point is taken in
 * the chat's project authority root instead, whatever the flag says (model Git
 * tools stay off while the sandbox is on), and its Undo restores there too.
 *
 * Differences from the IDE path, all deliberate:
 *  - EVERY git call, the checkpoint writes included, runs neutralized
 *    (workspace-git-neutralize with ignoreSubmodules 'all'): no hook, filter,
 *    fsmonitor or credential program from the repository runs on the host.
 *    Content therefore round-trips raw (a clean/smudge-filtered file is
 *    captured and restored as its worktree bytes, an unmodified LFS file as
 *    its stored pointer).
 *  - Refs live under refs/jenny/sandbox/<session>/<n> with their own
 *    retention, so they never prune turn checkpoints (or the reverse).
 *  - One process-wide queue per root serializes every sandbox checkpoint
 *    operation on that root (restore point and Undo alike).
 */

'use strict';

const fsPromises = require('fs/promises');
const nodePath = require('path');

const { ToolPathPolicy } = require('./tools/tool-path-policy');
const { WORKSPACE_GIT_ERROR_CODES, workspaceGitError } = require('./workspace-git-errors');
const { classifyExpectedOutcome, runWorkspaceGit } = require('./workspace-git-executor');
const { createCheckpointTransactionRunner, createWorkspaceGitCheckpointApi } = require('./workspace-git-checkpoint');
const { SANDBOX_NAMESPACE } = require('./workspace-git-checkpoint-refs');
const { createReadOnlyGitExec } = require('./workspace-git-neutralize');
const { detectRepoScope, notRepoToplevelResult, probeHeadState } = require('./workspace-git-root-guard');

const rootQueues = new Map();

function rootKey(root) {
  const resolved = nodePath.resolve(String(root));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Process-wide FIFO per root; a failed operation never blocks the next one.
function runSerializedOnRoot(key, fn) {
  const previous = rootQueues.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {});
  rootQueues.set(key, tail);
  tail.then(() => {
    if (rootQueues.get(key) === tail) rootQueues.delete(key);
  });
  return run;
}

function unavailable(op, reason) {
  return { ok: false, available: false, isRepo: false, op, reason };
}

function execFailure(op, result) {
  return {
    ok: false,
    available: true,
    isRepo: true,
    op,
    error_code: WORKSPACE_GIT_ERROR_CODES.GIT_COMMAND_FAILED,
    reason: classifyExpectedOutcome(op, result) || result?.reason || 'git_failed',
    message: result?.message || '',
  };
}

// The Workspace Git service's lexical rule (relative, no "..", no leading dash).
function normalizeRelPath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  const lead = raw.trimStart();
  const segments = raw.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (!lead || raw.includes('\0') || lead.startsWith('/') || /^[A-Za-z]:/.test(lead)
    || !segments.length || segments.includes('..') || segments.join('/').startsWith('-')) {
    throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.PATH_INVALID, 'Path must be a workspace-relative path.');
  }
  return segments.join('/');
}

/** Every-verb neutralized executor for the sandbox path. */
function createSandboxGitExec(exec = runWorkspaceGit, options = {}) {
  return createReadOnlyGitExec(exec, { ...options, ignoreSubmodules: 'all' });
}

/**
 * Checkpoint API (createCheckpoint/listCheckpoints/restoreCheckpoint/
 * deleteCheckpoint/preflightCheckpointFiles/restoreCheckpointFiles) bound to
 * `root` in the sandbox namespace. `isCurrent()` is re-checked before every
 * mutation (e.g. the session's project authority is still current).
 */
function createSandboxCheckpointApi({
  root,
  isCurrent = () => true,
  exec = runWorkspaceGit,
  fs = undefined,
  trashItem = null,
  log = () => {},
  retention = {},
  untrackedLimits = {},
} = {}) {
  const gitExec = createSandboxGitExec(exec);
  const fsImpl = fs || fsPromises;
  const pathPolicy = new ToolPathPolicy({ fs: fsImpl, path: nodePath });
  const key = rootKey(root);
  const acquireMutation = (signal) => {
    if (signal?.aborted) return { acquired: false, code: 'aborted' };
    const current = () => !signal?.aborted && isCurrent() === true;
    return { acquired: true, root, signal, isCurrent: current, context: { rootId: key }, release() {} };
  };
  async function resolveInsideRoot(relPath, boundRoot) {
    const normalized = normalizeRelPath(relPath);
    const resolved = nodePath.resolve(boundRoot, normalized);
    try {
      await pathPolicy.assertInsideRoot(resolved, { workingDirectory: boundRoot });
    } catch (error) {
      if (error?.code && String(error.code).startsWith('CMP-')) throw error;
      throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.PATH_OUTSIDE_ROOT, 'Path resolves outside the workspace root.');
    }
    return { root: boundRoot, relPath: normalized, resolved };
  }
  return createWorkspaceGitCheckpointApi({
    namespace: SANDBOX_NAMESPACE,
    runTransaction: createCheckpointTransactionRunner({
      gitEnabled: () => true,
      acquireMutation,
      runSerialized: runSerializedOnRoot,
      detectScope: (scopeRoot, options) => detectRepoScope(gitExec, scopeRoot, { ...options, fs: fsImpl }),
      unavailable,
      notARepo: (op) => ({ ok: false, available: true, isRepo: false, op }),
      notToplevel: (op) => notRepoToplevelResult(op),
      execFailure,
    }),
    exec: gitExec,
    execFailure,
    probeHeadState,
    log,
    retention,
    untrackedLimits,
    ...(fs ? { fs } : {}),
    resolveInsideRoot,
    trashItem,
  });
}

// The chat's project root for a session, from the main process's project
// authority (never the shell's selected workspace or the IDE root). The
// returned isCurrent() fails once the session's root changes or goes stale.
function createSessionRootResolver(getProjectAuthority) {
  return function resolveSessionRoot(sessionId) {
    const owner = getProjectAuthority();
    if (typeof owner?.captureSession !== 'function' || typeof owner?.requireCurrent !== 'function') {
      throw new Error('project authority is unavailable');
    }
    const authority = owner.captureSession(sessionId);
    owner.requireCurrent(authority);
    if (!authority?.root_path) throw new Error('the session has no project root');
    const isCurrent = () => {
      try {
        const now = owner.captureSession(sessionId);
        owner.requireCurrent(now);
        return now.root_path === authority.root_path && now.root_id === authority.root_id;
      } catch (_error) {
        return false;
      }
    };
    return { root: authority.root_path, isCurrent };
  };
}

// The Undo/Redo side: per-file preflight and restore of a sandbox ref in the
// root of the session that owns it.
function createSandboxCheckpointRecovery({ resolveSessionRoot, trashItem = null, exec = runWorkspaceGit, fs = undefined }) {
  async function run(op, { sessionId, ...options }) {
    let bound;
    try {
      bound = await resolveSessionRoot(sessionId);
    } catch (_error) {
      return unavailable(op, 'root_unavailable');
    }
    const api = createSandboxCheckpointApi({ root: bound.root, isCurrent: bound.isCurrent, exec, fs, trashItem });
    return api[op](options);
  }
  return Object.freeze({
    preflightCheckpointFiles: (options) => run('preflightCheckpointFiles', options),
    restoreCheckpointFiles: (options) => run('restoreCheckpointFiles', options),
  });
}

module.exports = {
  createSandboxCheckpointApi,
  createSandboxCheckpointRecovery,
  createSandboxGitExec,
  createSessionRootResolver,
};
