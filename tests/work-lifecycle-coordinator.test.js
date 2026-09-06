'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAgentStatusEvent,
  normalizeAgentProgressNotification,
  agentExecutorLifecycleEnabled,
  isAgentStatusSurfaceEnabled,
  coordinateWorkLifecycle,
  mirrorAgentStatusToActiveTurn,
} = require('../services/backend/work-lifecycle-coordinator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput(overrides = {}) {
  return {
    streamId: 'stream-1',
    sessionId: 'sess-1',
    requestId: 'req-1',
    taskId: 'task-1',
    taskType: 'coder',
    status: 'running',
    percent: 50,
    ...overrides,
  };
}

// Minimal adapter that satisfies touchActiveTurnProgress's adapter contract.
// Records every touchActiveTurn call so assertions can verify delegation.
function makeAdapter(touchActiveTurnCalls) {
  return {
    getActiveTurn: () => null,
    peekActiveTurn: () => null,
    touchActiveTurn: (...args) => {
      touchActiveTurnCalls.push(args);
      return { status: 'streaming' };
    },
  };
}

// ---------------------------------------------------------------------------
// normalizeAgentStatusEvent – full valid input
// ---------------------------------------------------------------------------

test('normalizeAgentStatusEvent returns type===agent_status and all normalized fields for full valid input', () => {
  const result = normalizeAgentStatusEvent(validInput());
  assert.equal(result.type, 'agent_status');
  assert.equal(result.streamId, 'stream-1');
  assert.equal(result.sessionId, 'sess-1');
  assert.equal(result.requestId, 'req-1');
  assert.equal(result.taskId, 'task-1');
  assert.equal(result.taskType, 'coder');
  assert.equal(result.status, 'running');
  assert.equal(result.percent, 50);
});

// ---------------------------------------------------------------------------
// Required-field gating: missing any one field -> null
// ---------------------------------------------------------------------------

test('normalizeAgentStatusEvent returns null when streamId is absent', () => {
  const input = validInput();
  delete input.streamId;
  // Without streamId the streamId field cannot be derived from requestId either
  // (requestId is still present, but streamId falls through to requestId
  //  derivation – let's also remove requestId to force a true missing-streamId case).
  delete input.requestId;
  assert.equal(normalizeAgentStatusEvent(input), null);
});

test('normalizeAgentStatusEvent returns null when sessionId is absent', () => {
  const input = validInput();
  delete input.sessionId;
  assert.equal(normalizeAgentStatusEvent(input), null);
});

test('normalizeAgentStatusEvent returns null when taskId is absent', () => {
  const input = validInput();
  delete input.taskId;
  assert.equal(normalizeAgentStatusEvent(input), null);
});

test('normalizeAgentStatusEvent returns null when taskType is absent', () => {
  const input = validInput();
  delete input.taskType;
  assert.equal(normalizeAgentStatusEvent(input), null);
});

// ---------------------------------------------------------------------------
// percent clamping
// ---------------------------------------------------------------------------

test('normalizeAgentStatusEvent clamps percent:150 to 100', () => {
  const result = normalizeAgentStatusEvent(validInput({ percent: 150 }));
  assert.equal(result.percent, 100);
});

test('normalizeAgentStatusEvent clamps percent:-5 to 0', () => {
  const result = normalizeAgentStatusEvent(validInput({ percent: -5 }));
  assert.equal(result.percent, 0);
});

test('normalizeAgentStatusEvent coerces non-numeric percent "x" to 0', () => {
  const result = normalizeAgentStatusEvent(validInput({ percent: 'x' }));
  assert.equal(result.percent, 0);
});

// ---------------------------------------------------------------------------
// status normalization and defaulting
// ---------------------------------------------------------------------------

test('normalizeAgentStatusEvent lowercases status', () => {
  const result = normalizeAgentStatusEvent(validInput({ status: 'RUNNING' }));
  assert.equal(result.status, 'running');
});

test('normalizeAgentStatusEvent defaults empty status to "running"', () => {
  const result = normalizeAgentStatusEvent(validInput({ status: '' }));
  assert.equal(result.status, 'running');
});

// ---------------------------------------------------------------------------
// terminal / success derivation
// ---------------------------------------------------------------------------

test('status "completed" -> terminal:true, success:true', () => {
  const result = normalizeAgentStatusEvent(validInput({ status: 'completed' }));
  assert.equal(result.terminal, true);
  assert.equal(result.success, true);
});

test('status "running" -> terminal:false, success:false', () => {
  const result = normalizeAgentStatusEvent(validInput({ status: 'running' }));
  assert.equal(result.terminal, false);
  assert.equal(result.success, false);
});

test('explicit terminal:false overrides a terminal status', () => {
  const result = normalizeAgentStatusEvent(validInput({ status: 'completed', terminal: false }));
  assert.equal(result.terminal, false);
});

test('explicit success:true overrides non-success derivation', () => {
  const result = normalizeAgentStatusEvent(validInput({ status: 'failed', success: true }));
  assert.equal(result.success, true);
});

// ---------------------------------------------------------------------------
// summary fallback and terminalSubcode
// ---------------------------------------------------------------------------

test('no summary/message -> event.summary is "Agent is " + status + "."', () => {
  const result = normalizeAgentStatusEvent(validInput({ status: 'running' }));
  assert.equal(result.summary, 'Agent is running.');
});

test('no summary/message with status "completed" -> "Agent is completed."', () => {
  const result = normalizeAgentStatusEvent(validInput({ status: 'completed' }));
  assert.equal(result.summary, 'Agent is completed.');
});

test('provided summary wins over fallback', () => {
  const result = normalizeAgentStatusEvent(validInput({ summary: 'Doing work' }));
  assert.equal(result.summary, 'Doing work');
});

test('terminalSubcode is included on the event when provided', () => {
  const result = normalizeAgentStatusEvent(validInput({ terminalSubcode: 'timeout' }));
  assert.equal(result.terminalSubcode, 'timeout');
});

test('terminalSubcode is absent from the event when not provided', () => {
  const result = normalizeAgentStatusEvent(validInput());
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'terminalSubcode'), false);
});

// ---------------------------------------------------------------------------
// requestId falls back to streamId when requestId absent
// ---------------------------------------------------------------------------

test('requestId falls back to streamId when request_id is absent', () => {
  // Build input without requestId so the fallback path activates.
  // streamId must still be present for the event to pass the null-guard.
  const result = normalizeAgentStatusEvent({
    streamId: 'stream-fallback',
    sessionId: 'sess-1',
    // no requestId / request_id
    taskId: 'task-1',
    taskType: 'coder',
  });
  assert.notEqual(result, null);
  assert.equal(result.requestId, 'stream-fallback');
});

// ---------------------------------------------------------------------------
// normalizeAgentProgressNotification
// ---------------------------------------------------------------------------

test('normalizeAgentProgressNotification maps snake_case params correctly', () => {
  const params = {
    request_id: 'r',
    session_id: 's',
    task_id: 't',
    task_type: 'tt',
    agent_id: 'research@r:call:1',
    parent_agent_id: 'main@r',
    status: 'COMPLETED',
    percent: 50,
  };
  const ctx = { streamId: '', sessionId: '', requestId: '' };
  const event = normalizeAgentProgressNotification(params, ctx);
  assert.notEqual(event, null);
  assert.equal(event.requestId, 'r');
  assert.equal(event.status, 'completed');
  assert.equal(event.terminal, true);
  assert.equal(event.percent, 50);
  assert.equal(event.agentId, 'research@r:call:1');
  assert.equal(event.parentAgentId, 'main@r');
});

test('normalizeAgentProgressNotification preserves bounded subagent monitor telemetry', () => {
  const event = normalizeAgentProgressNotification({
    request_id: 'r', session_id: 's', task_id: 'batch-1', task_type: 'sub_agent',
    source: 'subagent_batch', status: 'completed', terminal: true,
    tool_call_id: 'call-1', child_task_id: 'child-1', child_agent_id: 'research@r:call:1',
    child_ordinal: 1, child_count: 2, child_label: 'Inspect persistence',
    child_terminal: true, child_success: true, provider: 'ollama', model: 'qwen3.5',
    usage: { input_tokens: 100, output_tokens: 25, total_tokens: 125, raw_usage: { prompt: 'drop' } },
    terminal_reason: 'budget_exhausted',
  }, { streamId: 'stream-1', sessionId: 's', requestId: 'r' });

  assert.equal(event.toolCallId, 'call-1');
  assert.equal(event.childTaskId, 'child-1');
  assert.equal(event.childOrdinal, 1);
  assert.equal(event.childCount, 2);
  assert.equal(event.childLabel, 'Inspect persistence');
  assert.equal(event.childTerminal, true);
  assert.equal(event.model, 'qwen3.5');
  assert.deepEqual(event.usage, {
    input_tokens: 100, output_tokens: 25, total_tokens: 125, estimated: false,
  });
  assert.equal(event.terminalReason, 'budget_exhausted');
});

// ---------------------------------------------------------------------------
// agentExecutorLifecycleEnabled / isAgentStatusSurfaceEnabled
// ---------------------------------------------------------------------------

test('agentExecutorLifecycleEnabled returns true when featureFlags.agent_executor===true', () => {
  assert.equal(agentExecutorLifecycleEnabled({ featureFlags: { agent_executor: true } }), true);
});

test('agentExecutorLifecycleEnabled returns false when featureFlags is empty', () => {
  assert.equal(agentExecutorLifecycleEnabled({ featureFlags: {} }), false);
});

test('agentExecutorLifecycleEnabled returns false when service is undefined', () => {
  assert.equal(agentExecutorLifecycleEnabled(undefined), false);
});

test('isAgentStatusSurfaceEnabled returns true when featureFlags.agent_executor===true', () => {
  assert.equal(isAgentStatusSurfaceEnabled({ featureFlags: { agent_executor: true } }), true);
});

test('isAgentStatusSurfaceEnabled returns false when featureFlags is empty', () => {
  assert.equal(isAgentStatusSurfaceEnabled({ featureFlags: {} }), false);
});

// ---------------------------------------------------------------------------
// coordinateWorkLifecycle
// ---------------------------------------------------------------------------

test('coordinateWorkLifecycle returns null when event is null', () => {
  const service = { featureFlags: { agent_executor: true } };
  const calls = [];
  const adapter = makeAdapter(calls);
  assert.equal(coordinateWorkLifecycle(service, adapter, null), null);
});

test('coordinateWorkLifecycle returns null when flag is OFF even with a valid event', () => {
  const service = { featureFlags: {} };
  const calls = [];
  const adapter = makeAdapter(calls);
  const event = normalizeAgentStatusEvent(validInput());
  assert.notEqual(event, null);
  assert.equal(coordinateWorkLifecycle(service, adapter, event), null);
});

test('coordinateWorkLifecycle returns the same event object when flag is ON', () => {
  const service = { featureFlags: { agent_executor: true } };
  const calls = [];
  const adapter = makeAdapter(calls);
  const event = normalizeAgentStatusEvent(validInput());
  assert.notEqual(event, null);
  const result = coordinateWorkLifecycle(service, adapter, event);
  assert.equal(result, event);
});

test('coordinateWorkLifecycle with flag ON invokes touchActiveTurn on the adapter', () => {
  const service = { featureFlags: { agent_executor: true } };
  const calls = [];
  const adapter = makeAdapter(calls);
  const event = normalizeAgentStatusEvent(validInput());
  coordinateWorkLifecycle(service, adapter, event);
  assert.equal(calls.length, 1, 'coordinateWorkLifecycle invokes touchActiveTurn exactly once');
});

// ---------------------------------------------------------------------------
// mirrorAgentStatusToActiveTurn null-guard
// ---------------------------------------------------------------------------

test('mirrorAgentStatusToActiveTurn returns null when adapter is null', () => {
  const event = normalizeAgentStatusEvent(validInput());
  assert.equal(mirrorAgentStatusToActiveTurn(null, event), null);
});

test('mirrorAgentStatusToActiveTurn returns null when event is null', () => {
  const calls = [];
  const adapter = makeAdapter(calls);
  assert.equal(mirrorAgentStatusToActiveTurn(adapter, null), null);
});

test('mirrorAgentStatusToActiveTurn invokes adapter.touchActiveTurn when both args are present', () => {
  const calls = [];
  const adapter = makeAdapter(calls);
  const event = normalizeAgentStatusEvent(validInput());
  mirrorAgentStatusToActiveTurn(adapter, event);
  assert.equal(calls.length, 1);
  // The first positional arg to touchActiveTurn is the id object
  const idArg = calls[0][0];
  assert.equal(idArg.request_id, 'req-1');
  assert.equal(idArg.stream_id, 'stream-1');
});
