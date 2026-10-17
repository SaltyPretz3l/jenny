'use strict';

// Pure `coordination_receipts` records (row 59 checkpoint 5b-2, slice M1). One shared
// normalizer / builder / pruner for both durable writers (chat-proposal-store and
// session-mail-store): a receipt is written in the same flushed mutation as the effect
// it proves and rolls back with it, so a gesture replay survives a restart. Receipts hold
// references only (ids and an arguments hash), never bodies or response payloads.
// No IO. Entries that fail normalization (invalid, future-version or duplicate) are kept
// verbatim by the stores, so an older build never destroys a newer build's receipts.

const { canonicalJson, sha256Hex } = require('./chat-proposal-records');

const RECEIPT_LIMITS = Object.freeze({
  finalized_per_session: 1024,
  finalized_max_age_ms: 30 * 24 * 60 * 60 * 1000,
});
const RECEIPT_KEYS = Object.freeze([
  'schema_version', 'mutation_id', 'method', 'args_sha256', 'resource_kind', 'resource_id', 'accepted_revision',
  'created_at', 'settled_at',
]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const METHOD_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const KIND_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ID_MAX_CHARS = 512;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isIso = (value) => typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= ID_MAX_CHARS;
const nullOr = (value, check) => value === null || check(value);
const isRevision = (value) => Number.isSafeInteger(value) && value >= 0;
const hasExactKeys = (value) => isPlainObject(value) && Object.keys(value).length === RECEIPT_KEYS.length
  && RECEIPT_KEYS.every((key) => Object.hasOwn(value, key));

function nowIso(now) {
  const date = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid timestamp');
  return date.toISOString();
}

const argsSha256 = (args) => sha256Hex(canonicalJson(args));

// The canonical clone of a closed v1 receipt, else null.
function normalizeReceipt(raw) {
  if (!hasExactKeys(raw) || raw.schema_version !== 1) return null;
  if (!isId(raw.mutation_id) || !isId(raw.resource_id)) return null;
  if (typeof raw.method !== 'string' || !METHOD_RE.test(raw.method)) return null;
  if (typeof raw.resource_kind !== 'string' || !KIND_RE.test(raw.resource_kind)) return null;
  if (typeof raw.args_sha256 !== 'string' || !HEX64_RE.test(raw.args_sha256)) return null;
  if (!nullOr(raw.accepted_revision, isRevision) || !isIso(raw.created_at) || !nullOr(raw.settled_at, isIso)) return null;
  return structuredClone(raw);
}

// `args` is hashed with canonicalJson; `settled:false` leaves settled_at null (kept until settled).
function buildReceipt({
  mutationId, method, args, resourceKind, resourceId, acceptedRevision = null, now, settled = true,
}) {
  const at = nowIso(now);
  return normalizeReceipt({
    schema_version: 1,
    mutation_id: mutationId,
    method,
    args_sha256: argsSha256(args),
    resource_kind: resourceKind,
    resource_id: resourceId,
    accepted_revision: acceptedRevision,
    created_at: at,
    settled_at: settled ? at : null,
  });
}

// Valid receipts (unique mutation_id) and the opaque raw entries every write must keep untouched.
function partitionReceipts(list) {
  const records = [];
  const opaque = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const record = normalizeReceipt(raw);
    if (record && !seen.has(record.mutation_id)) {
      seen.add(record.mutation_id);
      records.push(record);
    } else {
      opaque.push(structuredClone(raw));
    }
  }
  return { records, opaque };
}

// The receipts a writer wants to store, or null when any is invalid or a mutation_id repeats.
function normalizeReceiptList(list) {
  if (!Array.isArray(list)) return null;
  const records = list.map(normalizeReceipt);
  const ids = new Set(records.map((record) => record?.mutation_id));
  return records.includes(null) || ids.size !== records.length ? null : records;
}

// The container reading for a stored list: a copy that keeps every entry (opaque ones verbatim).
function normalizeReceiptContainer(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => normalizeReceipt(entry) || structuredClone(entry));
}

const findReceipt = (list, mutationId) => (Array.isArray(list) ? list : []).find((record) => record.mutation_id === mutationId) || null;

// {state:'none'} | {state:'same', receipt} | {state:'conflict', receipt}: a replay with the same
// method and arguments is the same gesture; any change conflicts.
function replayVerdict(list, mutationId, method, args) {
  const receipt = findReceipt(list, mutationId);
  if (!receipt) return { state: 'none' };
  const same = receipt.method === method && receipt.args_sha256 === argsSha256(args);
  return { state: same ? 'same' : 'conflict', receipt };
}

// Unsettled receipts always stay; the newest 1,024 finalized ones within 30 days stay.
function pruneReceipts(list, { now } = {}) {
  const at = Date.parse(nowIso(now));
  const unsettled = list.filter((record) => record.settled_at === null);
  const finalized = list.filter((record) => record.settled_at !== null
    && at - Date.parse(record.settled_at) <= RECEIPT_LIMITS.finalized_max_age_ms)
    .sort((a, b) => (a.settled_at < b.settled_at ? -1 : a.settled_at > b.settled_at ? 1 : 0))
    .slice(-RECEIPT_LIMITS.finalized_per_session);
  const keep = new Set([...unsettled, ...finalized]);
  return list.filter((record) => keep.has(record));
}

// Adds `receipt` (idempotent on mutation_id: an existing receipt is kept) and prunes.
function appendReceipt(list, receipt, { now } = {}) {
  const base = Array.isArray(list) ? list : [];
  const next = receipt && !findReceipt(base, receipt.mutation_id) ? [...base, receipt] : base;
  return pruneReceipts(next, { now });
}

// ---------- proposal gestures (decide / retry / cancel) ----------

// The receipt input of a proposal gesture: the gesture (decision) id is the mutation id, the resource the proposal.
function proposalGestureReceipt(op, req, extra = {}) {
  return {
    mutationId: req.decision_id,
    method: `sessionProposals.${op}`,
    args: { proposal_id: req.proposal_id, expected_revision: req.expected_revision, ...extra },
    resourceKind: 'proposal',
    resourceId: req.proposal_id,
  };
}

// `list` with the gesture's receipt added (accepted at `revision`, settled now), pruned.
function recordGesture(list, input, { revision, now }) {
  return appendReceipt(list, buildReceipt({ ...input, acceptedRevision: revision, now }), { now });
}

const gestureVerdict = (list, input) => replayVerdict(list, input.mutationId, input.method, input.args);

// Marks an unsettled receipt settled (a no-op for an unknown or already settled one).
function settleReceipt(list, mutationId, { now } = {}) {
  const at = nowIso(now);
  return list.map((record) => (record.mutation_id === mutationId && record.settled_at === null
    ? { ...record, settled_at: at } : record));
}

module.exports = {
  RECEIPT_KEYS, RECEIPT_LIMITS, appendReceipt, argsSha256, buildReceipt, findReceipt, normalizeReceipt,
  gestureVerdict, normalizeReceiptContainer, normalizeReceiptList, partitionReceipts, proposalGestureReceipt, pruneReceipts,
  recordGesture, replayVerdict, settleReceipt,
};
