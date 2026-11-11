'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApprovedCallGrants } = require('../../services/backend/runtime-approved-call-grants');
const { proveResourcePrefix } = require('../../services/backend/runtime-resource-proof');

const CALL = { call_id: 'call_1', tool_id: 'read_file' };
const INPUT = { path: 'blocked.txt' };
const PARK = { streamId: 'stream_a', call: CALL, visibleInput: INPUT, effectiveArgsSha256: 'a'.repeat(64), checkpointId: 'checkpoint_1' };
const answer = (grants, overrides = {}) => grants.noteApproved({ streamId: 'stream_a', callId: 'call_1', toolName: 'read_file', input: INPUT, ...overrides });

test('a parked approval is handed over once, for its own checkpoint', () => {
  const grants = createApprovedCallGrants();
  answer(grants);
  assert.equal(grants.park(PARK), true);
  assert.equal(grants.take('checkpoint_other'), null);
  assert.deepEqual(grants.take('checkpoint_1'), {
    call: { call_id: 'call_1', tool_id: 'read_file', effective_args_sha256: 'a'.repeat(64) }, input: INPUT });
  assert.equal(grants.take('checkpoint_1'), null);
});

for (const [name, overrides] of [
  ['another stream', { streamId: 'stream_b' }],
  ['another call', { callId: 'call_2' }],
  ['another tool', { toolName: 'write_file' }],
  ['changed input', { input: { path: 'other.txt' } }],
]) {
  test(`an approval for ${name} does not carry over the wait`, () => {
    const grants = createApprovedCallGrants();
    answer(grants, overrides);
    assert.equal(grants.park(PARK), false);
    assert.equal(grants.take('checkpoint_1'), null);
  });
}

test('an unapproved park grants nothing and one answer parks only once', () => {
  const grants = createApprovedCallGrants();
  assert.equal(grants.park(PARK), false);
  answer(grants);
  assert.equal(grants.park(PARK), true);
  assert.equal(grants.park({ ...PARK, checkpointId: 'checkpoint_2' }), false);
});

test('retained approvals stay bounded, oldest first', () => {
  const grants = createApprovedCallGrants();
  for (let index = 0; index < 65; index += 1) {
    answer(grants, { callId: `call_${index}` });
    assert.equal(grants.park({ ...PARK, call: { ...CALL, call_id: `call_${index}` }, checkpointId: `checkpoint_${index}` }), true);
  }
  assert.equal(grants.take('checkpoint_0'), null);
  assert.notEqual(grants.take('checkpoint_64'), null);
});

const STREAM = 'stream_a';
const resolvedEvent = (payload = {}) => ({ event_id: `${STREAM}:approval:resolved:call_1`, kind: 'approval_resolved', turn_id: 'turn_1',
  tool_call_id: 'call_1', payload: { canonical_seq: 2, approved: true, approval_state: 'approved', tool_name: 'read_file', ...payload } });
const prove = events => proveResourcePrefix({ work: { session_id: 'session_1', turn_id: 'turn_1', attempt: { stream_id: STREAM } }, completedRefs: [],
  pendingCalls: [{ call_id: 'call_1', tool_id: 'read_file', arguments: INPUT }], position: { tool_calls_consumed: 1 }, events });

test('a wait with no completed effect is proven only by an answered card', () => {
  assert.equal(prove([resolvedEvent()]).valid, true);
  assert.throws(() => prove([]), /runtime_resource_progress_unproven/);
  assert.throws(() => prove([resolvedEvent({ approved: false })]), /runtime_resource_progress_unproven/);
  assert.throws(() => prove([resolvedEvent({ tool_name: 'write_file' })]), /runtime_resource_progress_unproven/);
});
