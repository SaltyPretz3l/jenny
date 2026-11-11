/* renderer/chat/renderer-render-pipeline-projection-stack.js
 * Composes the three projection pipelines in dependency order: projection
 * cache (C1), persisted-turn hydration (C2) and projection context (C3), and
 * returns the members the rest of the render pipeline consumes. Split out of
 * renderer-render-pipeline-utils.js, which supplies the shared inputs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineProjectionStack = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createProjectionStack(deps) {
    const {
      state,
      MESSAGE_STATUS,
      chatTimeline,
      uiRuntime,
      reducedMotionQuery,
      projectionCachePipelineUtils,
      hydrationPipelineUtils,
      projectionContextPipelineUtils,
      toolShellUtils,
      turnRowRenderer,
      renderMessageIndexUtils,
      projectTurnTree,
      projectTurnRows,
      projectTurn,
      getPaneSessionId,
      getPaneTranscriptView,
      appendClientLog,
      escapeHtml,
      renderToolCallBlock,
      getChatTimelineRowModelEnabled,
      recordChatTimelineRolloutSignal,
      rollbackChatTimelineRowModel,
      buildInteractiveRecapModel,
      isRecapExpandedForSession,
      resolveTurnArticleMessageId,
      resolveVisibleMessageDomTarget,
      buildTurnRowId,
      buildTurnRowListMarkup,
      buildMessageProjectionFingerprint,
      computeProjectionSignature,
      computeProjectionSignatureFromFingerprints,
      computeTurnStructureHash,
      computeTurnTailFingerprint,
    } = deps;

    // Projection-cache machinery, canonical-transcript building, tool-row
    // projection telemetry, and row-model meta accessors moved into
    // renderer/chat/renderer-render-pipeline-projection-cache.js (Stage C1).
    const projectionCachePipeline = projectionCachePipelineUtils.createProjectionCachePipeline({
      state,
      dom: { chatTimeline },
      runtime: { uiRuntime },
      callbacks: {
        getPaneSessionId,
        appendClientLog,
        getChatTimelineRowModelEnabled,
        recordChatTimelineRolloutSignal,
        buildInteractiveRecapModel,
        resolveTurnArticleMessageId,
        resolveVisibleMessageDomTarget,
      },
    });
    const {
      buildCanonicalTranscriptMessages,
      pruneToolRowProjectionSessionCaches,
      logToolRowProjectionFallbackOnce,
      logToolRowProjectionFailureOnce,
      getProjectionContextCache,
      finalizeProjectionContext,
      getCurrentProjectionContext,
      resolveVisibleTurnArticleTarget,
      recordTurnArticleRolloutSignal,
      clearProjectionContextCacheForSession,
      rekeyProjectionContextCache,
      getRowModelMeta,
      countLegacyVisibleMessages,
    } = projectionCachePipeline;

    // Persisted-turn-event hydration, fingerprint computation, live-row
    // projection state, and streaming-row resolvers moved into
    // renderer/chat/renderer-render-pipeline-hydration.js (Stage C2).
    const hydrationPipeline = hydrationPipelineUtils.createHydrationPipeline({
      state,
      dom: { chatTimeline },
      controllers: { reducedMotionQuery },
      callbacks: {
        getPaneSessionId,
        getPaneTranscriptView,
        projectTurnTree,
        projectTurnRows,
        projectTurn,
        buildMessageProjectionFingerprint,
        computeTurnStructureHash,
        computeTurnTailFingerprint,
        buildTurnRowId,
        buildTurnRowListMarkup,
        recordTurnArticleRolloutSignal,
        indexRowsByRenderMessageId: renderMessageIndexUtils?.indexRowsByRenderMessageId,
      },
    });
    const {
      getPersistedTurnEventState,
      buildHydratedTurnProjection,
      buildHydratedProjectionDigest,
      resolveThreadRootMessageId,
      isLiveRowModelEnabledForSession,
      isTurnStreamLive,
      getLiveProjectionStateForSession,
      overlayProjectedRows,
      resolveProjectionStreamingRowTarget,
      resolveProjectionStreamingRowId,
      buildProjectionStreamingRowMarkup,
      pruneConsumedLiveProjectionState,
    } = hydrationPipeline;

    // Projection-context builder, projected-row resolution, tool-entry
    // markup, and recap-expansion signature computation moved into
    // renderer/chat/renderer-render-pipeline-projection-context.js (Stage C3).
    const projectionContextPipeline = projectionContextPipelineUtils.createProjectionContextPipeline({
      state,
      constants: { MESSAGE_STATUS },
      callbacks: {
        getPaneSessionId,
        isTurnStreamLive,
        getPaneTranscriptView,
        escapeHtml,
        renderToolCallBlock,
        // Ht-E: the article path's wired trace-row builder, reused by the
        // settled-tool partition on the non-coalescing fallback path.
        buildProjectedToolCallRowMarkup: turnRowRenderer?.buildToolCallRowMarkup,
        hasSpecializedToolShell: toolShellUtils?.hasSpecializedToolShell,
        projectTurn,
        projectTurnTree,
        projectTurnRows,
        computeProjectionSignature,
        computeProjectionSignatureFromFingerprints,
        computeTurnStructureHash,
        computeTurnTailFingerprint,
        getChatTimelineRowModelEnabled,
        recordChatTimelineRolloutSignal,
        rollbackChatTimelineRowModel,
        getProjectionContextCache,
        finalizeProjectionContext,
        getRowModelMeta,
        countLegacyVisibleMessages,
        logToolRowProjectionFailureOnce,
        logToolRowProjectionFallbackOnce,
        getPersistedTurnEventState,
        buildHydratedTurnProjection,
        buildHydratedProjectionDigest,
        isLiveRowModelEnabledForSession,
        getLiveProjectionStateForSession,
        overlayProjectedRows,
        pruneConsumedLiveProjectionState,
        resolveThreadRootMessageId,
        buildInteractiveRecapModel,
        isRecapExpandedForSession,
        indexRowsByRenderMessageId: renderMessageIndexUtils?.indexRowsByRenderMessageId,
      },
    });
    const {
      buildProjectionContext,
      resolveProjectedPrimaryRow,
      buildToolEntryInnerMarkup,
      resolveArticlePredictionCacheKey,
      getMessageFromCollection,
      deriveActionTargetMessageId,
      getForcedOpenStreamingMessageId,
      buildRecapExpansionSignature,
      invalidateProjectionStateForSession,
    } = projectionContextPipeline;

    return {
      buildCanonicalTranscriptMessages,
      pruneToolRowProjectionSessionCaches,
      getCurrentProjectionContext,
      resolveVisibleTurnArticleTarget,
      recordTurnArticleRolloutSignal,
      clearProjectionContextCacheForSession,
      rekeyProjectionContextCache,
      resolveProjectionStreamingRowTarget,
      resolveProjectionStreamingRowId,
      buildProjectionStreamingRowMarkup,
      buildProjectionContext,
      resolveProjectedPrimaryRow,
      buildToolEntryInnerMarkup,
      resolveArticlePredictionCacheKey,
      getMessageFromCollection,
      deriveActionTargetMessageId,
      getForcedOpenStreamingMessageId,
      buildRecapExpansionSignature,
      invalidateProjectionStateForSession,
    };
  }

  return { createProjectionStack };
});
