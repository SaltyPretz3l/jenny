(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSessionLifecycleUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function createSessionLifecycleController(deps) {
    const { state } = deps;
    const sessionCacheController = deps.sessionCacheController || {};
    const thinkingController = deps.thinkingController || {};
    const jennyShell = deps.jennyShell || {};
    const syncRuntimeDraftFromActiveSession = deps.callbacks?.syncRuntimeDraftFromActiveSession || (() => {});
    const resetAttachmentQueue = deps.callbacks?.resetAttachmentQueue || (() => {});
    const clearActiveFileContext = deps.callbacks?.clearActiveFileContext
      || (() => globalThis.rendererIdeActiveFileContext?.clearPending?.());
    const renderAll = deps.callbacks?.renderAll || (() => {});
    const renderSessions = deps.callbacks?.renderSessions || (() => {});
    const renderHeader = deps.callbacks?.renderHeader || (() => {});
    const renderComposerState = deps.callbacks?.renderComposerState || (() => {});
    const setFollowLatest = deps.callbacks?.setFollowLatest || (() => {});
    const appendClientLog = deps.callbacks?.appendClientLog || (() => {});
    const patchSessionSummary = deps.callbacks?.patchSessionSummary || (() => {});
    const upsertSessionSummary = deps.callbacks?.upsertSessionSummary || (() => {});
    const removeSessionState = deps.callbacks?.removeSessionState || (() => {});
    const normalizeContextPreferences = deps.callbacks?.normalizeContextPreferences || ((v) => v || {});
    const clearStalePendingQuestionBatch = deps.callbacks?.clearStalePendingQuestionBatch || (async () => {});
    const getPendingQuestionBatch = deps.callbacks?.getPendingQuestionBatch || (() => null);
    const clearInteractiveDraft = deps.callbacks?.clearInteractiveDraft || (() => {});
    const getSessionMessages = deps.callbacks?.getSessionMessages || (() => []);
    const setSessionMessages = deps.callbacks?.setSessionMessages || (() => {});
    const setSessionTurnEventState = deps.callbacks?.setSessionTurnEventState || (() => {});
    const rehydrateLiveTurnState = typeof deps.callbacks?.rehydrateLiveTurnState === 'function'
      ? deps.callbacks.rehydrateLiveTurnState
      : () => null;
    const clearComposerStatusNotice = deps.callbacks?.clearComposerStatusNotice || (() => {});
    const resetArtifactsState = deps.callbacks?.resetArtifactsState || (() => {});
    const resetMemorySuggestionState = deps.callbacks?.resetMemorySuggestionState || (() => {});
    const clearDismissedMemorySession = deps.callbacks?.clearDismissedMemorySession || (() => {});
    const pruneSessionArtifacts = deps.callbacks?.pruneSessionArtifacts || (() => {});
    const evictPretextArticlePredictions = deps.callbacks?.evictPretextArticlePredictions || (() => {});
    const maybeAutoTitleSession = deps.callbacks?.maybeAutoTitleSession || (() => {});
    const prepareChatDockSessionTransition = deps.callbacks?.prepareChatDockSessionTransition || (() => false);

    const getMultiStreamController = deps.getMultiStreamController || (() => null);
    const getActiveSession = deps.callbacks?.getActiveSession || (() => null);

    function clearPendingApprovalsForSession(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) {
        return;
      }
      for (const [callId, approval] of [...state.pendingToolApprovals.entries()]) {
        if (String(approval?.sessionId || '').trim() === normalizedSessionId) {
          state.pendingToolApprovals.delete(callId);
        }
      }
    }

    async function rehydrateActiveTurnState(sessionId) {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId || typeof jennyShell.chat?.getActiveTurnState !== 'function') {
        return null;
      }
      let snapshot;
      try {
        snapshot = await jennyShell.chat.getActiveTurnState(normalizedSessionId);
      } catch (_error) {
        appendClientLog('WARN', 'chat.active_turn_rehydrate_failed', {
          sessionId: normalizedSessionId,
          reason: 'transport_failed',
        });
        return null;
      }
      if (snapshot !== null && (typeof snapshot !== 'object' || Array.isArray(snapshot))) {
        appendClientLog('WARN', 'chat.active_turn_rehydrate_failed', {
          sessionId: normalizedSessionId,
          reason: 'invalid_snapshot',
        });
        return null;
      }
      clearPendingApprovalsForSession(normalizedSessionId);
      const pendingApproval =
        snapshot && typeof snapshot === 'object' && snapshot.pending_approval && typeof snapshot.pending_approval === 'object'
          ? snapshot.pending_approval
          : null;
      if (!pendingApproval) {
        return snapshot;
      }
      const callId = String(pendingApproval.call_id || '').trim();
      if (!callId) {
        return snapshot;
      }
      const findPendingToolUseMessage = (messages) => (Array.isArray(messages) ? messages : []).find((message) =>
        String(message?.kind || '').trim() === 'tool_use'
        && String(message?.tool_call?.call_id || '').trim() === callId
        && String(message?.tool_call?.status || '').trim() === 'pending_approval'
      );
      const readSessionMessages = () =>
        state.messagesBySession instanceof Map
          ? state.messagesBySession.get(normalizedSessionId) || []
          : [];
      let toolUseMessage = findPendingToolUseMessage(readSessionMessages());
      if (!toolUseMessage && typeof jennyShell.sessions?.getMessages === 'function') {
        const persistedPayload = await jennyShell.sessions.getMessages(normalizedSessionId).catch(() => null);
        const persistedMessages = Array.isArray(persistedPayload?.data) ? persistedPayload.data : [];
        if (persistedMessages.length) {
          setSessionMessages(normalizedSessionId, persistedMessages, `session_${normalizedSessionId}`);
          setSessionTurnEventState(normalizedSessionId, {
            turnEventLogVersion: Number(persistedPayload?.turn_event_log_version || 0),
            turnEvents: Array.isArray(persistedPayload?.turn_events) ? persistedPayload.turn_events : [],
            activeTurn: persistedPayload?.active_turn ?? null,
          });
          rehydrateLiveTurnState(normalizedSessionId);
          toolUseMessage = findPendingToolUseMessage(readSessionMessages());
        }
      }
      if (!toolUseMessage) {
        return snapshot;
      }
      const streamId = String(snapshot?.request_id || toolUseMessage.tool_call?.parent_stream_id || '').trim();
      const approvalId = String(
        pendingApproval.approval_id
        || pendingApproval.approvalId
        || toolUseMessage.tool_call?.approval_id
        || ''
      ).trim() || callId;
      state.pendingToolApprovals.set(approvalId, {
        approvalId,
        callId,
        toolName: String(pendingApproval.tool_name || toolUseMessage.tool_call?.tool_name || '').trim(),
        input:
          toolUseMessage.tool_call?.input && typeof toolUseMessage.tool_call.input === 'object'
            ? { ...toolUseMessage.tool_call.input }
            : {},
        streamId,
        sessionId: normalizedSessionId,
        summary: String(pendingApproval.summary || toolUseMessage.tool_call?.summary || '').trim(),
      });
      const multiStreamController = getMultiStreamController();
      if (streamId) {
        multiStreamController?.registerStream?.(normalizedSessionId, streamId);
      }
      return snapshot;
    }

    async function reconcileSessionCaches() {
      const validSessionIds = new Set(
        state.sessions.map((session) => String(session?.id || '').trim()).filter(Boolean)
      );
      const staleSessionIds = new Set();
      const noteComposerV2SessionKeys = (sessionMap) => {
        if (!sessionMap || typeof sessionMap.keys !== 'function') {
          return;
        }
        for (const sessionId of sessionMap.keys()) {
          const normalizedSessionId = String(sessionId || '').trim();
          if (normalizedSessionId && !validSessionIds.has(normalizedSessionId)) {
            staleSessionIds.add(normalizedSessionId);
          }
        }
      };
      for (const sessionId of state.messagesBySession.keys()) {
        if (!validSessionIds.has(sessionId)) {
          staleSessionIds.add(sessionId);
        }
      }
      for (const sessionId of state.interactiveDraftsBySession.keys()) {
        if (!validSessionIds.has(sessionId)) {
          staleSessionIds.add(sessionId);
        }
      }
      if (state.turnEventsBySession instanceof Map) {
        for (const sessionId of state.turnEventsBySession.keys()) {
          if (!validSessionIds.has(sessionId)) {
            staleSessionIds.add(sessionId);
          }
        }
      }
      if (state.composerSessionState instanceof Map) {
        for (const sessionId of state.composerSessionState.keys()) {
          if (!validSessionIds.has(sessionId)) {
            staleSessionIds.add(sessionId);
          }
        }
      }
      const composerV2 = state.ui?.composerV2;
      if (composerV2 && typeof composerV2 === 'object') {
        noteComposerV2SessionKeys(composerV2.draftsBySession);
        noteComposerV2SessionKeys(composerV2.lifecycleBySession);
        noteComposerV2SessionKeys(composerV2.modeListeners);
      }
      for (const approval of state.pendingToolApprovals.values()) {
        const approvalSessionId = String(approval?.sessionId || '').trim();
        if (approvalSessionId && !validSessionIds.has(approvalSessionId)) {
          staleSessionIds.add(approvalSessionId);
        }
      }
      for (const sessionId of staleSessionIds) {
        await sessionCacheController.clearSessionStreamState(sessionId);
        removeSessionState(sessionId);
        state.sessionMessageAccessOrder?.delete(sessionId);
        clearDismissedMemorySession(sessionId);
      }
      if (staleSessionIds.size > 0) {
        evictPretextArticlePredictions();
      }
      pruneSessionArtifacts([...validSessionIds]);
      const currentSessionId = String(state.currentSessionId || '').trim();
      if (currentSessionId && !validSessionIds.has(currentSessionId)) {
        state.currentSessionId = state.sessions[0]?.id || '';
      } else if (!currentSessionId && state.sessions[0]) {
        state.currentSessionId = state.sessions[0].id;
      }
    }

    // Filter sessions.list snapshots against recent-delete tombstones so a pre-delete
    // response cannot resurrect a deleted id; IDs are never reused and the TTL bounds retention.
    const DELETED_SESSION_TOMBSTONE_TTL_MS = 5 * 60 * 1000;
    function isRecentlyDeletedSession(sessionId) {
      const tombstones = state.recentlyDeletedSessionIds;
      if (!(tombstones instanceof Map) || !tombstones.size) {
        return false;
      }
      const deletedAt = tombstones.get(sessionId);
      if (deletedAt === undefined) {
        return false;
      }
      if (Date.now() - Number(deletedAt) > DELETED_SESSION_TOMBSTONE_TTL_MS) {
        tombstones.delete(sessionId);
        return false;
      }
      return true;
    }

    async function refreshSessionSummaries(preferredSessionId = '', options = {}) {
      if (!state.auth.authenticated) {
        await loadSessions(preferredSessionId, options);
        return { currentSessionId: String(state.currentSessionId || '').trim(), validSessionIds: new Set() };
      }

      const payload = await jennyShell.sessions.list();
      const listedSessions = (Array.isArray(payload.data) ? payload.data : [])
        .filter((session) => !isRecentlyDeletedSession(String(session?.id || '').trim()));
      const preservedOptimisticSessions = state.sessions.filter((session) =>
        session?.optimistic_local === true
        && !listedSessions.some(
          (listedSession) => String(listedSession?.id || '').trim() === String(session?.id || '').trim()
        )
      );
      state.sessions = [...preservedOptimisticSessions, ...listedSessions];
      await reconcileSessionCaches();
      await sessionCacheController.evictColdSessionCaches();

      const validSessionIds = new Set(
        state.sessions.map((session) => String(session?.id || '').trim()).filter(Boolean)
      );
      const currentSessionId = String(state.currentSessionId || '').trim();
      const normalizedPreferredSessionId = String(preferredSessionId || '').trim();
      const preserveCurrentSession = options.preserveCurrentSession === true;

      if (preserveCurrentSession && currentSessionId && validSessionIds.has(currentSessionId)) {
        // Keep the current session bound while background work refreshes metadata.
      } else if (normalizedPreferredSessionId && validSessionIds.has(normalizedPreferredSessionId)) {
        state.currentSessionId = normalizedPreferredSessionId;
      } else if (currentSessionId && validSessionIds.has(currentSessionId)) {
        state.currentSessionId = currentSessionId;
      } else {
        state.currentSessionId = state.sessions[0]?.id || '';
      }

      if (state.currentSessionId) {
        syncRuntimeDraftFromActiveSession();
      }

      return { currentSessionId: String(state.currentSessionId || '').trim(), validSessionIds };
    }

    async function loadSessions(preferredSessionId = '', options = {}) {
      if (!state.auth.authenticated) {
        const multiStreamController = getMultiStreamController();
        state.sessions = [];
        state.currentSessionId = '';
        state.messagesBySession.clear();
        state.turnEventsBySession?.clear?.();
        state.sessionMessageAccessOrder.clear();
        state.pendingStreams.clear();
        state.streamThinkingStatusByStream.clear();
        state.toolCallsByStream.clear();
        state.pendingToolApprovals.clear();
        state.queuedSendBySession?.clear?.();
        state.turnClockBySession?.clear?.();
        state.sendOutboxController?.clearAll?.();
        state.sendOutboxBySession?.clear?.();
        state.ui?.chatSendLifecycleBySession?.clear?.();
        state.ui?.chatSendFailuresBySession?.clear?.();
        const composerV2 = state.ui?.composerV2;
        if (composerV2 && typeof composerV2 === 'object') {
          composerV2.draftsBySession?.clear?.();
          composerV2.lifecycleBySession?.clear?.();
        }
        multiStreamController?.dispose?.();
        state.activeStreamId = '';
        state.activeStreamSessionId = '';
        state.sendPreflight = null;
        state.runtimeDraft = {
          preferredModel: '',
          reasoningEffort: 'default',
          runMode: state.defaultRunMode || 'ask',
          planMode: false,
          contextPreferences: normalizeContextPreferences({}),
        };
        state.sendReceiptController?.clearFailedPayloads?.();
        globalThis.rendererComposerSessionStateController?.clearAll?.();
        resetAttachmentQueue();
        clearActiveFileContext();
        state.interactiveDraftsBySession.clear();
        resetMemorySuggestionState();
        if (typeof resetArtifactsState === 'function') resetArtifactsState();
        renderAll();
        return;
      }
      await refreshSessionSummaries(preferredSessionId, {
        preserveCurrentSession: options.preserveCurrentSession === true,
      });

      const skipOpenCurrent = Boolean(options.skipOpenCurrent);
      if (state.currentSessionId && !skipOpenCurrent && !state.messagesBySession.has(state.currentSessionId)) {
        await openSession(state.currentSessionId, { silent: true });
      }
      if (state.currentSessionId && state.messagesBySession.has(state.currentSessionId)) {
        await clearStalePendingQuestionBatch(state.currentSessionId);
        await rehydrateActiveTurnState(state.currentSessionId);
      }

      if (state.currentSessionId) syncRuntimeDraftFromActiveSession();
      renderAll();
    }

    // Returns false only when a plugin-navigation guard vetoes the switch;
    // successful hydration returns true and operational failures still throw.
    async function openSession(sessionId, { silent = false, outgoingSessionId: outgoingId } = {}) {
      evictPretextArticlePredictions();
      if (!silent) {
        globalThis.rendererNavigationIntent?.getOrCreateNavigationIntentOwner?.(state)?.noteUserNavigation?.();
      }
      // UIUX-006: #chatInput and state.attachments.queued are global
      // singletons. Capture the OUTGOING session's draft (by its id,
      // captured BEFORE currentSessionId flips — never re-read afterward)
      // so its text/selection/attachments survive the switch instead of
      // being silently overwritten/released; restoreForSession then owns
      // clearing/repopulating the composer for the incoming session in
      // place of the old unconditional resetAttachmentQueue() call.
      const outgoingSessionId = String((outgoingId ?? state.currentSessionId) || '').trim();
      const composerSessionState = globalThis.rendererComposerSessionStateController || null;
      const incomingSessionId = String(sessionId || '').trim();
      // Session-bound plugin views wait for broker-confirmed teardown. Opening
      // a provider workspace alone does not pre-empt an unrelated chat turn;
      // exclusive GPU admission happens only when the provider invokes work.
      const pluginSessions = globalThis.rendererPluginSessions?.instance || null;
      if (pluginSessions && !silent && outgoingSessionId !== incomingSessionId) {
        if (!(await pluginSessions.guardLeaveSession(outgoingSessionId, 'open_session'))) {
          return false;
        }
      }
      if (composerSessionState && outgoingSessionId && outgoingSessionId !== incomingSessionId) {
        composerSessionState.captureActive(outgoingSessionId, 'session_switch');
      }
      if (outgoingSessionId && outgoingSessionId !== incomingSessionId) {
        prepareChatDockSessionTransition(outgoingSessionId, incomingSessionId);
      }
      state.currentSessionId = sessionId;
      state.sessionMessageAccessOrder?.delete(sessionId);
      state.sessionMessageAccessOrder?.set(sessionId, Date.now());
      clearComposerStatusNotice();
      syncRuntimeDraftFromActiveSession();
      if (composerSessionState) {
        // A cache-miss refresh (loadSessions calling
        // openSession(state.currentSessionId, ...) to refetch messages)
        // reaches here with outgoing === incoming: the user never left this
        // session, so #chatInput's live text/selection and
        // state.attachments.queued are already correct. Restoring anyway
        // would stomp the live DOM with a stale/empty record (nothing
        // captured it, since captureActive above is skipped for the same
        // reason) and pointlessly bump the record generation, invalidating
        // any attachment token that began during this same session.
        if (outgoingSessionId !== incomingSessionId || composerSessionState.has?.(incomingSessionId) === false) {
          composerSessionState.restoreForSession(incomingSessionId);
        }
      } else {
        resetAttachmentQueue();
      }
      clearActiveFileContext();
      thinkingController.resumeAutoScroll();
      setFollowLatest(true);
      const activeSession = getActiveSession();
      if (!(activeSession?.local_draft === true && activeSession?.optimistic_local === true)) {
        const payload = await jennyShell.sessions.getMessages(sessionId);
        setSessionMessages(sessionId, payload.data || [], `session_${sessionId}`);
        setSessionTurnEventState(sessionId, {
          turnEventLogVersion: Number(payload?.turn_event_log_version || 0),
          turnEvents: Array.isArray(payload?.turn_events) ? payload.turn_events : [],
          activeTurn: payload?.active_turn ?? null,
        });
        rehydrateLiveTurnState(sessionId);
        // Lazy auto-title backfill (W9): untitled sessions with history get a
        // derived title now that their messages are loaded. Fire-and-forget —
        // the controller patches the summary and re-renders when it lands.
        maybeAutoTitleSession(sessionId);
      }
      state.sessionMessageAccessOrder?.delete(sessionId);
      state.sessionMessageAccessOrder?.set(sessionId, Date.now());
      await sessionCacheController.evictColdSessionCaches();
      await clearStalePendingQuestionBatch(sessionId);
      await rehydrateActiveTurnState(sessionId);
      if (!getPendingQuestionBatch(getActiveSession())) {
        clearInteractiveDraft(sessionId);
      }
      if (!silent) {
        renderAll();
        if (activeSession?.session_type === 'plugin') {
          await pluginSessions?.openSessionView?.(incomingSessionId, { userInitiated: true });
        }
      }
      return true;
    }

    return {
      reconcileSessionCaches,
      refreshSessionSummaries,
      loadSessions,
      openSession,
    };
  }

  return { createSessionLifecycleController };
});
