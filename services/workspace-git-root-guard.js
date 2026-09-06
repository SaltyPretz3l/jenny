/* services/workspace-git-root-guard.js - repo-state probes (isRepo/HEAD)
 * plus the WIDE-008 stopgap (Packet 0, Q1 fail-closed default): confirms the
 * selected Workspace-IDE root IS the git repository toplevel before any
 * destructive verb is allowed to run repo-wide. Split out of
 * workspace-git-service.js to stay under the project's file-size cap;
 * detectRepoScope serves both the read-path `_withRepo` envelope and the
 * write-path `_runWrite`/checkpoint-transaction guards.
 *
 * The defect this closes: the old isRepo probe only confirmed the root is
 * INSIDE a work tree (`git rev-parse --is-inside-work-tree`). If a caller
 * selects a repository SUBDIRECTORY as the workspace root, every destructive
 * verb (commit/stash/reset in particular) still runs without a pathspec and
 * so mutates the WHOLE repository, not just the selected subtree. This
 * module adds the missing check: the selected root must equal
 * `git rev-parse --show-toplevel` for that root.
 *
 * A LINKED WORKTREE root is its own toplevel — `git rev-parse
 * --show-toplevel` run inside a linked worktree reports the worktree's own
 * root, not the main repository's — so selecting a worktree remains
 * allowed. This protects Jenny's own Worktree feature.
 */

'use strict';

const fsPromises = require('fs/promises');
const { WORKSPACE_GIT_ERROR_CODES } = require('./backend/error-codes');

// WIDE-008 stopgap (Q1 fail-closed default): the soft-failure shape for a
// selected workspace root that is inside a work tree but is not that work
// tree's toplevel (e.g. a repo subdirectory was selected as the workspace
// root). Both reads (status/diff/log via _withRepo) AND destructive verbs now
// require the selected root to equal the repository toplevel — a subdirectory
// root would otherwise report repo-wide status and let a pathspec-less verb
// mutate the whole repository. Matches WorkspaceGitService's other soft-result
// factories (_notARepo / _execFailure): never thrown, always ok:false.
function notRepoToplevelResult(op) {
  return {
    ok: false,
    available: true,
    isRepo: true,
    op,
    error_code: WORKSPACE_GIT_ERROR_CODES.GIT_NOT_TOPLEVEL,
    reason: 'not_repo_toplevel',
    message: 'The selected workspace root must be the git repository toplevel; both Git status reads and destructive operations are refused otherwise.',
  };
}

// Per-call "is this root inside a git work tree at all" detection (no
// caching) — moved here alongside the toplevel check to keep
// workspace-git-service.js under the project's file-size cap. Interprets a
// "not a git repository" failure as a clean miss; a genuine spawn failure
// (git missing / aborted) is surfaced as `{ failure }` for the caller to
// fold into its own structured execution-failure shape.
async function detectIsRepo(exec, root, { signal = null } = {}) {
  const r = await exec(root, ['rev-parse', '--is-inside-work-tree'], { signal });
  if (r.success) {
    return { isRepo: r.stdout.trim() === 'true' };
  }
  if (/not a git repository/i.test(r.message || r.stderr || '')) {
    return { isRepo: false };
  }
  return { failure: r };
}

// Typed HEAD probe (failure-oracle hardening; the ONLY HEAD probe — the
// legacy boolean `hasHead` collapsed EVERY non-success into "no HEAD", so an
// aborted/timed-out/failed `rev-parse` was indistinguishable from a genuinely
// unborn branch and a caller silently took the no-HEAD code path, e.g. `reset`
// instead of `restore --staged`, on a broken probe; it was removed once every
// caller migrated here). Only a CONFIRMED unborn HEAD (git ran and rejected
// HEAD as a revision) maps to { hasHead: false }; abort/timeout/spawn failure
// surfaces as { failure } so the caller propagates a structured error instead.
// `--verify` is used WITHOUT `--quiet` so the unborn-branch fatal reaches
// stderr under the pinned C locale, giving a deterministic signal to
// distinguish it from a spawn error (which leaves stderr empty).
async function probeHeadState(exec, root, signal) {
  const r = await exec(root, ['rev-parse', '--verify', 'HEAD'], { signal });
  if (r.success) {
    return { hasHead: String(r.stdout || '').trim().length > 0 };
  }
  if (r.reason === 'aborted') {
    return { failure: r };
  }
  const detail = String(r.stderr || r.message || '');
  if (/unknown revision|ambiguous argument|needed a single revision|bad revision|bad default revision/i.test(detail)) {
    return { hasHead: false };
  }
  return { failure: r };
}

// Trailing-separator + case normalization for comparing two resolved paths.
// win32 paths are case-insensitive at the filesystem layer, so a
// drive-letter or segment case mismatch between the configured root and
// git's own toplevel output must not produce a false "not toplevel" refusal.
function normalizePathForComparison(value) {
  let normalized = String(value == null ? '' : value).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

function pathsEqual(a, b) {
  return normalizePathForComparison(a) === normalizePathForComparison(b);
}

// realpath resolves symlinks/junctions and (on win32) canonicalizes 8.3
// short names to their long form, so a root reached via a different alias
// than git's own toplevel output still compares equal. Falls back to the
// literal path if realpath fails (e.g. the path vanished mid-check, or is
// a synthetic value in a unit test) so detection degrades to a plain string
// compare instead of throwing.
async function realpathSafe(fsImpl, targetPath) {
  try {
    return await fsImpl.realpath(targetPath);
  } catch {
    return targetPath;
  }
}

// Realpaths both sides, then compares. Exported separately from
// checkRootIsToplevel so callers/tests can exercise the comparison logic
// against injected fs stubs without spawning git.
async function resolveAndCompare(fsImpl, root, toplevel) {
  const [rootReal, toplevelReal] = await Promise.all([
    realpathSafe(fsImpl, root),
    realpathSafe(fsImpl, toplevel),
  ]);
  return pathsEqual(rootReal, toplevelReal);
}

// Runs `git rev-parse --show-toplevel` via the caller's exec (the service's
// own `_exec`, so tests can spy/stub it exactly like every other git call)
// and reports whether `root` IS that toplevel. Never throws: a spawn
// failure surfaces as `{ failure }`, matching detectIsRepo's contract so the
// caller can fold it into the same _execFailure shape.
async function checkRootIsToplevel(exec, root, { signal = null, fs: fsImpl = fsPromises } = {}) {
  const r = await exec(root, ['rev-parse', '--show-toplevel'], { signal });
  if (!r.success) {
    return { failure: r };
  }
  const toplevel = String(r.stdout || '').trim();
  const isToplevel = await resolveAndCompare(fsImpl, root, toplevel);
  return { isToplevel, toplevel };
}

async function detectRepoScope(exec, root, options = {}) {
  const detected = await detectIsRepo(exec, root, options);
  if (detected.failure || !detected.isRepo) return detected;
  if (typeof options.isCurrent === 'function' && !options.isCurrent()) return { stale: true };
  const scope = await checkRootIsToplevel(exec, root, options);
  if (scope.failure) return scope;
  return { isRepo: true, isToplevel: scope.isToplevel, toplevel: scope.toplevel };
}

module.exports = {
  normalizePathForComparison,
  pathsEqual,
  resolveAndCompare,
  detectIsRepo,
  detectRepoScope,
  probeHeadState,
  checkRootIsToplevel,
  notRepoToplevelResult,
};
