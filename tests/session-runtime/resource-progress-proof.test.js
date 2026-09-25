"use strict";
const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { proveResourcePrefix } = require('../../services/backend/runtime-resource-proof');
const work = { session_id: 'session_1', turn_id: 'turn_1', attempt: { stream_id: 'stream_1' } };
const pendingCalls = [{ call_id: 'pending_1', tool_id: 'read_file', arguments: { path: 'two.txt' } }];
function fixture() {
  return { work, pendingCalls, position: { tool_calls_consumed: 2 }, completedRefs: [{ call_id: 'done_1', tool_id: 'read_file', success: true,
    result_sha256: createHash('sha256').update('one').digest('hex') }], events: [
    { event_id: 'stream_1:1', turn_id: 'turn_1', kind: 'tool_executing', tool_call_id: 'done_1',
      payload: { canonical_seq: 1, tool_name: 'read_file', canonical_event_type: 'tool_execution_started' } },
    { event_id: 'stream_1:2', turn_id: 'turn_1', kind: 'tool_result', tool_call_id: 'done_1',
      payload: { canonical_seq: 2, tool_name: 'read_file', success: true, tool_output_summary: 'one' } },
    { event_id: 'stream_1:3', turn_id: 'turn_1', kind: 'tool_use', tool_call_id: 'pending_1',
      payload: { canonical_seq: 3, tool_name: 'read_file', canonical_event_type: 'tool_call_requested', tool_input: { path: 'two.txt' } } },
  ] };
}
test('resource prefix proves only completed results and the exact unstarted suffix', () => {
  assert.deepEqual(proveResourcePrefix(fixture()), { valid: true, emittedCount: 1 });
  for (const mutate of [
    input => { input.position.tool_calls_consumed = 1; },
    input => { input.events[2].kind = 'tool_executing'; },
    input => { input.events[2].kind = 'approval_requested'; },
    input => { input.events[2].payload.tool_input.path = 'changed'; },
    input => { input.events[1].payload.tool_output_summary = 'changed'; },
    input => { input.events[1].payload.success = false; },
    input => { input.events[1].payload.metadata = { workspace_change_set: {} }; },
    input => { input.events[1].event_id = 'foreign:2'; },
    input => { input.completedRefs = []; },
    input => { input.events.push({ ...input.events[1], event_id: 'stream_1:4' }); },
    input => { input.events[0].tool_call_id = 'uncertain'; },
  ]) { const input = structuredClone(fixture()); mutate(input); assert.throws(() => proveResourcePrefix(input)); }
});

test('resource predecessor consumes only an ordered prefix before executing a later call', () => {
  const { assertPredecessorWaitOrder } = require('../../services/session-runtime/dependency-mixed-proof');
  const previous = { kind: 'before_tool_dispatch', position: { ordered_call_ids: ['a', 'b'] }, completed_effect_refs: [] };
  const next = ids => ({ position: { ordered_call_ids: ids }, source_attempt: { stream_id: 'new' },
    completed_effect_refs: ['a', 'b'].filter(id => !ids.includes(id)).map(call_id => ({ call_id })) });
  const event = (id, kind, seq) => ({ event_id: `new:${seq}`, kind, tool_call_id: id });
  assert.doesNotThrow(() => assertPredecessorWaitOrder(previous, next(['a', 'b']), []));
  assert.doesNotThrow(() => assertPredecessorWaitOrder(previous, next(['b']), [event('a', 'tool_executing', 1), event('a', 'tool_result', 2)]));
  assert.throws(() => assertPredecessorWaitOrder(previous, next(['a']), [event('b', 'tool_result', 1)]));
  assert.throws(() => assertPredecessorWaitOrder(previous, next([]), [event('a', 'tool_executing', 1), event('b', 'tool_executing', 2), event('a', 'tool_result', 3), event('b', 'tool_result', 4)]));
  const unstarted = next(['a', 'b']); unstarted.completed_effect_refs.push({ call_id: 'new_call' });
  assert.throws(() => assertPredecessorWaitOrder(previous, unstarted, [event('new_call', 'tool_result', 1)]));
});
