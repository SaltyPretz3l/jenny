'use strict';

const { createHash } = require('node:crypto');
const { stableJson } = require('../session-runtime/contracts');
const { normalizeDecision, normalizeCompletedEffects } = require('../session-runtime/continuation-contracts');
const { isContinuationEvent } = require('../session-runtime/continuation-events');
const { assertApprovalInputProgress } = require('./runtime-approval-inputs');
const { RUNTIME_ERROR_CODES } = require('./error-codes');

const { decisionProjection, allowedPendingDecisionEvent } = require('./runtime-continuation-effects');

function fail(reason) { throw Object.assign(new Error(reason), { reason, code: RUNTIME_ERROR_CODES.ADMISSION_REJECTED }); }
const hash = value => createHash('sha256').update(value).digest('hex');
const TEXT = new Set(['assistant_text_segment', 'reasoning_phase', 'plan_document']);
const TOOL = new Set(['tool_use', 'tool_executing', 'tool_result', 'approval_requested', 'approval_resolved']);

function assertDecisionProgress(previous, current, previousCalls, currentCalls, previousInputs = null, currentInputs = null) {
  require('../session-runtime/quota-state').assertQuotaProgress(previous.quota_state, current.quota_state,
    currentCalls, current.completed_effect_refs);
  if (previous.mutation_ref && (!current.mutation_ref
    || previous.mutation_ref.workspace_id !== current.mutation_ref.workspace_id
    || previous.mutation_ref.change_set_id !== current.mutation_ref.change_set_id
    || previous.mutation_ref.operation_count > current.mutation_ref.operation_count
    || (previous.mutation_ref.operation_count === current.mutation_ref.operation_count
      && stableJson(previous.mutation_ref) !== stableJson(current.mutation_ref)))) fail('runtime_mutation_progress_invalid');
  if (previous.approval_inputs_ref) {
    if (!previousInputs?.approvalInputsBytes || !currentInputs?.frozenFirstInput) fail('runtime_approval_inputs_unavailable');
    assertApprovalInputProgress(previousInputs, currentInputs, currentCalls);
  }
  const prior = previous.position;
  const next = current.position;
  const refs = previous.completed_effect_refs;
  const newPending = currentCalls.filter(call => !previousCalls.some(item => item.call_id === call.call_id)).length;
  if (current.prior_effect_count !== refs.length
    || stableJson(current.completed_effect_refs.slice(0, refs.length)) !== stableJson(refs)
    || (current.decision && current.decision.decision_id === previous.decision?.decision_id)
    || next.tool_call_limit !== prior.tool_call_limit || next.tool_calls_consumed < prior.tool_calls_consumed + newPending
    || next.current_iteration < prior.current_iteration
    || next.completed_iterations + next.remaining_iterations > prior.completed_iterations + prior.remaining_iterations
    || (prior.active_budget_ms_remaining !== null && (next.active_budget_ms_remaining === null
      || next.active_budget_ms_remaining > prior.active_budget_ms_remaining))) fail('runtime_decision_progress_invalid');
  // A surviving saved suffix must keep its execution order and precede any
  // newly generated calls. Matching inputs by ID alone does not prove order.
  const retained = previousCalls.filter(call => currentCalls.some(nextCall => nextCall.call_id === call.call_id));
  if (stableJson(currentCalls.slice(0, retained.length)) !== stableJson(retained)) {
    fail('runtime_decision_pending_order_changed');
  }
  for (const call of previousCalls) {
    const remaining = currentCalls.find(item => item.call_id === call.call_id);
    if (remaining ? stableJson(remaining) !== stableJson(call)
      : !current.completed_effect_refs.some(ref => ref.call_id === call.call_id && ref.tool_id === call.tool_id)) {
      fail('runtime_decision_pending_progress_invalid');
    }
  }
}

function readDecisionPredecessor(runtime, work, reference, visited = new Set()) {
  return require('../session-runtime/continuation-predecessor').readContinuationPredecessor(runtime, work, reference, visited);
}

function proveDecisionPrefix({ work, decision, completedRefs, pendingCalls, events, priorEvents = [] }) {
  const normalized = normalizeDecision(decision);
  const refs = normalizeCompletedEffects(completedRefs);
  const pendingIds = new Set(pendingCalls.map(call => call.call_id));
  const completedIds = new Set(refs.map(ref => ref.call_id));
  if (refs.some(ref => pendingIds.has(ref.call_id)) || !pendingIds.has(normalized.call_id)) {
    fail('runtime_decision_call_conflict');
  }
  const all = [...priorEvents, ...events];
  const unique = new Map();
  for (const event of all) {
    if (unique.has(event.event_id) && stableJson(unique.get(event.event_id)) !== stableJson(event)) fail('runtime_decision_event_conflict');
    unique.set(event.event_id, event);
  }
  const results = [...unique.values()].filter(event => event.kind === 'tool_result');
  for (const ref of refs) {
    const matches = results.filter(event => event.tool_call_id === ref.call_id);
    if (matches.length !== 1 || matches[0].payload?.tool_name !== ref.tool_id
      || matches[0].payload.success !== ref.success
      || typeof matches[0].payload.tool_output_summary !== 'string'
      || hash(matches[0].payload.tool_output_summary) !== ref.result_sha256) fail('runtime_decision_result_unproven');
  }
  if (results.some(event => !completedIds.has(event.tool_call_id))) fail('runtime_decision_result_unreferenced');
  const executed = new Set();
  const source = work.attempt.stream_id;
  for (const event of events) {
    const call = pendingCalls.find(item => item.call_id === event.tool_call_id);
    const projection = decisionProjection(event, { decision: normalized, sessionId: work.session_id,
      turnId: work.turn_id, streamId: source, pendingCalls, events });
    if (event.turn_id !== work.turn_id || (!String(event.event_id).startsWith(`${source}:`) && !projection)
      || (!isContinuationEvent(event) && !projection)) {
      fail('runtime_decision_event_fence');
    }
    if (TEXT.has(event.kind)) continue;
    if (!TOOL.has(event.kind) || (!call && !completedIds.has(event.tool_call_id))) fail('runtime_decision_event_unsupported');
    if (event.kind === 'tool_executing') executed.add(event.tool_call_id);
    if (!call) continue;
    if (allowedPendingDecisionEvent(event, { decision: normalized, sessionId: work.session_id,
      turnId: work.turn_id, streamId: source, pendingCalls })) continue;
    fail('runtime_decision_pending_effect_started');
  }
  const waitKind = normalized.kind === 'approval' ? 'approval_requested' : 'tool_executing';
  if (!events.some(event => event.kind === waitKind && event.tool_call_id === normalized.call_id
    && allowedPendingDecisionEvent(event, { decision: normalized, sessionId: work.session_id,
      turnId: work.turn_id, streamId: source, pendingCalls }))) fail('runtime_decision_wait_event_missing');
  return { valid: true, emittedCount: executed.size };
}

module.exports = { proveDecisionPrefix, readDecisionPredecessor, assertDecisionProgress };
