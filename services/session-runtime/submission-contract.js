'use strict';

const { validStart } = require('./root-run-start');
const { validId, MAX_PENDING_INPUT_BYTES } = require('./contracts');

const FIELDS = Object.freeze({
  session_id: 'sessionId', prompt: 'prompt', visible_prompt: 'visiblePrompt',
  preferred_model: 'preferredModel', reasoning_effort: 'reasoningEffort',
  attachments: 'attachments', plan_mode: 'planMode', context_preferences: 'contextPreferences',
  active_file_context: 'activeFileContext', mention_contents: 'mentionContents',
  tool_preferences: 'toolPreferences', approval_mode: 'approvalMode', debug_options: 'debugOptions',
  plugin_command_invocation: 'pluginCommandInvocation', skill_invocation: 'skillInvocation',
});

function normalizeSubmission(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => key !== 'idempotency_key' && !Object.hasOwn(FIELDS, key))
    || !validId(payload.idempotency_key) || !validId(payload.session_id)
    || typeof payload.prompt !== 'string' || !payload.prompt.trim()
    || (payload.attachments !== undefined && !Array.isArray(payload.attachments))
    || (payload.plan_mode !== undefined && typeof payload.plan_mode !== 'boolean')
    || ['visible_prompt', 'preferred_model', 'reasoning_effort', 'approval_mode']
      .some(key => payload[key] !== undefined && typeof payload[key] !== 'string')) return null;
  let encoded;
  try { encoded = JSON.stringify(payload); } catch (_error) { return null; }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PENDING_INPUT_BYTES) return null;
  const captured = JSON.parse(encoded);
  const request = Object.fromEntries(Object.entries(FIELDS)
    .filter(([key]) => Object.hasOwn(captured, key)).map(([key, value]) => [value, captured[key]]));
  return { request, idempotencyKey: captured.idempotency_key };
}

function normalizeStartSubmission(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { purpose, limits, ...send } = payload;
  if (!validStart({ purpose, limits })) return null;
  const normalized = normalizeSubmission(send);
  return normalized ? { ...normalized, purpose: purpose.trim(), limits: { ...limits } } : null;
}

function normalizeResumeRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).sort().join(',') !== 'expected_revision,work_id'
    || !validId(payload.work_id) || !Number.isSafeInteger(payload.expected_revision)
    || payload.expected_revision < 1) return null;
  return { workId: payload.work_id, expectedRevision: payload.expected_revision };
}

module.exports = { normalizeSubmission, normalizeStartSubmission, normalizeResumeRequest };
