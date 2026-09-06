(async () => {
  if (typeof window.__disposeRenderer === 'function') {
    await Promise.resolve(window.__disposeRenderer()).catch(() => {});
  }
  const noop = () => {}, noopAsync = async () => {}, noopNull = () => null, noopFalse = () => false;
  const noopObj = () => ({}), noopArr = () => [], noopStr = () => '';
  const rendererCleanupFns = [];
  let rendererDisposed = false;

  function registerRendererCleanup(cleanup) {
    if (typeof cleanup !== 'function') {
      return cleanup;
    }
    rendererCleanupFns.push(cleanup);
    return cleanup;
  }

  async function disposeRenderer() {
    if (rendererDisposed) {
      return;
    }
    rendererDisposed = true;
    while (rendererCleanupFns.length) {
      const cleanup = rendererCleanupFns.pop();
      try {
        await cleanup();
      } catch (error) {
        // Best-effort teardown keeps renderer rebootstrap resilient.
      }
    }
    if (window.__disposeRenderer === disposeRenderer) {
      window.__disposeRenderer = null;
    }
  }

  window.__disposeRenderer = disposeRenderer;
  const _fb = window.rendererFallbackRegistry?.buildFallbacks(window) || {};
  const _workspaceFallbacks = window.rendererFallbackWorkspaceRegistry?.buildFallbacks(window) || {};
  const workspaceStateUtils = window.rendererWorkspaceStateUtils || _workspaceFallbacks.workspaceStateUtils || {};
  const workspaceChromeUtils = window.rendererWorkspaceChromeUtils || _workspaceFallbacks.workspaceChromeUtils || {};
  const {
    normalizeChatMessage, normalizeChatMessages, buildAssistantMetaLabel, mergeReasoningEntries,
    getLatestAssistantMessageId, MESSAGE_STATUS, MAX_INTERACTIVE_QUESTIONS, MAX_INTERACTIVE_ROUNDS,
    INTERACTIVE_SEQUENCE_IDLE, INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE, INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
    INTERACTIVE_GUARDRAIL_PROMPT, buildMessageActionModel, getElaboratePrompt, getLatestReplyAssistantMessageId,
    resolveRegenerateRequest, INTERACTIVE_OTHER_OPTION_ID, getInteractiveComposerStatusNotice,
    getInteractiveQuestionOptions, isInteractiveOtherTrigger, isInteractiveQuestionAnswered,
    areInteractiveQuestionsAnswered, getInteractiveNextUnansweredIndex, ThinkingPanelController,
    groupReasoningByPhase,
    getThinkingSummary, shouldShowThinkingToggle, getLatestUserMessageId, isChatNearBottom,
    deriveFollowLatestFromScroll, shouldAutoScrollThread, formatTokenUsageDisplay,
    normalizeReasoningEffort, resolveComposerModelSelectWidth, appearanceUtils,
    getDefaultAppearancePreferences, normalizeAppearancePreferences, getPalettePresets,
    getTypographyPresets, getSurfaceEffectPresets, getFontScalePresets: rawGetFontScalePresets, applyAppearanceToDocument, loadStoredAppearancePreferences,
    saveStoredAppearancePreferences,
    toolCallUtils, transcriptUtils, composerHoloUtils, sessionUtils,
    streamHandlerUtils, sendUtils, interactivePanelUtils, personalityEditorUtils, toastControllerUtils,
    settingsRendererUtils, sidebarControllerUtils, lifecycleUtils, memoryManagerUtils, viewportUtils,
    artifactsUtils, activityPrefsUtils, renderPipelineUtils, lifecycleProgressUtils,
    buildPersonalityStatusTextModel, resolvePreferredPersonalityTab,
    beginActivity, clearActivity, failActivity, getActivitySnapshot, getMostRecentActivity,
    resolveActivity, setActivityChangeListener, applyActivityAttributes, isActivityBusy,
    createToastStore, buildLogViewModel,
  } = _fb;
  const getFontScalePresets = typeof rawGetFontScalePresets === 'function'
    ? rawGetFontScalePresets
    : (typeof appearanceUtils?.getFontScalePresets === 'function' ? appearanceUtils.getFontScalePresets.bind(appearanceUtils) : noopArr);
  const chatZoomUtils = window.chatZoomUtils || {};
  const cometOverlayPresenceUtils = window.rendererCometOverlayPresenceUtils || {};
  const cometPresenceArbiterUtils = window.rendererCometPresenceArbiter || {};
  const {
    DEFAULT_CHAT_ZOOM_PERCENT = 100,
    getChatZoomOptions = noopArr,
    isDefaultChatZoomPercent = (value) => Number(value) === 100,
    normalizeChatZoomPercent = (value) => Number(value) || 100,
    applyChatZoomToDocument = (_doc, value) => normalizeChatZoomPercent(value),
    stepChatZoomPercent = (currentPercent, _direction) => normalizeChatZoomPercent(currentPercent),
  } = chatZoomUtils;
  const rendererBootstrap = window.rendererBootstrapUtils.createRendererBootstrap({ document, getDefaultAppearancePreferences, appearanceUtils });
  const { staticModel, ACTIVITY_SCOPE, TOAST_SOURCE, state, surfaceDom, lazyDom } = rendererBootstrap;
  let settingsShellController = null;
  let chatShellController = null;
  const openSettingsSection = (...args) =>
    settingsShellController?.navigateSettingsSection?.(...args)
    || settingsShellController?.openSettingsSection?.(...args);
  const {
    workspace, workspaceRailShell, homeNavButton, metricList, conversationGroups, conversationCount,
    promptGrid, homeView,
    homeOpenLoopCount, homeOpenLoopStatus, homeOpenLoopList,
    chatView, ideView, logsView, settingsView, heroStack,
    chatSurfaceEffects, chatSurfaceEffectLeft,
    chatThreadStage, chatSurface, chatThreadScroll, chatThreadColumn, chatSpriteLayer, chatAssistantSprite,
    chatTimeline, attachmentTray, attachmentNotice,
    composerStatusNotice, chatInput,
    newChatButton, stopStreamButton, sendButton,
    composerAttachShortcut, composerTerminalShortcut, searchInput,
    sidebarResizer, heroAvatar, heroTitle, heroSubtitle,
    heroRuntimeHint,
    composerOfflineLabel, composerContextUsageSlot, composerPlanUsageSlot, composerToolToggleSlot,
    toastViewport, sessionActionButton, logLevelFilter, logList,
    logResultsLabel, logSearchInput, logSourceFilter, copyLogsReportButton, logAutoScrollToggle,
    observabilityRefreshButton, toolLatencyTable, slowOperationsList, recentTracesList,
    modelBadge, composerModelSelect, composerEffortSelect, composerSettingsButton,
    jumpToTopButton, jumpToLastPromptButton, jumpToBottomButton, composerSettingsPopover, composerCommandPopover,
    composerCommandPopoverList,
    commandPaletteOverlay, commandPaletteInput, commandPaletteList, titlebarPalettePill,
    attachFilesButton, captureScreenButton, openComposerSettingsViewButton, composerChatZoomSelect, composerChatZoomStatus,
    settingsAdvancedToggle, settingsAdvancedItems,
    settingsModelCard, composerModelSelectShell,
    composerEffortSelectShell, appearanceBadge, appearanceThemeBundleSelect, appearancePaletteSelect, appearanceTypographySelect,
    appearanceSurfaceEffectSelect, appearanceHoloList, appearanceResetButton, appearanceStatus,
    modelStatus,
    offlineBadge, offlineSummary, offlineStatus,
    contextBadge, contextStatus, contextHistoryScopeSelect, contextSourcesList, contextRuntimeList,
    toolsWorkspacePath, toolsWorkspaceStatus, toolsWorkspaceChooseButton, toolsSummary,
    contextPreview,
    skillsSettingsNavItem, skillsSettingsSection,
    artifactsSessionTitle,
    artifactsSessionMeta, artifactsStatus, artifactsFilterBar, artifactsList,
    artifactsDetailEmpty, artifactsDetailPanel, artifactsDetailKicker, artifactsDetailTitle,
    artifactsDetailPath, artifactsDetailStatus, artifactsDetailMeta, artifactsDetailNote,
    artifactsPreviewContent, artifactsEditorShell, artifactsEditorHost, artifactsEditorFallback,
    artifactsSaveButton, artifactsRevertButton, artifactsRevealButton, artifactsOpenExternalButton,
    artifactsJumpButton, artifactsDeleteButton, artifactsMetaPane, artifactsProvenanceTimeline,
    harnessBadge, harnessSummary, harnessStatus, harnessRuntimeList, harnessToolList, harnessMemoryList,
    harnessSkillsList, harnessShellList, accountBadge, accountSummary, backendSummary,
    localProfileSettingsMount, titlebar, sidebar, composer, composerHolo,
    composerHoloContext, chatSpriteHolo, chatSpriteHoloContext, composerWrap,
    workbenchHealthPillSlot,
    chatOriginChip, chatOriginLabel,
    artifactSplitViewToggle, artifactReviewResizer, artifactReviewPanel, artifactReviewStatus,
    artifactReviewCollapseButton, artifactReviewDetailEmpty,
    artifactReviewDetailPanel, artifactReviewDetailKicker, artifactReviewDetailTitle,
    artifactReviewDetailPath, artifactReviewDetailStatus, artifactReviewDetailMeta,
    artifactReviewDetailNote, artifactReviewPreviewContent, artifactReviewEditorShell,
    artifactReviewEditorHost, artifactReviewEditorFallback, artifactReviewSaveButton,
    artifactReviewRevertButton, artifactReviewRevealButton, artifactReviewOpenExternalButton,
    artifactReviewJumpButton, artifactReviewDeleteButton, artifactReviewProvenanceTimeline,
    chatContextPanel, contextArtifactList, contextPulse, contextSessionLogs, contextPanelToggle, contextArtifactExpand,
  } = rendererBootstrap.dom;
  const {
    APPEARANCE_STORAGE_KEY, SIDEBAR_STORAGE_KEY,
    SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH,
    SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MAIN_STAGE_MIN_WIDTH, SIDEBAR_KEYBOARD_STEP,
  } = rendererBootstrap.constants;
  const CHAT_TIMELINE_BATCH4_STORAGE_KEY = 'jenny.chatTimelineBatch4FastPath.v1';
  const REASONING_PHASE_EXPANSION_STORAGE_KEY = 'jenny.reasoningPhaseExpansionBySession.v1';
  const toastStore = createToastStore({ maxVisible: 4 });
  const toastActionHandlers = new Map();
  registerRendererCleanup(toastStore.subscribe(() => { renderToastViewport(); }));
  if (typeof window.__jennyTestHooks?.captureRendererState === 'function') {
    window.__jennyTestHooks.captureRendererState(state);
  }
  if (typeof window.rendererAgentHooks?.installAgentTestHooks === 'function') {
    registerRendererCleanup(window.rendererAgentHooks.installAgentTestHooks({ window, state }));
  }
  state.harness = { snapshot: null, loading: false, error: '', loadedAt: 0, agentActions: null };
  state.phasePercentiles = { payload: null, loading: false, error: '', loadedAt: 0, revision: 0 };
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const appLifecyclePreferenceUtils = window.rendererAppLifecyclePreferences || {};
  const chatSendLifecycleController = appLifecyclePreferenceUtils.createChatSendLifecycleController({ state });
  const {
    CHAT_SEND_LIFECYCLE,
    clearChatSendLifecycle,
    getChatSendLifecycle,
    moveChatSendLifecycle,
    setChatSendLifecycle,
  } = chatSendLifecycleController;
  const reasoningPhaseExpansionController = appLifecyclePreferenceUtils.createReasoningPhaseExpansionController({
    state,
    storage: window.localStorage,
    storageKey: REASONING_PHASE_EXPANSION_STORAGE_KEY,
    getThinkingController: () => thinkingController,
  });
  state.ui.reasoningPhaseExpansionBySession = reasoningPhaseExpansionController.loadReasoningPhaseExpansionPreferences();
  const {
    saveReasoningPhaseExpansionPreferences,
    setReasoningPhaseExpandedPreference,
    setReasoningPhaseExpandedPreferences,
    syncPersistedReasoningPhaseExpansionState,
  } = reasoningPhaseExpansionController;

  const startupAuditRuntime = appLifecyclePreferenceUtils.createStartupAuditRuntime({
    windowRef: window,
    state,
    dom: { chatInput, composerEffortSelect, composerModelSelect },
    callbacks: {
      normalizeReasoningEffort,
      renderComposerState: (...a) => renderComposerState(...a),
      startPromptSend: (...a) => startPromptSend(...a),
      syncComposerInputHeight: (...a) => syncComposerInputHeight(...a),
      syncComposerVisualState: (...a) => syncComposerVisualState(...a),
    },
  });
  const {
    markStartupAudit,
    runStartupAuditAutoSend,
    signalRendererReadyOnce,
  } = startupAuditRuntime;
  const uiRuntime = {};
  const spriteRuntime = { frameHandle: 0, targetMessageId: '', visible: false, streaming: false, currentY: 0, targetY: 0 };
  const composerHoloRuntime = {
    active: false, mode: 'idle', angle: 0, frameHandle: 0, lastFrame: 0,
    pixelRatio: 1, cssWidth: 0, cssHeight: 0, resizeObserver: null,
    supported: Boolean(composerHoloContext && typeof composerHoloContext.createConicGradient === 'function'),
  };
  const spriteHoloRuntime = {
    active: false, mode: 'idle', angle: 0, frameHandle: 0, lastFrame: 0,
    pixelRatio: 1, cssWidth: 0, cssHeight: 0, resizeObserver: null,
    supported: Boolean(chatSpriteHoloContext && typeof chatSpriteHoloContext.createConicGradient === 'function'),
  };
  const sidebarRuntime = { resizePointerId: null, startX: 0, startWidth: SIDEBAR_DEFAULT_WIDTH };
  const cometRuntime = window.rendererAppCometRuntime.createCometRuntime({
    state,
    windowRef: window,
    reducedMotionQuery,
    dom: { workspace, chatSpriteLayer, chatAssistantSprite, chatInput, chatThreadScroll },
    modules: {
      cometModule: window.cometModule,
      overlayPresenceUtils: cometOverlayPresenceUtils,
      presenceArbiterUtils: cometPresenceArbiterUtils,
    },
    callbacks: {
      appendClientLog: (...a) => appendClientLog(...a),
      inferSentimentFromText:
        window.cometSentimentUtils?.inferSentimentFromText
        || (() => ({ sentiment: 'neutral', expression: 'idle' })),
      refreshFeatureState: (...a) => refreshFeatureState(...a),
    },
  });
  const {
    activateCometIfEnabled: _activateCometIfEnabled,
    ensureComposerFeatureStateLoaded: _ensureComposerFeatureStateLoaded,
    handleCometOverlayToggleChange,
    handlePresenceStreamEvent,
    setFaceReaction,
    submitCometIndicatorState,
    submitCometUserAction,
    disposeCometPersonality,
  } = cometRuntime;
  // Living Atlas seam (WORKSPACE_FILE_MAP atlas plan, W3): ONE shared
  // activity bus ingests the same stream payloads as Comet presence above
  // (handleWorkspaceActivityStreamEvent mirrors handlePresenceStreamEvent).
  // Stashed on state.workspaceActivityBus so the IDE controller chain — which
  // already threads the shared `state` object to every layer — can hand it
  // to the map controller without adding a new explicit param at each layer.
  // getRootPath reads state.workspaceRoot.path: the canonical ABSOLUTE root
  // path (WIDE-030's state.workspaceRoot.rootId is a hash, not a path; .path
  // is the raw workspaceRootStatus source string set by
  // applyWorkspaceRootStatePayload in renderer-shell-state-runtime-utils.js).
  const workspaceActivityBus = (window.rendererIdeMapActivityBus || {}).createMapActivityBus?.({
    getRootPath: () => String(state.workspaceRoot?.path || ''),
  }) || null;
  state.workspaceActivityBus = workspaceActivityBus;
  function handleWorkspaceActivityStreamEvent(rawPayload) {
    // Flags hydrate late (post-boot fetch): gate PER EVENT, not once at wiring
    // time, so a flag flip mid-session takes effect immediately and flag-off
    // keeps the bus at zero accumulated state.
    if (state.features?.featureFlags?.workspace_file_map !== true) return;
    workspaceActivityBus?.ingest(rawPayload);
  }
  const thinkingController = new ThinkingPanelController();
  let renderLiveThinkingChip = noop;
  let updateAssistantSpritePositionRef = noop;
  let thinkingIndicatorRenderFrame = 0;
  function queueLiveThinkingChipRender() {
    if (rendererDisposed || thinkingIndicatorRenderFrame) {
      return;
    }
    thinkingIndicatorRenderFrame = window.requestAnimationFrame(() => {
      thinkingIndicatorRenderFrame = 0;
      updateAssistantSpritePositionRef();
      renderLiveThinkingChip();
    });
  }
  const thinkingIndicatorUtils = window.rendererThinkingIndicatorUtils || {};
  const thinkingIndicator = typeof thinkingIndicatorUtils.createThinkingIndicator === 'function'
    ? thinkingIndicatorUtils.createThinkingIndicator({
      onStateChange: () => {
        queueLiveThinkingChipRender();
        /* forward thinking indicator state to comet personality (no-op if comet not active) */
        const ds = thinkingIndicator?.getDisplayState?.();
        submitCometIndicatorState(ds);
      },
    })
    : null;
  let _applySidebarLayout = noop;
  let workspaceStateController;
  let workspaceChromeController;

  state.ui.osReducedMotion = reducedMotionQuery.matches;
  let resolveSurfaceActivityPhaseRef = null;
  const surfaceEffectManager = window.rendererAppSurfaceEffects.createSurfaceEffectManager({
    state,
    windowRef: window,
    documentRef: document,
    factories: {
      'reactive-grid': window.rendererReactiveGridUtils?.createReactiveGridController,
      'playlist-scroll': window.rendererPlaylistScrollUtils?.createPlaylistScrollController,
      'atomic-burst': window.rendererAtomicBurstUtils?.createAtomicBurstController,
      'circuit-trace': window.rendererCircuitTraceUtils?.createCircuitTraceController,
      'context-weave': window.rendererContextWeaveUtils?.createContextWeaveController,
    },
    options: { reducedMotionQuery },
    // Both gutters + homeView are first-class input surfaces (Rev 2 §3.3).
    dom: { chatView, homeView, chatSurfaceEffects, chatSurfaceEffectLeft },
    callbacks: {
      appendClientLog: (...args) => appendClientLog(...args), isDisposed: () => rendererDisposed,
      registerCleanup: registerRendererCleanup, getEffectRegistry: () => getSurfaceEffectPresets(),
      resolveActivityPhase: (sessionId) => (resolveSurfaceActivityPhaseRef ? resolveSurfaceActivityPhaseRef(sessionId) : 'idle'),
    },
  });
  const {
    SURFACE_EFFECT_STAGES, activateSurfaceEffect,
    logSurfaceEffectFailure: _logSurfaceEffectFailure, refreshActiveSurfaceEffect,
  } = surfaceEffectManager;
  /* surfaceEffectGallery — dev-only, nav-unlinked; defers its window global until the async flag reads true */
  window.rendererSurfaceGalleryUtils?.installSurfaceEffectGallery?.({
    windowRef: window, documentRef: document, reducedMotionQuery, registerCleanup: registerRendererCleanup,
    getEffectRegistry: () => getSurfaceEffectPresets(), isEnabled: () => state.features?.featureFlags?.surface_effect_gallery === true,
  });
  /* composerHoloController */
  const composerHoloController = composerHoloUtils.createComposerHoloController?.({
    composer, composerHolo, composerHoloContext, composerHoloRuntime, reducedMotionQuery,
  }) || null;
  const {
    initializeComposerHolo = noop, setComposerHoloState = noop,
    disposeComposerHolo = noop,
  } = composerHoloController || {};
  /* spriteHoloController — same controller, parameterized for sprite element */
  const spriteHoloController = (chatAssistantSprite && composerHoloUtils.createComposerHoloController)
    ? composerHoloUtils.createComposerHoloController({
        composer: chatAssistantSprite,
        composerHolo: chatSpriteHolo,
        composerHoloContext: chatSpriteHoloContext,
        composerHoloRuntime: spriteHoloRuntime,
        reducedMotionQuery,
        cssVarPrefix: 'sprite-holo',
      })
    : null;
  const {
    initializeComposerHolo: initializeSpriteHolo = noop,
    setComposerHoloState: setSpriteHoloState = noop,
    disposeComposerHolo: disposeSpriteHolo = noop,
  } = spriteHoloController || {};
  let renderSettings = noop;
  let renderComposerPopover = noop;
  let renderCommandPopover = noop;
  let syncComposerInputHeight = noop;
  let syncComposerModelSelectWidth = noop;
  let flushPendingStreamCommitsForSession = () => ({ flushedCount: 0, catchupRequired: false });
  let rehydrateSessionFromPersistedTurnEvents = () => null;
  let applySurfaceEffect = noop;
  let formatLogTimestamp = () => '--';
  let refreshSuggestions = noopAsync;
  let handleCreateSessionWithWorkspace = noopAsync;
  let syncBackendActivityFromStatus = noop;
  const lifecycleComposition = await window.rendererAppLifecycleComposition.createLifecycleComposition({
    window, document, globalThis, noop, noopAsync, noopNull, noopFalse, noopObj, noopArr, noopStr,
    state, sidebarRuntime, surfaceDom, lazyDom, lifecycleUtils, appLifecyclePreferenceUtils,
    fileDiffBindings: window.rendererFileDiffBindings || {}, codeHighlight: window.rendererCodeHighlight || {},
    monacoEditorUtils: window.rendererMonacoEditorUtils || {},
    personalityEditorUtils, memoryManagerUtils, viewportUtils, transcriptUtils, toolCallUtils, interactivePanelUtils,
    toastControllerUtils, artifactsUtils, sessionUtils, sidebarControllerUtils, workspaceStateUtils,
    workspaceChromeUtils, appearanceUtils, renderPipelineUtils, SIDEBAR_STORAGE_KEY,
    SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MAIN_STAGE_MIN_WIDTH,
    SIDEBAR_KEYBOARD_STEP,
    APPEARANCE_STORAGE_KEY,
    CHAT_TIMELINE_BATCH4_STORAGE_KEY, DEFAULT_CHAT_ZOOM_PERCENT,
    MESSAGE_STATUS, MAX_INTERACTIVE_QUESTIONS, MAX_INTERACTIVE_ROUNDS, TOAST_SOURCE, ACTIVITY_SCOPE,
    normalizeChatMessage, normalizeChatMessages, getLatestUserMessageId, getInteractiveQuestionOptions,
    isInteractiveQuestionAnswered, areInteractiveQuestionsAnswered, isInteractiveOtherTrigger, formatTokenUsageDisplay,
    INTERACTIVE_SEQUENCE_IDLE, INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE, INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
    get settingsShellController() { return settingsShellController; },
    get chatShellController() { return chatShellController; },
    getChatWayfinderController: () => chatWayfinderController,
    renderComposerJumpControls: (...a) => renderComposerJumpControls(...a),
    registerRendererCleanup,
    renderSettings: (...a) => renderSettings(...a), renderComposerPopover: (...a) => renderComposerPopover(...a),
    renderCommandPopover: (...a) => renderCommandPopover(...a), syncComposerInputHeight,
    syncComposerModelSelectWidth,
    thinkingController, reducedMotionQuery, toastStore, toastActionHandlers, renderAll: (...a) => renderAll(...a),
    renderLayout: (...a) => renderLayout(...a), renderHeader: (...a) => renderHeader(...a),
    renderLogs: (...a) => renderLogs(...a), renderPrompts: (...a) => renderPrompts(...a),
    renderComposerState: (...a) => renderComposerState(...a), syncBackendNotice: (...a) => syncBackendNotice(...a),
    renderMessages: (...a) => renderMessages(...a), renderIdeSafe: (...a) => renderIdeSafe(...a),
    activateIdeSafe: (...a) => activateIdeSafe(...a), layoutIdeEditorSafe: (...a) => layoutIdeEditorSafe(...a),
    renderHomePanelSafe: (...a) => renderHomePanelSafe(...a),
    renderSessions: (...a) => renderSessions(...a), getCurrentVisibleMessages: (...a) => getCurrentVisibleMessages(...a),
    saveReasoningPhaseExpansionPreferences,
    getCurrentSessionMessages: (...a) => getCurrentSessionMessages(...a), getSessionMessages: (...a) => getSessionMessages(...a),
    setSessionMessages: (...a) => setSessionMessages(...a), setSessionTurnEventState: (...a) => setSessionTurnEventState(...a),
    scrollThreadToTop: (...a) => scrollThreadToTop(...a), scrollThreadToBottom: (...a) => scrollThreadToBottom(...a),
    scrollMessageIntoView: (...a) => scrollMessageIntoView(...a), isSendBusy: (...a) => isSendBusy(...a),
    isAnySendBusy: (...a) => isAnySendBusy(...a), setFollowLatest: (...a) => setFollowLatest(...a),
    getPendingQuestionBatch: (...a) => getPendingQuestionBatch(...a), clearInteractiveDraft: (...a) => clearInteractiveDraft(...a),
    getScrollMetrics: (...a) => getScrollMetrics(...a), createNormalizedMessage: (...a) => createNormalizedMessage(...a),
    upsertSessionSummary: (...a) => upsertSessionSummary(...a), removeSessionState: (...a) => removeSessionState(...a),
    refreshActiveSurfaceEffect: (...a) => refreshActiveSurfaceEffect(...a), activateSurfaceEffect: (...a) => activateSurfaceEffect(...a),
    applySurfaceEffect: (...a) => applySurfaceEffect(...a), flushPendingStreamCommitsForSession: (...a) => flushPendingStreamCommitsForSession(...a),
    clearProjectionContextCacheForSession: (...a) => clearProjectionContextCacheForSession(...a),
    rehydrateSessionFromPersistedTurnEvents: (...a) => rehydrateSessionFromPersistedTurnEvents(...a),
    initializeComposerHolo, initializeSpriteHolo,
    _applySidebarLayout, hideAssistantSprite: (...a) => hideAssistantSprite(...a), updateAssistantSpritePosition: (...a) => updateAssistantSpritePosition(...a),
    setSidebarCollapsed: (...a) => setSidebarCollapsed(...a),
    invalidateSessionArtifacts: (...a) => invalidateSessionArtifacts(...a),
    pruneSessionArtifacts: (...a) => pruneSessionArtifacts(...a), resetArtifactsState: (...a) => resetArtifactsState(...a),
    handleCometOverlayToggleChange, getDefaultAppearancePreferences, normalizeAppearancePreferences, applyAppearanceToDocument,
    normalizeReasoningEffort, loadStoredAppearancePreferences, normalizeChatZoomPercent, applyChatZoomToDocument,
    saveStoredAppearancePreferences, stepChatZoomPercent, buildMessageActionModel, buildPersonalityStatusTextModel,
    resolvePreferredPersonalityTab, composerOfflineLabel,
    conversationGroups, conversationCount, searchInput,
    attachmentTray, attachmentNotice,
    homeView, chatInput, composer,
    chatView, chatSurfaceEffects, chatSurfaceEffectLeft, chatThreadStage,
    chatThreadColumn, composerWrap, chatTimeline, chatThreadScroll, workspace, sidebar, sidebarResizer,
    artifactReviewPanel, getThinkingSummary, shouldShowThinkingToggle, groupReasoningByPhase,
    mergeReasoningEntries, deriveFollowLatestFromScroll, shouldAutoScrollThread, uiRuntime,
    getCurrentRuntimePreferences: (...a) => getCurrentRuntimePreferences(...a), handleCreateSessionWithWorkspace: (...a) => handleCreateSessionWithWorkspace(...a),
    setSessionOrigin: (...a) => setSessionOrigin(...a), setPendingOrigin: (...a) => setPendingOrigin(...a),
    clearPendingOrigin: (...a) => clearPendingOrigin(...a), dismissToast: (...a) => dismissToast(...a),
    beginActivity, resolveActivity, failActivity, clearActivity, getActivitySnapshot, getMostRecentActivity, isActivityBusy,
    applyActivityAttributes, renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a), syncWorkspaceFromStore: (...a) => syncWorkspaceFromStore(...a),
    activateWorkspaceSession: (...a) => activateWorkspaceSession(...a), openSession: (...a) => openSession(...a),
    loadSessions: (...a) => loadSessions(...a), refreshSuggestions: (...a) => refreshSuggestions(...a),
    applyWorkspaceSnapshot: (...a) => applyWorkspaceSnapshot(...a), openSettingsSection: (...a) => openSettingsSection(...a),
    getCurrentMessageById: (...a) => getCurrentMessageById(...a), setActiveView: (...a) => setActiveView(...a),
  });
  let chatWayfinderController = lifecycleComposition.chatWayfinderController || null;
  let clearProjectionContextCacheForSession = lifecycleComposition.clearProjectionContextCacheForSession || noopFalse;
  let rekeyProjectionContextCache = lifecycleComposition.rekeyProjectionContextCache || noopStr;
  workspaceStateController = lifecycleComposition.workspaceStateController || null;
  workspaceChromeController = lifecycleComposition.workspaceChromeController || null;
  const {
    lifecycleController, escapeHtml, getSessionMonogram, normalizeModelToken, getActiveSession,
    getRuntimePreferencesFromSession, getCurrentRuntimePreferences, patchSessionSummary, syncRuntimeDraftFromActiveSession,
    buildModelOptionMarkup, loadAppearancePreferences, adjustChatZoomPercent, applyChatZoomPercent,
    resetChatZoomPercent, appendClientLog: lifecycleAppendClientLog = noop, getRendererElapsedMs, noteFirstRenderComplete, runDeferredVisualStartup,
    scheduleDeferredVisualStartup, pushIncomingLog, resetLogsViewState, setActiveView, saveAppearancePreferences, applyAppearancePreferences,
    isDefaultAppearancePreferences, buildSelectOptionMarkup, attachGlobalErrorBoundary, detachGlobalErrorBoundary,
    getChatTimelineRowModelEnabled,
    recordChatTimelineRolloutSignal, refreshDefaultChatTimelineBatch4Preference,
    rollbackChatTimelineRowModel, initializeEagerServices, applyFeatureStatePayload,
    refreshFeatureState, refreshWorkspaceRootState, refreshPhasePercentiles, resetPhasePercentiles,
    hydrateCachedLazyShellState, queueStartupLazyHydration, handleWorkspaceRootChoose,
    getPersonalityActiveFileSafe, setPersonalityDraftSafe, refreshPersonalityWorkspaceSafe, renderPersonalityEditorSafe,
    handlePersonalityTabChangeSafe, handlePersonalitySaveSafe, handlePersonalityResetSafe,
    handlePersonalityOpenFolderSafe,
    hasPersonalityUnsavedChangesSafe, refreshMemoryContextFilesSafe, renderMemoryContextFilesSafe,
    loadMemoryContextFileSafe, setMemoryContextDraftSafe, getMemoryContextActiveFileSafe,
    saveMemoryContextFileSafe, resetMemoryContextFileSafe, hasMemoryContextUnsavedChangesSafe,
    refreshProactiveStateSafe,
    handleUseProactiveSuggestionMessageSafe, refreshSkillsStateSafe,
    renderSkillsManagerSafe, updateSkillsSettingsSafe, openSkillsScopeFolderSafe, bindSkillsShellEventsSafe,
    refreshTipsStateSafe, bindTipsShellEventsSafe, refreshOfflineStateSafe,
    renderOfflineManagerSafe, bindOfflineShellEventsSafe, handleOfflineModeChangeSafe,
    refreshApprovedMemoriesSafe, refreshPendingMemoriesSafe, refreshMemoryStatusSafe,
    renderApprovedMemoryManagerSafe, maybeSuggestMemoryCaptureSafe,
    handleApprovedMemorySaveSafe, handleApprovedMemoryDeleteSafe, upsertApprovedMemoryDraftSafe,
    renderIdeSafe, activateIdeSafe, layoutIdeEditorSafe, reconcileChatDockHostSafe, openIdeChangeDiffSafe, openIdeFileAtLineSafe, getIdeCommandItemsSafe, openIdeHelpOverlaySafe,
    clearApprovedMemoryDraftSafe, getApprovedMemoryByIdSafe, hasApprovedMemoryDraftChangesSafe, clearDismissedMemorySessionSafe,
    rekeyDismissedMemorySessionSafe, resetMemorySuggestionStateSafe, refreshCompanionStateSafe, shouldRenderHomePanelSafe,
    renderHomePanelSafe, applyCompanionPayload, getAvailableCompanionDeferPresets, initSetupControllerSafe,
    refreshSetupStateSafe, applySetupBackendStatusSafe, openSetupTileSafe, showSetupFromSettingsSafe,
    showSetupHelpSafe, showFactoryResetSafe, handleRunSetupAgain, buildAttachmentBudget,
    summarizeAttachmentPreparation, buildAttachmentToastMessage, setAttachmentNotice, clearAttachmentNotice,
    setComposerStatusNotice, clearComposerStatusNotice, getActiveSendPreflight, isSendPreflightPending,
    getActiveStreamSessionId, isAnySendBusy, isSessionStreaming, hasPendingToolApprovalForSession, isSendBusy,
    enqueueToast,
    registerToastActions, dismissToast, renderToastViewport, showToastMessage, showShellErrorToast, toErrorMessage,
    showSessionActionError, showComposerActionError, reportErrorWhenActive, errorCenterStore, shellStatusController, getRuntimePreferenceSnapshot,
    renderComposerStatusNotice, handleActivityChange, runRuntimePreferenceActivity, persistRuntimePreferences,
    syncBackendNotice, retryBackendStart, _handleLifecycleProgress, _handleLifecycleBackendStatus, beginModelSwitch, updateModelSwitch,
    failModelSwitch, publishLifecycleStatus, setTurnStatusPill, clearTurnStatusPill, clearTurnStatusPillSources,
    renderTurnStatusPill, renderMessageAttachments, buildInteractiveRecapViewModel, renderInteractiveRoundRecap,
    renderMessageHoverRow, renderAgentStatusWidget, renderAssistantFailureNotice, renderContextCompactedNotice,
    renderThinkingWidget, renderToolCallBlock, setToolCallExpansion, renderProactiveSuggestionBlock, renderSlashCommandOutput,
    interactivePanelController, queueInteractiveComposerFocus, flushInteractiveComposerFocus, renderComposerInteractivePanel,
    clearStalledTimer, viewportController, chatScrollCoordinator, composerLayoutRuntime, getReasoningEntries, mergeMessageReasoning,
    getScrollMetrics, getScrollBehavior, setFollowLatest, syncThreadScrollState, getComposerSafeOffset,
    measureComposerSafeOffset, updateComposerSafeOffset, initializeComposerLayoutObserver, scrollThreadToTop,
    scrollThreadToBottom, scrollMessageIntoView, getCurrentMessageById, isInteractiveRoundRecapExpanded,
    pruneInteractiveRoundRecapExpansionState, toggleInteractiveRoundRecap, clearCopyFeedback, showCopyFeedback,
    syncRenderedThinkingPanels, syncThinkingBlockNode, scheduleMessageViewportSync, disposeViewportController,
    pinToTopController, buildArtifactsFromMessages, shellArtifactBridge, getArtifactsForSession, selectArtifact,
    invalidateSessionArtifacts, pruneSessionArtifacts, resetArtifactsState,
    isArtifactReviewVisible, renderArtifactReviewPanelSafe, openArtifactTarget,
    syncArtifactReviewLayout, openCodeReviewTarget, openFilePreviewTarget, contextPanelController, sessionManager, getSessionMessages,
    setSessionMessages, getSessionTurnEventState, setSessionTurnEventState, getCurrentSessionMessages,
    getVisibleSessionMessages, getCurrentVisibleMessages, createNormalizedMessage, resolveSessionId,
    normalizePendingQuestionBatch, getPendingQuestionBatch, getInteractiveSequenceState,
    hasStalePendingQuestionBatch, clearStalePendingQuestionBatch, clearInteractiveDraft, ensureInteractiveDraft,
    getInteractiveDraft, buildInteractiveQuestionBatchSummary, buildInteractiveQuestionBatchVisibleText,
    shouldForceInteractiveGuardrail, buildInteractiveSelectedAnswers, buildInteractiveAnswerPrompt,
    getTokenCountedMessages, estimateTokens, upsertSessionSummary,
    removeSessionState, rekeySessionState,
    sidebarController, chatsPanelController, updateTokenDisplay, renderAttachmentTray, renderSessions, setSidebarCollapsed,
    resetSidebarWidth, loadMoreChats, setRovingChatSession, toggleChatsScope, handleSidebarResizeStart, handleSidebarResizeMove,
    finishSidebarResize, handleSidebarResizeKeydown, multiStreamController, workspaceSessionCoordinator,
    syncWorkspaceFromStore, applyWorkspaceSnapshot, activateWorkspaceSession, closeWorkspaceSession,
    reorderWorkspaceSession, closeOtherWorkspaceSessions, closeWorkspaceSessionsToRight, closeAllWorkspaceSessions,
    renderWorkspaceSidebarBadges, handleLinkedSessionPopover, renderWorkspaceChrome, handleWorkspaceShortcut,
  } = lifecycleComposition;
  const appendClientLog = (...a) => lifecycleAppendClientLog(...a);
  resolveSurfaceActivityPhaseRef = window.rendererSurfaceActivityResolver?.createSurfaceActivityResolver?.({
    getChatSendLifecycle, isSendPreflightPending, isSessionStreaming, hasPendingToolApprovalForSession,
    getCurrentSessionId: () => state.currentSessionId,
  })?.resolveSurfaceActivityPhase || null;
  /* surfaceActivityWiring — production activity/impulse sources (Rev 2 §3.2.5, S5) */
  const {
    onChatLifecycleSurfaceSync: onSurfaceLifecycleSync, publishFirstTokenImpulse, publishToolStartImpulse, publishCompleteImpulse, publishCancelImpulse,
  } = window.rendererAppSurfaceActivityWiring.createSurfaceActivityWiring({
    manager: surfaceEffectManager, state,
    resolvePhase: (sessionId) => (resolveSurfaceActivityPhaseRef ? resolveSurfaceActivityPhaseRef(sessionId) : 'idle'),
    getStreamIdForSession: (sessionId) => multiStreamController.getStreamIdForSession(sessionId),
  });
  /* companionController */
  const openLoopActionHandlers = window.rendererAppOpenLoopActions.createOpenLoopActionHandlers({
    state,
    shell: window.jennyShell,
    constants: { TOAST_SOURCE },
    callbacks: {
      getCurrentMessageById: (...a) => getCurrentMessageById(...a),
      applyCompanionPayload: (...a) => applyCompanionPayload(...a),
      appendClientLog: (...a) => appendClientLog(...a),
      showToastMessage: (...a) => showToastMessage(...a),
      renderAll: (...a) => renderAll(...a),
      getAvailableCompanionDeferPresets: (...a) => getAvailableCompanionDeferPresets(...a),
      refreshCompanionState: (...a) => refreshCompanionStateSafe(...a),
    },
  });
  const {
    handleFollowUpMessage, handleSaveProactiveSuggestionMessage, handleLaterProactiveSuggestionMessage,
  } = openLoopActionHandlers;
  const controllerComposition = window.rendererAppControllerComposition.createControllerComposition({
    window, document, globalThis, noop, noopAsync, noopNull, noopFalse, noopObj, noopArr, noopStr,
    state, staticModel, surfaceDom, composerLayoutRuntime, reducedMotionQuery, chatInput,
    ACTIVITY_SCOPE, TOAST_SOURCE, DEFAULT_CHAT_ZOOM_PERCENT, MESSAGE_STATUS,
    MAX_INTERACTIVE_QUESTIONS, MAX_INTERACTIVE_ROUNDS, INTERACTIVE_GUARDRAIL_PROMPT,
    INTERACTIVE_SEQUENCE_IDLE, INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE, INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
    settingsShellController, chatShellController, chatWayfinderController,
    renderSettings, renderComposerPopover, renderCommandPopover,
    syncComposerInputHeight, syncComposerModelSelectWidth, flushPendingStreamCommitsForSession,
    rehydrateSessionFromPersistedTurnEvents, clearProjectionContextCacheForSession,
    rekeyProjectionContextCache, updateAssistantSpritePositionRef, renderLiveThinkingChip,
    settingsRendererUtils, appearanceUtils, renderPipelineUtils, sendUtils, streamHandlerUtils, _fb,
    lifecycleController, workspaceStateController, workspaceChromeController, contextPanelController,
    pinToTopController, chatScrollCoordinator, thinkingController, thinkingIndicator, toastActionHandlers, multiStreamController,
    onSurfaceLifecycleSync, publishFirstTokenImpulse, publishToolStartImpulse, publishCompleteImpulse, publishCancelImpulse,
    uiRuntime, spriteRuntime, healthPillController: null,
    retryBackendStart,
    composerContextUsageSlot, composerPlanUsageSlot, composerToolToggleSlot,
    homeView, chatView, ideView, chatSurface, logsView, settingsView, homeNavButton,
    metricList, sessionActionButton, newChatButton, promptGrid,
    chatTimeline, chatThreadScroll, chatThreadColumn, chatSpriteLayer, chatAssistantSprite,
    heroAvatar, heroTitle, heroSubtitle, heroRuntimeHint, heroStack,
    logSearchInput, logLevelFilter, logSourceFilter, logResultsLabel, logList,
    stopStreamButton, sendButton, composer, composerModelSelect, composerEffortSelect,
    composerSettingsButton,
    jumpToTopButton, jumpToBottomButton, jumpToLastPromptButton, composerModelSelectShell, composerEffortSelectShell,
    workbenchHealthPillSlot,
    chatSurfaceEffects, chatSurfaceEffectLeft, chatThreadStage, composerWrap, chatOriginChip, chatOriginLabel,
    toolLatencyTable, slowOperationsList, recentTracesList, observabilityRefreshButton,
    normalizeAppearancePreferences, getDefaultAppearancePreferences, isDefaultAppearancePreferences,
    getChatZoomOptions, isDefaultChatZoomPercent,
    normalizeChatZoomPercent, applyAppearancePreferences, applyChatZoomPercent, applySurfaceEffect, activateSurfaceEffect,
    getPalettePresets, getTypographyPresets, getSurfaceEffectPresets,
    getFontScalePresets,
    handlePersonalityTabChangeSafe,
    getPersonalityActiveFileSafe, setPersonalityDraftSafe, renderPersonalityEditorSafe, handlePersonalitySaveSafe,
    handlePersonalityResetSafe, handlePersonalityOpenFolderSafe,
    hasPersonalityUnsavedChangesSafe, refreshMemoryContextFilesSafe, renderMemoryContextFilesSafe,
    loadMemoryContextFileSafe, setMemoryContextDraftSafe, getMemoryContextActiveFileSafe,
    saveMemoryContextFileSafe, resetMemoryContextFileSafe, hasMemoryContextUnsavedChangesSafe,
    showToastMessage, showShellErrorToast, toErrorMessage, reportErrorWhenActive, errorCenterStore, appendClientLog: (...a) => appendClientLog(...a), showSessionActionError,
    getCurrentRuntimePreferences, getRuntimePreferenceSnapshot, runRuntimePreferenceActivity,
    handleWorkspaceRootChoose, handleRunSetupAgain, showSetupHelpSafe, showFactoryResetSafe,
    refreshProactiveStateSafe,
    refreshSkillsStateSafe, bindSkillsShellEventsSafe, updateSkillsSettingsSafe, openSkillsScopeFolderSafe,
    refreshTipsStateSafe, bindTipsShellEventsSafe,
    refreshOfflineStateSafe, bindOfflineShellEventsSafe, handleOfflineModeChangeSafe,
    refreshFeatureState, handleCometOverlayToggleChange, refreshPhasePercentiles,
    resetPhasePercentiles,
    refreshApprovedMemoriesSafe, refreshPendingMemoriesSafe, refreshMemoryStatusSafe, refreshPersonalityWorkspaceSafe,
    buildModelOptionMarkup, buildSelectOptionMarkup,
    resolveComposerModelSelectWidth, updateComposerSafeOffset, renderApprovedMemoryManagerSafe,
    renderSkillsManagerSafe, renderOfflineManagerSafe, escapeHtml,
    buildLogViewModel, setActiveView, setSidebarCollapsed, openSettingsSection, isSendBusy, isAnySendBusy, isSendPreflightPending, updateTokenDisplay,
    getLatestAssistantMessageId, getLatestReplyAssistantMessageId, getLatestUserMessageId, getElaboratePrompt, resolveRegenerateRequest,
    buildAssistantMetaLabel, shouldShowThinkingToggle, getActivitySnapshot, getMostRecentActivity, isActivityBusy,
    applyActivityAttributes, clearActivity, failActivity, beginActivity,
    buildInteractiveRecapViewModel, renderToolCallBlock, setToolCallExpansion, renderInteractiveRoundRecap, renderProactiveSuggestionBlock,
    renderSlashCommandOutput, renderMessageAttachments, renderThinkingWidget, renderAgentStatusWidget,
    renderAssistantFailureNotice, renderContextCompactedNotice, renderMessageHoverRow,
    getCurrentSessionMessages, getCurrentVisibleMessages, getVisibleSessionMessages, getCurrentMessageById, showCopyFeedback, estimateTokens, isSessionStreaming,
    hasPendingToolApprovalForSession, getActiveStreamSessionId, isInteractiveRoundRecapExpanded,
    pruneInteractiveRoundRecapExpansionState,
    setFollowLatest, scheduleMessageViewportSync, getScrollMetrics, scrollMessageIntoView, getPendingQuestionBatch,
    hasStalePendingQuestionBatch, renderComposerInteractivePanel, setComposerHoloState, setSpriteHoloState,
    renderSessions, renderAttachmentTray, renderComposerStatusNotice, syncBackendNotice, renderIdeSafe, activateIdeSafe, layoutIdeEditorSafe, reconcileChatDockHostSafe, openIdeChangeDiffSafe, openIdeFileAtLineSafe,
    renderArtifactReviewPanelSafe, isArtifactReviewVisible, getArtifactsForSession, selectArtifact,
    shouldRenderHomePanelSafe, renderHomePanelSafe, renderToastViewport,
    setReasoningPhaseExpandedPreference, setReasoningPhaseExpandedPreferences,
    syncPersistedReasoningPhaseExpansionState,
    publishLifecycleStatus, renderTurnStatusPill, getChatSendLifecycle, getChatTimelineRowModelEnabled,
    recordChatTimelineRolloutSignal, rollbackChatTimelineRowModel,
    refreshActiveSurfaceEffect, registerRendererCleanup, formatLogTimestamp,
    areInteractiveQuestionsAnswered, getInteractiveNextUnansweredIndex, getInteractiveQuestionOptions,
    isInteractiveQuestionAnswered, isInteractiveOtherTrigger, getInteractiveComposerStatusNotice,
    getActiveSession, normalizePendingQuestionBatch, shouldForceInteractiveGuardrail, getInteractiveSequenceState,
    clearInteractiveDraft, patchSessionSummary, getSessionTurnEventState, getSessionMessages, setSessionMessages,
    setSessionTurnEventState, createNormalizedMessage, resolveSessionId,
    upsertSessionSummary, removeSessionState, rekeySessionState, buildAttachmentBudget,
    clearComposerStatusNotice, showComposerActionError,
    syncWorkspaceFromStore, applyWorkspaceSnapshot, activateWorkspaceSession, openArtifactTarget,
    handleCreateSessionWithWorkspace, submitCometUserAction,
    setChatSendLifecycle, clearChatSendLifecycle, moveChatSendLifecycle, buildInteractiveAnswerPrompt,
    buildInteractiveSelectedAnswers, ensureInteractiveDraft, getInteractiveDraft, persistRuntimePreferences,
    queueInteractiveComposerFocus, getActiveSendPreflight, setComposerStatusNotice,
    setTurnStatusPill, clearTurnStatusPill, clearTurnStatusPillSources, setFaceReaction,
    handlePresenceStreamEvent, handleWorkspaceActivityStreamEvent, buildInteractiveQuestionBatchVisibleText, toastStore, maybeSuggestMemoryCaptureSafe,
    mergeMessageReasoning, setActivityChangeListener, handleActivityChange,
    pushIncomingLog, syncBackendActivityFromStatus, getRendererElapsedMs, refreshSuggestions,
    resetArtifactsState, resetMemorySuggestionStateSafe, openSetupTileSafe, syncThreadScrollState, renderWorkspaceChrome,
    toggleInteractiveRoundRecap, syncThinkingBlockNode, dismissToast, resolveActivity,
    handleFollowUpMessage,
    handleSaveProactiveSuggestionMessage, handleLaterProactiveSuggestionMessage, handleUseProactiveSuggestionMessageSafe,
    _handleLifecycleProgress, _handleLifecycleBackendStatus, runStartupAuditAutoSend, beginModelSwitch,
    updateModelSwitch, failModelSwitch, adjustChatZoomPercent, resetChatZoomPercent,
    openCodeReviewTarget, openFilePreviewTarget,
  });
  ({
    settingsShellController,
    chatShellController,
    chatWayfinderController,
    renderSettings,
    renderComposerPopover,
    renderCommandPopover,
    syncComposerInputHeight,
    syncComposerModelSelectWidth,
    flushPendingStreamCommitsForSession,
    rehydrateSessionFromPersistedTurnEvents,
    clearProjectionContextCacheForSession,
    updateAssistantSpritePositionRef,
    renderLiveThinkingChip,
  } = controllerComposition);
  const {
    contextUsageModule = null,
    getLogEntryById = () => null,
    ensureLogRowMounted = () => false,
    scrollLogsToBottom = noop,
    navigateToDiagnosticsTrace = noop,
    formatSessionDate = () => 'Recent',
    formatLogTimestamp: composedFormatLogTimestamp = () => '--',
    formatMessageTerminalTimestamp = noopStr,
    applyChatStateClasses = noop,
    syncChatState = noop,
    escapeSelectorValue = (v) => String(v || ''),
    hideAssistantSprite = noop,
    applyAssistantSprite = noop,
    updateAssistantSpritePosition = noop,
    renderLayout = noop,
    renderHeader = noop,
    renderPrompts = noop,
    renderMessages = noop,
    renderHero = noop,
    renderLogs = noop,
    syncComposerVisualState = noop,
    renderComposerJumpControls = noop,
    renderComposerState = noop,
    renderAll = noop,
    applySurfaceEffect: controllerApplySurfaceEffect = noop,
    syncBackendActivityFromStatus: controllerSyncBackendActivityFromStatus = noop,
    setSessionOrigin = noop,
    setPendingOrigin = noop,
    clearPendingOrigin = noop,
    attachPendingOriginToSession = noopStr,
    rekeySessionOrigin = noopStr,
    toggleThreadBranch = noop,
    timelineVirtualizer = null,
    closeComposerPopover = noop,
    openComposerPopover = noop,
    closeCommandPopover = noop,
    openCommandPopover = noop,
    resetAttachmentQueue = noop, beginAttachmentToken = () => null, cancelAttachmentToken = () => false,
    removeQueuedAttachment = noop,
    mergePreparedAttachments = noop,
    handleAttachmentPicker = noopAsync,
    prepareDroppedAttachments = noopAsync,
    queueInlineImageAttachment = noopAsync,
    setDropActive = noop,
    suppressFileDropNavigation = (e) => { e.preventDefault(); e.stopPropagation(); },
    getDroppedFilePaths = noopArr,
    loadSessions = noopAsync,
    openSession = noopAsync,
    refreshSessionSummaries = noopAsync,
    refreshSnapshots = noopAsync,
    bootstrap = noopAsync,
    refreshSuggestions: controllerRefreshSuggestions = noopAsync,
    handleCreateSession = noopAsync,
    handleRenameSession = noopAsync,
    handleDeleteSession = noopAsync,
    handleJumpToTop = noop,
    handleJumpToLastPrompt = noop,
    handleJumpToBottom = noop,
    pruneContextUsageCache = noop,
    renderComposerEnhancements = noop,
    refreshComposerToolToggles = noopAsync,
    queueDeferredStartupTask = noop,
    handleErrorRecoveryAction = noopAsync,
    handleArtifactAction = noopAsync,
    loadSessionsWithWorkspace = noopAsync,
    refreshSessionSummariesWithWorkspace = noopAsync,
    handleCreateSessionWithWorkspace: controllerHandleCreateSessionWithWorkspace = noopAsync,
    handleDeleteSessionWithWorkspace = noopAsync,
    startPromptSend = noopAsync,
    handleStopActiveStream = noopAsync,
    handleSend = noop,
    handleInteractiveOptionSelect = noop,
    handleInteractiveOtherConfirm = noop,
    handleInteractiveOtherInputChange = noop,
    handleInteractiveSkip = noop,
    handleInteractiveSkipQuestion = noop,
    handleInteractiveSkipAll = noop,
    handleInteractiveSubmit = noop,
    handleCopyMessage = noopAsync,
    handleElaborateMessage = noopAsync,
  } = controllerComposition;
  applySurfaceEffect = controllerApplySurfaceEffect;
  refreshSuggestions = controllerRefreshSuggestions;
  handleCreateSessionWithWorkspace = controllerHandleCreateSessionWithWorkspace;
  syncBackendActivityFromStatus = controllerSyncBackendActivityFromStatus;
  state.harness.agentActions = { loadSessions, openSession, setActiveView };
  await window.rendererAppShellBindings.bindAppShell({
    state,
    windowRef: window,
    documentRef: document,
    constants: { TOAST_SOURCE, SURFACE_EFFECT_STAGES },
    dom: {
      attachFilesButton,
      attachmentTray,
      captureScreenButton,
      chatInput,
      chatTimeline,
      chatView,
      commandPaletteInput,
      commandPaletteList,
      commandPaletteOverlay,
      composerAttachShortcut,
      composerCommandPopover,
      composerCommandPopoverList,
      composerSettingsButton,
      composerSettingsPopover,
      composerTerminalShortcut,
      conversationGroups,
      copyLogsReportButton,
      logAutoScrollToggle,
      logLevelFilter,
      logList,
      logSearchInput,
      logSourceFilter,
      newChatButton,
      localProfileSettingsMount,
      searchInput,
      sendButton,
      sessionActionButton,
      sidebarResizer,
      titlebarPalettePill,
    },
    controllers: {
      chatShellController,
      chatWayfinderController,
      contextPanelController,
      lifecycleController,
      multiStreamController,
      pinToTopController,
      settingsShellController,
      shellStatusController,
      thinkingIndicator,
      workspaceChromeController,
      workspaceStateController,
    },
    modules: {
      contextUsageModule,
    },
    refs: {
      getRenderCommandPopover: () => renderCommandPopover,
      getRenderComposerPopover: () => renderComposerPopover,
      setRenderCommandPopover: (next) => { renderCommandPopover = next; },
      thinkingIndicatorRenderFrame: {
        get: () => thinkingIndicatorRenderFrame,
        set: (next) => { thinkingIndicatorRenderFrame = next; },
      },
    },
    callbacks: {
      activateCometIfEnabled: (...a) => _activateCometIfEnabled(...a),
      activateSurfaceEffect: (...a) => activateSurfaceEffect(...a),
      activateWorkspaceSession: (...a) => activateWorkspaceSession(...a),
      appendClientLog: (...a) => appendClientLog(...a),
      applyAppearancePreferences: (...a) => applyAppearancePreferences(...a),
      applySetupBackendStatus: (...a) => applySetupBackendStatusSafe(...a),
      applySurfaceEffect: (...a) => applySurfaceEffect(...a),
      bootstrap: (...a) => bootstrap(...a),
      chooseWorkspaceRoot: (...a) => handleWorkspaceRootChoose(...a),
      closeCommandPopover: (...a) => closeCommandPopover(...a),
      closeComposerPopover: (...a) => closeComposerPopover(...a),
      dismissToast: (...a) => dismissToast(...a),
      disposeCometPersonality: (...a) => disposeCometPersonality(...a),
      disposeComposerHolo: (...a) => disposeComposerHolo?.(...a),
      disposeSpriteHolo: (...a) => disposeSpriteHolo?.(...a),
      disposeViewportController: (...a) => disposeViewportController?.(...a),
      ensureComposerFeatureStateLoaded: (...a) => _ensureComposerFeatureStateLoaded(...a),
      escapeHtml,
      estimateTokens,
      finishSidebarResize: (...a) => finishSidebarResize(...a),
      getCurrentRuntimePreferences,
      getDroppedFilePaths,
      getLogEntryById,
      ensureLogRowMounted,
      getRendererElapsedMs: (...a) => getRendererElapsedMs(...a),
      getSessionMessages: (...a) => getSessionMessages(...a),
      handleAttachmentPicker: (...a) => handleAttachmentPicker(...a),
      handleDeleteSessionWithWorkspace: (...a) => handleDeleteSessionWithWorkspace(...a),
      handleLifecycleBackendStatus: (...a) => _handleLifecycleBackendStatus(...a),
      handleRenameSession: (...a) => handleRenameSession(...a),
      handleSidebarResizeKeydown: (...a) => handleSidebarResizeKeydown(...a),
      handleSidebarResizeMove: (...a) => handleSidebarResizeMove(...a),
      handleSidebarResizeStart: (...a) => handleSidebarResizeStart(...a),
      handleWorkspaceShortcut: (...a) => handleWorkspaceShortcut(...a),
      getIdeCommandItems: (...a) => getIdeCommandItemsSafe(...a),
      openIdeHelpOverlay: (...a) => openIdeHelpOverlaySafe(...a),
      hydrateCachedLazyShellState: (...a) => hydrateCachedLazyShellState(...a),
      initSetupController: (...a) => initSetupControllerSafe(...a),
      isSendPreflightPending,
      loadSessions: (...a) => loadSessions(...a),
      logSurfaceEffectFailure: (...a) => _logSurfaceEffectFailure(...a),
      mergePreparedAttachments: (...a) => mergePreparedAttachments(...a),
      beginAttachmentToken: (...a) => beginAttachmentToken(...a), cancelAttachmentToken: (...a) => cancelAttachmentToken(...a),
      navigateToDiagnosticsTrace: (...a) => navigateToDiagnosticsTrace(...a),
      openSettingsSection: (...a) => openSettingsSection(...a),
      persistRuntimePreferences: (...a) => persistRuntimePreferences(...a),
      prepareDroppedAttachments: (...a) => prepareDroppedAttachments(...a),
      queueDeferredStartupTask: (...a) => queueDeferredStartupTask(...a),
      queueInlineImageAttachment: (...a) => queueInlineImageAttachment(...a),
      queueStartupLazyHydration: (...a) => queueStartupLazyHydration(...a),
      refreshApprovedMemories: (...a) => refreshApprovedMemoriesSafe(...a),
      refreshComposerToolToggles: (...a) => refreshComposerToolToggles(...a),
      refreshDefaultChatTimelineBatch4Preference: (...a) => refreshDefaultChatTimelineBatch4Preference(...a),
      refreshPendingMemories: (...a) => refreshPendingMemoriesSafe(...a),
      refreshPhasePercentiles: (...a) => refreshPhasePercentiles(...a),
      resetPhasePercentiles: (...a) => resetPhasePercentiles(...a),
      refreshSnapshots: (...a) => refreshSnapshots(...a),
      refreshSuggestions: (...a) => refreshSuggestions(...a),
      refreshWorkspaceRootState: (...a) => refreshWorkspaceRootState(...a),
      registerCleanup: registerRendererCleanup,
      removeQueuedAttachment: (...a) => removeQueuedAttachment(...a),
      renderAll: (...a) => renderAll(...a),
      renderAttachmentTray: (...a) => renderAttachmentTray(...a),
      renderComposerState: (...a) => renderComposerState(...a),
      renderLogs: (...a) => renderLogs(...a),
      renderOfflineManager: (...a) => renderOfflineManagerSafe(...a),
      renderSessions: (...a) => renderSessions(...a),
      loadMoreChats: (...a) => loadMoreChats(...a),
      setRovingChatSession: (...a) => setRovingChatSession(...a),
      toggleChatsScope: (...a) => toggleChatsScope(...a),
      resetAttachmentQueue,
      resetLogsViewState,
      resetSidebarWidth,
      runStartupAuditAutoSend: (...a) => runStartupAuditAutoSend(...a),
      scrollLogsToBottom,
      setActiveView,
      setDropActive,
      setSessionMessages: (...a) => setSessionMessages(...a),
      setSidebarCollapsed,
      showSessionActionError,
      showShellErrorToast,
      showToastMessage,
      signalRendererReadyOnce: (...a) => signalRendererReadyOnce(...a),
      suppressFileDropNavigation,
      syncBackendActivityFromStatus: (...a) => syncBackendActivityFromStatus(...a),
      syncComposerInputHeight: (...a) => syncComposerInputHeight(...a),
      syncComposerModelSelectWidth,
      syncComposerVisualState: (...a) => syncComposerVisualState(...a),
      syncWorkspaceFromStore: (...a) => syncWorkspaceFromStore(...a),
      toErrorMessage,
      updateComposerSafeOffset,
    },
  });
})().catch((error) => {
  // #8 (STARTUP_POLISH_FINDINGS): last-resort guard for the top-level composition
  // IIFE. The in-lifecycle error boundary only attaches partway through wiring, so
  // a throw before that (or in any controller factory) would leave the user stuck
  // behind the startup overlay -- the window still reveals on the reveal-timeout
  // fallback, but the overlay sits frozen with no recovery. Surface the failure
  // visibly, force the window to reveal, report it, and offer a reload.
  const message = String((error && error.message) || error || 'Renderer startup failed.');
  const detail = String((error && (error.stack || error.message)) || error || message);
  try { window.jennyShell?.lifecycle?.signalReady?.(); } catch (_e) { /* best-effort reveal */ }
  try {
    window.jennyShell?.diagnostics?.reportRendererError?.({
      message,
      stack: detail,
      source: 'renderer-app-bootstrap',
      context: { phase: 'top_level_composition' },
    });
  } catch (_e) { /* best-effort report */ }
  try {
    const overlay = document.getElementById('startupOverlay');
    if (overlay) {
      overlay.setAttribute('data-state', 'error');
      const sublabel = document.getElementById('startupOverlaySublabel');
      if (sublabel) {
        sublabel.textContent = 'Startup failed';
      }
      const secondary = document.getElementById('startupOverlaySecondary');
      if (secondary) {
        secondary.textContent = 'Something went wrong while loading. Press Retry to reload.';
      }
      // UIUX-021: real keyboard-activatable Retry + alertdialog semantics +
      // focus transfer + inert background, shared with the backend-failure
      // path in renderer-lifecycle-progress-utils.js (same overlay markup).
      window.lifecycleProgressUtils?.presentStartupOverlayFatalError?.(overlay, {
        onRetry: () => { try { window.location.reload(); } catch (_e) { /* noop */ } },
      });
    }
  } catch (_e) { /* recovery UI must never throw */ }
});
