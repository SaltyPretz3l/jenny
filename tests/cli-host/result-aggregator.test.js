'use strict';

// Jenny CLI S3: the result aggregator folds a run's cli.v1 events into the one final result frame,
// mapping the stop reason to a subtype and a frozen exit code.

const test = require('node:test');
const assert = require('node:assert/strict');

const { EXIT_CODES, createEventProjector, validateCliEvent } = require('../../services/cli-host/event-projection');
const { ENGINE_UNAVAILABLE_CODES, createResultAggregator } = require('../../services/cli-host/result-aggregator');
const { AI_ERROR_CODES, TOOL_ERROR_CODES } = require('../../services/backend/error-codes');
const { CLI_PROFILE_ERROR_CODES } = require('../../services/cli-host/profile-lock');

const BASE = { sessionId: 'sess_1', streamId: 'stream_a', turnId: 'turn_a' };

function harness() {
  const p = createEventProjector({ run_id: 'run_1', session_id: 'sess_1' });
  const aggregator = createResultAggregator({ run_id: 'run_1', session_id: 'sess_1', started_at_ms: 1000 });
  const desktop = (event) => { const out = p.project(event); if (out) aggregator.observe(out); return out; };
  const host = (kind, payload) => { const out = p.next(kind, payload); aggregator.observe(out); return out; };
  const finish = (args) => {
    const payload = aggregator.finish({ now_ms: 1500, ...args });
    const event = p.next('result', payload);
    assert.deepEqual(validateCliEvent(event), { ok: true });
    return payload;
  };
  return { desktop, host, finish, aggregator };
}

test('every finish reason maps to its subtype and exit code', () => {
  const cases = [
    [{ reason: 'complete' }, 'success', EXIT_CODES.OK],
    [{ reason: 'denied' }, 'denied', EXIT_CODES.POLICY_DENIED],
    [{ reason: 'input_required' }, 'input_required', EXIT_CODES.DECISION_REQUIRED],
    [{ reason: 'budget' }, 'budget', EXIT_CODES.BUDGET],
    [{ reason: 'timeout' }, 'budget', EXIT_CODES.BUDGET],
    [{ reason: 'cancelled', signal: 'SIGINT' }, 'cancelled', EXIT_CODES.SIGINT],
    [{ reason: 'cancelled', signal: 'SIGTERM' }, 'cancelled', EXIT_CODES.SIGTERM],
    [{ reason: 'error' }, 'error', EXIT_CODES.RUNTIME_ERROR],
  ];
  for (const [args, subtype, exitCode] of cases) {
    const result = harness().finish(args);
    assert.equal(result.subtype, subtype, args.reason);
    assert.equal(result.exit_code, exitCode, args.reason);
    assert.equal(result.is_error, exitCode !== 0, args.reason);
    assert.equal(result.duration_ms, 500);
  }
});

test('an error exit code follows the first error: engine or profile unavailable is 6, profile busy is 75', () => {
  const withError = (code) => {
    const h = harness();
    h.desktop({ type: 'started', ...BASE });
    h.desktop({ type: 'error', ...BASE, error_code: code, retryable: true });
    h.desktop({ type: 'error', ...BASE, error_code: 'CMP-LOOP-0001' });
    return h.finish({ reason: 'error' });
  };
  assert.equal(withError(AI_ERROR_CODES.ENGINE_CONNECTION).exit_code, EXIT_CODES.ENGINE_UNAVAILABLE);
  assert.equal(withError(CLI_PROFILE_ERROR_CODES.LOCK_UNAVAILABLE).exit_code, EXIT_CODES.ENGINE_UNAVAILABLE);
  assert.equal(withError(CLI_PROFILE_ERROR_CODES.BUSY).exit_code, EXIT_CODES.PROFILE_BUSY);
  const generic = withError(TOOL_ERROR_CODES.EXECUTION_FAILED);
  assert.equal(generic.exit_code, EXIT_CODES.RUNTIME_ERROR);
  assert.equal(generic.error_code, TOOL_ERROR_CODES.EXECUTION_FAILED);
  assert.ok(Object.isFrozen(ENGINE_UNAVAILABLE_CODES));
  assert.ok(!ENGINE_UNAVAILABLE_CODES.includes(CLI_PROFILE_ERROR_CODES.BUSY));
});

test('deny decisions are recorded as permission denials; allows are not', () => {
  const h = harness();
  h.desktop({ type: 'started', ...BASE });
  h.host('decision', { ref: 'ap_1', request: 'tool_approval', outcome: 'allow', by: 'user', tool_name: 'read_file' });
  h.host('decision', { ref: 'ap_2', request: 'tool_approval', outcome: 'deny', by: 'policy', rule: 'disallowed_tools',
    call_id: 'c2', tool_name: 'run_command' });
  h.host('decision', { ref: 'plan_1', request: 'plan_proposal', outcome: 'deny', by: 'caller' });
  const result = h.finish({ reason: 'denied' });
  assert.deepEqual(result.permission_denials, [
    { ref: 'ap_2', request: 'tool_approval', by: 'policy', rule: 'disallowed_tools', call_id: 'c2', tool_name: 'run_command' },
    { ref: 'plan_1', request: 'plan_proposal', by: 'caller' },
  ]);
});

test('a tool the stored policy denied outright counts as a denial once, and a plan nobody could accept is the result', () => {
  const h = harness();
  h.desktop({ type: 'started', ...BASE });
  // Denied by policy without an approval: the tool result is the only trace.
  const denied = h.desktop({ type: 'tool_result', callId: 'c1', toolName: 'run_command', isError: true, approvalState: 'denied',
    content: 'Tool "run_command" is denied by permission policy.', errorCode: TOOL_ERROR_CODES.POLICY_DENIED, ...BASE });
  assert.equal(denied.payload.status, 'denied');
  // Denied through the decider: the decision frame already recorded it.
  h.host('decision', { ref: 'ap_2', request: 'tool_approval', outcome: 'deny', by: 'policy', rule: 'not_pre_allowed', call_id: 'c2', tool_name: 'write_file' });
  h.desktop({ type: 'tool_result', callId: 'c2', toolName: 'write_file', isError: true, approvalState: 'denied', content: 'denied', ...BASE });
  // An ordinary failure is not a denial.
  h.desktop({ type: 'tool_result', callId: 'c3', toolName: 'read_file', isError: true, content: 'missing', ...BASE });
  const plan = h.desktop({ type: 'tool_approval_needed', approvalId: 'plan_1', callId: 'c4', toolName: 'exit_plan_mode',
    planDocument: { title: 'Rename the module', summary: 'Two steps.', steps: ['Move the file', 'Fix the imports'] }, ...BASE });
  assert.equal(plan.kind, 'plan_proposed');
  h.host('decision', { ref: 'plan_1', request: 'plan_proposal', outcome: 'deny', by: 'policy', rule: 'plan_requires_human', call_id: 'c4', tool_name: 'exit_plan_mode' });
  h.desktop({ type: 'complete', ...BASE });
  const result = h.finish({ reason: 'denied' });
  assert.deepEqual(result.permission_denials, [
    { ref: 'c1', request: 'tool_approval', by: 'policy', rule: 'policy_denied', call_id: 'c1', tool_name: 'run_command' },
    { ref: 'ap_2', request: 'tool_approval', by: 'policy', rule: 'not_pre_allowed', call_id: 'c2', tool_name: 'write_file' },
    { ref: 'plan_1', request: 'plan_proposal', by: 'policy', rule: 'plan_requires_human', call_id: 'c4', tool_name: 'exit_plan_mode' },
  ]);
  assert.equal(result.result, 'Rename the module\n\nTwo steps.\n\n1. Move the file\n2. Fix the imports');

  // Spoken text wins over the plan.
  const spoken = harness();
  spoken.desktop({ type: 'started', ...BASE });
  spoken.desktop({ type: 'tool_approval_needed', approvalId: 'plan_2', callId: 'c5', toolName: 'exit_plan_mode', planDocument: { title: 'P', steps: [] }, ...BASE });
  spoken.desktop({ type: 'delta', content: 'Here is the plan.', ...BASE });
  assert.equal(spoken.finish({ reason: 'complete' }).result, 'Here is the plan.');
});

test('turns, usage and resumable stops accumulate across streams', () => {
  const h = harness();
  h.desktop({ type: 'started', ...BASE });
  h.desktop({ type: 'delta', ...BASE, content: 'one' });
  h.desktop({ type: 'complete', ...BASE, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } });
  const next = { ...BASE, streamId: 'stream_b', turnId: 'turn_b' };
  h.desktop({ type: 'started', ...next });
  h.desktop({ type: 'delta', ...next, content: 'two' });
  h.desktop({ type: 'complete', ...next, usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, estimated: true },
    resumableStop: 'tool_cap' });
  const result = h.finish({ reason: 'complete' });
  assert.equal(result.num_turns, 2);
  assert.equal(result.result, 'one\n\ntwo');
  assert.deepEqual(result.usage, { input_tokens: 15, output_tokens: 3, total_tokens: 18, estimated: true });
  assert.deepEqual(result.resumable_stop, { reason: 'tool_cap' });
});

test('caller usage and a caller resumable stop win over observed values', () => {
  const h = harness();
  const result = h.finish({ reason: 'budget', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    resumable_stop: { reason: 'runtime_budget', work_id: 'work_1' } });
  assert.deepEqual(result.usage, { input_tokens: 1, output_tokens: 1, total_tokens: 2 });
  assert.deepEqual(result.resumable_stop, { reason: 'runtime_budget', work_id: 'work_1' });
});

test('events for another run or session are ignored', () => {
  const aggregator = createResultAggregator({ run_id: 'run_1', session_id: 'sess_1', started_at_ms: 0 });
  aggregator.observe({ v: 1, kind: 'delta', event_seq: 0, run_id: 'run_2', session_id: 'sess_1', payload: { text: 'a' } });
  aggregator.observe({ v: 1, kind: 'delta', event_seq: 1, run_id: 'run_1', session_id: 'sess_2', payload: { text: 'b' } });
  aggregator.observe(null);
  assert.equal(aggregator.finish({ reason: 'complete', now_ms: 0 }).result, '');
});

test('finish is callable once and rejects unknown reasons or a missing signal without consuming the call', () => {
  const aggregator = createResultAggregator({ run_id: 'run_1', session_id: 'sess_1', started_at_ms: 0 });
  assert.throws(() => aggregator.finish({ reason: 'exploded', now_ms: 0 }), /reason/u);
  assert.throws(() => aggregator.finish({ reason: 'cancelled', now_ms: 0 }), /signal/u);
  assert.throws(() => aggregator.finish({ reason: 'complete', now_ms: Number.NaN }), /now_ms/u);
  aggregator.finish({ reason: 'complete', now_ms: 0 });
  assert.throws(() => aggregator.finish({ reason: 'complete', now_ms: 0 }), /once/u);
});
