'use strict';

const crypto = require('crypto');
const path = require('path');

// Jenny's own managed state directory (artifacts, backups, tool results,
// quarantine). A workspace root pointed at or inside this directory
// materializes a doubled `.jenny/.jenny/...` tree — see workspace-root
// segment guards below (defense against that misconfiguration).
const JENNY_STATE_DIR_NAME = '.jenny';

function normalizeWorkspaceRootPath(value) {
  const raw = String(value || '').trim();
  return raw ? path.resolve(raw) : '';
}

// Segment split independent of `path` so this works on already-normalized
// strings from any normalizer (including test harnesses that never call
// path.resolve), not just OS-resolved absolute paths.
function workspaceRootPathSegments(rootPath) {
  return String(rootPath || '').split(/[\\/]+/).filter(Boolean);
}

// Windows silently strips trailing dots/spaces from a path segment at the
// filesystem-I/O layer, so `.jenny.`, `.JENNY...`, and `.jenny ` all resolve
// to the very same on-disk `.jenny` directory even though a naive string
// compare treats them as distinct, unguarded names (empirically confirmed).
// Strip trailing dot/whitespace runs before comparing so the guard matches
// real on-disk identity instead of the raw string. Kept in sync with
// sidecar/ai/tools/workspace_store.py's `_normalize_segment_for_jenny_compare`.
function normalizeSegmentForJennyCompare(segment) {
  return String(segment || '').replace(/[.\s]+$/, '').toLowerCase();
}

function isJennyStateDirRoot(rootPath) {
  const segments = workspaceRootPathSegments(rootPath);
  if (!segments.length) return false;
  return normalizeSegmentForJennyCompare(segments[segments.length - 1]) === JENNY_STATE_DIR_NAME;
}

function containsJennyStateDirSegment(rootPath) {
  return workspaceRootPathSegments(rootPath)
    .some((segment) => normalizeSegmentForJennyCompare(segment) === JENNY_STATE_DIR_NAME);
}

function workspaceRootId(rootPath, { platform = process.platform } = {}) {
  const normalized = normalizeWorkspaceRootPath(rootPath);
  if (!normalized) return null;
  const identity = platform === 'win32' ? normalized.toLowerCase() : normalized;
  return `root_${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

// Shared read-seam guard: the setter-side guards above block WRITING a new
// `.jenny` root, but a root persisted before those guards existed is still
// read by downstream consumers (sidecar tools config, diagnostic dev chat
// cwd, ...). Treat it as absent instead, with one WARN via the caller's
// `logger(level, event, details)`, so the misconfiguration stays observable.
function guardPersistedWorkspaceRoot(rootPath, { logger, seam = '' } = {}) {
  const root = String(rootPath || '').trim();
  if (!root || !isJennyStateDirRoot(root)) {
    return root;
  }
  if (typeof logger === 'function') {
    logger('WARN', 'workspace.persisted_root_is_jenny_state_dir', { seam });
  }
  return '';
}

module.exports = {
  containsJennyStateDirSegment,
  guardPersistedWorkspaceRoot,
  isJennyStateDirRoot,
  normalizeWorkspaceRootPath,
  workspaceRootId,
};
