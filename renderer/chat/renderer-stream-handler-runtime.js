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
    const TURN_PILL_SOURCES = (globalRef.rendererTurnStatusPill && globalRef.rendererTurnStatusPill.TURN_SOURCES)
      || ['turn.needs_approval', 'turn.running_tool', 'turn.thinking', 'turn.responding', 'turn.sending'];
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
      renderSessions = () => {},
      renderSettings = () => {},
      renderComposerState = () => {},
      renderComposerStatusNotice = () => {},
      renderWorkspaceChrome = () => {},
      afterRender = () => {},
      getQueuedSend = () => null,
      restoreQueuedSendDraft = () => {},
      clearSessionComposerNotice = () => {},
      clearSessionTurnStatusPill = () => {},
      clearSessionTurnStatusPillSources = (sessionId, sources) => {
        const list = Array.isArray(sources) ? sources : [];
        for (let i = 0; i < list.length; i += 1) {
          clearSessionTurnStatusPill(sessionId, list[i]);
        }
      },
      getChatSendLifecycle = () => 'idle',
      setChatSendLifecycle = () => 'idle',
      clearChatSendLifecycle = () => false,
      isCurrentSession = () => false,
      isVisibleChatSession = () => false,
      markHiddenRenderableEvent = () => {},
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

    function runQueuedRender(flags) {
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
        if (flags.composerStatus) renderComposerStatusNotice();
        if (flags.composer) renderComposerState();
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
      runQueuedRender(flags);
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

    function queueRender(nextFlags = {}, options = {}) {
      Object.keys(renderQueue).forEach((key) => {
        renderQueue[key] = renderQueue[key] || nextFlags[key] === true;
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
        queueRender(visibleFlags, options);
        return;
      }
      if (renderCurrentMessagesWhenHidden) {
        queueRender({
          ...visibleFlags,
          full: false,
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
      setChatSendLifecycle(sessionId, 'settling');
      publishCompleteImpulse({ sessionId, streamId, timeStamp: payload && payload.timeStamp });
      if (options.clearComposerNotice !== false) {
        clearSessionComposerNotice(sessionId);
        clearSessionTurnStatusPillSources(sessionId, TURN_PILL_SOURCES);
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
