'use strict';

/* services/shared/workspace-tool-helpers.js — the workspace-relative path
 * helpers shared by the `workspace_present` and `preview_test` tools and the
 * workspace presentation service (the last gate before the IPC payload).
 * Failure shapes come from services/tools/builtin/tool-result.js. */

const fs = require('node:fs');
const path = require('node:path');

const { extensionOf } = require('../workspace-file-map-ignore');

// Wire-safe workspace-relative POSIX form of a caller's path input; '' when the
// input is not expressible as one (absolute, drive, escape, scheme-like).
function toRelativePosix(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const raw = value.trim().replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.includes(':') || raw.startsWith('/')) {
    return '';
  }
  const segments = raw.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (!segments.length || segments.some((segment) => segment === '..')) {
    return '';
  }
  return segments.join('/');
}

// Accepts what a model means by a workspace path but spells wrongly: an absolute path that lies inside
// `root`, or one leading slash/backslash on a path that exists under `root`. Anything else (outside the
// root, `..`, a drive or UNC form that is not inside the root, no root) is '' exactly as toRelativePosix
// answers it. Pure spelling: the caller still runs its real-path containment check on the result.
async function resolveWorkspaceRelative(value, { root, fsLike = fs.promises } = {}) {
  const direct = toRelativePosix(value);
  if (direct || typeof value !== 'string' || typeof root !== 'string' || !root) {
    return direct;
  }
  const raw = value.trim();
  if (!raw || raw.includes('\0')) {
    return '';
  }
  const slashed = raw.replace(/\\/g, '/');
  if (slashed.startsWith('//')) {
    return '';
  }
  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    if (slashed.split('/').includes('..')) {
      return '';
    }
    const relative = path.relative(path.resolve(root), path.resolve(raw));
    if (relative && !path.isAbsolute(relative)) {
      const inside = toRelativePosix(relative);
      if (inside) {
        return inside;
      }
    }
  }
  if (slashed.startsWith('/') && !/^\/[A-Za-z]:/.test(slashed)) {
    const rooted = toRelativePosix(slashed.slice(1));
    if (rooted) {
      try {
        await fsLike.stat(path.join(root, ...rooted.split('/')));
        return rooted;
      } catch (_error) {
        return '';
      }
    }
  }
  return '';
}

// The refusal text for a path toRelativePosix/resolveWorkspaceRelative could not accept. It never echoes
// the path: unsafe caller input stays out of tool results (tests/workspace-present-tool.test.js).
function unsafePathMessage() {
  return 'That path is outside the workspace or not a plain file path. Use a path relative to the workspace root, such as src/index.html.';
}

async function realpathSafe(fsLike, target) {
  try {
    return await fsLike.realpath(target);
  } catch (_error) {
    return path.resolve(target);
  }
}

module.exports = {
  extensionOf,
  realpathSafe,
  resolveWorkspaceRelative,
  toRelativePosix,
  unsafePathMessage,
};
