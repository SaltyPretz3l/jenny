'use strict';

const { validStart } = require('./root-run-start');
const { validId, MAX_PENDING_INPUT_BYTES } = require('./contracts');

const FIELDS = Object.freeze({
  session_id: 'sessionId', prompt: 'prompt', visible_prompt: 'visiblePrompt',
  preferred_model: 'preferredModel', reasoning_effort: 'reasoningEffort',
  attachments: 'attachments', plan_mode: 'planMode', context_preferences: 'contextPreferences',
  active_file_context: 'activeFileContext', mention_contents: 'mentionContents',
  tool_preferences: 'toolPreferences', approval_mode: 'approvalMode', debug_options: 'debugOptions',
  skill_invocation: 'skillInvocation',
  client_timing: 'clientTiming',
});
const CLIENT_TIMING_KEYS = Object.freeze(['send_started_at_ms', 'optimistic_rendered_at_ms', 'local_render_latency_ms']);

// Send-phase telemetry rides the submission but never decides it: malformed
// timing is dropped, not refused.
function captureClientTiming(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const timing = Object.fromEntries(CLIENT_TIMING_KEYS
    .filter(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0)
    .map(key => [key, value[key]]));
  return Object.keys(timing).length ? timing : undefined;
}

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
  const clientTiming = captureClientTiming(request.clientTiming);
  if (clientTiming) request.clientTiming = clientTiming;
  else delete request.clientTiming;
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
