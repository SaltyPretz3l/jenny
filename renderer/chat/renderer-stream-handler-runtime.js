(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerRuntime = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RENDER_QUEUE_FALLBACK_TIMEOUT_MS = 32;
  const RENDER_FRAME_ASSIGNING_HANDLE = -1;

  function createStreamHandlerRuntime(options = {}) {
    const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
    const requestFrame = typeof globalRef.requestAnimationFrame === 'function'
      ? globalRef.requestAnimationFrame.bind(globalRef)
      : (callback) => globalRef.setTimeout(callback, 16);
    const cancelFrame = typeof globalRef.cancelAnimationFrame === 'function'
      ? globalRef.cancelAnimationFrame.bind(globalRef)
      : (handle) => globalRef.clearTimeout(handle);
    const scheduleTimeout = typeof globalRef.setTimeout === 'function'
      ? globalRef.setTimeout.bind(globalRef)
      : null;
    const clearScheduledTimeout = typeof globalRef.clearTimeout === 'function'
      ? globalRef.clearTimeout.bind(globalRef)
      : function noopClearTimeout() {};
    const {
      state,
      thinkingIndicator,
      multiStreamController,
      appendClientLog = () => {},
      renderAll = () => {},
      renderHeader = () => {},
      renderMessages = () => {},
      // Split view W1-4c: the pane composition's router. `renderSessionPane(id,
      // kind)` renders the pane showing `id` and answers true, false (the
      // session is in no pane) or undefined (one pane: take the global render).
      renderSessionPane = null,
      renderSessions = () => {},
      renderSettings = () => {},
      renderComposerState = () => {},
      renderComposerStatusNotice = () => {},
      renderWorkspaceChrome = () => {},
      afterRender = () => {},
      getQueuedSend = () => null,
      restoreQueuedSendDraft = () => {},
      clearSessionComposerNotice = () => {},
      getChatSendLifecycle = () => 'idle',
      setChatSendLifecycle = () => 'idle',
      clearChatSendLifecycle = () => false,
      isCurrentSession = () => false,
      isVisibleChatSession = () => false,
      markHiddenRenderableEvent = () => {},
      dismissApprovalToast = () => {},
      // Background Effects v3 S5 W1b: complete impulse, fired right where a
      // terminal stream flips the send lifecycle to 'settling'.
      publishCompleteImpulse = () => {},
    } = options;

    let renderFrameHandle = 0;
    let renderFallbackHandle = null;
    const renderQueue = {
      full: false,
      messages: false,
      header: false,
      composer: false,
      composerStatus: false,
      sessions: false,
      settings: false,
      chrome: false,
    };
    // `messages` and `composer` keyed per session (W1-4c): drained by the SAME
    // frame as the flat queue, so the latch count stays one.
    const keyedRenders = { messages: new Set(), composer: new Set() };
    const NO_KEYED_RENDERS = { messages: [], composer: [] };

    function keySessionFlags(sessionId, flags) {
      const id = String(sessionId || '').trim();
      if (typeof renderSessionPane !== 'function' || !id || !flags || flags.full === true) return flags;
      const next = { ...flags };
      ['messages', 'composer'].forEach((kind) => {
        if (next[kind] !== true) return;
        keyedRenders[kind].add(id);
        next[kind] = false;
      });
      return next;
    }

    // One pane render per keyed session; `undefined` from the router falls back
    // to the global render at most once, and never when the flat flag ran it.
    function routeKeyedRenders(sessionIds, kind, globalRendered) {
      let fallback = false;
      sessionIds.forEach((sessionId) => {
        const routed = renderSessionPane(sessionId, kind);
        if (routed === true) return;
        if (routed === false) {
          if (kind === 'messages') {
            markHiddenRenderableEvent({ sessionId, eventType: 'message_render', visible: false, current: isCurrentSession(sessionId) });
          }
          return;
        }
        fallback = true;
      });
      if (!fallback || globalRendered) return;
      if (kind === 'messages') renderMessages();
      else renderComposerState();
    }

    function syncThinkingIndicatorMode(sessionId, nextMode) {
      if (!thinkingIndicator || !isVisibleChatSession(sessionId)) return;
      const displayState = thinkingIndicator.getDisplayState?.() || null;
      if (!displayState || displayState.mode === 'idle') {
        thinkingIndicator.startIndicator(nextMode || 'thinking');
        return;
      }
      thinkingIndicator.updateIndicator(nextMode || displayState.mode);
    }

    function completeThinkingIndicator(sessionId) {
      if (thinkingIndicator && isVisibleChatSession(sessionId)) {
        thinkingIndicator.completeIndicator();
      }
    }

    function resetThinkingIndicator(sessionId) {
      if (thinkingIndicator && isVisibleChatSession(sessionId)) {
        thinkingIndicator.resetIndicator();
      }
    }

    function runQueuedRender(flags, keyed = NO_KEYED_RENDERS) {
      try {
        if (flags.full) {
          renderAll();
          return;
        }
        if (flags.chrome) {
          renderWorkspaceChrome?.({ runtimeOnly: flags.sessions !== true });
        }
        if (flags.sessions) renderSessions();
        if (flags.header) renderHeader();
        if (flags.messages) renderMessages();
        if (keyed.messages.length) routeKeyedRenders(keyed.messages, 'messages', flags.messages);
        if (flags.composerStatus) renderComposerStatusNotice();
        if (flags.composer) renderComposerState();
        if (keyed.composer.length) routeKeyedRenders(keyed.composer, 'composer', flags.composer);
        if (flags.settings && state.ui?.activeView === 'settings') renderSettings();
        afterRender();
      } catch (error) {
        appendClientLog('ERROR', 'render.frame_error', {
          message: String(error?.message || error || ''),
          flagKeys: Object.keys(flags).filter((key) => flags[key]),
        });
      }
    }

    function drainRenderQueue() {
      const flags = { ...renderQueue };
      Object.keys(renderQueue).forEach((key) => {
        renderQueue[key] = false;
      });
      const keyed = { messages: [...keyedRenders.messages], composer: [...keyedRenders.composer] };
      keyedRenders.messages.clear();
      keyedRenders.composer.clear();
      runQueuedRender(flags, keyed);
    }

    function clearRenderSchedule() {
      if (renderFrameHandle) {
        if (renderFrameHandle !== RENDER_FRAME_ASSIGNING_HANDLE) {
          cancelFrame(renderFrameHandle);
        }
        renderFrameHandle = 0;
      }
      if (renderFallbackHandle != null) {
        clearScheduledTimeout(renderFallbackHandle);
        renderFallbackHandle = null;
      }
    }

    function drainScheduledRenderQueue() {
      if (!renderFrameHandle && renderFallbackHandle == null) return;
      clearRenderSchedule();
      drainRenderQueue();
    }

    // `options.sessionId` (W1-4c) keys `messages`/`composer` to that session's
    // pane, exactly as queueSessionRender's visible path does.
    function queueRender(nextFlags = {}, options = {}) {
      const flags = options?.sessionId ? keySessionFlags(options.sessionId, nextFlags) : nextFlags;
      Object.keys(renderQueue).forEach((key) => {
        renderQueue[key] = renderQueue[key] || flags[key] === true;
      });
      if (options?.immediate === true) {
        clearRenderSchedule();
        drainRenderQueue();
        return;
      }
      if (renderFrameHandle || renderFallbackHandle != null) {
        return;
      }
      let frameFiredBeforeHandleAssigned = false;
      renderFrameHandle = RENDER_FRAME_ASSIGNING_HANDLE;
      const frameHandle = requestFrame(() => {
        frameFiredBeforeHandleAssigned = renderFrameHandle === RENDER_FRAME_ASSIGNING_HANDLE;
        drainScheduledRenderQueue();
      });
      if (frameFiredBeforeHandleAssigned) {
        renderFrameHandle = 0;
        return;
      }
      renderFrameHandle = frameHandle;
      if (scheduleTimeout) {
        renderFallbackHandle = scheduleTimeout(drainScheduledRenderQueue, RENDER_QUEUE_FALLBACK_TIMEOUT_MS);
      }
    }

    function queueSessionRender(sessionId, visibleFlags, options = {}) {
      const visible = isVisibleChatSession(sessionId);
      const current = isCurrentSession(sessionId);
      const renderCurrentMessagesWhenHidden = current
        && !visible
        && options?.renderCurrentMessagesWhenHidden === true;
      appendClientLog('DEBUG', 'stream.queue_session_render', {
        sessionId: String(sessionId || '').slice(0, 30),
        visible,
        current,
        renderCurrentMessagesWhenHidden,
        immediate: (visible || renderCurrentMessagesWhenHidden)
          && options?.immediate === true,
        activeView: state.ui?.activeView,
        currentSessionId: String(state.currentSessionId || '').slice(0, 30),
        flagKeys: Object.keys(visibleFlags || {}).filter((key) => visibleFlags[key]),
      });
      if (visible) {
        queueRender({ ...keySessionFlags(sessionId, visibleFlags), chrome: true }, options);
        return;
      }
      if (renderCurrentMessagesWhenHidden) {
        queueRender({
          ...visibleFlags,
          full: false,
          chrome: true,
        }, options);
        return;
      }
      if (current) {
        if (visibleFlags?.messages === true || visibleFlags?.full === true) {
          markHiddenRenderableEvent({
            sessionId,
            eventType: 'message_render',
            visible,
            current,
          });
        }
        queueRender({
          ...visibleFlags,
          full: false,
          messages: false,
          chrome: true,
        });
        return;
      }
      queueRender({ chrome: true });
    }

    function setStreamThinkingStatus(streamId, text, thinkingId) {
      const normalizedStreamId = String(streamId || '').trim();
      const nextText = String(text || '').trim();
      if (!normalizedStreamId) {
        return;
      }
      if (nextText) {
        state.streamThinkingStatusByStream.set(normalizedStreamId, {
          text: nextText,
          thinkingId: String(thinkingId || ''),
        });
        state.streamDeltaKindByStream?.set(normalizedStreamId, 'reasoning');
      } else {
        state.streamThinkingStatusByStream.delete(normalizedStreamId);
      }
    }

    function clearStreamThinkingStatus(streamId) {
      const normalizedStreamId = String(streamId || '').trim();
      if (normalizedStreamId) {
        state.streamThinkingStatusByStream.delete(normalizedStreamId);
      }
    }

    function getApprovalPendingSessionIds() {
      if (multiStreamController?.getApprovalPendingSessionIds) {
        return multiStreamController.getApprovalPendingSessionIds();
      }
      const pending = new Set();
      for (const approval of state.pendingToolApprovals.values()) {
        const sessionId = String(approval?.sessionId || '').trim();
        if (sessionId) {
          pending.add(sessionId);
        }
      }
      return [...pending];
    }

    function releaseApprovalToastSessions(approvalToastSessionIds, sessionIds) {
      (Array.isArray(sessionIds) ? sessionIds : []).forEach((sessionId) => {
        const normalizedSessionId = String(sessionId || '').trim();
        if (normalizedSessionId && !getApprovalPendingSessionIds().includes(normalizedSessionId)) {
          approvalToastSessionIds.delete(normalizedSessionId);
          dismissApprovalToast(normalizedSessionId);
        }
      });
    }

    function clearPendingApprovalsForStream(approvalToastSessionIds, streamId) {
      const normalizedStreamId = String(streamId || '').trim();
      const touchedSessionIds = new Set();
      if (!normalizedStreamId) {
        return;
      }
      for (const [callId, approval] of [...state.pendingToolApprovals.entries()]) {
        if (String(approval?.streamId || '').trim() === normalizedStreamId) {
          touchedSessionIds.add(String(approval?.sessionId || '').trim());
          state.pendingToolApprovals.delete(callId);
        }
      }
      releaseApprovalToastSessions(approvalToastSessionIds, [...touchedSessionIds]);
    }

    function clearTerminalStreamState(approvalToastSessionIds, streamSegmentState, streamPhaseState, streamId) {
      const rawStreamId = String(streamId || '');
      const normalizedStreamId = rawStreamId.trim();
      const streamIds = [...new Set([rawStreamId, normalizedStreamId].filter(Boolean))];
      for (const candidateStreamId of streamIds) {
        clearStreamThinkingStatus(candidateStreamId);
        state.streamDeltaKindByStream?.delete(candidateStreamId);
        clearPendingApprovalsForStream(approvalToastSessionIds, candidateStreamId);
        state.pendingStreams.delete(candidateStreamId);
        state.toolCallsByStream.delete(candidateStreamId);
        streamSegmentState.delete(candidateStreamId);
        streamPhaseState?.delete?.(candidateStreamId);
        multiStreamController?.clearStream?.(candidateStreamId);
      }
    }

    function finalizeTerminalStream(approvalToastSessionIds, streamSegmentState, streamPhaseState, payload, options = {}) {
      const sessionId = String(payload?.sessionId || '').trim();
      const streamId = String(payload?.streamId || '').trim();
      if (!sessionId || !streamId) {
        return;
      }
      clearTerminalStreamState(approvalToastSessionIds, streamSegmentState, streamPhaseState, streamId);
      // A resumed paused turn continues on a fresh stream, and the paused
      // stream never gets a terminal event of its own: release it here. A late
      // terminal from an older attempt, while a newer one is live, releases
      // nothing else.
      const turnId = String(payload?.turnId || payload?.turn_id || '').trim();
      const newerAttemptLive = Boolean(multiStreamController?.getStreamIdForSession?.(sessionId));
      const sessionMessages = turnId && !newerAttemptLive ? state.messagesBySession?.get?.(sessionId) : null;
      if (Array.isArray(sessionMessages)) {
        for (const [otherStreamId, messageId] of [...state.pendingStreams]) {
          if (otherStreamId === streamId) continue;
          const message = sessionMessages.find((candidate) => candidate?.id === messageId);
          if (String(message?.turn_id || '').trim() === turnId) {
            clearTerminalStreamState(approvalToastSessionIds, streamSegmentState, streamPhaseState, otherStreamId);
          }
        }
      }
      setChatSendLifecycle(sessionId, 'settling');
      publishCompleteImpulse({ sessionId, streamId, timeStamp: payload && payload.timeStamp });
      if (options.clearComposerNotice !== false) {
        clearSessionComposerNotice(sessionId);
      }
      if (options.restoreQueuedDraft === true && getQueuedSend(sessionId) && isCurrentSession(sessionId)) {
        restoreQueuedSendDraft(sessionId);
      }
    }

    function resetLifecycleIfSettling(sessionId) {
      if (String(getChatSendLifecycle(sessionId) || '').trim() === 'settling') {
        clearChatSendLifecycle(sessionId);
      }
    }

    function disposeRenderQueue() {
      clearRenderSchedule();
    }

    return {
      syncThinkingIndicatorMode,
      completeThinkingIndicator,
      resetThinkingIndicator,
      queueRender,
      queueSessionRender,
      setStreamThinkingStatus,
      clearStreamThinkingStatus,
      releaseApprovalToastSessions,
      clearPendingApprovalsForStream,
      clearTerminalStreamState,
      finalizeTerminalStream,
      resetLifecycleIfSettling,
      disposeRenderQueue,
    };
  }

  return { createStreamHandlerRuntime };
});
