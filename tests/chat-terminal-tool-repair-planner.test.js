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

test('a user Stop plans its running tools as cancelled and repairs them as stopped (F3)', () => {
  const { settleUnfinishedToolRows } = require('../services/backend/chat-stream-managed-runtime-failure');
  const {
    buildInterruptedToolRepairPlan, normalizeTerminalMutations,
  } = require('../services/backend/chat-stream-terminal-tool-repairs');
  const { statusForToolResult } = require('../renderer/chat/tool-call-utils');
  function plan(isUserStop) {
    const ctx = {
      latestToolContext: {},
      unfinishedToolsSettled: false,
      isUserStop: () => isUserStop,
      service: {
        sessionStore: { getSessionMessages: () => [toolUse()] },
        terminalCoordinator: { settle() {} },
      },
      resolvedSessionId: 'session_1',
      streamId: 'stream_1',
      model: 'test-model',
      diagnosticToolNamesByCallId: new Map(),
      diagnosticToolEvents: [],
      transcriptCollector: { noteToolStep() {} },
    };
    assert.equal(settleUnfinishedToolRows(ctx, 'terminal_cancelled'), 1);
    const [repair] = ctx.unfinishedToolRepairs;
    const identity = { streamId: 'stream_1', turnId: 'turn_1' };
    const normalized = normalizeTerminalMutations([], [repair], identity, 'now');
    assert.equal(normalized.ok, true);
    return { repair, built: buildInterruptedToolRepairPlan(repair, identity, 'now'), persisted: normalized.repairTurnEvents[0] };
  }

  const stopped = plan(true);
  assert.equal(stopped.repair.patch.tool_call.status, 'cancelled');
  assert.equal(stopped.built.resultMessage.content, 'Tool execution stopped by the user before it finished.');
  assert.equal(stopped.built.resultMessage.tool_result.approval_state, 'cancelled');
  // The event that is persisted (and that trace mode's result row reads).
  assert.equal(stopped.persisted.status, 'cancelled');
  assert.equal(statusForToolResult(stopped.persisted.payload), 'cancelled');
  assert.equal(statusForToolResult(stopped.built.resultMessage.tool_result), 'cancelled');

  const failed = plan(false);
  assert.equal(failed.repair.patch.tool_call.status, 'interrupted');
  assert.match(failed.built.resultMessage.content, /^System error: tool execution interrupted/);
  assert.equal(failed.persisted.status, 'error');
});
