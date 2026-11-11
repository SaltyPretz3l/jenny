(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerWiring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const streamDeps = globalThis.rendererStreamHandlerDeps
    || (typeof require === 'function' ? require('./renderer-stream-handler-deps') : null);
  if (!streamDeps || typeof streamDeps.resolveDependencyModule !== 'function') {
    throw new Error('renderer-stream-handler-deps must load before renderer/chat/renderer-stream-handler-wiring.js');
  }
  const {
    resolveDependencyModule,
    normalizeId,
    normalizeString,
    createRowModelStateUtils,
    createReducerWiring,
    createToolLiveTail,
    createImageRenderProgress,
    createToolTestProgress,
    createLiveToolPatchController,
    resolveSharedLiveAnnouncer,
  } = streamDeps;

  // Live turn reducer: the per-stream segment/phase maps, the row-model state helpers and the reducer
  // wiring that projects stream payloads into live rows.
  function createLiveTurnReducerWiring({
    state,
    appendClientLog,
    getSessionMessages,
    getChatTimelineRowModelEnabled,
    recordChatTimelineRolloutSignal,
  }) {
    const turnReducerUtils = resolveDependencyModule('rendererTurnReducer', './renderer-turn-reducer');
    const turnTreeProjectorUtils = resolveDependencyModule('rendererTurnTreeProjector', './renderer-turn-tree-projector');
    const turnRowProjectorUtils = resolveDependencyModule('rendererTurnRowProjector', './renderer-turn-row-projector');
    const streamRehydrateUtils = resolveDependencyModule('rendererStreamRehydrate', './renderer-stream-rehydrate');
    const createTurnReducerState = turnReducerUtils?.createTurnReducerState
      || function missingCreateTurnReducerState() { return { active_turn_id: '', turns_by_id: Object.create(null), reconciled_rows_by_turn_id: Object.create(null) }; };
    const buildTurnEventFromStreamPayload = turnReducerUtils?.buildTurnEventFromStreamPayload
      || function missingBuildTurnEventFromStreamPayload() { return null; };
    const applyTurnStreamEvent = turnReducerUtils?.applyTurnStreamEvent
      || function missingApplyTurnStreamEvent(currentState) { return currentState; };
    const reconcileTurnRows = turnReducerUtils?.reconcileTurnRows
      || function missingReconcileTurnRows(_provisionalRows, hydratedRows) { return { finalRows: Array.isArray(hydratedRows) ? hydratedRows.slice() : [], staleRows: [] }; };
    // Per-stream text segmentation state; aggregateOffset = cursor already projected into live row-model
    // text, segmentBaseOffset = where the current segment began (W3.6 mixed text+tool bubble slice base).
    const streamSegmentState = new Map();
    // Per-stream semantic phase state retained only for live renderer grouping.
    const streamPhaseState = new Map();
    const rowModelStateUtils = createRowModelStateUtils({
      state,
      normalizeId,
      getChatTimelineRowModelEnabled,
      createTurnReducerState,
    });
    const {
      getLiveStateStore,
      buildRolloutRowKey,
      isRowModelEnabled,
      isDeterministicRowIdEnabled,
      getSessionLiveTurnState,
      clearSessionLiveTurnState,
      pruneEmptySessionLiveState,
    } = rowModelStateUtils;
    const reducerWiring = createReducerWiring({
      streamSegmentState,
      normalizeId,
      normalizeString,
      getSessionMessages,
      isRowModelEnabled,
      getSessionLiveTurnState,
      pruneEmptySessionLiveState,
      buildRolloutRowKey,
      buildTurnEventFromStreamPayload,
      applyTurnStreamEvent,
      reconcileTurnRows,
      turnTreeProjectorUtils,
      turnRowProjectorUtils,
      streamRehydrateUtils,
      isCanonicalRendererProjectionEnabled(sessionId) {
        return state?.features?.featureFlags?.canonical_renderer_projection === true
          && isRowModelEnabled(sessionId);
      },
      isDeterministicRowIdEnabled,
      recordChatTimelineRolloutSignal,
      // Render-path telemetry (Track A): local-only diagnostics for the
      // streaming-flicker investigation. The affirmative "clean reconcile"
      // signal fires for row-model sessions.
      isRenderTelemetryEnabled(sessionId) {
        return isRowModelEnabled(sessionId);
      },
      appendClientLog,
    });
    const {
      buildAssistantShellMessageId,
      applyLiveTurnPayload,
      reconcileLiveTurnWithHydratedRows,
    } = reducerWiring;
    return {
      streamSegmentState,
      streamPhaseState,
      streamRehydrateUtils,
      getLiveStateStore,
      isRowModelEnabled,
      clearSessionLiveTurnState,
      buildAssistantShellMessageId,
      applyLiveTurnPayload,
      reconcileLiveTurnWithHydratedRows,
    };
  }

  // Ephemeral DOM surfaces of a running stream (tool live tail, image render progress, test-run
  // progress, live tool-row patches); none of them enters the row model or persistence.
  function createStreamEphemeralSurfaces({
    state,
    chatTimeline,
    timelineVirtualizer,
    announcer,
    isPaneZeroSession,
    appendClientLog,
    queueSessionRender,
    runtime,
    approvalToastSessionIds,
    streamSegmentState,
    streamPhaseState,
  }) {
    // W2-1: live output tail for running tool rows (ephemeral DOM patches).
    const toolLiveTail = createToolLiveTail({
      getChatTimeline: () => chatTimeline,
      isSessionVisible: isPaneZeroSession,
    });
    // Live image render progress (ephemeral DOM patches of the pending figure).
    // Like the live tail, only the visible session's figure is patched.
    const imageRenderProgress = createImageRenderProgress({ getChatTimeline: () => chatTimeline });
    // Live test-run progress (row 96): bar, counts, grid and failures under a running test command.
    const toolTestProgress = createToolTestProgress({ getChatTimeline: () => chatTimeline });
    const handleToolTestProgress = async (payload) => {
      if (!isPaneZeroSession(payload?.sessionId)) return { buffered: false, terminal: false };
      try { toolTestProgress.apply(payload); } catch (_error) { /* ephemeral UI only */ }
      return { buffered: false, terminal: false };
    };
    const handleToolProgress = async (payload) => {
      if (!isPaneZeroSession(payload?.sessionId)) return { buffered: false, terminal: false };
      try { imageRenderProgress.apply(payload); } catch (_error) { /* ephemeral UI only */ }
      return { buffered: false, terminal: false };
    };
    const clearTerminalStreamState = (streamId) => {
      toolLiveTail.settleStream(streamId);
      imageRenderProgress.settleStream(streamId);
      toolTestProgress.settleStream(streamId);
      runtime.clearTerminalStreamState?.(approvalToastSessionIds, streamSegmentState, streamPhaseState, streamId);
    };
    // UIUX-029: tool-activity terminal statuses route through the one shared
    // live-announcer channel. Injectable for tests (pass announcer: null to
    // disable); otherwise built once from the persistent #srAnnounce* regions
    // and stashed on the window so future consumers reuse the same throttled
    // channel instead of growing another bespoke live region.
    const liveAnnouncer = announcer !== undefined
      ? announcer
      : resolveSharedLiveAnnouncer();
    const liveToolPatchController = createLiveToolPatchController({
      windowRef: globalThis.window || globalThis,
      announcer: liveAnnouncer,
      chatTimeline,
      timelineVirtualizer,
      appendClientLog,
      isVisibleChatSession: isPaneZeroSession,
      shouldBlockLivePatch() {
        return state.ui?.editCommitting === true || state.ui?.bulkTruncateCommitting === true;
      },
      onFallback(sessionId) {
        // A tool row repaint: no sessions render (see queueToolSessionRender).
        queueSessionRender(sessionId, {
          messages: true,
          composerStatus: true,
          composer: true,
          header: true,
        });
      },
    });
    return {
      toolLiveTail,
      imageRenderProgress,
      toolTestProgress,
      handleToolTestProgress,
      handleToolProgress,
      clearTerminalStreamState,
      liveToolPatchController,
    };
  }

  // The multi-stream controller's terminal-absorbing, postwork and generation gates as the plain
  // functions the dispatch router, pending-message queue and terminal handlers take. Each reads the
  // controller on every call, so a controller that predates an API degrades exactly as before.
  function createMultiStreamAdapters(multiStreamController) {
    return {
      // Terminal-absorbing gate (CTL-003): the multi-stream controller's
      // bounded finalized registry is the single source of truth for "this
      // stream is done"; dispatch consults it before any handler runs. The
      // settled registry additionally distinguishes "terminal handler ran"
      // from "finalized by a stop/preempt clearStream", so the one genuine
      // late terminal for a preempted stream can still reconcile its partial
      // bubble (preempt-retry ordering contract).
      isStreamFinalized: (streamId) => multiStreamController?.isStreamFinalized?.(streamId) === true,
      isStreamTerminalSettled: (streamId) => multiStreamController?.isStreamTerminalSettled?.(streamId) === true,
      markStreamTerminalSettled: (streamId) => multiStreamController?.markStreamTerminalSettled?.(streamId),
      getStreamTerminalCommitState: (streamId, sessionId) => multiStreamController?.getStreamTerminalCommitState?.(streamId, sessionId) || '',
      beginStreamTerminalCommit: (streamId, sessionId) => multiStreamController?.beginStreamTerminalCommit?.(streamId, sessionId),
      finishStreamTerminalCommit: (streamId, committed, sessionId) => multiStreamController?.finishStreamTerminalCommit?.(streamId, committed, sessionId),
      isStreamCurrentForSession: (sessionId, streamId) => multiStreamController?.isStreamCurrentForSession?.(sessionId, streamId) !== false,
      isSessionStreaming: (sessionId) => multiStreamController?.isSessionStreaming?.(sessionId) === true,
      clearTerminalPostwork: (sessionId) => multiStreamController?.clearTerminalPostwork?.(sessionId),
      // Audit A5: compare-and-clear close of the postwork window; falls back
      // to the unconditional clear when the controller predates the token API.
      finishTerminalPostwork: (sessionId, token) => (
        typeof multiStreamController?.finishTerminalPostwork === 'function'
          ? multiStreamController.finishTerminalPostwork(sessionId, token)
          : multiStreamController?.clearTerminalPostwork?.(sessionId)
      ),
      // CTL-013: generation/abort token for the postwork window. A late
      // continuation validates its captured token against the CURRENT
      // generation (bumped by every new beginTerminalPostworkGeneration call
      // and invalidated by clearTerminalPostwork) before mutating state.
      beginTerminalPostworkGeneration: (sessionId) => multiStreamController?.beginTerminalPostworkGeneration?.(sessionId) ?? null,
      isTerminalPostworkGenerationCurrent: (sessionId, token) => (
        typeof multiStreamController?.isTerminalPostworkGenerationCurrent === 'function'
          ? multiStreamController.isTerminalPostworkGenerationCurrent(sessionId, token) === true
          : true
      ),
      captureStreamGeneration: (sessionId, streamId) => multiStreamController?.captureStreamGeneration?.(sessionId, streamId) || null,
      isStreamGenerationCurrent: (token) => multiStreamController?.isStreamGenerationCurrent?.(token) === true,
    };
  }

  return { createLiveTurnReducerWiring, createStreamEphemeralSurfaces, createMultiStreamAdapters };
});
