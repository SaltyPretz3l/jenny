/* renderer/chat/renderer-render-pipeline-utils.js – render pipeline, chat state, sprites, format helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function noop() {}
  function formatDate(value, opts, fallback) {
    const parsed = value ? new Date(value) : null;
    if (!parsed || Number.isNaN(parsed.valueOf())) return fallback;
    return parsed.toLocaleString(undefined, opts);
  }
  function formatSessionDate(value) {
    return formatDate(value, { month: 'short', day: '2-digit' }, 'Recent');
  }
  function formatLogTimestamp(value) {
    return formatDate(value, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }, '--');
  }
  function formatMessageTerminalTimestamp(value) {
    return formatDate(value, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, '');
  }
  function resolveModule(globalName, requirePath) {
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) {
      return globalThis[globalName];
    }
    if (typeof require === 'function') {
      return require(requirePath);
    }
    return null;
  }

  function createRenderPipeline(deps) {
    const thinkingPipelineUtils = resolveModule('rendererRenderPipelineThinkingUtils', './renderer-render-pipeline-thinking');
    const chromePipelineUtils = resolveModule('rendererRenderPipelineChromeUtils', './renderer-render-pipeline-chrome');
    const threadStatePipelineUtils = resolveModule('rendererRenderPipelineThreadStateUtils', './renderer-render-pipeline-thread-state');
    const surfaceStatePipelineUtils = resolveModule('rendererRenderPipelineSurfaceStateUtils', './renderer-render-pipeline-surface-state');
    const projectionCachePipelineUtils = resolveModule('rendererRenderPipelineProjectionCacheUtils', './renderer-render-pipeline-projection-cache');
    const hydrationPipelineUtils = resolveModule('rendererRenderPipelineHydrationUtils', './renderer-render-pipeline-hydration');
    const projectionContextPipelineUtils = resolveModule('rendererRenderPipelineProjectionContextUtils', './renderer-render-pipeline-projection-context');
    const toolShellUtils = resolveModule('toolShellUtils', './renderer-tool-shell-utils');
    const renderMessageIndexUtils = resolveModule('rendererRenderMessageIndexUtils', './renderer-render-message-index-utils');
    const contextUsageUtils = resolveModule('rendererContextUsageUtils', './renderer-context-usage-utils');
    const timelineAdapterUtils = resolveModule('rendererRenderPipelineTimelineAdapter', './renderer-render-pipeline-timeline-adapter');
    const fallbackMarkupPipelineUtils = resolveModule('rendererRenderPipelineFallbackMarkupUtils', './renderer-render-pipeline-fallback-markup');
    const shellResolversUtils = resolveModule('rendererRenderPipelineShellResolvers', './renderer-render-pipeline-shell-resolvers');
    const chromeDelegatesUtils = resolveModule('rendererRenderPipelineChromeDelegates', './renderer-render-pipeline-chrome-delegates');
    const articleMarkupPipelineUtils = resolveModule('rendererRenderPipelineArticleMarkupUtils', './renderer-render-pipeline-article-markup');
    const threadDomPipelineUtils = resolveModule('rendererRenderPipelineThreadDomUtils', './renderer-render-pipeline-thread-dom');
    const renderEffectsPipelineUtils = resolveModule('rendererRenderPipelineRenderEffectsUtils', './renderer-render-pipeline-render-effects');
    const messageRendererPipelineUtils = resolveModule('rendererRenderPipelineMessageRenderer', './renderer-render-pipeline-message-renderer');
    const timelineVirtualizerUtils = resolveModule('rendererChatTimelineVirtualizer', './renderer-chat-timeline-virtualizer');
    const timelineOrientationUtils = resolveModule('rendererChatTimelineOrientationUtils', './renderer-chat-timeline-orientation-utils');
    const turnShellUtils = resolveModule('rendererTurnShell', './renderer-turn-shell');
    const turnRowRenderUtils = resolveModule('rendererTurnRowRenderUtils', './renderer-turn-row-render-utils');
    const turnTreeProjectorUtils = resolveModule('rendererTurnTreeProjector', './renderer-turn-tree-projector');
    const turnRowProjectorUtils = resolveModule('rendererTurnRowProjector', './renderer-turn-row-projector');
    const timelineVisibilityUtils = resolveModule('rendererTimelineVisibilityUtils', './renderer-timeline-visibility-utils');
    const { state } = deps;
    const { MESSAGE_STATUS, ACTIVITY_SCOPE } = deps.constants;
    const {
      homeView, chatView, ideView, artifactsView, logsView, settingsView, homeNavButton,
      chatTimeline, chatThreadScroll,
      chatThreadColumn, chatSpriteLayer, chatAssistantSprite,
      heroAvatar, heroTitle, heroSubtitle, heroRuntimeHint, chatInput,
      stopStreamButton, sendButton, composer, composerModelSelect, composerEffortSelect,
      composerSettingsButton,
      jumpToTopButton, jumpToBottomButton, jumpToLastPromptButton,
      composerModelSelectShell, composerEffortSelectShell,
      chatSurfaceEffects, chatSurfaceEffectLeft,
      chatThreadStage, composerWrap, chatOriginChip, chatOriginLabel,
    } = deps.dom;
    const {
      escapeHtml, getLatestAssistantMessageId,
      getLatestUserMessageId, resolveRegenerateRequest, buildAssistantMetaLabel,
      shouldShowThinkingToggle, renderMessageAttachments, renderToolCallBlock,
      buildInteractiveRecapViewModel, renderInteractiveRoundRecap, renderProactiveSuggestionBlock, renderSlashCommandOutput,
      renderThinkingWidget, renderAgentStatusWidget = function noopRenderAgentStatusWidget() { return ''; }, renderAssistantFailureNotice, renderContextCompactedNotice = function noopRenderContextCompactedNotice() { return ''; }, renderMessageHoverRow,
      getCurrentSessionMessages, getCurrentVisibleMessages, getVisibleSessionMessages,
      isSendBusy, isSessionStreaming, hasPendingToolApprovalForSession,
      isSendPreflightPending, updateTokenDisplay, syncTurnElapsedClock,
      isInteractiveRoundRecapExpanded, pruneInteractiveRoundRecapExpansionState,
      setFollowLatest, scheduleMessageViewportSync,
      getPendingQuestionBatch, hasStalePendingQuestionBatch, buildInteractiveBatchRowMarkup,
      buildPlanProposalRowMarkup = function noopBuildPlanProposalRowMarkup() { return ''; },
      getActivitySnapshot, getMostRecentActivity, isActivityBusy, applyActivityAttributes,
      renderComposerInteractivePanel, closeComposerPopover, syncComposerInputHeight,
      setComposerHoloState, setSpriteHoloState, updateComposerSafeOffset, renderSessions,
      renderWorkspaceChrome, renderSettings, renderIde = noop, layoutIdeEditor = noop,
      reconcileChatDockHost = function noopReconcileChatDockHost() { return false; },
      renderArtifactReviewPanel,
      isArtifactReviewVisible = function noopArtifactReviewVisible() { return false; },
      renderContextPanel, renderPinnedNotes, renderHomePanel, shouldRenderHomePanel = function noopShouldRenderHomePanel() { return false; }, renderAttachmentTray,
      renderComposerStatusNotice, setComposerStatusNotice, clearComposerStatusNotice, renderToastViewport, renderComposerPopover, renderCommandPopover,
      clearActivity, failActivity,
      beginActivity, getCurrentRuntimePreferences, syncComposerModelSelectWidth,
      renderComposerEnhancements, onSurfaceLifecycleSync,
      renderMarkdown, renderStreamingMarkdownUnits, publishLifecycleStatus: _publishLifecycleStatus, renderTurnStatusPill: _renderTurnStatusPill, syncBackendNotice: _syncBackendNotice,
      syncPersistedReasoningPhaseExpansionState = function noopSyncPersistedReasoningPhaseExpansionState() {},
      getChatSendLifecycle = function noopGetChatSendLifecycle() { return 'idle'; },
      getChatTimelineRowModelEnabled = function noopGetChatTimelineRowModelEnabled() { return false; },
      recordChatTimelineRolloutSignal = function noopRecordChatTimelineRolloutSignal() { return { logged: false, count: 0 }; },
      rollbackChatTimelineRowModel = function noopRollbackChatTimelineRowModel() { return false; },
      refreshActiveSurfaceEffect: _refreshActiveSurfaceEffect,
      appendClientLog: _appendClientLog,
      renderHeader: _renderHeader,
      renderPrompts: _renderPrompts,
      stopFallbackRotation: _stopFallbackRotation,
    } = deps.callbacks;
    const appendClientLog = typeof _appendClientLog === 'function' ? _appendClientLog : function noop() {};
    const timelineVisibilityTracker = typeof timelineVisibilityUtils?.getTimelineVisibilityTracker === 'function'
      ? timelineVisibilityUtils.getTimelineVisibilityTracker(state, { appendClientLog })
      : null;
    const refreshActiveSurfaceEffect = typeof _refreshActiveSurfaceEffect === 'function' ? _refreshActiveSurfaceEffect : function noop() {};
    const renderHeader = typeof _renderHeader === 'function' ? _renderHeader : function noop() {};
    const renderPrompts = typeof _renderPrompts === 'function' ? _renderPrompts : function noop() {};
    const stopFallbackRotation = typeof _stopFallbackRotation === 'function' ? _stopFallbackRotation : function noop() {};
    const syncBackendNotice = typeof _syncBackendNotice === 'function' ? _syncBackendNotice : function noop() {};
    const projectTurnTree = typeof turnTreeProjectorUtils?.projectTurnTree === 'function'
      ? turnTreeProjectorUtils.projectTurnTree
      : null;
    const projectTurnRows = typeof turnRowProjectorUtils?.projectTurnRows === 'function'
      ? turnRowProjectorUtils.projectTurnRows
      : null;
    const projectTurn = typeof turnRowProjectorUtils?.projectTurn === 'function'
      ? turnRowProjectorUtils.projectTurn
      : null;
    const { thinkingController, reducedMotionQuery, thinkingIndicator, scrollCoordinator } = deps.controllers;
    const { uiRuntime, spriteRuntime } = deps.runtime;

    // Recap models, thread-collapse state, and recap-expansion accessors moved
    // into renderer/chat/renderer-render-pipeline-thread-state.js. Late-bound callbacks let
    // shouldShowThreadToggle (resolved later from threadTreeUtils) and
    // renderMessages (declared later in this closure) be referenced here
    // before their declarations.
    const threadStatePipeline = threadStatePipelineUtils.createThreadStatePipeline({
      state,
      callbacks: {
        buildInteractiveRecapViewModel,
        isInteractiveRoundRecapExpanded,
        pruneInteractiveRoundRecapExpansionState,
        shouldShowThreadToggle: (node) => shouldShowThreadToggle(node),
        renderMessages: () => renderMessages(),
      },
    });
    const {
      buildInteractiveRecapModel,
      isThreadBranchCollapsed,
      pruneThreadBranchState,
      buildThreadExpansionSignature,
      isThreadBranchOpen,
      toggleThreadBranch,
      isRecapExpandedForSession,
      pruneRecapExpansionState,
    } = threadStatePipeline;

    // Surface-state, send-lifecycle, chat-state classes, transition timers,
    // and selector escape helpers moved into
    // renderer/chat/renderer-render-pipeline-surface-state.js.
    const surfaceStatePipeline = surfaceStatePipelineUtils.createSurfaceStatePipeline({
      state,
      dom: {
        chatView,
        composer,
        composerWrap,
        chatSurfaceEffects,
        chatSurfaceEffectLeft,
        homeView,
        ideView,
        artifactsView,
        logsView,
        settingsView,
      },
      runtime: { uiRuntime },
      callbacks: {
        getChatSendLifecycle,
        isSendPreflightPending,
        isSessionStreaming,
        hasPendingToolApprovalForSession,
        updateComposerSafeOffset,
        refreshActiveSurfaceEffect, onSurfaceLifecycleSync,
      },
    });
    const {
      resolveChatSendLifecycle,
      syncStableChatSurfaceState,
      applyChatStateClasses,
      applySurfaceEffect,
      syncChatState,
      scheduleThreadTransitionCleanup,
      escapeSelectorValue,
    } = surfaceStatePipeline;
    const streamRevealController = (globalThis.rendererStreamRevealUtils || {}).createStreamRevealController?.({
      windowRef: window,
      chatTimeline,
      reducedMotionQuery,
      renderStreamingMarkdownUnits,
      escapeSelectorValue,
      appendClientLog,
      state, recordChatTimelineRolloutSignal,
    }) || null;
    const {
      resetState: resetStreamRevealState = () => {},
      buildTimelineStructureSignature = () => '',
      buildStreamingBubbleMarkup = (message) => ({ bubbleInnerHtml: renderMarkdown(message && message.content), entryReveal: false }),
      commitFullRender: commitStreamRevealFullRender = () => {},
      replayReasoningHandoff: replayStreamRevealHandoff = () => {},
      canPatchMessage: canPatchStreamRevealMessage = () => false,
      describePatchBlock: describeStreamRevealPatchBlock = () => '',
      stampStreamingArticleMarker: stampStreamingArticleMarkerNode = () => null,
      queuePatch: queueStreamRevealPatch = () => {},
      patchActiveTurnRoot: patchStreamRevealActiveTurnRoot = () => false,
      updateTailState: updateStreamRevealTailState = () => {},
    } = streamRevealController || {};

    const timelineAdapter = timelineAdapterUtils.createRenderPipelineTimelineAdapter({
      timelineOrientationUtils,
      buildTimelineStructureSignature,
    });
    const {
      computeDerivedMessageState,
      resolveResumeTailAssistantMessageId,
      computeTailFingerprint,
      buildMessageProjectionFingerprint,
      buildMessageRenderSignature,
      computeMessageFingerprintList,
      renderSignatureFromFingerprints,
      computeProjectionSignature,
      computeProjectionSignatureFromFingerprints,
      computeStructureHash,
      computeTurnStructureHash,
      computeTurnTailFingerprint,
      deriveTimelineTimeDividers,
      buildTimeDividerMap,
      buildTimelineDividerInputSignature,
      buildTranscriptThreadTree,
      collectThreadBranchIds,
      shouldShowThreadToggle,
    } = timelineAdapter;
    const thinkingPipeline = thinkingPipelineUtils?.createThinkingPipeline?.({
      state,
      constants: { MESSAGE_STATUS },
      dom: {
        chatTimeline,
        chatThreadColumn,
        chatSpriteLayer,
        chatAssistantSprite,
      },
      controllers: { thinkingIndicator, thinkingController },
      runtime: { spriteRuntime },
      callbacks: {
        getCurrentSessionMessages,
        getLatestUserMessageId,
        getLatestAssistantMessageId,
        escapeSelectorValue,
        isSendPreflightPending,
        setSpriteHoloState,
      },
    }) || {};
    const turnShellRenderer = turnShellUtils?.createTurnShellRenderer?.({ escapeHtml }) || null;
    const turnRowRenderer = typeof turnRowRenderUtils?.createTurnRowRenderUtils === 'function'
      ? turnRowRenderUtils.createTurnRowRenderUtils({
        MESSAGE_STATUS,
        buildTimeDividerMarkup: timelineOrientationUtils?.buildTimeDividerMarkup,
        escapeHtml, buildInteractiveBatchRowMarkup,
        buildPlanProposalRowMarkup,
        renderMarkdown,
        renderStreamingMarkdownUnits,
        renderMessageAttachments,
        renderInteractiveRoundRecap,
        renderProactiveSuggestionBlock,
        renderSlashCommandOutput,
        renderThinkingWidget,
        renderToolCallBlock,
        renderAgentStatusWidget,
        renderAgentProgressRow: (function resolveRenderAgentProgressRow() {
          const mod = typeof globalThis !== 'undefined' ? globalThis.rendererTranscriptAgentProgressUtils : null;
          return (mod && typeof mod.renderAgentProgressRow === 'function')
            ? mod.renderAgentProgressRow
            : function noopRenderAgentProgressRow() { return ''; };
        })(),
        renderAssistantFailureNotice,
        renderContextCompactedNotice,
        isAgentProgressDurableEnabled: function readAgentProgressDurableFlag() {
          return Boolean(state && state.features && state.features.featureFlags
            && state.features.featureFlags.agent_progress_durable === true);
        },
        getFeatureFlags: function readRendererFeatureFlags() {
          return (state && state.features && state.features.featureFlags) || {};
        },
      })
      : null;
    const {
      resolveVisibleMessageDomTarget,
      resolveTurnArticleMessageId,
      buildMessageBodyShell,
      buildAssistantContentShell,
      buildMessageShellArticle,
      buildTurnRowId,
      buildTurnRowListMarkup,
    } = shellResolversUtils.createShellResolvers({
      escapeHtml, escapeSelectorValue, turnShellUtils, turnShellRenderer, turnRowRenderer, fallbackMarkupPipelineUtils,
    });
    let renderMessagesImpl = function noopRenderMessages() {};
    let subagentMonitorController = null;
    function renderMessages(options) {
      return renderMessagesImpl(options);
    }
    const chromePipeline = chromePipelineUtils?.createChromePipeline?.({
      state,
      constants: { ACTIVITY_SCOPE, MESSAGE_STATUS },
      dom: {
        homeView,
        chatView,
        ideView,
        artifactsView,
        logsView,
        settingsView,
        homeNavButton,
        chatThreadStage,
        composerWrap,
        chatOriginChip,
        chatOriginLabel,
        heroAvatar,
        heroTitle,
        heroSubtitle,
        heroRuntimeHint,
        chatInput,
        composer,
        composerModelSelect,
        composerEffortSelect,
        composerSettingsButton,
        jumpToTopButton,
        jumpToBottomButton,
        jumpToLastPromptButton,
        stopStreamButton,
        sendButton,
        composerModelSelectShell,
        composerEffortSelectShell,
      },
      controllers: { logRenderer: deps.controllers?.logRenderer || null },
      callbacks: {
        renderHeader: (...a) => renderHeader(...a),
        renderPrompts: (...a) => renderPrompts(...a),
        renderMessages: (...a) => renderMessages(...a),
        applySurfaceEffect: (...a) => applySurfaceEffect(...a),
        syncBackendNotice: (...a) => syncBackendNotice(...a),
        publishLifecycleStatus: (...a) => _publishLifecycleStatus(...a),
        renderTurnStatusPill: (...a) => (typeof _renderTurnStatusPill === 'function' ? _renderTurnStatusPill(...a) : undefined),
        renderSettings: (...a) => renderSettings(...a),
        renderIde: (...a) => renderIde(...a),
        layoutIdeEditor: (...a) => layoutIdeEditor(...a),
        reconcileChatDockHost: (...a) => reconcileChatDockHost(...a),
        rebuildChatVirtualizer: () => virtualizerFacade.rebuild(), // lazy: declared later, call-time only (ide_chat_dock)
        renderAttachmentTray: (...a) => renderAttachmentTray(...a),
        renderComposerStatusNotice: (...a) => renderComposerStatusNotice(...a),
        setComposerStatusNotice: (...a) => setComposerStatusNotice?.(...a),
        clearComposerStatusNotice: (...a) => clearComposerStatusNotice?.(...a),
        renderToastViewport: (...a) => renderToastViewport(...a),
        renderComposerPopover: (...a) => renderComposerPopover(...a),
        renderCommandPopover: (...a) => renderCommandPopover(...a),
        renderHomePanel: (...a) => renderHomePanel(...a),
        shouldRenderHomePanel: (...a) => shouldRenderHomePanel(...a),
        renderContextPanel: (...a) => renderContextPanel?.(...a),
        renderPinnedNotes: (...a) => renderPinnedNotes?.(...a),
        renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a),
        renderSessions: (...a) => renderSessions(...a),
        renderArtifactReviewPanel: (...a) => renderArtifactReviewPanel?.(...a),
        getVisibleSessionMessages,
        getCurrentVisibleMessages,
        getCurrentRuntimePreferences,
        isSendBusy,
        isSessionStreaming,
        hasPendingToolApprovalForSession,
        getPendingQuestionBatch,
        hasStalePendingQuestionBatch,
        getActivitySnapshot,
        getMostRecentActivity,
        isActivityBusy,
        applyActivityAttributes,
        syncComposerModelSelectWidth,
        renderComposerInteractivePanel,
        closeComposerPopover,
        syncComposerInputHeight,
        setComposerHoloState,
        updateComposerSafeOffset,
        renderLiveThinkingChip: (...a) => renderLiveThinkingChip(...a),
        renderComposerEnhancements,
        resolveChatSendLifecycle,
        syncStableChatSurfaceState,
        getLatestUserMessageId,
        isSendPreflightPending,
        syncTurnElapsedClock,
        stopFallbackRotation,
      },
    }) || {};

    // Projection-cache machinery, canonical-transcript building, tool-row
    // projection telemetry, and row-model meta accessors moved into
    // renderer/chat/renderer-render-pipeline-projection-cache.js (Stage C1).
    const projectionCachePipeline = projectionCachePipelineUtils.createProjectionCachePipeline({
      state,
      dom: { chatTimeline },
      runtime: { uiRuntime },
      callbacks: {
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

    // Article markup, prediction helpers, projected-turn-article rendering,
    // and the legacy fallback dispatcher (Cluster 10 + 11) moved into
    // renderer/chat/renderer-render-pipeline-article-markup.js (Stage D2). All deps resolve
    // from already-instantiated upstream pipelines or from `deps` directly,
    // so no late-binding lambdas are required at this call site.
    const articleMarkupPipeline = articleMarkupPipelineUtils.createArticleMarkupPipeline({
      state,
      constants: { MESSAGE_STATUS },
      dom: { chatTimeline, chatThreadColumn },
      controllers: { reducedMotionQuery },
      callbacks: {
        buildToolEntryInnerMarkup,
        resolveProjectedPrimaryRow,
        resolveArticlePredictionCacheKey,
        getMessageFromCollection,
        deriveActionTargetMessageId,
        resolveVisibleTurnArticleTarget,
        recordTurnArticleRolloutSignal,
        resolveProjectionStreamingRowId,
        buildInteractiveRecapModel,
        buildMessageShellArticle,
        buildMessageBodyShell,
        buildAssistantContentShell,
        resolveResumeTailAssistantMessageId,
        buildTurnRowListMarkup,
        buildTurnRowId,
        buildStreamingBubbleMarkup,
        escapeHtml,
        renderMarkdown,
        buildAssistantMetaLabel,
        buildMessageTokenMeta: contextUsageUtils?.buildMessageTokenMeta,
        formatMessageTokenMeta: contextUsageUtils?.formatMessageTokenMeta,
        combineMessageMetaLabels: contextUsageUtils?.combineMessageMetaLabels,
        renderAgentStatusWidget,
        renderContextCompactedNotice,
        renderThinkingWidget,
        renderAssistantFailureNotice,
        renderMessageAttachments,
        renderMessageHoverRow,
        renderInteractiveRoundRecap,
        renderProactiveSuggestionBlock,
        renderSlashCommandOutput,
        formatMessageTerminalTimestamp,
        isArtifactReviewVisible,
      },
    });
    const {
      buildMessageInnerMarkup,
      buildMessageArticleInnerHtml,
      buildMessageArticleMarkup,
      buildTurnArticleMarkup,
      maybePredictTurnHeight,
      schedulePredictedHeightCleanup,
      syncPatchedArticlePrediction,
    } = articleMarkupPipeline;

    // Thread DOM rendering (Cluster 12) moved into
    // renderer/chat/renderer-render-pipeline-thread-dom.js (Stage D3). The factory takes
    // the chatTimeline DOM target plus the thread-state isThreadBranchOpen
    // helper and the threadTree-resolved shouldShowThreadToggle predicate.
    // No late-binding lambdas are required — `buildArticle` is passed in at
    // call time by the render-effects callers.
    const threadDomPipeline = threadDomPipelineUtils.createThreadDomPipeline({
      state,
      dom: { chatTimeline },
      callbacks: {
        escapeHtml,
        shouldShowThreadToggle,
        isThreadBranchOpen,
        appendClientLog,
      },
    });
    const {
      renderThreadTree,
      renderThreadNode,
      updateThreadRailExtents,
      measureThreadRailExtentsNow,
      scheduleRailResizeUpdate,
      attachRailResizeObserver,
      refreshRailRootObservation,
      syncTimelineBusyState,
      dispose: disposeThreadDomPipeline,
    } = threadDomPipeline;

    // B5 — long-conversation timeline virtualization. The active-turn-root
    // pin probe reads through this ref; render-effects writes it before
    // each render via virtualizerFacade.setActiveTurnRoot.
    const virtualizerActiveRootRef = { id: '' };
    const virtualizer = timelineVirtualizerUtils
      ? timelineVirtualizerUtils.createTimelineVirtualizer({
        chatTimeline,
        chatThreadScroll,
        document: typeof document !== 'undefined' ? document : null,
        window: typeof window !== 'undefined' ? window : null,
        boundsEnabled: state.features?.featureFlags?.chat_long_thread_bounds !== false,
        contentVisibilityEnabled: state.features?.featureFlags?.chat_render_content_visibility === true,
        getActiveTurnRootMessageId: function readActiveTurnRoot() {
          return virtualizerActiveRootRef.id || '';
        },
        onAfterMount: function onVirtualizedEntryMount(entryEl, containerEl) {
          // Lazy-decoration re-trigger (mermaid re-observe, math re-typeset,
          // follow-up buttons) lives on the render-effects sibling — this
          // controller is at the file-size cap.
          renderEffectsPipeline?.redecorateVirtualizedEntry?.(containerEl);
        },
        requestEntryMarkup: function requestVirtualizedEntryMarkup(entryEl) {
          return renderEffectsPipeline?.buildVirtualizedEntryInnerHtml?.(entryEl) || '';
        },
        requestCanonicalRerender: function requestVirtualizerRecoveryRender() {
          renderMessages({ forceFullRender: true, reason: 'virtualizer_recovery' });
        },
        captureReaderAnchor: function captureVirtualizerReaderAnchor() {
          return scrollCoordinator?.captureReaderAnchor?.();
        },
        noteProgrammaticWrite: function noteVirtualizerProgrammaticWrite(reason) {
          scrollCoordinator?.noteProgrammaticWrite?.(reason);
        },
        restoreReaderAnchor: function restoreVirtualizerReaderAnchor() {
          return scrollCoordinator?.restoreReaderAnchor?.();
        },
        appendClientLog,
        onStatsChange: function updateVirtualizerStats(nextStats) {
          const longThreadBudgetStats = {
            ...(state.ui?.longThreadBudgetStats || {}),
            ...(uiRuntime.longThreadBudgetStats || {}),
            ...(nextStats || {}),
          };
          uiRuntime.longThreadBudgetStats = longThreadBudgetStats;
          if (state.ui && typeof state.ui === 'object') {
            state.ui.longThreadBudgetStats = longThreadBudgetStats;
          }
        },
      })
      : null;

    // Facade exposed to render-effects so it doesn't need to know
    // whether the virtualizer module loaded. All three operations are
    // safe no-ops when `virtualizer` is null.
    const virtualizerFacade = {
      setActiveTurnRoot(messageId) {
        virtualizerActiveRootRef.id = String(messageId || '').trim();
      },
      rebuild() {
        if (!virtualizer) return;
        virtualizer.rebuild();
        const longThreadBudgetStats = {
          ...(state.ui?.longThreadBudgetStats || {}),
          ...(uiRuntime.longThreadBudgetStats || {}),
          ...(virtualizer._internals?.getBudgetStats?.() || {}),
        };
        uiRuntime.longThreadBudgetStats = longThreadBudgetStats;
        if (state.ui && typeof state.ui === 'object') {
          state.ui.longThreadBudgetStats = longThreadBudgetStats;
        }
      },
      prepareForStructuralMorph() { virtualizer && virtualizer.prepareForStructuralMorph(); },
      refreshScope(rootEl) { virtualizer && virtualizer.refreshScope(rootEl); },
      getBudgetStats() { return virtualizer?._internals?.getBudgetStats?.() || null; },
    };

    // Aggregate teardown for the render-pipeline controller. The
    // sub-pipelines holding async resources are threadDomPipeline (its
    // ResizeObserver + pending rAF) and now the B5 virtualizer (its
    // IntersectionObserver). If future sub-pipelines (chrome,
    // render-effects, etc.) need teardown, register them here so app-level
    function disposeRenderPipeline() {
      try { subagentMonitorController?.dispose?.(); } catch (_e) { /* defensive */ }
      try { disposeThreadDomPipeline?.(); } catch (_e) { /* defensive */ }
      try { renderEffectsPipeline?.dispose?.(); } catch (_e) { /* defensive */ }
      try { virtualizer?.dispose?.(); } catch (_e) { /* defensive */ }
      uiRuntime.longThreadBudgetStats = null;
      if (state.ui && typeof state.ui === 'object') {
        state.ui.longThreadBudgetStats = null;
      }
      try { thinkingPipeline?.dispose?.(); } catch (_e) { /* defensive */ }
      try { surfaceStatePipeline?.dispose?.(); } catch (_e) { /* defensive */ }
    }

    // Render orchestration is delegated to renderer-render-pipeline-render-effects.js; renderMessages remains in this factory.
    const renderEffectsPipeline = renderEffectsPipelineUtils.createRenderEffectsPipeline({
      state,
      dom: { chatTimeline },
      runtime: { uiRuntime },
      callbacks: {
        buildMessageArticleMarkup,
        schedulePredictedHeightCleanup,
        syncPatchedArticlePrediction,
        renderThreadTree,
        renderThreadNode,
        updateThreadRailExtents,
        measureThreadRailExtentsNow,
        scheduleRailResizeUpdate,
        attachRailResizeObserver,
        refreshRailRootObservation,
        syncTimelineBusyState,
        thinkingPipeline,
        chromePipeline,
        commitStreamRevealFullRender,
        replayStreamRevealHandoff,
        patchStreamRevealActiveTurnRoot,
        updateStreamRevealTailState,
        resolveProjectionStreamingRowTarget,
        resolveTurnArticleMessageId,
        computeTailFingerprint,
        syncBackendNotice,
        renderArtifactReviewPanel,
        escapeSelectorValue,
        isArtifactReviewVisible,
        scheduleMessageViewportSync,
        appendClientLog,
        recordChatTimelineRolloutSignal,
        // B5 virtualizer integration — see virtualizer construction above.
        virtualizerFacade,
      },
    });
    const {
      performFullMessageRender,
      tryPatchActiveTurnRoot,
      syncPostRenderChrome,
      runPostTimelineRenderEffects,
      renderLiveThinkingChip,
      hideAssistantSprite,
      applyAssistantSprite,
      updateAssistantSpritePosition,
      renderLayout,
    } = renderEffectsPipeline;

    const messageRendererPipeline = messageRendererPipelineUtils.createRenderPipelineMessageRenderer({
      state,
      dom: { chatTimeline, chatThreadScroll },
      controllers: { reducedMotionQuery, thinkingController },
      runtime: { uiRuntime },
      timelineVisibilityTracker,
      callbacks: {
        appendClientLog,
        buildCanonicalTranscriptMessages,
        buildInteractiveRecapModel,
        buildMessageArticleInnerHtml,
        buildMessageArticleMarkup,
        buildMessageInnerMarkup,
        buildMessageRenderSignature,
        computeMessageFingerprintList,
        renderSignatureFromFingerprints,
        buildProjectionContext,
        buildProjectionStreamingRowMarkup,
        buildRecapExpansionSignature,
        buildThreadExpansionSignature,
        buildTimelineDividerInputSignature,
        buildTimeDividerMap,
        buildTranscriptThreadTree,
        canPatchStreamRevealMessage,
        describeStreamRevealPatchBlock,
        stampStreamingArticleMarkerNode,
        collectThreadBranchIds,
        commitStreamRevealFullRender,
        replayStreamRevealHandoff,
        computeDerivedMessageState,
        computeStructureHash,
        deriveTimelineTimeDividers,
        getCurrentVisibleMessages,
        getForcedOpenStreamingMessageId,
        hideAssistantSprite,
        isSendBusy,
        isSendPreflightPending,
        isThreadBranchOpen,
        noteScrollProgrammaticWrite: (reason) => scrollCoordinator?.noteProgrammaticWrite?.(reason),
        performFullMessageRender,
        pruneRecapExpansionState,
        pruneThreadBranchState,
        pruneToolRowProjectionSessionCaches,
        queueStreamRevealPatch,
        recordTurnArticleRolloutSignal,
        resetStreamRevealState,
        resolveProjectionStreamingRowTarget,
        resolveRegenerateRequest,
        resolveTurnArticleMessageId,
        resolveVisibleTurnArticleTarget,
        runPostTimelineRenderEffects,
        scheduleThreadTransitionCleanup,
        setFollowLatest,
        shouldShowThinkingToggle,
        shouldShowThreadToggle,
        syncChatState,
        syncPersistedReasoningPhaseExpansionState,
        syncPostRenderChrome,
        syncTimelineBusyState,
        tryPatchActiveTurnRoot,
        updateAssistantSpritePosition,
        updateTokenDisplay,
      },
    });
    const monitorDocument = chatTimeline?.ownerDocument || null;
    const monitorWindow = monitorDocument?.defaultView || null;
    subagentMonitorController = globalThis.rendererSubagentMonitorController?.createSubagentMonitorController?.({
      state,
      documentRef: monitorDocument,
      windowRef: monitorWindow,
      inspector: monitorDocument?.getElementById?.('subagentInspector'),
      chatView,
      getMessages: () => getCurrentSessionMessages(),
      appendClientLog,
    }) || null;
    subagentMonitorController?.bind?.();
    if (typeof messageRendererPipeline?.renderMessages === 'function') {
      const renderTimelineMessages = messageRendererPipeline.renderMessages;
      renderMessagesImpl = function renderMessagesAndReconcileMonitor(options) {
        const result = renderTimelineMessages(options);
        subagentMonitorController?.reconcile?.();
        return result;
      };
    }

    const {
      syncSurfaceStates,
      setSessionOrigin,
      setPendingOrigin,
      clearPendingOrigin,
      attachPendingOriginToSession,
      rekeySessionOrigin,
      renderOriginChip,
      renderHero,
      renderLogs,
      syncComposerVisualState,
      renderComposerJumpControls,
      renderComposerState,
      renderAll,
      syncBackendActivityFromStatus,
    } = chromeDelegatesUtils.createChromeDelegates({ chromePipeline, clearActivity, failActivity, beginActivity, ACTIVITY_SCOPE });

    return {
      formatSessionDate,
      formatLogTimestamp,
      formatMessageTerminalTimestamp,
      applyChatStateClasses,
      syncChatState,
      escapeSelectorValue,
      hideAssistantSprite,
      applyAssistantSprite,
      updateAssistantSpritePosition,
      renderLayout,
      renderHeader,
      renderPrompts,
      renderMessages,
      renderHero,
      syncBackendNotice,
      renderLogs,
      syncComposerVisualState,
      renderComposerJumpControls,
      renderComposerState,
      renderAll,
      applySurfaceEffect,
      syncBackendActivityFromStatus,
      stopFallbackRotation,
      renderLiveThinkingChip,
      setSessionOrigin,
      setPendingOrigin,
      clearPendingOrigin,
      attachPendingOriginToSession,
      rekeySessionOrigin,
      clearProjectionContextCacheForSession,
      rekeyProjectionContextCache,
      invalidateProjectionStateForSession,
      deriveActionTargetMessageId,
      buildTurnArticleMarkup,
      maybePredictTurnHeight,
      resolveTurnArticleMessageId,
      getCurrentProjectionContext,
      toggleThreadBranch,
      timelineVirtualizer: virtualizer,
      dispose: disposeRenderPipeline,
    };
  }
  return { createRenderPipeline };
});
