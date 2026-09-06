/* services/workspace-ide-gitdir.js - trusted git-layout resolution for the
 * Workspace IDE watcher (WIDE-028 b). A regular repository keeps HEAD/index/
 * refs under `<root>/.git`, which the root-recursive watch already sees; a
 * LINKED WORKTREE root has a `.git` FILE ("gitdir: <path>") pointing at
 * `<main-repo>/.git/worktrees/<name>`, whose `commondir` file points at the
 * shared `.git` - all OUTSIDE the workspace root, invisible to the root
 * watch. This module resolves that documented on-disk layout (no git
 * subprocess) so the watcher can arm auxiliary watches on the external
 * metadata directories. */

'use strict';

const fsPromises = require('node:fs/promises');
const nodePath = require('node:path');

// The `.git` file format is a single `gitdir: <path>` line (gitrepository-layout).
const GITDIR_FILE_RE = /^gitdir:\s*(.+?)\s*$/m;
// A `.git` file / `commondir` file is a one-line pointer; anything bigger is
// not the documented layout and is refused rather than parsed.
const MAX_POINTER_FILE_BYTES = 4096;

async function readPointerFile(fs, filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  if (typeof content !== 'string' || content.length > MAX_POINTER_FILE_BYTES) return '';
  return content;
}

/**
 * Resolve where the git metadata (HEAD/index/refs/packed-refs) for `rootPath`
 * actually lives.
 *
 * @returns {Promise<{ mode: 'none' }
 *   | { mode: 'internal', gitDir: string, commonDir: string }
 *   | { mode: 'external', gitDir: string, commonDir: string }>}
 *   'internal'  - `<root>/.git` is a directory; the root watch covers it.
 *   'external'  - linked worktree (or detached gitdir): metadata lives at
 *                 gitDir (HEAD/index) and commonDir (packed-refs, refs/).
 *   'none'      - not a git checkout (or unreadable layout).
 */
async function resolveGitMetaLayout(rootPath, { fs = fsPromises, path = nodePath } = {}) {
  const root = String(rootPath || '').trim();
  if (!root) return { mode: 'none' };
  const dotGit = path.join(root, '.git');
  let stats;
  try {
    stats = await fs.lstat(dotGit);
  } catch (_error) {
    return { mode: 'none' };
  }
  if (typeof stats?.isDirectory === 'function' && stats.isDirectory()) {
    return { mode: 'internal', gitDir: dotGit, commonDir: dotGit };
  }
  if (typeof stats?.isFile !== 'function' || !stats.isFile()) {
    return { mode: 'none' };
  }
  let pointer;
  try {
    pointer = await readPointerFile(fs, dotGit);
  } catch (_error) {
    return { mode: 'none' };
  }
  const match = GITDIR_FILE_RE.exec(pointer);
  if (!match) return { mode: 'none' };
  // Relative gitdir pointers resolve against the worktree root (git writes
  // absolute paths for worktrees, relative ones for some submodule layouts).
  const gitDir = path.resolve(root, match[1]);
  let commonDir = gitDir;
  try {
    const common = (await readPointerFile(fs, path.join(gitDir, 'commondir'))).trim();
    // `commondir` is relative to gitDir when relative (gitrepository-layout).
    if (common) commonDir = path.resolve(gitDir, common);
  } catch (_error) {
    /* no commondir file: a plain detached gitdir owns all its metadata */
  }
  return { mode: 'external', gitDir, commonDir };
}

module.exports = {
  resolveGitMetaLayout,
};
