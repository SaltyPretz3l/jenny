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
const projectId = { type: 'string', minLength: 9, maxLength: 136, pattern: '^project_[A-Za-z0-9_-]{1,128}$' };
const authorityKey = { type: 'string', pattern: '^authority_[a-f0-9]{64}$' };
const text = (maxLength) => ({ type: 'string', maxLength });
const object = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const positiveRevision = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const runtimeControl = { work_id: id, expected_revision: positiveRevision };
const laneLimits = { runnable_turns: { type: 'integer', minimum: 1, maximum: 16 },
  inference_requests: { type: 'integer', minimum: 1, maximum: 64 },
  descendants: { type: 'integer', minimum: 0, maximum: 512 },
  descendant_depth: { type: 'integer', minimum: 0, maximum: 8 } };
const resourceLimits = { tool_operations: { type: 'integer', minimum: 1, maximum: 64 },
  native_processes: { type: 'integer', minimum: 1, maximum: 64 },
  tests: { type: 'integer', minimum: 1, maximum: 16 } };
const runtimeLimits = full => object({ local: object(laneLimits, full ? Object.keys(laneLimits) : []),
  cloud: object(laneLimits, full ? Object.keys(laneLimits) : []),
  resources: object(resourceLimits, full ? Object.keys(resourceLimits) : []) }, full ? ['local', 'cloud', 'resources'] : []);
// This is an explicit service vocabulary, not a reflection of Electron IPC.
const PARAM_SCHEMAS = Object.freeze({
  'sessionRuntime.getSnapshot': object({ project_id: projectId, session_id: id, cursor: { anyOf: [text(4096), { type: 'null' }] },
    limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  'sessionRuntime.getWork': object({ work_id: id, child_offset: { type: 'integer', minimum: 0, maximum: 512 },
    lineage_revision: positiveRevision }, ['work_id']),
  'sessionRuntime.getResult': object({ work_id: id }, ['work_id']),
  'sessionRuntime.start': object({ purpose: { ...text(256), minLength: 1 }, prompt: { ...text(100000), minLength: 1 },
    limits: object(Object.fromEntries(['inference_requests', 'input_tokens', 'output_tokens'].map(key =>
      [key, { type: 'integer', minimum: 1, maximum: 1000000000000 }])), ['inference_requests', 'input_tokens', 'output_tokens']) },
  ['purpose', 'prompt', 'limits']),
  'sessionRuntime.pause': object(runtimeControl, ['work_id', 'expected_revision']),
  'sessionRuntime.resume': object(runtimeControl, ['work_id', 'expected_revision']),
  'sessionRuntime.cancel': object(runtimeControl, ['work_id', 'expected_revision']),
  'sessionRuntime.updatePending': object({ ...runtimeControl, prompt: { ...text(100000), minLength: 1 } },
    ['work_id', 'expected_revision', 'prompt']),
  'sessionRuntime.updateLimits': object({ expected_limits: runtimeLimits(true), patch: runtimeLimits(false) },
    ['expected_limits', 'patch']),
  'sessions.list': object({}),
  'requests.status': object({ request_id: id }, ['request_id']),
  'sessions.create': object({ title: text(80) }),
  'sessions.rename': object({ title: { ...text(80), minLength: 1 } }, ['title']),
  'sessions.delete': object({}),
  'sessions.snapshot': object({
    before_message_id: text(256), max_messages: { type: 'integer', minimum: 1, maximum: 100 },
  }),
  'sessions.preferences': object({ plan_mode: { type: 'boolean' } }, ['plan_mode']),
  'projects.list': object({}),
  'projects.create': object({ name: { ...text(80), minLength: 1 } }, ['name']),
  'projects.rename': object({
    project_id: projectId, name: { ...text(80), minLength: 1 },
  }, ['project_id', 'name']),
  'projects.bindRoot': object({
    project_id: projectId,
    root_path: { anyOf: [{ type: 'null' }, { ...text(4096), minLength: 1, pattern: '^/' }] },
    expected_root_revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  }, ['project_id', 'root_path', 'expected_root_revision']),
  'projects.assignSession': object({ project_id: projectId }, ['project_id']),
  'permissionReview.getState': object({}),
  'permissionReview.resolve': {
    oneOf: [
      object({
        review_id: id,
        decision: { enum: ['ask', 'deny', 'dismiss'] },
      }, ['review_id', 'decision']),
      object({
        review_id: id,
        decision: { const: 'auto' },
        project_id: projectId,
        expected_root_revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        expected_authority_key: authorityKey,
      }, [
        'review_id', 'decision', 'project_id', 'expected_root_revision', 'expected_authority_key',
      ]),
    ],
  },
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
const WITHOUT_SESSION = new Set([
  'sessionRuntime.getSnapshot', 'sessionRuntime.getWork', 'sessionRuntime.getResult', 'sessionRuntime.updateLimits',
  'sessions.list', 'sessions.create', 'requests.status',
  'projects.list', 'projects.create', 'projects.rename', 'projects.bindRoot',
  'permissionReview.getState', 'permissionReview.resolve',
]);

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
