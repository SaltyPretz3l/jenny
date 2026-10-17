'use strict';

// Addressed session message envelope + canonical context-row builders/validators
// (row 59 checkpoint 4, slice S1). Pure: no IO. The envelope is the immutable
// unit that crosses between two chats; the canonical transcript rows
// (`role:'context'`) carry it verbatim and are validated here so a malformed row
// is dropped, never coerced to user/assistant text.

const { canonicalJson, isUuid, sha256Hex } = require('./chat-proposal-records');

const MAX_BODY_BYTES = 16384;
const MAX_REPORT_BODY_BYTES = 8192;
const INCLUDED_ROW_PREFIX = 'ctx_';
const RECEIPT_ROW_PREFIX = 'ctxr_';
const INCLUDED_ROW_KIND = 'session_message';
const RECEIPT_ROW_KIND = 'session_message_receipt';
const ENVELOPE_KINDS = Object.freeze(['user_message', 'agent_message', 'terminal_report']);
const REPORT_OUTCOMES = Object.freeze(['completed', 'failed', 'cancelled', 'awaiting_decision']);
const ENVELOPE_KEYS = Object.freeze([
  'schema_version', 'message_id', 'source_session_id', 'source_session_incarnation', 'source_project_id',
  'destination_session_id', 'destination_session_incarnation', 'destination_project_id', 'source_turn_id',
  'kind', 'created_at', 'body', 'body_sha256', 'report',
]);
const ID_MAX_CHARS = 512;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ERROR_CODE_RE = /^CMP-[A-Z]+-\d{4}$/;
// C0 controls except TAB/LF/CR, and DEL (built from code points, never literal).
const CONTROL_RE = new RegExp(`[${[
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f],
].map(([lo, hi]) => `\\u${lo.toString(16).padStart(4, '0')}-\\u${hi.toString(16).padStart(4, '0')}`).join('')}]`, 'u');

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

const isIso = (value) => typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= ID_MAX_CHARS;
const isHex64 = (value) => typeof value === 'string' && HEX64_RE.test(value);
const wellFormed = (text) => (typeof text.isWellFormed === 'function' ? text.isWellFormed() : true);
const hasExactKeys = (value, keys) => Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

function bodySha256(body) {
  return sha256Hex(String(body));
}

function envelopeSha256(envelope) {
  return sha256Hex(canonicalJson(envelope));
}

// {ok:true} | {ok:false, reason:'invalid_request', field:'body'}.
function validateBody(body, { maxBytes = MAX_BODY_BYTES } = {}) {
  const invalid = { ok: false, reason: 'invalid_request', field: 'body' };
  if (typeof body !== 'string' || !wellFormed(body) || body.trim().length === 0 || CONTROL_RE.test(body)) return invalid;
  const bytes = Buffer.byteLength(body, 'utf8');
  return bytes >= 1 && bytes <= maxBytes ? { ok: true } : invalid;
}

function validReport(report) {
  return isPlainObject(report) && hasExactKeys(report, ['outcome', 'clipped', 'error_code'])
    && REPORT_OUTCOMES.includes(report.outcome) && typeof report.clipped === 'boolean'
    && (report.error_code === null || (typeof report.error_code === 'string' && ERROR_CODE_RE.test(report.error_code)));
}

// The canonical clone of a closed, self-consistent envelope, else null.
function validateEnvelope(raw) {
  if (!isPlainObject(raw) || raw.schema_version !== 1 || !hasExactKeys(raw, ENVELOPE_KEYS)) return null;
  if (!isUuid(raw.message_id) || !ENVELOPE_KINDS.includes(raw.kind) || !isIso(raw.created_at)) return null;
  for (const key of ['source_session_id', 'source_session_incarnation', 'destination_session_id',
    'destination_session_incarnation']) {
    if (!isId(raw[key])) return null;
  }
  for (const key of ['source_project_id', 'destination_project_id', 'source_turn_id']) {
    if (raw[key] !== null && !isId(raw[key])) return null;
  }
  const isReport = raw.kind === 'terminal_report';
  if (isReport ? !validReport(raw.report) : raw.report !== null) return null;
  // An agent-authored message always names the source turn that wrote it.
  if (raw.kind === 'agent_message' && raw.source_turn_id === null) return null;
  if (!validateBody(raw.body, { maxBytes: isReport ? MAX_REPORT_BODY_BYTES : MAX_BODY_BYTES }).ok) return null;
  if (raw.body_sha256 !== bodySha256(raw.body)) return null;
  return structuredClone(raw);
}

// source/destination = {session_id, session_incarnation, project_id}. Null when the result is not a valid envelope.
function buildUserEnvelope({ message_id: messageId, source, destination, body, created_at: createdAt } = {}) {
  const at = createdAt instanceof Date ? createdAt.toISOString() : (createdAt ?? new Date().toISOString());
  return validateEnvelope({
    schema_version: 1,
    message_id: messageId,
    source_session_id: source?.session_id,
    source_session_incarnation: source?.session_incarnation,
    source_project_id: source?.project_id ?? null,
    destination_session_id: destination?.session_id,
    destination_session_incarnation: destination?.session_incarnation,
    destination_project_id: destination?.project_id ?? null,
    source_turn_id: null,
    kind: 'user_message',
    created_at: at,
    body,
    body_sha256: typeof body === 'string' ? bodySha256(body) : undefined,
    report: null,
  });
}

// source/destination = {session_id, session_incarnation, project_id}. A closed agent_message written by
// `turnId` of the source chat; null when the result is not a valid envelope (no turn id, bad body, ids).
function buildAgentEnvelope({
  message_id: messageId, source, destination, turnId, body, created_at: createdAt,
} = {}) {
  const at = createdAt instanceof Date ? createdAt.toISOString() : (createdAt ?? new Date().toISOString());
  if (!isId(turnId)) return null;
  return validateEnvelope({
    schema_version: 1,
    message_id: messageId,
    source_session_id: source?.session_id,
    source_session_incarnation: source?.session_incarnation,
    source_project_id: source?.project_id ?? null,
    destination_session_id: destination?.session_id,
    destination_session_incarnation: destination?.session_incarnation,
    destination_project_id: destination?.project_id ?? null,
    source_turn_id: turnId,
    kind: 'agent_message',
    created_at: at,
    body,
    body_sha256: typeof body === 'string' ? bodySha256(body) : undefined,
    report: null,
  });
}

// child/parent = {session_id, session_incarnation, project_id}. A closed terminal_report from the
// child to its parent; null when the result is not a valid envelope (bad outcome, body, ids).
function buildReportEnvelope({
  child, parent, turnId, outcome, body, clipped, errorCode, messageId, createdAt,
} = {}) {
  const at = createdAt instanceof Date ? createdAt.toISOString() : (createdAt ?? new Date().toISOString());
  if (!isId(turnId)) return null; // a report always names its turn
  return validateEnvelope({
    schema_version: 1,
    message_id: messageId,
    source_session_id: child?.session_id,
    source_session_incarnation: child?.session_incarnation,
    source_project_id: child?.project_id ?? null,
    destination_session_id: parent?.session_id,
    destination_session_incarnation: parent?.session_incarnation,
    destination_project_id: parent?.project_id ?? null,
    source_turn_id: turnId,
    kind: 'terminal_report',
    created_at: at,
    body,
    body_sha256: typeof body === 'string' ? bodySha256(body) : undefined,
    report: { outcome, clipped: Boolean(clipped), error_code: errorCode ?? null },
  });
}

const stamp = (timestamp) => (timestamp instanceof Date ? timestamp.toISOString() : (timestamp ?? new Date().toISOString()));

// The included-in-a-turn transcript row; null for an invalid envelope or turn id.
function buildIncludedRow(envelope, { turn_id: turnId, timestamp } = {}) {
  const valid = validateEnvelope(envelope);
  if (!valid || !isId(turnId)) return null;
  return {
    id: `${INCLUDED_ROW_PREFIX}${valid.message_id}`,
    role: 'context',
    kind: INCLUDED_ROW_KIND,
    content: valid.body,
    session_message: valid,
    turn_id: turnId,
    timestamp: stamp(timestamp),
  };
}

// The non-model-visible receipt row written by a recipient discard.
function buildDiscardReceiptRow(envelope, { timestamp } = {}) {
  const valid = validateEnvelope(envelope);
  if (!valid) return null;
  return {
    id: `${RECEIPT_ROW_PREFIX}${valid.message_id}`,
    role: 'context',
    kind: RECEIPT_ROW_KIND,
    content: valid.body,
    session_message: valid,
    disposition: 'discarded',
    timestamp: stamp(timestamp),
  };
}

// The row itself when it is a valid canonical context row (either kind), else null.
// Normalized store rows carry extra default fields; only the contract fields are checked.
function validateContextRow(row) {
  if (!isPlainObject(row) || row.role !== 'context') return null;
  const envelope = validateEnvelope(row.session_message);
  if (!envelope || row.content !== envelope.body) return null;
  if (typeof row.timestamp !== 'string' || row.timestamp.length === 0) return null;
  if (row.kind === INCLUDED_ROW_KIND) {
    if (row.id !== `${INCLUDED_ROW_PREFIX}${envelope.message_id}` || !isId(row.turn_id)) return null;
    if (row.disposition !== undefined && row.disposition !== '') return null;
    return row;
  }
  if (row.kind === RECEIPT_ROW_KIND) {
    if (row.id !== `${RECEIPT_ROW_PREFIX}${envelope.message_id}` || row.disposition !== 'discarded') return null;
    if (row.turn_id !== undefined && row.turn_id !== '' && !isId(row.turn_id)) return null;
    return row;
  }
  return null;
}

// Same canonical row under the same id, ignoring timestamp and event_seq (idempotent re-insert).
function contextRowsEquivalent(existing, incoming) {
  if (!validateContextRow(existing) || !validateContextRow(incoming)) return false;
  const turn = (row) => (row.turn_id ? String(row.turn_id) : '');
  return existing.id === incoming.id && existing.kind === incoming.kind && existing.content === incoming.content
    && turn(existing) === turn(incoming) && (existing.disposition || '') === (incoming.disposition || '')
    && canonicalJson(existing.session_message) === canonicalJson(incoming.session_message);
}

module.exports = {
  ENVELOPE_KEYS, ENVELOPE_KINDS, ERROR_CODE_RE, INCLUDED_ROW_KIND, INCLUDED_ROW_PREFIX, MAX_BODY_BYTES, MAX_REPORT_BODY_BYTES,
  RECEIPT_ROW_KIND, RECEIPT_ROW_PREFIX, REPORT_OUTCOMES,
  bodySha256, buildAgentEnvelope, buildDiscardReceiptRow, buildIncludedRow, buildReportEnvelope, buildUserEnvelope,
  contextRowsEquivalent,
  envelopeSha256, isHex64, isId, isIso, isPlainObject, validateBody, validateContextRow, validateEnvelope,
};
