'use strict';

const { normalizeMutationRef } = require('../session-runtime/continuation-contracts');
const { stableJson } = require('../session-runtime/contracts');
const { isDecisionProjection } = require('../session-runtime/continuation-events');
const { buildPersistedToolInputSnapshot } = require('./tool-loop-input-sanitization');
const { PLAN_DECISIONS } = require('../tools/builtin/exit-plan-mode-tool');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function contextForBody(body) {
  return { decision: body.decision, sessionId: body.session_id, turnId: body.turn_id,
    streamId: body.stream_id, pendingCalls: body.tool_batch.calls };
}
function decisionProjection(event, context) {
  let call = context.pendingCalls.find(item => item.call_id === context.decision?.call_id);
  let proof = context;
  if (!isDecisionProjection(event, context)) {
    const completed = completedApprovalCall(event, context);
    if (!completed) return false;
    call = completed;
    proof = { ...context, decision: { kind: 'approval', call_id: call.call_id }, pendingCalls: [call] };
  }
  return isDecisionProjection(event, proof)
    && stableJson(event.payload.input) === stableJson(buildPersistedToolInputSnapshot(call.arguments).input);
}
// Every plan decision executes exit_plan_mode (rejected and accepted return
// their outcome as the tool result), so each proves a completed call.
function completedApprovalState(state, toolName) {
  return state === 'approved' || (toolName === 'exit_plan_mode' && PLAN_DECISIONS.includes(state));
}
function completedApprovalCall(event, context) {
  if (context.pendingCalls.some(call => call.call_id === event.tool_call_id)) return null;
  const related = (context.events || []).filter(item => item.tool_call_id === event.tool_call_id
    && item.turn_id === context.turnId && String(item.event_id).startsWith(`${context.streamId}:`)
    && Number.isSafeInteger(item.payload?.canonical_seq) && item.payload.canonical_seq > 0);
  const stages = [
    related.filter(item => item.kind === 'approval_requested'),
    related.filter(item => item.kind === 'approval_resolved'),
    related.filter(item => item.kind === 'tool_executing'
      && item.payload.canonical_event_type === 'tool_execution_started'),
    related.filter(item => item.kind === 'tool_result'),
  ];
  if (stages.some(items => items.length !== 1)) return null;
  const [requested, resolved, execution, result] = stages.map(items => items[0]);
  const payload = execution.payload;
  if (requested.payload.approval_state !== 'pending' || resolved.payload.approved !== true
    || !completedApprovalState(resolved.payload.approval_state, payload.tool_name)
    || [requested, resolved, result].some(item => item.payload.tool_name !== payload.tool_name)
    // The collector/app-owned array orders events across independent producer sequence origins.
    || !(related.indexOf(requested) < related.indexOf(resolved)
      && related.indexOf(resolved) < related.indexOf(execution)
      && related.indexOf(execution) < related.indexOf(result))) return null;
  return { call_id: event.tool_call_id, tool_id: payload.tool_name, arguments: Object.fromEntries(Object.entries(payload.tool_input || {}).filter(([key]) =>
    !['_jenny_turn_id', '_jenny_tool_call_id', '_jenny_change_set_id', '_jenny_session_id'].includes(key))) };
}
function allowedPendingDecisionEvent(event, context) {
  const { decision, pendingCalls, streamId } = context;
  const call = pendingCalls.find(item => item.call_id === event.tool_call_id);
  if (!decision || !call) return false;
  if (decisionProjection(event, context)) return true;
  if (!Number.isSafeInteger(event.payload?.canonical_seq) || event.payload.canonical_seq < 1
    || !String(event.event_id).startsWith(`${streamId}:`) || event.payload.tool_name !== call.tool_id) return false;
  if (event.kind === 'tool_use' && event.payload.canonical_event_type === 'tool_call_requested'
    && stableJson(event.payload.tool_input) === stableJson(call.arguments)) return true;
  if (event.tool_call_id !== decision.call_id) return false;
  if (decision.kind === 'approval') return event.kind === 'approval_requested'
    && event.event_id === `${streamId}:approval:requested:${decision.call_id}`
    && event.payload.approval_state === 'pending';
  return event.kind === 'tool_executing' && call.tool_id === 'ask_user';
}
// The same selected material is checked before publication and on hydration.
// Include inherited events: the Python resume carrier transports the whole array.
function validateDecisionMaterial(body, events) {
  if (!body.decision && body.frozen_first_input?.tool_name !== 'session_wait') return;
  const frozen = body.frozen_first_input;
  if ([frozen.effective_tool_arguments, frozen.execution_context_payload]
    .some(value => Object.hasOwn(value, '_jenny_change_set_id'))
    || events.some(event => event.kind === 'tool_result'
      && Object.hasOwn(event.payload?.metadata || {}, 'workspace_change_set')
      && (!body.mutation_ref || event.payload.metadata.workspace_change_set?.change_set_id
        !== normalizeMutationRef(body.mutation_ref).change_set_id))) {
    fail('runtime_decision_mutation_state_unsupported');
  }
  if (Buffer.byteLength(stableJson(events), 'utf8') > 1024 * 1024) {
    fail('runtime_decision_prefix_capacity');
  }
}
function eventBelongsToStream(event, streamId) {
  return String(event.event_id || '').startsWith(`${streamId}:`) || String(event.event_id || '').endsWith(`:${streamId}`);
}
function messageBelongsToStream(message, body) {
  return message.id === body.user_message_id || message.parent_stream_id === body.stream_id
    || message.tool_call?.parent_stream_id === body.stream_id || message.tool_result?.parent_stream_id === body.stream_id;
}

const EFFECTFUL_TOOL_EVENT_KINDS = new Set([
  'tool_executing', 'tool_result', 'approval_requested', 'approval_resolved',
]);
const EFFECTFUL_TOOL_STATUSES = new Set([
  'running', 'executing', 'complete', 'completed', 'error', 'failed', 'cancelled',
  'canceled', 'denied', 'interrupted', 'approval_pending',
]);
function validateNoPendingBatchEffects(session, body) {
  const decisionContext = contextForBody(body);
  const callIds = new Set(body.tool_batch.calls.map(call => call.call_id));
  for (const message of session.messages || []) {
    if (String(message?.turn_id || '') !== body.turn_id || !messageBelongsToStream(message, body)) continue;
    const callId = String(message?.tool_call?.call_id || message?.tool_result?.call_id || '');
    if (!callIds.has(callId)) continue;
    const kind = String(message?.kind || '').toLowerCase();
    const status = String(message?.tool_call?.status || message?.status || '').toLowerCase();
    const question = body.decision?.kind === 'user_questions' && callId === body.decision.call_id
      && kind === 'tool_use' && message.tool_call?.tool_name === 'ask_user'
      && ['running', 'executing'].includes(status);
    if (!question && (kind === 'tool_result' || (kind === 'tool_use' && EFFECTFUL_TOOL_STATUSES.has(status)))) {
      fail('runtime_continuation_effect_already_started');
    }
  }
  for (const event of session.turn_events || []) {
    if (String(event?.turn_id || '') !== body.turn_id
      || !eventBelongsToStream(event, body.stream_id)
      || !callIds.has(String(event?.tool_call_id || ''))) continue;
    const kind = String(event?.kind || '').toLowerCase();
    const canonicalType = String(event?.payload?.canonical_event_type || '').toLowerCase();
    if (body.decision && allowedPendingDecisionEvent(event, decisionContext)) continue;
    if (EFFECTFUL_TOOL_EVENT_KINDS.has(kind)
      || canonicalType.startsWith('tool_execution_')
      || canonicalType.startsWith('tool_approval_')) {
      fail('runtime_continuation_effect_already_started');
    }
  }
}

module.exports = { contextForBody, decisionProjection, allowedPendingDecisionEvent, validateDecisionMaterial, validateNoPendingBatchEffects };
