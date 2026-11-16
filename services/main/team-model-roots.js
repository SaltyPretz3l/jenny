'use strict';

// Row 123 slice 6-5: the roots a model received from a team member may be placed in ({userData}/models and the
// managed library roots), under the rules the discovery scan uses for its library roots: a local absolute path only
// (isLocalAbsolutePath: on Windows a drive path, never a UNC, device or root-relative path, which could make Windows
// contact another machine before any answer comes back) and no root twice (resolved, case folded). A root left out
// here never reaches a mkdir, a free-space read, a staging scan or the 7-day sweep. Shape only: nothing is read.

const path = require('node:path');

const { isLocalAbsolutePath } = require('../shell-config-engines');

/** `[{ path, display }]` in order: {userData}/models first, then each library root that passes. */
function teamModelRoots({ userDataPath, libraryRoots, platform = process.platform }) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const seen = new Set();
  const roots = [];
  for (const raw of [api.join(String(userDataPath || ''), 'models'), ...(Array.isArray(libraryRoots) ? libraryRoots : [])]) {
    const root = typeof raw === 'string' ? raw.trim() : '';
    if (!isLocalAbsolutePath(root, { platform })) continue;
    const key = api.resolve(root).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push({ path: root, display: root });
  }
  return roots;
}

module.exports = { teamModelRoots };
