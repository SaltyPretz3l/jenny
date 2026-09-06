const test = require('node:test');
const assert = require('node:assert/strict');

const { createStreamHandler } = require('../renderer/chat/renderer-stream-handler');
const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');

function createHarness() {
  const previousWindow = global.window;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  global.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  global.cancelAnimationFrame = () => {};
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
    ui: {
      activeView: 'chat',
      chatSendLifecycleBySession: new Map(),
      chatTimelineRowModelBySession: new Map([['session-1', true]]),
    },
    messagesBySession: new Map([['session-1', []]]),
    interactiveDraftsBySession: new Map(),
    sessions: [{ id: 'session-1' }],
    pendingStreams: new Map(),
    streamThinkingStatusByStream: new Map(),
    toolCallsByStream: new Map(),
    pendingToolApprovals: new Map(),
    bufferedStreamEventsByStream: new Map(),
  };
  let streamListener = null;
  const multiStreamController = createMultiStreamController({
    getState: () => state,
    appendClientLog() {},
  });
  const handler = createStreamHandler({
    state,
    thinkingIndicator: null,
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
      syncTurnElapsedClock() {},
      renderSessions() {},
      renderSettings() {},
      renderComposerState() {},
      renderComposerStatusNotice() {},
      renderWorkspaceChrome() {},
      getSessionMessages(sessionId) { return state.messagesBySession.get(sessionId) || []; },
      setSessionMessages(sessionId, messages) { state.messagesBySession.set(sessionId, messages); },
      setSessionTurnEventState() {},
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
      handlePresenceStreamEvent() {},
      getInteractiveComposerStatusNotice() { return ''; },
      persistInteractiveFallbackRequest: async () => {},
      requestInteractiveGuardrailAnswer: async () => {},
      requestInteractiveProtocolDriftAnswer: async () => {},
      queueInteractiveComposerFocus() {},
      mergeMessageReasoning(message, reasoning) {
        if (!reasoning || !Array.isArray(reasoning.entriesDelta)) {
          return message.reasoning || { source: 'none', entries: [] };
        }
        return { source: 'provider', entries: reasoning.entriesDelta };
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
      getChatTimelineRowModelEnabled(sessionId) {
        return state.ui.chatTimelineRowModelBySession.get(sessionId) === true;
      },
      recordChatTimelineRolloutSignal() {
        return { logged: true, count: 1 };
      },
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
    state,
    async emit(payload) {
      await streamListener(payload);
    },
    restore() {
      handler.dispose();
      global.window = previousWindow;
      global.requestAnimationFrame = previousRequestAnimationFrame;
      global.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
}

test('stream handler carries optional phase summaries into live phase state', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({
    type: 'started',
    sessionId: 'session-1',
    streamId: 'stream-phase-summary',
  });
  await harness.emit({
    type: 'phase_started',
    sessionId: 'session-1',
    streamId: 'stream-phase-summary',
    phaseId: 'phase-summary',
    phaseKind: 'reasoning',
    thinkingId: 'think-summary',
    summary: 'Inspecting the workspace map',
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-phase-summary',
    content: 'Starting summary.',
    aggregate: 'Starting summary.',
  });

  const assistantMessage = harness.state.messagesBySession.get('session-1')
    .find((message) => message.streamId === 'stream-phase-summary');
  const liveState = harness.state.ui.chatTimelineLiveStateBySession.get('session-1');
  const liveTurn = liveState.turns_by_id['stream-phase-summary'];

  assert.equal(assistantMessage.reasoning_phases[0].summary, 'Inspecting the workspace map');
  assert.equal(liveTurn.events[1].payload.summary, 'Inspecting the workspace map');
});

test('stream handler preserves and bounds phase summaries across completion updates', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const longSummary = ` ${'phase summary '.repeat(40)} `;

  await harness.emit({
    type: 'started',
    sessionId: 'session-1',
    streamId: 'stream-phase-summary-bounds',
  });
  await harness.emit({
    type: 'phase_started',
    sessionId: 'session-1',
    streamId: 'stream-phase-summary-bounds',
    phaseId: 'phase-summary-bounds',
    phaseKind: 'reasoning',
    thinkingId: 'think-summary-bounds',
    summary: longSummary,
  });
  await harness.emit({
    type: 'phase_completed',
    sessionId: 'session-1',
    streamId: 'stream-phase-summary-bounds',
    phaseId: 'phase-summary-bounds',
    phaseKind: 'reasoning',
    thinkingId: 'think-summary-bounds',
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-phase-summary-bounds',
    content: 'Done.',
    aggregate: 'Done.',
  });

  const assistantMessage = harness.state.messagesBySession.get('session-1')
    .find((message) => message.streamId === 'stream-phase-summary-bounds');
  const summary = assistantMessage.reasoning_phases[0].summary;

  assert.equal(summary.length <= 240, true);
  assert.equal(summary.endsWith('...'), true);
  assert.doesNotMatch(summary, /\s{2,}/);
});
