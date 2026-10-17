'use strict';

/* services/chat-workspace-contract.js - wire shapes for the chatWorkspace.*
 * bridge (row 59 checkpoint 2). Closed request schemas, the common
 * `{schema_version:1, ok, ...}` response envelope and the stable reason enum.
 * Pure: no I/O, no logging. Unknown keys, malformed ids and nonfinite numbers
 * fail closed; `reason` is always a stable token, never exception prose.
 */

const { CHATWS_ERROR_CODES } = require('./backend/error-codes');

const SCHEMA_VERSION = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MAX_CHANGE_PATH_CHARS = 1024;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const SECTION_STATES = Object.freeze(['checking', 'available', 'stale', 'unavailable', 'not_applicable']);

// reason -> [error code, retryable]. Anything unlisted degrades to UNAVAILABLE.
const REASON_CLASSES = Object.freeze({
  invalid_request: [CHATWS_ERROR_CODES.INVALID_REQUEST, false],
  invalid_patch: [CHATWS_ERROR_CODES.INVALID_REQUEST, false],
  not_found: [CHATWS_ERROR_CODES.NOT_FOUND, false],
  revision_conflict: [CHATWS_ERROR_CODES.REVISION_CONFLICT, true],
  io_failed: [CHATWS_ERROR_CODES.IO_FAILED, true],
  path_not_changed: [CHATWS_ERROR_CODES.PATH_REFUSED, false],
  path_outside_workspace: [CHATWS_ERROR_CODES.PATH_REFUSED, false],
  unavailable: [CHATWS_ERROR_CODES.UNAVAILABLE, false],
  git_failed: [CHATWS_ERROR_CODES.UNAVAILABLE, true],
  root_changed: [CHATWS_ERROR_CODES.UNAVAILABLE, true],
  file_unreadable: [CHATWS_ERROR_CODES.UNAVAILABLE, true],
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function stableReason(reason) {
  const token = typeof reason === 'string' ? reason : '';
  return REASON_PATTERN.test(token) ? token : 'unavailable';
}

function revisionOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Failure envelope. `retryable` follows the reason class unless the owner of
// the failure states it (an I/O failure reported by the persistence layer).
function fail(reason, { currentRevision = null, retryable = null } = {}) {
  const token = stableReason(reason);
  const [code, defaultRetryable] = REASON_CLASSES[token] || [CHATWS_ERROR_CODES.UNAVAILABLE, false];
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

function hasExactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  if (!required.every((key) => Object.hasOwn(value, key))) return false;
  const allowed = new Set([...required, ...optional]);
  return keys.every((key) => allowed.has(key));
}

function validSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

function validChangePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CHANGE_PATH_CHARS
    && !value.includes('\0');
}

// Each validator returns `{ ok: true, value }` (a fresh plain object) or
// `{ ok: false, reason: 'invalid_request' }`.
function validateSessionRequest(raw) {
  if (!isPlainObject(raw) || !hasExactKeys(raw, ['schema_version', 'session_id'])
    || raw.schema_version !== SCHEMA_VERSION || !validSessionId(raw.session_id)) {
    return { ok: false, reason: 'invalid_request' };
  }
  return { ok: true, value: { session_id: raw.session_id } };
}

function validateSetViewRequest(raw) {
  if (!isPlainObject(raw)
    || !hasExactKeys(raw, ['schema_version', 'session_id', 'expected_revision', 'patch'])
    || raw.schema_version !== SCHEMA_VERSION || !validSessionId(raw.session_id)
    || !Number.isSafeInteger(raw.expected_revision) || raw.expected_revision < 0
    || !isPlainObject(raw.patch)) {
    return { ok: false, reason: 'invalid_request' };
  }
  return {
    ok: true,
    value: { session_id: raw.session_id, expected_revision: raw.expected_revision, patch: raw.patch },
  };
}

function validateChangeDiffRequest(raw) {
  if (!isPlainObject(raw) || !hasExactKeys(raw, ['schema_version', 'session_id', 'path'])
    || raw.schema_version !== SCHEMA_VERSION || !validSessionId(raw.session_id)
    || !validChangePath(raw.path)) {
    return { ok: false, reason: 'invalid_request' };
  }
  return { ok: true, value: { session_id: raw.session_id, path: raw.path } };
}

// Section wrapper: `{state, sampled_at, reason, data}`. Checking/unavailable/
// not_applicable carry null data; a nonnull `reason` explains a non-available
// state or a degraded available one.
function section(state, { sampledAt = null, reason = null, data = null } = {}) {
  if (!SECTION_STATES.includes(state)) throw new TypeError(`Unknown section state: ${state}`);
  const keepData = state === 'available' || state === 'stale';
  return {
    state,
    sampled_at: sampledAt,
    reason: reason == null ? null : stableReason(reason),
    data: keepData ? data : null,
  };
}

// Nonnegative safe integer or null: unknown is never zero.
function countOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

module.exports = {
  MAX_CHANGE_PATH_CHARS,
  SCHEMA_VERSION,
  SECTION_STATES,
  countOrNull,
  fail,
  isPlainObject,
  section,
  stableReason,
  succeed,
  validateChangeDiffRequest,
  validateSessionRequest,
  validateSetViewRequest,
  validSessionId,
};
