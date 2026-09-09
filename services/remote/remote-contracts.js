'use strict';

const {
  FRAME_HEADER_BUDGET_BYTES,
  FRAME_MAX_BYTES,
  PROMPT_MAX_BYTES,
  TRANSCRIPT_PAGE_MAX_MESSAGES,
} = require('./remote-limits');

const PROTOCOL_VERSION = 1;
// The whole serialized frame must fit FRAME_MAX_BYTES; the header budget is
// what remains for the JSON envelope around the base64url ciphertext.
const FRAME_CIPHERTEXT_MAX_CHARS = FRAME_MAX_BYTES - FRAME_HEADER_BUDGET_BYTES;
// Backend ceilings the decision adapters forward into: ask_user answers/ids
// (services/tools/builtin/ask-user-tool.js LIMITS) and plan feedback
// (backend-chat-stream.js keeps 800 chars). Reject longer text up front so a
// phone never sees an acknowledgement for text the backend would truncate.
const ANSWER_ID_MAX_CHARS = 64;
const ANSWER_VALUE_MAX_CHARS = 500;
const ANSWER_VALUES_MAX = 32;
const PLAN_FEEDBACK_MAX_CHARS = 800;
const PLAN_FEEDBACK_MAX_BYTES = 2048;
const IDENTIFIER_RE = /^[A-Za-z0-9_-]{8,64}$/;

const OPERATIONS = Object.freeze([
  'session.list',
  'session.create',
  'session.share_ack',
  'transcript.page',
  'chat.send',
  'chat.stop',
  'decision.tool',
  'decision.question',
  'decision.plan',
  'control.request',
  'control.release',
  'heartbeat',
  'resync',
]);

const EVENT_TYPES = Object.freeze([
  'started',
  'delta',
  'tool_use',
  'tool_result',
  'tool_approval_needed',
  'user_questions_requested',
  'plan_proposed',
  'status',
  'reset',
  'complete',
  'error',
  'session_shared',
  'session_unshared',
  'control_changed',
]);

const ERROR_CODES = Object.freeze({
  unauthorized: 'CMP-REMOTE-0001',
  not_reachable: 'CMP-REMOTE-0002',
  session_not_shared: 'CMP-REMOTE-0003',
  stale_approval: 'CMP-REMOTE-0004',
  session_busy: 'CMP-REMOTE-0005',
  rate_limited: 'CMP-REMOTE-0006',
  payload_too_large: 'CMP-REMOTE-0007',
  lockdown: 'CMP-REMOTE-0008',
  desktop_only: 'CMP-REMOTE-0009',
  resync_required: 'CMP-REMOTE-0010',
  invalid_request: 'CMP-REMOTE-0011',
  epoch_invalid: 'CMP-REMOTE-0012',
});

const OPERATION_SET = new Set(OPERATIONS);
const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const SESSION_OPTIONAL_OPERATIONS = new Set([
  'session.list', 'session.create', 'heartbeat', 'resync',
]);
const EMPTY_PAYLOAD_OPERATIONS = new Set([
  'session.list', 'session.create', 'session.share_ack', 'chat.stop',
  'control.request', 'control.release', 'heartbeat',
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object'
    || Object.prototype.toString.call(value) !== '[object Object]') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || (Object.getPrototypeOf(prototype) === null
    && typeof prototype.constructor === 'function'
    && prototype.constructor.name === 'Object');
}

function success(value) {
  return { ok: true, value };
}

function failure(reason, path) {
  return { ok: false, reason, path };
}

function unknownKey(value, allowedKeys, basePath) {
  const allowed = new Set(allowedKeys);
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate));
  return key === undefined ? null : failure('invalid_request', `${basePath}.${key}`);
}

function validateString(value, path, { max = Infinity, allowEmpty = false, bytes = false } = {}) {
  if (typeof value !== 'string') return failure('field_not_string', path);
  const size = bytes ? Buffer.byteLength(value, 'utf8') : value.length;
  if ((!allowEmpty && size === 0) || size > max) return failure('field_out_of_bounds', path);
  return null;
}

// Canonical unpadded base64url only: non-empty, and the decode/re-encode round
// trip must reproduce the input exactly (rejects padding, stray bits, and
// non-alphabet characters).
function isCanonicalBase64Url(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 === 1) return false;
  return Buffer.from(value, 'base64url').toString('base64url') === value;
}

function validateIdentifier(value, path) {
  if (typeof value !== 'string') return failure('field_not_string', path);
  if (!IDENTIFIER_RE.test(value)) return failure('identifier_invalid', path);
  return null;
}

function validateNonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    return failure('field_not_nonnegative_integer', path);
  }
  return null;
}

function normalizeSessionId(value) {
  if (typeof value !== 'string') throw new TypeError('session id must be a string');
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    throw new RangeError('session id must contain 1 to 128 characters');
  }
  return normalized;
}

function toWireSessionId(value) {
  return normalizeSessionId(value);
}

function fromWireSessionId(value) {
  return normalizeSessionId(value);
}

function validateFrameHeader(obj) {
  if (!isPlainObject(obj)) return failure('frame_not_object', '$');
  const extra = unknownKey(
    obj,
    ['v', 'route_id', 'connection_id', 'epoch', 'seq', 'ciphertext'],
    '$'
  );
  if (extra) return extra;
  if (obj.v !== PROTOCOL_VERSION) return failure('unsupported_version', '$.v');
  for (const field of ['route_id', 'connection_id', 'epoch']) {
    const invalid = validateIdentifier(obj[field], `$.${field}`);
    if (invalid) return invalid;
  }
  const invalidSeq = validateNonNegativeInteger(obj.seq, '$.seq');
  if (invalidSeq) return invalidSeq;
  if (typeof obj.ciphertext !== 'string') return failure('field_not_string', '$.ciphertext');
  if (obj.ciphertext.length > FRAME_CIPHERTEXT_MAX_CHARS) {
    return failure('payload_too_large', '$.ciphertext');
  }
  if (!isCanonicalBase64Url(obj.ciphertext)) {
    return failure('base64url_invalid', '$.ciphertext');
  }
  return success({
    v: obj.v,
    route_id: obj.route_id,
    connection_id: obj.connection_id,
    epoch: obj.epoch,
    seq: obj.seq,
    ciphertext: obj.ciphertext,
  });
}

function validateEmptyPayload(payload, basePath) {
  const extra = unknownKey(payload, [], basePath);
  return extra || success({});
}

function validateTranscriptPayload(payload, basePath) {
  const extra = unknownKey(payload, ['before', 'limit'], basePath);
  if (extra) return extra;
  if (Object.hasOwn(payload, 'before')) {
    const invalidBefore = validateString(payload.before, `${basePath}.before`, { max: 128 });
    if (invalidBefore) return invalidBefore;
  }
  if (Object.hasOwn(payload, 'limit')
    && (!Number.isSafeInteger(payload.limit)
      || payload.limit < 1
      || payload.limit > TRANSCRIPT_PAGE_MAX_MESSAGES)) {
    return failure('field_out_of_bounds', `${basePath}.limit`);
  }
  return success({ ...payload });
}

function validateChatSendPayload(payload, basePath) {
  const extra = unknownKey(payload, ['prompt'], basePath);
  if (extra) return extra;
  const invalidPrompt = validateString(payload.prompt, `${basePath}.prompt`, {
    max: PROMPT_MAX_BYTES,
    bytes: true,
  });
  return invalidPrompt || success({ prompt: payload.prompt });
}

function validateDecisionIdentity(payload, basePath, allowedKeys) {
  const extra = unknownKey(payload, allowedKeys, basePath);
  if (extra) return extra;
  for (const field of ['stream_id', 'approval_id']) {
    const invalid = validateString(payload[field], `${basePath}.${field}`, { max: 256 });
    if (invalid) return invalid;
  }
  return validateNonNegativeInteger(payload.decision_revision, `${basePath}.decision_revision`);
}

function validateToolDecision(payload, basePath) {
  const invalidIdentity = validateDecisionIdentity(
    payload,
    basePath,
    ['stream_id', 'approval_id', 'decision_revision', 'decision']
  );
  if (invalidIdentity) return invalidIdentity;
  if (!['approve_once', 'deny'].includes(payload.decision)) {
    return failure('field_invalid', `${basePath}.decision`);
  }
  return success({ ...payload });
}

function validateAnswerValue(value, path) {
  if (Array.isArray(value)) {
    if (value.length > ANSWER_VALUES_MAX) return failure('field_out_of_bounds', path);
    for (let index = 0; index < value.length; index += 1) {
      const invalid = validateString(value[index], `${path}[${index}]`, {
        max: ANSWER_VALUE_MAX_CHARS,
      });
      if (invalid) return invalid;
    }
    return null;
  }
  return validateString(value, path, { max: ANSWER_VALUE_MAX_CHARS, allowEmpty: true });
}

// `answer` carries the phone's answers for the live batch; `decline` maps to
// the backend's explicit `{ declined: true }` outcome and carries no answers.
function validateQuestionDecision(payload, basePath) {
  const extra = unknownKey(payload, ['question_ref', 'batch_id', 'decision', 'answers'], basePath);
  if (extra) return extra;
  for (const field of ['question_ref', 'batch_id']) {
    const invalid = validateString(payload[field], `${basePath}.${field}`, { max: 4096 });
    if (invalid) return invalid;
  }
  if (!['answer', 'decline'].includes(payload.decision)) {
    return failure('field_invalid', `${basePath}.decision`);
  }
  if (payload.decision === 'decline') {
    if (Object.hasOwn(payload, 'answers')) return failure('invalid_request', `${basePath}.answers`);
    return success({
      question_ref: payload.question_ref, batch_id: payload.batch_id, decision: 'decline',
    });
  }
  if (!Array.isArray(payload.answers)) return failure('field_not_array', `${basePath}.answers`);
  if (payload.answers.length > 32) return failure('field_out_of_bounds', `${basePath}.answers`);

  const answers = [];
  for (let index = 0; index < payload.answers.length; index += 1) {
    const answer = payload.answers[index];
    const answerPath = `${basePath}.answers[${index}]`;
    if (!isPlainObject(answer)) return failure('field_not_object', answerPath);
    const answerExtra = unknownKey(answer, ['id', 'value', 'other'], answerPath);
    if (answerExtra) return answerExtra;
    const invalidId = validateString(answer.id, `${answerPath}.id`, { max: ANSWER_ID_MAX_CHARS });
    if (invalidId) return invalidId;
    const normalized = { id: answer.id };
    if (Object.hasOwn(answer, 'value')) {
      const invalidValue = validateAnswerValue(answer.value, `${answerPath}.value`);
      if (invalidValue) return invalidValue;
      normalized.value = Array.isArray(answer.value) ? answer.value.slice() : answer.value;
    }
    if (Object.hasOwn(answer, 'other')) {
      const invalidOther = validateString(answer.other, `${answerPath}.other`, {
        max: ANSWER_VALUE_MAX_CHARS,
        allowEmpty: true,
      });
      if (invalidOther) return invalidOther;
      normalized.other = answer.other;
    }
    answers.push(normalized);
  }
  return success({
    question_ref: payload.question_ref, batch_id: payload.batch_id, decision: 'answer', answers,
  });
}

function validatePlanDecision(payload, basePath) {
  const invalidIdentity = validateDecisionIdentity(
    payload,
    basePath,
    ['stream_id', 'approval_id', 'decision_revision', 'decision', 'feedback']
  );
  if (invalidIdentity) return invalidIdentity;
  if (!['approve', 'revise'].includes(payload.decision)) {
    return failure('field_invalid', `${basePath}.decision`);
  }
  if (payload.decision === 'revise' && !Object.hasOwn(payload, 'feedback')) {
    return failure('field_required', `${basePath}.feedback`);
  }
  if (Object.hasOwn(payload, 'feedback')) {
    const invalidFeedback = validateString(payload.feedback, `${basePath}.feedback`, {
      max: PLAN_FEEDBACK_MAX_CHARS,
      allowEmpty: payload.decision !== 'revise',
    }) || validateString(payload.feedback, `${basePath}.feedback`, {
      max: PLAN_FEEDBACK_MAX_BYTES,
      bytes: true,
      allowEmpty: payload.decision !== 'revise',
    });
    if (invalidFeedback) return invalidFeedback;
  }
  return success({ ...payload });
}

function validateResyncPayload(payload, basePath) {
  const extra = unknownKey(payload, ['last_event_seq'], basePath);
  if (extra) return extra;
  const invalid = validateNonNegativeInteger(payload.last_event_seq, `${basePath}.last_event_seq`);
  return invalid || success({ last_event_seq: payload.last_event_seq });
}

function validatePayloadForOperation(operation, payload, basePath = '$.payload') {
  if (!isPlainObject(payload)) return failure('field_not_object', basePath);
  if (EMPTY_PAYLOAD_OPERATIONS.has(operation)) return validateEmptyPayload(payload, basePath);
  if (operation === 'transcript.page') return validateTranscriptPayload(payload, basePath);
  if (operation === 'chat.send') return validateChatSendPayload(payload, basePath);
  if (operation === 'decision.tool') return validateToolDecision(payload, basePath);
  if (operation === 'decision.question') return validateQuestionDecision(payload, basePath);
  if (operation === 'decision.plan') return validatePlanDecision(payload, basePath);
  if (operation === 'resync') return validateResyncPayload(payload, basePath);
  return failure('invalid_request', '$.operation');
}

function validateDecisionPayload(kind, payload) {
  if (!['tool', 'question', 'plan'].includes(kind)) return failure('invalid_request', '$.kind');
  return validatePayloadForOperation(`decision.${kind}`, payload, '$');
}

function validateCommand(obj) {
  if (!isPlainObject(obj)) return failure('command_not_object', '$');
  const extra = unknownKey(
    obj,
    ['v', 'kind', 'request_id', 'operation', 'session_id', 'control_lease', 'payload'],
    '$'
  );
  if (extra) return extra;
  if (obj.v !== PROTOCOL_VERSION) return failure('unsupported_version', '$.v');
  if (obj.kind !== 'command') return failure('field_invalid', '$.kind');
  const invalidRequestId = validateIdentifier(obj.request_id, '$.request_id');
  if (invalidRequestId) return invalidRequestId;
  if (!OPERATION_SET.has(obj.operation)) return failure('field_invalid', '$.operation');

  let sessionId;
  if (Object.hasOwn(obj, 'session_id')) {
    if (typeof obj.session_id !== 'string') return failure('field_not_string', '$.session_id');
    try {
      sessionId = fromWireSessionId(obj.session_id);
    } catch (_error) {
      return failure('field_out_of_bounds', '$.session_id');
    }
  } else if (!SESSION_OPTIONAL_OPERATIONS.has(obj.operation)) {
    return failure('field_required', '$.session_id');
  }

  if (Object.hasOwn(obj, 'control_lease')) {
    const invalidLease = validateString(obj.control_lease, '$.control_lease', {
      max: 64,
      allowEmpty: true,
    });
    if (invalidLease) return invalidLease;
  }

  const payloadResult = validatePayloadForOperation(obj.operation, obj.payload);
  if (!payloadResult.ok) return payloadResult;
  const value = {
    v: obj.v,
    kind: obj.kind,
    request_id: obj.request_id,
    operation: obj.operation,
  };
  if (sessionId !== undefined) value.session_id = sessionId;
  if (Object.hasOwn(obj, 'control_lease')) value.control_lease = obj.control_lease;
  value.payload = payloadResult.value;
  return success(value);
}

function buildResult(requestId, data) {
  return { v: PROTOCOL_VERSION, kind: 'result', request_id: requestId, ok: true, data };
}

function buildError(requestId, codeKey, reason, retryable = false) {
  if (!Object.hasOwn(ERROR_CODES, codeKey)) throw new TypeError(`unknown remote error code: ${codeKey}`);
  return {
    v: PROTOCOL_VERSION,
    kind: 'result',
    request_id: requestId,
    ok: false,
    error: { code: ERROR_CODES[codeKey], reason, retryable: retryable === true },
  };
}

function buildEvent({ eventSeq, type, sessionId, streamId, turnId, payload }) {
  if (!EVENT_TYPE_SET.has(type)) throw new TypeError(`unknown remote event type: ${type}`);
  const event = {
    v: PROTOCOL_VERSION,
    kind: 'event',
    event_seq: eventSeq,
    type,
    session_id: toWireSessionId(sessionId),
  };
  if (streamId !== undefined) event.stream_id = streamId;
  if (turnId !== undefined) event.turn_id = turnId;
  event.payload = payload;
  return event;
}

module.exports = Object.freeze({
  PROTOCOL_VERSION,
  OPERATIONS,
  EVENT_TYPES,
  ERROR_CODES,
  buildError,
  buildEvent,
  buildResult,
  fromWireSessionId,
  toWireSessionId,
  validateCommand,
  validateDecisionPayload,
  validateFrameHeader,
});
