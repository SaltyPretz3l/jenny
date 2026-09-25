'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('../helpers/session-runtime-children-fixture');
const { dependencyFixture } = require('../helpers/session-runtime-dependency-fixture');
const { completedEffectRefs } = require('../../services/session-runtime/continuation-effect-refs');
const { proveMixedDependencyPrefix, assertPredecessorWaitOrder } = require('../../services/session-runtime/dependency-mixed-proof');
const { assertDecisionProgress } = require('../../services/backend/runtime-decision-proof');

test('mixed child proof binds generic outputs, typed receipts, current execution count and lineage', async t => {
  const h = await fixture(t, { workspace: true });
  const child = await h.spawn();
  const f = dependencyFixture(h, child);
  const work = h.runtime.store.get(h.started.work_id);
  const read = ['tool_executing', 'tool_result'].map((kind, index) => ({
    event_id: `${work.attempt.stream_id}:canonical:${index + 4}`, turn_id: work.turn_id,
    kind, tool_call_id: 'read_1', payload: { canonical_seq: index + 4,
      canonical_event_type: index ? 'tool_execution_completed' : 'tool_execution_started',
      tool_name: 'read_file', tool_input: { path: 'fixture.txt' },
      ...(index ? { success: true, tool_output_summary: 'Exact prior output.' } : {}) } }));
  const events = [...f.events, ...read];
  const input = { runtime: h.runtime, work, events, dependencyId: child.child_work_id,
    expectedRefs: f.params.completed_spawn_refs, expectedWaitRefs: [], expectedEffects: completedEffectRefs(events),
    pendingCallId: 'wait_1', permittedStreams: [work.attempt.stream_id], expectedEmittedCount: 2 };
  assert.equal(proveMixedDependencyPrefix(input).emittedCount, 2);
  for (const mutate of [
    value => { value.events.at(-1).payload.tool_output_summary = 'Changed'; },
    value => { value.events.pop(); },
    value => { value.expectedEmittedCount = 0; },
    value => { value.expectedRefs[0].result_sha256 = 'f'.repeat(64); },
    value => { value.events[2].payload.tool_output_summary = JSON.stringify({ ...child, session_id: 'forged' }); value.expectedEffects = completedEffectRefs(value.events); },
    value => { value.events.at(-1).payload.metadata = { workspace_change_set: {} }; },
    value => { value.events.at(-1).payload.trusted_attachment_refs = ['missing']; },
  ]) {
    const altered = { ...input, events: structuredClone(events), expectedRefs: structuredClone(input.expectedRefs),
      expectedEffects: structuredClone(input.expectedEffects) };
    mutate(altered); assert.throws(() => proveMixedDependencyPrefix(altered));
  }
});

test('mixed progress refuses missing prior pending outcomes, reordered calls and replenished budgets', () => {
  const savedCalls = ['approved', 'dropped'].map(call_id => ({ call_id, tool_id: 'read_file' }));
  const position = { tool_call_limit: 20, tool_calls_consumed: 3, current_iteration: 2,
    completed_iterations: 2, remaining_iterations: 6, active_budget_ms_remaining: 5000 };
  const previous = { kind: 'before_decision_wait', position, completed_effect_refs: [] };
  const current = { prior_effect_count: 0, position: { ...position, tool_calls_consumed: 4 },
    completed_effect_refs: savedCalls.map(call => ({ ...call, success: call.call_id === 'approved' })) };
  const next = [{ call_id: 'new_wait', tool_id: 'session_wait' }];
  assert.doesNotThrow(() => assertDecisionProgress(previous, current, savedCalls, next));
  assert.throws(() => assertDecisionProgress(previous, { ...current, completed_effect_refs: current.completed_effect_refs.slice(0, 1) }, savedCalls, next), /pending_progress/);
  for (const patch of [{ tool_call_limit: 21 }, { tool_calls_consumed: 3 },
    { remaining_iterations: 7 }, { active_budget_ms_remaining: 5001 }]) {
    assert.throws(() => assertDecisionProgress(previous, { ...current, position: { ...current.position, ...patch } }, savedCalls, next));
  }
  assert.throws(() => assertDecisionProgress(previous, { ...current, completed_effect_refs: [] }, savedCalls, [...savedCalls].reverse()), /pending_order/);
});

test('dependency predecessor must finish its saved wait before any new effect', () => {
  const previous = { kind: 'before_dependency_wait', pending_call: { call_id: 'wait_1' }, wait: { dependency_id: 'child_1' } };
  const current = { source_attempt: { stream_id: 'stream_new' } };
  const event = { event_id: 'stream_new:canonical:1', kind: 'tool_result', tool_call_id: 'wait_1',
    payload: { tool_name: 'session_wait', tool_input: { child_work_id: 'child_1' }, success: true } };
  assert.doesNotThrow(() => assertPredecessorWaitOrder(previous, current, [event]));
  assert.throws(() => assertPredecessorWaitOrder(previous, current, [{ ...event, tool_call_id: 'new_effect' }, event]));
  assert.throws(() => assertPredecessorWaitOrder(previous, current, [{ ...event, payload: { ...event.payload, success: false } }]));
});
