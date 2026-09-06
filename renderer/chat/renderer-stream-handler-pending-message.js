/* renderer/chat/renderer-stream-handler-pending-message.js -- pending stream-message lookup + commit-queue helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-stream-text-cursor'));
    return;
  }
  root.rendererStreamHandlerPendingMessage = factory(root.rendererStreamTextCursor || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (streamTextCursor) {
  const { seedContent } = streamTextCursor;

  function createPendingMessageUtils(options = {}) {
    const {
      state,
      normalizeId,
      normalizeString,
      streamSegmentState,
      MESSAGE_STATUS,
      appendClientLog,
      getSessionMessages,
      setSessionMessages,
      createNormalizedMessage,
      getReasoningPhasesForStream,
      createPendingStreamCommitQueue,
      queueRender,
      timelineVisibilityTracker,
      noteTimelineMessageCreated,
      isStreamFinalized,
    } = options || {};

    if (!state || typeof state !== 'object') {
      throw new Error('createPendingMessageUtils requires options.state');
    }
    if (typeof normalizeId !== 'function' || typeof normalizeString !== 'function') {
      throw new Error('createPendingMessageUtils requires normalizeId and normalizeString');
    }
    if (!(streamSegmentState instanceof Map)) {
      throw new Error('createPendingMessageUtils requires streamSegmentState (Map)');
    }
    if (typeof getSessionMessages !== 'function' || typeof setSessionMessages !== 'function') {
      throw new Error('createPendingMessageUtils requires getSessionMessages and setSessionMessages');
    }
    if (typeof createNormalizedMessage !== 'function') {
      throw new Error('createPendingMessageUtils requires createNormalizedMessage');
    }
    if (typeof getReasoningPhasesForStream !== 'function') {
      throw new Error('createPendingMessageUtils requires getReasoningPhasesForStream');
    }
    if (typeof createPendingStreamCommitQueue !== 'function') {
      throw new Error('createPendingMessageUtils requires createPendingStreamCommitQueue');
    }
    if (typeof queueRender !== 'function') {
      throw new Error('createPendingMessageUtils requires queueRender');
    }

    const safeAppendClientLog = typeof appendClientLog === 'function' ? appendClientLog : () => {};
    const safeIsStreamFinalized = typeof isStreamFinalized === 'function'
      ? isStreamFinalized
      : function noopIsStreamFinalized() { return false; };
    const safeNoteTimelineMessageCreated = typeof noteTimelineMessageCreated === 'function'
      ? noteTimelineMessageCreated
      : function noopNoteTimelineMessageCreated() { return false; };
    const messageStatus = MESSAGE_STATUS || { STREAMING: 'streaming', ERROR: 'error' };

    function notifyTimelineMessageCreated(sessionId, message) {
      const messageId = normalizeId(message && message.id);
      if (!messageId) {
        return false;
      }
      try {
        return safeNoteTimelineMessageCreated({
          sessionId,
          messageId,
          role: normalizeString(message && message.role),
          kind: normalizeString(message && message.kind),
          visible: true,
        });
      } catch (_error) {
        return false;
      }
    }

    function optimisticAppend(sessionId, role, content, extra = {}) {
      const messages = [...getSessionMessages(sessionId)];
      const message = createNormalizedMessage(role, content, extra);
      messages.push(message);
      setSessionMessages(sessionId, messages, `session_${sessionId}`);
      notifyTimelineMessageCreated(sessionId, message);
      return message;
    }

    function findPendingStreamEntryIndex(messages, pendingId, canonicalMessageId, streamId) {
      const normalizedPendingId = normalizeId(pendingId);
      const normalizedCanonicalMessageId = normalizeId(canonicalMessageId);
      const normalizedStreamId = normalizeId(streamId);
      let pendingIndex = -1;
      let canonicalIndex = -1;
      let streamIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        const messageId = normalizeId(message?.id);
        if (pendingIndex === -1 && normalizedPendingId && messageId === normalizedPendingId) {
          pendingIndex = index;
        }
        if (canonicalIndex === -1 && normalizedCanonicalMessageId && messageId === normalizedCanonicalMessageId) {
          canonicalIndex = index;
        }
        if (
          streamIndex === -1
          && normalizedStreamId
          && normalizeString(message?.role) === 'assistant'
          && normalizeId(message?.streamId) === normalizedStreamId
          // A finalized segment bubble (mixed text+tool preamble, W3.6) must
          // not be re-adopted by the next segment's deltas — only re-attach
          // to a bubble that is still live.
          && normalizeString(message?.status) !== normalizeString(messageStatus.COMPLETE || 'complete')
        ) {
          streamIndex = index;
        }
      }
      if (pendingIndex !== -1) {
        return pendingIndex;
      }
      if (canonicalIndex !== -1) {
        return canonicalIndex;
      }
      return streamIndex;
    }

    function ensurePendingStreamEntry(payload) {
      // A finalized stream must not be resurrected. After the terminal handler
      // cleared the stream, a trailing delta/agent_status/reasoning event would
      // otherwise re-adopt the completed bubble by its canonical id
      // (`assistant_<streamId>`) and re-add the stream to state.pendingStreams,
      // leaving the renderer stuck "streaming" — waitForIdle never resolves and
      // the just-completed reply's follow-up actions stay disabled. Returning -1
      // is the established no-op contract every caller already handles.
      if (safeIsStreamFinalized(payload?.streamId)) {
        return -1;
      }
      const pendingId = state.pendingStreams.get(payload.streamId);
      const sessionMessages = getSessionMessages(payload.sessionId);
      const segState = streamSegmentState.get(payload.streamId);
      const segIndex = segState ? segState.segmentIndex : 0;
      const messageId = segIndex === 0
        ? `assistant_${payload.streamId}`
        : `assistant_${payload.streamId}_seg${segIndex}`;
      const existingIndex = findPendingStreamEntryIndex(sessionMessages, pendingId, messageId, payload.streamId);
      if (existingIndex !== -1) {
        state.pendingStreams.set(payload.streamId, sessionMessages[existingIndex].id);
        return existingIndex;
      }
      // Seed only the current segment's slice of the cumulative aggregate so a
      // mixed-iteration preamble isn't duplicated into post-tool bubbles (W3.6).
      const initialContent = seedContent(segState, payload, '');
      const pendingMessage = optimisticAppend(payload.sessionId, 'assistant', initialContent, {
        id: messageId,
        status: payload.type === 'error' ? messageStatus.ERROR : messageStatus.STREAMING,
        streamId: payload.streamId,
        finalizedAt: payload.type === 'error' ? new Date().toISOString() : null,
        reasoning: { source: 'none', entries: [] },
        reasoning_phases: getReasoningPhasesForStream(payload.streamId),
      });
      state.pendingStreams.set(payload.streamId, pendingMessage.id);
      return getSessionMessages(payload.sessionId).findIndex((message) => message.id === pendingMessage.id);
    }

    function ensureRenderableReasoningStreamEntry(payload) {
      if (!normalizeId(payload?.sessionId) || !normalizeId(payload?.streamId)) {
        return -1;
      }
      return ensurePendingStreamEntry(payload);
    }

    function updatePendingMessage(payload, patch) {
      const index = ensurePendingStreamEntry(payload);
      const activeMessages = [...getSessionMessages(payload.sessionId)];
      if (index === -1) {
        return null;
      }
      activeMessages[index] = { ...activeMessages[index], ...patch };
      setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
      return { activeMessages, index };
    }

    const pendingStreamCommitQueue = createPendingStreamCommitQueue({
      minimumIntervalMs: 50,
      commit(entry) {
        const updated = updatePendingMessage(entry.payload, entry.patch);
        const sessionId = entry?.payload?.sessionId;
        const currentNow = normalizeId(sessionId) === normalizeId(state.currentSessionId);
        // Widened render gate (ide_chat_dock): the open Workspace dock counts as
        // a live chat surface; falls back to the pre-dock predicate flag-off.
        const visibleNow = currentNow && (
          (globalThis.rendererChatSurfaceLiveUtils || {}).isChatSurfaceLive?.(state)
          ?? (state.ui?.activeView === 'chat')
        );
        if (updated && visibleNow) {
          queueRender({ messages: true });
        } else if (updated && currentNow) {
          timelineVisibilityTracker?.markRenderableEvent?.(sessionId, {
            streamId: entry?.payload?.streamId,
            eventType: normalizeString(entry?.payload?.type) || 'stream_commit',
            visible: false,
            current: true,
          });
          safeAppendClientLog('DEBUG', 'stream.delta_current_not_visible', {
            sessionId: String(entry.payload.sessionId || '').slice(0, 30),
            activeView: state.ui?.activeView,
            aggregateLen: entry.payload.aggregateLength ?? String(entry.aggregate || '').length,
          });
          queueRender({ chrome: true });
        } else {
          queueRender({ chrome: true });
        }
        return updated;
      },
      requestAnimationFrame: typeof globalThis !== 'undefined' ? globalThis.requestAnimationFrame : null,
      cancelAnimationFrame: typeof globalThis !== 'undefined' ? globalThis.cancelAnimationFrame : null,
    });

    function flushPendingStreamCommit(streamId) {
      return pendingStreamCommitQueue.flush(normalizeId(streamId));
    }

    function flushPendingStreamCommitsForSession(sessionId) {
      const normalizedSessionId = normalizeId(sessionId);
      if (!normalizedSessionId) {
        return { flushedCount: 0, catchupRequired: false };
      }
      const flushed = pendingStreamCommitQueue.flushWhere((entry) =>
        normalizeId(entry?.payload?.sessionId) === normalizedSessionId
      );
      return {
        flushedCount: flushed.length,
        catchupRequired: timelineVisibilityTracker?.hasHiddenCatchup?.(normalizedSessionId) === true,
      };
    }

    return {
      optimisticAppend,
      ensurePendingStreamEntry,
      ensureRenderableReasoningStreamEntry,
      updatePendingMessage,
      pendingStreamCommitQueue,
      flushPendingStreamCommit,
      flushPendingStreamCommitsForSession,
    };
  }

  return { createPendingMessageUtils };
});
