const test = require('node:test');
const assert = require('node:assert/strict');

const { createSendController } = require('../renderer/chat/renderer-send-utils');
const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');

function createHarness(options = {}) {
  const state = {
    activeStreamId: '',
    activeStreamSessionId: '',
    backend: { phase: 'ready' },
    auth: { authenticated: true },
    attachments: { queued: Array.isArray(options.attachments) ? options.attachments.map((entry) => ({ ...entry })) : [] },
    currentSessionId: options.currentSessionId !== undefined ? options.currentSessionId : 'session-1',
    queuedSendBySession: new Map(options.queuedSends || []),
    sessions: Array.isArray(options.sessions)
      ? options.sessions.map((session) => ({ ...session }))
      : [{ id: 'session-1', title: 'Session 1' }],
    messagesBySession: new Map(options.messagesBySession || [['session-1', []]]),
    turnEventsBySession: new Map(),
    interactiveDraftsBySession: new Map(),
    sessionMessageAccessOrder: new Map(),
    bufferedStreamEventsByStream: new Map(),
    streamThinkingStatusByStream: new Map(),
    pendingStreams: new Map(),
    pendingToolApprovals: new Map(),
    sendPreflight: null,
    ui: { chatSendLifecycleBySession: new Map() },
  };
  const chatInput = { value: String(options.chatInputValue || ''), disabled: false };
  const calls = {
    startStream: [],
    cancelStream: [],
    errors: [],
    logs: [],
    publishCancelImpulse: [],
    resetQueue: 0,
    restoreQueuedSendDraft: [],
    sessionPatches: [],
  };
  const originalWindow = global.window;
  const originalComposerSessionStateController = global.rendererComposerSessionStateController;
  const multiStreamController = createMultiStreamController({
    getState: () => state,
    appendClientLog() {},
  });

  if (options.trackQueuedRestore) {
    global.rendererComposerSessionStateController = {
      captureActive(sessionId, reason) {
        if (reason === 'queued_restore') calls.restoreQueuedSendDraft.push(sessionId);
      },
    };
  }

  global.window = {
    jennyShell: {
      chat: {
        async startStream(payload) {
          calls.startStream.push(payload);
          if (typeof options.startStream === 'function') {
            return options.startStream(payload);
          }
          throw new Error('backend unavailable');
        },
        async cancelStream(streamId) {
          calls.cancelStream.push(streamId);
          if (typeof options.cancelStream === 'function') {
            return options.cancelStream(streamId, state);
          }
          return { ok: true };
        },
      },
    },
  };

  const controller = createSendController({
    state,
    dom: { chatInput },
    multiStreamController,
    slashCommandRegistry: null,
    constants: {
      MESSAGE_STATUS: { STREAMING: 'streaming', COMPLETE: 'complete', ERROR: 'error' },
      INTERACTIVE_GUARDRAIL_PROMPT: 'Guardrail prompt',
      INTERACTIVE_SEQUENCE_IDLE: 'idle',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
      TOAST_SOURCE: { attachments: 'attachments' },
      MAX_INTERACTIVE_ROUNDS: 3,
    },
    callbacks: {
      getActiveSession: () => state.sessions.find((session) => session.id === state.currentSessionId) || null,
      getPendingQuestionBatch: () => null,
      normalizePendingQuestionBatch: () => null,
      shouldForceInteractiveGuardrail: () => false,
      getInteractiveSequenceState: () => 'idle',
      clearInteractiveDraft: () => {},
      patchSessionSummary: (sessionId, patch) => {
        const normalizedSessionId = String(sessionId || '').trim();
        calls.sessionPatches.push({ sessionId: normalizedSessionId, patch: { ...(patch || {}) } });
        state.sessions = state.sessions.map((session) =>
          String(session?.id || '').trim() === normalizedSessionId ? { ...session, ...(patch || {}) } : session
        );
      },
      getCurrentRuntimePreferences: () => ({
        preferredModel: '',
        reasoningEffort: 'default',
        conversationMode: 'chat',
        contextPreferences: {
          historyScope: 'session',
          includePersonality: true,
          includeMemory: true,
        },
        planMode: false,
      }),
      getCurrentVisibleMessages: () => state.messagesBySession.get(state.currentSessionId) || [],
      getCurrentSessionMessages: () => state.messagesBySession.get(state.currentSessionId) || [],
      getSessionTurnEventState: () => ({ turnEvents: [] }),
      getSessionMessages: (sessionId) => state.messagesBySession.get(String(sessionId || '').trim()) || [],
      setSessionMessages: (sessionId, nextMessages) => {
        state.messagesBySession.set(String(sessionId || '').trim(), nextMessages);
      },
      createNormalizedMessage: (role, content, extra = {}) => ({
        id: extra.id || `${role}_local`,
        role,
        content,
        ...extra,
        attachments: extra.attachments || [],
        status: extra.status || 'complete',
      }),
      resolveSessionId: (sessionId) => String(sessionId || '').trim(),
      buildAttachmentBudget: (entries) => ({
        accepted: Array.isArray(entries) ? entries.map((entry) => ({ ...entry })) : [],
        skipped: [],
      }),
      resetAttachmentQueue: () => {
        calls.resetQueue += 1;
        state.attachments.queued = [];
      },
      showToastMessage: () => {},
      clearComposerStatusNotice: () => {},
      setComposerStatusNotice: () => {},
      showComposerActionError: (error, title) => {
        calls.errors.push({ title, message: error?.message || String(error) });
      },
      renderComposerState: () => {},
      renderMessages: () => {},
      renderSessions: () => {},
      renderHeader: () => {},
      syncComposerInputHeight: () => {},
      syncComposerVisualState: () => {},
      setFollowLatest: () => {},
      appendClientLog: (level, event, details) => {
        calls.logs.push({ level, event, details });
      },
      refreshSessionSummaries: async () => ({
        currentSessionId: state.currentSessionId,
        validSessionIds: new Set(state.sessions.map((session) => session.id)),
      }),
      thinkingController: { resumeAutoScroll: () => {} },
      optimisticAppend: (sessionId, role, content, extra = {}) => {
        const message = {
          id: extra.id || `${role}_${Date.now()}`,
          role,
          content,
          attachments: extra.attachments || [],
        };
        state.messagesBySession.set(sessionId, [...(state.messagesBySession.get(sessionId) || []), message]);
        return message;
      },
      flushBufferedStreamEvents: async () => ({ flushedCount: 0, terminal: false }),
      dropBufferedStreamEvents: () => {},
      isSendBusy: () => false,
      isSessionStreaming: () => false,
      hasPendingToolApprovalForSession: () => false,
      getCurrentMessageById: () => null,
      getElaboratePrompt: () => '',
      getLatestReplyAssistantMessageId: () => '',
      resolveRegenerateRequest: () => null,
      showCopyFeedback: () => {},
      upsertSessionSummary: (summary) => {
        const normalized = summary && typeof summary === 'object' ? { ...summary } : null;
        const sessionId = String(normalized?.id || '').trim();
        if (!sessionId) return null;
        const existingIndex = state.sessions.findIndex((session) => String(session?.id || '').trim() === sessionId);
        if (existingIndex === -1) {
          state.sessions = [normalized, ...state.sessions];
          return normalized;
        }
        state.sessions[existingIndex] = { ...state.sessions[existingIndex], ...normalized };
        return state.sessions[existingIndex];
      },
      removeSessionState: () => {},
      rekeySessionState: (_from, to) => to,
      attachPendingOriginToSession: () => {},
      rekeySessionOrigin: () => {},
      onUserSendStarted: () => {},
      getToolPreferences: () => ({}),
      setChatSendLifecycle: (sessionId, lifecycle) => {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) return 'idle';
        state.ui.chatSendLifecycleBySession.set(normalizedSessionId, lifecycle);
        return lifecycle;
      },
      clearChatSendLifecycle: (sessionId) => state.ui.chatSendLifecycleBySession.delete(String(sessionId || '').trim()),
      moveChatSendLifecycle: (_from, to) => {
        if (to) state.ui.chatSendLifecycleBySession.set(to, 'preflight');
        return 'preflight';
      },
      publishCancelImpulse: (payload) => calls.publishCancelImpulse.push(payload),
    },
  });

  return {
    controller,
    state,
    chatInput,
    calls,
    multiStreamController,
    restore() {
      global.window = originalWindow;
      global.rendererComposerSessionStateController = originalComposerSessionStateController;
    },
  };
}

const imageAttachment = {
  id: 'image-1',
  kind: 'image',
  displayName: 'capture.png',
  mimeType: 'image/png',
  sizeBytes: 128,
  width: 10,
  height: 10,
  assetPath: 'C:/attachments/capture.png',
  sourceKind: 'capture',
};

test('handleStopActiveStream keeps a queued send in the outbox when cancel is refused', async (t) => {
  const harness = createHarness({ cancelStream: async () => false, trackQueuedRestore: true });
  t.after(() => harness.restore());
  harness.multiStreamController.registerStream('session-1', 'stream-1');
  harness.controller.stashQueuedSendForSession('session-1', { prompt: 'queued prompt' });

  const result = await harness.controller.handleStopActiveStream();

  assert.equal(result, null);
  assert.deepEqual(harness.calls.restoreQueuedSendDraft, []);
  assert.ok(harness.controller.getQueuedSend('session-1'));
});

test('handleStopActiveStream restores a queued send once when cancel is accepted', async (t) => {
  const harness = createHarness({ cancelStream: async () => ({ ok: true }), trackQueuedRestore: true });
  t.after(() => harness.restore());
  harness.multiStreamController.registerStream('session-1', 'stream-1');
  harness.controller.stashQueuedSendForSession('session-1', { prompt: 'queued prompt' });

  const result = await harness.controller.handleStopActiveStream();

  assert.deepEqual(result, { streamId: 'stream-1', sessionId: 'session-1' });
  assert.deepEqual(harness.calls.restoreQueuedSendDraft, ['session-1']);
  assert.equal(harness.calls.publishCancelImpulse.length, 1);
});

// The cancelled terminal can reach the outbox drain before the cancel IPC
// resolves. A drain that follows a user Stop must hand the entry back (null
// makes the terminal handler restore it), never dispatch it as a new turn.
// A ready (already context-captured) entry, seeded the way the dispatch tests
// below do it: a freshly stashed entry sits in capturing_context and would make
// any "the drain did not dispatch" assertion vacuous.
const readyQueuedSend = () => ({ sessionId: 'session-1', prompt: 'queued prompt', attachments: [], createdAt: 123 });

test('a terminal drain that lands before the cancel reply holds the queued send instead of sending it', async (t) => {
  let drainResult = 'unset';
  const harness = createHarness({
    trackQueuedRestore: true,
    queuedSends: [['session-1', readyQueuedSend()]],
    cancelStream: async () => {
      harness.multiStreamController.clearStream('stream-1');
      drainResult = await harness.controller.dispatchQueuedSendForSession('session-1');
      return { ok: true };
    },
  });
  t.after(() => harness.restore());
  harness.multiStreamController.registerStream('session-1', 'stream-1');

  await harness.controller.handleStopActiveStream();

  assert.equal(drainResult, null, 'the drain was held');
  assert.deepEqual(harness.calls.startStream, [], 'nothing was auto-sent after Stop');
  assert.deepEqual(harness.calls.restoreQueuedSendDraft, ['session-1'], 'the entry went back to the composer once');
});

test('a refused cancel releases the hold so the next drain dispatches normally', async (t) => {
  const harness = createHarness({
    trackQueuedRestore: true,
    queuedSends: [['session-1', readyQueuedSend()]],
    cancelStream: async () => false,
  });
  t.after(() => harness.restore());
  harness.multiStreamController.registerStream('session-1', 'stream-1');

  await harness.controller.handleStopActiveStream();
  harness.multiStreamController.clearStream('stream-1');
  await harness.controller.dispatchQueuedSendForSession('session-1');

  assert.equal(harness.calls.startStream.length, 1, 'the refused Stop did not hold the drain');
  assert.deepEqual(harness.calls.restoreQueuedSendDraft, []);
});

test('handleStopActiveStream leaves the queued send when the session switches during cancel', async (t) => {
  const harness = createHarness({
    trackQueuedRestore: true,
    cancelStream: async (_streamId, state) => {
      state.currentSessionId = 'session-2';
      return { ok: true };
    },
  });
  t.after(() => harness.restore());
  harness.multiStreamController.registerStream('session-1', 'stream-1');
  harness.controller.stashQueuedSendForSession('session-1', { prompt: 'queued prompt' });

  await harness.controller.handleStopActiveStream();

  assert.deepEqual(harness.calls.restoreQueuedSendDraft, []);
  assert.ok(harness.controller.getQueuedSend('session-1'));
});

test('stashQueuedSendForSession preserves source/meta and clones queued attachments', (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const queued = harness.controller.stashQueuedSendForSession('session-1', {
    prompt: 'queued prompt',
    attachments: [{ ...imageAttachment, metadata: { label: 'before' } }],
    runtimePreferences: {
      contextPreferences: { historyScope: 'recent' },
    },
    createdAt: 789,
    source: 'composer',
    meta: { reason: 'streaming' },
  });

  assert.equal(queued.sessionId, 'session-1');
  assert.equal(queued.source, 'composer');
  assert.deepEqual(queued.meta, { reason: 'streaming' });
  assert.deepEqual(queued.attachments, [{ ...imageAttachment, metadata: { label: 'before' } }]);

  queued.attachments[0].metadata.label = 'mutated';
  const stored = harness.controller.getQueuedSend('session-1');
  assert.equal(stored.attachments[0].metadata.label, 'before');
  assert.deepEqual(stored.runtimePreferences, {
    contextPreferences: { historyScope: 'recent' },
  });
});

test('stashQueuedSendForSession scrubs unsafe clone keys and tolerates circular metadata', (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const circularMeta = { label: 'meta' };
  const circularAttachment = { id: 'cycle' };
  circularMeta.self = circularMeta;
  circularAttachment.self = circularAttachment;
  const unsafePayload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"polluted":true},"safe":true}');

  const queued = harness.controller.stashQueuedSendForSession('session-1', {
    prompt: 'queued prompt',
    attachments: [circularAttachment, unsafePayload],
    source: 'composer',
    meta: { circularMeta, unsafePayload },
  });

  assert.equal(queued.meta.circularMeta.self, null);
  assert.equal(queued.attachments[0].self, null);
  assert.deepEqual(queued.meta.unsafePayload, { safe: true });
  assert.deepEqual(queued.attachments[1], { safe: true });
  assert.equal({}.polluted, undefined);
});

test('startPromptSend preserves existing-session draft and annotates optimistic user message on startStream rejection', async (t) => {
  const harness = createHarness({
    chatInputValue: 'keep me',
    attachments: [imageAttachment],
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('keep me', { restoreInputOnError: true });

  assert.equal(result, null);
  assert.equal(harness.chatInput.value, 'keep me');
  assert.deepEqual(harness.state.attachments.queued, [imageAttachment]);
  const messages = harness.state.messagesBySession.get('session-1') || [];
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'keep me');
  assert.equal(messages[0].send_failure?.state, 'failed');
  assert.equal(messages[0].send_failure?.restored_to_composer, true);
  assert.equal(messages[0].send_failure?.error_code, 'CMP-CHAT-0002');
  assert.equal(harness.state.ui.chatSendLifecycleBySession.get('session-1'), 'failed');
  assert.equal(harness.calls.errors.length, 1);
  assert.equal(harness.calls.errors[0].title, 'Send Failed');
});

test('startPromptSend preserves a first-turn failed local thread and restores the draft with attachments', async (t) => {
  const harness = createHarness({
    currentSessionId: '',
    sessions: [],
    messagesBySession: [],
    chatInputValue: 'first turn',
    attachments: [imageAttachment],
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('first turn', { restoreInputOnError: true });

  assert.equal(result, null);
  const localSessionId = String(harness.state.currentSessionId || '').trim();
  assert.equal(localSessionId.startsWith('session_local_'), true);
  assert.equal(harness.chatInput.value, 'first turn');
  assert.deepEqual(harness.state.attachments.queued, [imageAttachment]);
  const messages = harness.state.messagesBySession.get(localSessionId) || [];
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].send_failure?.state, 'failed');
  assert.equal(messages[0].send_failure?.restored_to_composer, true);
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].status, 'error');
  assert.equal(harness.state.ui.chatSendLifecycleBySession.get(localSessionId), 'failed');
  assert.equal(harness.calls.resetQueue, 0);
});

test('dispatchQueuedSendForSession re-stashes a rejected queued send without replacing the visible composer draft', async (t) => {
  const queuedSend = {
    sessionId: 'session-1',
    prompt: 'queued prompt',
    attachments: [imageAttachment],
    runtimePreferences: {
      preferredModel: '',
      reasoningEffort: 'default',
      conversationMode: 'chat',
      contextPreferences: {
        historyScope: 'session',
        includePersonality: true,
        includeMemory: true,
      },
      planMode: false,
    },
    createdAt: 123,
  };
  const harness = createHarness({
    currentSessionId: 'session-2',
    sessions: [{ id: 'session-1', title: 'Queued' }, { id: 'session-2', title: 'Visible' }],
    messagesBySession: [['session-1', []], ['session-2', []]],
    chatInputValue: 'visible draft',
    queuedSends: [['session-1', queuedSend]],
  });
  t.after(() => harness.restore());

  const result = await harness.controller.dispatchQueuedSendForSession('session-1', {
    preserveCurrentSessionOnDispatch: true,
  });

  assert.equal(result, null);
  assert.equal(harness.chatInput.value, 'visible draft');
  assert.deepEqual(harness.state.attachments.queued, []);
  const restoredQueue = harness.state.queuedSendBySession.get('session-1');
  assert.ok(restoredQueue);
  assert.equal(restoredQueue.prompt, 'queued prompt');
  assert.deepEqual(restoredQueue.attachments, [imageAttachment]);
  assert.equal(harness.state.currentSessionId, 'session-2');
});
