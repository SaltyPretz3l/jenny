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
const teamRole = { enum: ['member', 'read_only'] };
const teamCount = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const runtimeControl = { work_id: id, expected_revision: positiveRevision };
// Team chat (TEAM_CHAT_SPEC "API and realtime"): the chat store re-validates every id, text and ref.
const channelId = { type: 'string', minLength: 6, maxLength: 160, pattern: '^chan_[A-Za-z0-9_-]+$' };
const chatText = { type: 'string', minLength: 1, maxLength: 32_000 };
const chatLimit = (maximum) => ({ type: 'integer', minimum: 1, maximum });
// The team chat search cursor (slice 2a-3b): opaque base64url, bounded. The
// search module checks the same bound and alphabet when it decodes one.
const CHAT_CURSOR_MAX_CHARS = 512;
const CHAT_CURSOR_PATTERN = '^[A-Za-z0-9_-]+$';
const chatRef = { anyOf: [
  object({ kind: { const: 'conversation' }, session_id: id }, ['kind', 'session_id']),
  object({ kind: { const: 'file' }, project_id: projectId, path: { ...text(1024), minLength: 1 },
    line: { anyOf: [positiveRevision, { type: 'null' }] } }, ['kind', 'project_id', 'path', 'line']),
  object({ kind: { const: 'message' }, channel_id: channelId, message_id: id }, ['kind', 'channel_id', 'message_id']),
] };
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
    limit: { type: 'integer', minimum: 1, maximum: 100 }, view: { enum: ['runs'] }, finished_since: text(40) }),
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
  'sessions.preferences': { ...object({ plan_mode: { type: 'boolean' }, run_mode: { enum: ['ask', 'auto', 'plan', 'propose'] } }), minProperties: 1 },
  // Propose mode (row 35): the suggestion record of the command's session.
  'suggestedChanges.list': object({}),
  'suggestedChanges.decide': object({
    id, decision: { enum: ['reject', 'later', 'restore', 'ungroup'] }, reason: text(400),
  }, ['id', 'decision']),
  'suggestedChanges.comment': object({ id, text: { ...text(2000), minLength: 1 } }, ['id', 'text']),
  'suggestedChanges.sendComments': object({
    undo: object({ ids: { type: 'array', maxItems: 200, uniqueItems: true, items: id }, sent_at: { ...text(40), minLength: 1 } }, ['ids', 'sent_at']),
  }),
  'suggestedChanges.discardPending': object({}),
  // Consent is for the revision the person saw; `force` is the confirmed "Apply anyway".
  'suggestedChanges.accept': object({ id, revision: positiveRevision, force: { type: 'boolean' } }, ['id', 'revision']),
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
      question_id: text(512),
      answer: { anyOf: [text(8000), { type: 'array', maxItems: 8, uniqueItems: true, items: text(240) }] },
      other: text(8000),
    }, ['question_id', 'answer']) },
  }, ['stream_id', 'question_ref', 'answers']),
  'questions.decline': object({ stream_id: id, question_ref: { ...id, maxLength: 512 } }, ['stream_id', 'question_ref']),
  // Team host commands (TEAM_MEMBERSHIP_SPEC). Each has a row in server/team/operation-registry.js.
  'team.members.list': object({}),
  'team.invite.create': object({ role: teamRole, ttl_ms: { type: 'integer', minimum: 60_000, maximum: 604_800_000 } },
    ['role']),
  'team.invite.reveal': object({ invite_id: id }, ['invite_id']),
  'team.invite.revoke': object({ invite_id: id }, ['invite_id']),
  'team.invite.list': object({}),
  'team.device.invite': object({}),
  'team.device.list': object({}),
  'team.device.revoke': object({ device_id: id }, ['device_id']),
  'team.member.admit': object({ member_id: id }, ['member_id']),
  'team.member.setRole': object({ member_id: id, role: teamRole }, ['member_id', 'role']),
  'team.member.revoke': object({ member_id: id }, ['member_id']),
  'team.audit.read': object({ cursor: teamCount, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  'team.rename': object({ name: { ...text(128), minLength: 1 } }, ['name']),
  'team.owner.transfer': object({ member_id: id }, ['member_id']),
  // Team chat (slice 2a-3a). Each has a row in server/team/operation-registry.js.
  'team.chat.overview': object({}),
  'team.chat.history': object({ channel_id: channelId, before_seq: positiveRevision, limit: chatLimit(100) },
    ['channel_id', 'limit']),
  'team.chat.sync': object({ channel_id: channelId, after_rev: teamCount, limit: chatLimit(200) },
    ['channel_id', 'after_rev', 'limit']),
  'team.chat.thread': object({ channel_id: channelId, root_id: id, after_seq: teamCount, limit: chatLimit(100) },
    ['channel_id', 'root_id', 'limit']),
  'team.chat.post': object({ channel_id: channelId, text: chatText, thread_root_id: id,
    refs: { type: 'array', maxItems: 8, items: chatRef } }, ['channel_id', 'text']),
  'team.chat.edit': object({ channel_id: channelId, message_id: id, text: chatText, expected_rev: positiveRevision },
    ['channel_id', 'message_id', 'text', 'expected_rev']),
  'team.chat.delete': object({ channel_id: channelId, message_id: id }, ['channel_id', 'message_id']),
  'team.chat.mark_read': object({ channel_id: channelId, seq: teamCount, unread: { type: 'boolean' } },
    ['channel_id', 'seq']),
  'team.chat.set_notify': object({ channel_id: channelId, level: { enum: ['all', 'mentions', 'none'] } },
    ['channel_id', 'level']),
  'team.chat.follow': object({ channel_id: channelId, root_id: id, on: { type: 'boolean' } },
    ['channel_id', 'root_id', 'on']),
  // Slice 2a-3b. The cursor is opaque; the search module validates it in full.
  'team.chat.search': object({ query: { type: 'string', minLength: 1, maxLength: 200 }, channel_id: channelId,
    cursor: { type: 'string', minLength: 1, maxLength: CHAT_CURSOR_MAX_CHARS, pattern: CHAT_CURSOR_PATTERN },
    limit: chatLimit(50) },
  ['query', 'limit']),
  'team.chat.typing': object({ channel_id: channelId, thread_root_id: id }, ['channel_id']),
  'team.presence.set': object({ state: { enum: ['active', 'idle'] } }, ['state']),
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
  'team.members.list', 'team.invite.create', 'team.invite.reveal', 'team.invite.revoke', 'team.invite.list',
  'team.device.invite', 'team.device.list', 'team.device.revoke', 'team.member.admit', 'team.member.setRole',
  'team.member.revoke', 'team.audit.read', 'team.rename', 'team.owner.transfer',
  'team.chat.overview', 'team.chat.history', 'team.chat.sync', 'team.chat.thread', 'team.chat.post',
  'team.chat.edit', 'team.chat.delete', 'team.chat.mark_read', 'team.chat.set_notify', 'team.chat.follow',
  'team.chat.search', 'team.chat.typing', 'team.presence.set',
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

module.exports = {
  API_VERSION, CHAT_CURSOR_MAX_CHARS, CHAT_CURSOR_PATTERN, EXECUTION_POLICY_VERSION, ERROR_CODES, PARAM_SCHEMAS,
  validateCommand, hostFailure,
};
