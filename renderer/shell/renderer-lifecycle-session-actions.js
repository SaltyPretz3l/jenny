/* renderer/shell/renderer-lifecycle-session-actions.js - session create / rename / delete of the lifecycle controller.
 *
 * Split out of renderer-lifecycle-utils.js (which creates this once per controller and keeps the
 * window.rendererTaskSessionActions / rendererSessionTeardown publications): the renderer-side flows
 * around the backend session calls, including the local-draft create while a send is busy and the
 * renderer teardown shared by Delete and Delete all chats.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererLifecycleSessionActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createLocalDraftSessionId() { return `session_local_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`; }

  function createLifecycleSessionActions(deps) {
    const {
      state,
      fwd,
      call,
      chatInput,
      thinkingController,
      INTERACTIVE_SEQUENCE_IDLE,
      appendClientLog,
      getCurrentRuntimePreferences,
      mergeRequestedRuntimePreferences,
      normalizeReasoningEffort,
      getMultiStreamController,
      loadSessions,
      setActiveView,
      clearSessionStreamState,
      getComposerSessionStateController,
    } = deps;

    async function handleCreateSession(options = {}) {
      const previousCurrentSessionId = String(state.currentSessionId || '').trim();
      const knownSessionIds = new Set(
        Array.isArray(state.sessions)
          ? state.sessions.map((session) => String(session?.id || '').trim()).filter(Boolean)
          : []
      );
      fwd.clearComposerStatusNotice();
      if (fwd.isAnySendBusy() && typeof options.initialPrompt !== 'string' && options.requireRecord !== true) {
        const runtimePreferences = mergeRequestedRuntimePreferences(getCurrentRuntimePreferences(), options.preferences, normalizeReasoningEffort);
        const sessionId = createLocalDraftSessionId();
        const timestamp = new Date().toISOString();
        fwd.upsertSessionSummary({
          id: sessionId, title: 'New Chat', session_type: 'chat',
          created_at: timestamp, updated_at: timestamp, message_count: 0,
          last_message_preview: '', last_model_used: '',
          preferred_model: runtimePreferences.preferredModel,
          reasoning_effort: runtimePreferences.reasoningEffort,
          conversation_mode: 'chat',
          pending_question_batch: null, interactive_sequence_state: INTERACTIVE_SEQUENCE_IDLE,
          interactive_round_count: 0, plan_mode: runtimePreferences.planMode === true,
          run_mode: runtimePreferences.runMode, pre_plan_run_mode: runtimePreferences.prePlanRunMode,
          context_preferences: {
            history_scope: runtimePreferences.contextPreferences.historyScope,
            include_personality: runtimePreferences.contextPreferences.includePersonality !== false,
            include_memory: runtimePreferences.contextPreferences.includeMemory !== false,
            memory_opt_out: runtimePreferences.contextPreferences.memoryOptOut === true,
          },
          optimistic_local: true,
          local_draft: true,
        }, { prepend: true });
        fwd.setSessionMessages(sessionId, [], `session_${sessionId}`);
        state.currentSessionId = sessionId;
        state.runtimeDraft = {
          preferredModel: runtimePreferences.preferredModel,
          reasoningEffort: runtimePreferences.reasoningEffort,
          runMode: runtimePreferences.runMode,
          prePlanRunMode: runtimePreferences.prePlanRunMode,
          planMode: runtimePreferences.planMode,
          contextPreferences: runtimePreferences.contextPreferences,
        };
        fwd.renderAll();
        chatInput.focus();
        appendClientLog('INFO', 'sessions.created_local_draft', { sessionId });
        return sessionId;
      }
      const runtimePreferences = mergeRequestedRuntimePreferences(getCurrentRuntimePreferences(), options.preferences, normalizeReasoningEffort);
      const payload = await window.jennyShell.sessions.create({
        title: String(options.title || 'New Chat').trim(),
        ...(typeof options.initialPrompt === 'string' ? { initialPrompt: options.initialPrompt } : {}), ...(typeof options.linkedTaskId === 'string' && options.linkedTaskId ? { linkedTaskId: options.linkedTaskId } : {}),
        ...(typeof options.projectId === 'string' && /^project_[A-Za-z0-9_-]{1,128}$/u.test(options.projectId) ? { projectId: options.projectId } : {}),
        // /handoff links the new chat to its source (row 60 W4); the backend refuses one from the primary chat.
        ...(typeof options.handoffFromSessionId === 'string' && options.handoffFromSessionId && options.handoffFromSessionId.length <= 256
          ? { handoffFromSessionId: options.handoffFromSessionId } : {}),
        preferences: {
          preferred_model: runtimePreferences.preferredModel,
          reasoning_effort: runtimePreferences.reasoningEffort,
          ...(options.runMode === 'plan' ? { run_mode: 'plan' } : {}),
          context_preferences: {
            history_scope: runtimePreferences.contextPreferences.historyScope,
            include_personality: runtimePreferences.contextPreferences.includePersonality,
            include_memory: runtimePreferences.contextPreferences.includeMemory,
            memory_opt_out: runtimePreferences.contextPreferences.memoryOptOut === true,
          },
        },
      });
      const createdSessionId = String(payload?.data?.id || '').trim();
      getComposerSessionStateController()?.captureActive(previousCurrentSessionId, 'session_create');
      state.currentSessionId = createdSessionId;
      // Pane 0's follow intent; a chat created into another pane re-latches that pane's own (pane composition).
      if (!(state.panes?.panes?.length > 1) || state.panes.focusedPaneId === 0) {
        thinkingController.resumeAutoScroll();
        fwd.setFollowLatest(true);
      }
      fwd.setSessionMessages(createdSessionId, [], `session_${createdSessionId}`);
      await loadSessions(createdSessionId, { skipOpenCurrent: true });
      if (state.currentSessionId === createdSessionId) { // navigation during the await: never restore over another session's composer
        getComposerSessionStateController()?.restoreForSession(createdSessionId);
        if (createdSessionId && typeof options.initialPrompt === 'string') setActiveView('chat');
        fwd.renderAll(); chatInput.focus();
      }
      appendClientLog('INFO', 'sessions.created', { sessionId: createdSessionId });
      return createdSessionId
        && createdSessionId !== previousCurrentSessionId
        && !knownSessionIds.has(createdSessionId)
        ? createdSessionId
        : '';
    }

    async function handleRenameSession(sessionId, nextTitleInput) {
      const session = state.sessions.find((item) => item.id === sessionId);
      const currentTitle = session && session.title ? session.title : 'New Chat';
      const nextTitle = String(nextTitleInput == null ? '' : nextTitleInput).trim();
      if (!nextTitle || nextTitle === currentTitle.trim()) {
        return;
      }
      await window.jennyShell.sessions.rename(sessionId, nextTitle);
      await loadSessions(sessionId, { skipOpenCurrent: true });
      fwd.renderSessions();
      fwd.renderHeader();
      appendClientLog('INFO', 'sessions.renamed', { sessionId });
    }

    function discardSessionPreflight(id) {
      const sp = state.sendPreflight;
      const pending = getMultiStreamController()?.getPreflight?.(id);
      if (pending) pending.discarded = true;
      if (sp && [sp.sessionId, sp.optimisticSessionId].some((value) => String(value || '').trim() === id)) sp.discarded = true;
    }
    function dropSessionState(id) { fwd.removeSessionState(id, { tombstone: true }); call.invalidateSessionArtifacts?.(id); }
    // Renderer teardown for a session the backend already deleted; Delete all chats (row 95) reuses it.
    async function forgetDeletedSession(sessionId) {
      const id = String(sessionId || '').trim();
      if (id) { discardSessionPreflight(id); await clearSessionStreamState(id, { cancelActive: true }); dropSessionState(id); }
    }

    async function handleDeleteSession(sessionId, options = {}) {
      // Confirmation moved to the undo window: renderer-session-actions defers
      // this hard delete behind an Undo toast; callers reach it via that path.
      const isOptimisticLocal = state.sessions.find((session) => session.id === sessionId)?.optimistic_local === true;
      const normalizedSessionId = String(sessionId || '').trim();
      const controllerPreflight = getMultiStreamController()?.getPreflight?.(normalizedSessionId) || null;
      if (options.onlyIfIdle === true && (controllerPreflight
        || getMultiStreamController()?.getActiveStreamIdForCancel?.(normalizedSessionId)
        || state.sendOutboxBySession?.get?.(normalizedSessionId)?.length
        || state.sendPreflight?.sessionId === normalizedSessionId
        || state.sendPreflight?.optimisticSessionId === normalizedSessionId)) {
        return { id: sessionId, deleted: false, reason: 'session_busy' };
      }
      discardSessionPreflight(normalizedSessionId);
      if (options.onlyIfIdle !== true) await clearSessionStreamState(sessionId, { cancelActive: true });
      let cleanup = {};
      if (!isOptimisticLocal) {
        const deleteResult = await window.jennyShell.sessions.delete(sessionId, options);
        // The main-process cleanup outcome rides back for the delete toast.
        if (deleteResult?.cleanup_status) cleanup = { cleanup_status: deleteResult.cleanup_status, freed: deleteResult.freed };
        if (options.onlyIfIdle === true && (deleteResult?.id !== sessionId || deleteResult?.deleted !== true)) {
          return { id: sessionId, deleted: false, reason: deleteResult?.reason || 'delete_unacknowledged' };
        }
        if (deleteResult && typeof deleteResult === 'object'
          && Object.prototype.hasOwnProperty.call(deleteResult, 'deleted') && deleteResult.deleted !== true) {
          if (options.onlyIfIdle === true) return deleteResult;
          throw new Error('Session could not be deleted because the session store refused the delete request.');
        }
      }
      // tombstone: the backend delete above succeeded (or the session was
      // optimistic-local and never reached the backend), so a stale list
      // snapshot must not resurrect the id (Audit A2).
      if (options.onlyIfIdle === true) await clearSessionStreamState(sessionId, { cancelActive: false });
      dropSessionState(normalizedSessionId);
      await loadSessions();
      fwd.renderAll();
      appendClientLog('INFO', 'sessions.deleted', { sessionId });
      return { id: sessionId, deleted: true, ...cleanup };
    }

    return { handleCreateSession, handleRenameSession, handleDeleteSession, forgetDeletedSession };
  }

  return { createLifecycleSessionActions };
});
