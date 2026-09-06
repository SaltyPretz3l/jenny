const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createStreamReasoningPhaseStatusHandlers,
} = require('../renderer/chat/renderer-stream-handler-reasoning-phase-status');

function createHarness(overrides = {}) {
  const logs = [];
  const calls = [];
  const handlers = createStreamReasoningPhaseStatusHandlers({
    state: {
      streamThinkingStatusByStream: new Map(),
    },
    streamSegmentState: new Map([['stream-1', { segmentIndex: 0 }]]),
    setStreamThinkingStatus: (...args) => calls.push(['setStreamThinkingStatus', ...args]),
    syncThinkingIndicatorMode: (...args) => calls.push(['syncThinkingIndicatorMode', ...args]),
    markHiddenRenderableEvent: (...args) => calls.push(['markHiddenRenderableEvent', ...args]),
    isVisibleChatSession: () => true,
    applyLiveTurnPayload: (...args) => {
      calls.push(['applyLiveTurnPayload', ...args]);
      return null;
    },
    buildAssistantShellMessageId: () => 'assistant-stream-1',
    updateStreamPhaseState: (...args) => {
      calls.push(['updateStreamPhaseState', ...args]);
      return [];
    },
    syncPendingMessagePhaseState: (...args) => calls.push(['syncPendingMessagePhaseState', ...args]),
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
    ...overrides,
  });
  return { handlers, logs, calls };
}

test('thinking status logs render-entry failures without rejecting the stream payload', async () => {
  const harness = createHarness({
    ensureRenderableReasoningStreamEntry: () => {
      throw new Error('template failed');
    },
  });

  const result = await harness.handlers.handleThinkingStatus({
    type: 'thinking_status',
    sessionId: 'session-1',
    streamId: 'stream-1',
    text: 'Reading context',
    thinkingId: 'thinking-1',
  });

  assert.deepEqual(result, { buffered: false, terminal: false });
  assert.ok(harness.calls.some((call) => call[0] === 'setStreamThinkingStatus'));
  assert.equal(harness.logs.length, 1);
  assert.equal(harness.logs[0].level, 'ERROR');
  assert.equal(harness.logs[0].event, 'stream.reasoning_phase_handler_failed');
  assert.equal(harness.logs[0].details.operation, 'ensure_renderable_reasoning_entry');
});

test('phase events log queueRender failures without rejecting the stream payload', async () => {
  const harness = createHarness({
    ensureRenderableReasoningStreamEntry: () => 0,
    queueRender: () => {
      throw new Error('render queue closed');
    },
  });

  const result = await harness.handlers.handlePhaseStarted({
    type: 'phase_started',
    sessionId: 'session-1',
    streamId: 'stream-1',
    phaseKind: 'reasoning',
  });

  assert.deepEqual(result, { buffered: false, terminal: false });
  assert.ok(harness.calls.some((call) => call[0] === 'applyLiveTurnPayload'));
  assert.ok(harness.logs.some((entry) => (
    entry.level === 'ERROR'
    && entry.event === 'stream.reasoning_phase_handler_failed'
    && entry.details.operation === 'queue_render'
  )));
});
