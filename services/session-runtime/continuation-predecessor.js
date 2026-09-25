'use strict';
const { createHash } = require('node:crypto');
const { stableJson, normalizeCheckpointRef } = require('./contracts');
const { completedEffectRefs } = require('./continuation-effect-refs');
const { proveDependencyPrefix } = require('./dependency-proof');
const { proveMixedDependencyPrefix, assertPredecessorWaitOrder, eventStream } = require('./dependency-mixed-proof');
function fail() { throw new Error('runtime_continuation_predecessor_invalid'); }
function readContinuationPredecessor(runtime, work, reference, visited = new Set()) {
  const ref = normalizeCheckpointRef(reference);
  if (!ref || visited.size >= 20 || visited.has(ref.checkpoint_id)
    || ref.source_attempt.stream_id === work.attempt.stream_id
    || ref.source_attempt.attempt_id === work.attempt.attempt_id) fail();
  visited.add(ref.checkpoint_id);
  const source = { ...work, attempt: ref.source_attempt, checkpoint_ref: ref };
  const checkpoint = runtime.checkpointStore.readHistorical(ref, source);
  const digest = value => createHash('sha256').update(stableJson(value)).digest('hex');
  if (!['before_dependency_wait', 'before_decision_wait', 'before_tool_dispatch'].includes(checkpoint.kind)
    || checkpoint.authority.sha256 !== digest(work.authority) || checkpoint.route.sha256 !== digest(work.input.route)
    || checkpoint.canonical_refs.request_ref.sha256 !== work.submission_hash) fail();
  const payload = runtime.conversationStore.resolvePendingContinuation(checkpoint, source,
    { includePayload: true, historical: true });
  if (!payload.valid || !Array.isArray(payload.turnEvents)) fail();
  if (checkpoint.quota_state) require('./quota-state').assertQuotaCoverage(
    checkpoint.quota_state, payload.toolBatch.calls, require('./quota-state').quotaEffects(payload.turnEvents));
  const previous = checkpoint.prior_checkpoint_ref
    ? readContinuationPredecessor(runtime, source, checkpoint.prior_checkpoint_ref, visited) : null;
  const inherited = new Set((previous?.payload.turnEvents || []).map(event => event.event_id));
  const events = payload.turnEvents.filter(event => !inherited.has(event.event_id));
  // Late imports keep existing proof entrypoints callable without a startup cycle.
  const { assertDecisionProgress, proveDecisionPrefix } = require('../backend/runtime-decision-proof');
  if (previous && (checkpoint.completed_effect_refs || previous.checkpoint.kind === 'before_decision_wait')) {
    assertDecisionProgress({ ...previous.checkpoint,
      completed_effect_refs: previous.checkpoint.completed_effect_refs || completedEffectRefs(previous.payload.turnEvents) },
    checkpoint, previous.payload.toolBatch.calls, payload.toolBatch.calls, previous.payload, payload);
    assertPredecessorWaitOrder(previous.checkpoint, checkpoint, events);
  } else if (previous) {
    require('./dependency-predecessor').assertDependencyProgress(previous.checkpoint, checkpoint, payload.turnEvents);
  }
  if (checkpoint.mutation_ref && runtime.mutationJournalProof?.verify({ work: source,
    reference: checkpoint.mutation_ref, decision: checkpoint.decision,
    completedRefs: checkpoint.completed_effect_refs, historical: true })?.valid !== true) fail();
  if (checkpoint.kind === 'before_tool_dispatch') {
    require('../backend/runtime-resource-proof').proveResourcePrefix({ work: source,
      position: checkpoint.position, completedRefs: checkpoint.completed_effect_refs || [], pendingCalls: payload.toolBatch.calls,
      events, priorEvents: previous?.payload.turnEvents || [] });
  } else if (checkpoint.kind === 'before_decision_wait') {
    proveDecisionPrefix({ work: source, decision: checkpoint.decision, completedRefs: checkpoint.completed_effect_refs,
      pendingCalls: payload.toolBatch.calls, events, priorEvents: previous?.payload.turnEvents || [] });
  } else {
    const proof = checkpoint.completed_effect_refs ? proveMixedDependencyPrefix : proveDependencyPrefix;
    proof({ runtime, work: source, events: payload.turnEvents, dependencyId: checkpoint.wait.dependency_id,
      expectedRefs: checkpoint.completed_spawn_refs, expectedWaitRefs: checkpoint.completed_wait_refs ?? null,
      expectedEffects: checkpoint.completed_effect_refs, expectedEmittedCount: checkpoint.eligibility.emitted_tool_execution_count, pendingCallId: checkpoint.pending_call.call_id,
      permittedStreams: [...new Set([...(previous?.payload.turnEvents || []).map(eventStream), source.attempt.stream_id])] });
  }
  return { checkpoint, payload, reference: ref };
}
module.exports = { readContinuationPredecessor };
