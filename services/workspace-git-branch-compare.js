'use strict';

/* services/workspace-git-branch-compare.js - bounded, read-only "whole branch"
 * change reads for the chat workspace (chat session bar slice 5): everything the
 * current branch carries since its base, which is what a pull request would
 * contain. It never mutates and never fetches: base resolution reads refs only,
 * the file list is `git diff --name-status/--numstat -z <merge-base>` against the
 * working tree plus the status-listed untracked files, measured with the same
 * bounded logic as the working-tree read (workspace-git-change-summary.js).
 *
 * Base branch, first match wins, each candidate verified to exist and to pass the
 * worktree service's ref-shape check before it reaches any git argument:
 *   1. the worktree registry `base_ref` for this chat's root (unless it is the
 *      current branch or the bare `HEAD` default),
 *   2. `refs/remotes/origin/HEAD` (shown as its bare name),
 *   3. local `main`, 4. local `master`.
 *
 * Security boundary (getBranchChangeDiff): the requested path must be a member of
 * the branch file list computed for THIS request, and its resolved real path must
 * stay inside the real workspace root (symlink/junction escape refused) before any
 * read. Paths reach git only as literal pathspecs. Nothing here logs a path or a
 * diff body.
 */

const fsPromises = require('node:fs/promises');
const nodePath = require('node:path');

const { runWorkspaceGit, literalPathspec } = require('./workspace-git-executor');
const { baseRefIsSafe } = require('./worktree-service-git');
const { normalizeComparablePath } = require('./worktree-path-policy');
const {
  GIT_ARGS_PREFIX,
  MAX_LISTED_FILES,
  changeKind,
  createWorkspaceGitChangeSummary,
  diffResult,
  fileRow,
  nowIso,
  parseNumstat,
  resolveContained,
  summarizeFiles,
} = require('./workspace-git-change-summary');

const FULL_OBJECT_ID = /^[0-9a-f]{40,64}$/u;
const SHORT_ID_CHARS = 9;
const NAME_STATUS_CHANGE = Object.freeze({
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type_changed', U: 'conflicted',
});

// The `base_ref` of the registry entry whose worktree path is `rootPath`, else null.
function registryBaseRef(entries, rootPath) {
  if (!rootPath || !Array.isArray(entries)) return null;
  const wanted = normalizeComparablePath(rootPath);
  const match = entries.find((entry) => entry && typeof entry.worktree_path === 'string'
    && normalizeComparablePath(entry.worktree_path) === wanted);
  const base = typeof match?.base_ref === 'string' ? match.base_ref.trim() : '';
  return base || null;
}

// `git diff --name-status -z`: `X\0path\0`, renames and copies `Rnn\0old\0new\0`.
function parseNameStatus(stdout) {
  const tokens = String(stdout || '').split('\0');
  const rows = [];
  for (let i = 0; i < tokens.length;) {
    const code = tokens[i];
    if (!code) {
      i += 1;
      continue;
    }
    const pair = code[0] === 'R' || code[0] === 'C';
    const first = tokens[i + 1];
    const filePath = pair ? tokens[i + 2] : first;
    i += pair ? 3 : 2;
    if (!filePath) continue;
    rows.push({
      path: filePath,
      origPath: pair && first ? first : null,
      change: NAME_STATUS_CHANGE[code[0]] || 'modified',
    });
  }
  return rows;
}

// A git command that exited 1 without a word to say: `--verify --quiet`, `symbolic-ref -q`
// and `merge-base` answer "no such thing" this way, which is not a failure of git itself.
// The runner reports a plain non-zero exit as "Command failed: git ..." (or "Git exited with code
// 1."); a timeout, an abort or a spawn error say something else.
function isSilentMiss(result) {
  return result?.success === false && result.reason === 'git_failed'
    && !String(result.stderr || '').trim() && !String(result.stdout || '').trim()
    && /^(?:Command failed: git |Git exited with code 1\.?$)/u.test(String(result.message || ''));
}

const DIFF_REUSE_MS = 1500;

function createWorkspaceGitBranchCompare({
  exec = runWorkspaceGit,
  fs = fsPromises,
  path = nodePath,
  now = () => new Date(),
} = {}) {
  const { kit } = createWorkspaceGitChangeSummary({ exec, fs, path, now });
  let recentForDiff = null; // { key, at, promise }

  // -> { base: { ref, display, short } } | { noBase: true } | { failed: true }
  async function resolveBase({ root, branch, registryBase, signal }) {
    const exists = async (ref) => {
      if (!baseRefIsSafe(ref)) return 'miss';
      const result = await kit.runRead(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], signal);
      if (result.success) return 'hit';
      return isSilentMiss(result) ? 'miss' : 'failed';
    };
    const candidate = (ref, display) => ({ ref, display, short: display.replace(/^origin\//u, '') });
    const attempt = async (found) => {
      const verdict = await exists(found.ref);
      return verdict === 'hit' ? { base: found } : (verdict === 'failed' ? { failed: true } : null);
    };

    if (registryBase && registryBase !== 'HEAD' && registryBase !== branch) {
      const outcome = await attempt(candidate(registryBase, registryBase));
      if (outcome) return outcome;
    }
    const origin = await kit.runRead(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], signal);
    if (origin.success) {
      const name = /^refs\/remotes\/origin\/(.+)$/u.exec(String(origin.stdout || '').trim())?.[1];
      if (name && name !== 'HEAD' && baseRefIsSafe(name)) {
        const outcome = await attempt(candidate(`refs/remotes/origin/${name}`, name));
        if (outcome) return outcome;
      }
    } else if (!isSilentMiss(origin)) {
      return { failed: true };
    }
    for (const name of ['main', 'master']) {
      const outcome = await attempt(candidate(`refs/heads/${name}`, name));
      if (outcome) return outcome;
    }
    return { noBase: true };
  }

  async function readCommitCount(root, mergeBase, signal) {
    const result = await kit.runRead(root, ['rev-list', '--count', `${mergeBase}..HEAD`], signal);
    const count = result.success ? Number(String(result.stdout || '').trim()) : NaN;
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  }

  // The whole branch file set for one request. -> { terminal: { state, reason } } or
  // { branch, head, base, mergeBase, commitCount, entries, numstat, truncated }.
  async function computeBranch({ gitService, root, registryBase = null, signal = null }) {
    const stop = (state, reason) => ({ terminal: { state, reason } });
    if (!root || typeof gitService?.getStatus !== 'function') return stop('unavailable', 'no_workspace');
    const status = await gitService.getStatus({ signal });
    if (!status || status.ok !== true) return { terminal: kit.mapStatusFailure(status) };
    const headInfo = await kit.readHead(root, signal);
    if (headInfo.failed) return stop('unavailable', 'git_failed');
    const branch = status.detached === true || !status.branch ? null : String(status.branch);
    if (!headInfo.hasHead || !branch) return stop('not_applicable', 'no_base');

    const resolved = await resolveBase({ root, branch, registryBase, signal });
    if (resolved.failed) return stop('unavailable', 'git_failed');
    if (resolved.noBase) return stop('not_applicable', 'no_base');
    const { base } = resolved;
    if (base.short === branch) return stop('not_applicable', 'on_base_branch');

    const mergeBaseRun = await kit.runRead(root, ['merge-base', base.ref, 'HEAD'], signal);
    if (isSilentMiss(mergeBaseRun)) return stop('not_applicable', 'no_base');
    const mergeBase = mergeBaseRun.success ? String(mergeBaseRun.stdout || '').trim() : '';
    if (!FULL_OBJECT_ID.test(mergeBase)) return stop('unavailable', 'git_failed');
    const commitCount = await readCommitCount(root, mergeBase, signal);
    if (commitCount === null) return stop('unavailable', 'git_failed');

    const nameStatus = await kit.runRead(root, [...GIT_ARGS_PREFIX, '--name-status', '-z', mergeBase, '--'], signal);
    if (!nameStatus.success) return stop('unavailable', 'git_failed');
    const numstatRun = await kit.runRead(root, [...GIT_ARGS_PREFIX, '--numstat', '-z', mergeBase, '--'], signal);
    const tracked = parseNameStatus(nameStatus.stdout);
    const known = new Set(tracked.map((entry) => entry.path));
    const untracked = (Array.isArray(status.files) ? status.files : [])
      .filter((file) => typeof file?.path === 'string' && file.path && !known.has(file.path)
        && changeKind(file) === 'untracked')
      .map((file) => ({ path: file.path, origPath: null, change: 'untracked' }));
    const entries = [...tracked, ...untracked]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return {
      branch,
      head: headInfo.head,
      base,
      mergeBase,
      commitCount,
      entries,
      numstat: numstatRun.success ? parseNumstat(numstatRun.stdout) : null,
      truncated: status.truncated === true || entries.length > MAX_LISTED_FILES,
    };
  }

  // -> { state, reason, sampled_at, data } in the same envelope as the working-tree list.
  async function listBranchChanges({ gitService, root, workspaceId = null, registryBase = null, signal = null } = {}) {
    const sampledAt = nowIso(now);
    const computed = await computeBranch({ gitService, root, registryBase, signal });
    if (computed.terminal) return { ...computed.terminal, sampled_at: sampledAt, data: null };
    const listed = computed.entries.slice(0, MAX_LISTED_FILES);
    const measured = await kit.measureUntracked(root, listed.filter((entry) => entry.change === 'untracked'));
    const files = listed.map((entry) => fileRow(
      entry.path,
      entry.origPath,
      entry.change,
      entry.change === 'untracked' ? measured.get(entry.path) : (entry.change === 'conflicted' ? null : computed.numstat?.get(entry.path)),
    ));
    const totals = summarizeFiles(files, computed.truncated, computed.numstat !== null);
    return {
      state: 'available',
      reason: totals.reason,
      sampled_at: sampledAt,
      data: {
        workspace_id: workspaceId,
        scope: 'branch',
        ref: computed.branch,
        head: computed.head,
        branch: computed.branch,
        base_ref: computed.base.display,
        merge_base: computed.mergeBase.slice(0, SHORT_ID_CHARS),
        commit_count: computed.commitCount,
        files,
        file_count: files.length,
        additions: totals.additions,
        deletions: totals.deletions,
        truncated: computed.truncated,
      },
    };
  }

  // Expanding several files asks for several diffs at once: they share one recent comparison (seconds old at
  // most), and membership and real-path containment are still checked for each file.
  function comparisonForDiff(args) {
    if (args.signal) return computeBranch(args); // a cancellable read owns its own run
    const key = JSON.stringify([args.root, args.registryBase]);
    const nowMs = now().getTime();
    if (recentForDiff && recentForDiff.key === key && nowMs - recentForDiff.at < DIFF_REUSE_MS) return recentForDiff.promise;
    const promise = computeBranch(args);
    const record = { key, at: nowMs, promise };
    recentForDiff = record;
    promise.catch(() => { if (recentForDiff === record) recentForDiff = null; });
    return promise;
  }

  // -> { ok:true, path, change, binary, truncated, diff } | { ok:false, reason }
  async function getBranchChangeDiff({ gitService, root, path: requestedPath, registryBase = null, signal = null } = {}) {
    const computed = await comparisonForDiff({ gitService, root, registryBase, signal });
    if (computed.terminal) {
      // No branch comparison exists, so no path can be a member of it.
      return { ok: false, reason: computed.terminal.state === 'not_applicable' ? 'path_not_changed' : computed.terminal.reason };
    }
    const entry = computed.entries.find((candidate) => candidate.path === requestedPath);
    if (!entry) return { ok: false, reason: 'path_not_changed' };
    const resolved = await resolveContained(root, entry.path, { fs, path });
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    if (entry.change === 'untracked') return kit.untrackedDiff(entry.path, resolved, 'untracked');
    const specs = [literalPathspec(entry.path)];
    if (entry.origPath) specs.push(literalPathspec(entry.origPath));
    const result = await kit.runRead(root, [...GIT_ARGS_PREFIX, computed.mergeBase, '--', ...specs], signal);
    if (!result.success) return { ok: false, reason: 'git_failed' };
    return diffResult(entry.path, entry.change, String(result.stdout || ''));
  }

  return { listBranchChanges, getBranchChangeDiff };
}

module.exports = {
  createWorkspaceGitBranchCompare,
  parseNameStatus,
  registryBaseRef,
};
