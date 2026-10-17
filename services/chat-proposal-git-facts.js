'use strict';

/**
 * chat-proposal-git-facts - Git fact capture for inline Git proposals (row 59 checkpoint 3).
 *
 * One read-only pass through the Git service's admitted exec (`readWithExec`) captures the ref,
 * the full HEAD oid and, per selected path, the index/worktree status plus blob oids, then folds
 * them into a stable fingerprint. File bodies are never loaded into JS: worktree oids come from
 * `git hash-object --stdin-paths`, index and HEAD oids from `cat-file --batch-check`. Capture is
 * bounded (summed lstat bytes and wall clock); overflow fails visibly (`capacity`) and never falls
 * back to a weaker mtime fingerprint.
 *
 * Results: `{ok:true, git:{ref, head, paths, fingerprint}}` or `{ok:false, reason, cause_code}`
 * where reason is invalid_request | capacity | authority_changed | unavailable.
 */

const crypto = require('crypto');
const fsPromises = require('fs/promises');
const nodePath = require('path');

const { resolveContained } = require('./workspace-git-change-summary');
const { parseStatus } = require('./workspace-git-parsers');
const { probeHeadState } = require('./workspace-git-root-guard');
const { cQuotePath } = require('./workspace-git-checkpoint-untracked');

const MAX_PATHS = 200;
const MAX_PATH_BYTES = 4096;
const DEFAULT_BUDGET = Object.freeze({ maxBytes: 256 * 1024 * 1024, timeoutMs: 30_000 });
const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const OBJECT_LINE_RE = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\w+)$/;

// Private copies of the proposal-record helpers (chat-proposal-records.js is written by a sibling
// slice); both follow the frozen C1 definition: sorted keys, ordered arrays, no whitespace.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const fail = (reason, cause_code) => ({ ok: false, reason, cause_code });

function lexicalPathProblem(value, path) {
  if (typeof value !== 'string' || !value) return 'path_invalid';
  if (Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) return 'path_invalid';
  if (/[\0\r\n]/.test(value)) return 'path_invalid';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return 'path_invalid';
  if (path.sep === '\\' && value.includes('\\')) return 'path_invalid';
  if (value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return 'path_invalid';
  return '';
}

function normalizeSelection(paths, path) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_PATHS) return null;
  for (const value of paths) if (lexicalPathProblem(value, path)) return null;
  const sorted = [...new Set(paths)].sort();
  return sorted.length === paths.length ? sorted : null;
}

function createClock(budget, now) {
  const startedAt = now();
  return {
    remaining: () => Math.max(0, budget.timeoutMs - (now() - startedAt)),
    expired: () => now() - startedAt >= budget.timeoutMs,
  };
}

// Maps a failed admitted exec result: a spent budget is capacity, an abort or git error unavailable.
function execFailure(result, clock) {
  if (clock.expired()) return fail('capacity', 'binding_budget');
  return fail('unavailable', result?.reason === 'aborted' ? 'aborted' : 'git_failed');
}

// Parent-directory containment (junction/symlink escape) with the leaf lstat'ed, never followed.
async function inspectPath(root, rel, { fs, path }) {
  const slash = rel.lastIndexOf('/');
  const parentRel = slash < 0 ? '.' : rel.slice(0, slash);
  const parent = await resolveContained(root, parentRel, { fs, path });
  if (!parent.ok) {
    return fail('invalid_request', parent.reason === 'path_outside_workspace' ? 'path_outside_workspace' : 'path_unreadable');
  }
  const absolute = path.join(parent.real, rel.slice(slash + 1));
  let stats;
  try {
    stats = await fs.lstat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ok: true, absolute, kind: 'missing', size: 0 };
    return fail('invalid_request', 'path_unreadable');
  }
  if (stats.isSymbolicLink()) return { ok: true, absolute, kind: 'symlink', size: 0 };
  if (!stats.isFile()) return fail('invalid_request', 'path_not_file');
  return { ok: true, absolute, kind: 'file', size: Number(stats.size) || 0 };
}

async function readRef(exec, status, clock) {
  const result = await exec(['symbolic-ref', '-q', 'HEAD'], { timeoutMs: clock.remaining() });
  if (result.success) {
    const ref = String(result.stdout || '').trim();
    return ref ? { ref } : fail('unavailable', 'ref_unreadable');
  }
  if (result.reason === 'aborted' || clock.expired()) return execFailure(result, clock);
  // `symbolic-ref -q` exits 1 quietly for a detached HEAD; the status header must agree.
  return status.detached === true ? { ref: null } : fail('unavailable', 'ref_unreadable');
}

async function readHead(exec, root, signal, clock) {
  const result = await exec(['rev-parse', '--verify', 'HEAD'], { timeoutMs: clock.remaining() });
  if (result.success) {
    const head = String(result.stdout || '').trim().toLowerCase();
    return OID_RE.test(head) ? { head } : fail('unavailable', 'head_unreadable');
  }
  if (result.reason === 'aborted' || clock.expired()) return execFailure(result, clock);
  const probe = await probeHeadState((_cwd, args, options) => exec(args, options), root, signal);
  return probe.failure || probe.hasHead ? fail('unavailable', 'head_unreadable') : { head: null };
}

// One `cat-file --batch-check` per rev list: null for a missing object, else its oid.
async function objectIds(exec, revs, clock) {
  if (!revs.length) return { ids: [] };
  const result = await exec(['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    input: `${revs.join('\n')}\n`,
    timeoutMs: clock.remaining(),
  });
  if (!result.success) return execFailure(result, clock);
  const lines = String(result.stdout || '').split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean);
  if (lines.length !== revs.length) return fail('unavailable', 'git_failed');
  return { ids: lines.map((line) => OBJECT_LINE_RE.exec(line)?.[1] || null) };
}

async function hashWorktree(exec, items, { fs, clock }) {
  const files = items.filter((item) => item.kind === 'file');
  const ids = new Map();
  if (files.length) {
    const result = await exec(['hash-object', '--stdin-paths'], {
      input: `${files.map((item) => cQuotePath(item.path)).join('\n')}\n`,
      timeoutMs: clock.remaining(),
    });
    if (!result.success) return execFailure(result, clock);
    const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean);
    if (lines.length !== files.length || !lines.every((line) => OID_RE.test(line))) return fail('unavailable', 'git_failed');
    files.forEach((item, index) => ids.set(item.path, lines[index]));
  }
  for (const item of items.filter((entry) => entry.kind === 'symlink')) {
    // A link is hashed by its target text, as git stores it; the target is never followed.
    let target;
    try {
      target = await fs.readlink(item.absolute);
    } catch (_error) {
      return fail('invalid_request', 'path_unreadable');
    }
    const result = await exec(['hash-object', '--stdin'], { input: target, timeoutMs: clock.remaining() });
    const oid = String(result.stdout || '').trim().toLowerCase();
    if (!result.success || !OID_RE.test(oid)) return execFailure(result, clock);
    ids.set(item.path, oid);
  }
  return { ids };
}

async function collectFacts({ root, signal, exec }, selection, { fs, path, budget, now }) {
  const clock = createClock(budget, now);
  const items = [];
  let totalBytes = 0;
  for (const rel of selection) {
    const inspected = await inspectPath(root, rel, { fs, path });
    if (!inspected.ok) return inspected;
    totalBytes += inspected.size;
    if (totalBytes > budget.maxBytes) return fail('capacity', 'binding_budget');
    items.push({ path: rel, ...inspected });
  }
  if (clock.expired()) return fail('capacity', 'binding_budget');

  const statusResult = await exec(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'], {
    streamOutput: true,
    timeoutMs: clock.remaining(),
  });
  if (!statusResult.success) return execFailure(statusResult, clock);
  if (statusResult.truncated === true) return fail('capacity', 'status_truncated');
  const status = parseStatus(statusResult.stdout);
  const changes = new Map(status.files.map((file) => [file.path, file]));
  for (const item of items) {
    const change = changes.get(item.path);
    if (!change) return fail('invalid_request', 'path_not_changed');
    item.change = change;
  }

  const ref = await readRef(exec, status, clock);
  if (ref.ok === false) return ref;
  const head = await readHead(exec, root, signal, clock);
  if (head.ok === false) return head;

  // A renamed path has no HEAD entry of its own; its HEAD side is the original name.
  const headIds = await objectIds(exec, head.head
    ? items.map((item) => `${head.head}:${item.change.origPath || item.path}`) : [], clock);
  if (headIds.ok === false) return headIds;
  const indexIds = await objectIds(exec, items.map((item) => `:0:${item.path}`), clock);
  if (indexIds.ok === false) return indexIds;
  const worktree = await hashWorktree(exec, items, { fs, clock });
  if (worktree.ok === false) return worktree;

  const paths = items.map((item, index) => ({
    path: item.path,
    orig_path: item.change.origPath || null,
    index_status: item.change.index,
    worktree_status: item.change.worktree,
    head_oid: head.head ? headIds.ids[index] : null,
    index_oid: indexIds.ids[index],
    worktree_oid: worktree.ids.get(item.path) || null,
    worktree_kind: item.kind,
  }));
  const facts = { ref: ref.ref, head: head.head, paths };
  return { ok: true, git: { ...facts, fingerprint: sha256Hex(canonicalJson(facts)) } };
}

// Maps a failed Git-service envelope (feature off, not a repo, root moved) to a binding failure.
function mapServiceFailure(result) {
  const reason = String(result?.reason || '');
  if (result?.available === false) {
    if (reason === 'feature_disabled') return fail('invalid_request', 'git_disabled');
    if (reason === 'no_root' || reason === 'root_context_unavailable') return fail('invalid_request', 'no_workspace');
    if (reason === 'root_changed') return fail('authority_changed', 'root_changed');
    return fail('unavailable', reason || 'git_unavailable');
  }
  if (result?.isRepo === false) return fail('invalid_request', 'not_git');
  if (reason === 'not_repo_toplevel') return fail('invalid_request', 'not_repo_toplevel');
  return fail('unavailable', result?.reason === 'aborted' ? 'aborted' : 'git_failed');
}

async function captureGitFacts({
  gitService, paths, signal = null, budget = {}, now = Date.now, fs = fsPromises, path = nodePath,
} = {}) {
  const selection = normalizeSelection(paths, path);
  if (!selection) return fail('invalid_request', 'field_paths');
  if (typeof gitService?.readWithExec !== 'function') return fail('invalid_request', 'git_unavailable');
  const limits = { ...DEFAULT_BUDGET, ...budget };
  let outcome;
  try {
    outcome = await gitService.readWithExec('captureProposalBinding',
      (context) => collectFacts(context, selection, { fs, path, budget: limits, now }), { signal });
  } catch (_error) {
    return fail('unavailable', 'git_failed');
  }
  if (outcome?.ok === true && outcome.git) return outcome;
  if (outcome && typeof outcome.reason === 'string' && typeof outcome.cause_code === 'string' && outcome.available === undefined) {
    return fail(outcome.reason, outcome.cause_code);
  }
  return mapServiceFailure(outcome);
}

module.exports = {
  DEFAULT_BUDGET,
  MAX_PATHS,
  canonicalJson,
  captureGitFacts,
  sha256Hex,
};
