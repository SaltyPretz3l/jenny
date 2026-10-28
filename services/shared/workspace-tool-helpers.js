'use strict';

/* services/shared/workspace-tool-helpers.js — the workspace-relative path
 * helpers shared by the `workspace_present` and `preview_test` tools and the
 * workspace presentation service (the last gate before the IPC payload).
 * Failure shapes come from services/tools/builtin/tool-result.js. */

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
  toRelativePosix,
};
