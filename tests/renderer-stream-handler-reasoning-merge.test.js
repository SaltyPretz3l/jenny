const test = require('node:test');
const assert = require('node:assert/strict');

const { createStreamHandler } = require('../renderer/chat/renderer-stream-handler');
const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');
const { createReasoningStreamMerger } = require('../renderer/chat/renderer-stream-handler-reasoning-merge');
const { mergeReasoningEntries } = require('../renderer/chat/chat-message-utils');

function createQueuedFrameController() {
  let nextHandle = 1;
  const callbacks = new Map();
  return {
    requestAnimationFrame(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle) {
      callbacks.delete(handle);
    },
    async drainAllFrames() {
      let guard = 0;
      while (callbacks.size > 0 && guard < 20) {
        const pending = [...callbacks.values()];
        callbacks.clear();
        pending.forEach((callback) => callback(Date.now()));
        await Promise.resolve();
        guard += 1;
      }
    },
  };
}

function createDirectReasoningMerger(options = {}) {
  return createReasoningStreamMerger({
    normalizeId(value) {
      return String(value || '').trim();
    },
    mergeMessageReasoning(message, payload) {
      const existing = Array.isArray(message?.reasoning?.entries) ? message.reasoning.entries : [];
      if (!payload || !Array.isArray(payload.entriesDelta) || !payload.entriesDelta.length) {
        return message.reasoning || { source: 'none', entries: [] };
      }
      return {
        source: String(payload.source || 'provider'),
        entries: mergeReasoningEntries(existing, payload.entriesDelta, {
          timestamp: '2026-05-16T00:00:00.000Z',
        }),
      };
    },
    ...options,
  });
}

function createHarness(options = {}) {
  const { frameController = createQueuedFrameController(), mergeProbe = () => {} } = options;
  const previousWindow = global.window;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  global.requestAnimationFrame = frameController.requestAnimationFrame.bind(frameController);
  global.cancelAnimationFrame = frameController.cancelAnimationFrame.bind(frameController);
  global.window = {
    jennyShell: {
      sessions: {
        async getMessages() {
          return { data: [] };
        },
      },
    },
  };

  const state = {
    currentSessionId: 'session-1',
    ui: { activeView: 'chat', chatSendLifecycleBySession: new Map() },
    messagesBySession: new Map([['session-1', []]]),
    interactiveDraftsBySession: new Map(),
    sessions: [{ id: 'session-1' }],
    pendingStreams: new Map(),
    streamThinkingStatusByStream: new Map(),
    toolCallsByStream: new Map(),
    pendingToolApprovals: new Map(),
    bufferedStreamEventsByStream: new Map(),
    sendPreflight: null,
  };
  const multiStreamController = createMultiStreamController({
    getState: () => state,
    appendClientLog() {},
  });
  let streamListener = null;
  const handler = createStreamHandler({
    state,
    dom: { chatInput: { focus() {} } },
    multiStreamController,
    constants: {
      MESSAGE_STATUS: { STREAMING: 'streaming', COMPLETE: 'complete', ERROR: 'error' },
      MAX_INTERACTIVE_QUESTIONS: 3,
      MAX_INTERACTIVE_ROUNDS: 3,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      TOAST_SOURCE: { chatStream: 'chat.stream' },
    },
    callbacks: {
      renderAll() {},
      renderHeader() {},
      renderMessages() {},
      renderSessions() {},
      renderSettings() {},
      renderComposerState() {},
      renderComposerStatusNotice() {},
      renderWorkspaceChrome() {},
      getSessionMessages(sessionId) { return state.messagesBySession.get(sessionId) || []; },
      setSessionMessages(sessionId, messages) { state.messagesBySession.set(sessionId, messages); },
      createNormalizedMessage(role, content, extra = {}) {
        return { id: extra.id || `${role}_message`, role, content, ...extra };
      },
      setComposerStatusNotice() {},
      clearComposerStatusNotice() {},
      normalizePendingQuestionBatch(batch) { return batch || null; },
      getInteractiveSequenceState() { return 'idle'; },
      clearInteractiveDraft() {},
      ensureInteractiveDraft() {},
      patchSessionSummary() {},
      buildInteractiveQuestionBatchVisibleText() { return ''; },
      refreshSessionSummaries: async () => ({}),
      refreshSnapshots: async () => {},
      showToastMessage() {},
      dismissStreamErrors() {},
      maybeSuggestMemoryCapture: async () => {},
      appendClientLog() {},
      getInteractiveComposerStatusNotice() { return ''; },
      persistInteractiveFallbackRequest: async () => {},
      requestInteractiveGuardrailAnswer: async () => {},
      requestInteractiveProtocolDriftAnswer: async () => {},
      queueInteractiveComposerFocus() {},
      mergeMessageReasoning(message, payload) {
        const existing = Array.isArray(message?.reasoning?.entries) ? message.reasoning.entries : [];
        mergeProbe(existing.length);
        if (!payload || !Array.isArray(payload.entriesDelta) || !payload.entriesDelta.length) {
          return message.reasoning || { source: 'none', entries: [] };
        }
        return {
          source: String(payload.source || 'provider'),
          entries: mergeReasoningEntries(existing, payload.entriesDelta, {
            timestamp: '2026-05-16T00:00:00.000Z',
          }),
        };
      },
      getQueuedSend() { return null; },
      restoreQueuedSendDraft() {},
      dispatchQueuedSendForSession: async () => null,
      setChatSendLifecycle(sessionId, lifecycle) {
        state.ui.chatSendLifecycleBySession.set(sessionId, lifecycle);
        return lifecycle;
      },
      clearChatSendLifecycle(sessionId) {
        return state.ui.chatSendLifecycleBySession.delete(sessionId);
      },
      getChatSendLifecycle(sessionId) {
        return state.ui.chatSendLifecycleBySession.get(sessionId) || 'idle';
      },
      getChatTimelineRowModelEnabled() { return false; },
      recordChatTimelineRolloutSignal() { return { logged: false, count: 0 }; },
    },
  });
  handler.registerStreamHandler({
    chat: {
      onStream(listener) {
        streamListener = listener;
        return () => {
          streamListener = null;
        };
      },
    },
  });

  return {
    frameController,
    state,
    async emit(payload) {
      await streamListener(payload);
    },
    restore() {
      global.window = previousWindow;
      global.requestAnimationFrame = previousRequestAnimationFrame;
      global.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
}

test('reasoning merge content dedupe follows same-id replacements', () => {
  const merger = createDirectReasoningMerger();
  const message = {
    id: 'assistant-reasoning-dedupe',
    reasoning: { source: 'provider', entries: [] },
  };
  function merge(entriesDelta) {
    message.reasoning = merger.merge('stream-reasoning-dedupe', message, {
      source: 'provider',
      entriesDelta,
    });
    return message.reasoning;
  }

  merge([{ id: 'reason-same', text: 'First text' }]);
  merge([{ id: 'reason-same', text: 'Second text' }]);
  const reasoning = merge([{ id: 'reason-later', text: 'First text' }]);

  assert.deepEqual(
    reasoning.entries.map((entry) => [entry.id, entry.text]),
    [
      ['reason-same', 'Second text'],
      ['reason-later', 'First text'],
    ]
  );
});

test('reasoning merge clearAll drops abandoned accumulator state', () => {
  const merger = createDirectReasoningMerger();
  const message = {
    id: 'assistant-reasoning-clear',
    reasoning: { source: 'provider', entries: [] },
  };

  message.reasoning = merger.merge('stream-reasoning-clear', message, {
    source: 'provider',
    entriesDelta: [{ id: 'reason-before-clear', text: 'Before clear' }],
  });
  message.reasoning = { source: 'provider', entries: [] };
  merger.clearAll();
  message.reasoning = merger.merge('stream-reasoning-clear', message, {
    source: 'provider',
    entriesDelta: [{ id: 'reason-after-clear', text: 'After clear' }],
  });

  assert.deepEqual(
    message.reasoning.entries.map((entry) => entry.id),
    ['reason-after-clear']
  );
});

test('reasoning merge cap evicts the least-recently-touched stream', (t) => {
  const originalDateNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  t.after(() => {
    Date.now = originalDateNow;
  });
  const flushedStreamIds = [];
  const merger = createDirectReasoningMerger({
    bufferExpiryMs: 60000,
    maxStreams: 2,
    flushPendingStreamCommit(streamId) {
      flushedStreamIds.push(streamId);
    },
  });
  const messagesByStream = new Map();
  function touch(streamId, text) {
    now += 100;
    const message = messagesByStream.get(streamId) || {
      id: `assistant_${streamId}`,
      reasoning: { source: 'provider', entries: [] },
    };
    message.reasoning = merger.merge(streamId, message, {
      source: 'provider',
      entriesDelta: [{ id: `reason_${streamId}_${text}`, text }],
    });
    messagesByStream.set(streamId, message);
  }

  touch('stream-old-active', 'one');
  touch('stream-idle', 'two');
  touch('stream-old-active', 'three');
  touch('stream-new', 'four');

  assert.deepEqual(flushedStreamIds, ['stream-idle']);
});

test('same-frame reasoning bursts do not remerge the accumulated pending reasoning list', async (t) => {
  const existingEntryCounts = [];
  const harness = createHarness({
    mergeProbe(existingCount) {
      existingEntryCounts.push(existingCount);
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-reasoning-burst' });
  for (let index = 0; index < 20; index += 1) {
    await harness.emit({
      type: 'delta',
      sessionId: 'session-1',
      streamId: 'stream-reasoning-burst',
      content: '',
      aggregate: '',
      reasoning: {
        source: 'provider',
        entriesDelta: [{ id: `reason-${index}`, text: `Reasoning ${index}` }],
      },
    });
  }

  assert.equal(
    Math.max(0, ...existingEntryCounts),
    0,
    'reasoning delta normalization should not scan accumulated pending entries before the frame commits'
  );

  await harness.frameController.drainAllFrames();
  const message = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(message.reasoning.entries.length, 20);
  assert.deepEqual(
    message.reasoning.entries.map((entry) => entry.id),
    Array.from({ length: 20 }, (_, index) => `reason-${index}`)
  );
});

test('same-frame id-less reasoning deltas keep generated ids unique', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-reasoning-idless' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-reasoning-idless',
    content: '',
    aggregate: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ text: 'First generated id chunk' }],
    },
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-reasoning-idless',
    content: '',
    aggregate: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ text: 'Second generated id chunk' }],
    },
  });

  await harness.frameController.drainAllFrames();
  const message = harness.state.messagesBySession.get('session-1')[0];
  assert.deepEqual(
    message.reasoning.entries.map((entry) => entry.text),
    ['First generated id chunk', 'Second generated id chunk']
  );
  assert.deepEqual(
    message.reasoning.entries.map((entry) => entry.id),
    ['reasoning_0', 'reasoning_1']
  );
});

test('same-frame content deltas preserve staged reasoning entries', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-reasoning-content' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-reasoning-content',
    content: '',
    aggregate: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-before-content', text: 'Think first' }],
    },
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-reasoning-content',
    content: 'Then answer.',
    aggregate: 'Then answer.',
  });

  await harness.frameController.drainAllFrames();
  const message = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(message.content, 'Then answer.');
  assert.deepEqual(
    message.reasoning.entries.map((entry) => entry.id),
    ['reason-before-content']
  );
});

test('reasoning merge state cap flushes oldest pending reasoning before eviction', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  for (let index = 0; index < 130; index += 1) {
    const streamId = `stream-reasoning-cap-${index}`;
    await harness.emit({ type: 'started', sessionId: 'session-1', streamId });
    await harness.emit({
      type: 'delta',
      sessionId: 'session-1',
      streamId,
      content: '',
      aggregate: '',
      reasoning: {
        source: 'provider',
        entriesDelta: [{ id: `reason-cap-${index}`, text: `Capped reasoning ${index}` }],
      },
    });
  }

  const oldestMessage = harness.state.messagesBySession
    .get('session-1')
    .find((message) => message.id === 'assistant_stream-reasoning-cap-0');
  assert.ok(oldestMessage, 'oldest stream shell should exist');
  assert.deepEqual(
    oldestMessage.reasoning.entries.map((entry) => entry.id),
    ['reason-cap-0'],
    'oldest staged reasoning should be flushed before the accumulator is evicted'
  );
});

test('error terminal drains staged reasoning before marking the stream failed', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-reasoning-error' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-reasoning-error',
    content: '',
    aggregate: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-before-error', text: 'Keep this reasoning' }],
    },
  });
  await harness.emit({
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-reasoning-error',
    message: 'Model stream interrupted.',
  });

  const message = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(message.status, 'error');
  assert.deepEqual(
    message.reasoning.entries.map((entry) => entry.id),
    ['reason-before-error']
  );
});
