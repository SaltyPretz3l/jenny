(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSendFlowHelpers = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const sendOutboxModule = (typeof globalThis !== 'undefined' && globalThis.rendererSendOutbox)
    || (typeof require === 'function' ? require('./renderer-send-outbox') : null);
  if (!sendOutboxModule || typeof sendOutboxModule.getOrCreateSendOutbox !== 'function') {
    throw new Error('renderer-send-outbox must load before renderer-send-flow-helpers');
  }
  const { getOrCreateSendOutbox } = sendOutboxModule;
  const UNSAFE_JSON_CLONE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

  function clipSessionTitle(value) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return 'New Chat';
    }
    return normalized.length > 80 ? `${normalized.slice(0, 77).trim()}...` : normalized;
  }

  function createOptimisticSessionId() {
    return `session_local_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  }

  function createTraceToken() {
    return `trace_${Date.now()}_${Math.random().toString(16).slice(2, 14)}`;
  }

  function rejectBusyPluginCommand({ invocation, sessionId, setNotice, render, log }) {
    if (!invocation) return null;
    setNotice?.('Wait for the active response to finish before running a plugin command.', {
      owner: 'send:plugin_command_busy', tone: 'warning',
    });
    render?.();
    log?.('INFO', 'plugin.command_busy_rejected', { sessionId });
    return { rejected: true, reason: 'session_busy', sessionId };
  }

  function cloneJsonLike(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return null;
    seen.add(value);

    let clone;
    if (Array.isArray(value)) {
      clone = value.map((entry) => cloneJsonLike(entry, seen));
    } else {
      clone = {};
      for (const [key, entry] of Object.entries(value)) {
        if (UNSAFE_JSON_CLONE_KEYS.has(key)) continue;
        clone[key] = cloneJsonLike(entry, seen);
      }
    }
    seen.delete(value);
    return clone;
  }

  function cloneQueuedAttachments(entries) {
    return cloneJsonLike(Array.isArray(entries) ? entries : []);
  }

  function buildOptimisticAttachmentMetadata(entries) {
    return (Array.isArray(entries) ? entries : []).map((entry) =>
      String(entry?.kind || '').trim() === 'image'
        ? {
            id: entry.id,
            kind: 'image',
            displayName: entry.displayName,
            mimeType: entry.mimeType,
            sizeBytes: entry.sizeBytes,
            width: entry.width,
            height: entry.height,
            assetPath: entry.assetPath,
            sourceKind: entry.sourceKind,
          }
        : String(entry?.kind || '').trim() === 'audio'
          ? {
              id: entry.id,
              kind: 'audio',
              displayName: entry.displayName,
              mimeType: entry.mimeType,
              sizeBytes: entry.sizeBytes,
              durationMs: entry.durationMs,
              assetPath: entry.assetPath,
              sourceKind: entry.sourceKind,
              transcriptText: entry.transcriptText,
              transcriptStatus: entry.transcriptStatus,
              transcriptLanguage: entry.transcriptLanguage,
            }
        : {
            id: entry.id,
            kind: 'text',
            displayName: entry.displayName,
            promptName: entry.promptName,
            extension: entry.extension,
            sizeBytes: entry.sizeBytes,
            truncated: Boolean(entry.truncated || entry.budgetTruncated),
          }
    );
  }

  function buildDurableFailureMessage(error, sessionId, createNormalizedMessage) {
    const candidate = error && typeof error === 'object' ? error : {};
    const errorCode = String(candidate.error_code || candidate.code || '').trim() || 'CMP-CHAT-0002';
    const retryable = candidate.retryable !== false;
    const category = String(candidate.category || 'transport').trim() || 'transport';
    const normalizedSessionId = String(sessionId || '').trim();
    const extra = {
      id: `assistant_failed_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
      status: 'error',
      stream_error: String(candidate.message || error || 'Chat stream failed.'),
      error_code: errorCode,
      retryable,
      category,
      session_id: normalizedSessionId,
      finalizedAt: new Date().toISOString(),
      reasoning: { source: 'none', entries: [] },
    };
    if (typeof createNormalizedMessage === 'function') {
      return createNormalizedMessage('assistant', '', extra);
    }
    return { role: 'assistant', content: '', ...extra };
  }

  function buildSendFailureMetadata(error, { restoredToComposer = false, failedPayloadId = '' } = {}) {
    const candidate = error && typeof error === 'object' ? error : {};
    const errorCode = String(candidate.error_code || candidate.code || '').trim() || 'CMP-CHAT-0002';
    const retryable = candidate.retryable !== false;
    const category = String(candidate.category || 'transport').trim() || 'transport';
    return {
      state: 'failed',
      reason: 'start_stream_rejected',
      error_code: errorCode,
      category,
      retryable,
      restored_to_composer: restoredToComposer === true,
      payload_id: String(failedPayloadId || '').trim(),
      failed_at: new Date().toISOString(),
    };
  }

  function getQueuedSendFromState(state, sessionId) {
    const normalizedSessionId = String(sessionId || '').trim();
    return normalizedSessionId ? getOrCreateSendOutbox(state).peek(normalizedSessionId) : null;
  }

  function clearQueuedSendInState(state, sessionId, entry = null) {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId) {
      return false;
    }
    const outbox = getOrCreateSendOutbox(state);
    if (entry) return outbox.remove(entry);
    outbox.clearSession(normalizedSessionId);
    return true;
  }

  function stashQueuedSendInState(state, sessionId, payload) {
    const normalizedSessionId = String(sessionId || '').trim();
    if (!normalizedSessionId || !payload) {
      return null;
    }
    return getOrCreateSendOutbox(state).enqueue(normalizedSessionId, {
      prompt: String(payload.prompt || ''),
      attachments: cloneQueuedAttachments(payload.attachments),
      runtimePreferences: payload.runtimePreferences ? cloneJsonLike(payload.runtimePreferences) : null,
      createdAt: Number(payload.createdAt || Date.now()),
      source: String(payload.source || '').trim() || 'send_controller',
      meta: payload.meta && typeof payload.meta === 'object' ? cloneJsonLike(payload.meta) : {},
      status: String(payload.status || 'capturing_context'),
      sourceRevision: Number(payload.sourceRevision) || 0,
      targetSessionIncarnation: String(payload.targetSessionIncarnation || ''),
    });
  }

  function annotateUserSendFailureInStore({ getSessionMessages, setSessionMessages }, sessionId, messageId, metadata) {
    const normalizedSessionId = String(sessionId || '').trim();
    const normalizedMessageId = String(messageId || '').trim();
    if (!normalizedSessionId || !normalizedMessageId || !metadata) {
      return false;
    }
    const messages = getSessionMessages(normalizedSessionId);
    let changed = false;
    const nextMessages = messages.map((message) => {
      if (String(message?.id || '').trim() !== normalizedMessageId) {
        return message;
      }
      changed = true;
      return {
        ...message,
        send_failure: { ...metadata },
      };
    });
    if (changed) {
      setSessionMessages(normalizedSessionId, nextMessages, `session_${normalizedSessionId}`);
    }
    return changed;
  }

  // Rewrite an optimistic user message's id to the backend's deterministic
  // persisted id (`user_<streamId>`) once it is known, so terminal hydration
  // reconciles the bubble by id instead of treating the random `user_local_*`
  // copy as a brand-new row and re-appending it at the tail (the duplicate
  // user-bubble bug). Mirrors the assistant bubble, which already keys off
  // `assistant_<streamId>`. Renames in place to preserve canonical position.
  //
  // This by-id rename is the PRIMARY dedup path; the content-keyed multiset in
  // mergeTerminalHydratedMessages (renderer-stream-handler-terminal.js) is the
  // fallback for when this never ran (e.g. a missing streamId). The two must stay
  // in parity. On a post-adoption failure the caller reassigns
  // optimisticUserMessageId to the renamed id so annotateUserSendFailureInStore
  // (its companion below, keyed on the same id) still targets this row — see the
  // renderer-send-utils.js success block.
  function adoptPersistedUserMessageId({ getSessionMessages, setSessionMessages }, sessionId, optimisticId, persistedId) {
    const normalizedSessionId = String(sessionId || '').trim();
    const normalizedOptimisticId = String(optimisticId || '').trim();
    const normalizedPersistedId = String(persistedId || '').trim();
    if (
      !normalizedSessionId
      || !normalizedOptimisticId
      || !normalizedPersistedId
      || normalizedOptimisticId === normalizedPersistedId
    ) {
      return false;
    }
    const messages = getSessionMessages(normalizedSessionId);
    if (!Array.isArray(messages) || !messages.length) {
      return false;
    }
    const optimisticIndex = messages.findIndex(
      (message) => String(message?.id || '').trim() === normalizedOptimisticId
    );
    if (optimisticIndex === -1) {
      return false;
    }
    const persistedAlreadyPresent = messages.some(
      (message) => String(message?.id || '').trim() === normalizedPersistedId
    );
    let nextMessages;
    if (persistedAlreadyPresent) {
      // Late hydration already landed the persisted twin — drop the optimistic
      // copy instead of renaming so we never create two rows with the same id.
      nextMessages = messages.filter((_message, index) => index !== optimisticIndex);
    } else {
      nextMessages = messages.map((message, index) => {
        if (index !== optimisticIndex) {
          return message;
        }
        return {
          ...message,
          id: normalizedPersistedId,
          // Mirror the backend's deterministic persisted shape, which sets both
          // id and client_message_id to user_<streamId>. No renderer code reads
          // client_message_id today; it is kept consistent so the renamed bubble
          // is a faithful preview of the row terminal hydration replaces it with.
          client_message_id: normalizedPersistedId,
        };
      });
    }
    setSessionMessages(normalizedSessionId, nextMessages, `session_${normalizedSessionId}`);
    return true;
  }

  function summarizeDurableFailurePreview(prompt, failureMessage) {
    const promptPreview = String(prompt || '').trim().slice(0, 160);
    if (promptPreview) {
      return promptPreview;
    }
    return String(failureMessage?.stream_error || '').trim().slice(0, 160);
  }

  function resolveMessageCopyText(message) {
    if (!message) return '';
    const segments = Array.isArray(message.visible_segments) ? message.visible_segments : [];
    if (segments.length) {
      const joined = segments
        .map((segment) => String(segment && segment.text || ''))
        .filter((text) => text.length > 0)
        .join('');
      if (joined) {
        return joined;
      }
    }
    return String(message.content || '');
  }

  // isDockApprovalSteerActive is injected because send admission and queued dispatch must use the same predicate.
  function createSendQueueGuards(deps = {}) {
    const state = deps.state;
    const multiStreamController = deps.multiStreamController || null;
    const isSessionStreaming = typeof deps.isSessionStreaming === 'function'
      ? deps.isSessionStreaming
      : () => false;
    const hasPendingToolApprovalForSession = typeof deps.hasPendingToolApprovalForSession === 'function'
      ? deps.hasPendingToolApprovalForSession
      : () => false;
    const getPendingQuestionBatch = typeof deps.getPendingQuestionBatch === 'function'
      ? deps.getPendingQuestionBatch
      : () => null;
    const isDockApprovalSteerActive = typeof deps.isDockApprovalSteerActive === 'function'
      ? deps.isDockApprovalSteerActive
      : () => false;
    const chatInput = deps.chatInput;
    const syncComposerInputHeight = typeof deps.syncComposerInputHeight === 'function'
      ? deps.syncComposerInputHeight
      : () => {};
    const syncComposerVisualState = typeof deps.syncComposerVisualState === 'function'
      ? deps.syncComposerVisualState
      : () => {};
    const renderComposerState = typeof deps.renderComposerState === 'function'
      ? deps.renderComposerState
      : () => {};
    const renderMessages = typeof deps.renderMessages === 'function'
      ? deps.renderMessages
      : () => {};

    function isSessionBusy(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return false;
      }
      if (multiStreamController) {
        // isSessionSendBusy folds streaming + preflight + terminal-post-work
        // into one predicate so every gating site agrees on what "busy" means.
        return multiStreamController.isSessionSendBusy(normalizedSessionId);
      }
      return isSessionStreaming(normalizedSessionId);
    }

    function restoreQueuedSendDraft(sessionId) {
      const queuedSend = getQueuedSendFromState(state, sessionId);
      if (!queuedSend) {
        return null;
      }
      const hasNewerComposerWork = Boolean(String(chatInput?.value || '').trim())
        || Boolean(Array.isArray(state.attachments?.queued) && state.attachments.queued.length);
      if (hasNewerComposerWork) {
        getOrCreateSendOutbox(state).replace(queuedSend, { status: 'needs_review' });
        renderComposerState();
        renderMessages();
        return null;
      }
      chatInput.value = String(queuedSend.prompt || '');
      state.attachments.queued = cloneQueuedAttachments(queuedSend.attachments);
      clearQueuedSendInState(state, sessionId, queuedSend);
      // UIUX-006: a queued-send restore writes straight to the live
      // composer/queue, bypassing the normal capture-on-input path — sync the
      // session-owned record immediately so a later switch away from this
      // session doesn't clobber the just-restored draft with whatever the
      // record last held (or leave it stale relative to the live composer).
      globalThis.rendererComposerSessionStateController?.captureActive(sessionId, 'queued_restore');
      syncComposerInputHeight();
      syncComposerVisualState();
      renderComposerState();
      renderMessages();
      return queuedSend;
    }

    function canQueueForSession(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      // Derive eligibility from isSessionBusy (streaming | preflight |
      // terminal-post-work) rather than re-enumerating states here — the
      // divergence between this and isSessionBusy is what let sends escape the
      // queue during post-work (and be silently dropped during preflight).
      return Boolean(
        normalizedSessionId
        && isSessionBusy(normalizedSessionId)
        && (!hasPendingToolApprovalForSession(normalizedSessionId) || isDockApprovalSteerActive())
        && !getPendingQuestionBatch()
      );
    }

    return { isSessionBusy, restoreQueuedSendDraft, canQueueForSession };
  }

  function reconcileAcceptedRegenerate(payload = {}, callbacks = {}) {
    const sessionId = String(payload.sessionId || '').trim();
    const sourceMessageId = String(payload.sourceMessageId || '').trim();
    const targetMessageId = String(payload.targetMessageId || '').trim();
    const authoritativeUserMessageId = String(
      payload.startResult?.identity?.userMessageId || ''
    ).trim();
    const currentMessages = [
      ...(callbacks.getSessionMessages?.(sessionId) || []),
    ];
    const sourceIndex = currentMessages.findIndex(
      (message) => String(message?.id || '').trim() === sourceMessageId
        && String(message?.role || '').trim() === 'user'
    );
    const targetIndex = currentMessages.findIndex(
      (message) => String(message?.id || '').trim() === targetMessageId
    );
    if (
      !sessionId
      || !sourceMessageId
      || authoritativeUserMessageId !== sourceMessageId
      || sourceIndex < 0
      || targetIndex <= sourceIndex
    ) {
      callbacks.appendClientLog?.('WARN', 'chat.regenerate_reconcile_skipped', {
        sessionId: sessionId.slice(0, 30),
        sourceMessageId: sourceMessageId.slice(0, 60),
        targetMessageId: targetMessageId.slice(0, 60),
        reason: authoritativeUserMessageId !== sourceMessageId
          ? 'identity_mismatch'
          : sourceIndex < 0
            ? 'source_missing'
            : 'target_missing_or_stale',
      });
      return false;
    }

    const nextMessages = payload.failureRetry === true
      ? currentMessages
      : currentMessages.slice(0, sourceIndex + 1);
    callbacks.clearProjectionContextCacheForSession?.(sessionId);
    callbacks.setSessionMessages?.(sessionId, nextMessages, `session_${sessionId}`);
    callbacks.patchSessionSummary?.(sessionId, {
      message_count: nextMessages.length,
      last_message_preview: String(nextMessages[nextMessages.length - 1]?.content || '').slice(0, 160),
      updated_at: new Date().toISOString(),
    });
    callbacks.renderAll?.();
    callbacks.appendClientLog?.('INFO', 'chat.regenerate_superseded_turn', {
      sessionId: sessionId.slice(0, 30),
      sourceMessageId: sourceMessageId.slice(0, 60),
      targetMessageId: targetMessageId.slice(0, 60),
      removedMessageCount: currentMessages.length - nextMessages.length,
    });
    return true;
  }

  return {
    adoptPersistedUserMessageId,
    annotateUserSendFailureInStore,
    buildDurableFailureMessage,
    buildOptimisticAttachmentMetadata,
    buildSendFailureMetadata,
    clearQueuedSendInState,
    cloneJsonLike,
    cloneQueuedAttachments,
    clipSessionTitle,
    createOptimisticSessionId,
    createSendQueueGuards,
    createTraceToken,
    getQueuedSendFromState,
    getOrCreateSendOutbox,
    reconcileAcceptedRegenerate,
    rejectBusyPluginCommand,
    resolveMessageCopyText,
    stashQueuedSendInState,
    summarizeDurableFailurePreview,
  };
});
