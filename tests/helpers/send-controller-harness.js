'use strict';

// Shared jsdom-free harness for the send controller (renderer-send-utils.js).
// Extracted from tests/renderer-send-utils.test.js so multiple test files can
// drive startPromptSend / dispatchQueuedSendForSession against a stubbed shell
// without duplicating ~300 lines of setup (and to keep that test file under the
// 1015-line file-size ceiling).

const { createSendController } = require('../../renderer/chat/renderer-send-utils');
const { createMultiStreamController } = require('../../renderer/chat/renderer-multi-stream-utils');
const {
  getElaboratePrompt,
  getLatestReplyAssistantMessageId,
  resolveRegenerateRequest,
} = require('../../renderer/chat/chat-bubble-action-utils');

function buildMessageSequence() {
  return [
    {
      id: 'user_1',
      role: 'user',
      content: 'Describe this screenshot',
      attachments: [
        {
          id: 'image_1',
          kind: 'image',
          displayName: 'capture.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          width: 320,
          height: 200,
          assetPath: 'C:/attachments/capture.png',
          sourceKind: 'capture',
        },
      ],
    },
    {
      id: 'assistant_1',
      role: 'assistant',
      status: 'complete',
      content: 'It looks like a terminal window.',
    },
  ];
}

function createControllerHarness(messages, options = {}) {
  const state = {
    activeStreamId: '',
    activeStreamSessionId: '',
    backend: { phase: String(options.backendPhase || 'ready') },
    auth: { authenticated: options.authenticated !== false },
    attachments: { queued: [] },
    currentSessionId: 'session-1',
    queuedSendBySession: new Map(),
    sessions: [{ id: 'session-1', title: 'Session 1' }],
    messagesBySession: new Map([['session-1', messages]]),
    turnEventsBySession: options.turnEventsBySession instanceof Map ? options.turnEventsBySession : new Map(),
    interactiveDraftsBySession: new Map(),
    sessionMessageAccessOrder: new Map(),
    bufferedStreamEventsByStream: new Map(),
    streamThinkingStatusByStream: new Map(),
    pendingStreams: new Map(),
    pendingToolApprovals: new Map(),
    sendPreflight: null,
    ui: { activeView: 'chat', chatSendLifecycleBySession: new Map() },
  };
  const chatInput = { value: String(options.chatInputValue || ''), disabled: false };
  const calls = {
    startStream: [],
    editAndRegenerate: [],
    cancelStream: [],
    clipboard: [],
    errors: [],
    logs: [],
    resetQueue: 0,
    optimisticAppend: [],
    cometUserSendStarted: [],
    sessionPatches: [],
    composerNotices: [],
    toasts: [],
    activations: [],
    renderAll: 0,
    renderComposerState: 0,
    clearedProjectionSessions: [],
  };
  const originalWindow = global.window;
  const multiStreamController = createMultiStreamController({
    getState: () => state,
    appendClientLog() {},
  });

  global.window = {
    jennyShell: {
      chat: {
        async startStream(payload) {
          calls.startStream.push(payload);
          if (typeof options.startStream === 'function') return options.startStream(payload);
          return { sessionId: payload.sessionId || 'session-1', streamId: 'stream-regen' };
        },
        async editAndRegenerate(payload) {
          calls.editAndRegenerate.push(payload);
          if (options.editAndRegenerateError) {
            throw options.editAndRegenerateError;
          }
          return options.editAndRegenerateResult || {
            sessionId: payload.sessionId || 'session-1',
            streamId: 'stream-regen',
            identity: { userMessageId: payload.editedMessageId },
          };
        },
        async cancelStream(streamId) {
          calls.cancelStream.push(streamId);
          return { ok: true };
        },
      },
      clipboard: {
        async writeText(value) {
          calls.clipboard.push(String(value || ''));
          return { ok: true };
        },
      },
    },
  };

  const controller = createSendController({
    state,
    dom: { chatInput },
    multiStreamController,
    approvalModeController: options.approvalModeController || null,
    createSendReceiptStore: options.createSendReceiptStore,
    compactionCoordinator: options.compactionCoordinator || null,
    slashCommandRegistry: null,
    constants: {
      MESSAGE_STATUS: {
        STREAMING: 'streaming',
        COMPLETE: 'complete',
        ERROR: 'error',
      },
      INTERACTIVE_GUARDRAIL_PROMPT: 'Guardrail prompt',
      INTERACTIVE_SEQUENCE_IDLE: 'idle',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
      TOAST_SOURCE: {
        attachments: 'attachments',
      },
      MAX_INTERACTIVE_ROUNDS: 3,
    },
    callbacks: {
      getActiveSession: () => ({ id: 'session-1', interactive_round_count: 0 }),
      getPendingQuestionBatch: () => null,
      normalizePendingQuestionBatch: () => null,
      shouldForceInteractiveGuardrail: () => false,
      getInteractiveSequenceState: () => 'idle',
      clearInteractiveDraft: () => {},
      patchSessionSummary: (sessionId, patch) => {
        const normalizedSessionId = String(sessionId || '').trim();
        calls.sessionPatches.push({
          sessionId: normalizedSessionId,
          patch: { ...(patch || {}) },
        });
        state.sessions = state.sessions.map((session) =>
          String(session?.id || '').trim() === normalizedSessionId
            ? { ...session, ...(patch || {}) }
            : session
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
        ...(options.runtimePreferences || {}),
      }),
      getCurrentVisibleMessages: () => state.messagesBySession.get(state.currentSessionId) || [],
      getCurrentSessionMessages: () => state.messagesBySession.get(state.currentSessionId) || [],
      getSessionTurnEventState: (sessionId) => (
        state.turnEventsBySession.get(String(sessionId || '').trim()) || { turnEvents: [] }
      ),
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
        accepted: Array.isArray(entries) ? entries : [],
        skipped: [],
      }),
      resetAttachmentQueue: () => {
        calls.resetQueue += 1;
        state.attachments.queued = [];
      },
      showToastMessage: (message, toastOptions) => calls.toasts.push({ message, options: toastOptions || {} }),
      setComposerStatusNotice: (message, noticeOptions) => {
        calls.composerNotices.push({ message: String(message || ''), options: noticeOptions || {} });
      },
      clearComposerStatusNotice: () => {},
      isSendPreflightPending: () => false,
      showComposerActionError: (error, title) => {
        calls.errors.push({
          title,
          message: error?.message || String(error),
        });
      },
      renderComposerState: () => { calls.renderComposerState += 1; },
      renderAll: () => { calls.renderAll += 1; },
      syncComposerInputHeight: () => {},
      syncComposerVisualState: () => {},
      setFollowLatest: () => {},
      appendClientLog: (level, event, details) => {
        calls.logs.push({ level, event, details });
      },
      loadSessions: async () => {},
      activateWorkspaceSession: async (sessionId) => {
        calls.activations.push(sessionId);
        state.currentSessionId = sessionId;
      },
      refreshSessionSummaries: async () => ({
        currentSessionId: state.currentSessionId,
        validSessionIds: new Set([state.currentSessionId]),
      }),
      thinkingController: {
        resumeAutoScroll: () => {},
      },
      flushBufferedStreamEvents: typeof options.flushBufferedStreamEvents === 'function'
        ? options.flushBufferedStreamEvents
        : async () => ({ flushedCount: 0, terminal: false }),
      dropBufferedStreamEvents: () => {},
      optimisticAppend: (sessionId, role, content, extra = {}) => {
        const message = {
          id: extra.id || `${role}_${calls.optimisticAppend.length + 1}`,
          role,
          content,
          attachments: extra.attachments || [],
        };
        calls.optimisticAppend.push({ sessionId, role, content, extra });
        const nextMessages = [...(state.messagesBySession.get(sessionId) || []), message];
        state.messagesBySession.set(sessionId, nextMessages);
        return message;
      },
      onUserSendStarted: (payload) => {
        calls.cometUserSendStarted.push(payload);
      },
      isSendBusy: () => false,
      isAnySendBusy: () => options.isAnySendBusy === true,
      isSessionStreaming: (sessionId) =>
        options.isSessionStreaming === true
        && String(sessionId || '').trim() === String(state.activeStreamSessionId || '').trim(),
      hasPendingToolApprovalForSession: typeof options.hasPendingToolApprovalForSession === 'function'
        ? options.hasPendingToolApprovalForSession
        : () => options.hasPendingToolApproval === true,
      getCurrentMessageById: (messageId) =>
        messages.find((message) => String(message.id || '') === String(messageId || '')) || null,
      getElaboratePrompt,
      getLatestReplyAssistantMessageId,
      resolveRegenerateRequest,
      showCopyFeedback: () => {},
      upsertSessionSummary: (sessionSummary) => {
        const normalizedSummary =
          sessionSummary && typeof sessionSummary === 'object' ? { ...sessionSummary } : null;
        const normalizedSessionId = String(normalizedSummary?.id || '').trim();
        if (!normalizedSessionId) {
          return null;
        }
        const existingIndex = state.sessions.findIndex(
          (session) => String(session?.id || '').trim() === normalizedSessionId
        );
        if (existingIndex === -1) {
          state.sessions = [normalizedSummary, ...state.sessions];
          return normalizedSummary;
        }
        state.sessions[existingIndex] = {
          ...state.sessions[existingIndex],
          ...normalizedSummary,
        };
        return state.sessions[existingIndex];
      },
      removeSessionState: () => {},
      rekeySessionState: (_from, to) => to,
      setChatSendLifecycle: (sessionId, lifecycle) => {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
          return 'idle';
        }
        state.ui.chatSendLifecycleBySession.set(normalizedSessionId, lifecycle);
        return lifecycle;
      },
      clearChatSendLifecycle: (sessionId) => {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
          return false;
        }
        return state.ui.chatSendLifecycleBySession.delete(normalizedSessionId);
      },
      moveChatSendLifecycle: (fromSessionId, toSessionId) => {
        const normalizedFrom = String(fromSessionId || '').trim();
        const normalizedTo = String(toSessionId || '').trim();
        const lifecycle = state.ui.chatSendLifecycleBySession.get(normalizedFrom) || 'idle';
        if (normalizedFrom) {
          state.ui.chatSendLifecycleBySession.delete(normalizedFrom);
        }
        if (normalizedTo && lifecycle !== 'idle') {
          state.ui.chatSendLifecycleBySession.set(normalizedTo, lifecycle);
        }
        return lifecycle;
      },
      clearProjectionContextCacheForSession: (sessionId) => {
        calls.clearedProjectionSessions.push(String(sessionId || '').trim());
      },
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
    },
  };
}

module.exports = {
  buildMessageSequence,
  createControllerHarness,
};
