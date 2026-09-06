'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  drainPendingApprovalWaiters,
  planTerminalToolRepairs,
} = require('../services/backend/chat-terminal-tool-repair-planner');

function toolUse(overrides = {}) {
  return {
    id: 'tool_use_1',
    role: 'assistant',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call_1',
      tool_name: 'shell',
      parent_stream_id: 'stream_1',
      status: 'running',
      approval_state: 'auto',
      ...overrides,
    },
  };
}

test('terminal tool repair planning is pure and terminalizes running and pending rows', () => {
  const messages = [
    toolUse(),
    {
      ...toolUse({ call_id: 'call_2', status: 'pending_approval', approval_state: 'pending' }),
      id: 'tool_use_2',
    },
  ];
  const before = structuredClone(messages);
  const result = planTerminalToolRepairs(messages, 'stream_1', {
    model: 'local-model',
    terminalState: 'cancelled',
  });
  assert.equal(result.ok, true);
  assert.equal(result.repairs.length, 2);
  assert.equal(result.repairs[0].patch.tool_call.status, 'cancelled');
  assert.equal(result.repairs[1].patch.tool_call.approval_state, 'cancelled');
  assert.deepEqual(messages, before);
});

test('terminal tool repair planning fails closed on malformed or ambiguous active rows', () => {
  assert.equal(planTerminalToolRepairs([
    toolUse({ call_id: '' }),
  ], 'stream_1').reason, 'malformed_nonterminal_tool_row');
  assert.equal(planTerminalToolRepairs([
    toolUse(),
    { ...toolUse(), id: 'tool_use_2' },
  ], 'stream_1').reason, 'ambiguous_nonterminal_tool_row');
});

test('terminal tool repair planning preserves an authoritative existing tool result', () => {
  const result = planTerminalToolRepairs([
    toolUse(),
    {
      id: 'tool_result_1',
      role: 'tool',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_1',
        parent_stream_id: 'stream_1',
        output_text: 'authoritative output',
      },
    },
  ], 'stream_1', { terminalState: 'complete' });
  assert.equal(result.ok, true);
  assert.equal(result.repairs.length, 1);
  assert.equal(result.repairs[0].synthesizeResult, false);
  assert.equal(result.repairs[0].patch.tool_call.status, 'complete');
});

test('pending approval waiter drain is stream-scoped', () => {
  const resolved = [];
  const service = {
    pendingToolApprovals: new Map([
      ['call_1', { streamId: 'stream_1', resolve: (...args) => resolved.push(args) }],
      ['call_2', { streamId: 'stream_2', resolve: (...args) => resolved.push(args) }],
    ]),
  };
  assert.equal(drainPendingApprovalWaiters(service, 'stream_1', 'denied'), 1);
  assert.deepEqual(resolved, [[false, 'denied']]);
  assert.deepEqual([...service.pendingToolApprovals.keys()], ['call_2']);
});

test('pending approval waiter drain isolates a throwing waiter and logs the failure', () => {
  const resolved = [];
  const logs = [];
  const service = {
    pendingToolApprovals: new Map([
      ['call_bad', { streamId: 'stream_1', resolve: () => { throw new Error('poison'); } }],
      ['call_good', { streamId: 'stream_1', resolve: (...args) => resolved.push(args) }],
    ]),
    _emitServiceLog: (...args) => logs.push(args),
  };
  assert.equal(drainPendingApprovalWaiters(service, 'stream_1', 'cancelled'), 2);
  assert.deepEqual(resolved, [[false, 'cancelled']]);
  assert.equal(service.pendingToolApprovals.size, 0);
  assert.equal(logs[0][0], 'WARN');
  assert.equal(logs[0][1], 'lifecycle.approval_waiter_drain_failed');
});
