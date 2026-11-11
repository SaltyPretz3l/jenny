/* services/workspace-git-checkpoint-refs.js - checkpoint ref namespaces
 * (<prefix>/<session>/<sequence>) and their retention planning, split out of
 * workspace-git-checkpoint.js for the file-size ceiling.
 *
 * Turn checkpoints live under refs/jenny/checkpoints; the synced-workspace
 * restore points (row 106) under refs/jenny/sandbox. Each namespace lists,
 * validates and prunes only its own refs, so one never retires the other's.
 */

'use strict';

const { createHash } = require('crypto');

const CHECKPOINT_FORMAT = '%(refname)%00%(objectname)%00%(committerdate:iso-strict)';
// The session segment is validated against git ref-component rules (no
// leading dot, no "..", no ".lock" tail); sequence is a bounded positive integer.
const CHECKPOINT_SESSION_RE = /^(?!\.)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
const MAX_SESSION_CHARS = 40;
const DEFAULT_RETENTION = Object.freeze({
  perSession: 20,
  total: 100,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
});

// Caps and hash-stabilizes a caller-supplied session id into one git-ref-safe
// path segment. A value that is ALREADY ref-safe and within the length cap
// passes through unchanged (real Electron session ids, e.g.
// sess_<epochms>_<12hex>, round-trip losslessly). Anything else — unsafe
// characters, traversal dots, overlength — maps DETERMINISTICALLY to
// `<safe-stem>-<8-hex sha256 of the raw value>`, so distinct raw inputs that
// sanitize to the same stem still receive distinct, collision-resistant
// segments and the same raw input always maps to the same segment.
function sanitizeCheckpointSession(session) {
  const raw = String(session == null ? '' : session).trim();
  if (raw && raw.length <= MAX_SESSION_CHARS && CHECKPOINT_SESSION_RE.test(raw)) {
    return raw;
  }
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8);
  const stem = raw
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, MAX_SESSION_CHARS - 9)
    .replace(/[._-]+$/, '');
  return `${stem || 'session'}-${digest}`;
}

function sortRowsNewestFirst(rows) {
  return rows.sort((a, b) => {
    const aMs = Date.parse(a.createdAt) || 0;
    const bMs = Date.parse(b.createdAt) || 0;
    return (bMs - aMs) || (b.sequence - a.sequence) || a.ref.localeCompare(b.ref);
  });
}

/** One ref namespace: `<prefix>/<session>/<sequence>` with its own retention. */
function createCheckpointNamespace(prefix, retention = DEFAULT_RETENTION) {
  const refRe = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\/([^/]+)\\/([1-9][0-9]{0,8})$`);

  function refIsSafe(ref) {
    const match = refRe.exec(String(ref || ''));
    return Boolean(match && CHECKPOINT_SESSION_RE.test(match[1]));
  }

  function sessionOf(ref) {
    return refRe.exec(ref)[1];
  }

  // Parses `for-each-ref --format=<CHECKPOINT_FORMAT>` output scoped to one
  // session's namespace and returns the next sequence number (max + 1).
  function nextSequence(stdout) {
    let max = 0;
    for (const line of String(stdout || '').split(/\r?\n/)) {
      const ref = line.split('\0', 1)[0].trim();
      if (!refIsSafe(ref)) continue;
      const n = Number(refRe.exec(ref)[2]);
      if (Number.isSafeInteger(n) && n > max) max = n;
    }
    return max + 1;
  }

  // NUL-format for-each-ref output -> normalized row list, newest first.
  function parseRefs(stdout) {
    const checkpoints = [];
    for (const line of String(stdout || '').split(/\r?\n/)) {
      if (!line) continue;
      const [ref = '', sha = '', createdAt = ''] = line.split('\0');
      if (!refIsSafe(ref) || !SHA_RE.test(String(sha).toLowerCase())) continue;
      const match = refRe.exec(ref);
      checkpoints.push({
        ref,
        sha: String(sha).toLowerCase(),
        session: match[1],
        sequence: Number(match[2]),
        createdAt: Number.isFinite(Date.parse(createdAt)) ? new Date(createdAt).toISOString() : '',
      });
    }
    return sortRowsNewestFirst(checkpoints);
  }

  // Retention plan: which refs should be pruned given per-session, total, and
  // age caps. Rows are normalized INTERNALLY — malformed refs/SHAs (and refs of
  // another namespace) are dropped, duplicates deduped, and ordering recomputed
  // here — so a caller can never steer retention with a crafted or shuffled row
  // list. `protectedRefs` (e.g. a just-created checkpoint, a restore target, or
  // a fresh rollback ref) are never pruned, even when age-expired. Returns
  // [{ ref, sha }] so every delete can be compare-and-swapped against the SHA
  // observed at planning time.
  function planRetention(rows, {
    nowMs = Date.now(),
    perSession = retention.perSession,
    total = retention.total,
    maxAgeMs = retention.maxAgeMs,
    protectedRefs = [],
  } = {}) {
    const protectedSet = new Set(
      (Array.isArray(protectedRefs) ? protectedRefs : []).map((value) => String(value || ''))
    );
    const byRef = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const ref = String(row?.ref || '');
      const sha = String(row?.sha || '').toLowerCase();
      if (!refIsSafe(ref) || !SHA_RE.test(sha) || byRef.has(ref)) continue;
      const match = refRe.exec(ref);
      const createdMs = Date.parse(String(row?.createdAt || ''));
      byRef.set(ref, {
        ref,
        sha,
        session: match[1],
        sequence: Number(match[2]),
        createdAt: Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : '',
      });
    }
    const sorted = sortRowsNewestFirst([...byRef.values()]);
    const prune = new Map();
    const markPrune = (row) => {
      if (!protectedSet.has(row.ref)) prune.set(row.ref, { ref: row.ref, sha: row.sha });
    };
    const bySession = new Map();
    for (const row of sorted) {
      const createdMs = Date.parse(row.createdAt) || 0;
      if (createdMs > 0 && createdMs < nowMs - maxAgeMs) markPrune(row);
      const sessionRows = bySession.get(row.session) || [];
      sessionRows.push(row);
      bySession.set(row.session, sessionRows);
    }
    const perSessionCap = Math.max(1, Math.trunc(Number(perSession)) || 1);
    for (const sessionRows of bySession.values()) {
      for (const row of sessionRows.slice(perSessionCap)) markPrune(row);
    }
    const totalCap = Math.max(1, Math.trunc(Number(total)) || 1);
    const retained = sorted.filter((row) => !prune.has(row.ref));
    for (const row of retained.slice(totalCap)) markPrune(row);
    return [...prune.values()].sort((a, b) => a.ref.localeCompare(b.ref));
  }

  return Object.freeze({ prefix, refIsSafe, sessionOf, nextSequence, parseRefs, planRetention });
}

const CHECKPOINT_NAMESPACE = createCheckpointNamespace('refs/jenny/checkpoints');
const SANDBOX_NAMESPACE = createCheckpointNamespace('refs/jenny/sandbox');

module.exports = {
  CHECKPOINT_FORMAT,
  CHECKPOINT_NAMESPACE,
  SANDBOX_NAMESPACE,
  SHA_RE,
  createCheckpointNamespace,
  sanitizeCheckpointSession,
};
