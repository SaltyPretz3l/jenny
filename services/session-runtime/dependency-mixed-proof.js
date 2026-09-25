'use strict';
const { stableJson } = require('./contracts');
const { assertCompletedEffects } = require('./continuation-effect-refs');
const { proveDependencyPrefix } = require('./dependency-proof');
function fail() { throw new Error('runtime_mixed_dependency_unproven'); }
function eventStream(event) {
  const id = String(event.event_id || '');
  return event.payload?.parent_stream_id || id.split(':')[0];
}
function proveMixedDependencyPrefix({ runtime, work, events, dependencyId, expectedRefs,
  expectedWaitRefs, expectedEffects, pendingCallId, permittedStreams, expectedEmittedCount }) {
  assertCompletedEffects(events, expectedEffects);
  const completed = new Map(expectedEffects.map(ref => [ref.call_id, ref]));
  const allowedKinds = new Set(['tool_use', 'tool_executing', 'tool_result', 'approval_requested', 'approval_resolved']);
  const children = [];
  let emitted = 0;
  for (const event of events) {
    const stream = eventStream(event);
    if (event.turn_id !== work.turn_id || !permittedStreams.includes(stream)) fail();
    if (['assistant_text_segment', 'reasoning_phase'].includes(event.kind)) continue;
    if (!allowedKinds.has(event.kind)) fail();
    if (event.tool_call_id === pendingCallId) {
      if (event.kind !== 'tool_use' || event.payload?.canonical_event_type !== 'tool_call_requested'
        || event.payload.tool_name !== 'session_wait' || stream !== work.attempt.stream_id
        || stableJson(event.payload.tool_input) !== stableJson({ child_work_id: dependencyId })) fail();
    } else if (completed.get(event.tool_call_id)?.tool_id !== event.payload?.tool_name) fail();
    if (event.kind === 'tool_executing' && stream === work.attempt.stream_id) emitted++;
    if (['session_spawn', 'session_wait'].includes(event.payload?.tool_name)) children.push(event);
  }
  if (expectedEmittedCount !== emitted) fail();
  const proof = proveDependencyPrefix({ runtime, work, events: children, dependencyId,
    expectedRefs, expectedWaitRefs, pendingCallId, permittedStreams, allowRepeatedAnnouncements: true });
  return { ...proof, emittedCount: emitted };
}
function assertResourcePredecessorOrder(previous, current, events) {
  const old = previous.position.ordered_call_ids;
  const retained = old.filter(id => current.position.ordered_call_ids.includes(id));
  const removed = old.filter(id => !retained.includes(id));
  const added = current.completed_effect_refs.slice((previous.completed_effect_refs || []).length);
  if (stableJson(old.slice(0, removed.length)) !== stableJson(removed)
    || stableJson(added.slice(0, removed.length).map(ref => ref.call_id)) !== stableJson(removed)
    || (retained.length && added.length !== removed.length)) fail();
  let cursor = 0;
  for (const event of events) {
    if (cursor === removed.length) break;
    if (eventStream(event) !== current.source_attempt.stream_id
      || !['tool_executing', 'tool_result'].includes(event.kind)) continue;
    if (event.tool_call_id !== removed[cursor]) fail();
    if (event.kind === 'tool_result') cursor++;
  }
  if (cursor !== removed.length) fail();
}
function assertPredecessorWaitOrder(previous, current, events) {
  if (previous.kind === 'before_tool_dispatch') return assertResourcePredecessorOrder(previous, current, events);
  if (previous.kind !== 'before_dependency_wait') return;
  let completed = false;
  for (const event of events) {
    if (eventStream(event) !== current.source_attempt.stream_id
      || !['tool_executing', 'tool_result'].includes(event.kind)) continue;
    if (event.tool_call_id !== previous.pending_call.call_id || event.payload?.tool_name !== 'session_wait'
      || event.payload.tool_input?.child_work_id !== previous.wait.dependency_id) fail();
    if (event.kind === 'tool_result' && event.payload.success === true) { completed = true; break; }
  }
  if (!completed) fail();
}
module.exports = { proveMixedDependencyPrefix, assertPredecessorWaitOrder, eventStream };
