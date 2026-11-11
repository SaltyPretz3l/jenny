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
    return parsed.toLocaleString(globalThis.jennyI18n?.tag?.(), { ...opts, ...globalThis.jennyI18n?.timeOptions?.() });
  }
  function formatSessionDate(value) {
    return formatDate(value, { month: 'short', day: '2-digit' }, 'Recent');
  }
  function formatLogTimestamp(value) {
    return formatDate(value, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }, '--');
  }
  function formatMessageTerminalTimestamp(value) {
    return formatDate(value, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }, '');
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
  const virtualizerPipelineUtils = resolveModule('rendererRenderPipelineVirtualizer', './renderer-render-pipeline-virtualizer');
  const { getTimelineEntryWeight } = virtualizerPipelineUtils;

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
    const paneVisibilityUtils = resolveModule('rendererPaneVisibilityUtils', './renderer-pane-visibility-utils');
    const projectionStackUtils = resolveModule('rendererRenderPipelineProjectionStack', './renderer-render-pipeline-projection-stack');
    const paneRuntimeUtils = resolveModule('rendererRenderPipelinePaneRuntime', './renderer-render-pipeline-pane-runtime');
    const { state } = deps;
    const { MESSAGE_STATUS, ACTIVITY_SCOPE } = deps.constants;
    const {
      homeView, chatView, ideView, artifactsView, logsView, settingsView, homeNavButton,
      chatTimeline, chatThreadScroll,
      chatThreadColumn, chatSpriteLayer, chatAssistantSprite,
      heroAvatar, heroTitle, heroSubtitle, heroRuntimeHint, chatInput,
      stopStreamButton, sendButton, composer, composerModelSelect, composerEffortSelect,
      jumpToTopButton, jumpToBottomButton,
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
      getCurrentSessionMessages, getCurrentVisibleMessages, getVisibleSessionMessages: _getVisibleSessionMessages,
      getSessionMessages: _getSessionMessages,
      isSendBusy, isSessionStreaming, hasPendingToolApprovalForSession,
      isSendPreflightPending, updateTokenDisplay, syncTurnElapsedClock,
      isInteractiveRoundRecapExpanded, pruneInteractiveRoundRecapExpansionState,
      setFollowLatest, scheduleMessageViewportSync,
      isFollowingLatest, // this pane's follow intent; absent, each consumer's own default (state.ui.followLatest)
      getPendingQuestionBatch, hasStalePendingQuestionBatch, buildInteractiveBatchRowMarkup,
      buildPlanProposalRowMarkup = function noopBuildPlanProposalRowMarkup() { return ''; },
      getActivitySnapshot, getMostRecentActivity, isActivityBusy, applyActivityAttributes,
      renderComposerInteractivePanel, closeComposerPopover, syncComposerInputHeight,
      setComposerHoloState, updateComposerSafeOffset, renderSessions,
      renderWorkspaceChrome, renderSettings, renderComposerCarriers = noop, renderIde = noop, layoutIdeEditor = noop,
      reconcileChatDockHost = function noopReconcileChatDockHost() { return false; },
      renderArtifactReviewPanel,
      isArtifactReviewVisible = function noopArtifactReviewVisible() { return false; },
      renderContextPanel, renderPinnedNotes, renderHomePanel, shouldRenderHomePanel = function noopShouldRenderHomePanel() { return false; }, renderAttachmentTray,
      renderComposerStatusNotice, setComposerStatusNotice, clearComposerStatusNotice, renderToastViewport, renderComposerPopover,
      clearActivity, failActivity,
      beginActivity, getCurrentRuntimePreferences, getRuntimePreferencesFromSession = null,
      renderComposerEnhancements, onSurfaceLifecycleSync,
      renderMarkdown, renderStreamingMarkdownUnits, syncBackendNotice: _syncBackendNotice,
      syncPersistedReasoningPhaseExpansionState = function noopSyncPersistedReasoningPhaseExpansionState() {},
      getChatSendLifecycle = function noopGetChatSendLifecycle() { return 'idle'; },
      getChatTimelineRowModelEnabled = function noopGetChatTimelineRowModelEnabled() { return false; },
      recordChatTimelineRolloutSignal = function noopRecordChatTimelineRolloutSignal() { return { logged: false, count: 0 }; },
      rollbackChatTimelineRowModel = function noopRollbackChatTimelineRowModel() { return false; },
      refreshActiveSurfaceEffect: _refreshActiveSurfaceEffect,
      appendClientLog: _appendClientLog,
      renderHeader: _renderHeader,
    } = deps.callbacks;
    const appendClientLog = typeof _appendClientLog === 'function' ? _appendClientLog : function noop() {};
    const timelineVisibilityTracker = typeof timelineVisibilityUtils?.getTimelineVisibilityTracker === 'function'
      ? timelineVisibilityUtils.getTimelineVisibilityTracker(state, { appendClientLog })
      : null;
    const refreshActiveSurfaceEffect = typeof _refreshActiveSurfaceEffect === 'function' ? _refreshActiveSurfaceEffect : function noop() {};
    const renderHeader = typeof _renderHeader === 'function' ? _renderHeader : function noop() {};
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
    // renderThinkingWidget is one shared renderer closed over the app-level reasoning
    // controller; hand it THIS pane's, so a split pane's disclosures read its own state.
    const renderPaneThinkingWidget = typeof renderThinkingWidget === 'function'
      ? (message, latestAssistantMessageId, options) => renderThinkingWidget(message, latestAssistantMessageId, { ...options, thinkingController })
      : renderThinkingWidget;
    const { uiRuntime, spriteRuntime } = deps.runtime;
    // Split view W1-4a: what THIS pane shows (session, transcript view, selection
    // ownership, message getters) lives in renderer-render-pipeline-pane-runtime.js.
    const {
      paneId, getPaneSessionId, getPaneTranscriptView, isPaneSelecting, getVisibleSessionMessages, getSessionMessages,
    } = paneRuntimeUtils.createPaneAccessors({
      state,
      uiRuntime,
      paneVisibilityUtils,
      getVisibleSessionMessages: _getVisibleSessionMessages,
      getSessionMessages: _getSessionMessages,
      getCurrentVisibleMessages,
      getCurrentSessionMessages,
    });

    // Recap models, thread-collapse state, and recap-expansion accessors moved
    // into renderer/chat/renderer-render-pipeline-thread-state.js. Late-bound callbacks let
    // shouldShowThreadToggle (resolved later from threadTreeUtils) and
    // renderMessages (declared later in this closure) be referenced here
    // before their declarations.
    const threadStatePipeline = threadStatePipelineUtils.createThreadStatePipeline({
      state,
      callbacks: {
        getPaneSessionId,
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
        getPaneSessionId,
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
      getSessionId: getPaneSessionId,
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
      buildStreamingBubbleMarkup = (message) => ({ bubbleInnerHtml: renderMarkdown(message && message.content) }),
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
        jumpToBottomButton,
      },
      controllers: { thinkingIndicator, thinkingController, getRuntimeSendController: deps.controllers.getRuntimeSendController },
      runtime: { spriteRuntime },
      callbacks: {
        getPaneSessionId,
        getCurrentSessionMessages,
        getSessionMessages,
        getLatestUserMessageId,
        getLatestAssistantMessageId,
        escapeSelectorValue,
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
        renderThinkingWidget: renderPaneThinkingWidget,
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
        isPrimarySession: (id) => (globalThis.stringUtils?.isPrimarySessionId || (() => false))(state.sessions, id), // row 76: the offer card's Always-allow row
        getFeatureFlags: function readRendererFeatureFlags() {
          return (state && state.features && state.features.featureFlags) || {};
        },
        getApprovalCardState: function readApprovalCardState(ref) {
          return globalThis.rendererApprovalBlock?.resolveApprovalCardState?.(state, ref) || null;
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
        jumpToTopButton,
        jumpToBottomButton,
        stopStreamButton,
        sendButton,
        composerModelSelectShell,
        composerEffortSelectShell,
        chatTimeline,
      },
      controllers: {
        logRenderer: deps.controllers?.logRenderer || null,
        getSendOutboxActions: () => deps.controllers?.getSendOutboxActions?.(),
      },
      callbacks: {
        renderHeader: (...a) => renderHeader(...a),
        renderMessages: (...a) => renderMessages(...a),
        applySurfaceEffect: (...a) => applySurfaceEffect(...a),
        syncBackendNotice: (...a) => syncBackendNotice(...a),
        renderSettings: (...a) => renderSettings(...a),
        renderComposerCarriers: (...a) => renderComposerCarriers(...a),
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
        renderHomePanel: (...a) => renderHomePanel(...a),
        shouldRenderHomePanel: (...a) => shouldRenderHomePanel(...a),
        renderContextPanel: (...a) => renderContextPanel?.(...a),
        renderPinnedNotes: (...a) => renderPinnedNotes?.(...a),
        renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a),
        renderSessions: (...a) => renderSessions(...a),
        renderArtifactReviewPanel: (...a) => renderArtifactReviewPanel?.(...a),
        getPaneSessionId,
        isFollowingLatest,
        getVisibleSessionMessages,
        getCurrentRuntimePreferences,
        getRuntimePreferencesFromSession,
        isSendBusy,
        isSessionStreaming,
        hasPendingToolApprovalForSession,
        getPendingQuestionBatch,
        hasStalePendingQuestionBatch,
        getActivitySnapshot,
        getMostRecentActivity,
        isActivityBusy,
        applyActivityAttributes,
        renderComposerInteractivePanel,
        closeComposerPopover,
        syncComposerInputHeight,
        setComposerHoloState,
        updateComposerSafeOffset,
        renderLiveThinkingChip: (...a) => renderLiveThinkingChip(...a),
        renderComposerEnhancements,
        resolveChatSendLifecycle,
        syncStableChatSurfaceState,
        isSendPreflightPending,
        syncTurnElapsedClock,
      },
    }) || {};

    // Projection cache (Stage C1), persisted-turn hydration (C2) and projection
    // context (C3) moved into renderer/chat/renderer-render-pipeline-projection-stack.js.
    const {
      buildCanonicalTranscriptMessages, pruneToolRowProjectionSessionCaches, getCurrentProjectionContext,
      resolveVisibleTurnArticleTarget, recordTurnArticleRolloutSignal,
      clearProjectionContextCacheForSession, rekeyProjectionContextCache,
      resolveProjectionStreamingRowTarget, resolveProjectionStreamingRowId, buildProjectionStreamingRowMarkup,
      buildProjectionContext, resolveProjectedPrimaryRow, buildToolEntryInnerMarkup, resolveArticlePredictionCacheKey,
      getMessageFromCollection, deriveActionTargetMessageId, getForcedOpenStreamingMessageId,
      buildRecapExpansionSignature, invalidateProjectionStateForSession,
    } = projectionStackUtils.createProjectionStack({
      state, MESSAGE_STATUS, chatTimeline, uiRuntime, reducedMotionQuery,
      projectionCachePipelineUtils, hydrationPipelineUtils, projectionContextPipelineUtils,
      toolShellUtils, turnRowRenderer, renderMessageIndexUtils,
      projectTurnTree, projectTurnRows, projectTurn,
      getPaneSessionId, getPaneTranscriptView, appendClientLog, escapeHtml, renderToolCallBlock,
      getChatTimelineRowModelEnabled, recordChatTimelineRolloutSignal, rollbackChatTimelineRowModel,
      buildInteractiveRecapModel, isRecapExpandedForSession, resolveTurnArticleMessageId, resolveVisibleMessageDomTarget,
      buildTurnRowId, buildTurnRowListMarkup,
      buildMessageProjectionFingerprint, computeProjectionSignature, computeProjectionSignatureFromFingerprints,
      computeTurnStructureHash, computeTurnTailFingerprint,
    });

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
        getPaneSessionId,
        getPaneTranscriptView,
        isPaneSelecting,
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
        renderThinkingWidget: renderPaneThinkingWidget,
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

    // B5 long-conversation timeline virtualization (renderer-render-pipeline-virtualizer.js).
    // The active-turn-root pin probe reads through the facade; render-effects
    // writes it before each render via virtualizerFacade.setActiveTurnRoot.
    // renderEffectsPipeline is declared later and read at call time only.
    const { virtualizer, virtualizerFacade } = virtualizerPipelineUtils.createPipelineVirtualizer({
      state, timelineVirtualizerUtils, chatTimeline, chatThreadScroll, uiRuntime, scrollCoordinator, appendClientLog,
      renderMessages, getVisibleSessionMessages, getPaneSessionId,
      getRenderEffectsPipeline: () => renderEffectsPipeline,
    });

    // Aggregate teardown for the render-pipeline controller. The
    // sub-pipelines holding async resources are threadDomPipeline (its
    // ResizeObserver + pending rAF) and now the B5 virtualizer (its
    // IntersectionObserver). If future sub-pipelines (chrome,
    // render-effects, etc.) need teardown, register them here so app-level
    function disposeRenderPipeline() {
      try { streamRevealController?.dispose?.(); } catch (_e) { /* defensive */ }
      try { subagentMonitorController?.dispose?.(); } catch (_e) { /* defensive */ }
      try { disposeThreadDomPipeline?.(); } catch (_e) { /* defensive */ }
      try { renderEffectsPipeline?.dispose?.(); } catch (_e) { /* defensive */ }
      try { virtualizer?.dispose?.(); } catch (_e) { /* defensive */ }
      uiRuntime.longThreadBudgetStats = null;
      if (paneId === 0 && state.ui && typeof state.ui === 'object') { // W1-4c: pane 1's dispose leaves the shared stats
        state.ui.longThreadBudgetStats = null;
      }
      try { thinkingPipeline?.dispose?.(); } catch (_e) { /* defensive */ }
      try { surfaceStatePipeline?.dispose?.(); } catch (_e) { /* defensive */ }
      try { chromePipeline?.dispose?.(); } catch (_e) { /* defensive */ }
    }

    // Render orchestration is delegated to renderer-render-pipeline-render-effects.js; renderMessages remains in this factory.
    const renderEffectsPipeline = renderEffectsPipelineUtils.createRenderEffectsPipeline({
      state,
      dom: { chatTimeline },
      runtime: { uiRuntime },
      callbacks: {
        getPaneSessionId,
        getPaneTranscriptView,
        isPaneSelecting,
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
        getPaneSessionId,
        getPaneTranscriptView,
        isPaneSelecting,
        getCurrentVisibleMessages,
        getVisibleSessionMessages,
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
        isFollowingLatest,
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
    // Split view W3-2: one monitor per pane (renderer-render-pipeline-pane-runtime.js).
    subagentMonitorController = paneRuntimeUtils.createPaneSubagentMonitor({
      state, chatTimeline, chatThreadStage, paneId, getPaneSessionId, getSessionMessages, appendClientLog,
    });
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

    // Split view W1-4c: `callbacks.syncPaneLayout(kind)` runs first at the three
    // exported entry points (the layout controller reconciles the legacy
    // currentSessionId writers there). Internal calls stay unwrapped; absent, the
    // entry points are the bare functions.
    const syncPaneLayout = typeof deps.callbacks.syncPaneLayout === 'function' ? deps.callbacks.syncPaneLayout : null;
    const withPaneSync = (kind, render) => (syncPaneLayout
      ? function renderAfterPaneSync(...args) { syncPaneLayout(kind); return render(...args); }
      : render);

    return {
      formatSessionDate,
      formatLogTimestamp,
      formatMessageTerminalTimestamp,
      applyChatStateClasses,
      syncChatState,
      escapeSelectorValue,
      hideAssistantSprite,
      updateAssistantSpritePosition,
      renderLayout,
      renderHeader: withPaneSync('header', renderHeader),
      renderMessages: withPaneSync('messages', renderMessages),
      renderHero,
      syncBackendNotice,
      renderLogs,
      syncComposerVisualState,
      renderComposerJumpControls,
      renderComposerState,
      renderAll: withPaneSync('all', renderAll),
      applySurfaceEffect,
      syncBackendActivityFromStatus,
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
      getPaneSessionId,
      toggleThreadBranch,
      timelineVirtualizer: virtualizer,
      rebuildVirtualizer: () => virtualizerFacade.rebuild(), // after a host move (a pane the Workspace hosts)
      dispose: disposeRenderPipeline,
    };
  }
  return { createRenderPipeline, getTimelineEntryWeight };
});
