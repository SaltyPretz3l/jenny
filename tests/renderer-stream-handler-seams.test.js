const test = require('node:test');
const assert = require('node:assert/strict');

const { createStreamHandler } = require('../renderer/chat/renderer-stream-handler');
const { createStreamHandlerLifecycle } = require('../renderer/chat/renderer-stream-handler-lifecycle');
const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');
const { mergeReasoningEntries } = require('../renderer/chat/chat-message-utils');

// Phase 10 Track A2 — focused regression coverage for fragile streaming seams.
// Each test reproduces a specific shape that previously caused the renderer
// to drop, duplicate, or reorder rows. The goal is to lock the seam contracts
// before the projector/stream-handler files get split (Track C), so refactors
// can move code around without silently changing observable stream behaviour.

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
    async drainNextFrame() {
      const frameCallbacks = [...callbacks.entries()];
      callbacks.clear();
      frameCallbacks.forEach(([, callback]) => callback(Date.now()));
      await flushMicrotasks(25);
      return frameCallbacks.length;
    },
  };
}

async function flushMicrotasks(count = 1) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function createLifecycleHarness(overrides = {}) {
  const logs = [];
  const pendingStreamCommitQueue = {
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  };
  const lifecycle = createStreamHandlerLifecycle({
    state: { turnEventsBySession: new Map() },
    normalizeId(value) {
      return String(value || '').trim();
    },
    appendClientLog(level, eventName, details) {
      logs.push({ level, eventName, details });
    },
    handleStreamPayload: async () => ({ buffered: false, terminal: false }),
    handleStreamEnvelope: async () => ({ buffered: false, terminal: false }),
    pendingStreamCommitQueue,
    approvalToastSessionIds: new Set(),
    isRowModelEnabled: () => false,
    getLiveStateStore: () => new Map(),
    ...overrides,
  });
  return { lifecycle, logs, pendingStreamCommitQueue };
}

function createHarness(options = {}) {
  const {
    requestAnimationFrameImpl = null,
    cancelAnimationFrameImpl = null,
    callbackOverrides = {},
    stateOverrides = {},
    rowModelSessions = ['session-1'],
  } = options;
  const previousWindow = global.window;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  global.requestAnimationFrame = requestAnimationFrameImpl || ((callback) => {
    callback();
    return 1;
  });
  global.cancelAnimationFrame = cancelAnimationFrameImpl || (() => {});
  global.window = stateOverrides.window || {
    jennyShell: {
      sessions: {
        async getMessages() {
          return { data: [] };
        },
      },
    },
  };
  const defaultMessagesBySession = new Map([
    ['session-1', []],
    ['session-2', []],
    ['session-3', []],
  ]);
  const chatTimelineRowModelBySession = new Map();
  for (const sessionId of rowModelSessions) {
    chatTimelineRowModelBySession.set(sessionId, true);
  }
  const state = {
    currentSessionId: 'session-1',
    ui: {
      activeView: 'chat',
      chatSendLifecycleBySession: new Map(),
      chatTimelineRowModelBySession,
    },
    messagesBySession: stateOverrides.messagesBySession || defaultMessagesBySession,
    interactiveDraftsBySession: new Map(),
    sessions: [{ id: 'session-1' }, { id: 'session-2' }, { id: 'session-3' }],
    pendingStreams: new Map(),
    streamThinkingStatusByStream: new Map(),
    toolCallsByStream: new Map(),
    pendingToolApprovals: new Map(),
    bufferedStreamEventsByStream: new Map(),
    sendPreflight: null,
    ...stateOverrides,
  };
  state.ui = {
    activeView: 'chat',
    chatSendLifecycleBySession: new Map(),
    chatTimelineRowModelBySession,
    ...(stateOverrides.ui || {}),
  };
  const calls = {
    renderMessages: 0,
    renderSessions: 0,
    renderWorkspaceChrome: 0,
    setSessionMessages: [],
    toasts: [],
    indicator: [],
    presence: [],
    rolloutSignals: [],
  };
  const multiStreamController = createMultiStreamController({
    getState: () => state,
    appendClientLog() {},
  });
  const thinkingIndicator = {
    startIndicator(mode) { calls.indicator.push(['start', mode]); },
    updateIndicator(mode) { calls.indicator.push(['update', mode]); },
    completeIndicator() { calls.indicator.push(['complete']); },
    resetIndicator() { calls.indicator.push(['reset']); },
    getDisplayState() {
      const lastCall = calls.indicator[calls.indicator.length - 1] || null;
      if (!lastCall) {
        return { mode: 'idle' };
      }
      if (lastCall[0] === 'start' || lastCall[0] === 'update') {
        return { mode: lastCall[1] || 'thinking' };
      }
      return { mode: 'idle' };
    },
  };
  let streamListener = null;
  let envelopeListener = null;
  const handler = createStreamHandler({
    state,
    thinkingIndicator,
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
      renderMessages() { calls.renderMessages += 1; },
      renderSessions() { calls.renderSessions += 1; },
      renderSettings() {},
      renderComposerState() {},
      renderComposerStatusNotice() {},
      renderWorkspaceChrome() { calls.renderWorkspaceChrome += 1; },
      getSessionMessages(sessionId) { return state.messagesBySession.get(sessionId) || []; },
      setSessionMessages(sessionId, messages) {
        calls.setSessionMessages.push({ sessionId, messages });
        state.messagesBySession.set(sessionId, messages);
      },
      createNormalizedMessage(role, content, extra = {}) {
        return { id: extra.id || `${role}_${Date.now()}`, role, content, ...extra };
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
      showToastMessage(message, options) { calls.toasts.push({ message, options }); },
      dismissStreamErrors() {},
      maybeSuggestMemoryCapture: async () => {},
      appendClientLog() {},
      handlePresenceStreamEvent(payload) { calls.presence.push(payload); },
      getInteractiveComposerStatusNotice() { return ''; },
      persistInteractiveFallbackRequest: async () => {},
      requestInteractiveGuardrailAnswer: async () => {},
      requestInteractiveProtocolDriftAnswer: async () => {},
      queueInteractiveComposerFocus() {},
      mergeMessageReasoning(message, reasoning) {
        if (!reasoning || !Array.isArray(reasoning.entriesDelta) || !reasoning.entriesDelta.length) {
          return message.reasoning || { source: 'none', entries: [] };
        }
        const existingEntries = Array.isArray(message?.reasoning?.entries) ? message.reasoning.entries : [];
        return {
          source: String(reasoning.source || 'provider'),
          entries: mergeReasoningEntries(existingEntries, reasoning.entriesDelta, {
            timestamp: '2026-04-10T00:00:00.000Z',
          }),
        };
      },
      getQueuedSend() { return null; },
      restoreQueuedSendDraft() {},
      dispatchQueuedSendForSession: async () => null,
      setChatSendLifecycle(sessionId, lifecycle) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) return 'idle';
        state.ui.chatSendLifecycleBySession.set(normalizedSessionId, lifecycle);
        return lifecycle;
      },
      clearChatSendLifecycle(sessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) return false;
        return state.ui.chatSendLifecycleBySession.delete(normalizedSessionId);
      },
      getChatSendLifecycle(sessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) return 'idle';
        return state.ui.chatSendLifecycleBySession.get(normalizedSessionId) || 'idle';
      },
      getChatTimelineRowModelEnabled(sessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) return false;
        return state.ui.chatTimelineRowModelBySession?.get(normalizedSessionId) === true;
      },
      recordChatTimelineRolloutSignal(sessionId, signal, details) {
        calls.rolloutSignals.push({ sessionId, signal, details });
        return { logged: true, count: calls.rolloutSignals.length };
      },
      ...callbackOverrides,
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
      onStreamEnvelope(listener) {
        envelopeListener = listener;
        return () => {
          envelopeListener = null;
        };
      },
    },
  });
  return {
    state,
    calls,
    handler,
    multiStreamController,
    async emit(payload) {
      await streamListener(payload);
    },
    async emitEnvelope(envelope) {
      await envelopeListener(envelope);
    },
    restore() {
      global.window = previousWindow;
      global.requestAnimationFrame = previousRequestAnimationFrame;
      global.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
}

test('stream lifecycle degrades when the bridge has no stream subscription method', () => {
  const harness = createLifecycleHarness();

  assert.doesNotThrow(() => {
    const unsubscribe = harness.lifecycle.registerStreamHandler({ chat: {} });
    assert.equal(unsubscribe, null);
  });
  assert.equal(
    harness.logs.some((entry) => entry.level === 'WARN' && entry.eventName === 'stream.listener_unavailable'),
    true
  );

  harness.lifecycle.dispose();
  assert.equal(harness.pendingStreamCommitQueue.disposed, true);
});

test('stream lifecycle logs unsubscribe failures and still re-subscribes', () => {
  const harness = createLifecycleHarness();
  let subscriptionCount = 0;
  let unsubscribeCalls = 0;
  const shell = {
    chat: {
      onStream() {
        subscriptionCount += 1;
        return () => {
          unsubscribeCalls += 1;
          throw new Error('unsubscribe failed');
        };
      },
    },
  };

  assert.doesNotThrow(() => harness.lifecycle.registerStreamHandler(shell));
  assert.doesNotThrow(() => harness.lifecycle.registerStreamHandler(shell));

  assert.equal(subscriptionCount, 2);
  assert.equal(unsubscribeCalls, 1);
  assert.equal(
    harness.logs.some((entry) => entry.level === 'WARN' && entry.eventName === 'stream.unsubscribe_failed'),
    true
  );

  harness.lifecycle.dispose();
});

test('stream lifecycle logs subscribe failures instead of throwing from partial bridges', () => {
  const harness = createLifecycleHarness();

  assert.doesNotThrow(() => {
    const unsubscribe = harness.lifecycle.registerStreamHandler({
      chat: {
        onStream() {
          throw new Error('subscribe failed');
        },
      },
    });
    assert.equal(unsubscribe, null);
  });
  assert.equal(
    harness.logs.some((entry) => entry.level === 'WARN' && entry.eventName === 'stream.listener_subscribe_failed'),
    true
  );

  harness.lifecycle.dispose();
});

test('stream lifecycle falls back to legacy stream events when envelope subscription throws', async () => {
  const legacyPayloads = [];
  const harness = createLifecycleHarness({
    isStreamEnvelopeV2Enabled: () => true,
    handleStreamPayload: async (payload) => {
      legacyPayloads.push(payload);
      return { buffered: false, terminal: false };
    },
  });
  let legacyListener = null;

  const unsubscribe = harness.lifecycle.registerStreamHandler({
    chat: {
      onStreamEnvelope() {
        throw new Error('envelope subscribe failed');
      },
      onStream(listener) {
        legacyListener = listener;
        return () => {
          legacyListener = null;
        };
      },
    },
  });

  assert.equal(typeof unsubscribe, 'function');
  assert.equal(typeof legacyListener, 'function');
  await legacyListener({ type: 'started', streamId: 'stream-fallback', sessionId: 'session-1' });
  assert.deepEqual(legacyPayloads, [{ type: 'started', streamId: 'stream-fallback', sessionId: 'session-1' }]);
  assert.equal(
    harness.logs.some((entry) => entry.level === 'INFO' && entry.eventName === 'stream.envelope_v2_legacy_fallback'),
    true
  );

  harness.lifecycle.dispose();
});

test('stream lifecycle resyncs to envelope mode after the initial feature-state pull lands', async () => {
  // Live boot order repro: registerStreamHandler runs while the placeholder
  // feature flags are in state (stream_envelope_v2 unreadable -> legacy mode);
  // the real flags then arrive via the features.getState() pull, which does
  // NOT fire features.onChanged. resyncStreamSubscriptionMode() is the
  // explicit post-bootstrap hook that must flip the live subscription.
  let envelopeEnabled = false;
  const envelopePayloads = [];
  const legacyPayloads = [];
  const harness = createLifecycleHarness({
    isStreamEnvelopeV2Enabled: () => envelopeEnabled,
    handleStreamPayload: async (payload) => {
      legacyPayloads.push(payload);
      return { buffered: false, terminal: false };
    },
    handleStreamEnvelope: async (envelope) => {
      envelopePayloads.push(envelope);
      return { buffered: false, terminal: false };
    },
  });
  let legacyListener = null;
  let envelopeListener = null;
  const shell = {
    chat: {
      onStream(listener) {
        legacyListener = listener;
        return () => {
          legacyListener = null;
        };
      },
      onStreamEnvelope(listener) {
        envelopeListener = listener;
        return () => {
          envelopeListener = null;
        };
      },
    },
  };

  harness.lifecycle.registerStreamHandler(shell);
  assert.equal(typeof legacyListener, 'function');
  assert.equal(envelopeListener, null);

  // Resync with an unchanged flag must not churn the subscription.
  assert.equal(harness.lifecycle.resyncStreamSubscriptionMode(), null);
  assert.equal(typeof legacyListener, 'function');

  // The features.getState() pull resolves: the flag was actually on.
  envelopeEnabled = true;
  harness.lifecycle.resyncStreamSubscriptionMode();

  assert.equal(legacyListener, null);
  assert.equal(typeof envelopeListener, 'function');
  assert.equal(
    harness.logs.some((entry) => entry.level === 'INFO' && entry.eventName === 'stream.envelope_v2_resubscribe'),
    true
  );

  await envelopeListener({ eventKind: 'terminal', streamId: 'stream-resync', channel: 'control' });
  assert.equal(envelopePayloads.length, 1);
  assert.equal(legacyPayloads.length, 0);

  harness.lifecycle.dispose();
});

test('stream lifecycle resync before any registration is a safe no-op', () => {
  const harness = createLifecycleHarness({ isStreamEnvelopeV2Enabled: () => true });

  assert.equal(harness.lifecycle.resyncStreamSubscriptionMode(), null);
  assert.equal(harness.logs.length, 0);

  harness.lifecycle.dispose();
});

test('duplicate V2 envelope sequences are dropped before they replay visible deltas', async (t) => {
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      features: {
        featureFlags: {
          stream_envelope_v2: true,
        },
      },
    },
    callbackOverrides: {
      appendClientLog(level, eventName, details) {
        logs.push({ level, eventName, details });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emitEnvelope({
    schemaVersion: 2,
    eventKind: 'started',
    channel: 'control',
    streamId: 'stream-envelope-duplicate',
    turnId: 'turn-envelope-duplicate',
    sessionId: 'session-1',
    payload: { type: 'started' },
  });
  const responseDelta = {
    schemaVersion: 2,
    eventKind: 'delta',
    channel: 'response',
    streamId: 'stream-envelope-duplicate',
    turnId: 'turn-envelope-duplicate',
    sessionId: 'session-1',
    sequence: 1,
    channelSequence: 1,
    phase: { phaseId: 'phase_text_duplicate', phaseKind: 'text', iteration: 1 },
    payload: { delta: 'Hello' },
  };

  await harness.emitEnvelope(responseDelta);
  await harness.emitEnvelope({ ...responseDelta });

  const messages = harness.state.messagesBySession.get('session-1');
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.ok(assistant);
  assert.equal(assistant.content, 'Hello');
  const regressionLog = logs.find((entry) => entry.eventName === 'stream.envelope_v2_sequence_regression');
  assert.ok(regressionLog);
  assert.equal(regressionLog.level, 'WARN');
  assert.equal(regressionLog.details.expectedSequence, 2);
});

test('mid-stream cancellation commits partial text, clears throbber, and settles lifecycle', async (t) => {
  // started → delta(partial) → error(cancelled) must not leave a streaming
  // bubble or pending lifecycle behind. Before A1, the projection pipeline
  // could keep a phantom row whose dedup_source rank flipped after the
  // error settled; this test asserts that the partial content is committed
  // to the assistant message and lifecycle ends in an idle/terminal state.
  const frames = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frames.requestAnimationFrame,
    cancelAnimationFrameImpl: frames.cancelAnimationFrame,
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-cancel-mid' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-cancel-mid',
    content: 'Partial ',
    aggregate: 'Partial ',
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-cancel-mid',
    content: 'answer',
    aggregate: 'Partial answer',
  });
  await frames.drainNextFrame();

  const midStream = harness.state.messagesBySession.get('session-1')
    .find((message) => message.streamId === 'stream-cancel-mid');
  assert.equal(midStream.content, 'Partial answer');
  assert.equal(midStream.status, 'streaming');
  assert.equal(
    harness.state.ui.chatSendLifecycleBySession.get('session-1'),
    'streaming',
    'lifecycle should be streaming mid-flight'
  );

  await harness.emit({
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-cancel-mid',
    message: 'cancelled by user',
    status: 'cancelled',
    terminal_subcode: 'user_cancelled',
  });

  const settled = harness.state.messagesBySession.get('session-1')
    .find((message) => message.streamId === 'stream-cancel-mid');
  assert.ok(settled, 'partial assistant message must persist after cancellation');
  assert.equal(
    settled.content.includes('Partial'),
    true,
    'partial text must remain after cancellation rather than being wiped'
  );
  assert.notEqual(settled.status, 'streaming', 'status must leave streaming after cancellation');
  assert.notEqual(
    harness.state.ui.chatSendLifecycleBySession.get('session-1'),
    'streaming',
    'lifecycle must leave streaming after cancellation terminal'
  );

  const liveState = harness.state.ui.chatTimelineLiveStateBySession?.get('session-1');
  // After cancellation the provisional turn should clear or settle — it must
  // not be left active+streaming, which would re-show the throbber on the
  // next render.
  if (liveState && liveState.turns_by_id && liveState.turns_by_id['stream-cancel-mid']) {
    const turn = liveState.turns_by_id['stream-cancel-mid'];
    const assistantTextRow = (turn.rows || []).find((row) => row.kind === 'assistant_text');
    if (assistantTextRow) {
      assert.notEqual(
        assistantTextRow.payload?.streaming,
        true,
        'cancelled turn must not still be flagged as streaming'
      );
    }
  }
});

test('two concurrent streams on different turns project rows into distinct turn buckets', async (t) => {
  // Multi-stream collision: two streams in the same session each emit text
  // segments. The reducer must keep their rows on separate turns and the
  // dedup index must not collapse rows that share neither turn nor
  // primary_message_id.
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-collide-a' });
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-collide-b' });

  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-collide-a',
    content: 'A1 ',
    aggregate: 'A1 ',
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-collide-b',
    content: 'B1 ',
    aggregate: 'B1 ',
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-collide-a',
    content: 'A2',
    aggregate: 'A1 A2',
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-collide-b',
    content: 'B2',
    aggregate: 'B1 B2',
  });

  const liveState = harness.state.ui.chatTimelineLiveStateBySession.get('session-1');
  assert.ok(liveState, 'row-model live state must exist for concurrent streams');
  const turnA = liveState.turns_by_id['stream-collide-a'];
  const turnB = liveState.turns_by_id['stream-collide-b'];
  assert.ok(turnA, 'turn A must be retained');
  assert.ok(turnB, 'turn B must be retained');
  const textA = turnA.rows.find((row) => row.kind === 'assistant_text');
  const textB = turnB.rows.find((row) => row.kind === 'assistant_text');
  assert.ok(textA, 'turn A assistant_text row must exist');
  assert.ok(textB, 'turn B assistant_text row must exist');
  assert.equal(textA.payload.text, 'A1 A2');
  assert.equal(textB.payload.text, 'B1 B2');
  assert.notEqual(textA.payload.text, textB.payload.text, 'streams must not cross-contaminate');

  const messageA = harness.state.messagesBySession.get('session-1')
    .find((message) => message.streamId === 'stream-collide-a');
  const messageB = harness.state.messagesBySession.get('session-1')
    .find((message) => message.streamId === 'stream-collide-b');
  assert.ok(messageA && messageB, 'both streams must each commit an assistant message');
  assert.notEqual(messageA.id, messageB.id, 'concurrent streams must keep distinct message ids');
});

test('tool approval mid-stream preserves the already-streamed assistant_text row', async (t) => {
  // Approval-mid-stream: after partial text, a tool_use arrives followed by
  // tool_approval_needed. The text row that already streamed must survive
  // both events, and a tool_call row must be appended ordered after it. In the
  // trace-shaped reducer an awaiting-approval tool with no result is a single
  // tool_call row (no separate tool_result row until a result arrives).
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-approval-mid' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-approval-mid',
    content: 'I will read the file. ',
    aggregate: 'I will read the file. ',
  });

  const beforeApproval = harness.state.ui.chatTimelineLiveStateBySession
    .get('session-1').turns_by_id['stream-approval-mid'];
  assert.equal(
    beforeApproval.rows.filter((row) => row.kind === 'assistant_text').length,
    1,
    'text row must exist before approval'
  );

  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-approval-mid',
    callId: 'call-approval-mid',
    toolName: 'Read',
    status: 'pending_approval',
    summary: 'Read notes.md',
  });
  await harness.emit({
    type: 'tool_approval_needed',
    sessionId: 'session-1',
    streamId: 'stream-approval-mid',
    callId: 'call-approval-mid',
    toolName: 'Read',
    summary: 'Read notes.md',
  });

  const afterApproval = harness.state.ui.chatTimelineLiveStateBySession
    .get('session-1').turns_by_id['stream-approval-mid'];
  const textRows = afterApproval.rows.filter((row) => row.kind === 'assistant_text');
  const toolRows = afterApproval.rows.filter((row) => row.kind === 'tool_call');
  assert.equal(textRows.length, 1, 'mid-stream text must survive approval');
  assert.equal(textRows[0].payload.text, 'I will read the file. ');
  assert.equal(toolRows.length, 1, 'approval must produce one tool_call row');
  assert.equal(toolRows[0].tool_call_id, 'call-approval-mid');
  assert.equal(
    toolRows[0].payload.state,
    'awaiting_approval',
    'an awaiting-approval tool with no result must be in awaiting_approval state'
  );
  // No tool_result row may exist yet — the result has not arrived. Trace mode
  // only emits the tool_result row once a tool_result event is seen.
  assert.equal(
    afterApproval.rows.filter((row) => row.kind === 'tool_result').length,
    0,
    'awaiting-approval tool must not yet produce a tool_result row'
  );

  // Row order: assistant_text must come before tool_call (text streamed first).
  const textIndex = afterApproval.rows.findIndex((row) => row.kind === 'assistant_text');
  const toolIndex = afterApproval.rows.findIndex((row) => row.kind === 'tool_call');
  assert.ok(textIndex < toolIndex, 'streamed text must remain ordered before approval tool row');
});

// ---------------------------------------------------------------------------
// context_usage seam: the ephemeral composer-ring snapshot must reach the
// context-usage store through the handler map and touch nothing else. Before
// this event existed the store was written only at the turn's terminal, so a
// long agentic turn rendered the PREVIOUS turn's number the whole way through.
// ---------------------------------------------------------------------------

test('context_usage reaches the context-usage store without touching message state', async (t) => {
  const usageWrites = [];
  const harness = createHarness({
    callbackOverrides: {
      updateContextUsage(sessionId, payload) {
        usageWrites.push({ sessionId, payload });
        return null;
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-ring' });
  const messagesBefore = harness.state.messagesBySession.get('session-1').length;

  await harness.emit({
    type: 'context_usage',
    sessionId: 'session-1',
    streamId: 'stream-ring',
    phase: 'iteration',
    iteration: 2,
    usage: {
      context_used_tokens: 9000,
      context_used_source: 'estimate',
      compact_threshold_tokens: 20000,
      context_window: 40000,
      model: 'test-model',
    },
  });

  assert.equal(usageWrites.length, 1, 'the snapshot is forwarded to the store exactly once');
  assert.equal(usageWrites[0].sessionId, 'session-1');
  assert.equal(usageWrites[0].payload.usage.context_used_tokens, 9000);
  assert.equal(usageWrites[0].payload.streamId, 'stream-ring', 'turn scoping survives the seam');
  assert.equal(
    harness.state.messagesBySession.get('session-1').length,
    messagesBefore,
    'a meter snapshot must never create or mutate a message row'
  );
});

test('a context_usage snapshot after the turn terminal never reaches the store', async (t) => {
  const usageWrites = [];
  const harness = createHarness({
    callbackOverrides: {
      updateContextUsage(sessionId, payload) {
        usageWrites.push({ sessionId, payload });
        return null;
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-ring-late' });
  await harness.emit({
    type: 'complete', sessionId: 'session-1', streamId: 'stream-ring-late', content: 'done',
  });
  const writesAfterTerminal = usageWrites.length;
  assert.equal(writesAfterTerminal, 1, 'precondition: the terminal itself wrote the authoritative reading');

  await harness.emit({
    type: 'context_usage',
    sessionId: 'session-1',
    streamId: 'stream-ring-late',
    phase: 'iteration',
    usage: { context_used_tokens: 100 },
  });

  assert.equal(usageWrites.length, writesAfterTerminal, 'the late snapshot is dropped at the gate');
});
