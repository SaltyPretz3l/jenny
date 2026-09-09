'use strict';

const { HOST_ERROR_CODES } = require('../services/backend/error-codes');

const Ajv = require('ajv');

const API_VERSION = 1;
const EXECUTION_POLICY_VERSION = 1;
const ERROR_CODES = Object.freeze({
  invalid: HOST_ERROR_CODES.INVALID,
  unauthorized: HOST_ERROR_CODES.UNAUTHORIZED,
  forbidden: HOST_ERROR_CODES.FORBIDDEN,
  conflict: HOST_ERROR_CODES.CONFLICT,
  unavailable: HOST_ERROR_CODES.UNAVAILABLE,
  persistence: HOST_ERROR_CODES.PERSISTENCE,
  limit: HOST_ERROR_CODES.LIMIT,
});

const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' };
const text = (maxLength) => ({ type: 'string', maxLength });
const object = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
// This is an explicit service vocabulary, not a reflection of Electron IPC.
const PARAM_SCHEMAS = Object.freeze({
  'sessions.list': object({}),
  'requests.status': object({ request_id: id }, ['request_id']),
  'sessions.create': object({ title: text(80) }),
  'sessions.rename': object({ title: { ...text(80), minLength: 1 } }, ['title']),
  'sessions.delete': object({}),
  'sessions.snapshot': object({
    before_message_id: text(256), max_messages: { type: 'integer', minimum: 1, maximum: 100 },
  }),
  'sessions.preferences': object({ plan_mode: { type: 'boolean' } }, ['plan_mode']),
  'control.acquire': object({ takeover: { type: 'boolean' } }),
  'control.heartbeat': object({}),
  'control.release': object({}),
  'chat.send': object({
    prompt: { ...text(100_000), minLength: 1 },
    attachment_ids: { type: 'array', maxItems: 8, uniqueItems: true, items: id },
  }, ['prompt']),
  'chat.cancel': object({ stream_id: id }, ['stream_id']),
  'approval.resolve': object({
    stream_id: id, approval_id: text(512), decision_revision: id,
    approved: { type: 'boolean' },
  }, ['stream_id', 'approval_id', 'decision_revision', 'approved']),
  'questions.answer': object({
    stream_id: id, question_ref: { ...id, maxLength: 512 },
    answers: { type: 'array', maxItems: 8, items: object({
      question_id: id,
      answer: { anyOf: [text(8000), { type: 'array', maxItems: 8, uniqueItems: true, items: text(240) }] },
      other: text(8000),
    }, ['question_id', 'answer']) },
  }, ['stream_id', 'question_ref', 'answers']),
  'questions.decline': object({ stream_id: id, question_ref: { ...id, maxLength: 512 } }, ['stream_id', 'question_ref']),
});

const schema = object({
  api_version: { const: API_VERSION },
  operation: { enum: Object.keys(PARAM_SCHEMAS) },
  request_id: id,
  client_id: id,
  boot_epoch: id,
  session_id: id,
  control_generation: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  expected_revision: text(160),
  params: { type: 'object' },
}, ['api_version', 'operation', 'request_id', 'client_id', 'boot_epoch', 'params']);

const ajv = new Ajv({ allErrors: false, coerceTypes: false, removeAdditional: false });
const validateEnvelope = ajv.compile(schema);
const validators = new Map(Object.entries(PARAM_SCHEMAS).map(([operation, params]) => [operation, ajv.compile(params)]));
const WITHOUT_SESSION = new Set(['sessions.list', 'sessions.create', 'requests.status']);

function validateCommand(value) {
  if (!validateEnvelope(value)) return { ok: false, reason: 'invalid_command_envelope' };
  if (!validators.get(value.operation)(value.params)) return { ok: false, reason: 'invalid_command_parameters' };
  if (!WITHOUT_SESSION.has(value.operation) && !value.session_id) {
    return { ok: false, reason: 'session_required' };
  }
  return { ok: true, value };
}

function hostFailure(kind, reason, requestId = '', retryable = false) {
  return {
    ok: false,
    error: {
      code: ERROR_CODES[kind] || ERROR_CODES.unavailable,
      reason: /^[a-z][a-z0-9_]{0,79}$/.test(reason) ? reason : 'host_unavailable',
      retryable: retryable === true,
      ...(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(requestId)
        ? { request_id: requestId } : {}),
    },
  };
}

module.exports = { API_VERSION, EXECUTION_POLICY_VERSION, ERROR_CODES, validateCommand, hostFailure };
