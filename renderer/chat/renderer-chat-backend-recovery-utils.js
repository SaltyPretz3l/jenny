(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatBackendRecoveryUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const _terminalStatusVocabulary = typeof globalThis !== 'undefined' && typeof globalThis.chatTerminalStatusVocabulary !== 'undefined'
    ? globalThis.chatTerminalStatusVocabulary
    : typeof require === 'function' ? require('./chat-terminal-status-vocabulary')
    : null;
  const { normalizeTerminalStatus, isTerminalStatus } = _terminalStatusVocabulary;

  const BACKEND_UNUSABLE_PHASES = new Set(['failed', 'stopped']);
  const INFLIGHT_SEND_LIFECYCLES = new Set(['preflight', 'streaming', 'settling']);

  // Use the shared terminal-status vocabulary so every terminal outcome is excluded from stranded-message recovery.
  function isTerminalMessageStatus(rawStatus) {
    return isTerminalStatus(normalizeTerminalStatus(rawStatus));
  }

  function normalizeToken(value) {
    return String(value || '').trim();
  }

  function collectInflightSendSessionIds(state, multiStreamController) {
    const sessionIds = new Set();
    const lifecycleStore = state?.ui?.chatSendLifecycleBySession;
    if (lifecycleStore && typeof lifecycleStore.forEach === 'function') {
      lifecycleStore.forEach((lifecycle, sessionId) => {
        const normalizedSessionId = normalizeToken(sessionId);
        const normalizedLifecycle = normalizeToken(lifecycle).toLowerCase();
        if (normalizedSessionId && INFLIGHT_SEND_LIFECYCLES.has(normalizedLifecycle)) {
          sessionIds.add(normalizedSessionId);
        }
      });
    }
    if (multiStreamController) {
      for (const sessionId of multiStreamController.getStreamingSessionIds?.() || []) {
        const normalizedSessionId = normalizeToken(sessionId);
        if (normalizedSessionId) {
          sessionIds.add(normalizedSessionId);
        }
      }
      for (const sessionId of multiStreamController.getPreflightSessionIds?.() || []) {
        const normalizedSessionId = normalizeToken(sessionId);
        if (normalizedSessionId) {
          sessionIds.add(normalizedSessionId);
        }
      }
    }
    return [...sessionIds];
  }

  function resolveNowIso(nowIso) {
    return typeof nowIso === 'function' ? nowIso() : new Date().toISOString();
  }

  function markStrandedStreamMessageErrored({
    state,
    sessionId,
    streamId,
    errorMessage,
    nowIso,
  }) {
    const messageStore = state?.messagesBySession;
    if (!messageStore || typeof messageStore.get !== 'function') {
      return false;
    }
    const messages = messageStore.get(sessionId);
    if (!Array.isArray(messages) || !messages.length) {
      return false;
    }
    const normalizedStreamId = normalizeToken(streamId);
    let lastUserIdx = -1;
    for (let i = 0; i < messages.length; i += 1) {
      const candidate = messages[i];
      if (candidate && typeof candidate === 'object'
        && normalizeToken(candidate.role) === 'user') {
        lastUserIdx = i;
      }
    }
    let inFlightAssistantIdx = -1;
    for (let i = messages.length - 1; i > lastUserIdx; i -= 1) {
      const candidate = messages[i];
      if (!candidate || typeof candidate !== 'object') {
        continue;
      }
      const candidateStatus = normalizeToken(candidate.status).toLowerCase();
      if (isTerminalMessageStatus(candidateStatus)) {
        continue;
      }
      if (normalizeToken(candidate.role) === 'assistant') {
        inFlightAssistantIdx = i;
        break;
      }
    }
    let mutated = false;
    const finalizedAt = resolveNowIso(nowIso);
    const nextMessages = messages.map((message, index) => {
      if (!message || typeof message !== 'object') {
        return message;
      }
      const status = normalizeToken(message.status).toLowerCase();
      if (isTerminalMessageStatus(status)) {
        return message;
      }
      const messageStreamId = normalizeToken(message.streamId || message.stream_id);
      const streamMatches = Boolean(normalizedStreamId) && messageStreamId === normalizedStreamId;
      const isInFlightAssistant = index === inFlightAssistantIdx;
      if (!streamMatches && !isInFlightAssistant) {
        return message;
      }
      mutated = true;
      return {
        ...message,
        agent_status: null,
        agent_status_steps: [],
        status: 'error',
        stream_error: errorMessage,
        finalizedAt,
      };
    });
    if (mutated) {
      messageStore.set(sessionId, nextMessages);
    }
    return mutated;
  }

  function recoverInflightSendsForUnusableBackend({
    payload,
    state,
    clearChatSendLifecycle = function noopClearChatSendLifecycle() {},
    getMultiStreamController = function noopGetMultiStreamController() { return null; },
    appendClientLog = function noopAppendClientLog() {},
    showToastMessage = function noopShowToastMessage() {},
    reportError = null,
    toastSource = 'chatStream',
    nowIso,
  }) {
    const phase = normalizeToken(payload?.phase).toLowerCase();
    if (!BACKEND_UNUSABLE_PHASES.has(phase)) {
      return false;
    }
    const multiStreamController = getMultiStreamController() || null;
    const sessionIds = collectInflightSendSessionIds(state, multiStreamController);
    if (!sessionIds.length) {
      return false;
    }
    const detail = normalizeToken(payload?.detail);
    const baseMessage = phase === 'stopped'
      ? 'The backend stopped before this response finished.'
      : 'The backend connection failed before this response finished.';
    const errorMessage = detail ? `${baseMessage} ${detail}` : baseMessage;
    for (const sessionId of sessionIds) {
      clearChatSendLifecycle(sessionId);
      let streamId = '';
      if (multiStreamController) {
        streamId = normalizeToken(multiStreamController.clearSessionStream?.(sessionId));
        multiStreamController.clearPreflight?.(sessionId);
      }
      markStrandedStreamMessageErrored({
        state,
        sessionId,
        streamId,
        errorMessage,
        nowIso,
      });
    }
    appendClientLog('WARN', 'chat.backend_unusable_send_recovery', {
      phase,
      recoveredCount: sessionIds.length,
      sessionIds: sessionIds.map((sessionId) => String(sessionId).slice(0, 30)),
    });
    /* When error intake accepts the event, suppress the duplicate toast; row recovery remains unconditional, and a null routing result uses the toast fallback. */
    const routed = typeof reportError === 'function'
      ? reportError({
        message: errorMessage,
        options: {
          title: 'Backend Unavailable',
          source: toastSource,
          dedupeKey: `${toastSource}:backend-unusable`,
        },
      }, { origin: 'chat-stream', isInflightTurn: true, backendUnusable: true })
      : null;
    if (!routed) {
      showToastMessage(errorMessage, {
        title: 'Backend Unavailable',
        tone: 'danger',
        sticky: true,
        source: toastSource,
        dedupeKey: `${toastSource}:backend-unusable`,
      });
    }
    return true;
  }

  return {
    collectInflightSendSessionIds,
    markStrandedStreamMessageErrored,
    recoverInflightSendsForUnusableBackend,
  };
});
