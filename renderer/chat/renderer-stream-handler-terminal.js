(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerTerminal = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function resolveTerminalMergeModule() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererStreamHandlerTerminalMerge) {
      return globalThis.rendererStreamHandlerTerminalMerge;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-stream-handler-terminal-merge'); } catch (_error) { /* browser script mode */ }
    }
    return null;
  }
  const _terminalMergeModule = resolveTerminalMergeModule();
  if (!_terminalMergeModule || typeof _terminalMergeModule.createTerminalMergeUtils !== 'function') {
    throw new Error('renderer-stream-handler-terminal-merge must load before renderer/chat/renderer-stream-handler-terminal.js');
  }
  const { buildAgentProgressSnapshot, createTerminalMergeUtils, normalizeUnsavedDurability } = _terminalMergeModule;

  function resolveResumeTurnAffordanceModule() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererResumeTurnAffordance) return globalThis.rendererResumeTurnAffordance;
    if (typeof require === 'function') {
      try { return require('./renderer-resume-turn-affordance'); } catch (_error) { /* browser script mode */ }
    }
    return null;
  }
  // Resolved lazily, never at module load: this file's script tag precedes
  // renderer-resume-turn-affordance.js in index.html, so a load-time read would
  // capture undefined in the app and silently disable the live stamp forever.
  let _resumableStopKinds = null;
  function resumableStopKinds() {
    if (!_resumableStopKinds) {
      _resumableStopKinds = resolveResumeTurnAffordanceModule()?.RESUMABLE_STOP_KINDS || null;
    }
    return _resumableStopKinds;
  }

  function resolveTerminalPostworkUtilsModule() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererStreamHandlerTerminalPostworkUtils) {
      return globalThis.rendererStreamHandlerTerminalPostworkUtils;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-stream-handler-terminal-postwork-utils'); } catch (_error) { /* browser script mode */ }
    }
    return null;
  }
  const _terminalPostworkUtilsModule = resolveTerminalPostworkUtilsModule();
  if (!_terminalPostworkUtilsModule || typeof _terminalPostworkUtilsModule.createTerminalPostworkUtils !== 'function') {
    throw new Error('renderer-stream-handler-terminal-postwork-utils must load before renderer/chat/renderer-stream-handler-terminal.js');
  }
  const { createTerminalPostworkUtils } = _terminalPostworkUtilsModule;

  function resolveContinuationGuardModule() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererStreamContinuationGuard) {
      return globalThis.rendererStreamContinuationGuard;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-stream-continuation-guard'); } catch (_error) { /* browser script mode */ }
    }
    return null;
  }
  const _continuationGuardModule = resolveContinuationGuardModule();
  if (!_continuationGuardModule || typeof _continuationGuardModule.createStreamContinuationOwner !== 'function') {
    throw new Error('renderer-stream-continuation-guard must load before renderer/chat/renderer-stream-handler-terminal.js');
  }
  const { createStreamContinuationOwner } = _continuationGuardModule;

  function resolveTerminalStateModule() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererStreamTerminalState) {
      return globalThis.rendererStreamTerminalState;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-stream-terminal-state'); } catch (_error) { /* browser script mode */ }
    }
    return null;
  }
  const _terminalStateModule = resolveTerminalStateModule();
  if (!_terminalStateModule || typeof _terminalStateModule.createTerminalStateUtils !== 'function') {
    throw new Error('renderer-stream-terminal-state must load before renderer/chat/renderer-stream-handler-terminal.js');
  }
  const { createTerminalStateUtils, resolveTerminalPresentation } = _terminalStateModule;

  function createStreamTerminalHandlers(options = {}) {
    const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
    const requestFrame = typeof globalRef.requestAnimationFrame === 'function'
      ? globalRef.requestAnimationFrame.bind(globalRef)
      : (callback) => globalRef.setTimeout(callback, 16);
    const jennyShell = globalRef.window?.jennyShell || globalRef.jennyShell || null;
    const {
      state,
      chatInput = null,
      MAX_INTERACTIVE_QUESTIONS = 0,
      MAX_INTERACTIVE_ROUNDS = 0,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED = '',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE = '',
      MESSAGE_STATUS = {},
      TOAST_SOURCE = {},
      appendClientLog = () => {},
      normalizePendingQuestionBatch = (batch) => batch || null,
      getInteractiveSequenceState = () => 'idle',
      clearInteractiveDraft = () => {},
      ensureInteractiveDraft = () => {},
      patchSessionSummary = () => {},
      buildInteractiveQuestionBatchVisibleText = () => '',
      refreshSessionMetadata = async () => {},
      refreshSnapshots = async () => {},
      refreshObservability = async () => {},
      dismissStreamErrors = () => {},
      maybeSuggestMemoryCapture = async () => {},
      getInteractiveComposerStatusNotice = () => '',
      persistInteractiveFallbackRequest = async () => {},
      requestInteractiveGuardrailAnswer = async () => {},
      queueInteractiveComposerFocus = () => {},
      getQueuedSend = () => null,
      restoreQueuedSendDraft = () => {},
      dispatchQueuedSendForSession = async () => null,
      updateContextUsage = () => {},
      completeThinkingIndicator = () => {},
      resetThinkingIndicator = () => {},
      clearStreamThinkingStatus = () => {},
      finalizeTerminalStream = () => {},
      resetLifecycleIfSettling = () => {},
      clearTerminalPostwork = () => {},
      finishTerminalPostwork = null,
      beginTerminalPostworkGeneration = () => null,
      isTerminalPostworkGenerationCurrent = () => true,
      ensurePendingStreamEntry = () => -1,
      getSessionMessages = () => [],
      setSessionMessages = () => {},
      setSessionTurnEventState = () => {},
      createNormalizedMessage = (_role, _content, extra = {}) => ({ ...extra }),
      setSessionComposerNotice = () => {},
      clearSessionComposerNotice = () => {},
      queueSessionRender = () => {},
      isCurrentSession = () => false,
      isVisibleChatSession = () => false,
      normalizeId = (value) => String(value || '').trim(),
      showToastMessage = () => {},
      isRowModelEnabled = () => false,
      reconcileLiveTurnWithHydratedRows = () => null,
      clearSessionLiveTurnState = () => false,
      isSessionStreaming = () => false,
      captureStreamGeneration = () => null,
      isStreamGenerationCurrent = () => true,
    } = options;

    function focusChatInput(sessionId) {
      if (!isVisibleChatSession(sessionId)) {
        return;
      }
      requestFrame(() => {
        try {
          if (isVisibleChatSession(sessionId) && chatInput && typeof chatInput.focus === 'function') {
            chatInput.focus();
          }
        } catch (_) { /* focus best-effort */ }
      });
    }

    const terminalStateUtils = createTerminalStateUtils({ MESSAGE_STATUS, normalizeId, appendClientLog });
    const {
      guardTerminalHydratedMessages,
      isCompleteStatus,
      isTerminalStatus,
      isTerminalStreamLocalArtifact,
      readMessageAssociatedStreamId,
      statusEquals,
    } = terminalStateUtils;

    const terminalMergeUtils = createTerminalMergeUtils({
      normalizeId,
      readMessageAssociatedStreamId,
      isTerminalStatus,
      isCompleteStatus,
      isTerminalStreamLocalArtifact,
      appendClientLog,
    });
    const { findSyntheticErrorInsertIndex, findLateReconcileBubbleIndex } = terminalMergeUtils;

    // CTL-006 + CTL-013: bounded per-stage deadlines for the postwork window
    // plus the generation/session-alive validity gate for late continuations.
    // Extracted to a sibling module (kept this file under the size cap).
    const postworkUtils = createTerminalPostworkUtils({
      state,
      appendClientLog,
      isTerminalPostworkGenerationCurrent,
      normalizeId,
    });
    const {
      HYDRATION_DEADLINE_MS,
      REFRESH_DEADLINE_MS,
      MEMORY_CAPTURE_DEADLINE_MS,
      runDeadlineStage,
      noteStageDuration,
      reportSlowPostwork,
      isPostworkContinuationValid,
    } = postworkUtils;
    const continuationOwner = createStreamContinuationOwner({
      state,
      normalizeId,
      captureStreamGeneration,
      isStreamGenerationCurrent,
      isPostworkContinuationValid,
    });
    const { beginMessageUpdate, createTerminalContinuation } = continuationOwner;
    // Audit A5: close the postwork window with compare-and-clear so an older
    // overlapping continuation's finally cannot tear down a newer generation.
    // ide_chat_dock W5: a render draining while postwork is open recomputes the
    // composer from sendBusy === true. Closing must always queue another
    // composer recompute or that last pre-close render can latch it disabled.
    function finishPostworkWindow(sessionId, token) {
      const closeResult = typeof finishTerminalPostwork === 'function'
        ? finishTerminalPostwork(sessionId, token)
        : clearTerminalPostwork(sessionId);
      const activeView = state?.ui?.activeView;
      if (activeView === 'ide'
        && (globalThis.rendererChatSurfaceLiveUtils || {}).isChatSurfaceLive?.(state) === true) {
        const documentRef = typeof document !== 'undefined' ? document : null;
        const ideView = documentRef?.getElementById?.('ideView') || null;
        appendClientLog('INFO', 'ide_chat_dock.composer_state', {
          sessionId: String(sessionId || '').slice(0, 30),
          activeView,
          chatInputDisabled: chatInput?.disabled === true,
          ideViewInert: ideView?.inert === true,
          ideViewAriaHidden: ideView?.getAttribute?.('aria-hidden') ?? null,
          composerParentId: documentRef?.getElementById?.('composerWrap')?.parentElement?.id || null,
          activeElementId: documentRef?.activeElement?.id || null,
        });
      }
      const turnClock = state?.turnClockBySession?.get(sessionId);
      if (turnClock && turnClock.endedAt == null) turnClock.endedAt = Date.now();
      queueSessionRender(sessionId, { composer: true, composerStatus: true });
      return closeResult;
    }

    function mergeTerminalHydratedMessages(sessionId, hydratedMessages, options = {}) {
      const sessionMessages = getSessionMessages(sessionId);
      const currentMessages = Array.isArray(sessionMessages) ? sessionMessages : [];
      return terminalMergeUtils.mergeTerminalHydratedMessages(
        currentMessages,
        hydratedMessages,
        { ...options, sessionId }
      );
    }

    function readHydratedTurnEventState(refreshedSessionMessages) {
      const turnEventLogVersion = Number(
        refreshedSessionMessages?.turn_event_log_version
        ?? refreshedSessionMessages?.turnEventLogVersion
        ?? 0
      ) || 0;
      const turnEvents = Array.isArray(refreshedSessionMessages?.turn_events)
        ? refreshedSessionMessages.turn_events
        : (Array.isArray(refreshedSessionMessages?.turnEvents) ? refreshedSessionMessages.turnEvents : []);
      return { turnEventLogVersion, turnEvents };
    }

    async function fetchHydratedTerminalMessages(sessionId, fallbackMessages, options = {}) {
      const fallback = Array.isArray(fallbackMessages) ? fallbackMessages : [];
      const streamId = options.streamId;
      const postworkToken = options.postworkToken;
      // CTL-006: hydration gets its own bounded deadline. A hung getMessages
      // must not block the rest of postwork (or the busy gate) forever; the
      // real call keeps running in the background (its own .then/.catch
      // handlers inside withPostworkDeadline keep it from surfacing as an
      // unhandled rejection) but this function stops waiting on it.
      let raced;
      try {
        raced = await runDeadlineStage(
          'hydration',
          sessionId,
          streamId,
          () => jennyShell?.sessions?.getMessages?.(sessionId),
          HYDRATION_DEADLINE_MS,
          { continuationGuard: options.continuationGuard }
        );
      } catch (hydrationError) {
        // The deadline racer deliberately re-throws real rejections, but
        // hydration always degraded to the local fallback on failure
        // (`.catch(() => null)` pre-CTL-006) — a transient getMessages
        // rejection must not escape and skip the settle/toast/refresh chain
        // downstream (code review 2026-07-10).
        appendClientLog('WARN', 'stream.terminal_hydration_failed', {
          sessionId: String(sessionId || '').slice(0, 30),
          streamId: String(streamId || '').slice(0, 30),
          message: hydrationError && hydrationError.message
            ? String(hydrationError.message).slice(0, 200)
            : String(hydrationError),
        });
        raced = { timedOut: false, value: null };
      }
      // CTL-013: the session may have been deleted (or a newer postwork
      // generation may have superseded this one) while hydration was in
      // flight — including while it hung past the deadline. Checked BEFORE the
      // timeout early-return so a delete-during-hang also aborts. A stale
      // continuation does NOTHING beyond one bounded diagnostic — no
      // setSessionMessages, no turn-event write, no downstream postwork.
      if (!isPostworkContinuationValid(sessionId, postworkToken)
        || (options.continuationGuard && options.continuationGuard.isCurrent() !== true)) {
        appendClientLog('DEBUG', 'stream.terminal_postwork_stale_continuation', {
          sessionId: String(sessionId || '').slice(0, 30),
          streamId: String(streamId || '').slice(0, 30),
          stage: 'hydration',
        });
        return { messages: fallback, turnEventState: null, aborted: true, timedOut: raced.timedOut === true };
      }
      if (raced.timedOut) {
        return { messages: fallback, turnEventState: null, aborted: false, timedOut: true };
      }
      const refreshedSessionMessages = raced.value;
      const refreshedMessages = Array.isArray(refreshedSessionMessages?.data)
        ? refreshedSessionMessages.data
        : null;
      if (Array.isArray(refreshedMessages) && (refreshedMessages.length > 0 || fallback.length === 0)) {
        const guardedMessages = guardTerminalHydratedMessages(sessionId, refreshedMessages, fallback, options);
        const mergedMessages = mergeTerminalHydratedMessages(sessionId, guardedMessages, options);
        const turnEventState = readHydratedTurnEventState(refreshedSessionMessages);
        setSessionMessages(sessionId, mergedMessages, `session_${sessionId}`);
        setSessionTurnEventState(sessionId, turnEventState);
        return {
          messages: mergedMessages,
          turnEventState,
          aborted: false,
        };
      }
      return {
        messages: fallback,
        turnEventState: null,
        aborted: false,
      };
    }

    // Terminal-once is enforced synchronously at the dispatch boundary.
    function settleRowModelTerminalState(
      sessionId,
      streamId,
      messages,
      turnEventState = null,
      canonicalTurnEvents = undefined
    ) {
      if (isRowModelEnabled(sessionId)) {
        reconcileLiveTurnWithHydratedRows(
          sessionId,
          streamId,
          messages,
          turnEventState,
          canonicalTurnEvents
        );
        if (!isVisibleChatSession(sessionId)) {
          clearSessionLiveTurnState(sessionId);
        }
      } else {
        clearSessionLiveTurnState(sessionId);
      }
    }

    async function handleQuestionBatch(payload, callOptions = {}) {
      const index = ensurePendingStreamEntry(payload);
      const activeMessages = [...getSessionMessages(payload.sessionId)];
      const batch = normalizePendingQuestionBatch(payload.batch);
      const durability = normalizeUnsavedDurability(payload.durability);
      if (index === -1) {
        resetThinkingIndicator(payload.sessionId);
        return { buffered: false, terminal: false };
      }
      if (!batch || batch.questions.length < 1 || batch.questions.length > MAX_INTERACTIVE_QUESTIONS) {
        appendClientLog('ERROR', 'interactive.batch_invalid', {
          streamId: payload.streamId,
          sessionId: payload.sessionId,
        });
        activeMessages.splice(index, 1);
        setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
        finalizeTerminalStream(payload);
        resetThinkingIndicator(payload.sessionId);
        queueSessionRender(payload.sessionId, {
          messages: true,
          header: true,
          composer: true,
          composerStatus: true,
          sessions: true,
        });
        resetLifecycleIfSettling(payload.sessionId);
        return { buffered: false, terminal: true };
      }
      activeMessages[index] = createNormalizedMessage(
        'assistant',
        buildInteractiveQuestionBatchVisibleText(batch),
        {
          id: `question_batch_${payload.streamId}`,
          kind: 'question_batch',
          interactive_batch: batch,
          agent_status: null,
          agent_status_steps: [],
          status: MESSAGE_STATUS.COMPLETE,
          finalizedAt: new Date().toISOString(),
          reasoning: { source: 'none', entries: [] },
          ...(durability ? { durability } : {}),
        }
      );
      setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
      finalizeTerminalStream(payload, { clearComposerNotice: false });
      resetThinkingIndicator(payload.sessionId);
      if (durability) {
        if (getQueuedSend(payload.sessionId) && isCurrentSession(payload.sessionId)) {
          restoreQueuedSendDraft(payload.sessionId);
        }
        clearInteractiveDraft(payload.sessionId);
        setSessionComposerNotice(payload.sessionId, 'Questions are unsaved. Retry save or discard them before answering.', {
          owner: 'interactive:unsaved', tone: 'warning',
        });
        queueSessionRender(payload.sessionId, {
          messages: true, header: true, composer: true, composerStatus: true, sessions: true,
        });
        appendClientLog('WARN', 'interactive.batch_unsaved', {
          streamId: payload.streamId, sessionId: payload.sessionId, batchId: batch.batch_id,
        });
        resetLifecycleIfSettling(payload.sessionId);
        return { buffered: false, terminal: true };
      }
      const previousSession = state.sessions.find((session) => session.id === payload.sessionId) || null;
      const previousSequenceState = getInteractiveSequenceState(previousSession);
      if (
        Number(batch.round_index || 0) > MAX_INTERACTIVE_ROUNDS
        || previousSequenceState === INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED
      ) {
        if (getQueuedSend(payload.sessionId) && isCurrentSession(payload.sessionId)) {
          restoreQueuedSendDraft(payload.sessionId);
        }
        clearInteractiveDraft(payload.sessionId);
        const postworkToken = beginTerminalPostworkGeneration(payload.sessionId);
        const continuationGuard = createTerminalContinuation(payload, callOptions, postworkToken);
        try {
          await runDeadlineStage(
            'persistInteractiveFallbackRequest', payload.sessionId, payload.streamId,
            ({ signal, guard }) => persistInteractiveFallbackRequest(
              payload.sessionId, batch.round_index, { signal, guard }
            ),
            REFRESH_DEADLINE_MS,
            { continuationGuard }
          );
          if (!continuationGuard.isCurrent()) return { buffered: false, terminal: true };
          await runDeadlineStage(
            'refreshSessionMetadata', payload.sessionId, payload.streamId,
            ({ signal, guard }) => refreshSessionMetadata(payload.sessionId, { signal, guard }),
            REFRESH_DEADLINE_MS,
            { continuationGuard }
          );
          if (!continuationGuard.isCurrent()) return { buffered: false, terminal: true };
        setSessionComposerNotice(payload.sessionId, getInteractiveComposerStatusNotice('guardrail'), {
          owner: 'interactive:guardrail',
          tone: 'warning',
        });
        queueSessionRender(payload.sessionId, {
          messages: true,
          header: true,
          composer: true,
          composerStatus: true,
          sessions: true,
        });
        appendClientLog('WARN', 'interactive.guardrail_batch_blocked', {
          streamId: payload.streamId,
          sessionId: payload.sessionId,
          batchId: batch.batch_id,
          roundIndex: batch.round_index,
          maxRounds: MAX_INTERACTIVE_ROUNDS,
        });
        if (previousSequenceState !== INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED) {
            await runDeadlineStage(
              'requestInteractiveGuardrailAnswer', payload.sessionId, payload.streamId,
              ({ signal, guard }) => requestInteractiveGuardrailAnswer(payload.sessionId, batch, { signal, guard }),
              MEMORY_CAPTURE_DEADLINE_MS,
              { continuationGuard }
            );
        }
        } finally {
          finishPostworkWindow(payload.sessionId, postworkToken);
        }
        resetLifecycleIfSettling(payload.sessionId);
        return { buffered: false, terminal: true };
      }
      ensureInteractiveDraft(batch, payload.sessionId);
      if (getQueuedSend(payload.sessionId) && isCurrentSession(payload.sessionId)) {
        restoreQueuedSendDraft(payload.sessionId);
      }
      clearSessionComposerNotice(payload.sessionId);
      patchSessionSummary(payload.sessionId, {
        pending_question_batch: batch,
        interactive_sequence_state: INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
        interactive_round_count: batch.round_index,
      });
      queueInteractiveComposerFocus({ type: 'default' });
      queueSessionRender(payload.sessionId, {
        messages: true,
        header: true,
        composer: true,
        composerStatus: true,
        sessions: true,
      });
      appendClientLog('INFO', 'interactive.batch_emitted', {
        streamId: payload.streamId,
        sessionId: payload.sessionId,
        batchId: batch.batch_id,
      });
      resetLifecycleIfSettling(payload.sessionId);
      return { buffered: false, terminal: true };
    }

    async function handleMessageUpdated(payload, callOptions = {}) {
      const messageId = normalizeId(payload.messageId);
      if (!messageId) {
        return { buffered: false, terminal: false };
      }
      const patch = payload.patch && typeof payload.patch === 'object' && !Array.isArray(payload.patch)
        ? payload.patch
        : {};
      // CTL-002 durability warning: the backend emits at most one per turn when
      // a persist was refused after visible completion. The toast fires BEFORE
      // any merge/defer branch — the user must learn the reply is not on disk
      // even when the local message copy cannot be located. The visible answer
      // itself stays untouched for copy/retry.
      if (patch.durability && typeof patch.durability === 'object'
        && patch.durability.state === 'unsaved') {
        appendClientLog('WARN', 'stream.turn_durability_unsaved', {
          sessionId: String(payload.sessionId || '').slice(0, 30),
          streamId: String(payload.streamId || '').slice(0, 30),
          messageId: messageId.slice(0, 60),
          reason: String(patch.durability.reason || '').slice(0, 40),
          scope: String(patch.durability.scope || '').slice(0, 20),
        });
        showToastMessage(
          "This reply couldn't be saved to your session history and will be lost when the app closes. Copy anything you need to keep.",
          {
            title: 'Reply not saved',
            tone: 'warning',
            sticky: true,
            source: TOAST_SOURCE.chatStream,
            dedupeKey: `${TOAST_SOURCE.chatStream}:durability:${String(payload.sessionId || payload.streamId || 'active')}`,
          }
        );
      }
      let activeMessages = [...getSessionMessages(payload.sessionId)];
      let messageIndex = activeMessages.findIndex((message) => normalizeId(message?.id) === messageId);
      if (messageIndex === -1 && isSessionStreaming(payload.sessionId) === true) {
        // Mid-turn, the store refresh below clobbers live state: hydrated
        // messages carry no results yet for still-running tools, so the
        // projector flips their pills to 'interrupted' until the next live
        // event (running -> interrupted -> running flicker). The store was
        // patched before this event was emitted and terminal hydration
        // re-reads it, so deferring the refresh is lossless.
        appendClientLog('DEBUG', 'stream.message_update_deferred_mid_turn', {
          sessionId: String(payload.sessionId || '').slice(0, 30),
          streamId: String(payload.streamId || '').slice(0, 30),
          messageId: messageId.slice(0, 60),
        });
        return { buffered: false, terminal: false };
      }
      if (messageIndex === -1 && jennyShell?.sessions?.getMessages) {
        const updateGuard = beginMessageUpdate(
          payload.sessionId, messageId, callOptions?.continuationGuard
        );
        try {
          const refresh = await runDeadlineStage(
            'refreshUpdatedMessage',
            payload.sessionId,
            payload.streamId,
            ({ signal }) => jennyShell.sessions.getMessages(payload.sessionId, { signal }),
            REFRESH_DEADLINE_MS,
            { continuationGuard: callOptions?.continuationGuard }
          );
          if (refresh.timedOut) {
            return { buffered: false, terminal: false, timedOut: true };
          }
          const refreshedSessionMessages = refresh.value;
          if (!updateGuard.isCurrent()) {
            return { buffered: false, terminal: false, stale: true };
          }
          const refreshedMessages = Array.isArray(refreshedSessionMessages?.data)
            ? refreshedSessionMessages.data
            : [];
          const fetchedMessage = refreshedMessages.find((message) => normalizeId(message?.id) === messageId);
          activeMessages = [...getSessionMessages(payload.sessionId)];
          messageIndex = activeMessages.findIndex((message) => normalizeId(message?.id) === messageId);
          if (messageIndex === -1 && fetchedMessage) {
            activeMessages.push({ ...fetchedMessage });
            messageIndex = activeMessages.length - 1;
          }
          const refreshedTurnState = readHydratedTurnEventState(refreshedSessionMessages);
          const currentTurnVersion = Number(
            state.turnEventsBySession?.get?.(normalizeId(payload.sessionId))?.turnEventLogVersion || 0
          );
          if (refreshedTurnState.turnEventLogVersion >= currentTurnVersion) {
            setSessionTurnEventState(payload.sessionId, refreshedTurnState);
          }
        } catch (error) {
          appendClientLog('WARN', 'stream.message_update_refresh_failed', {
            sessionId: String(payload.sessionId || '').slice(0, 30),
            messageId: messageId.slice(0, 60),
            message: String(error?.message || error).slice(0, 200),
          });
        } finally {
          updateGuard.finish();
        }
      }
      if (messageIndex === -1) {
        return { buffered: false, terminal: false };
      }
      activeMessages[messageIndex] = {
        ...activeMessages[messageIndex],
        ...patch,
        id: activeMessages[messageIndex].id,
        timestamp: activeMessages[messageIndex].timestamp,
      };
      setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
      queueSessionRender(payload.sessionId, {
        messages: true,
        sessions: true,
      });
      return { buffered: false, terminal: false };
    }

    async function handleComplete(payload, callOptions = {}) {
      completeThinkingIndicator(payload.sessionId);
      const durability = normalizeUnsavedDurability(payload.durability);
      const knownResumableStops = resumableStopKinds();
      const resumableStop = typeof payload.resumableStop === 'string' && Array.isArray(knownResumableStops)
        && knownResumableStops.includes(payload.resumableStop) ? payload.resumableStop : '';
      appendClientLog('DEBUG', 'stream.handle_complete', {
        streamId: payload.streamId,
        sessionId: String(payload.sessionId || '').slice(0, 30),
        contentLen: String(payload.content || '').length,
        activeView: state.ui?.activeView,
      });
      const index = ensurePendingStreamEntry(payload);
      const activeMessages = [...getSessionMessages(payload.sessionId)];
      if (index === -1) {
        // Reconcile the one admitted late terminal in place without postwork.
        const lateIndex = findLateReconcileBubbleIndex(activeMessages, normalizeId(payload.streamId));
        if (lateIndex === -1) {
          return { buffered: false, terminal: false };
        }
        clearStreamThinkingStatus(payload.streamId);
        const lateContent = String(payload.content || '')
          || String(activeMessages[lateIndex]?.content || '');
        activeMessages[lateIndex] = {
          ...activeMessages[lateIndex],
          content: lateContent,
          status: MESSAGE_STATUS.COMPLETE,
          stream_error: '',
          finalizedAt: new Date().toISOString(),
          ...(durability ? { durability } : {}),
          // Parity with `durability` on this same reconcile. Not independently
          // covered: the harness cannot reach this branch (a duplicate terminal is
          // absorbed upstream), and omitting the field while applying its neighbour
          // would be the anomaly.
          ...(resumableStop ? { resumable_stop: resumableStop } : {}),
        };
        setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
        // The admitted late terminal is still authoritative for request usage.
        // Reconcile the meter without reopening terminal postwork or producing
        // another persistence mutation.
        updateContextUsage(payload.sessionId, payload);
        queueSessionRender(payload.sessionId, {
          messages: true,
          composer: true,
          composerStatus: true,
        }, {
          immediate: true,
          renderCurrentMessagesWhenHidden: true,
        });
        settleRowModelTerminalState(
          payload.sessionId,
          payload.streamId,
          activeMessages,
          null,
          payload.canonicalTurnEvents
        );
        return { buffered: false, terminal: true };
      }
      clearStreamThinkingStatus(payload.streamId);
      const fullTerminalContent = String(payload.content || '');
      const existingSegmentContent = String(activeMessages[index]?.content || '');
      // Terminal content replaces the live aggregate; hydration owns splitting.
      const completeContent = fullTerminalContent || existingSegmentContent;
      const progressSnapshot = buildAgentProgressSnapshot(
        activeMessages[index], activeMessages, state?.features?.featureFlags?.agent_progress_durable === true
      );
      activeMessages[index] = {
        ...activeMessages[index],
        agent_status: null,
        agent_status_steps: [],
        ...(progressSnapshot ? { agent_progress_snapshot: progressSnapshot } : {}),
        content: completeContent,
        status: MESSAGE_STATUS.COMPLETE,
        stream_error: '',
        finalizedAt: new Date().toISOString(),
        ...(durability ? { durability } : {}),
        ...(resumableStop ? { resumable_stop: resumableStop } : {}),
      };
      setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
      updateContextUsage(payload.sessionId, payload);
      finalizeTerminalStream(payload);
      const pretextUtils = typeof globalThis !== 'undefined' ? globalThis.rendererPretextUtils : null;
      if (pretextUtils && typeof pretextUtils.evictStreamingEntry === 'function') {
        const completedMsgId = activeMessages[index] ? String(activeMessages[index].id || '') : '';
        if (completedMsgId) {
          pretextUtils.evictStreamingEntry(completedMsgId);
        }
      }
      dismissStreamErrors();
      clearInteractiveDraft(payload.sessionId);
      resetLifecycleIfSettling(payload.sessionId);
      queueSessionRender(payload.sessionId, {
        messages: true,
        composer: true,
        composerStatus: true,
      }, {
        immediate: true,
        renderCurrentMessagesWhenHidden: true,
      });
      // Keep the session send-busy until hydration and refresh postwork drains.
      // CTL-013: every post-await mutation revalidates this generation token.
      const postworkToken = beginTerminalPostworkGeneration(payload.sessionId);
      const continuationGuard = createTerminalContinuation(payload, callOptions, postworkToken);
      const terminalPostworkStartedAt = Date.now();
      try {
        const hydrationStartedAt = Date.now();
        const terminalHydration = await fetchHydratedTerminalMessages(payload.sessionId, activeMessages, {
          streamId: payload.streamId,
          postworkToken,
          continuationGuard,
        });
        noteStageDuration(payload.streamId, 'fetchHydratedTerminalMessages', Date.now() - hydrationStartedAt);
        if (!terminalHydration.aborted) {
          const terminalMessages = Array.isArray(terminalHydration?.messages) ? terminalHydration.messages : activeMessages;
          settleRowModelTerminalState(
            payload.sessionId,
            payload.streamId,
            terminalMessages,
            terminalHydration?.turnEventState || null,
            payload.canonicalTurnEvents
          );
          // Independent refreshes are deadline-bounded and failure-isolated.
          await Promise.allSettled([
            runDeadlineStage('refreshSessionMetadata', payload.sessionId, payload.streamId,
              ({ signal, guard }) => refreshSessionMetadata(payload.sessionId, { signal, guard }),
              REFRESH_DEADLINE_MS, { continuationGuard }),
            runDeadlineStage('refreshSnapshots', payload.sessionId, payload.streamId,
              ({ signal, guard }) => refreshSnapshots({ signal, guard, includeModels: false }),
              REFRESH_DEADLINE_MS, { continuationGuard }),
            runDeadlineStage('refreshObservability', payload.sessionId, payload.streamId,
              ({ signal, guard }) => refreshObservability({ silent: true, force: true, signal, guard }),
              REFRESH_DEADLINE_MS, { continuationGuard }),
          ]);
          if (continuationGuard.isCurrent()) {
            queueSessionRender(payload.sessionId, {
              messages: true,
              header: true,
              composer: true,
              composerStatus: true,
              sessions: true,
              settings: true,
            });
            await runDeadlineStage('maybeSuggestMemoryCapture', payload.sessionId, payload.streamId,
              ({ signal, guard }) => maybeSuggestMemoryCapture(payload, { signal, guard }),
              MEMORY_CAPTURE_DEADLINE_MS, { continuationGuard });
          }
          reportSlowPostwork(payload, Date.now() - terminalPostworkStartedAt);
          if (continuationGuard.isCurrent()) {
            focusChatInput(payload.sessionId);
          }
        }
      } catch (postworkError) {
        // Postwork failure cannot reopen the finalized turn or skip queue drain.
        appendClientLog('ERROR', 'stream.terminal_postwork_failed', {
          streamId: String(payload.streamId || '').slice(0, 30),
          sessionId: String(payload.sessionId || '').slice(0, 30),
          message: postworkError && postworkError.message ? postworkError.message : String(postworkError),
        });
      } finally {
        finishPostworkWindow(payload.sessionId, postworkToken);
      }
      const queuedSend = getQueuedSend(payload.sessionId);
      if (queuedSend) {
        const queuedDispatchResult = await dispatchQueuedSendForSession(payload.sessionId, {
          preserveCurrentSessionOnDispatch: !isCurrentSession(payload.sessionId),
          streamId: payload.streamId, // consumes a Stop hold scoped to this stream
        });
        if (!queuedDispatchResult && isCurrentSession(payload.sessionId)) {
          restoreQueuedSendDraft(payload.sessionId);
        }
      }
      resetLifecycleIfSettling(payload.sessionId);
      return { buffered: false, terminal: true };
    }

    async function handleError(payload, callOptions = {}) {
      resetThinkingIndicator(payload.sessionId);
      const durability = normalizeUnsavedDurability(payload.durability);
      appendClientLog('ERROR', 'stream.handle_error', {
        streamId: payload.streamId,
        sessionId: String(payload.sessionId || '').trim(),
        message: String(payload.message || '').slice(0, 200),
        activeView: state.ui?.activeView,
      });
      let index = ensurePendingStreamEntry(payload);
      let activeMessages = [...getSessionMessages(payload.sessionId)];
      const streamErrorMessage = String(payload.message || 'Unknown streaming error.');
      const explicitTerminalStatus = String(payload.terminal_status || payload.terminalStatus || '').trim();
      const statusClassification = String(payload.status || '').trim().toLowerCase();
      const rawTerminalStatus = explicitTerminalStatus
        || (statusClassification && statusClassification !== 'error' ? statusClassification : '');
      const terminalStatusValue = rawTerminalStatus
        ? resolveTerminalPresentation(rawTerminalStatus).status
        : '';
      const terminalSubcodeValue = String(payload.terminal_subcode || payload.terminalSubcode || '').trim();
      // User-intent terminals (stop/deny) settle via the calm timeline card;
      // suppress the danger toast for them — a red "Streaming Error" for the
      // user's own Stop click reads as a failure (GUI finding 2026-07-20).
      const isUserIntentTerminal = terminalStatusValue === 'cancelled' || terminalStatusValue === 'denied';
      const isLateTerminalReconcile = index === -1;
      if (index === -1) {
        // Reconcile a late error onto its surviving bubble; synthesize only
        // when the stream has no row, anchored before any later user turn.
        const normalizedStreamId = normalizeId(payload.streamId);
        const existingStreamIndex = findLateReconcileBubbleIndex(activeMessages, normalizedStreamId);
        if (existingStreamIndex !== -1) {
          index = existingStreamIndex;
        } else {
          const streamIdStr = String(payload.streamId || '').trim();
          const syntheticId = streamIdStr ? `error_${streamIdStr}` : `error_${Date.now()}`;
          const syntheticMessage = createNormalizedMessage('assistant', '', {
            id: syntheticId,
            status: MESSAGE_STATUS.ERROR,
            stream_error: streamErrorMessage,
            streamId: streamIdStr,
            session_id: String(payload.sessionId || payload.session_id || ''),
            finalizedAt: new Date().toISOString(),
            ...(payload.error_code ? { error_code: String(payload.error_code) } : {}),
            ...(typeof payload.retryable === 'boolean' ? { retryable: payload.retryable } : {}),
            ...(payload.category ? { category: String(payload.category) } : {}),
            ...(terminalStatusValue ? { terminal_status: terminalStatusValue } : {}),
            ...(terminalSubcodeValue ? { terminal_subcode: terminalSubcodeValue } : {}),
          });
          // Anchor the synthetic bubble to the end of its own turn: insert it
          // immediately before the first user message that follows the stream's
          // own user prompt (`user_<streamId>` or the last message that belongs
          // to this stream). With no such boundary it appends at the tail as
          // before, which is correct when nothing newer was added.
          const insertAt = findSyntheticErrorInsertIndex(activeMessages, normalizedStreamId);
          if (insertAt >= 0 && insertAt < activeMessages.length) {
            activeMessages = [
              ...activeMessages.slice(0, insertAt),
              syntheticMessage,
              ...activeMessages.slice(insertAt),
            ];
            index = insertAt;
          } else {
            activeMessages = [...activeMessages, syntheticMessage];
            index = activeMessages.length - 1;
          }
          setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
        }
      }
      const progressSnapshot = buildAgentProgressSnapshot(
        activeMessages[index], activeMessages, state?.features?.featureFlags?.agent_progress_durable === true
      );
      activeMessages[index] = {
        ...activeMessages[index],
        agent_status: null,
        agent_status_steps: [],
        ...(progressSnapshot ? { agent_progress_snapshot: progressSnapshot } : {}),
        status: MESSAGE_STATUS.ERROR,
        stream_error: streamErrorMessage,
        ...(payload.error_code ? { error_code: String(payload.error_code) } : {}),
        ...(typeof payload.retryable === 'boolean' ? { retryable: payload.retryable } : {}),
        ...(payload.category ? { category: String(payload.category) } : {}),
        ...(terminalStatusValue ? { terminal_status: terminalStatusValue } : {}),
        ...(terminalSubcodeValue ? { terminal_subcode: terminalSubcodeValue } : {}),
        session_id: String(payload.sessionId || payload.session_id || ''),
        finalizedAt: new Date().toISOString(),
        ...(durability ? { durability } : {}),
      };
      setSessionMessages(payload.sessionId, activeMessages, `session_${payload.sessionId}`);
      finalizeTerminalStream(payload, { restoreQueuedDraft: true });
      resetLifecycleIfSettling(payload.sessionId);
      queueSessionRender(payload.sessionId, {
        messages: true,
        composer: true,
        composerStatus: true,
      }, {
        immediate: true,
        renderCurrentMessagesWhenHidden: true,
      });
      if (isLateTerminalReconcile) {
        // One-shot late reconcile of an already-finalized stream: the bubble
        // is settled and rendered above; settle the row model from LOCAL
        // state and surface the toast, but do NOT open a postwork window —
        // a live turn on this session may be mid-postwork, and beginning a
        // new generation here would supersede (abort) that turn's settle and
        // refreshes, while the drain/restore tail below could yank a queued
        // send the live turn owns (code review 2026-07-10).
        settleRowModelTerminalState(
          payload.sessionId,
          payload.streamId,
          activeMessages,
          null,
          payload.canonicalTurnEvents
        );
        if (!isUserIntentTerminal) {
          showToastMessage(streamErrorMessage, {
            title: 'Streaming Error',
            tone: 'danger',
            sticky: true,
            source: TOAST_SOURCE.chatStream,
            dedupeKey: `${TOAST_SOURCE.chatStream}:${String(payload.sessionId || payload.streamId || 'active')}`,
          });
        }
        return { buffered: false, terminal: true };
      }
      // Same terminal post-work guard as handleComplete: keep the session busy
      // across the error-path hydration so a retry/follow-up send queues instead
      // of racing the hydration. finally guarantees the guard is released.
      // CTL-013: same generation-token capture as handleComplete.
      const postworkToken = beginTerminalPostworkGeneration(payload.sessionId);
      const continuationGuard = createTerminalContinuation(payload, callOptions, postworkToken);
      try {
        const terminalHydration = await fetchHydratedTerminalMessages(payload.sessionId, activeMessages, {
          streamId: payload.streamId,
          postworkToken,
          continuationGuard,
        });
        if (!terminalHydration.aborted) {
          const terminalMessages = Array.isArray(terminalHydration?.messages) ? terminalHydration.messages : activeMessages;
          settleRowModelTerminalState(
            payload.sessionId,
            payload.streamId,
            terminalMessages,
            terminalHydration?.turnEventState || null,
            payload.canonicalTurnEvents
          );
          if (continuationGuard.isCurrent() && !isUserIntentTerminal) {
            showToastMessage(streamErrorMessage, {
              title: 'Streaming Error',
              tone: 'danger',
              sticky: true,
              source: TOAST_SOURCE.chatStream,
              dedupeKey: `${TOAST_SOURCE.chatStream}:${String(payload.sessionId || payload.streamId || 'active')}`,
            });
          }
          // CTL-006: the error path's metadata refresh gets the same bounded
          // deadline as the complete path's group.
          await runDeadlineStage('refreshSessionMetadata', payload.sessionId, payload.streamId,
            ({ signal, guard }) => refreshSessionMetadata(payload.sessionId, { signal, guard }),
            REFRESH_DEADLINE_MS, { continuationGuard });
          if (continuationGuard.isCurrent()) {
            queueSessionRender(payload.sessionId, {
              messages: true,
              header: true,
              composer: true,
              composerStatus: true,
              sessions: true,
            });
            resetLifecycleIfSettling(payload.sessionId);
            focusChatInput(payload.sessionId);
          }
        }
      } catch (postworkError) {
        appendClientLog('ERROR', 'stream.terminal_postwork_failed', {
          streamId: String(payload.streamId || '').slice(0, 30),
          sessionId: String(payload.sessionId || '').slice(0, 30),
          message: postworkError && postworkError.message ? postworkError.message : String(postworkError),
        });
      } finally {
        finishPostworkWindow(payload.sessionId, postworkToken);
      }
      // Error and complete terminals share one FIFO drain contract. A failed
      // dispatch remains visible/retryable; only a current-session conflict
      // falls back to conflict-aware composer restore.
      const queuedSend = getQueuedSend(payload.sessionId);
      if (queuedSend) {
        const queuedDispatchResult = await dispatchQueuedSendForSession(payload.sessionId, {
          preserveCurrentSessionOnDispatch: !isCurrentSession(payload.sessionId),
          streamId: payload.streamId, // consumes a Stop hold scoped to this stream
        });
        if (!queuedDispatchResult && isCurrentSession(payload.sessionId)) {
          restoreQueuedSendDraft(payload.sessionId);
        }
      }
      return { buffered: false, terminal: true };
    }

    return {
      handleQuestionBatch,
      handleMessageUpdated,
      handleComplete,
      handleError,
    };
  }

  return { createStreamTerminalHandlers };
});
