'use strict';

/* services/workspace-recovery-files-ipc.js - the workspaceRecovery file
 * methods behind the Changes view's undo/redo (row 34 S5 step 4).
 *
 * Owner: Electron workspace-git (checkpoint files) plus workspaceRecovery
 * (journal safety copies). Registered by registerWorkspaceRecoveryIpcHandlers
 * on the existing `workspace-recovery:` channel family; split out of that file
 * to keep it under the 600-line ratchet.
 *
 * Boundary rules: every payload is strictly shaped and bounded (max 500
 * paths); relative paths pass the Workspace IDE lexical guard here and the
 * owning service's realpath containment again before any IO; results carry
 * relative paths, enums and fixed messages only - never file bytes, absolute
 * paths, git stderr or a private recovery location.
 */

const { isPlainObject } = require('./value-utils');
const { normalizeWorkspaceRelPath } = require('./workspace-ide-path-guard');
const { WORKSPACE_FS_ERROR_CODES } = require('./workspace-ide-errors');
const { WORKSPACE_GIT_ERROR_CODES } = require('./workspace-git-errors');
const { checkpointRefIsSafe } = require('./workspace-git-checkpoint');
const { HASH_KINDS, MAX_FILES: MAX_PATHS } = require('./workspace-git-checkpoint-files');
const {
  WorkspaceRecoverySafetyCopyStore,
  stateOfCapture,
  unavailableReasonFor,
} = require('./workspace-recovery-safety-copies');

const MAX_PATH_LENGTH = 4096;
const MAX_REF_LENGTH = 255;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AFTER_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const IN_CHECKPOINT = new Set(['tracked', 'untracked', 'absent']);
const DISK_KINDS = new Set(['missing', 'file', 'directory', 'symlink', 'other']);
const ROOT_LEVEL_FS_CODES = new Set([
  WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING,
  WORKSPACE_FS_ERROR_CODES.STALE_GENERATION,
  WORKSPACE_FS_ERROR_CODES.ROOT_MISSING,
]);
const GIT_THROWN_REASONS = new Map([
  [WORKSPACE_GIT_ERROR_CODES.REF_INVALID, 'ref_invalid'],
  [WORKSPACE_GIT_ERROR_CODES.PATH_INVALID, 'path_invalid'],
  [WORKSPACE_GIT_ERROR_CODES.PATH_OUTSIDE_ROOT, 'path_outside_root'],
]);
// Inverse-plan step kinds and the plan paths each one rewrites.
const STEP_PATHS = Object.freeze({
  restore_object: ['to_relative_path'],
  remove_created: ['from_relative_path'],
  move_back: ['from_relative_path', 'to_relative_path'],
});

function normalizeRelPath(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH) return '';
  try {
    return normalizeWorkspaceRelPath(value);
  } catch (_error) {
    return '';
  }
}

// A bounded, lexically valid, de-duplicated path list, or null.
function normalizePathList(value, { min = 1 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_PATHS) return null;
  const paths = value.map(normalizeRelPath);
  return paths.every(Boolean) ? [...new Set(paths)] : null;
}

function normalizePreflightFiles(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_PATHS) return null;
  const files = [];
  const seen = new Set();
  for (const item of value) {
    if (!isPlainObject(item) || !Object.keys(item).every((key) => ['path', 'afterHash', 'hashKind'].includes(key))) return null;
    const path = normalizeRelPath(item.path);
    const hasHash = item.afterHash !== undefined;
    if (!path || (hasHash && (typeof item.afterHash !== 'string' || !AFTER_HASH_PATTERN.test(item.afterHash)))) return null;
    if (item.hashKind !== undefined && (!hasHash || !HASH_KINDS.includes(item.hashKind))) return null;
    if (seen.has(path)) continue;
    seen.add(path);
    files.push(hasHash
      ? { path, afterHash: item.afterHash.toLowerCase(), hashKind: item.hashKind || 'diff_input_text' }
      : { path });
  }
  return files;
}

function normalizeRef(value) {
  return typeof value === 'string' && value.length <= MAX_REF_LENGTH && checkpointRefIsSafe(value) ? value : '';
}

function safeReason(value, fallback) {
  return REASON_PATTERN.test(String(value || '')) ? String(value) : fallback;
}

function isRootLevelError(error) {
  return ROOT_LEVEL_FS_CODES.has(error?.code)
    || (error?.code === WORKSPACE_FS_ERROR_CODES.ROOT_INVALID && String(error?.details?.reason || '').startsWith('root_'));
}

function pathErrorReason(error, fallback) {
  if (error?.code === WORKSPACE_FS_ERROR_CODES.PATH_INVALID) return 'path_invalid';
  if (error?.code === WORKSPACE_FS_ERROR_CODES.PATH_OUTSIDE_ROOT) return 'path_outside_root';
  if (error?.code === WORKSPACE_FS_ERROR_CODES.NOT_A_FILE) return 'not_a_file';
  return fallback;
}

function sanitizeFailedList(value) {
  return (Array.isArray(value) ? value : []).slice(0, MAX_PATHS * 2)
    .filter((item) => typeof item?.path === 'string')
    .map((item) => ({ path: item.path, reason: safeReason(item.reason, 'restore_failed') }));
}

function sanitizePathList(value) {
  return (Array.isArray(value) ? value : []).filter((item) => typeof item === 'string').slice(0, MAX_PATHS);
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function sanitizePreflightFile(item) {
  const tri = (value) => (typeof value === 'boolean' ? value : null);
  return {
    path: String(item?.path || ''),
    inCheckpoint: IN_CHECKPOINT.has(item?.inCheckpoint) ? item.inCheckpoint : 'absent',
    exists: item?.exists === true,
    kind: DISK_KINDS.has(item?.kind) ? item.kind : 'other',
    size: finiteOrZero(item?.size),
    mtimeMs: finiteOrZero(item?.mtimeMs),
    matchesCheckpoint: tri(item?.matchesCheckpoint),
    matchesAfter: tri(item?.matchesAfter),
  };
}

// Ordered unique plan paths a journal undo will rewrite.
function touchedPlanPaths(plan) {
  const paths = [];
  for (const step of Array.isArray(plan) ? plan : []) {
    for (const key of STEP_PATHS[step?.kind] || []) {
      const raw = step[key];
      if (typeof raw === 'string' && raw && !paths.some((item) => item.raw === raw)) {
        paths.push({ raw, relPath: normalizeRelPath(raw) });
      }
    }
  }
  return paths;
}

function createWorkspaceRecoveryFileHandlers({
  failure,
  hasOnlyKeys,
  callRpc,
  methods,
  gitService = null,
  ideService = null,
  safetyCopies = null,
}) {
  const store = safetyCopies || new WorkspaceRecoverySafetyCopyStore();
  // A token restores once at a time: a second request waits for no one, it fails.
  const restoringTokens = new Set();
  const maxBytes = store.limits.maxFileBytes;
  const unavailable = (what) => failure('recovery_unavailable', `${what} is unavailable right now.`);

  async function callGit(method, options, label) {
    if (typeof gitService?.[method] !== 'function') return { early: unavailable(label) };
    try {
      return { result: await gitService[method](options) };
    } catch (error) {
      const reason = GIT_THROWN_REASONS.get(error?.code) || 'checkpoint_failed';
      return { early: failure(reason, `${label} could not run.`) };
    }
  }

  // Runs `callback` under one IDE root lease. Root-level failures (a root
  // change, a transition, a stale generation) become { error }.
  async function withRootOperation(kind, callback) {
    let operation;
    try {
      operation = await ideService.acquireRootOperation({ kind });
    } catch (error) {
      return { error: error?.code === WORKSPACE_FS_ERROR_CODES.ROOT_MISSING ? 'root_unavailable' : 'root_changed' };
    }
    try {
      return { value: await callback(operation) };
    } catch (error) {
      if (isRootLevelError(error)) return { error: 'root_changed' };
      throw error;
    } finally {
      operation.release();
    }
  }

  async function readState(relPath, operation) {
    try {
      const capture = await ideService.readFileBytesForRecovery({ path: relPath, maxBytes }, operation);
      return { capture, state: stateOfCapture(capture) };
    } catch (error) {
      if (isRootLevelError(error)) throw error;
      return { capture: null, state: null, reason: pathErrorReason(error, 'unreadable') };
    }
  }

  async function preflightCheckpointFiles(payload) {
    if (!hasOnlyKeys(payload, ['ref', 'files'])) return failure('payload_invalid', 'The checkpoint preflight request was invalid.');
    const ref = normalizeRef(payload.ref);
    const files = normalizePreflightFiles(payload.files);
    if (!ref) return failure('ref_invalid', 'The checkpoint reference was invalid.');
    if (!files) return failure('files_invalid', 'The checkpoint file list was invalid.');
    const called = await callGit('preflightCheckpointFiles', { ref, files }, 'Checkpoint preflight');
    if (called.early) return called.early;
    const { result } = called;
    if (result?.ok !== true) return failure(safeReason(result?.reason, 'checkpoint_failed'), 'The checkpoint could not be checked.');
    if (result.found === false) return failure('checkpoint_not_found', 'That checkpoint no longer exists.');
    return { ok: true, files: (Array.isArray(result.files) ? result.files : []).slice(0, MAX_PATHS).map(sanitizePreflightFile) };
  }

  async function restoreCheckpointFiles(payload) {
    if (!hasOnlyKeys(payload, ['ref', 'paths', 'removePaths'])) return failure('payload_invalid', 'The checkpoint restore request was invalid.');
    const ref = normalizeRef(payload.ref);
    const paths = normalizePathList(payload.paths, { min: 0 });
    const removePaths = payload.removePaths === undefined ? [] : normalizePathList(payload.removePaths, { min: 0 });
    if (!ref) return failure('ref_invalid', 'The checkpoint reference was invalid.');
    if (!paths || !removePaths || !(paths.length + removePaths.length)
      || paths.length + removePaths.length > MAX_PATHS || removePaths.some((item) => paths.includes(item))) {
      return failure('paths_invalid', 'The restore path list was invalid.');
    }
    const called = await callGit('restoreCheckpointFiles', { ref, paths, removePaths }, 'Checkpoint restore');
    if (called.early) return called.early;
    const { result } = called;
    if (result?.ok === true && result.found === false) return failure('checkpoint_not_found', 'That checkpoint no longer exists.');
    const outcome = {
      rollbackRef: normalizeRef(result?.rollbackRef) || null,
      restored: sanitizePathList(result?.restored),
      removed: sanitizePathList(result?.removed),
      failed: sanitizeFailedList(result?.failed),
    };
    if (result?.ok === true) return { ok: true, ...outcome };
    return failure(safeReason(result?.reason, 'checkpoint_failed'), 'The checkpoint files could not be restored.', outcome);
  }

  async function preflightSafetyCopy(payload) {
    if (!hasOnlyKeys(payload, ['token'])) return failure('payload_invalid', 'The safety copy request was invalid.');
    if (typeof payload.token !== 'string' || !TOKEN_PATTERN.test(payload.token)) return failure('token_invalid', 'The safety copy token was invalid.');
    if (!ideService) return unavailable('The safety copy');
    const run = await withRootOperation('read', async (operation) => {
      const peek = store.peek(payload.token, ideService.recoveryBinding(operation));
      if (peek.error) return { error: peek.error };
      const files = [];
      for (const relPath of peek.copy.paths) {
        const current = await readState(relPath, operation);
        files.push({
          path: relPath,
          unchanged: current.state !== null && current.state === peek.copy.entries.get(relPath).expected,
          mtimeMs: finiteOrZero(current.capture?.mtimeMs),
        });
      }
      return { files };
    });
    const error = run.error || run.value?.error;
    if (error) return failure(error, 'The safety copy is no longer available for this workspace.');
    return { ok: true, files: run.value.files };
  }

  async function restoreOne(relPath, entry, operation) {
    const request = { path: relPath, expectedState: entry.expected, maxBytes };
    try {
      if (entry.state === 'bytes') {
        const written = await ideService.writeFileBytesForRecovery({ ...request, bytes: entry.bytes }, operation);
        return { done: written.written === true, reason: written.reason, before: written.before };
      }
      const trashed = await ideService.trashFileForRecovery(request, operation);
      return { done: trashed.trashed === true, reason: trashed.reason, before: trashed.before };
    } catch (error) {
      if (isRootLevelError(error)) throw error;
      return { done: false, reason: pathErrorReason(error, 'restore_failed') };
    }
  }

  async function restoreSafetyCopy(payload) {
    if (!hasOnlyKeys(payload, ['token', 'paths'])) return failure('payload_invalid', 'The safety copy restore request was invalid.');
    if (typeof payload.token !== 'string' || !TOKEN_PATTERN.test(payload.token)) return failure('token_invalid', 'The safety copy token was invalid.');
    const paths = normalizePathList(payload.paths);
    if (!paths) return failure('paths_invalid', 'The restore path list was invalid.');
    if (!ideService) return unavailable('The safety copy');
    if (restoringTokens.has(payload.token)) return failure('token_busy', 'This safety copy is already being restored.');
    restoringTokens.add(payload.token);
    try {
      return await restoreSafetyCopyOnce(payload, paths);
    } finally {
      restoringTokens.delete(payload.token);
    }
  }

  async function restoreSafetyCopyOnce(payload, paths) {
    const restored = [];
    const failed = [];
    let reverse = null;
    let aborted = '';
    const posts = new Map();
    const run = await withRootOperation('mutation', async (operation) => {
      const binding = ideService.recoveryBinding(operation);
      const peek = store.peek(payload.token, binding);
      if (peek.error) return { error: peek.error };
      reverse = store.startCopy(binding);
      for (const relPath of paths) {
        const entry = peek.copy.entries.get(relPath);
        if (!entry) {
          failed.push({ path: relPath, reason: 'not_in_safety_copy' });
          continue;
        }
        let outcome;
        try {
          outcome = await restoreOne(relPath, entry, operation);
        } catch (error) {
          if (!isRootLevelError(error)) throw error;
          aborted = 'root_changed';
          break;
        }
        if (!outcome.done) {
          failed.push({ path: relPath, reason: safeReason(outcome.reason, 'restore_failed') });
          continue;
        }
        // The pre-write state becomes the reverse copy; its post-state is
        // what was just restored.
        reverse.record(relPath, outcome.before);
        posts.set(relPath, entry.state === 'bytes' ? entry.hash : 'missing');
        restored.push(relPath);
      }
      return {};
    });
    const error = run.error || run.value?.error;
    if (error) return failure(error, 'The safety copy is no longer available for this workspace.');
    // Single use once it changed something; a restore that changed nothing
    // (every file failed) leaves the copy for a retry.
    if (restored.length) store.consume(payload.token);
    const result = { restored, failed, safety_copy: store.commit(reverse, posts) };
    return aborted
      ? failure(aborted, 'The workspace changed while restoring; some files were not restored.', result)
      : { ok: true, ...result };
  }

  // Journal undo with a safety copy: capture the plan's paths, run the same
  // undo, then record each path's post-undo state. A failed undo discards the
  // copy; a needs_review outcome keeps it.
  async function undoWithSafetyCopy(changeSetId, undoParams) {
    if (!ideService) return unavailable('Undo with a safety copy');
    const preflight = await callRpc(methods.preflight, { change_set_id: changeSetId });
    if (!preflight.ok) return preflight;
    const targets = touchedPlanPaths(preflight.inverse_plan);
    if (targets.length > MAX_PATHS) return failure('too_many_paths', 'This change touches too many files to keep a safety copy.');
    const captured = await withRootOperation('read', async (operation) => {
      const binding = ideService.recoveryBinding(operation);
      const draft = store.startCopy(binding);
      for (const { raw, relPath } of targets) {
        if (!relPath) {
          draft.markUnavailable(raw, 'path_invalid');
          continue;
        }
        const current = await readState(relPath, operation);
        if (current.capture) draft.record(relPath, current.capture);
        else draft.markUnavailable(relPath, current.reason);
      }
      return { binding, draft };
    });
    if (captured.error) return failure(captured.error, 'The workspace changed before the undo could start.');
    const undo = await callRpc(methods.undo, undoParams);
    if (!undo.ok && undo.status !== 'needs_review') return undo;
    const { binding, draft } = captured.value;
    const post = await withRootOperation('read', async (operation) => {
      const current = ideService.recoveryBinding(operation);
      if (current.rootId !== binding.rootId || current.workspaceId !== binding.workspaceId) return null;
      const states = new Map();
      for (const [relPath, entry] of draft.entries()) {
        if (entry.state === 'unavailable') continue;
        const now = await readState(relPath, operation);
        states.set(relPath, now.state ?? { unavailable: now.capture ? unavailableReasonFor(now.capture) : now.reason });
      }
      return states;
    });
    if (post.error || !post.value) return { ...undo, safety_copy: null, safety_copy_reason: 'root_changed' };
    return { ...undo, safety_copy: store.commit(draft, post.value) };
  }

  return {
    handlers: {
      'workspaceRecovery.preflightCheckpointFiles': (_event, payload = {}) => preflightCheckpointFiles(payload),
      'workspaceRecovery.restoreCheckpointFiles': (_event, payload = {}) => restoreCheckpointFiles(payload),
      'workspaceRecovery.preflightSafetyCopy': (_event, payload = {}) => preflightSafetyCopy(payload),
      'workspaceRecovery.restoreSafetyCopy': (_event, payload = {}) => restoreSafetyCopy(payload),
    },
    undoWithSafetyCopy,
  };
}

module.exports = {
  createWorkspaceRecoveryFileHandlers,
  touchedPlanPaths,
};
