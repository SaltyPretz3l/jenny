'use strict';
// Row 106 restore point for synced-workspace write-back: a git checkpoint of
// the authority root under refs/jenny/sandbox/<session>/<n>, taken after
// approval and before the command starts; the Changed-files Undo restores
// from it (workspace-recovery-files-ipc routes sandbox refs to the chat root).
//   probe(root)                         -> { available: true } | { available: false, reason }
//   create({ root, sessionId, signal }) -> { kind: 'git_checkpoint', ref, created_at }
// probe never throws; reason is 'not_git' (no repository, a repository
// subfolder, no commit yet) or 'unavailable' (git missing or failing, config
// that cannot be neutralized, untracked files over the checkpoint caps).
// create throws when no complete checkpoint could be pinned; the service then
// refuses the run. All host git here runs neutralized (workspace-git-sandbox-checkpoint).

const fsPromises = require('fs/promises');
const nodePath = require('path');

const { runWorkspaceGit } = require('../workspace-git-executor');
const { detectRepoScope, probeHeadState } = require('../workspace-git-root-guard');
const { SANDBOX_NAMESPACE } = require('../workspace-git-checkpoint-refs');
const {
  DEFAULT_UNTRACKED_LIMITS,
  inspectEntry,
  planUntrackedCapture,
} = require('../workspace-git-checkpoint-untracked');
const { createSandboxCheckpointApi, createSandboxGitExec } = require('../workspace-git-sandbox-checkpoint');

// Untracked entries the checkpoint cannot hold but write-back never writes
// either (a link pointing outside the folder, a special file); anything else
// skipped would leave a written-back file without its pre-run bytes.
const HARMLESS_SKIPS = new Set(['outside_root', 'not_regular_file']);

function failure(reason) {
  return Object.assign(new Error(`restore_point_unavailable: ${reason}`), { reason: 'restore_point_unavailable', detail: reason });
}

function untrackedComplete(summary) {
  if (!summary || summary.reason === 'too_many_files' || summary.reason === 'total_size_limit'
    || summary.reason === 'list_failed' || summary.reason === 'capture_failed') return false;
  return Object.keys(summary.skippedByReason || {}).every((reason) => HARMLESS_SKIPS.has(reason));
}

function createSandboxRestorePoints({
  logger = null,
  exec = runWorkspaceGit,
  fs = fsPromises,
  now = () => Date.now(),
  retention = {},
  untrackedLimits = {},
} = {}) {
  const gitExec = createSandboxGitExec(exec);
  const caps = { ...DEFAULT_UNTRACKED_LIMITS, ...untrackedLimits };
  const log = (level, event, details = {}) => {
    try {
      if (typeof logger === 'function') logger(level, event, details);
      else logger?.[String(level).toLowerCase()]?.(event, details);
    } catch (_error) { /* logging never breaks a run */ }
  };

  async function untrackedWithinCaps(root, signal) {
    const listed = await gitExec(root, ['ls-files', '--others', '--exclude-standard', '-z'], { signal });
    if (!listed.success) return false;
    const paths = String(listed.stdout || '').split('\0').filter(Boolean);
    const realRoot = await fs.realpath(root);
    const plan = await planUntrackedCapture(paths, caps, (relPath) => inspectEntry(fs, root, realRoot, relPath));
    return untrackedComplete(plan.summary);
  }

  async function probe(root, { signal = null } = {}) {
    try {
      if (typeof root !== 'string' || !root || !nodePath.isAbsolute(root)) return { available: false, reason: 'unavailable' };
      const scope = await detectRepoScope(gitExec, root, { signal, fs });
      if (scope.failure || scope.stale) return { available: false, reason: 'unavailable' };
      if (!scope.isRepo || !scope.isToplevel) return { available: false, reason: 'not_git' };
      const head = await probeHeadState(gitExec, root, signal);
      if (head.failure) return { available: false, reason: 'unavailable' };
      if (!head.hasHead) return { available: false, reason: 'not_git' };
      // An unresolved merge cannot be checkpointed (stash create refuses an unmerged index): say so
      // before approval rather than refusing the run after it.
      const unmerged = await gitExec(root, ['ls-files', '--unmerged', '-z'], { signal });
      if (!unmerged.success || String(unmerged.stdout || '')) return { available: false, reason: 'unavailable' };
      if (!(await untrackedWithinCaps(root, signal))) return { available: false, reason: 'unavailable' };
      return { available: true };
    } catch (_error) {
      return { available: false, reason: 'unavailable' };
    }
  }

  async function create({ root, sessionId, signal = null } = {}) {
    if (typeof root !== 'string' || !root || !nodePath.isAbsolute(root)) throw failure('root_invalid');
    const api = createSandboxCheckpointApi({ root, exec, retention, untrackedLimits, log, ...(fs !== fsPromises ? { fs } : {}) });
    const result = await api.createCheckpoint({ session: String(sessionId || ''), signal, allowClean: true });
    if (result?.ok !== true || result.created !== true || !SANDBOX_NAMESPACE.refIsSafe(result.ref)) {
      log('WARN', 'command_sandbox.restore_point_failed', { reason: String(result?.reason || 'checkpoint_failed') });
      throw failure(String(result?.reason || 'checkpoint_failed'));
    }
    if (!untrackedComplete(result.untracked)) {
      // An incomplete checkpoint is no restore point: drop it and refuse.
      await api.deleteCheckpoint({ ref: result.ref }).catch(() => null);
      log('WARN', 'command_sandbox.restore_point_failed', { reason: 'untracked_incomplete' });
      throw failure('untracked_incomplete');
    }
    return Object.freeze({ kind: 'git_checkpoint', ref: result.ref, created_at: new Date(now()).toISOString() });
  }

  return Object.freeze({ probe, create });
}

module.exports = { createSandboxRestorePoints };
