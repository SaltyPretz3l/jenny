'use strict';

/* services/chat-proposal-contract.js - wire shapes for the sessionProposals.*
 * bridge (row 59 checkpoint 3). Closed request schemas, the common
 * `{schema_version:1, ok, ...}` response envelope, the stable reason enum and
 * the opaque list cursor. Pure: no I/O, no logging. Unknown keys, malformed ids
 * and nonfinite numbers fail closed; `reason` is always a stable token, never
 * exception prose, and no envelope ever carries command text, summaries or paths.
 */

const { PROPOSAL_ERROR_CODES: CODES } = require('./backend/error-codes');

const SCHEMA_VERSION = 1;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const PROPOSAL_ID_PATTERN = /^proposal_[0-9a-f]{64}$/u;
// Lowercase only, the same shape the record validator and the sidecar accept.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_PRECONDITIONS = 5;
const CHOICES = Object.freeze(['commit', 'test_first', 'dismiss', 'run', 'do_it_here', 'new_session']);
// Which non-dismiss choices each proposal kind accepts.
const KIND_CHOICES = Object.freeze({
  git: Object.freeze(['commit', 'test_first']),
  command: Object.freeze(['run']),
  session: Object.freeze(['do_it_here', 'new_session']),
});
// No method answers unsupported_capability wholesale any more (confirmRestored shipped in checkpoint 5b-3).
const UNSUPPORTED_METHODS = Object.freeze([]);

// reason -> [error code, retryable]. Anything unlisted degrades to UNAVAILABLE.
const REASON_CLASSES = Object.freeze({
  invalid_request: [CODES.INVALID_REQUEST, false],
  unavailable: [CODES.UNAVAILABLE, false],
  not_found: [CODES.UNAVAILABLE, false],
  runtime_unavailable: [CODES.UNAVAILABLE, true],
  submission_pending: [CODES.UNAVAILABLE, true],
  io_failed: [CODES.UNAVAILABLE, true],
  plan_mode: [CODES.UNAVAILABLE, false],
  read_only: [CODES.UNAVAILABLE, false],
  lockdown: [CODES.UNAVAILABLE, false],
  stale_revision: [CODES.STALE_REVISION, true],
  stale_cursor: [CODES.STALE_REVISION, true],
  not_pending: [CODES.STALE_REVISION, true],
  idempotency_conflict: [CODES.IDEMPOTENCY_CONFLICT, false],
  expired: [CODES.EXPIRED, false],
  capacity: [CODES.CAPACITY, false],
  authority_changed: [CODES.AUTHORITY_CHANGED, false],
  authorization_required: [CODES.AUTHORIZATION_REQUIRED, false],
  unsupported_capability: [CODES.UNSUPPORTED_CAPABILITY, false],
  preparation_failed: [CODES.PREPARATION_FAILED, true],
  dispatch_failed: [CODES.DISPATCH_FAILED, true],
  outcome_unknown: [CODES.OUTCOME_UNKNOWN, false],
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

function classify(reason) {
  const token = stableReason(reason);
  const [code, retryable] = REASON_CLASSES[token] || [CODES.UNAVAILABLE, false];
  return { reason: token, code, retryable };
}

// Failure envelope. `retryable` follows the reason class unless the owner of
// the failure states it (an I/O failure reported by the persistence layer).
// `detail` is an optional stable token refining the reason (e.g. fresh_command_proposal_required).
function fail(reason, { currentRevision = null, retryable = null, detail = null } = {}) {
  const { reason: token, code, retryable: defaultRetryable } = classify(reason);
  return {
    schema_version: SCHEMA_VERSION,
    ok: false,
    error_code: code,
    reason: token,
    retryable: typeof retryable === 'boolean' ? retryable : defaultRetryable,
    current_revision: revisionOrNull(currentRevision),
    ...(typeof detail === 'string' && REASON_PATTERN.test(detail) ? { detail } : {}),
  };
}

function succeed(payload) {
  return { schema_version: SCHEMA_VERSION, ok: true, ...payload };
}

// `last_error` as persisted on a record: {code, reason, retryable, cause_code}.
function lastError(reason, { retryable = null, causeCode = null } = {}) {
  const { reason: token, code, retryable: defaultRetryable } = classify(reason);
  return {
    code,
    reason: token,
    retryable: typeof retryable === 'boolean' ? retryable : defaultRetryable,
    cause_code: typeof causeCode === 'string' && REASON_PATTERN.test(causeCode) ? causeCode : null,
  };
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

function validProposalId(value) {
  return typeof value === 'string' && PROPOSAL_ID_PATTERN.test(value);
}

function validDecisionId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

const INVALID = Object.freeze({ ok: false, reason: 'invalid_request' });

function envelopeOk(raw, required, optional = []) {
  return isPlainObject(raw) && hasExactKeys(raw, ['schema_version', 'session_id', ...required], optional)
    && raw.schema_version === SCHEMA_VERSION && validSessionId(raw.session_id);
}

function validateGetRequest(raw) {
  if (!envelopeOk(raw, ['proposal_id']) || !validProposalId(raw.proposal_id)) return INVALID;
  return { ok: true, value: { session_id: raw.session_id, proposal_id: raw.proposal_id } };
}

function validateListRequest(raw) {
  if (!envelopeOk(raw, [], ['cursor', 'limit'])) return INVALID;
  if (Object.hasOwn(raw, 'cursor') && !(typeof raw.cursor === 'string' && CURSOR_PATTERN.test(raw.cursor))) return INVALID;
  if (Object.hasOwn(raw, 'limit') && !(Number.isSafeInteger(raw.limit) && raw.limit >= 1 && raw.limit <= MAX_LIMIT)) return INVALID;
  return {
    ok: true,
    value: {
      session_id: raw.session_id,
      cursor: Object.hasOwn(raw, 'cursor') ? raw.cursor : null,
      limit: Object.hasOwn(raw, 'limit') ? raw.limit : DEFAULT_LIMIT,
    },
  };
}

function validPreconditions(value) {
  return Array.isArray(value) && value.length <= MAX_PRECONDITIONS
    && value.every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry < MAX_PRECONDITIONS)
    && new Set(value).size === value.length;
}

// dismiss fits every kind; any other choice must belong to the record's own kind.
function choiceFitsKind(kind, choice) {
  return choice === 'dismiss' || (KIND_CHOICES[kind] || []).includes(choice);
}

function validateDecideRequest(raw) {
  if (!envelopeOk(raw, ['proposal_id', 'expected_revision', 'decision_id', 'choice'], ['confirmed_preconditions'])
    || !validProposalId(raw.proposal_id) || !validRevision(raw.expected_revision)
    || !validDecisionId(raw.decision_id) || !CHOICES.includes(raw.choice)
    || (Object.hasOwn(raw, 'confirmed_preconditions') && !validPreconditions(raw.confirmed_preconditions))) {
    return INVALID;
  }
  return {
    ok: true,
    value: {
      session_id: raw.session_id,
      proposal_id: raw.proposal_id,
      expected_revision: raw.expected_revision,
      decision_id: raw.decision_id,
      choice: raw.choice,
      confirmed_preconditions: Object.hasOwn(raw, 'confirmed_preconditions')
        ? [...raw.confirmed_preconditions] : null,
    },
  };
}

// cancel and retry share one shape.
function validateGestureRequest(raw) {
  if (!envelopeOk(raw, ['proposal_id', 'expected_revision', 'decision_id'])
    || !validProposalId(raw.proposal_id) || !validRevision(raw.expected_revision)
    || !validDecisionId(raw.decision_id)) {
    return INVALID;
  }
  return {
    ok: true,
    value: {
      session_id: raw.session_id,
      proposal_id: raw.proposal_id,
      expected_revision: raw.expected_revision,
      decision_id: raw.decision_id,
    },
  };
}

// confirmRestored (checkpoint 5b-3): the displayed revision and a fresh gesture id, exactly the cancel / retry shape.
const validateConfirmRestoredRequest = validateGestureRequest;

// Opaque list cursor: binds the session and the coordination revision it was
// issued at, plus the last item's (created_at, proposal_id) sort key.
function encodeCursor({ sessionId, revision, createdAt, proposalId }) {
  const body = JSON.stringify({ v: 1, s: sessionId, r: revision, c: createdAt, p: proposalId });
  return Buffer.from(body, 'utf8').toString('base64url');
}

function decodeCursor(cursor, { sessionId, revision }) {
  let body;
  try {
    body = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_request' };
  }
  if (!isPlainObject(body) || body.v !== 1 || typeof body.s !== 'string' || typeof body.c !== 'string'
    || !validProposalId(body.p) || !Number.isSafeInteger(body.r)) {
    return { ok: false, reason: 'invalid_request' };
  }
  if (body.s !== sessionId || body.r !== revision) return { ok: false, reason: 'stale_cursor' };
  return { ok: true, createdAt: body.c, proposalId: body.p };
}

module.exports = {
  CHOICES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SCHEMA_VERSION,
  UNSUPPORTED_METHODS,
  choiceFitsKind,
  classify,
  decodeCursor,
  encodeCursor,
  envelopeOk,
  fail,
  hasExactKeys,
  isPlainObject,
  lastError,
  stableReason,
  succeed,
  validDecisionId,
  validProposalId,
  validRevision,
  validSessionId,
  validateConfirmRestoredRequest,
  validateDecideRequest,
  validateGestureRequest,
  validateGetRequest,
  validateListRequest,
  INVALID,
};
