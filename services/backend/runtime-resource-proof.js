"use strict";
const { stableJson } = require('../session-runtime/contracts');
const { normalizeCompletedEffects } = require('../session-runtime/continuation-contracts');
const { completedEffectRefs } = require('../session-runtime/continuation-effect-refs');
const { isContinuationEvent } = require('../session-runtime/continuation-events');
const { decisionProjection } = require('./runtime-continuation-effects');
const { assertQuotaCoverage } = require('../session-runtime/quota-state');
const { assertDecisionProgress, readDecisionPredecessor } = require('./runtime-decision-proof');
const { assertPredecessorWaitOrder } = require('../session-runtime/dependency-mixed-proof');
function fail() { throw new Error('runtime_resource_progress_unproven'); }

function proveResourcePrefix({ work, completedRefs, pendingCalls, position, events, priorEvents = [] }) {
  const refs = normalizeCompletedEffects(completedRefs);
  const completed = new Set(refs.map(ref => ref.call_id));
  const pending = new Set(pendingCalls.map(call => call.call_id));
  if (!pending.size || [...pending].some(id => completed.has(id))) fail();
  const unique = new Map();
  for (const event of [...priorEvents, ...events]) {
    if (unique.has(event.event_id) && stableJson(unique.get(event.event_id)) !== stableJson(event)) fail();
    unique.set(event.event_id, event);
  }
  const all = [...unique.values()];
  if (Buffer.byteLength(stableJson(all)) > 1024 * 1024
    || stableJson(completedEffectRefs(all)) !== stableJson(refs)) fail();
  const charged = new Set(all.filter(event => event.kind === 'tool_executing'
    && completed.has(event.tool_call_id)).map(event => event.tool_call_id));
  if (!Number.isSafeInteger(position?.tool_calls_consumed)
    || position.tool_calls_consumed < pendingCalls.length + charged.size) fail();
  const executed = new Set();
  const announced = new Set();
  const context = { sessionId: work.session_id, turnId: work.turn_id,
    streamId: work.attempt.stream_id, pendingCalls, events };
  for (const event of events) {
    const projection = decisionProjection(event, context);
    if (event.turn_id !== work.turn_id
      || (!String(event.event_id).startsWith(`${work.attempt.stream_id}:`) && !projection)
      || (!isContinuationEvent(event) && !projection)) fail();
    if (['assistant_text_segment', 'reasoning_phase'].includes(event.kind)) continue;
    if (!['tool_use', 'tool_executing', 'tool_result', 'approval_requested', 'approval_resolved'].includes(event.kind)) fail();
    const call = pendingCalls.find(item => item.call_id === event.tool_call_id);
    if (!call && !completed.has(event.tool_call_id)) fail();
    if (call) {
      if (event.kind !== 'tool_use' || event.payload?.canonical_event_type !== 'tool_call_requested'
        || event.payload.tool_name !== call.tool_id || announced.has(call.call_id)
        || stableJson(event.payload.tool_input) !== stableJson(call.arguments)) fail();
      announced.add(call.call_id);
    } else if (event.kind === 'tool_executing') executed.add(event.tool_call_id);
  }
  return { valid: true, emittedCount: executed.size };
}

function validateResourceProgress({ params, work, runtime, events, resourceOperations }) {
  const first = params.tool_calls?.[0];
  if (!resourceOperations.validateResourceWait(first?.call_id, first?.tool_id,
    params.frozen_input?.visible_tool_arguments)) fail();
  const frozen = params.frozen_input;
  if ([frozen?.effective_tool_arguments, frozen?.execution_context_payload]
    .some(value => !value || Object.hasOwn(value, '_jenny_change_set_id'))) fail();
  assertQuotaCoverage(params.quota_state, params.tool_calls, params.completed_effect_refs);
  let priorEvents = [];
  if (params.prior_checkpoint_ref) {
    const previous = readDecisionPredecessor(runtime, work, params.prior_checkpoint_ref);
    assertDecisionProgress({ ...previous.checkpoint,
      completed_effect_refs: previous.checkpoint.completed_effect_refs || completedEffectRefs(previous.payload.turnEvents) },
    params, previous.payload.toolBatch.calls, params.tool_calls,
    previous.payload, { frozenFirstInput: frozen });
    assertPredecessorWaitOrder(previous.checkpoint, { ...params, source_attempt: work.attempt }, events);
    priorEvents = previous.payload.turnEvents;
  } else if (params.prior_effect_count !== 0) fail();
  return proveResourcePrefix({ work, pendingCalls: params.tool_calls,
    completedRefs: params.completed_effect_refs, position: params.position, events, priorEvents });
}
module.exports = { proveResourcePrefix, validateResourceProgress };
