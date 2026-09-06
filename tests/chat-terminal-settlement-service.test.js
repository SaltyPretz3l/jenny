'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildTerminalEvents,
  settleTerminalMutation,
} = require('../services/backend/chat-terminal-settlement-service');

const identity = {
  sessionId: 'session_1',
  sessionIncarnation: 'inc_1',
  generation: 1,
  turnId: 'turn_1',
  streamId: 'stream_1',
  userMessageId: 'user_1',
};

test('terminal settlement builds finalized events from the repaired transcript preview', async () => {
  const captured = [];
  const store = {
    getSessionMessages: () => [{
      id: 'tool_use_1',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_1',
        tool_name: 'shell',
        status: 'running',
        parent_stream_id: 'stream_1',
      },
    }],
    commitTerminal() {},
  };
  let flushed = 0;
  const collector = {
    flushJournalEvents() { flushed += 1; },
    buildFinalizedTurnEvents(turnId, messages) {
      assert.equal(turnId, 'turn_1');
      assert.equal(messages.find((message) => message.id === 'tool_use_1').tool_call.status,
        'interrupted');
      assert.ok(messages.some((message) => message.kind === 'tool_result'));
      return [{ event_id: 'event_1', turn_id: turnId, kind: 'assistant_text' }];
    },
  };
  const service = {
    terminalCoordinator: {
      async settle(request) {
        captured.push(request);
        return { ok: true, durableTerminal: true };
      },
    },
  };
  const lease = { identity, store };
  const outcome = await settleTerminalMutation(service, {
    lease,
    rawStore: store,
    terminal: { kind: 'error', rendererPayload: { type: 'error' } },
    messages: [{ id: 'assistant_1', role: 'assistant', content: 'failed' }],
    toolRepairs: [{
      messageId: 'tool_use_1',
      callId: 'call_1',
      patch: { tool_call: { call_id: 'call_1', status: 'interrupted' } },
    }],
    turnEventCollector: collector,
  });
  assert.equal(outcome.handled, true);
  assert.equal(flushed, 1);
  assert.deepEqual(captured[0].turnEvents, [{
    event_id: 'event_1', turn_id: 'turn_1', kind: 'assistant_text',
  }]);
});

test('terminal event preparation refuses a repair that does not match exactly', () => {
  const result = buildTerminalEvents({
    collector: null,
    identity,
    currentMessages: [],
    messages: [],
    toolRepairs: [{
      messageId: 'missing',
      callId: 'call_1',
      patch: { tool_call: { call_id: 'call_1', status: 'interrupted' } },
    }],
    timestamp: '2026-07-14T12:00:00.000Z',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'terminal_preview_repair_not_exact');
});

test('tool-repair preflight refusal routes through visible durable repair ownership', async () => {
  const captured = [];
  const store = {
    getSessionMessages: () => [{
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_bad',
        status: 'running',
        parent_stream_id: identity.streamId,
      },
    }],
    commitTerminal() {},
  };
  const service = {
    _emitServiceLog() {},
    terminalCoordinator: {
      async settle() {
        throw new Error('preflight refusal must not reach terminal commit');
      },
      async settlePreparationRefusal(request, reason, options) {
        captured.push({ request, reason, options });
        return {
          ok: false,
          visibleTerminal: true,
          durableTerminal: false,
          reason,
          persistedMessageIds: [],
          repairDurable: true,
          artifactId: 'repair_preflight',
        };
      },
    },
  };

  const outcome = await settleTerminalMutation(service, {
    lease: { identity, store },
    rawStore: store,
    terminal: { kind: 'error', rendererPayload: { type: 'error' } },
    messages: [],
  });

  assert.equal(outcome.handled, true);
  assert.equal(outcome.result.visibleTerminal, true);
  assert.equal(outcome.result.repairDurable, true);
  assert.equal(captured[0].reason, 'malformed_nonterminal_tool_row');
  assert.equal(captured[0].options.requiresToolReplan, true);
});
