'use strict';

/**
 * Read-only .gitignore queries for WorkspaceGitService: the File Map's
 * non-ignored scan scope and (Row 82 X1) the Files tree's ignored-row check.
 * Both run inside the service's _withRepo envelope and never touch
 * WRITE_VERBS or _runWrite.
 */

const MAX_CHECK_IGNORED_PATHS = 2000;

// Tracked files plus untracked-but-not-gitignored files, POSIX-relative to the
// workspace root (aligns with WorkspaceIdeService.listAllFiles).
async function listNonIgnoredFilesRead({ exec, execFailure, root, signal }) {
  const r = await exec(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { signal });
  if (!r.success) return execFailure('listNonIgnoredFiles', r);
  const files = String(r.stdout || '').split('\0').filter(Boolean);
  return { ok: true, available: true, isRepo: true, op: 'listNonIgnoredFiles', files };
}

// `git check-ignore` exits 1 when nothing matched. The runners do not surface
// exit codes, so a failure with no output at all and an execFile-style or
// "code 1" message is that case; a real failure (128) carries stderr, and a
// timeout/abort carries its own message.
function isNoMatchExit(r) {
  if (r.exitCode === 1 || r.code === 1) return true;
  if (r.reason !== 'git_failed' || r.stdout || r.stderr) return false;
  return /^Command failed: git |exited with code 1\b/.test(String(r.message || ''));
}

// Lexically normalize (invalid paths are dropped, never thrown), de-duplicate
// and cap the batch.
function normalizeCheckIgnoredPaths(values, normalizeRel) {
  const unique = new Set();
  for (const value of values) {
    try { unique.add(normalizeRel(value)); } catch (_error) { /* dropped */ }
  }
  const all = [...unique];
  const list = all.slice(0, MAX_CHECK_IGNORED_PATHS);
  return { list, truncated: all.length > list.length };
}

async function checkIgnoredRead({ exec, execFailure, root, signal, list, truncated }) {
  const base = { ok: true, available: true, isRepo: true, op: 'checkIgnored' };
  if (!list.length) return { ...base, ignored: [] };
  const r = await exec(root, ['check-ignore', '--stdin', '-z'], {
    signal,
    input: `${list.join('\0')}\0`,
  });
  const tail = truncated ? { truncated: true } : {};
  if (!r.success) {
    if (isNoMatchExit(r) && !r.stdout) return { ...base, ignored: [], ...tail };
    return execFailure('checkIgnored', r);
  }
  const requested = new Set(list);
  const ignored = String(r.stdout || '').split('\0').filter((entry) => entry && requested.has(entry));
  return { ...base, ignored, ...tail };
}

module.exports = {
  MAX_CHECK_IGNORED_PATHS, listNonIgnoredFilesRead, checkIgnoredRead, normalizeCheckIgnoredPaths,
};
