'use strict';

// Pure `session_mail` record normalizers, counts, capacity and pruning
// (row 59 checkpoint 4, slice S1). No IO; the durable writer is ./session-mail-store.
// Every normalizer returns a canonical clone of a closed, self-consistent record or
// null. Callers keep null (invalid / future-version / duplicate) entries verbatim as
// opaque raw values, so an older build never destroys a newer build's mail.

const { isUuid } = require('./chat-proposal-records');
const { MESSAGE_ERROR_CODES } = require('./error-codes');
const {
  INCLUDED_ROW_PREFIX, RECEIPT_ROW_PREFIX, isHex64, isId, isIso, isPlainObject, validateEnvelope,
} = require('./session-message-envelope');

const MAIL_LIMITS = Object.freeze({
  inbox_records: 256,
  inbox_body_bytes: 2 * 1024 * 1024,
  outbox_records: 128,
  outbox_body_bytes: 2 * 1024 * 1024,
  prepared_expiry_ms: 24 * 60 * 60 * 1000,
  finalized_per_session: 1024,
  finalized_max_age_ms: 30 * 24 * 60 * 60 * 1000,
  published_snapshots: 64,
  snapshot_entries: 16,
  remaining_sends_max: 100,
  live_grants_per_source: 32,
  agent_sends_per_turn: 8,
  grant_ttl_ms: 7 * 24 * 60 * 60 * 1000,
  grant_retire_after_ms: 30 * 24 * 60 * 60 * 1000,
  purpose_max_bytes: 512,
});

const OUTBOX_STATES = Object.freeze(['prepared', 'pending', 'delivered', 'failed', 'cancelled']);
const UNDELIVERED_STATES = Object.freeze(['prepared', 'pending', 'failed']);
const AUTH_KINDS = Object.freeze(['user_send', 'agent_once', 'agent_directional']);
const DEFERRED_REASONS = Object.freeze(['context_budget', 'budget_unknown']);
const OUTBOX_KEYS = Object.freeze([
  'envelope', 'operation_id', 'gesture_id', 'tool_call_id', 'authorization_id', 'state', 'prepared_at',
  'expires_at', 'send_requested_at', 'delivered_at', 'destination_receipt_id', 'last_error',
  'restore_requires_confirmation',
]);
const INBOX_KEYS = Object.freeze([
  'envelope', 'receipt_id', 'receive_sequence', 'delivered_at', 'read_at', 'source_receipt_confirmed_at',
  'source_absent', 'context',
]);
const DISCARD_KEYS = Object.freeze([
  'schema_version', 'message_id', 'envelope_sha256', 'receipt_id', 'receive_sequence', 'discarded_at',
  'source_receipt_confirmed_at', 'source_absent', 'canonical_message_id',
]);
const AUTH_KEYS = Object.freeze([
  'schema_version', 'authorization_id', 'kind', 'source_session_id', 'source_session_incarnation',
  'source_project_id', 'destination_session_id', 'destination_session_incarnation', 'destination_project_id',
  'operation_id', 'body_sha256', 'purpose', 'consent_event_id', 'created_at', 'expires_at', 'remaining_sends',
  'revoked_at',
]);
const SNAPSHOT_KEYS = Object.freeze([
  'schema_version', 'snapshot_id', 'turn_id', 'cutoff_receive_sequence', 'entries', 'deferred_count',
  'deferred_reason', 'estimator_id', 'state', 'created_at',
]);
const RESERVATION_KEYS = Object.freeze([
  'turn_id', 'slot_bytes', 'reserved_at', 'parent_session_id', 'parent_session_incarnation', 'reporting_consent_id',
]);
const REPORT_SLOT_BYTES = 8192;
const ERROR_CODE_RE = /^CMP-MESSAGE-00(?:0[1-9]|1[0-2])$/;
const STALE_OPERATION_ERROR = Object.freeze({ code: MESSAGE_ERROR_CODES.STALE_OPERATION, reason: 'stale_operation', retryable: false });

const hasExactKeys = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const nullOr = (value, check) => value === null || check(value);
const wellFormed = (text) => (typeof text.isWellFormed === 'function' ? text.isWellFormed() : true);
// A grant purpose: well-formed text of 1-512 UTF-8 bytes.
const validPurpose = (value) => typeof value === 'string' && wellFormed(value)
  && Buffer.byteLength(value, 'utf8') >= 1 && Buffer.byteLength(value, 'utf8') <= MAIL_LIMITS.purpose_max_bytes;
const isSeq = (value) => Number.isSafeInteger(value) && value >= 1;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const timeMs = (iso) => Date.parse(iso);
const nowMs = (now) => {
  const date = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid timestamp');
  return date.getTime();
};
const bodyBytes = (envelope) => Buffer.byteLength(envelope.body, 'utf8');

function validLastError(value) {
  return hasExactKeys(value, ['code', 'reason', 'retryable'])
    && typeof value.code === 'string' && ERROR_CODE_RE.test(value.code)
    && typeof value.reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value.reason)
    && typeof value.retryable === 'boolean';
}

// ---------- outbox ----------

function validOutboxStateCombo(raw) {
  const delivered = raw.state === 'delivered';
  if (delivered !== (raw.delivered_at !== null) || delivered !== (raw.destination_receipt_id !== null)) return false;
  if (raw.state === 'prepared') return raw.send_requested_at === null && raw.authorization_id === null;
  if (raw.state === 'pending' || delivered) return raw.send_requested_at !== null;
  if (raw.state === 'failed') return raw.last_error !== null && raw.send_requested_at !== null;
  return true; // cancelled
}

function normalizeOutboxRecord(raw) {
  if (!hasExactKeys(raw, OUTBOX_KEYS)) return null;
  const envelope = validateEnvelope(raw.envelope);
  if (!envelope || !isUuid(raw.operation_id) || !OUTBOX_STATES.includes(raw.state)) return null;
  if (!nullOr(raw.gesture_id, isUuid) || !nullOr(raw.tool_call_id, isId) || !nullOr(raw.authorization_id, isUuid)) return null;
  if (!isIso(raw.prepared_at) || !nullOr(raw.expires_at, isIso) || !nullOr(raw.send_requested_at, isIso)) return null;
  if (!nullOr(raw.delivered_at, isIso) || !nullOr(raw.destination_receipt_id, isUuid)) return null;
  if (!nullOr(raw.last_error, validLastError) || typeof raw.restore_requires_confirmation !== 'boolean') return null;
  if (!validOutboxStateCombo(raw)) return null;
  return { ...structuredClone(raw), envelope };
}

// ---------- inbox ----------

function validContext(context, envelope) {
  if (!isPlainObject(context)) return false;
  switch (context.state) {
    case 'queued': return hasExactKeys(context, ['state']);
    case 'reserved':
      return hasExactKeys(context, ['state', 'turn_id', 'snapshot_id']) && isId(context.turn_id) && isUuid(context.snapshot_id);
    case 'included':
      return hasExactKeys(context, ['state', 'turn_id', 'snapshot_id', 'included_at', 'canonical_message_id'])
        && isId(context.turn_id) && isUuid(context.snapshot_id) && isIso(context.included_at)
        && context.canonical_message_id === `${INCLUDED_ROW_PREFIX}${envelope.message_id}`;
    case 'excluded_by_user': return hasExactKeys(context, ['state', 'changed_at']) && isIso(context.changed_at);
    default: return false;
  }
}

function normalizeInboxRecord(raw) {
  if (!hasExactKeys(raw, INBOX_KEYS)) return null;
  const envelope = validateEnvelope(raw.envelope);
  if (!envelope || !isUuid(raw.receipt_id) || !isSeq(raw.receive_sequence) || !isIso(raw.delivered_at)) return null;
  if (!nullOr(raw.read_at, isIso) || !nullOr(raw.source_receipt_confirmed_at, isIso)) return null;
  if (typeof raw.source_absent !== 'boolean' || !validContext(raw.context, envelope)) return null;
  return { ...structuredClone(raw), envelope };
}

function normalizeDiscardReceipt(raw) {
  if (!hasExactKeys(raw, DISCARD_KEYS) || raw.schema_version !== 1) return null;
  if (!isUuid(raw.message_id) || !isHex64(raw.envelope_sha256) || !isUuid(raw.receipt_id)) return null;
  if (!isSeq(raw.receive_sequence) || !isIso(raw.discarded_at) || !nullOr(raw.source_receipt_confirmed_at, isIso)) return null;
  if (typeof raw.source_absent !== 'boolean') return null;
  if (raw.canonical_message_id !== `${RECEIPT_ROW_PREFIX}${raw.message_id}`) return null;
  return structuredClone(raw);
}

// ---------- authorizations ----------

// Per-kind rules: a directional grant has no operation / body, a required purpose and a seven-day
// expiry; the per-operation kinds bind an operation and its body hash.
function validAuthorizationKind(raw) {
  const perOperation = raw.kind !== 'agent_directional';
  if (perOperation !== (raw.operation_id !== null) || perOperation !== (raw.body_sha256 !== null)) return false;
  if (raw.kind === 'user_send') return raw.purpose === null;
  if (perOperation) return true;
  return validPurpose(raw.purpose) && raw.expires_at !== null
    && timeMs(raw.expires_at) === timeMs(raw.created_at) + MAIL_LIMITS.grant_ttl_ms;
}

function normalizeAuthorizationRecord(raw) {
  if (!hasExactKeys(raw, AUTH_KEYS) || raw.schema_version !== 1) return null;
  if (!isUuid(raw.authorization_id) || !AUTH_KINDS.includes(raw.kind)) return null;
  if (!['source_session_id', 'source_session_incarnation', 'destination_session_id', 'destination_session_incarnation']
    .every((key) => isId(raw[key]))) return null;
  if (!nullOr(raw.source_project_id, isId) || !nullOr(raw.destination_project_id, isId)) return null;
  if (!isId(raw.consent_event_id) || !isIso(raw.created_at) || !nullOr(raw.expires_at, isIso)) return null;
  if (!nullOr(raw.revoked_at, isIso) || !nullOr(raw.purpose, validPurpose) || !nullOr(raw.operation_id, isUuid)) return null;
  if (!nullOr(raw.body_sha256, isHex64)) return null;
  if (!Number.isSafeInteger(raw.remaining_sends) || raw.remaining_sends < 0 || raw.remaining_sends > MAIL_LIMITS.remaining_sends_max) return null;
  return validAuthorizationKind(raw) ? structuredClone(raw) : null;
}

// ---------- admission snapshots ----------

function validSnapshotEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAIL_LIMITS.snapshot_entries) return false;
  const seen = new Set();
  for (const entry of entries) {
    if (!hasExactKeys(entry, ['message_id', 'body_sha256']) || !isUuid(entry.message_id) || !isHex64(entry.body_sha256)
      || seen.has(entry.message_id)) return false;
    seen.add(entry.message_id);
  }
  return true;
}

function normalizeAdmissionSnapshot(raw) {
  if (!hasExactKeys(raw, SNAPSHOT_KEYS) || raw.schema_version !== 1) return null;
  if (!isUuid(raw.snapshot_id) || !isId(raw.turn_id) || !isSeq(raw.cutoff_receive_sequence)) return null;
  if (!validSnapshotEntries(raw.entries) || !isCount(raw.deferred_count)) return null;
  if (raw.deferred_reason !== null && !DEFERRED_REASONS.includes(raw.deferred_reason)) return null;
  if (!isId(raw.estimator_id) || !['reserved', 'published'].includes(raw.state) || !isIso(raw.created_at)) return null;
  return structuredClone(raw);
}

// ---------- report reservations ----------

function normalizeReportReservation(raw) {
  if (!hasExactKeys(raw, RESERVATION_KEYS) || raw.slot_bytes !== REPORT_SLOT_BYTES) return null;
  if (!['turn_id', 'parent_session_id', 'parent_session_incarnation'].every((key) => isId(raw[key]))) return null;
  if (!isIso(raw.reserved_at) || !isUuid(raw.reporting_consent_id)) return null;
  return structuredClone(raw);
}

const NORMALIZERS = Object.freeze({
  outbox: [normalizeOutboxRecord, (record) => record.operation_id],
  inbox: [normalizeInboxRecord, (record) => record.envelope.message_id],
  discarded: [normalizeDiscardReceipt, (record) => record.message_id],
  authorizations: [normalizeAuthorizationRecord, (record) => record.authorization_id],
  report_reservations: [normalizeReportReservation, (record) => record.turn_id],
  admission_snapshots: [normalizeAdmissionSnapshot, (record) => record.snapshot_id],
});

// Splits a raw stored list into valid normalized records and opaque raw entries
// (invalid, future-version or duplicate identity) that must be kept untouched.
function partitionList(list, normalize, identity) {
  const records = [];
  const opaque = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const record = normalize(raw);
    const id = record ? identity(record) : null;
    if (record && !seen.has(id)) {
      seen.add(id);
      records.push(record);
    } else {
      opaque.push(structuredClone(raw));
    }
  }
  return { records, opaque };
}

// ---------- counts and capacity ----------

const latestFirst = (a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0);

// Structural unread count over RAW inbox entries (cheap enough for every summary projection).
function countUnreadInbox(mail) {
  const inbox = mail && typeof mail === 'object' && Array.isArray(mail.inbox) ? mail.inbox : [];
  let unread = 0;
  for (const entry of inbox) {
    if (isPlainObject(entry) && entry.read_at === null && isPlainObject(entry.envelope) && isPlainObject(entry.context)) unread += 1;
  }
  return unread;
}

function computeCounts(mail) {
  const counts = {
    unread: 0, queued: 0, reserved: 0, excluded_by_user: 0, included: 0,
    pending_delivery: 0, failed_delivery: 0, deferred_reason: null,
  };
  for (const record of mail?.inbox || []) {
    if (record.read_at === null) counts.unread += 1;
    counts[record.context.state] += 1;
  }
  for (const record of mail?.outbox || []) {
    if (record.state === 'pending') counts.pending_delivery += 1;
    else if (record.state === 'failed') counts.failed_delivery += 1;
  }
  if (counts.queued > 0) {
    const latest = [...(mail?.admission_snapshots || [])].filter((s) => s.state === 'published').sort(latestFirst)[0];
    counts.deferred_reason = latest?.deferred_reason || null;
  }
  return counts;
}

function candidateBytes(candidate) {
  if (candidate === undefined || candidate === null) return 0;
  if (typeof candidate === 'number') return Math.max(0, candidate);
  if (typeof candidate === 'string') return Buffer.byteLength(candidate, 'utf8');
  if (typeof candidate.body === 'string') return Buffer.byteLength(candidate.body, 'utf8');
  return candidate.envelope ? bodyBytes(candidate.envelope) : 0;
}

function capacity(records, maxRecords, maxBytes, candidate, reserved = []) {
  const bytes = records.reduce((sum, record) => sum + bodyBytes(record.envelope), 0)
    + reserved.reduce((sum, slot) => sum + slot.slot_bytes, 0);
  const count = records.length + reserved.length;
  const added = candidateBytes(candidate);
  return {
    records: count,
    body_bytes: bytes,
    // Whether admitting one more record of the candidate's size would exceed a limit.
    full: count + 1 > maxRecords || bytes + added > maxBytes,
  };
}

// Current usage plus `full` for one more inbox record (candidate: string body, {body}, {envelope}, or byte count).
function inboxCapacity(mail, candidate) {
  return capacity(mail?.inbox || [], MAIL_LIMITS.inbox_records, MAIL_LIMITS.inbox_body_bytes, candidate);
}

// Undelivered outbox = prepared + pending + failed, plus each report reservation as one record and its slot bytes.
function outboxCapacity(mail, candidate) {
  const undelivered = (mail?.outbox || []).filter((record) => UNDELIVERED_STATES.includes(record.state));
  const reserved = Array.isArray(mail?.report_reservations) ? mail.report_reservations : [];
  return capacity(undelivered, MAIL_LIMITS.outbox_records, MAIL_LIMITS.outbox_body_bytes, candidate, reserved);
}

// ---------- agent sends and directional grants ----------

const isAgentOp = (record) => record.envelope.kind === 'agent_message';

// The outbox record an agent tool call already prepared (its identity: incarnation, turn, call), else null.
function findAgentOperation(mail, { incarnation, turnId, toolCallId }) {
  return (mail?.outbox || []).find((record) => isAgentOp(record) && record.tool_call_id === toolCallId
    && record.envelope.source_turn_id === turnId && record.envelope.source_session_incarnation === incarnation) || null;
}

// New agent sends a source turn has prepared (a retry reuses its record, so it never counts twice).
function countAgentSendsForTurn(mail, { incarnation, turnId }) {
  return (mail?.outbox || []).filter((record) => isAgentOp(record) && record.envelope.source_turn_id === turnId
    && record.envelope.source_session_incarnation === incarnation).length;
}

// A directional grant that can still authorize a send now.
function isLiveGrant(auth, now) {
  return auth.kind === 'agent_directional' && auth.revoked_at === null && auth.remaining_sends > 0
    && auth.expires_at !== null && timeMs(auth.expires_at) > nowMs(now);
}

const liveGrantCount = (mail, now) => (mail?.authorizations || []).filter((auth) => isLiveGrant(auth, now)).length;

// True when `auth` can no longer authorize `envelope`'s delivery: revoked, expired, or an identity /
// project on either end changed. `current` = {source, destination}, each {session_incarnation, project_id}
// or null (a null end is skipped, e.g. a recipient that is gone: delivery reports that itself).
function authorizationBlocked(auth, envelope, current, now) {
  if (auth.revoked_at !== null || (auth.expires_at !== null && timeMs(auth.expires_at) <= nowMs(now))) return true;
  if (auth.source_session_id !== envelope.source_session_id || auth.destination_session_id !== envelope.destination_session_id) return true;
  if (auth.kind === 'agent_once' && (auth.operation_id === null || auth.body_sha256 !== envelope.body_sha256)) return true;
  return ['source', 'destination'].some((end) => current[end]
    && (auth[`${end}_session_incarnation`] !== current[end].session_incarnation || auth[`${end}_project_id`] !== current[end].project_id));
}

// ---------- pruning ----------

function expirePrepared(record, now) {
  if (record.state !== 'prepared' || record.expires_at === null || timeMs(record.expires_at) > now) return record;
  return { ...record, state: 'cancelled', last_error: { ...STALE_OPERATION_ERROR } };
}

const retireInbox = (record) => record.read_at !== null && record.context.state === 'included'
  && (record.source_receipt_confirmed_at !== null || record.source_absent);

// Newest `cap` of `records` within `maxAgeMs` (by `at`), keeping every protected one.
function capFinalized(records, { at, cap, maxAgeMs, now, protectedCheck = () => false }) {
  const fresh = records.filter((record) => protectedCheck(record) || now - timeMs(at(record)) <= maxAgeMs);
  const keep = new Set([...fresh].filter((r) => !protectedCheck(r))
    .sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0)).slice(-cap));
  return fresh.filter((record) => protectedCheck(record) || keep.has(record));
}

// When a directional grant stopped being usable: its revocation, its expiry, or (once all its sends are
// spent) its last send. Null only when nothing ends it.
function grantEndedAt(auth, outbox) {
  const ends = [];
  if (auth.revoked_at !== null) ends.push(timeMs(auth.revoked_at));
  if (auth.expires_at !== null) ends.push(timeMs(auth.expires_at));
  if (auth.remaining_sends === 0) {
    const sends = outbox.filter((op) => op.authorization_id === auth.authorization_id && op.send_requested_at !== null)
      .map((op) => timeMs(op.send_requested_at));
    ends.push(Math.max(timeMs(auth.created_at), ...sends));
  }
  return ends.length ? Math.min(...ends) : null;
}

// Per-operation authorizations retire with their operation; a directional grant retires 30 days after it
// ended (expired, revoked or exhausted) unless an unsettled operation still references it.
function retireAuthorizations(mail, at) {
  const operations = new Set(mail.outbox.map((record) => record.operation_id));
  const referenced = new Set(mail.outbox.filter((op) => UNDELIVERED_STATES.includes(op.state) && op.authorization_id !== null)
    .map((op) => op.authorization_id));
  return mail.authorizations.filter((auth) => {
    if (auth.operation_id !== null) return operations.has(auth.operation_id);
    if (referenced.has(auth.authorization_id)) return true;
    const ended = grantEndedAt(auth, mail.outbox);
    return ended === null || at - ended <= MAIL_LIMITS.grant_retire_after_ms;
  });
}

// A pruned copy: prepared past expiry become cancelled(stale_operation); retired inbox records,
// finalized outbox / discard receipts past 1,024 or 30 days, and old published snapshots drop.
function pruneMail(mail, { now } = {}) {
  const at = nowMs(now);
  const next = structuredClone(mail);
  next.outbox = capFinalized(next.outbox.map((record) => expirePrepared(record, at)), {
    at: (record) => record.delivered_at || record.send_requested_at || record.prepared_at,
    cap: MAIL_LIMITS.finalized_per_session,
    maxAgeMs: MAIL_LIMITS.finalized_max_age_ms,
    now: at,
    protectedCheck: (record) => UNDELIVERED_STATES.includes(record.state),
  });
  next.inbox = next.inbox.filter((record) => !retireInbox(record));
  next.discarded = capFinalized(next.discarded, {
    at: (record) => record.discarded_at,
    cap: MAIL_LIMITS.finalized_per_session,
    maxAgeMs: MAIL_LIMITS.finalized_max_age_ms,
    now: at,
    protectedCheck: (record) => record.source_receipt_confirmed_at === null && !record.source_absent, // dedup proof
  });
  next.authorizations = retireAuthorizations(next, at);
  const published = next.admission_snapshots.filter((snapshot) => snapshot.state === 'published');
  const keepPublished = new Set([...published].sort(latestFirst).slice(0, MAIL_LIMITS.published_snapshots));
  next.admission_snapshots = next.admission_snapshots.filter((s) => s.state !== 'published' || keepPublished.has(s));
  return next;
}

module.exports = {
  AUTH_KINDS, DEFERRED_REASONS, MAIL_LIMITS, NORMALIZERS, OUTBOX_STATES, REPORT_SLOT_BYTES, STALE_OPERATION_ERROR,
  UNDELIVERED_STATES, authorizationBlocked, computeCounts, countAgentSendsForTurn, countUnreadInbox,
  findAgentOperation, inboxCapacity, isLiveGrant, liveGrantCount, normalizeAdmissionSnapshot,
  normalizeAuthorizationRecord, normalizeDiscardReceipt, normalizeInboxRecord, normalizeOutboxRecord,
  normalizeReportReservation, outboxCapacity, partitionList, pruneMail, validPurpose,
};
