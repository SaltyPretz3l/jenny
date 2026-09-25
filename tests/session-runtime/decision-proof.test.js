"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { proveDecisionPrefix, assertDecisionProgress } = require('../../services/backend/runtime-decision-proof');
const { buildDecisionPrefix } = require('../../services/backend/runtime-decision-prefix');
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const completedRefs = [{ call_id: 'done', tool_id: 'list_dir', success: false, result_sha256: hash(' failed\n') }];
  return { work: { session_id: 'session', turn_id: 'turn', attempt: { stream_id: 'stream' } },
    decision: { kind: 'approval', call_id: 'pending', decision_id: 'decision_1', execution_started: false },
    completedRefs, pendingCalls: [{ call_id: 'pending', tool_id: 'read_file', arguments: { path: 'fixture' } }],
    events: [{ event_id: 'stream:canonical:1', turn_id: 'turn', kind: 'tool_result', tool_call_id: 'done',
      payload: { canonical_seq: 1, tool_name: 'list_dir', tool_output_summary: ' failed\n', success: false,
        tool_input: { path: '.' }, metadata: { effects: 'none', failure_class: 'validation' }, error_code: 'CMP-TOOL-0001' } },
    { event_id: 'stream:approval:requested:pending', turn_id: 'turn', kind: 'approval_requested',
      tool_call_id: 'pending', payload: { canonical_seq: 2, tool_name: 'read_file', approval_state: 'pending' } },
    { event_id: 'turn:tool_use:1:stream', turn_id: 'turn', kind: 'tool_use', status: 'pending_approval', tool_call_id: 'pending',
      payload: { tool_name: 'read_file', input: { path: 'fixture' }, parent_stream_id: 'stream', approval_id: 'approval_session_stream_pending' } }] };
}
test('canonical failure replay preserves exact output and error/effect envelope without pending calls', () => {
  const f = fixture();
  assert.deepEqual(proveDecisionPrefix(f), { valid: true, emittedCount: 0 });
  const prefix = buildDecisionPrefix(f.events, f.completedRefs);
  assert.equal(prefix.length, 2);
  assert.equal(prefix[0].tool_calls[0].id, 'done');
  assert.equal(prefix[1].content, ' failed\n');
  assert.equal(prefix[1].is_error, true);
  assert.equal(prefix[1].error_code, 'CMP-TOOL-0001');
  assert.equal(prefix[1].tool_envelope.effects, 'none');
});
for (const mutation of ['result', 'sequence', 'projection', 'foreign', 'execution', 'missing_wait', 'duplicate']) {
  test(`decision proof rejects ${mutation} evidence`, () => {
    const f = fixture();
    if (mutation === 'result') f.events[0].payload.success = true;
    if (mutation === 'sequence') f.events[1].payload.canonical_seq = 0;
    if (mutation === 'projection') f.events[2].payload.input.path = 'other';
    if (mutation === 'foreign') f.events[0].event_id = 'other:canonical:1';
    if (mutation === 'execution') f.events.push({ ...f.events[1], event_id: 'stream:canonical:3', kind: 'tool_executing' });
    if (mutation === 'missing_wait') f.events.splice(1, 1);
    if (mutation === 'duplicate') f.events.push({ ...f.events[0], status: 'changed' });
    assert.throws(() => proveDecisionPrefix(f));
  });
}
test('successive pauses cannot reuse consent, replenish active time, or omit newly reserved calls', () => {
  const f = fixture();
  const previous = { completed_effect_refs: f.completedRefs, decision: f.decision,
    position: { tool_call_limit: 8, tool_calls_consumed: 2, current_iteration: 2,
      completed_iterations: 2, remaining_iterations: 4, active_budget_ms_remaining: 5000 } };
  const current = { ...structuredClone(previous), prior_effect_count: 1,
    decision: { ...f.decision, decision_id: 'decision_2' } };
  assert.doesNotThrow(() => assertDecisionProgress(previous, current, f.pendingCalls, f.pendingCalls));
  current.position.active_budget_ms_remaining++;
  assert.throws(() => assertDecisionProgress(previous, current, f.pendingCalls, f.pendingCalls));
  current.position.active_budget_ms_remaining--;
  assert.throws(() => assertDecisionProgress(previous, current, f.pendingCalls,
    [...f.pendingCalls, { call_id: 'new', tool_id: 'read_file', arguments: {} }]));
});

function completedApprovalFixture() {
  const f = fixture();
  const event = (kind, seq, payload) => ({ event_id: `stream:canonical:${seq}`, turn_id: 'turn',
    kind, event_seq: seq, tool_call_id: 'done', payload: { canonical_seq: seq, tool_name: 'list_dir', ...payload } });
  f.events[0].event_id = 'stream:canonical:6'; f.events[0].payload.canonical_seq = 6; f.events[0].event_seq = 6;
  f.events[1].payload.canonical_seq = 7;
  f.events.push(event('approval_requested', 3, { approval_state: 'pending' }),
    event('approval_resolved', 4, { approved: true, approval_state: 'approved' }),
    event('tool_executing', 5, { canonical_event_type: 'tool_execution_started',
      tool_input: { path: '.', _jenny_turn_id: 'turn', _jenny_tool_call_id: 'done' } }),
    { event_id: 'turn:tool_use:0:stream', turn_id: 'turn', kind: 'tool_use', status: 'pending_approval',
      tool_call_id: 'done', payload: { tool_name: 'list_dir', input: { path: '.' },
        parent_stream_id: 'stream', approval_id: 'approval_session_stream_done' } });
  f.events.sort((left, right) => (left.payload.canonical_seq || 100) - (right.payload.canonical_seq || 100));
  return f;
}
test('completed approval display history is retained with exact canonical execution evidence', () => {
  assert.deepEqual(proveDecisionPrefix(completedApprovalFixture()), { valid: true, emittedCount: 1 });
});
for (const mutation of ['approval_requested', 'approval_resolved', 'tool_executing', 'input', 'identity', 'sequence']) {
  test(`completed approval projection rejects changed ${mutation}`, () => {
    const f = completedApprovalFixture();
    if (['approval_requested', 'approval_resolved', 'tool_executing'].includes(mutation)) {
      f.events = f.events.filter(event => !(event.kind === mutation && event.tool_call_id === 'done'));
    } else if (mutation === 'input') f.events.at(-1).payload.input.path = 'other';
    else if (mutation === 'identity') f.events.at(-1).payload.approval_id = 'approval_other';
    else f.events.find(event => event.kind === 'tool_executing').payload.canonical_seq = 0;
    assert.throws(() => proveDecisionPrefix(f));
  });
}

for (const mutation of ['denied', 'resolved_state', 'requested_state', 'tool', 'duplicate', 'order']) {
  test(`completed approval audit rejects ${mutation}`, () => {
    const f = completedApprovalFixture();
    const requested = f.events.find(event => event.kind === 'approval_requested' && event.tool_call_id === 'done');
    const resolved = f.events.find(event => event.kind === 'approval_resolved');
    if (mutation === 'denied') resolved.payload.approved = false;
    if (mutation === 'resolved_state') resolved.payload.approval_state = 'denied';
    if (mutation === 'requested_state') requested.payload.approval_state = 'approved';
    if (mutation === 'tool') resolved.payload.tool_name = 'write_file';
    if (mutation === 'duplicate') f.events.push({ ...structuredClone(resolved), event_id: 'stream:duplicate' });
    if (mutation === 'order') { f.events.splice(f.events.indexOf(resolved), 1); f.events.push(resolved); }
    assert.throws(() => proveDecisionPrefix(f));
  });
}

function completedPlanExitFixture(approvalState) {
  const f = completedApprovalFixture();
  f.completedRefs[0].tool_id = 'exit_plan_mode';
  for (const event of f.events) {
    if (event.tool_call_id === 'done') event.payload.tool_name = 'exit_plan_mode';
  }
  f.events.find(event => event.kind === 'approval_resolved').payload.approval_state = approvalState;
  return f;
}
for (const approvalState of ['approved_auto', 'accepted', 'rejected']) {
  test(`a completed exit_plan_mode resolved ${approvalState} still proves a later pause`, () => {
    assert.deepEqual(proveDecisionPrefix(completedPlanExitFixture(approvalState)), { valid: true, emittedCount: 1 });
  });
}
test('plan decision states prove completion only for exit_plan_mode', () => {
  const f = completedApprovalFixture();
  f.events.find(event => event.kind === 'approval_resolved').payload.approval_state = 'rejected';
  assert.throws(() => proveDecisionPrefix(f));
});

test('completed approval uses application order across independent producer sequence origins', () => {
  const f = completedApprovalFixture();
  const unmutated = completedApprovalFixture();
  f.events.find(event => event.kind === 'approval_resolved').payload.canonical_seq = 1;
  assert.deepEqual(proveDecisionPrefix(f), { valid: true, emittedCount: 1 });
  assert.deepEqual(
    buildDecisionPrefix(f.events, f.completedRefs),
    buildDecisionPrefix(unmutated.events, unmutated.completedRefs),
  );
});
