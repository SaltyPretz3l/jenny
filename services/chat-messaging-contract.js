'use strict';

/* services/chat-messaging-contract.js - wire shapes for the chatMessages.*
 * bridge (row 59 checkpoint 4). Closed request schemas, the common
 * `{schema_version:1, ok, ...}` response envelope, the stable reason enum and the
 * opaque list cursor. Pure: no I/O, no logging. Unknown keys, malformed ids and
 * nonfinite numbers fail closed; `reason` is always a stable token, never exception
 * prose, and no envelope ever carries paths. Message bodies appear only in the
 * projections the owning chat's user is entitled to read.
 */

const { MESSAGE_ERROR_CODES: CODES } = require('./backend/error-codes');
const { isUuid } = require('./backend/chat-proposal-records');
const { validateBody } = require('./backend/session-message-envelope');
const { validPurpose } = require('./backend/session-mail-records');

const SCHEMA_VERSION = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;
const QUERY_MAX_BYTES = 200;
const RECIPIENT_DEFAULT_LIMIT = 50;
const RECIPIENT_MAX_LIMIT = 50;
const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;
const MAX_MESSAGE_IDS = 100;
const DIRECTIONS = Object.freeze(['inbox', 'outbox']);
const DISPOSITIONS = Object.freeze(['queued', 'excluded_by_user']);
// No method answers `unsupported` any more (confirmRestored shipped in checkpoint 5b-3).
const UNSUPPORTED_METHODS = Object.freeze([]);
const HEX64_PATTERN = /^[0-9a-f]{64}$/u;
// A grant purpose is one line of human text: no C0 control characters or DEL.
const hasControlChar = (text) => [...text].some((char) => char.codePointAt(0) < 0x20 || char.codePointAt(0) === 0x7f);

// reason -> [error code, retryable]. Anything unlisted degrades to UNAVAILABLE.
const REASON_CLASSES = Object.freeze({
  invalid_request: [CODES.INVALID_REQUEST, false],
  not_found: [CODES.INVALID_REQUEST, false],
  self_send: [CODES.INVALID_REQUEST, false],
  source_ineligible: [CODES.INVALID_REQUEST, false],
  recipient_ineligible: [CODES.INVALID_REQUEST, false],
  unavailable: [CODES.UNAVAILABLE, false],
  unsupported: [CODES.UNAVAILABLE, false],
  authorization_required: [CODES.AUTHORIZATION_REQUIRED, false],
  authorization_revoked: [CODES.AUTHORIZATION_REVOKED, false],
  idempotency_conflict: [CODES.IDEMPOTENCY_CONFLICT, false],
  recipient_archived: [CODES.RECIPIENT_ARCHIVED, true],
  recipient_deleted: [CODES.RECIPIENT_DELETED, false],
  sender_backpressure: [CODES.SENDER_BACKPRESSURE, false],
  capacity: [CODES.SENDER_BACKPRESSURE, false],
  turn_send_limit: [CODES.SENDER_BACKPRESSURE, false],
  recipient_backpressure: [CODES.RECIPIENT_BACKPRESSURE, true],
  context_budget: [CODES.CONTEXT_BUDGET, true],
  persistence_failure: [CODES.PERSISTENCE_FAILURE, true],
  io_failed: [CODES.PERSISTENCE_FAILURE, true],
  stale_operation: [CODES.STALE_OPERATION, false],
  busy: [CODES.STALE_OPERATION, true],
  stale_cursor: [CODES.STALE_OPERATION, true],
  expired: [CODES.STALE_OPERATION, false],
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function stableReason(reason) {
  const token = typeof reason === 'string' ? reason : '';
  return REASON_PATTERN.test(token) ? token : 'unavailable';
}

const revisionOrNull = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

function classify(reason) {
  const token = stableReason(reason);
  const [code, retryable] = REASON_CLASSES[token] || [CODES.UNAVAILABLE, false];
  return { reason: token, code, retryable };
}

// Failure envelope. `retryable` follows the reason class unless the owner of
// the failure states it (an I/O failure reported by the persistence layer).
function fail(reason, { currentRevision = null, retryable = null } = {}) {
  const { reason: token, code, retryable: defaultRetryable } = classify(reason);
  return {
    schema_version: SCHEMA_VERSION,
    ok: false,
    error_code: code,
    reason: token,
    retryable: typeof retryable === 'boolean' ? retryable : defaultRetryable,
    current_revision: revisionOrNull(currentRevision),
  };
}

function succeed(payload) {
  return { schema_version: SCHEMA_VERSION, ok: true, ...payload };
}

// `last_error` as persisted on an outbox record: {code, reason, retryable}.
function lastError(reason, { retryable = null } = {}) {
  const { reason: token, code, retryable: defaultRetryable } = classify(reason);
  return { code, reason: token, retryable: typeof retryable === 'boolean' ? retryable : defaultRetryable };
}

function hasExactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  if (!required.every((key) => Object.hasOwn(value, key))) return false;
  const allowed = new Set([...required, ...optional]);
  return keys.every((key) => allowed.has(key));
}

const validSessionId = (value) => typeof value === 'string' && SESSION_ID_PATTERN.test(value);
const validUuid = (value) => isUuid(value);
const INVALID = Object.freeze({ ok: false, reason: 'invalid_request' });
const ok = (value) => ({ ok: true, value });

function validCursor(raw) {
  return typeof raw === 'string' && CURSOR_PATTERN.test(raw);
}

function validLimit(raw, max) {
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= max;
}

function validQuery(raw) {
  return typeof raw === 'string' && (typeof raw.isWellFormed !== 'function' || raw.isWellFormed())
    && Buffer.byteLength(raw, 'utf8') <= QUERY_MAX_BYTES;
}

function validateListRecipientsRequest(raw) {
  if (!isPlainObject(raw) || raw.schema_version !== SCHEMA_VERSION
    || !hasExactKeys(raw, ['schema_version', 'source_session_id'], ['query', 'cursor', 'limit'])
    || !validSessionId(raw.source_session_id)) return INVALID;
  if (Object.hasOwn(raw, 'query') && !validQuery(raw.query)) return INVALID;
  if (Object.hasOwn(raw, 'cursor') && !validCursor(raw.cursor)) return INVALID;
  if (Object.hasOwn(raw, 'limit') && !validLimit(raw.limit, RECIPIENT_MAX_LIMIT)) return INVALID;
  return ok({
    source_session_id: raw.source_session_id,
    query: Object.hasOwn(raw, 'query') ? raw.query.trim() : '',
    cursor: Object.hasOwn(raw, 'cursor') ? raw.cursor : null,
    limit: Object.hasOwn(raw, 'limit') ? raw.limit : RECIPIENT_DEFAULT_LIMIT,
  });
}

function validatePrepareRequest(raw) {
  if (!isPlainObject(raw) || raw.schema_version !== SCHEMA_VERSION
    || !hasExactKeys(raw, ['schema_version', 'source_session_id', 'destination_session_id', 'body', 'gesture_id'])
    || !validSessionId(raw.source_session_id) || !validSessionId(raw.destination_session_id)
    || !validUuid(raw.gesture_id) || !validateBody(raw.body).ok) return INVALID;
  return ok({
    source_session_id: raw.source_session_id,
    destination_session_id: raw.destination_session_id,
    body: raw.body,
    gesture_id: raw.gesture_id,
  });
}

// send, retry and cancel share one shape.
function validateOperationRequest(raw) {
  if (!isPlainObject(raw) || raw.schema_version !== SCHEMA_VERSION
    || !hasExactKeys(raw, ['schema_version', 'operation_id']) || !validUuid(raw.operation_id)) return INVALID;
  return ok({ operation_id: raw.operation_id });
}

function validateListRequest(raw) {
  if (!isPlainObject(raw) || raw.schema_version !== SCHEMA_VERSION
    || !hasExactKeys(raw, ['schema_version', 'session_id', 'direction'], ['cursor', 'limit'])
    || !validSessionId(raw.session_id) || !DIRECTIONS.includes(raw.direction)) return INVALID;
  if (Object.hasOwn(raw, 'cursor') && !validCursor(raw.cursor)) return INVALID;
  if (Object.hasOwn(raw, 'limit') && !validLimit(raw.limit, LIST_MAX_LIMIT)) return INVALID;
  return ok({
    session_id: raw.session_id,
    direction: raw.direction,
    cursor: Object.hasOwn(raw, 'cursor') ? raw.cursor : null,
    limit: Object.hasOwn(raw, 'limit') ? raw.limit : LIST_DEFAULT_LIMIT,
  });
}

function validMessageIds(raw) {
  return Array.isArray(raw) && raw.length >= 1 && raw.length <= MAX_MESSAGE_IDS && raw.every(validUuid)
    && new Set(raw).size === raw.length;
}

// markRead, discard (and setContextDisposition with `disposition`).
function validateMessageIdsRequest(raw, { disposition = false } = {}) {
  const required = ['schema_version', 'session_id', 'message_ids', ...(disposition ? ['disposition'] : [])];
  if (!isPlainObject(raw) || raw.schema_version !== SCHEMA_VERSION || !hasExactKeys(raw, required)
    || !validSessionId(raw.session_id) || !validMessageIds(raw.message_ids)
    || (disposition && !DISPOSITIONS.includes(raw.disposition))) return INVALID;
  return ok({
    session_id: raw.session_id,
    message_ids: [...raw.message_ids],
    disposition: disposition ? raw.disposition : null,
  });
}

// setReporting: flips a linked child's `reporting_enabled`.
function validateSetReportingRequest(raw) {
  if (!isPlainObject(raw) || raw.schema_version !== SCHEMA_VERSION
    || !hasExactKeys(raw, ['schema_version', 'child_session_id', 'enabled'])
    || !validSessionId(raw.child_session_id) || typeof raw.enabled !== 'boolean') return INVALID;
  return ok({ child_session_id: raw.child_session_id, enabled: raw.enabled });
}

// createGrant: the trimmed purpose (1-512 UTF-8 bytes, one line) is what is stored.
function validateCreateGrantRequest(raw) {
  if (!isPlainObject(raw) || raw.schema_version !== SCHEMA_VERSION
    || !hasExactKeys(raw, ['schema_version', 'source_session_id', 'destination_session_id', 'purpose', 'gesture_id'])
    || !validSessionId(raw.source_session_id) || !validSessionId(raw.destination_session_id)
    || !validUuid(raw.gesture_id) || typeof raw.purpose !== 'string') return INVALID;
  const purpose = raw.purpose.trim();
  if (!validPurpose(purpose) || hasControlChar(purpose)) return INVALID;
  return ok({
    source_session_id: raw.source_session_id,
    destination_session_id: raw.destination_session_id,
    purpose,
    gesture_id: raw.gesture_id,
  });
}

function validateRevokeGrantRequest(raw) {
  if (!isPlainObject(raw) || raw.schema_version !== SCHEMA_VERSION
    || !hasExactKeys(raw, ['schema_version', 'source_session_id', 'grant_id'])
    || !validSessionId(raw.source_session_id) || !validUuid(raw.grant_id)) return INVALID;
  return ok({ source_session_id: raw.source_session_id, grant_id: raw.grant_id });
}

// confirmRestored: the immutable operation id, the full-envelope hash the user previewed and a fresh gesture id.
function validateConfirmRestoredRequest(raw) {
  if (!isPlainObject(raw) || raw.schema_version !== SCHEMA_VERSION
    || !hasExactKeys(raw, ['schema_version', 'operation_id', 'expected_envelope_sha256', 'gesture_id'])
    || !validUuid(raw.operation_id) || !validUuid(raw.gesture_id)
    || typeof raw.expected_envelope_sha256 !== 'string' || !HEX64_PATTERN.test(raw.expected_envelope_sha256)) return INVALID;
  return ok({
    operation_id: raw.operation_id,
    expected_envelope_sha256: raw.expected_envelope_sha256,
    gesture_id: raw.gesture_id,
  });
}

// Opaque list cursor: binds the scope (a session + direction, or a recipient
// search) and carries the last item's sort key. `r` is the coordination
// revision for mail lists and null for the recipient search (whose order moves
// with every message and is paged by key alone).
function encodeCursor({ scope, revision = null, key }) {
  return Buffer.from(JSON.stringify({ v: 1, s: scope, r: revision, k: key }), 'utf8').toString('base64url');
}

function decodeCursor(cursor, { scope, revision = null }) {
  let body;
  try {
    body = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_request' };
  }
  if (!isPlainObject(body) || body.v !== 1 || typeof body.s !== 'string' || !Array.isArray(body.k)
    || !(body.r === null || Number.isSafeInteger(body.r))) {
    return { ok: false, reason: 'invalid_request' };
  }
  if (body.s !== scope || body.r !== revision) return { ok: false, reason: 'stale_cursor' };
  return { ok: true, key: body.k };
}

// Bounded UTF-8 text for projected titles / project names (untrusted, never trusted for layout).
function boundText(value, maxBytes = 512) {
  const text = typeof value === 'string' ? value : '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char, 'utf8');
    if (bytes > maxBytes) break;
    out += char;
  }
  return out;
}

module.exports = {
  DISPOSITIONS,
  LIST_DEFAULT_LIMIT,
  MAX_MESSAGE_IDS,
  REASON_CLASSES,
  RECIPIENT_DEFAULT_LIMIT,
  SCHEMA_VERSION,
  UNSUPPORTED_METHODS,
  boundText,
  classify,
  decodeCursor,
  encodeCursor,
  fail,
  isPlainObject,
  lastError,
  stableReason,
  succeed,
  validSessionId,
  validUuid,
  validateConfirmRestoredRequest,
  validateCreateGrantRequest,
  validateListRecipientsRequest,
  validateListRequest,
  validateMessageIdsRequest,
  validateOperationRequest,
  validatePrepareRequest,
  validateRevokeGrantRequest,
  validateSetReportingRequest,
};
