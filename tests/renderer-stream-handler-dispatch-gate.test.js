// Audit finding A1 (owner audit of waves 1-5) acceptance pin: the dispatch
// terminal-absorbing gate must treat a SETTLED stream as dead even when it was
// never FINALIZED. Dispatch marks a terminal settled just before routing it;
// the handler may throw before it reaches finalizeTerminalStream (which is
// what marks the stream finalized), leaving the stream settled-but-unfinalized.
// A duplicate terminal for such a stream must absorb at the gate — pre-fix it
// re-invoked the throwing handler. The one-shot preempt allowance (finalized
// with no terminal ever dispatched) and the message_updated passthrough are
// green-pinned alongside.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createStreamDispatchRouter } = require('../renderer/chat/renderer-stream-handler-dispatch');
const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');
const { createHarness } = require('./helpers/renderer-stream-handler-harness');

function buildRouterHarness({
  throwOnComplete = false,
  throwOnQuestionBatch = false,
  degradation = null,
  shouldBufferStreamEvent = null,
} = {}) {
  const controller = createMultiStreamController({ getState: () => ({}) });
  const logs = [];
  const invocations = [];
  const buffered = [];
  const record = (name) => async (payload) => {
    invocations.push({ name, streamId: String(payload?.streamId || '') });
    if (name === 'handleComplete' && throwOnComplete) {
      throw new Error('terminal handler exploded before finalize');
    }
    if (name === 'handleQuestionBatch' && throwOnQuestionBatch) {
      throw new Error('question terminal handler exploded before commit');
    }
    return {
      buffered: false,
      terminal: name === 'handleComplete' || name === 'handleError',
      degraded: name === 'handleBufferDegraded',
    };
  };
  const handlers = {
    handleBufferDegraded: record('handleBufferDegraded'),
    handleStarted: record('handleStarted'),
    handleThinkingStatus: record('handleThinkingStatus'),
    handlePhaseStarted: record('handlePhaseStarted'),
    handlePhaseCompleted: record('handlePhaseCompleted'),
    handleAgentStatus: record('handleAgentStatus'),
    handleToolUse: record('handleToolUse'),
    handleApprovalNeeded: record('handleApprovalNeeded'),
    handleToolResult: record('handleToolResult'),
    handleStreamReset: record('handleStreamReset'),
    handleContextCompacted: record('handleContextCompacted'),
    handleContextUsage: record('handleContextUsage'),
    handleDelta: record('handleDelta'),
    handleQuestionBatch: record('handleQuestionBatch'),
    handleMessageUpdated: record('handleMessageUpdated'),
    handleComplete: record('handleComplete'),
    handleError: record('handleError'),
  };
  const router = createStreamDispatchRouter({
    state: { bufferedStreamEventsByStream: new Map() },
    normalizeId: (value) => String(value || '').trim(),
    normalizeString: (value) => String(value || '').trim(),
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
    handlers,
    consumeBufferedStreamDegradation: () => {
      const marker = degradation;
      degradation = null;
      return marker;
    },
    isRenderableBufferedStreamEvent: () => false,
    waitForRenderFrame: async () => {},
    ...(typeof shouldBufferStreamEvent === 'function'
      ? { shouldBufferStreamEvent, bufferStreamEvent: (payload) => buffered.push(payload) }
      : {}),
    isStreamFinalized: (streamId) => controller.isStreamFinalized(streamId),
    isStreamTerminalSettled: (streamId) => controller.isStreamTerminalSettled(streamId),
    markStreamTerminalSettled: (streamId) => controller.markStreamTerminalSettled(streamId),
    getStreamTerminalCommitState: (streamId, sessionId) => controller.getStreamTerminalCommitState(streamId, sessionId),
    beginStreamTerminalCommit: (streamId, sessionId) => controller.beginStreamTerminalCommit(streamId, sessionId),
    finishStreamTerminalCommit: (streamId, committed, sessionId) => controller.finishStreamTerminalCommit(streamId, committed, sessionId),
    isStreamCurrentForSession: (sessionId, streamId) => controller.isStreamCurrentForSession(sessionId, streamId),
  });
  const invocationsOf = (name) => invocations.filter((entry) => entry.name === name);
  const droppedLogs = () => logs.filter((entry) => entry.event === 'stream.late_event_dropped_terminal');
  return { router, controller, handlers, invocations, invocationsOf, logs, droppedLogs, buffered };
}

test('degraded buffered streams hydrate instead of replaying a partial suffix', async () => {
  const harness = buildRouterHarness({
    degradation: {
      type: 'buffer_degraded', streamId: 'stream-degraded', sessionId: 'session-1', reason: 'event_cap',
    },
  });
  const result = await harness.router.flushBufferedStreamEvents('stream-degraded');
  assert.equal(result.degraded, true);
  assert.equal(result.flushedCount, 0);
  assert.equal(harness.invocationsOf('handleBufferDegraded').length, 1);
  assert.equal(harness.invocationsOf('handleDelta').length, 0);
});

test('degraded recovery replays preserved terminal disposition through normal dispatch', async () => {
  for (const [type, handlerName] of [['complete', 'handleComplete'], ['error', 'handleError'], ['cancelled', 'handleError']]) {
    const harness = buildRouterHarness({ degradation: {
      type: 'buffer_degraded', streamId: `stream-${type}`, sessionId: 'session-1',
      terminalPayload: { type, streamId: `stream-${type}`, sessionId: 'session-1' },
    } });
    const result = await harness.router.flushBufferedStreamEvents(`stream-${type}`);
    assert.deepEqual(harness.invocations.map(({ name }) => name), ['handleBufferDegraded', handlerName], type);
    assert.equal(result.terminal, true, type);
    assert.equal(result.degraded, true, type);
  }
});

test('fully stale buffered stream preserves terminal disposition through canonical recovery', async (t) => {
  const streamId = 'stream-terminal-recovery';
  const canonical = { id: 'assistant_terminal', role: 'assistant', content: 'finished', status: 'complete', streamId };
  const logs = [];
  const harness = createHarness({ callbackOverrides: {
    appendClientLog(level, event, details) { logs.push({ level, event, details }); },
  }, stateOverrides: {
    sessions: [{ id: 'session-1' }], messagesBySession: new Map([['session-1', []]]),
    window: { jennyShell: { sessions: { getMessages: async () => ({ data: [canonical] }) } } }, } });
  t.after(() => harness.restore());
  harness.multiStreamController.registerPreflight('session-bg', { pending: true, sessionId: 'session-bg', streamId });
  await harness.emit({ type: 'started', sessionId: 'session-bg', streamId });
  await harness.emit({ type: 'complete', sessionId: 'session-bg', streamId, content: 'finished' });
  harness.state.bufferedStreamEventsByStream.get(streamId)
    .forEach((event) => { event._bufferedAt = Date.now() - 61_000; });
  harness.state.pendingStreams.set(streamId, canonical);
  harness.multiStreamController.registerStream('session-bg', streamId);
  harness.state.ui.chatSendLifecycleBySession.set('session-bg', 'streaming');
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-terminal-trigger' });
  harness.state.messagesBySession.set('session-bg', []);
  const result = await harness.handler.flushBufferedStreamEvents(streamId);

  assert.equal(harness.state.messagesBySession.get('session-bg')[0]?.content, 'finished');
  assert.equal(result.degraded, true);
  assert.equal(harness.state.pendingStreams.has(streamId), false);
  assert.equal(harness.state.ui.chatSendLifecycleBySession.get('session-bg') || 'idle', 'idle');
  const degradationLog = logs.find(({ event }) => event === 'stream.buffer_degraded');
  assert.equal(degradationLog?.level, 'WARN');
  assert.equal(degradationLog?.details?.streamId, streamId);
  assert.equal(degradationLog?.details?.reason, 'buffer_expired');
  assert.equal(degradationLog?.details?.droppedEvents, 2);
  assert.equal(Number(degradationLog?.details?.droppedBytes) > 0, true);
});

test('an expired started event does not degrade a stream with fresh content', async (t) => {
  const streamId = 'stream-fresh-after-start';
  const harness = createHarness({ stateOverrides: {
    sessions: [{ id: 'session-1' }], messagesBySession: new Map([['session-1', []]]),
  } });
  t.after(() => harness.restore());
  harness.multiStreamController.registerPreflight('session-bg', { pending: true, sessionId: 'session-bg', streamId });
  await harness.emit({ type: 'started', sessionId: 'session-bg', streamId });
  await harness.emit({ type: 'delta', sessionId: 'session-bg', streamId, content: 'fresh', aggregate: 'fresh' });
  harness.state.bufferedStreamEventsByStream.get(streamId)[0]._bufferedAt = Date.now() - 61_000;
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-start-trigger' });
  harness.state.messagesBySession.set('session-bg', []);

  const result = await harness.handler.flushBufferedStreamEvents(streamId);
  assert.equal(harness.state.messagesBySession.get('session-bg')[0]?.content, 'fresh');
  assert.deepEqual(result, { flushedCount: 2, terminal: false, discardedCount: 0 });
});

test('unrecovered degraded marker survives expiry and rejects a new sparse tail', async (t) => {
  const harness = createHarness({ stateOverrides: {
    sessions: [{ id: 'session-1' }], messagesBySession: new Map([['session-1', []]]),
    window: { jennyShell: { sessions: { getMessages: async () => ({ data: [{ role: 'assistant', content: 'whole tail' }] }) } } }, } });
  t.after(() => harness.restore());
  harness.multiStreamController.registerPreflight('session-bg', { pending: true, sessionId: 'session-bg', streamId: 'stream-marker' });
  await harness.emit({ type: 'started', sessionId: 'session-bg', streamId: 'stream-marker' });
  const firstQueue = harness.state.bufferedStreamEventsByStream.get('stream-marker');
  firstQueue[0]._bufferedAt = Date.now() - 61_000;
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-marker-trigger-1' });
  harness.state.degradedBufferedStreamsByStream.get('stream-marker')._bufferedAt = Date.now() - 61_000;
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-marker-trigger-2' });
  await harness.emit({ type: 'delta', sessionId: 'session-bg', streamId: 'stream-marker', content: 'tail', aggregateLength: 10 });
  harness.state.messagesBySession.set('session-bg', []);
  const result = await harness.handler.flushBufferedStreamEvents('stream-marker');

  assert.equal(harness.state.messagesBySession.get('session-bg')[0]?.content, 'whole tail');
  assert.equal(result.degraded, true);
});

test('a duplicate complete after a throwing terminal handler retries the repairable commit', async () => {
  const harness = buildRouterHarness({ throwOnComplete: true });

  const first = await harness.router.handleStreamPayload({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-throw', content: 'answer',
  });
  assert.equal(harness.invocationsOf('handleComplete').length, 1, 'the first terminal reaches its handler');
  assert.equal(first.terminal, true, 'a throwing terminal handler still reports terminal:true (W3.8)');
  assert.equal(
    harness.controller.isStreamFinalized('stream-throw'),
    false,
    'precondition: the throw happened before finalizeTerminalStream — the stream is settled but NOT finalized'
  );

  const duplicate = await harness.router.handleStreamPayload({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-throw', content: 'answer again',
  });

  assert.equal(harness.invocationsOf('handleComplete').length, 2, 'the duplicate terminal retries repair');
  assert.equal(duplicate.handlerError, true);
  assert.equal(harness.droppedLogs().length, 0);
});

test('a late delta after a throwing terminal handler is absorbed while terminal repair stays eligible', async () => {
  const harness = buildRouterHarness({ throwOnComplete: true });
  await harness.router.handleStreamPayload({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-throw-2', content: 'answer',
  });

  const lateDelta = await harness.router.handleStreamPayload({
    type: 'delta', sessionId: 'session-1', streamId: 'stream-throw-2', content: 'zombie text',
  });

  assert.equal(harness.invocationsOf('handleDelta').length, 0, 'no delta may resurrect a settled stream');
  assert.equal(lateDelta.droppedLate, true);
});

// Green pin: the one-shot preempt allowance — a clearStream-finalized stream
// with NO terminal ever dispatched lets exactly one late terminal through.
test('preempt-finalized stream: first late error routes, second absorbs', async () => {
  const harness = buildRouterHarness();
  harness.controller.registerStream('session-1', 'stream-preempt');
  harness.controller.clearStream('stream-preempt');
  assert.equal(harness.controller.isStreamFinalized('stream-preempt'), true);

  await harness.router.handleStreamPayload({
    type: 'error', sessionId: 'session-1', streamId: 'stream-preempt', message: 'late provider error',
  });
  assert.equal(harness.invocationsOf('handleError').length, 1, 'the one genuine late terminal routes');

  const duplicate = await harness.router.handleStreamPayload({
    type: 'error', sessionId: 'session-1', streamId: 'stream-preempt', message: 'duplicate',
  });
  assert.equal(harness.invocationsOf('handleError').length, 1, 'the duplicate absorbs');
  assert.equal(duplicate.droppedLate, true);
});

// Green pin: message_updated stays the settled-message reconciliation channel.
test('message_updated passes the gate for a settled stream', async () => {
  const harness = buildRouterHarness();
  await harness.router.handleStreamPayload({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-recon', content: 'answer',
  });

  await harness.router.handleStreamPayload({
    type: 'message_updated', sessionId: 'session-1', streamId: 'stream-recon',
    messageId: 'assistant_stream-recon', patch: { content: 'reconciled' },
  });

  assert.equal(harness.invocationsOf('handleMessageUpdated').length, 1);
});

// Green pin: a live stream's ordinary events still route before any terminal.
test('pre-terminal events route normally', async () => {
  const harness = buildRouterHarness();
  await harness.router.handleStreamPayload({ type: 'started', sessionId: 'session-1', streamId: 'stream-live' });
  await harness.router.handleStreamPayload({ type: 'delta', sessionId: 'session-1', streamId: 'stream-live', content: 'hi' });
  await harness.router.handleStreamPayload({ type: 'complete', sessionId: 'session-1', streamId: 'stream-live', content: 'hi' });

  assert.equal(harness.invocationsOf('handleStarted').length, 1);
  assert.equal(harness.invocationsOf('handleDelta').length, 1);
  assert.equal(harness.invocationsOf('handleComplete').length, 1);
  assert.equal(harness.droppedLogs().length, 0);
});

test('question-batch terminal failures remain repairable until a commit succeeds', async () => {
  const harness = buildRouterHarness({ throwOnQuestionBatch: true });
  const payload = {
    type: 'question_batch', sessionId: 'session-1', streamId: 'stream-question', batch: { questions: [] },
  };

  const first = await harness.router.handleStreamPayload(payload);
  const duplicate = await harness.router.handleStreamPayload(payload);

  assert.equal(first.handlerError, true);
  assert.equal(duplicate.handlerError, true);
  assert.equal(harness.invocationsOf('handleQuestionBatch').length, 2);
  assert.equal(harness.controller.getStreamTerminalCommitState('stream-question'), 'failed_repairable');
});

// ---------------------------------------------------------------------------
// context_usage: the ephemeral composer-ring snapshot. It routes to its own
// handler, is non-terminal, and — like tool_output_chunk — is DROPPED rather
// than buffered or replayed. A stale meter reading is worse than none.
// ---------------------------------------------------------------------------

test('context_usage routes to handleContextUsage and stays non-terminal', async () => {
  const harness = buildRouterHarness();
  await harness.router.handleStreamPayload({ type: 'started', sessionId: 'session-1', streamId: 'stream-usage' });

  const result = await harness.router.handleStreamPayload({
    type: 'context_usage',
    sessionId: 'session-1',
    streamId: 'stream-usage',
    phase: 'iteration',
    iteration: 2,
    usage: { context_used_tokens: 9000, compact_threshold_tokens: 20000 },
  });

  assert.equal(harness.invocationsOf('handleContextUsage').length, 1);
  assert.equal(result.terminal, false);
  assert.equal(result.buffered, false);
  assert.equal(harness.droppedLogs().length, 0);
  // Chrome-only: no message-state handler may be reached by a meter snapshot.
  assert.equal(harness.invocationsOf('handleDelta').length, 0);
});

test('context_usage is dropped, never buffered, when the pipeline would buffer', async () => {
  const harness = buildRouterHarness({ shouldBufferStreamEvent: () => true });

  const result = await harness.router.handleStreamPayload({
    type: 'context_usage', sessionId: 'session-1', streamId: 'stream-usage-buffer',
    usage: { context_used_tokens: 9000 },
  });

  assert.equal(result.buffered, false, 'ephemeral snapshots never enter the replay buffer');
  assert.equal(harness.buffered.length, 0);
  assert.equal(harness.invocationsOf('handleContextUsage').length, 0);

  // Contrast: a non-ephemeral event on the same harness IS buffered.
  const delta = await harness.router.handleStreamPayload({
    type: 'delta', sessionId: 'session-1', streamId: 'stream-usage-buffer', content: 'hi',
  });
  assert.equal(delta.buffered, true);
  assert.equal(harness.buffered.length, 1);
});

test('context_usage arriving after the turn terminal is dropped', async () => {
  const harness = buildRouterHarness();
  await harness.router.handleStreamPayload({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-usage-late', content: 'answer',
  });

  const late = await harness.router.handleStreamPayload({
    type: 'context_usage', sessionId: 'session-1', streamId: 'stream-usage-late',
    usage: { context_used_tokens: 100 },
  });

  assert.equal(late.droppedLate, true);
  assert.equal(harness.invocationsOf('handleContextUsage').length, 0);
});
