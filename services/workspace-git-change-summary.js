'use strict';

/* services/workspace-git-change-summary.js - bounded, read-only working-tree
 * change reads for the chat workspace rail and its Changes page (row 59
 * checkpoint 2). It never mutates: file list from the session-scoped
 * WorkspaceGitService.getStatus (which owns the feature flag, root currency and
 * repository-toplevel guards), line counts from one `git diff --numstat`, and a
 * bounded read of untracked text files.
 *
 * Security boundary (getChangeDiff): the requested path must be a file in the
 * CURRENT status list, and its resolved real path must stay inside the real
 * workspace root (symlink/junction escape refused) before any read happens.
 * Ids never grant filesystem access; nothing here logs a path or a diff body.
 */

const fsPromises = require('node:fs/promises');
const nodePath = require('node:path');

const { runWorkspaceGit, literalPathspec } = require('./workspace-git-executor');
const { probeHeadState } = require('./workspace-git-root-guard');

const MAX_DIFF_CHARS = 200000;
const MAX_LISTED_FILES = 500;
const MAX_UNTRACKED_READS = 200;
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 4 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8000;
const GIT_ARGS_PREFIX = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M'];

function stableReason(value, fallback = 'git_failed') {
  const token = typeof value === 'string' ? value : '';
  return /^[a-z][a-z0-9_]{0,63}$/u.test(token) ? token : fallback;
}

function nowIso(now) {
  return now().toISOString();
}

function changeKind(file) {
  const state = String(file?.state || 'modified');
  if (state === 'modified' && (file.index === 'T' || file.worktree === 'T')) return 'type_changed';
  const known = ['modified', 'added', 'deleted', 'renamed', 'copied', 'untracked', 'conflicted'];
  return known.includes(state) ? state : 'modified';
}

// `git diff --numstat -z`: `adds\tdels\tpath\0`; renames and copies arrive as
// `adds\tdels\t\0old\0new\0`. Binary files report `-\t-`. Keyed by current path.
function parseNumstat(stdout) {
  const byPath = new Map();
  const records = String(stdout || '').split('\0');
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(record);
    if (!match) continue;
    let filePath = match[3];
    if (filePath === '') {
      filePath = records[i + 2] || '';
      i += 2;
    }
    if (!filePath) continue;
    const binary = match[1] === '-' || match[2] === '-';
    byPath.set(filePath, {
      binary,
      additions: binary ? null : Number(match[1]),
      deletions: binary ? null : Number(match[2]),
    });
  }
  return byPath;
}

function isInside(rootReal, candidate, path = nodePath) {
  const relative = path.relative(rootReal, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Real path of `rel` under `root` with symlinks/junctions resolved. A missing
// leaf (deleted file) resolves through its deepest existing ancestor.
async function resolveContained(root, rel, { fs = fsPromises, path = nodePath } = {}) {
  let rootReal;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return { ok: false, reason: 'file_unreadable' };
  }
  const target = path.resolve(rootReal, ...rel.split('/'));
  if (!isInside(rootReal, target, path)) return { ok: false, reason: 'path_outside_workspace' };
  let probe = target;
  const tail = [];
  for (let depth = 0; depth < 4096; depth += 1) {
    try {
      const real = path.join(await fs.realpath(probe), ...tail.reverse());
      return isInside(rootReal, real, path)
        ? { ok: true, rootReal, real, exists: tail.length === 0 }
        : { ok: false, reason: 'path_outside_workspace' };
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return { ok: false, reason: 'file_unreadable' };
      const parent = path.dirname(probe);
      if (parent === probe || !isInside(rootReal, parent, path)) return { ok: false, reason: 'path_outside_workspace' };
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
  return { ok: false, reason: 'file_unreadable' };
}

// First BINARY_SNIFF_BYTES decide binary (NUL byte), the git heuristic.
function looksBinary(buffer) {
  const limit = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) if (buffer[i] === 0) return true;
  return false;
}

function countLines(text) {
  if (!text) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
  return text.charCodeAt(text.length - 1) === 10 ? count : count + 1;
}

// One bounded read of a regular, in-root file. Never follows a leaf link.
async function readBounded(resolved, { fs = fsPromises } = {}) {
  let stat;
  try {
    stat = await fs.lstat(resolved.real);
  } catch {
    return { ok: false, reason: 'file_unreadable' };
  }
  if (!stat.isFile()) return { ok: true, regular: false };
  let handle;
  try {
    handle = await fs.open(resolved.real, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_UNTRACKED_FILE_BYTES) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > MAX_UNTRACKED_FILE_BYTES;
    const data = buffer.subarray(0, Math.min(bytesRead, MAX_UNTRACKED_FILE_BYTES));
    return { ok: true, regular: true, size: stat.size, bytes: data, truncated, binary: looksBinary(data) };
  } catch {
    return { ok: false, reason: 'file_unreadable' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function synthesizeAdditionDiff(filePath, text) {
  const lines = text === '' ? [] : text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const header = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n`;
  if (!lines.length) return header;
  return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
}

function createWorkspaceGitChangeSummary({
  exec = runWorkspaceGit,
  fs = fsPromises,
  path = nodePath,
  now = () => new Date(),
} = {}) {
  async function runRead(root, args, signal) {
    try {
      return await exec(root, args, { signal });
    } catch {
      return { success: false, reason: 'git_failed' };
    }
  }

  function mapStatusFailure(status) {
    if (status?.available === false) {
      const reason = status.reason === 'no_root' ? 'no_workspace' : stableReason(status.reason, 'unavailable');
      return { state: 'unavailable', reason };
    }
    if (status?.isRepo === false) return { state: 'not_applicable', reason: 'not_a_git_repository' };
    return { state: 'unavailable', reason: stableReason(status?.reason, 'git_failed') };
  }

  async function readHead(root, signal) {
    const probe = await probeHeadState(exec, root, signal);
    if (probe.failure) return { failed: true };
    if (!probe.hasHead) return { hasHead: false, head: null };
    const short = await runRead(root, ['rev-parse', '--short=9', 'HEAD'], signal);
    const head = short.success ? String(short.stdout || '').trim() : '';
    return { hasHead: true, head: /^[0-9a-f]{4,64}$/u.test(head) ? head : null };
  }

  async function readNumstat(root, hasHead, signal) {
    const args = [...GIT_ARGS_PREFIX, '--numstat', '-z', hasHead ? 'HEAD' : '--cached', '--'];
    const result = await runRead(root, args, signal);
    return result.success ? parseNumstat(result.stdout) : null;
  }

  async function measureUntracked(root, files) {
    const budget = { reads: 0, bytes: 0 };
    const measured = new Map();
    for (const file of files) {
      if (budget.reads >= MAX_UNTRACKED_READS || budget.bytes >= MAX_UNTRACKED_TOTAL_BYTES) break;
      const resolved = await resolveContained(root, file.path, { fs, path });
      if (!resolved.ok || !resolved.exists) continue;
      budget.reads += 1;
      const read = await readBounded(resolved, { fs });
      if (!read.ok || !read.regular) continue;
      budget.bytes += read.bytes.length;
      if (read.binary) {
        measured.set(file.path, { binary: true, additions: null, deletions: null });
      } else if (!read.truncated) {
        measured.set(file.path, { binary: false, additions: countLines(read.bytes.toString('utf8')), deletions: 0 });
      }
    }
    return measured;
  }

  // -> { state, reason, sampled_at, data } shared by getSummary and listChanges.
  async function listChanges({ gitService, root, workspaceId = null, signal = null } = {}) {
    const sampledAt = nowIso(now);
    const empty = (state, reason) => ({ state, reason, sampled_at: sampledAt, data: null });
    if (!root || typeof gitService?.getStatus !== 'function') return empty('unavailable', 'no_workspace');
    const status = await gitService.getStatus({ signal });
    if (!status || status.ok !== true) return { ...mapStatusFailure(status), sampled_at: sampledAt, data: null };
    const headInfo = await readHead(root, signal);
    if (headInfo.failed) return empty('unavailable', 'git_failed');
    const statusFiles = (Array.isArray(status.files) ? status.files : [])
      .filter((file) => typeof file?.path === 'string' && file.path)
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const truncated = status.truncated === true || statusFiles.length > MAX_LISTED_FILES;
    const listed = statusFiles.slice(0, MAX_LISTED_FILES);
    const numstat = await readNumstat(root, headInfo.hasHead, signal);
    const untracked = await measureUntracked(root, listed.filter((file) => changeKind(file) === 'untracked'));
    const files = listed.map((file) => {
      const change = changeKind(file);
      const counts = change === 'untracked' ? untracked.get(file.path)
        : (change === 'conflicted' ? null : numstat?.get(file.path));
      return {
        path: file.path,
        orig_path: typeof file.origPath === 'string' && file.origPath ? file.origPath : null,
        change,
        binary: counts?.binary === true,
        additions: Number.isSafeInteger(counts?.additions) ? counts.additions : null,
        deletions: Number.isSafeInteger(counts?.deletions) ? counts.deletions : null,
      };
    });
    const measured = files.filter((file) => file.additions !== null && file.deletions !== null);
    const sum = (key) => (files.length === 0 ? 0 : (measured.length === 0 ? null : measured.reduce((acc, f) => acc + f[key], 0)));
    const complete = measured.length === files.length && !truncated;
    const branch = status.detached === true || !status.branch ? null : String(status.branch);
    return {
      state: 'available',
      reason: complete ? null : (numstat === null ? 'counts_unavailable' : 'some_files_unmeasured'),
      sampled_at: sampledAt,
      data: {
        workspace_id: workspaceId,
        scope: 'working_tree',
        ref: branch || headInfo.head,
        head: headInfo.head,
        branch,
        files,
        file_count: files.length,
        additions: sum('additions'),
        deletions: sum('deletions'),
        truncated,
      },
    };
  }

  // -> { ok:true, path, change, binary, truncated, diff } | { ok:false, reason }
  async function getChangeDiff({ gitService, root, path: requestedPath, signal = null } = {}) {
    if (!root || typeof gitService?.getStatus !== 'function') return { ok: false, reason: 'no_workspace' };
    const status = await gitService.getStatus({ signal });
    if (!status || status.ok !== true) return { ok: false, reason: mapStatusFailure(status).reason };
    // Exact membership in the CURRENT status list is the authority; a lexically
    // odd path (`..`, absolute, NUL, drive) simply cannot be in that list.
    const entry = (Array.isArray(status.files) ? status.files : []).find((file) => file?.path === requestedPath);
    if (!entry) return { ok: false, reason: 'path_not_changed' };
    const resolved = await resolveContained(root, entry.path, { fs, path });
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const change = changeKind(entry);
    if (change === 'untracked') return untrackedDiff(entry.path, resolved, change);
    const headInfo = await readHead(root, signal);
    if (headInfo.failed) return { ok: false, reason: 'git_failed' };
    const specs = [literalPathspec(entry.path)];
    if (typeof entry.origPath === 'string' && entry.origPath) specs.push(literalPathspec(entry.origPath));
    const args = [...GIT_ARGS_PREFIX, headInfo.hasHead ? 'HEAD' : '--cached', '--', ...specs];
    const result = await runRead(root, args, signal);
    if (!result.success) return { ok: false, reason: 'git_failed' };
    const raw = String(result.stdout || '');
    if (/^Binary files |^GIT binary patch/mu.test(raw)) {
      return { ok: true, path: entry.path, change, binary: true, truncated: false, diff: '' };
    }
    const truncated = raw.length > MAX_DIFF_CHARS;
    return { ok: true, path: entry.path, change, binary: false, truncated, diff: truncated ? raw.slice(0, MAX_DIFF_CHARS) : raw };
  }

  async function untrackedDiff(filePath, resolved, change) {
    const read = await readBounded(resolved, { fs });
    if (!read.ok) return { ok: false, reason: read.reason };
    if (!read.regular) return { ok: true, path: filePath, change, binary: false, truncated: false, diff: '' };
    if (read.binary) return { ok: true, path: filePath, change, binary: true, truncated: false, diff: '' };
    let text = read.bytes.toString('utf8');
    let truncated = read.truncated;
    if (truncated) text = text.slice(0, text.lastIndexOf('\n') + 1);
    let diff = synthesizeAdditionDiff(filePath, text);
    if (diff.length > MAX_DIFF_CHARS) {
      diff = diff.slice(0, MAX_DIFF_CHARS);
      truncated = true;
    }
    return { ok: true, path: filePath, change, binary: false, truncated, diff };
  }

  return { listChanges, getChangeDiff };
}

module.exports = {
  MAX_DIFF_CHARS,
  MAX_LISTED_FILES,
  MAX_UNTRACKED_FILE_BYTES,
  countLines,
  createWorkspaceGitChangeSummary,
  isInside,
  parseNumstat,
  resolveContained,
  synthesizeAdditionDiff,
};
