(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSessionCacheUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const MAX_CACHED_SESSION_MESSAGE_SETS =
    Number(globalThis.rendererBootstrapUtils?.MAX_CACHED_SESSION_MESSAGE_SETS) || 6;

  function createSessionCacheController(deps) {
    const { state } = deps;
    const getMultiStreamController = deps.getMultiStreamController || (() => null);
    const jennyShell = deps.jennyShell || {};
    const invalidateSessionArtifacts = deps.callbacks?.invalidateSessionArtifacts || (() => {});
    const clearDismissedMemorySession = deps.callbacks?.clearDismissedMemorySession || (() => {});
    const clearInteractiveDraft = deps.callbacks?.clearInteractiveDraft || (() => {});
    const appendClientLog = deps.callbacks?.appendClientLog || (() => {});

    function collectSessionStreamIds(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      const streamIds = new Set();
      if (!normalizedSessionId) {
        return streamIds;
      }
      const sessionMessages = state.messagesBySession.get(normalizedSessionId) || [];
      for (const message of sessionMessages) {
        const messageStreamId = String(message?.streamId || '').trim();
        if (messageStreamId) {
          streamIds.add(messageStreamId);
        }
        const toolCallStreamId = String(message?.tool_call?.parent_stream_id || '').trim();
        if (toolCallStreamId) {
          streamIds.add(toolCallStreamId);
        }
        const toolResultStreamId = String(message?.tool_result?.parent_stream_id || '').trim();
        if (toolResultStreamId) {
          streamIds.add(toolResultStreamId);
        }
      }
      for (const approval of state.pendingToolApprovals.values()) {
        if (String(approval?.sessionId || '').trim() !== normalizedSessionId) {
          continue;
        }
        const streamId = String(approval?.streamId || '').trim();
        if (streamId) {
          streamIds.add(streamId);
        }
      }
      if (normalizedSessionId === String(state.currentSessionId || '').trim()) {
        const activeStreamId = String(state.activeStreamId || '').trim();
        if (activeStreamId) {
          streamIds.add(activeStreamId);
        }
      }
      const multiStreamController = getMultiStreamController();
      const controllerStreamId = String(multiStreamController?.getStreamIdForSession?.(normalizedSessionId) || '').trim();
      if (controllerStreamId) streamIds.add(controllerStreamId);
      const controllerPreflight = multiStreamController?.getPreflight?.(normalizedSessionId) || null;
      const controllerPreflightStreamId = String(controllerPreflight?.streamId || '').trim();
      if (controllerPreflightStreamId) streamIds.add(controllerPreflightStreamId);
      const sendPreflightStreamId = String(state.sendPreflight?.streamId || '').trim();
      const sendPreflightSessionId = String(state.sendPreflight?.sessionId || '').trim();
      if (sendPreflightStreamId && sendPreflightSessionId === normalizedSessionId) {
        streamIds.add(sendPreflightStreamId);
      }
      return streamIds;
    }

    function getPinnedSessionIds() {
      const pinned = new Set();
      const currentSessionId = String(state.currentSessionId || '').trim();
      if (currentSessionId) pinned.add(currentSessionId);
      const multiStreamController = getMultiStreamController();
      (multiStreamController?.getStreamingSessionIds?.() || []).forEach((sessionId) => {
        const normalizedSessionId = String(sessionId || '').trim();
        if (normalizedSessionId) pinned.add(normalizedSessionId);
      });
      (multiStreamController?.getPreflightSessionIds?.() || []).forEach((sessionId) => {
        const normalizedSessionId = String(sessionId || '').trim();
        if (normalizedSessionId) pinned.add(normalizedSessionId);
      });
      // Derive each session's stream set once and test it against the pending
      // streams, instead of re-deriving every session's set for every pending
      // stream (was O(pendingStreams x sessions x messages) with a fresh Set per
      // pair). Equivalent: a session is pinned iff its stream set holds a pending
      // stream id. collectSessionStreamIds normalizes the key (empty set for a
      // blank id), so only normalize again at the add site.
      for (const sessionId of state.messagesBySession.keys()) {
        for (const streamId of collectSessionStreamIds(sessionId)) {
          if (state.pendingStreams.has(streamId)) {
            const normalizedSessionId = String(sessionId || '').trim();
            if (normalizedSessionId) pinned.add(normalizedSessionId);
            break;
          }
        }
      }
      for (const approval of state.pendingToolApprovals.values()) {
        const sessionId = String(approval?.sessionId || '').trim();
        if (sessionId) pinned.add(sessionId);
      }
      const sendPreflightSessionId = String(state.sendPreflight?.sessionId || '').trim();
      if (sendPreflightSessionId) pinned.add(sendPreflightSessionId);
      return pinned;
    }

    // Shared cache-entry teardown for both eviction loops below. The orphan
    // purge also drops the postwork marker (the session id is gone from
    // state.sessions, so no postwork continuation can legitimately finish);
    // cap eviction keeps it — that session still exists, and a live postwork
    // window must not be torn down by mere cache pressure.
    async function evictSessionCacheEntry(sessionId, { clearPostwork = false } = {}) {
      await clearSessionStreamState(sessionId);
      state.messagesBySession.delete(sessionId);
      state.interactiveDraftsBySession.delete(sessionId);
      state.sessionMessageAccessOrder?.delete(sessionId);
      invalidateSessionArtifacts(sessionId);
      clearDismissedMemorySession(sessionId);
      if (clearPostwork) {
        getMultiStreamController()?.clearTerminalPostwork?.(sessionId);
      }
    }

    async function evictColdSessionCaches() {
      if (!(state.messagesBySession instanceof Map)) {
        return;
      }
      const validSessionIds = new Set(state.sessions.map((session) => String(session?.id || '').trim()).filter(Boolean));
      // Purge orphaned cache entries before cap eviction so removed sessions cannot
      // remain alive through the postwork validity fallback.
      for (const sessionId of [...state.messagesBySession.keys()]) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId || validSessionIds.has(normalizedSessionId)) {
          continue;
        }
        await evictSessionCacheEntry(normalizedSessionId, { clearPostwork: true });
      }
      const pinnedSessionIds = getPinnedSessionIds();
      while (state.messagesBySession.size > MAX_CACHED_SESSION_MESSAGE_SETS) {
        let candidateSessionId = '';
        let candidateAccessTs = Number.POSITIVE_INFINITY;
        for (const sessionId of state.messagesBySession.keys()) {
          const normalizedSessionId = String(sessionId || '').trim();
          if (!normalizedSessionId || !validSessionIds.has(normalizedSessionId)) {
            continue;
          }
          if (pinnedSessionIds.has(normalizedSessionId)) {
            continue;
          }
          const accessTs = Number(state.sessionMessageAccessOrder?.get(normalizedSessionId) || 0);
          if (!candidateSessionId || accessTs < candidateAccessTs) {
            candidateSessionId = normalizedSessionId;
            candidateAccessTs = accessTs;
          }
        }
        if (!candidateSessionId) {
          break;
        }
        await evictSessionCacheEntry(candidateSessionId);
      }
    }

    async function clearSessionStreamState(sessionId, options = {}) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return;
      }
      const multiStreamController = getMultiStreamController();
      const shouldCancelActive = options.cancelActive === true;
      const streamIds = collectSessionStreamIds(normalizedSessionId);
      const activeStreamId = String(state.activeStreamId || '').trim();
      const cancelStreamId = String(multiStreamController?.getActiveStreamIdForCancel?.(normalizedSessionId)
        || (activeStreamId && streamIds.has(activeStreamId) ? activeStreamId : '')).trim();
      if (shouldCancelActive && cancelStreamId) {
        await jennyShell.chat?.cancelStream?.(cancelStreamId, {
          cancel_reason: 'session_delete',
        }).catch(() => {});
      }
      for (const streamId of streamIds) {
        state.pendingStreams.delete(streamId);
        state.streamThinkingStatusByStream.delete(streamId);
        state.toolCallsByStream.delete(streamId);
      }
      for (const [callId, approval] of [...state.pendingToolApprovals.entries()]) {
        const approvalSessionId = String(approval?.sessionId || '').trim();
        const approvalStreamId = String(approval?.streamId || '').trim();
        if (approvalSessionId === normalizedSessionId || (approvalStreamId && streamIds.has(approvalStreamId))) {
          state.pendingToolApprovals.delete(callId);
        }
      }
      if (activeStreamId && streamIds.has(activeStreamId)) {
        state.activeStreamId = '';
        state.activeStreamSessionId = '';
      }
      const controllerPreflight = multiStreamController?.getPreflight?.(normalizedSessionId) || null;
      if (controllerPreflight?.pending) controllerPreflight.discarded = true;
      multiStreamController?.clearSessionStream?.(normalizedSessionId);
      multiStreamController?.clearPreflight?.(normalizedSessionId);
      const sendPreflightStreamId = String(state.sendPreflight?.streamId || '').trim();
      const sendPreflightSessionId = String(state.sendPreflight?.sessionId || '').trim();
      if (
        state.sendPreflight
        && (
          sendPreflightSessionId === normalizedSessionId
          || (sendPreflightStreamId && streamIds.has(sendPreflightStreamId))
        )
      ) {
        if (state.sendPreflight.pending && sendPreflightSessionId === normalizedSessionId) {
          state.sendPreflight.discarded = true;
        } else {
          state.sendPreflight = null;
        }
      }
    }

    return {
      collectSessionStreamIds,
      getPinnedSessionIds,
      evictColdSessionCaches,
      clearSessionStreamState,
    };
  }

  return { createSessionCacheController };
});
