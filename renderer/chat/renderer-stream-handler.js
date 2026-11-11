(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const streamDeps = globalThis.rendererStreamHandlerDeps
    || (typeof require === 'function' ? require('./renderer-stream-handler-deps') : null);
  if (!streamDeps || typeof streamDeps.resolveDependencyModule !== 'function') {
    throw new Error('renderer-stream-handler-deps must load before renderer/chat/renderer-stream-handler.js');
  }
  const wiringUtils = globalThis.rendererStreamHandlerWiring
    || (typeof require === 'function' ? require('./renderer-stream-handler-wiring') : null);
  if (!wiringUtils || typeof wiringUtils.createLiveTurnReducerWiring !== 'function') {
    throw new Error('renderer-stream-handler-wiring must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createLiveTurnReducerWiring, createStreamEphemeralSurfaces, createMultiStreamAdapters } = wiringUtils;
  const {
    normalizeString,
    normalizeId,
    FLUSH_RENDERABLE_BATCH_SIZE,
    isRenderableBufferedStreamEvent,
    waitForRenderFrame,
    normalizePhaseSummary,
    appendAgentStatusStep,
    createStreamPhaseStateUtils,
    createStreamDispatchRouter,
    createTerminalSettleHandlers,
    createStreamSessionHelpers,
    createDegradedStreamRecovery,
    createReasoningStreamMerger,
    createStreamReasoningPhaseStatusHandlers,
    createPendingMessageUtils,
    createStreamHandlerLifecycle,
    createStreamLiveEventHandlers,
    createStreamActivityRow,
    createWaitingRowWiring,
    createFollowWiring,
    createStreamHandlerRuntime,
    settleVisibleStreamAffordances,
    createStreamToolHandlers,
    createStreamTerminalHandlers,
    createPendingStreamCommitQueue,
    getTimelineVisibilityTracker,
    noopStreamHandler,
  } = streamDeps;

  function createStreamHandler(deps) {
    const { state } = deps;
    const thinkingIndicator = deps.thinkingIndicator || null;
    const timelineVirtualizer = deps.timelineVirtualizer || null;
    const multiStreamController = deps.multiStreamController || globalThis.rendererMultiStreamController || null;
    const {
      isStreamFinalized,
      isStreamTerminalSettled,
      markStreamTerminalSettled,
      getStreamTerminalCommitState,
      beginStreamTerminalCommit,
      finishStreamTerminalCommit,
      isStreamCurrentForSession,
      isSessionStreaming,
      clearTerminalPostwork,
      finishTerminalPostwork,
      beginTerminalPostworkGeneration,
      isTerminalPostworkGenerationCurrent,
      captureStreamGeneration,
      isStreamGenerationCurrent,
    } = createMultiStreamAdapters(multiStreamController);
    const {
      MESSAGE_STATUS,
      MAX_INTERACTIVE_QUESTIONS,
      MAX_INTERACTIVE_ROUNDS,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
      TOAST_SOURCE,
    } = deps.constants;
    const { chatInput, chatTimeline } = deps.dom;
    const {
      renderAll,
      renderHeader,
      renderMessages, renderSessionPane,
      syncTurnElapsedClock = () => {},
      scheduleMessageViewportSync = () => {},
      renderSessions,
      renderSettings,
      renderComposerState,
      renderComposerStatusNotice,
      renderWorkspaceChrome,
      getSessionMessages,
      setSessionMessages,
      setSessionTurnEventState = () => {},
      createNormalizedMessage,
      setComposerStatusNotice,
      clearComposerStatusNotice,
      normalizePendingQuestionBatch,
      getInteractiveSequenceState,
      clearInteractiveDraft,
      ensureInteractiveDraft,
      patchSessionSummary,
      buildInteractiveQuestionBatchVisibleText,
      refreshSessionSummaries,
      // Test-only direct override (CTL-006): production wiring always relies on
      // the sessionHelpers-derived refreshSessionMetadata below, which wraps
      // refreshSessionSummaries + a chrome re-render. A caller that needs to
      // stub the exact terminal-handler dependency name (e.g. to simulate a
      // hung metadata refresh under a deadline) may pass this directly.
      refreshSessionMetadata: refreshSessionMetadataOverride,
      refreshSnapshots,
      refreshObservability = async () => {},
      showToastMessage, dismissToast,
      dismissStreamErrors,
      appendClientLog,
      getInteractiveComposerStatusNotice,
      persistInteractiveFallbackRequest,
      requestInteractiveGuardrailAnswer,
      queueInteractiveComposerFocus,
      mergeMessageReasoning,
      getQueuedSend,
      restoreQueuedSendDraft,
      dispatchQueuedSendForSession,
      updateContextUsage = () => {},
      handlePresenceStreamEvent = () => {},
      handleWorkspaceActivityStreamEvent = () => {},
      setChatSendLifecycle = () => 'idle',
      clearChatSendLifecycle = () => false,
      getChatSendLifecycle = () => 'idle',
      getChatTimelineRowModelEnabled = () => false,
      recordChatTimelineRolloutSignal = () => ({ logged: false, count: 0 }),
      noteTimelineMessageCreated = () => false,
      invalidateProjectionStateForSession = () => 0,
      // Background Effects v3 S5 W1b: surface-activity impulse callbacks,
      // forwarded to the live-events / tool / runtime sub-factories below.
      publishFirstTokenImpulse = () => {},
      publishToolStartImpulse = () => {},
      publishCompleteImpulse = () => {},
    } = deps.callbacks;
    const MAX_BUFFER_PER_STREAM = 500;
    const BUFFER_EXPIRY_MS = 60000;
    const MAX_REASONING_MERGE_STREAMS = 128;
    const approvalToastSessionIds = new Set();
    let startupAuditFirstStreamEventMarked = false;

    function markStartupAudit(name, details = {}) {
      try {
        globalThis.__jennyStartupAudit?.mark?.(name, details);
      } catch (_error) {
        // Best effort only.
      }
    }
    const {
      streamSegmentState,
      streamPhaseState,
      streamRehydrateUtils,
      getLiveStateStore,
      isRowModelEnabled,
      clearSessionLiveTurnState,
      buildAssistantShellMessageId,
      applyLiveTurnPayload,
      reconcileLiveTurnWithHydratedRows,
    } = createLiveTurnReducerWiring({
      state,
      appendClientLog,
      getSessionMessages,
      getChatTimelineRowModelEnabled,
      recordChatTimelineRolloutSignal,
    });
    function isCurrentSession(sessionId) { return normalizeId(sessionId) === normalizeId(state.currentSessionId); }
    // Widened render gate: the chat subtree is live when EITHER the Chat view or
    // the open Workspace dock is showing it (ide_chat_dock), and split view W0-3
    // widens the other axis -- which session, in which pane. Both are passed by
    // reference into the 6 DI submodules (session-helpers, runtime, live-events,
    // terminal, reasoning-phase-status, tool-patch-utils), so widening here widens
    // all six; each falls back to exactly the pre-W0-3 expression, script absent.
    function isChatSurfaceLive(current) {
      return (globalThis.rendererChatSurfaceLiveUtils || {}).isChatSurfaceLive?.(current)
        ?? (current?.ui?.activeView === 'chat');
    }
    function isVisibleChatSession(sessionId) { return (globalThis.rendererPaneVisibilityUtils || {}).isSessionVisibleInAnyPane?.(state, sessionId) ?? (isCurrentSession(sessionId) && isChatSurfaceLive(state)); }
    // W1-4c: direct DOM patches (tool rows, live output) reach pane 0's timeline only; another pane's rows take the routed re-render.
    const isPaneZeroSession = (id) => (globalThis.rendererPaneVisibilityUtils || {}).isSessionVisibleInPane?.(state, id, 0) ?? isVisibleChatSession(id);
    const timelineVisibilityTracker = getTimelineVisibilityTracker(state, { appendClientLog });
    const sessionHelpers = createStreamSessionHelpers({
      state,
      normalizeId,
      appendClientLog,
      multiStreamController,
      maxBufferPerStream: MAX_BUFFER_PER_STREAM,
      bufferExpiryMs: BUFFER_EXPIRY_MS,
      timelineVisibilityTracker,
      isCurrentSession,
      isVisibleChatSession,
      refreshSessionSummaries,
      // queueRender is created by the runtime factory below — defer resolution.
      queueRender: (...args) => queueRender(...args),
      setComposerStatusNotice,
      clearComposerStatusNotice,
      showToastMessage, dismissToast,
      toastSource: TOAST_SOURCE,
      approvalToastSessionIds,
    });
    const {
      markHiddenRenderableEvent,
      markHiddenRenderableRender,
      resolvePayloadSessionId,
      getPreflightForPayload,
      notePreflightEvent,
      shouldBufferStreamEvent,
      bufferStreamEvent,
      consumeBufferedStreamDegradation,
      evictStaleBufferedEvents,
      clearBufferedStreamEvents,
      refreshSessionMetadata,
      setSessionComposerNotice,
      clearSessionComposerNotice,
      showApprovalToast, dismissApprovalToast,
    } = sessionHelpers;

    const runtime = createStreamHandlerRuntime({
      state,
      thinkingIndicator,
      multiStreamController,
      appendClientLog,
      renderAll,
      renderHeader,
      renderMessages, renderSessionPane,
      renderSessions,
      renderSettings,
      renderComposerState,
      renderComposerStatusNotice,
      renderWorkspaceChrome,
      afterRender: () => {
        evictStaleBufferedEvents();
        syncTurnElapsedClock();
      },
      getQueuedSend,
      restoreQueuedSendDraft,
      clearSessionComposerNotice,
      getChatSendLifecycle,
      setChatSendLifecycle,
      clearChatSendLifecycle,
      isCurrentSession,
      isVisibleChatSession,
      markHiddenRenderableEvent: markHiddenRenderableRender, dismissApprovalToast,
      publishCompleteImpulse,
    });
    const syncThinkingIndicatorMode = runtime.syncThinkingIndicatorMode || function noopSyncThinkingIndicatorMode() {};
    const completeThinkingIndicator = runtime.completeThinkingIndicator || function noopCompleteThinkingIndicator() {};
    const resetThinkingIndicator = runtime.resetThinkingIndicator || function noopResetThinkingIndicator() {};
    const queueRender = runtime.queueRender || function noopQueueRender() {};
    const queueSessionRender = runtime.queueSessionRender || function noopQueueSessionRender() {};
    const handleBufferDegraded = createDegradedStreamRecovery({
      getPersistedSession: (sessionId) => globalThis.window?.jennyShell?.sessions?.getMessages?.(sessionId),
      setSessionMessages,
      setSessionTurnEventState,
      setSessionComposerNotice,
      queueSessionRender,
      appendClientLog,
    });
    const setStreamThinkingStatus = runtime.setStreamThinkingStatus || function noopSetStreamThinkingStatus() {};
    const clearStreamThinkingStatus = runtime.clearStreamThinkingStatus || function noopClearStreamThinkingStatus() {};
    const releaseApprovalToastSessions = runtime.releaseApprovalToastSessions
      ? (sessionIds) => runtime.releaseApprovalToastSessions(approvalToastSessionIds, sessionIds)
      : function noopReleaseApprovalToastSessions() {};
    const {
      toolLiveTail,
      imageRenderProgress,
      toolTestProgress,
      handleToolTestProgress,
      handleToolProgress,
      clearTerminalStreamState,
      liveToolPatchController,
    } = createStreamEphemeralSurfaces({
      state,
      chatTimeline,
      timelineVirtualizer,
      announcer: deps.announcer,
      isPaneZeroSession,
      appendClientLog,
      queueSessionRender,
      runtime,
      approvalToastSessionIds,
      streamSegmentState,
      streamPhaseState,
    });
    const finalizeTerminalStream = runtime.finalizeTerminalStream
      ? (payload, options) => runtime.finalizeTerminalStream(
        approvalToastSessionIds,
        streamSegmentState,
        streamPhaseState,
        payload,
        options
      )
      : function noopFinalizeTerminalStream() {};
    const resetLifecycleIfSettling = runtime.resetLifecycleIfSettling || function noopResetLifecycleIfSettling() {};

    const phaseStateUtils = createStreamPhaseStateUtils({
      streamPhaseState,
      state,
      normalizeId,
      normalizeString,
      normalizePhaseSummary,
      getSessionMessages,
      setSessionMessages,
    });
    const {
      getReasoningPhasesForStream,
      settleUnfinishedReasoningPhases,
      updateStreamPhaseState,
      syncPendingMessagePhaseState,
    } = phaseStateUtils;
    const pendingMessageUtils = createPendingMessageUtils({
      state,
      normalizeId,
      normalizeString,
      streamSegmentState,
      buildAssistantShellMessageId,
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
    });
    const {
      optimisticAppend,
      ensurePendingStreamEntry,
      ensureRenderableReasoningStreamEntry,
      updatePendingMessage,
      pendingStreamCommitQueue,
      flushPendingStreamCommit,
      flushPendingStreamCommitsForSession,
    } = pendingMessageUtils;
    const reasoningStreamMerger = createReasoningStreamMerger({
      normalizeId,
      mergeMessageReasoning,
      appendClientLog,
      flushPendingStreamCommit,
      bufferExpiryMs: BUFFER_EXPIRY_MS,
      maxStreams: MAX_REASONING_MERGE_STREAMS,
    });
    const reasoningPhaseStatusHandlers = createStreamReasoningPhaseStatusHandlers({
      state,
      normalizeId,
      normalizeString,
      streamSegmentState,
      setStreamThinkingStatus,
      syncThinkingIndicatorMode,
      ensureRenderableReasoningStreamEntry,
      markHiddenRenderableEvent,
      isVisibleChatSession,
      queueRender,
      appendClientLog,
      applyLiveTurnPayload,
      buildAssistantShellMessageId,
      updateStreamPhaseState,
      syncPendingMessagePhaseState,
    });
    const { handleThinkingStatus, handlePhaseStarted, handlePhaseCompleted } = reasoningPhaseStatusHandlers;

    // Phantom activity row: covers the silent window while the model
    // generates tool-call arguments (no provider events exist to render).
    // Ephemeral DOM only — never enters the row model or persistence.
    const waitingRowWiring = createWaitingRowWiring({ state, queueSessionRender });
    const followWiring = createFollowWiring({ state, setActiveView: deps.callbacks.setActiveView, getChatTimeline: () => chatTimeline });
    const streamActivityRow = createStreamActivityRow({
      ...waitingRowWiring.rowOptions,
      getChatTimeline: () => chatTimeline,
      getSessionTimeline: (sessionId) => globalThis.rendererAppPaneComposition?.getPaneComposition?.()
        ?.getSessionPaneTarget?.(sessionId)?.chatTimeline || null,
      // A dismissed row leaves with the render that replaces it (no tail snap).
      retireOnTimelineWrite: true,
      onRowMounted: (sessionId, node) => scheduleMessageViewportSync(getSessionMessages(sessionId) || [], {
        patchedRoot: node?.closest?.('.chat-entry') || node,
      }),
      isStreamLive: (sessionId, streamId) => (
        multiStreamController?.isSessionStreaming?.(sessionId) === true
        && multiStreamController?.isStreamFinalized?.(streamId) !== true
      ),
      isSessionVisible: (sessionId) => (globalThis.rendererPaneVisibilityUtils || {}).isSessionVisibleInPane?.(state, sessionId, 0) ?? isVisibleChatSession(sessionId),
      hasBlockingToolState: (sessionId, streamId) => {
        const streamTools = state.toolCallsByStream.get(streamId) || [];
        const hasBlockingTool = streamTools.some((tool) => {
          const status = String(tool?.status || '').trim();
          return status === 'running'
            || status === 'pending_approval'
            || status === 'awaiting_approval'
            || status === 'pending_user_input'
            || status === 'approved';
        });
        if (hasBlockingTool) return true;
        for (const approval of state.pendingToolApprovals.values()) {
          if (normalizeId(approval?.sessionId) === normalizeId(sessionId)) {
            return true;
          }
        }
        return false;
      },
    });
    state.streamWaits = streamActivityRow; // read by the Pause control and the queue strip
    const toolHandlers = createStreamToolHandlers({
      state,
      appendClientLog,
      syncThinkingIndicatorMode,
      streamSegmentState,
      getSessionMessages,
      setSessionMessages,
      createNormalizedMessage,
      releaseApprovalToastSessions,
      clearSessionComposerNotice,
      patchSessionSummary,
      queueSessionRender,
      scheduleLiveToolPatch: (payload, details) => liveToolPatchController.queueToolPatch(payload, details),
      showApprovalToast,
      isCurrentSession,
      isRowModelEnabled,
      applyLiveTurnPayload,
      noteTimelineMessageCreated,
      invalidateProjectionStateForSession,
      MESSAGE_STATUS,
      publishToolStartImpulse,
      applyToolLiveOutputChunk: (payload) => toolLiveTail.appendChunk(payload),
      isToolLiveOutputSession: isPaneZeroSession,
      settleToolLiveOutput: (identity) => {
        toolLiveTail.settle(identity);
        imageRenderProgress.settle(identity);
        toolTestProgress.settle(identity);
      },
    });
    const handleToolUse = toolHandlers.handleToolUse || noopStreamHandler;
    const handleToolOutputChunk = toolHandlers.handleToolOutputChunk || noopStreamHandler;
    const handleApprovalNeeded = toolHandlers.handleApprovalNeeded || noopStreamHandler;
    const handleUserQuestionsRequested = toolHandlers.handleUserQuestionsRequested || noopStreamHandler;
    const handleToolResult = toolHandlers.handleToolResult || noopStreamHandler;
    const terminalHandlers = createStreamTerminalHandlers({
      state,
      chatInput,
      MAX_INTERACTIVE_QUESTIONS,
      MAX_INTERACTIVE_ROUNDS,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
      MESSAGE_STATUS,
      TOAST_SOURCE,
      appendClientLog,
      normalizePendingQuestionBatch,
      getInteractiveSequenceState,
      clearInteractiveDraft,
      ensureInteractiveDraft,
      patchSessionSummary,
      buildInteractiveQuestionBatchVisibleText,
      refreshSessionMetadata: typeof refreshSessionMetadataOverride === 'function'
        ? refreshSessionMetadataOverride
        : refreshSessionMetadata,
      refreshSnapshots,
      refreshObservability,
      dismissStreamErrors,
      getInteractiveComposerStatusNotice,
      persistInteractiveFallbackRequest,
      requestInteractiveGuardrailAnswer,
      queueInteractiveComposerFocus,
      getQueuedSend,
      restoreQueuedSendDraft,
      dispatchQueuedSendForSession,
      updateContextUsage,
      completeThinkingIndicator,
      resetThinkingIndicator,
      clearStreamThinkingStatus,
      finalizeTerminalStream,
      resetLifecycleIfSettling,
      ensurePendingStreamEntry,
      getSessionMessages,
      setSessionMessages,
      setSessionTurnEventState,
      createNormalizedMessage,
      setSessionComposerNotice,
      clearSessionComposerNotice,
      queueSessionRender,
      isCurrentSession,
      isVisibleChatSession,
      normalizeId,
      showToastMessage,
      isRowModelEnabled,
      reconcileLiveTurnWithHydratedRows, clearSessionLiveTurnState,
      isSessionStreaming,
      clearTerminalPostwork,
      finishTerminalPostwork,
      beginTerminalPostworkGeneration,
      isTerminalPostworkGenerationCurrent,
      captureStreamGeneration,
      isStreamGenerationCurrent,
    });
    const handleQuestionBatch = terminalHandlers.handleQuestionBatch || noopStreamHandler;
    const handleMessageUpdated = terminalHandlers.handleMessageUpdated || noopStreamHandler;
    const rawHandleComplete = terminalHandlers.handleComplete || noopStreamHandler;
    const rawHandleError = terminalHandlers.handleError || noopStreamHandler;
    // Terminal settle wrappers extracted to renderer-stream-handler-terminal-settle.js
    // (file-size ceiling); behavior is unchanged.
    const { handleComplete, handleError } = createTerminalSettleHandlers({
      getChatTimeline: () => chatTimeline,
      state,
      normalizeId,
      isCurrentSession,
      appendClientLog,
      settleVisibleStreamAffordances,
      settleUnfinishedReasoningPhases,
      applyLiveTurnPayload,
      flushPendingStreamCommit,
      clearTerminalStreamState,
      dropReasoningStream: (streamId) => reasoningStreamMerger.drop(streamId),
      rawHandleComplete,
      rawHandleError,
      dismissToast,
      chatStreamToastSource: TOAST_SOURCE.chatStream,
      onTerminal: (event) => {
        // The away digest goes first: it only arms a coalesced read and never throws.
        state.awayDigestReader?.onRunSettled?.(event);
        state.desktopNotificationsController?.onTerminal?.(event);
        state.imagePromptController?.onTerminal?.(event);
      },
    });

    const liveEventHandlers = createStreamLiveEventHandlers({
      state,
      normalizeId,
      normalizeString,
      appendClientLog,
      MESSAGE_STATUS,
      streamSegmentState,
      streamPhaseState,
      reasoningStreamMerger,
      multiStreamController,
      pendingStreamCommitQueue,
      appendAgentStatusStep,
      notePreflightEvent,
      clearStreamThinkingStatus,
      flushPendingStreamCommit,
      applyLiveTurnPayload,
      buildAssistantShellMessageId,
      setChatSendLifecycle,
      syncThinkingIndicatorMode,
      queueSessionRender,
      queueRender,
      ensurePendingStreamEntry,
      getSessionMessages,
      setSessionMessages,
      updatePendingMessage,
      markHiddenRenderableEvent,
      isVisibleChatSession,
      isCurrentSession,
      isRowModelEnabled,
      getReasoningPhasesForStream,
      completeThinkingIndicator,
      updateContextUsage,
      publishFirstTokenImpulse,
    });
    const {
      handleStarted,
      handleAgentStatus,
      handleStreamReset,
      handleContextCompacted,
      handleContextUsage,
      handleDelta,
    } = liveEventHandlers;

    const dispatchRouter = createStreamDispatchRouter({
      state,
      normalizeId,
      normalizeString,
      appendClientLog,
      markStartupAudit,
      resolvePayloadSessionId,
      shouldBufferStreamEvent,
      bufferStreamEvent,
      consumeBufferedStreamDegradation,
      notePreflightEvent,
      flushPendingStreamCommit,
      handlePresenceStreamEvent,
      handleWorkspaceActivityStreamEvent,
      handlers: {
        handleBufferDegraded,
        handleStarted,
        handleThinkingStatus,
        handlePhaseStarted,
        handlePhaseCompleted,
        handleAgentStatus,
        handleToolUse,
        handleApprovalNeeded,
        handleUserQuestionsRequested,
        handleToolOutputChunk,
        handleToolProgress,
        handleToolTestProgress,
        handleToolResult,
        handleStreamReset,
        handleContextCompacted,
        handleContextUsage,
        handleRuntimeWaiting: waitingRowWiring.handleRuntimeWaiting,
        handleDelta,
        handleQuestionBatch,
        handleMessageUpdated,
        handleComplete,
        handleError,
      },
      isRenderableBufferedStreamEvent,
      waitForRenderFrame,
      flushRenderableBatchSize: FLUSH_RENDERABLE_BATCH_SIZE,
      onStartupFirstEvent() {
        if (startupAuditFirstStreamEventMarked) {
          return false;
        }
        startupAuditFirstStreamEventMarked = true;
        return true;
      },
      isStreamFinalized,
      isStreamTerminalSettled,
      markStreamTerminalSettled,
      getStreamTerminalCommitState,
      beginStreamTerminalCommit,
      finishStreamTerminalCommit,
      isStreamCurrentForSession,
    });
    const {
      handleStreamPayload: dispatchStreamPayload,
      flushBufferedStreamEvents,
      dropBufferedStreamEvents,
    } = dispatchRouter;
    // Every dispatched event doubles as the activity row's heartbeat: it
    // resets the silence clock and dismisses a visible phantom row before the
    // authoritative handler renders.
    function handleStreamPayload(payload, callOptions = {}) {
      try {
        streamActivityRow.noteStreamEvent(payload);
      } catch (_error) { /* affordance only — never blocks dispatch */ }
      followWiring.noteStreamEvent(payload); // after the row: the tail hangs under it; never throws
      return dispatchStreamPayload(payload, callOptions);
    }

    const lifecycle = createStreamHandlerLifecycle({
      state,
      normalizeId,
      appendClientLog,
      handleStreamPayload,
      pendingStreamCommitQueue,
      runtime,
      approvalToastSessionIds,
      reasoningStreamMerger,
      streamRehydrateUtils,
      isRowModelEnabled,
      getLiveStateStore,
      clearBufferedStreamEvents,
    });
    const {
      registerStreamHandler,
      dispose: disposeLifecycle,
      rehydrateSessionFromPersistedTurnEvents,
    } = lifecycle;

    return {
      registerStreamHandler,
      optimisticAppend,
      ensurePendingStreamEntry,
      flushBufferedStreamEvents,
      flushPendingStreamCommitsForSession,
      dropBufferedStreamEvents,
      rehydrateSessionFromPersistedTurnEvents,
      dispose() {
        if (state.streamWaits === streamActivityRow) state.streamWaits = null;
        streamActivityRow.dispose?.();
        followWiring.dispose();
        liveToolPatchController.dispose?.();
        toolLiveTail.dispose();
        imageRenderProgress.dispose();
        disposeLifecycle();
      },
    };
  }

  return { createStreamHandler, appendAgentStatusStep };
});
