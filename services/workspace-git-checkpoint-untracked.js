/* services/workspace-git-checkpoint-untracked.js - untracked-file capture and
 * restore for workspace checkpoints (row 34 A1).
 *
 * Capture builds a `stash -u`-shaped commit WITHOUT touching the real index or
 * the working tree: untracked files are hashed straight into the object store
 * (`hash-object -w --stdin-paths`), their tree is assembled bottom-up with one
 * `mktree -z --batch` call per directory depth, and the result becomes a
 * parentless commit U. The checkpoint commit W then gets the parents
 * HEAD, I (the index commit) and U, so `W^3` holds the untracked files.
 *
 * No temporary index is used: the workspace executor scrubs the child env and
 * has no per-call env channel, so GIT_INDEX_FILE cannot be passed. The plumbing
 * here never names an index at all, which also means a dropped option can never
 * redirect a write onto the user's real index.
 *
 * Restore writes only U's own paths with
 * `git restore --source=U --worktree` and literal pathspecs. It never deletes:
 * files created after the checkpoint stay, and a path whose directory or
 * parent changed shape since the checkpoint is skipped and reported.
 *
 * File names are untrusted: listings are NUL-separated, paths reach git through
 * stdin only (c-quoted or literal pathspecs), and every captured entry must be
 * a regular file or symlink whose realpath stays inside the workspace root.
 */

'use strict';

const fsPromises = require('fs/promises');
const nodePath = require('path');

const { buildPathspecCommand } = require('./workspace-git-executor');

const SHA_RE = /^[0-9a-f]{40,64}$/;
const DEFAULT_UNTRACKED_LIMITS = Object.freeze({
  maxFiles: 2000,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxSymlinks: 64,
});
// Jenny's own workspace metadata never belongs in a user checkpoint.
const INTERNAL_PREFIXES = ['.jenny/'];
const FS_CONCURRENCY = 16;
const HASH_TIMEOUT_MS = 30000;
const FILE_MODE = { regular: '100644', executable: '100755', symlink: '120000' };
const RESTORABLE_MODES = new Set([FILE_MODE.regular, FILE_MODE.executable, FILE_MODE.symlink]);
// Fixed identity for the plumbing commits: `stash create` has its own fallback
// identity, `commit-tree` does not, and a checkpoint must not fail on a machine
// without user.name/user.email.
const IDENTITY_ARGS = ['-c', 'user.name=Jenny checkpoint', '-c', 'user.email=checkpoint@jenny.invalid'];

class StaleCheckpointError extends Error {}

function isInternalPath(relPath) {
  const lower = String(relPath).toLowerCase();
  return INTERNAL_PREFIXES.some((prefix) => lower === prefix.slice(0, -1) || lower.startsWith(prefix));
}

// C-style quoting for `hash-object --stdin-paths`, which unquotes a line that
// starts with a double quote. Quoting every path keeps names with newlines,
// quotes or backslashes intact.
function cQuotePath(relPath) {
  let out = '"';
  for (const ch of String(relPath)) {
    const code = ch.codePointAt(0);
    if (ch === '"' || ch === '\\') out += `\\${ch}`;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

// A tree path from a checkpoint commit is untrusted: relative, forward-slash
// separated, no empty/dot segments, nothing inside .git or Jenny metadata.
function treePathIsSafe(relPath) {
  const value = String(relPath || '');
  if (!value || value.length > 4096 || value.includes('\\') || value.includes('\0')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  if (segments.some((segment) => segment.toLowerCase() === '.git')) return false;
  return !isInternalPath(value);
}

function isInsideRoot(realRoot, candidate) {
  const rel = nodePath.relative(realRoot, candidate);
  return Boolean(rel) && !rel.startsWith('..') && !nodePath.isAbsolute(rel);
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function emptySummary() {
  return { captured: 0, skipped: 0, reason: '', skippedByReason: {} };
}

function countSkip(summary, reason, count = 1) {
  summary.skipped += count;
  summary.skippedByReason[reason] = (summary.skippedByReason[reason] || 0) + count;
}

// lstat + realpath containment for one listed path. Returns a capture entry or
// a skip reason; never reads file content.
async function inspectEntry(fs, root, realRoot, relPath) {
  const absolute = nodePath.join(root, ...relPath.split('/'));
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (_error) {
    return { skip: 'unreadable' };
  }
  const symlink = stat.isSymbolicLink();
  if (!symlink && !stat.isFile()) return { skip: 'not_regular_file' };
  let real;
  try {
    real = await fs.realpath(absolute);
  } catch (_error) {
    return { skip: 'outside_root' };
  }
  if (!isInsideRoot(realRoot, real)) return { skip: 'outside_root' };
  if (symlink) {
    try {
      return { relPath, symlink: true, target: await fs.readlink(absolute), size: 0 };
    } catch (_error) {
      return { skip: 'unreadable' };
    }
  }
  const executable = process.platform !== 'win32' && (stat.mode & 0o100) !== 0;
  return { relPath, symlink: false, executable, size: Number(stat.size) || 0 };
}

// Picks which untracked paths to capture under the caps. Pure apart from the
// injected inspect callback, so the cap policy is unit-testable.
async function planUntrackedCapture(listed, limits, inspect) {
  const summary = emptySummary();
  const paths = listed.filter((relPath) => relPath && !isInternalPath(relPath));
  if (paths.length > limits.maxFiles) {
    countSkip(summary, 'too_many_files', paths.length);
    summary.reason = 'too_many_files';
    return { entries: [], summary };
  }
  const inspected = await mapLimited(paths, FS_CONCURRENCY, inspect);
  const entries = [];
  let totalBytes = 0;
  let symlinks = 0;
  for (const item of inspected) {
    if (item.skip) {
      countSkip(summary, item.skip);
    } else if (item.size > limits.maxFileBytes) {
      countSkip(summary, 'file_too_large');
    } else if (item.symlink && symlinks >= limits.maxSymlinks) {
      countSkip(summary, 'symlink_limit');
    } else {
      if (item.symlink) symlinks += 1;
      totalBytes += item.size;
      entries.push(item);
    }
  }
  if (totalBytes > limits.maxTotalBytes) {
    countSkip(summary, 'total_size_limit', entries.length);
    summary.reason = 'total_size_limit';
    return { entries: [], summary };
  }
  summary.captured = entries.length;
  if (summary.skipped > 0) summary.reason = 'some_files_skipped';
  return { entries, summary };
}

// Groups blob entries into per-directory listings, deepest directory first, so
// each depth can be written with one `mktree --batch` call.
function directoriesByDepth(blobs) {
  const dirs = new Map([['', []]]);
  for (const blob of blobs) {
    const segments = blob.relPath.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const dir = segments.slice(0, depth).join('/');
      if (!dirs.has(dir)) dirs.set(dir, []);
    }
    const parent = segments.slice(0, -1).join('/');
    dirs.get(parent).push({ mode: blob.mode, type: 'blob', sha: blob.sha, name: segments[segments.length - 1] });
  }
  const levels = new Map();
  for (const dir of dirs.keys()) {
    const depth = dir ? dir.split('/').length : 0;
    if (!levels.has(depth)) levels.set(depth, []);
    levels.get(depth).push(dir);
  }
  const depths = [...levels.keys()].sort((a, b) => b - a);
  return { dirs, levels: depths.map((depth) => levels.get(depth)) };
}

function mktreeRecord(entry) {
  return `${entry.mode} ${entry.type} ${entry.sha}\t${entry.name}\0`;
}

function shaLines(stdout, expected) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean);
  if (lines.length !== expected || !lines.every((line) => SHA_RE.test(line))) {
    throw Object.assign(new Error('git returned an unexpected object id list'), { gitFailure: true });
  }
  return lines;
}

function createUntrackedCheckpointSupport({ exec, mutate, fs = fsPromises, limits = {} }) {
  const caps = { ...DEFAULT_UNTRACKED_LIMITS, ...limits };

  function read(tx, args, options = {}) {
    return exec(tx.root, args, { signal: tx.signal, ...options });
  }

  async function write(tx, args, options = {}) {
    if (!tx.isCurrent()) throw new StaleCheckpointError('root changed');
    const result = await mutate(tx, args, options);
    if (!result.success) throw Object.assign(new Error(result.message || 'git failed'), { gitResult: result });
    return result;
  }

  async function hashEntries(tx, entries) {
    const files = entries.filter((entry) => !entry.symlink);
    const blobs = [];
    if (files.length) {
      const hashed = await write(tx, ['hash-object', '-w', '--stdin-paths'], {
        input: `${files.map((entry) => cQuotePath(entry.relPath)).join('\n')}\n`,
        timeoutMs: HASH_TIMEOUT_MS,
      });
      shaLines(hashed.stdout, files.length).forEach((sha, index) => {
        blobs.push({
          relPath: files[index].relPath,
          sha,
          mode: files[index].executable ? FILE_MODE.executable : FILE_MODE.regular,
        });
      });
    }
    for (const entry of entries.filter((item) => item.symlink)) {
      const hashed = await write(tx, ['hash-object', '-w', '--stdin'], { input: entry.target });
      blobs.push({ relPath: entry.relPath, sha: shaLines(hashed.stdout, 1)[0], mode: FILE_MODE.symlink });
    }
    return blobs;
  }

  async function writeTree(tx, blobs) {
    const { dirs, levels } = directoriesByDepth(blobs);
    let rootTree = '';
    for (const level of levels) {
      const input = level.map((dir) => dirs.get(dir).map(mktreeRecord).join('')).join('\0');
      const made = await write(tx, ['mktree', '-z', '--batch'], { input });
      shaLines(made.stdout, level.length).forEach((sha, index) => {
        const dir = level[index];
        if (!dir) {
          rootTree = sha;
          return;
        }
        const cut = dir.lastIndexOf('/');
        dirs.get(cut < 0 ? '' : dir.slice(0, cut)).push({
          mode: '040000', type: 'tree', sha, name: dir.slice(cut + 1),
        });
      });
    }
    return rootTree;
  }

  async function commitTree(tx, tree, parents, message) {
    const args = ['commit-tree', '--no-gpg-sign', ...parents.flatMap((parent) => ['-p', parent]), '-m', message, tree];
    const made = await write(tx, args, { identity: IDENTITY_ARGS });
    return shaLines(made.stdout, 1)[0];
  }

  async function listUntracked(tx) {
    const listed = await read(tx, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (!listed.success) return { failure: listed };
    return { paths: String(listed.stdout || '').split('\0').filter(Boolean) };
  }

  // Returns { sha, summary } where sha is the stash-shaped checkpoint commit
  // (null when nothing untracked was captured), or { stale } / { failure } for
  // an abort or root change. Any other capture failure degrades to the
  // tracked-only checkpoint (owner decision 3) with reason 'capture_failed'.
  async function captureCheckpoint(tx, { stashSha }) {
    let summary = emptySummary();
    try {
      const listed = await listUntracked(tx);
      if (listed.failure) {
        if (listed.failure.reason === 'aborted') return { failure: listed.failure };
        summary.reason = 'list_failed';
        return { sha: null, summary };
      }
      if (!listed.paths.length) return { sha: null, summary };
      const realRoot = await fs.realpath(tx.root);
      const plan = await planUntrackedCapture(listed.paths, caps,
        (relPath) => inspectEntry(fs, tx.root, realRoot, relPath));
      summary = plan.summary;
      if (!plan.entries.length) return { sha: null, summary };
      const blobs = await hashEntries(tx, plan.entries);
      const untrackedCommit = await commitTree(tx, await writeTree(tx, blobs), [], 'untracked files');
      let head = 'HEAD';
      let indexCommit;
      if (stashSha) {
        head = `${stashSha}^1`;
        indexCommit = `${stashSha}^2`;
      } else {
        // A clean index still needs its own commit: commit-tree drops a
        // duplicate parent, which would shift U into the ^2 (index) slot.
        indexCommit = await commitTree(tx, 'HEAD^{tree}', ['HEAD'], 'index');
      }
      const tree = stashSha ? `${stashSha}^{tree}` : 'HEAD^{tree}';
      const sha = await commitTree(tx, tree, [head, indexCommit, untrackedCommit], 'Jenny checkpoint with untracked files');
      return { sha, summary };
    } catch (error) {
      if (error instanceof StaleCheckpointError) return { stale: true };
      if (error?.gitResult?.reason === 'aborted') return { failure: error.gitResult };
      return { sha: null, summary: { ...emptySummary(), skipped: summary.captured + summary.skipped, reason: 'capture_failed' } };
    }
  }

  // Read-only: is `sha` a stash-shaped commit whose third parent is a
  // parentless untracked-files commit? A merge commit pinned as a clean-tree
  // rollback has parents too, so the shape (exactly three parents, U without
  // parents) is checked, never assumed.
  async function findUntrackedParent(tx, sha) {
    const parents = await read(tx, ['rev-list', '--parents', '-n', '1', sha]);
    if (!parents.success) return { failure: parents };
    const ids = String(parents.stdout || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (ids.length !== 4 || !ids.every((id) => SHA_RE.test(id))) return { commit: null };
    const own = await read(tx, ['rev-list', '--parents', '-n', '1', ids[3]]);
    if (!own.success) return { failure: own };
    const ownIds = String(own.stdout || '').trim().split(/\s+/).filter(Boolean);
    return { commit: ownIds.length === 1 ? ids[3] : null };
  }

  // Lists U's restorable entries before any restore mutation runs. With
  // `onlyPaths` (a Set) the plan keeps just those paths (per-file restore).
  async function planRestore(tx, targetSha, { onlyPaths = null } = {}) {
    const found = await findUntrackedParent(tx, targetSha);
    if (found.failure || !found.commit) return found;
    const listed = await read(tx, ['ls-tree', '-r', '-z', '--full-tree', found.commit]);
    if (!listed.success) return { failure: listed };
    const summary = { restored: 0, skipped: 0, reason: '', skippedByReason: {}, filesCreatedAfterCheckpointKept: true };
    const paths = [];
    for (const record of String(listed.stdout || '').split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      const [mode, type] = record.slice(0, Math.max(0, tab)).split(' ');
      const relPath = record.slice(tab + 1);
      if (tab < 0 || type !== 'blob' || !RESTORABLE_MODES.has(mode) || !treePathIsSafe(relPath)) {
        countSkip(summary, 'invalid_entry');
      } else if (!onlyPaths || onlyPaths.has(relPath)) {
        paths.push(relPath);
      }
    }
    if (paths.length > caps.maxFiles) {
      countSkip(summary, 'too_many_files', paths.length);
      summary.reason = 'too_many_files';
      return { commit: found.commit, paths: [], summary };
    }
    return { commit: found.commit, paths, summary };
  }

  // A restore must never delete: skip a path that is now a directory, or
  // whose parent is now a file, symlink or junction.
  async function pathConflicts(root, relPath) {
    const segments = relPath.split('/');
    for (let depth = 1; depth <= segments.length; depth += 1) {
      let stat;
      try {
        stat = await fs.lstat(nodePath.join(root, ...segments.slice(0, depth)));
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        return true;
      }
      const leaf = depth === segments.length;
      if (leaf) return stat.isDirectory();
      if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
    }
    return false;
  }

  async function applyRestore(tx, plan) {
    const summary = { ...plan.summary, skippedByReason: { ...plan.summary.skippedByReason } };
    const conflicts = await mapLimited(plan.paths, FS_CONCURRENCY, (relPath) => pathConflicts(tx.root, relPath));
    const writable = plan.paths.filter((_relPath, index) => !conflicts[index]);
    const conflictedPaths = plan.paths.filter((_relPath, index) => conflicts[index]);
    if (conflictedPaths.length) countSkip(summary, 'path_conflict', conflictedPaths.length);
    if (summary.skipped && !summary.reason) summary.reason = 'some_files_skipped';
    if (!writable.length) return { summary, restoredPaths: [], conflictedPaths };
    const command = buildPathspecCommand(['restore', `--source=${plan.commit}`, '--worktree'], writable);
    if (!tx.isCurrent()) return { stale: true };
    const restored = await mutate(tx, command.args, { input: command.input });
    if (!restored.success) return { failure: restored };
    summary.restored = writable.length;
    return { summary, restoredPaths: writable, conflictedPaths };
  }

  return { captureCheckpoint, planRestore, applyRestore, findUntrackedParent, pathConflicts };
}

module.exports = {
  DEFAULT_UNTRACKED_LIMITS,
  cQuotePath,
  createUntrackedCheckpointSupport,
  directoriesByDepth,
  planUntrackedCapture,
  treePathIsSafe,
};
