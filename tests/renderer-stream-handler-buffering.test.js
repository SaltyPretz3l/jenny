const test = require('node:test');
const assert = require('node:assert/strict');

const { createStreamDispatchRouter } = require('../renderer/chat/renderer-stream-handler-dispatch');
const { createPendingStreamCommitQueue } = require('../renderer/chat/renderer-stream-pending-commit-utils');
const { createStreamHandlerRuntime } = require('../renderer/chat/renderer-stream-handler-runtime');
const {
  createHarness,
  createManualTimerController,
  createQueuedFrameController,
  flushMicrotasks,
  waitUntil,
} = require('./helpers/renderer-stream-handler-buffering-harness');

test('pending stream commit queue cancels fallback timers on flush, drop, and dispose', () => {
  const frameController = createQueuedFrameController();
  const timerController = createManualTimerController();
  const commits = [];
  const queue = createPendingStreamCommitQueue({
    commit(value) {
      commits.push(value);
      return value;
    },
    requestAnimationFrame: frameController.requestAnimationFrame.bind(frameController),
    cancelAnimationFrame: frameController.cancelAnimationFrame.bind(frameController),
    setTimeout: timerController.setTimeout.bind(timerController),
    clearTimeout: timerController.clearTimeout.bind(timerController),
  });

  queue.stage('stream-flush', { content: 'flush' });
  assert.equal(frameController.pendingCount(), 1);
  assert.equal(timerController.pendingCount(), 1);
  assert.deepEqual(timerController.pendingDelays(), [32]);
  assert.deepEqual(queue.flush('stream-flush'), { content: 'flush' });
  assert.equal(frameController.pendingCount(), 0);
  assert.equal(timerController.pendingCount(), 0);

  queue.stage('stream-drop', { content: 'drop' });
  assert.equal(frameController.pendingCount(), 1);
  assert.equal(timerController.pendingCount(), 1);
  assert.deepEqual(timerController.pendingDelays(), [32]);
  queue.drop('stream-drop');
  assert.equal(frameController.pendingCount(), 0);
  assert.equal(timerController.pendingCount(), 0);

  queue.stage('stream-dispose', { content: 'dispose' });
  assert.equal(frameController.pendingCount(), 1);
  assert.equal(timerController.pendingCount(), 1);
  assert.deepEqual(timerController.pendingDelays(), [32]);
  queue.dispose();
  assert.equal(frameController.pendingCount(), 0);
  assert.equal(timerController.pendingCount(), 0);
  assert.deepEqual(commits, [{ content: 'flush' }]);
});

test('pending stream commit queue bounds a 400-update stream and preserves the trailing value', () => {
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map();
  const commits = [];
  const runDueTimers = () => {
    let ran = true;
    while (ran) {
      ran = false;
      for (const [handle, timer] of [...timers]) {
        if (timer.due <= clock) {
          timers.delete(handle);
          timer.callback();
          ran = true;
        }
      }
    }
  };
  const queue = createPendingStreamCommitQueue({
    minimumIntervalMs: 50,
    now: () => clock,
    commit(value) {
      commits.push(value);
      return value;
    },
    requestAnimationFrame(callback) {
      callback();
      return 0;
    },
    cancelAnimationFrame() {},
    setTimeout(callback, delayMs) {
      const handle = nextTimer++;
      timers.set(handle, { callback, due: clock + delayMs });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
  });

  for (let index = 0; index < 400; index += 1) {
    queue.stage('stream-a', { content: `value-${index}` });
    clock += 5;
    runDueTimers();
  }
  queue.flush('stream-a');

  assert.ok(commits.length <= 42, `expected at most 42 commits, got ${commits.length}`);
  assert.equal(commits.at(-1).content, 'value-399');
  assert.equal(queue.pendingCount(), 0);
  assert.ok(queue.timingStateCount() <= 64);
  queue.dispose();
  assert.equal(queue.timingStateCount(), 0);
  assert.equal(timers.size, 0);
});

test('pending stream cadence isolates keys and caps timing state', () => {
  let clock = 0;
  const queue = createPendingStreamCommitQueue({
    minimumIntervalMs: 50,
    now: () => clock,
    commit(value) { return value; },
    requestAnimationFrame(callback) { callback(); return 0; },
    cancelAnimationFrame() {},
    setTimeout() { return 1; },
    clearTimeout() {},
  });
  for (let index = 0; index < 80; index += 1) {
    queue.stage(`stream-${index}`, { index });
    clock += 50;
  }
  assert.equal(queue.timingStateCount(), 64);
  queue.drop('stream-79');
  assert.equal(queue.timingStateCount(), 63);
  queue.dispose();
});

test('stream render queue cancels fallback timers on immediate render and dispose', () => {
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const frameController = createQueuedFrameController();
  const timerController = createManualTimerController();
  const calls = { renderMessages: 0 };
  global.requestAnimationFrame = frameController.requestAnimationFrame.bind(frameController);
  global.cancelAnimationFrame = frameController.cancelAnimationFrame.bind(frameController);
  global.setTimeout = timerController.setTimeout.bind(timerController);
  global.clearTimeout = timerController.clearTimeout.bind(timerController);
  try {
    const runtime = createStreamHandlerRuntime({
      state: { ui: { activeView: 'chat' } },
      renderMessages() {
        calls.renderMessages += 1;
      },
      appendClientLog() {},
    });

    runtime.queueRender({ messages: true });
    assert.equal(frameController.pendingCount(), 1);
    assert.equal(timerController.pendingCount(), 1);
    assert.deepEqual(timerController.pendingDelays(), [32]);
    runtime.queueRender({}, { immediate: true });
    assert.equal(calls.renderMessages, 1);
    assert.equal(frameController.pendingCount(), 0);
    assert.equal(timerController.pendingCount(), 0);

    runtime.queueRender({ messages: true });
    assert.equal(frameController.pendingCount(), 1);
    assert.equal(timerController.pendingCount(), 1);
    assert.deepEqual(timerController.pendingDelays(), [32]);
    runtime.disposeRenderQueue();
    assert.equal(frameController.pendingCount(), 0);
    assert.equal(timerController.pendingCount(), 0);
    assert.equal(calls.renderMessages, 1);
  } finally {
    global.requestAnimationFrame = previousRequestAnimationFrame;
    global.cancelAnimationFrame = previousCancelAnimationFrame;
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('flushBufferedStreamEvents yields buffered deltas across frames instead of rendering all catch-up in one pass', async (t) => {
  const frameController = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frameController.requestAnimationFrame.bind(frameController),
    cancelAnimationFrameImpl: frameController.cancelAnimationFrame.bind(frameController),
  });
  t.after(() => harness.restore());

  const bufferedEvents = [{ type: 'started', sessionId: 'session-1', streamId: 'stream-flush-1' }];
  for (let index = 1; index <= 15; index += 1) {
    bufferedEvents.push({
      type: 'delta',
      sessionId: 'session-1',
      streamId: 'stream-flush-1',
      content: `t${index}`,
      aggregate: 'x'.repeat(index),
    });
  }
  harness.state.bufferedStreamEventsByStream.set('stream-flush-1', bufferedEvents);

  let flushResult = null;
  const flushPromise = harness.handler.flushBufferedStreamEvents('stream-flush-1').then((result) => {
    flushResult = result;
    return result;
  });

  for (let index = 0; index < 30 && frameController.pendingCount() < 1; index += 1) {
    await flushMicrotasks();
  }
  assert.equal(harness.calls.renderMessages, 0);
  assert.equal(frameController.pendingCount() > 0, true);

  let frameDrains = 0;
  while (flushResult === null && frameDrains < 12) {
    if (frameController.pendingCount() < 1) {
      for (let index = 0; index < 30 && frameController.pendingCount() < 1 && flushResult === null; index += 1) {
        await flushMicrotasks();
      }
    }
    if (frameController.pendingCount() < 1) {
      break;
    }
    await frameController.drainNextFrame();
    frameDrains += 1;
  }

  assert.deepEqual(await flushPromise, { flushedCount: 16, terminal: false, discardedCount: 0 });
  assert.equal(harness.calls.renderMessages > 1, true);
  assert.equal(frameDrains > 1, true);
  assert.equal(frameController.pendingCount(), 0);
});

test('stream handler renders visible-session deltas and clears stream ownership on error', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-1' });
  assert.equal(harness.multiStreamController.getStreamIdForSession('session-1'), 'stream-1');
  assert.deepEqual(harness.calls.indicator, [['start', 'thinking']]);
  assert.equal(harness.state.ui.chatSendLifecycleBySession.get('session-1'), 'streaming');

  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-1', aggregate: 'hello' });
  assert.equal(harness.state.messagesBySession.get('session-1').length > 0, true);
  assert.equal(harness.calls.renderWorkspaceChrome, 0);
  assert.deepEqual(harness.calls.indicator, [['start', 'thinking'], ['complete']]);
  assert.equal(harness.state.ui.chatSendLifecycleBySession.get('session-1'), 'streaming');

  await harness.emit({
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-1',
    message: 'boom',
    error_code: 'CMP-CHAT-0002',
    retryable: true,
    category: 'transport',
  });
  assert.equal(harness.multiStreamController.getStreamIdForSession('session-1'), null);
  assert.deepEqual(harness.calls.indicator, [['start', 'thinking'], ['complete'], ['reset']]);
  assert.equal(harness.state.ui.chatSendLifecycleBySession.has('session-1'), false);
  const failedMessage = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(failedMessage.content, 'hello');
  assert.equal(failedMessage.status, 'error');
  assert.equal(failedMessage.stream_error, 'boom');
  assert.equal(failedMessage.error_code, 'CMP-CHAT-0002');
  assert.equal(failedMessage.retryable, true);
  assert.equal(failedMessage.category, 'transport');
  assert.equal(failedMessage.session_id, 'session-1');
});

test('stream handler flushes pending hidden current-session deltas for chat catch-up', async (t) => {
  const frameController = createQueuedFrameController();
  const logs = [];
  const harness = createHarness({
    requestAnimationFrameImpl: frameController.requestAnimationFrame.bind(frameController),
    cancelAnimationFrameImpl: frameController.cancelAnimationFrame.bind(frameController),
    stateOverrides: {
      ui: { activeView: 'settings' },
    },
    callbackOverrides: {
      appendClientLog(level, event, data) {
        logs.push({ level, event, data });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-hidden-1' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-hidden-1',
    content: 'Hello from a hidden chat view',
  });

  const beforeFlush = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(beforeFlush.content, '');

  const result = harness.handler.flushPendingStreamCommitsForSession('session-1');

  assert.equal(result.flushedCount, 1);
  assert.equal(result.catchupRequired, true);
  assert.equal(harness.state.messagesBySession.get('session-1')[0].content, 'Hello from a hidden chat view');
  assert.equal(harness.calls.renderMessages, 0);
  assert.equal(
    harness.state.ui.chatTimelineVisibilityTracker.hasHiddenCatchup('session-1'),
    true
  );
  assert.equal(logs.some((entry) => entry.event === 'timeline.hidden_stream_dirty'), true);
});

test('stream handler commits and renders visible deltas when animation frames are throttled', async (t) => {
  const frameController = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frameController.requestAnimationFrame.bind(frameController),
    cancelAnimationFrameImpl: frameController.cancelAnimationFrame.bind(frameController),
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-throttled-1' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-throttled-1',
    content: 'Visible fallback text',
  });

  assert.equal(harness.state.messagesBySession.get('session-1')[0].content, '');
  assert.equal(harness.calls.renderMessages, 0);
  assert.ok(frameController.pendingCount() > 0);

  await waitUntil(() => harness.calls.renderMessages === 1, {
    label: 'the rAF-fallback timer to commit the visible delta',
  });
  await flushMicrotasks(20);

  assert.equal(harness.state.messagesBySession.get('session-1')[0].content, 'Visible fallback text');
  assert.equal(harness.calls.renderMessages, 1);
  assert.equal(frameController.pendingCount(), 0);
});

test('flushBufferedStreamEvents keeps same-stream arrivals ordered while yielding', async () => {
  const state = {
    bufferedStreamEventsByStream: new Map(),
  };
  const handled = [];
  let frameWaiter = null;
  const handlers = {
    async handleStarted(payload) {
      handled.push(payload.type);
      return { terminal: false };
    },
    async handleDelta(payload) {
      handled.push(payload.content);
      return { terminal: false };
    },
    async handleThinkingStatus() { return { terminal: false }; },
    async handlePhaseStarted() { return { terminal: false }; },
    async handlePhaseCompleted() { return { terminal: false }; },
    async handleAgentStatus() { return { terminal: false }; },
    async handleToolUse() { return { terminal: false }; },
    async handleApprovalNeeded() { return { terminal: false }; },
    async handleToolResult() { return { terminal: false }; },
    async handleStreamReset() { return { terminal: false }; },
    async handleContextCompacted() { return { terminal: false }; },
    async handleQuestionBatch() { return { terminal: false }; },
    async handleMessageUpdated() { return { terminal: false }; },
    async handleComplete() { return { terminal: true }; },
    async handleError() { return { terminal: true }; },
  };

  state.bufferedStreamEventsByStream.set('stream-race', [
    { type: 'started', sessionId: 'session-1', streamId: 'stream-race' },
    { type: 'delta', sessionId: 'session-1', streamId: 'stream-race', content: 't1' },
    { type: 'delta', sessionId: 'session-1', streamId: 'stream-race', content: 't2' },
    { type: 'delta', sessionId: 'session-1', streamId: 'stream-race', content: 't3' },
    { type: 'delta', sessionId: 'session-1', streamId: 'stream-race', content: 't4' },
    { type: 'delta', sessionId: 'session-1', streamId: 'stream-race', content: 't5' },
    { type: 'delta', sessionId: 'session-1', streamId: 'stream-race', content: 't6' },
  ]);

  const router = createStreamDispatchRouter({
    state,
    normalizeId: (value) => String(value || '').trim(),
    normalizeString: (value) => String(value || '').trim(),
    appendClientLog() {},
    handlers,
    shouldBufferStreamEvent: () => false,
    bufferStreamEvent(payload) {
      const key = String(payload.streamId || '').trim();
      const queue = state.bufferedStreamEventsByStream.get(key) || [];
      queue.push(payload);
      state.bufferedStreamEventsByStream.set(key, queue);
    },
    isRenderableBufferedStreamEvent: (payload) => payload.type === 'delta',
    waitForRenderFrame() {
      return new Promise((resolve) => {
        frameWaiter = resolve;
      });
    },
    flushRenderableBatchSize: 4,
  });

  const flushPromise = router.flushBufferedStreamEvents('stream-race');
  for (let index = 0; index < 20 && !frameWaiter; index += 1) {
    await flushMicrotasks();
  }
  assert.deepEqual(handled, ['started', 't1', 't2', 't3', 't4']);

  const lateResult = await router.handleStreamPayload({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-race',
    content: 'late',
  });
  assert.deepEqual(lateResult, { buffered: true, terminal: false });
  assert.deepEqual(handled, ['started', 't1', 't2', 't3', 't4'], 'late payload must not bypass older buffered items');

  frameWaiter();
  assert.deepEqual(await flushPromise, { flushedCount: 8, terminal: false, discardedCount: 0 });
  assert.deepEqual(handled, ['started', 't1', 't2', 't3', 't4', 't5', 't6', 'late']);
});

test('stream handler marks staged visible deltas hidden if the commit runs after navigation', async (t) => {
  const frameController = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frameController.requestAnimationFrame.bind(frameController),
    cancelAnimationFrameImpl: frameController.cancelAnimationFrame.bind(frameController),
  });
  t.after(() => harness.restore());

  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-visible-then-hidden-1',
    content: 'reasoning text committed after navigation',
  });
  harness.state.ui.activeView = 'logs';

  assert.equal(frameController.pendingCount(), 1);
  await frameController.drainNextFrame();

  assert.equal(
    harness.state.ui.chatTimelineVisibilityTracker.hasHiddenCatchup('session-1'),
    true
  );
  assert.equal(harness.calls.renderMessages, 0);

  await frameController.drainNextFrame();

  assert.equal(harness.calls.renderMessages, 0);
  assert.equal(harness.calls.renderWorkspaceChrome, 1);
});

test('stream handler creates a hidden reasoning shell before assistant text arrives', async (t) => {
  const frameController = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frameController.requestAnimationFrame.bind(frameController),
    cancelAnimationFrameImpl: frameController.cancelAnimationFrame.bind(frameController),
    stateOverrides: {
      ui: { activeView: 'logs' },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({
    type: 'phase_started',
    sessionId: 'session-1',
    streamId: 'stream-hidden-reasoning-shell-1',
    phaseKind: 'reasoning',
    phaseId: 'phase-hidden-reasoning-shell-1',
    thinkingId: 'thinking-hidden-reasoning-shell-1',
    summary: 'Reading context',
  });

  const messages = harness.state.messagesBySession.get('session-1');
  const assistant = messages.find((message) => message.id === 'assistant_stream-hidden-reasoning-shell-1');

  assert.ok(assistant, 'expected hidden reasoning to materialize an assistant shell');
  assert.equal(assistant.status, 'streaming');
  assert.equal(assistant.content, '');
  assert.equal(harness.state.pendingStreams.get('stream-hidden-reasoning-shell-1'), assistant.id);
  assert.equal(
    harness.state.ui.chatTimelineVisibilityTracker.hasHiddenCatchup('session-1'),
    true
  );
  assert.equal(harness.calls.renderMessages, 0);
});

test('stream handler does not create a reasoning shell for blank thinking status', async (t) => {
  const frameController = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frameController.requestAnimationFrame.bind(frameController),
    cancelAnimationFrameImpl: frameController.cancelAnimationFrame.bind(frameController),
    stateOverrides: {
      ui: { activeView: 'logs' },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({
    type: 'thinking_status',
    sessionId: 'session-1',
    streamId: 'stream-blank-thinking-1',
    text: '',
  });

  assert.equal(harness.state.pendingStreams.has('stream-blank-thinking-1'), false);
  assert.equal(harness.state.messagesBySession.get('session-1').length, 0);
  assert.equal(harness.state.streamThinkingStatusByStream.has('stream-blank-thinking-1'), false);
});

test('stream handler does not create a reasoning shell without a stream id', async (t) => {
  const frameController = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frameController.requestAnimationFrame.bind(frameController),
    cancelAnimationFrameImpl: frameController.cancelAnimationFrame.bind(frameController),
    stateOverrides: {
      ui: { activeView: 'logs' },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({
    type: 'phase_started',
    sessionId: 'session-1',
    phaseKind: 'reasoning',
    phaseId: 'phase-missing-stream-1',
    thinkingId: 'thinking-missing-stream-1',
    summary: 'Reading context',
  });

  assert.equal(harness.state.pendingStreams.size, 0);
  assert.equal(harness.state.messagesBySession.get('session-1').length, 0);
});

test('stream handler marks hidden current-session tool updates without rendering hidden messages', async (t) => {
  const frameController = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frameController.requestAnimationFrame.bind(frameController),
    cancelAnimationFrameImpl: frameController.cancelAnimationFrame.bind(frameController),
    stateOverrides: {
      ui: { activeView: 'settings' },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-hidden-tool-1' });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-hidden-tool-1',
    callId: 'call-hidden-1',
    toolName: 'Read',
    summary: 'Read notes.md',
    input: { path: 'notes.md' },
    status: 'running',
  });

  await frameController.drainNextFrame();

  assert.equal(harness.calls.renderMessages, 0);
  assert.equal(harness.calls.renderWorkspaceChrome, 1);
  assert.equal(
    harness.state.ui.chatTimelineVisibilityTracker.hasHiddenCatchup('session-1'),
    true
  );
});

test('handleDelta skips stale text aggregates that would regress visible content', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-stale-1' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-stale-1',
    content: 'abcdefghijklmnopqrst',
    aggregate: 'abcdefghijklmnopqrst',
  });

  const beforeMessage = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(beforeMessage.content, 'abcdefghijklmnopqrst');

  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-stale-1',
    content: 'stale',
    aggregate: 'abcdefghijklmno',
  });

  const afterMessage = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(afterMessage.content, 'abcdefghijklmnopqrst');
});

test('handleDelta merges reasoning from stale buffered deltas without regressing text', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-stale-2' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-stale-2',
    content: 'abcdefghijklmnopqrst',
    aggregate: 'abcdefghijklmnopqrst',
  });

  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-stale-2',
    content: '',
    aggregate: 'abcdefghijklmno',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-1', text: 'Reason through the stale delta.' }],
    },
  });

  const message = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(message.content, 'abcdefghijklmnopqrst');
  assert.deepEqual(message.reasoning, {
    source: 'provider',
    entries: [{ id: 'reason-1', text: 'Reason through the stale delta.', timestamp: '2026-04-10T00:00:00.000Z' }],
  });
});

test('stream handler reuses a pre-seeded assistant stream message instead of appending a duplicate', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  harness.state.messagesBySession.set('session-1', [
    { id: 'user_1', role: 'user', content: 'Use tools', status: 'complete' },
    {
      id: 'assistant_stream-1',
      role: 'assistant',
      content: 'Working...',
      status: 'streaming',
      streamId: 'stream-1',
    },
  ]);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-1' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-1', aggregate: 'Working harder' });

  const messages = harness.state.messagesBySession.get('session-1') || [];
  const streamMessages = messages.filter((message) => message.id === 'assistant_stream-1');

  assert.equal(streamMessages.length, 1);
  assert.equal(streamMessages[0].content, 'Working harder');
  assert.equal(streamMessages[0].status, 'streaming');
  assert.equal(harness.state.pendingStreams.get('stream-1'), 'assistant_stream-1');
});

test('stream handler completes the indicator only for the active visible session', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-1' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-1', aggregate: 'hello' });
  await harness.emit({ type: 'started', sessionId: 'session-2', streamId: 'stream-2' });
  await harness.emit({ type: 'complete', sessionId: 'session-2', streamId: 'stream-2', content: 'done' });

  assert.deepEqual(harness.calls.indicator, [['start', 'thinking'], ['complete']]);

  await harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-1', content: 'done' });
  assert.deepEqual(harness.calls.indicator, [['start', 'thinking'], ['complete'], ['complete']]);
  assert.equal(harness.state.ui.chatSendLifecycleBySession.has('session-1'), false);
  assert.equal(harness.state.ui.chatSendLifecycleBySession.has('session-2'), false);
});
