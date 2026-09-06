const { createStreamHandler } = require('../../renderer/chat/renderer-stream-handler');
const { createMultiStreamController } = require('../../renderer/chat/renderer-multi-stream-utils');
const { mergeReasoningEntries } = require('../../renderer/chat/chat-message-utils');

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
    pendingCount() {
      return callbacks.size;
    },
  };
}

function createManualTimerController() {
  let nextHandle = 1;
  const callbacks = new Map();
  return {
    setTimeout(callback, delayMs = 0) {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, { callback, delayMs });
      return handle;
    },
    clearTimeout(handle) {
      callbacks.delete(handle);
    },
    pendingDelays() {
      return [...callbacks.values()].map((entry) => entry.delayMs);
    },
    pendingCount() {
      return callbacks.size;
    },
  };
}

async function flushMicrotasks(count = 1) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

// Waits for an observable condition instead of sleeping a fixed span. The
// throttled-render case used `setTimeout(resolve, 90)` to outlast production's
// 32 ms rAF-fallback timer; under load that 90 ms of WALL CLOCK can pass without
// the fallback callback and its microtasks getting scheduled, and the test
// failed 4 runs in 8 at 2.4x CPU oversubscription. Polling keeps the same
// oracle -- production still has to commit, or this throws -- without pinning
// the assertion to the scheduler.
async function waitUntil(predicate, { timeoutMs = 5000, pollMs = 5, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    await flushMicrotasks(5);
  }
}

function createHarness(options = {}) {
  const {
    requestAnimationFrameImpl = null,
    cancelAnimationFrameImpl = null,
    callbackOverrides = {},
    stateOverrides = {},
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
  const defaultMessagesBySession = new Map([['session-1', []], ['session-2', []], ['session-3', []], ['session-4', []]]);
  const state = {
    currentSessionId: 'session-1',
    ui: { activeView: 'chat', chatSendLifecycleBySession: new Map() },
    messagesBySession: stateOverrides.messagesBySession || defaultMessagesBySession,
    interactiveDraftsBySession: new Map(),
    sessions: [{ id: 'session-1' }, { id: 'session-2' }, { id: 'session-3' }, { id: 'session-4' }],
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
      // The shared reasoning merger applies snapshots and append-edits.
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
        if (!normalizedSessionId) {
          return 'idle';
        }
        state.ui.chatSendLifecycleBySession.set(normalizedSessionId, lifecycle);
        return lifecycle;
      },
      clearChatSendLifecycle(sessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
          return false;
        }
        return state.ui.chatSendLifecycleBySession.delete(normalizedSessionId);
      },
      getChatSendLifecycle(sessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
          return 'idle';
        }
        return state.ui.chatSendLifecycleBySession.get(normalizedSessionId) || 'idle';
      },
      getChatTimelineRowModelEnabled(sessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
          return false;
        }
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
    restore() {
      global.window = previousWindow;
      global.requestAnimationFrame = previousRequestAnimationFrame;
      global.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
}

module.exports = {
  createHarness,
  createManualTimerController,
  createQueuedFrameController,
  flushMicrotasks,
  waitUntil,
};
