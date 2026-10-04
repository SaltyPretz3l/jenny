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
  function getTimelineEntryWeight(messages) {
    let total = 0;
    for (const message of Array.isArray(messages) ? messages : []) {
      if (!message || typeof message !== 'object') continue;
      const seen = new Set();
      const entryGroups = [message.reasoning?.entries]
        .concat((Array.isArray(message.reasoning_phases) ? message.reasoning_phases : []).map((phase) => phase?.entries));
      total = Math.min(Number.MAX_SAFE_INTEGER, total + (typeof message.content === 'string' ? message.content.length : 0));
      for (const entries of entryGroups) {
        for (const entry of Array.isArray(entries) ? entries : []) {
          if (!entry || typeof entry !== 'object' || seen.has(entry)) continue;
          seen.add(entry);
          total = Math.min(Number.MAX_SAFE_INTEGER, total + (typeof entry.text === 'string' ? entry.text.length : 0));
        }
      }
    }
    return total;
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
    const paneVisibilityUtils = resolveModule('rendererPaneVisibilityUtils', './renderer-pane-visibility-utils');
    const { state } = deps;
    const { MESSAGE_STATUS, ACTIVITY_SCOPE } = deps.constants;
    const {
      homeView, chatView, ideView, artifactsView, logsView, settingsView, homeNavButton,
      chatTimeline, chatThreadScroll,
      chatThreadColumn, chatSpriteLayer, chatAssistantSprite,
      heroAvatar, heroTitle, heroSubtitle, heroRuntimeHint, chatInput,
      stopStreamButton, sendButton, composer, composerModelSelect, composerEffortSelect,
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
      renderWorkspaceChrome, renderSettings, renderIde = noop, layoutIdeEditor = noop,
      reconcileChatDockHost = function noopReconcileChatDockHost() { return false; },
      renderArtifactReviewPanel,
      isArtifactReviewVisible = function noopArtifactReviewVisible() { return false; },
      renderContextPanel, renderPinnedNotes, renderHomePanel, shouldRenderHomePanel = function noopShouldRenderHomePanel() { return false; }, renderAttachmentTray,
      renderComposerStatusNotice, setComposerStatusNotice, clearComposerStatusNotice, renderToastViewport, renderComposerPopover, renderCommandPopover,
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
    // Split view W1-4a: the session THIS pane shows (renderer-pane-visibility-utils.js
    // resolvePaneSessionId). A bag without an integer paneId is pane 0, as in
    // createPaneRuntime; a blank layout makes pane 0 exactly currentSessionId.
    const paneId = Number.isInteger(uiRuntime?.paneId) && uiRuntime.paneId >= 0 ? uiRuntime.paneId : 0;
    const getPaneSessionId = typeof paneVisibilityUtils?.resolvePaneSessionId === 'function'
      ? () => paneVisibilityUtils.resolvePaneSessionId(state, paneId)
      : () => String(state.currentSessionId || '').trim();
    // Transcript view (answers | thinking | everything) of the session THIS pane
    // shows (renderer-transcript-view-utils.js). Threaded through render
    // options because the row builders are shared single instances and two
    // panes can show two views; absent-safe so a missing module renders
    // 'thinking', today's behaviour.
    const getPaneTranscriptView = () => {
      const utils = globalThis.rendererTranscriptViewUtils;
      return typeof utils?.resolveTranscriptView === 'function'
        ? utils.resolveTranscriptView(state, getPaneSessionId())
        : 'thinking';
    };
    // Split view W3-1: this pane renders selection chrome only while it owns the mode.
    // (renderer-chat-selection-utils.js: state.ui.selectionModePaneId, null = off).
    const isPaneSelecting = () => state.ui?.selectionModePaneId === paneId;
    // Per-session message getters, read with getPaneSessionId(); a composition
    // that injects only the current-session getters keeps working unchanged.
    const getVisibleSessionMessages = typeof _getVisibleSessionMessages === 'function'
      ? _getVisibleSessionMessages : () => (typeof getCurrentVisibleMessages === 'function' ? getCurrentVisibleMessages() : []);
    const getSessionMessages = typeof _getSessionMessages === 'function'
      ? _getSessionMessages : () => (typeof getCurrentSessionMessages === 'function' ? getCurrentSessionMessages() : []);

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
        jumpToLastPromptButton,
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
        getLatestUserMessageId,
        isSendPreflightPending,
        syncTurnElapsedClock,
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
        virtualizer.rebuild(getTimelineEntryWeight(getVisibleSessionMessages(getPaneSessionId())));
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
    const monitorDocument = chatTimeline?.ownerDocument || null;
    const monitorWindow = monitorDocument?.defaultView || null;
    // Split view W3-2: one monitor per pane, each showing its pane's session.
    // In Chat the monitor is the artifact panel's `subagents` rail mode; the
    // pane thread stage's own aside (pane 0's #subagentInspector, the
    // template's for pane 1) hosts it only in the IDE dock. A trigger belongs
    // to the pane whose root holds it (pane 0's when docked in the IDE), so the
    // two monitors' document-level listeners never both handle one click.
    const subagentInspector = chatThreadStage?.querySelector?.(':scope > [data-chat-node="subagentInspector"]') || null;
    subagentMonitorController = paneId !== 0 && !subagentInspector ? null : globalThis.rendererSubagentMonitorController?.createSubagentMonitorController?.({
      state,
      documentRef: monitorDocument,
      windowRef: monitorWindow,
      inspector: subagentInspector,
      idSuffix: paneId === 0 ? '' : `-pane${paneId}`,
      getSessionId: getPaneSessionId,
      ownsTrigger: (trigger) => {
        const paneRoot = trigger?.closest?.('.chat-pane[data-pane-id]');
        return (paneRoot ? Number(paneRoot.dataset.paneId) : 0) === paneId;
      },
      getMessages: () => getSessionMessages(getPaneSessionId()),
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
      dispose: disposeRenderPipeline,
    };
  }
  return { createRenderPipeline, getTimelineEntryWeight };
});
