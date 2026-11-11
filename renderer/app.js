var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
    if (rendererDisposed) {
      try {
        Promise.resolve(cleanup()).catch(() => {});
      } catch (_error) {
        // Late registrations follow the same best-effort teardown contract.
      }
    } else {
      rendererCleanupFns.push(cleanup);
    }
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
  // Real modules only (renderer-bootstrap-utils resolveShellModules): a module
  // missing from index.html throws with its window global name instead of booting
  // a silently degraded shell.
  const shellModules = window.rendererBootstrapUtils.resolveShellModules(window);
  const { workspaceStateUtils, workspaceChromeUtils } = shellModules;
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
    deriveFollowLatestFromScroll, shouldAutoScrollThread,
    normalizeReasoningEffort, resolveComposerModelSelectWidth, appearanceUtils,
    getDefaultAppearancePreferences, normalizeAppearancePreferences, getPalettePresets,
    getTypographyPresets, getSurfaceEffectPresets, getFontScalePresets, applyAppearanceToDocument, loadStoredAppearancePreferences,
    saveStoredAppearancePreferences,
    toolCallUtils, transcriptUtils, composerHoloUtils, sessionUtils,
    streamHandlerUtils, sendUtils, interactivePanelUtils, personalityEditorUtils, toastControllerUtils,
    settingsRendererUtils, sidebarControllerUtils, lifecycleUtils, memoryManagerUtils, viewportUtils,
    artifactsUtils, activityPrefsUtils, renderPipelineUtils, lifecycleProgressUtils,
    buildPersonalityStatusTextModel, resolvePreferredPersonalityTab,
    beginActivity, clearActivity, failActivity, getActivitySnapshot, getMostRecentActivity,
    resolveActivity, setActivityChangeListener, applyActivityAttributes, isActivityBusy,
    createToastStore, buildLogViewModel,
  } = shellModules;
  const chatZoomUtils = window.chatZoomUtils || {};
  const {
    DEFAULT_CHAT_ZOOM_PERCENT = 100,
    getChatZoomOptions = noopArr,
    isDefaultChatZoomPercent = (value) => Number(value) === 100,
    normalizeChatZoomPercent = (value) => Number(value) || 100,
    applyChatZoomToDocument = (_doc, value) => normalizeChatZoomPercent(value),
    stepChatZoomPercent = (currentPercent, _direction) => normalizeChatZoomPercent(currentPercent),
  } = chatZoomUtils;
  const rendererBootstrap = window.rendererBootstrapUtils.createRendererBootstrap({ document, getDefaultAppearancePreferences, appearanceUtils });
  const { ACTIVITY_SCOPE, TOAST_SOURCE, state, surfaceDom, lazyDom } = rendererBootstrap;
  let settingsShellController = null;
  let chatShellController = null;
  const openSettingsSection = (...args) => settingsShellController?.navigateSettingsSection?.(...args);
  const {
    workspace, workspaceRailShell, homeNavButton, metricList, conversationGroups, conversationCount,
    homeView,
    homeOpenLoopCount, homeOpenLoopStatus, homeOpenLoopList,
    chatView, ideView, logsView, settingsView, heroStack,
    chatSurfaceEffects, chatSurfaceEffectLeft,
    chatThreadStage, chatSurface, chatThreadScroll, chatThreadColumn, chatSpriteLayer, chatAssistantSprite,
    chatTimeline, attachmentTray, attachmentNotice,
    composerStatusNotice, chatInput,
    newChatButton, stopStreamButton, sendButton,
    composerAttachShortcut, searchInput,
    sidebarResizer, heroAvatar, heroTitle, heroSubtitle,
    heroRuntimeHint,
    composerOfflineLabel, composerContextUsageSlot, composerPlanUsageSlot, composerToolToggleSlot,
    toastViewport, sessionActionButton, logLevelFilter, logList,
    logResultsLabel, logSearchInput, logSourceFilter, copyLogsReportButton, logAutoScrollToggle,
    observabilityRefreshButton, toolLatencyTable, slowOperationsList, recentTracesList,
    modelBadge, composerModelSelect, composerEffortSelect,
    jumpToTopButton, jumpToBottomButton, composerAttachMenu,
    commandPaletteOverlay, commandPaletteInput, commandPaletteList, titlebarPalettePill,
    commandPaletteScope, commandPaletteCount, commandPaletteLegend, commandPaletteStatus, commandPaletteFieldIcon,
    attachFilesButton, captureScreenButton,
    settingsModelCard, composerModelSelectShell,
    composerEffortSelectShell, appearanceHoloList, appearanceResetButton,
    modelStatus,
    offlineSummary, offlineStatus,
    contextStatus, contextSourcesList, contextRuntimeList,
    toolsWorkspacePath, toolsWorkspaceStatus, toolsWorkspaceChooseButton,
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
    harnessSkillsList, harnessShellList, accountSummary, backendSummary,
    localProfileSettingsMount, titlebar, sidebar, composer, composerHolo,
    composerHoloContext, composerWrap,
    workbenchHealthPillSlot,
    chatOriginChip, chatOriginLabel,
    artifactSplitViewToggle, artifactReviewResizer, artifactReviewPanel,
    artifactReviewCollapseButton, artifactReviewDetailEmpty,
    artifactReviewDetailPanel, artifactReviewDetailKicker, artifactReviewDetailTitle,
    artifactReviewDetailPath, artifactReviewDetailStatus, artifactReviewDetailMeta,
    artifactReviewDetailNote, artifactReviewPreviewContent, artifactReviewEditorShell,
    artifactReviewEditorHost, artifactReviewEditorFallback, artifactReviewSaveButton,
    artifactReviewRevertButton, artifactReviewRevealButton, artifactReviewOpenExternalButton,
    artifactReviewJumpButton, artifactReviewDeleteButton, artifactReviewProvenanceTimeline,
    chatContextPanel,
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
  // Split view W0-6: the render-memo bag is now pane 0's, and the three
  // session-keyed projection caches live in a store every pane shares. With one
  // pane this is an identity change -- same object shape, same lazy writes.
  const paneSharedStore = window.rendererPaneRuntime.createSharedSessionStore();
  const uiRuntime = window.rendererPaneRuntime.createPaneRuntime({ paneId: 0, shared: paneSharedStore });
  const spriteRuntime = { frameHandle: 0, targetMessageId: '', targetY: 0 };
  // Split view W1-4c: the ONE writer of state.panes; the second pane's lifecycle
  // (paneComposition) is built after the controller composition below.
  let paneComposition = null;
  const paneLayoutController = window.rendererPaneLayoutController?.createPaneLayoutController?.({
    state, getWorkspaceStateController: () => workspaceStateController,
    onLayoutChanged: (prev, next, meta) => paneComposition?.handleLayoutChanged?.(prev, next, meta),
  }) || null;
  const composerHoloRuntime = {
    active: false, mode: 'idle', angle: 0, frameHandle: 0, lastFrame: 0,
    pixelRatio: 1, cssWidth: 0, cssHeight: 0, resizeObserver: null,
    supported: Boolean(composerHoloContext && typeof composerHoloContext.createConicGradient === 'function'),
  };
  const sidebarRuntime = { resizePointerId: null, startX: 0, startWidth: SIDEBAR_DEFAULT_WIDTH };
  // First feature-state pull at boot; a failure is logged here and never
  // rejects, so the shell bootstrap can await it alongside other hydration.
  let composerFeatureStateLoaded = false;
  async function _ensureComposerFeatureStateLoaded() {
    if (composerFeatureStateLoaded) return;
    try {
      await refreshFeatureState();
      composerFeatureStateLoaded = true;
    } catch (error) {
      appendClientLog('WARN', 'features.bootstrap_failed', { message: error?.message || String(error) });
    }
  }
  // Living Atlas seam (file map atlas plan, W3): ONE shared
  // activity bus ingests the stream payloads the chat stream handler fans out.
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
    workspaceActivityBus?.ingest(rawPayload);
  }
  const thinkingController = new ThinkingPanelController();
  // Transcript view (answers | thinking | everything) per session; built here rather than beside the
  // reasoning controller because it needs the thinking controller itself.
  const transcriptViewController = appLifecyclePreferenceUtils.createTranscriptViewController({
    state, storage: window.localStorage, thinkingController, reasoningExpansionController: reasoningPhaseExpansionController,
    getPaneThinkingControllers: () => [window.rendererAppPaneComposition?.getPaneComposition?.()?.getPane?.(1)?.thinkingController],
    renderAll: (...a) => renderAll(...a), appendClientLog: (...a) => appendClientLog(...a),
  });
  window.rendererTranscriptViewController = transcriptViewController;
  registerRendererCleanup(() => {
    if (window.rendererTranscriptViewController === transcriptViewController) window.rendererTranscriptViewController = null;
  });
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
  let renderSettings = noop;
  let renderComposerCarriers = noop;
  let renderComposerPopover = noop;
  let syncComposerInputHeight = noop;
  let clearProjectionContextCacheForSession = noopFalse;
  let rekeyProjectionContextCache = noopStr;
  let flushPendingStreamCommitsForSession = () => ({ flushedCount: 0, catchupRequired: false });
  let rehydrateSessionFromPersistedTurnEvents = () => null;
  let applySurfaceEffect = noop;
  let handleCreateSessionWithWorkspace = noopAsync;
  let syncBackendActivityFromStatus = noop;
  const lifecycleComposition = await window.rendererAppLifecycleComposition.createLifecycleComposition({
    window, document, globalThis, noop, noopAsync, noopNull, noopFalse, noopObj, noopArr, noopStr,
    state, sidebarRuntime, surfaceDom, lazyDom, lifecycleUtils, appLifecyclePreferenceUtils, paneLayoutController,
    fileDiffBindings: window.rendererFileDiffBindings || {}, codeHighlight: window.rendererCodeHighlight || {},
    monacoEditorUtils: window.rendererMonacoEditorUtils || {},
    personalityEditorUtils, memoryManagerUtils, viewportUtils, transcriptUtils, toolCallUtils, interactivePanelUtils,
    toastControllerUtils, artifactsUtils, sessionUtils, sidebarControllerUtils, workspaceStateUtils,
    workspaceChromeUtils, SIDEBAR_STORAGE_KEY,
    SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MAIN_STAGE_MIN_WIDTH,
    SIDEBAR_KEYBOARD_STEP,
    APPEARANCE_STORAGE_KEY,
    CHAT_TIMELINE_BATCH4_STORAGE_KEY, DEFAULT_CHAT_ZOOM_PERCENT,
    MESSAGE_STATUS, MAX_INTERACTIVE_QUESTIONS, MAX_INTERACTIVE_ROUNDS, TOAST_SOURCE, ACTIVITY_SCOPE,
    normalizeChatMessage, normalizeChatMessages, getLatestUserMessageId, getInteractiveQuestionOptions,
    isInteractiveQuestionAnswered, areInteractiveQuestionsAnswered, isInteractiveOtherTrigger,
    INTERACTIVE_SEQUENCE_IDLE, INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE, INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
    get settingsShellController() { return settingsShellController; },
    get chatShellController() { return chatShellController; },
    renderComposerJumpControls: (...a) => renderComposerJumpControls(...a),
    registerRendererCleanup,
    isDisposed: () => rendererDisposed,
    renderSettings: (...a) => renderSettings(...a), renderComposerPopover: (...a) => renderComposerPopover(...a),
    syncComposerInputHeight: (...a) => syncComposerInputHeight(...a),
    thinkingController, reducedMotionQuery, toastStore, toastActionHandlers, renderAll: (...a) => renderAll(...a),
    renderLayout: (...a) => renderLayout(...a), renderHeader: (...a) => renderHeader(...a),
    renderLogs: (...a) => renderLogs(...a),
    renderComposerState: (...a) => renderComposerState(...a), syncBackendNotice: (...a) => syncBackendNotice(...a),
    renderMessages: (...a) => renderMessages(...a), renderIdeSafe: (...a) => renderIdeSafe(...a),
    activateIdeSafe: (...a) => activateIdeSafe(...a), layoutIdeEditorSafe: (...a) => layoutIdeEditorSafe(...a),
    renderHomePanelSafe: (...a) => renderHomePanelSafe(...a),
    renderSessions: (...a) => renderSessions(...a), getCurrentVisibleMessages: (...a) => getCurrentVisibleMessages(...a),
    saveReasoningPhaseExpansionPreferences, transcriptViewController,
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
    rekeyProjectionContextCache: (...a) => rekeyProjectionContextCache(...a),
    rehydrateSessionFromPersistedTurnEvents: (...a) => rehydrateSessionFromPersistedTurnEvents(...a),
    initializeComposerHolo,
    _applySidebarLayout, hideAssistantSprite: (...a) => hideAssistantSprite(...a), updateAssistantSpritePosition: (...a) => updateAssistantSpritePosition(...a),
    setSidebarCollapsed: (...a) => setSidebarCollapsed(...a),
    invalidateSessionArtifacts: (...a) => invalidateSessionArtifacts(...a),
    pruneSessionArtifacts: (...a) => pruneSessionArtifacts(...a), resetArtifactsState: (...a) => resetArtifactsState(...a),
    getDefaultAppearancePreferences, normalizeAppearancePreferences, applyAppearanceToDocument,
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
    beginActivity, resolveActivity, failActivity, getActivitySnapshot, getMostRecentActivity, isActivityBusy,
    applyActivityAttributes, renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a), syncWorkspaceFromStore: (...a) => syncWorkspaceFromStore(...a),
    activateWorkspaceSession: (...a) => activateWorkspaceSession(...a), openSession: (...a) => openSession(...a),
    loadSessions: (...a) => loadSessions(...a),
    applyWorkspaceSnapshot: (...a) => applyWorkspaceSnapshot(...a), openSettingsSection: (...a) => openSettingsSection(...a),
    getCurrentMessageById: (...a) => getCurrentMessageById(...a), setActiveView: (...a) => setActiveView(...a),
  });
  if (rendererDisposed) return;
  let chatWayfinderController = lifecycleComposition.chatWayfinderController || null;
  workspaceStateController = lifecycleComposition.workspaceStateController || null;
  workspaceChromeController = lifecycleComposition.workspaceChromeController || null;
  const {
    lifecycleController, escapeHtml, getActiveSession,
    getRuntimePreferencesFromSession, getCurrentRuntimePreferences, patchSessionSummary,
    buildModelOptionMarkup, adjustChatZoomPercent, applyChatZoomPercent,
    resetChatZoomPercent, appendClientLog: lifecycleAppendClientLog = noop, getRendererElapsedMs,
    pushIncomingLog, resetLogsViewState, setActiveView, applyAppearancePreferences,
    isDefaultAppearancePreferences, buildSelectOptionMarkup,
    getChatTimelineRowModelEnabled,
    recordChatTimelineRolloutSignal, refreshDefaultChatTimelineBatch4Preference,
    rollbackChatTimelineRowModel,
    refreshFeatureState, refreshWorkspaceRootState, refreshPhasePercentiles, resetPhasePercentiles,
    hydrateCachedLazyShellState, queueStartupLazyHydration, handleWorkspaceRootChoose, clearWorkspaceRoot, getProjectSwitcher,
    getPersonalityActiveFileSafe, setPersonalityDraftSafe, refreshPersonalityWorkspaceSafe, renderPersonalityEditorSafe,
    handlePersonalityTabChangeSafe, handlePersonalitySaveSafe, handlePersonalityResetSafe,
    handlePersonalityOpenFolderSafe,
    hasPersonalityUnsavedChangesSafe,
    refreshProactiveStateSafe,
    handleUseProactiveSuggestionMessageSafe, refreshSkillsStateSafe,
    renderSkillsManagerSafe, updateSkillsSettingsSafe, openSkillsScopeFolderSafe, bindSkillsShellEventsSafe,
    refreshOfflineStateSafe,
    renderOfflineManagerSafe, bindOfflineShellEventsSafe, handleOfflineModeChangeSafe,
    refreshApprovedMemoriesSafe, refreshPendingMemoriesSafe, refreshMemoryStatusSafe,
    renderApprovedMemoryManagerSafe,
    renderIdeSafe, activateIdeSafe, layoutIdeEditorSafe, reconcileChatDockHostSafe, openIdeChangeDiffSafe, openIdeFileAtLineSafe, revealIdePathSafe, getIdeCommandItemsSafe, openIdeHelpOverlaySafe,
    openIdeTerminalSafe, runIdeTaskTerminalSafe, closeIdeBottomPanelSafe,
    refreshCompanionStateSafe, shouldRenderHomePanelSafe,
    renderHomePanelSafe, applyCompanionPayload, getAvailableCompanionDeferPresets, initSetupControllerSafe,
    applySetupBackendStatusSafe, openSetupTileSafe,
    showSetupHelpSafe, showFactoryResetSafe, handleRunSetupAgain, buildAttachmentBudget,
    setComposerStatusNotice, clearComposerStatusNotice, getActiveSendPreflight, isSendPreflightPending,
    getActiveStreamSessionId, isAnySendBusy, isSessionStreaming, hasPendingToolApprovalForSession, isSendBusy,
    dismissToast, renderToastViewport, showToastMessage, showShellErrorToast, toErrorMessage,
    showSessionActionError, showComposerActionError, reportErrorWhenActive, errorCenterStore, shellStatusController, getRuntimePreferenceSnapshot,
    renderComposerStatusNotice, handleActivityChange, runRuntimePreferenceActivity, persistRuntimePreferences,
    syncBackendNotice, retryBackendStart, _handleLifecycleProgress, _handleLifecycleBackendStatus, beginModelSwitch, updateModelSwitch,
    failModelSwitch, renderMessageAttachments, buildInteractiveRecapViewModel, renderInteractiveRoundRecap,
    renderMessageHoverRow, renderAgentStatusWidget, renderAssistantFailureNotice, renderContextCompactedNotice,
    renderThinkingWidget, renderToolCallBlock, setToolCallExpansion, renderProactiveSuggestionBlock, renderSlashCommandOutput,
    queueInteractiveComposerFocus, renderComposerInteractivePanel,
    chatScrollCoordinator, composerLayoutRuntime, mergeMessageReasoning,
    getScrollMetrics, setFollowLatest, syncThreadScrollState,
    updateComposerSafeOffset, scrollThreadToTop,
    scrollThreadToBottom, scrollMessageIntoView, getCurrentMessageById, isInteractiveRoundRecapExpanded,
    pruneInteractiveRoundRecapExpansionState, toggleInteractiveRoundRecap, toggleContextCompactionDetails, showCopyFeedback,
    syncThinkingBlockNode, scheduleMessageViewportSync, disposeViewportController,
    shellArtifactBridge, getArtifactsForSession, selectArtifact,
    invalidateSessionArtifacts, pruneSessionArtifacts, resetArtifactsState,
    isArtifactReviewVisible, renderArtifactReviewPanelSafe, openArtifactTarget,
    openCodeReviewTarget, openFilePreviewTarget, contextPanelController, getSessionMessages,
    setSessionMessages, getSessionTurnEventState, setSessionTurnEventState, getCurrentSessionMessages,
    getVisibleSessionMessages, getCurrentVisibleMessages, createNormalizedMessage, resolveSessionId,
    normalizePendingQuestionBatch, getPendingQuestionBatch, getInteractiveSequenceState,
    hasStalePendingQuestionBatch, clearInteractiveDraft, ensureInteractiveDraft,
    getInteractiveDraft, buildInteractiveQuestionBatchVisibleText,
    shouldForceInteractiveGuardrail, buildInteractiveSelectedAnswers, buildInteractiveAnswerPrompt,
    estimateTokens, upsertSessionSummary,
    removeSessionState, rekeySessionState,
    updateTokenDisplay, renderAttachmentTray, renderSessions, setSidebarCollapsed,
    resetSidebarWidth, setRovingChatSession, toggleChatsScope, handleSidebarResizeStart, handleSidebarResizeMove,
    finishSidebarResize, handleSidebarResizeKeydown, multiStreamController,
    syncWorkspaceFromStore, applyWorkspaceSnapshot, activateWorkspaceSession,
    handleLinkedSessionPopover, renderWorkspaceChrome, handleWorkspaceShortcut,
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
    state, surfaceDom, composerLayoutRuntime, reducedMotionQuery, chatInput, paneLayoutController, getPaneComposition: () => paneComposition,
    ACTIVITY_SCOPE, TOAST_SOURCE, DEFAULT_CHAT_ZOOM_PERCENT, MESSAGE_STATUS,
    MAX_INTERACTIVE_QUESTIONS, MAX_INTERACTIVE_ROUNDS, INTERACTIVE_GUARDRAIL_PROMPT,
    INTERACTIVE_SEQUENCE_IDLE, INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE, INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
    settingsShellController, chatShellController, chatWayfinderController,
    renderSettings, renderComposerCarriers, renderComposerPopover,
    syncComposerInputHeight, flushPendingStreamCommitsForSession,
    rehydrateSessionFromPersistedTurnEvents, clearProjectionContextCacheForSession,
    rekeyProjectionContextCache, updateAssistantSpritePositionRef, renderLiveThinkingChip,
    settingsRendererUtils, appearanceUtils, renderPipelineUtils, sendUtils, streamHandlerUtils, shellModules,
    lifecycleController, contextPanelController,
    chatScrollCoordinator, thinkingController, thinkingIndicator, toastActionHandlers, multiStreamController,
    onSurfaceLifecycleSync, publishFirstTokenImpulse, publishToolStartImpulse, publishCompleteImpulse, publishCancelImpulse,
    uiRuntime, spriteRuntime, healthPillController: null,
    retryBackendStart,
    composerContextUsageSlot, composerPlanUsageSlot, composerToolToggleSlot,
    homeView, chatView, ideView, chatSurface, logsView, settingsView, homeNavButton,
    metricList, sessionActionButton, newChatButton,
    chatTimeline, chatThreadScroll, chatThreadColumn, chatSpriteLayer, chatAssistantSprite,
    heroAvatar, heroTitle, heroSubtitle, heroRuntimeHint, heroStack,
    logSearchInput, logLevelFilter, logSourceFilter, logResultsLabel, logList,
    stopStreamButton, sendButton, composer, composerModelSelect, composerEffortSelect,
    jumpToTopButton, jumpToBottomButton, composerModelSelectShell, composerEffortSelectShell,
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
    hasPersonalityUnsavedChangesSafe,
    showToastMessage, showShellErrorToast, toErrorMessage, reportErrorWhenActive, errorCenterStore, appendClientLog: (...a) => appendClientLog(...a), showSessionActionError,
    getCurrentRuntimePreferences, getRuntimePreferencesFromSession, getRuntimePreferenceSnapshot, runRuntimePreferenceActivity,
    handleWorkspaceRootChoose, clearWorkspaceRoot, getProjectSwitcher, handleRunSetupAgain, showSetupHelpSafe, showFactoryResetSafe,
    refreshProactiveStateSafe,
    refreshSkillsStateSafe, bindSkillsShellEventsSafe, updateSkillsSettingsSafe, openSkillsScopeFolderSafe,
    refreshOfflineStateSafe, bindOfflineShellEventsSafe, handleOfflineModeChangeSafe,
    refreshFeatureState, refreshPhasePercentiles,
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
    getCurrentSessionMessages, getCurrentVisibleMessages, getVisibleSessionMessages, getCurrentMessageById, showCopyFeedback, isSessionStreaming,
    hasPendingToolApprovalForSession, getActiveStreamSessionId, isInteractiveRoundRecapExpanded,
    pruneInteractiveRoundRecapExpansionState,
    setFollowLatest, scheduleMessageViewportSync, getScrollMetrics, scrollMessageIntoView, getPendingQuestionBatch,
    hasStalePendingQuestionBatch, renderComposerInteractivePanel, setComposerHoloState,
    renderSessions, renderAttachmentTray, renderComposerStatusNotice, syncBackendNotice, renderIdeSafe, layoutIdeEditorSafe, reconcileChatDockHostSafe, openIdeChangeDiffSafe, openIdeFileAtLineSafe, revealIdePathSafe,
    renderArtifactReviewPanelSafe, isArtifactReviewVisible, getArtifactsForSession, selectArtifact,
    shouldRenderHomePanelSafe, renderHomePanelSafe, renderToastViewport,
    setReasoningPhaseExpandedPreference,
    syncPersistedReasoningPhaseExpansionState,
    getChatSendLifecycle, getChatTimelineRowModelEnabled,
    recordChatTimelineRolloutSignal, rollbackChatTimelineRowModel,
    refreshActiveSurfaceEffect, registerRendererCleanup,
    areInteractiveQuestionsAnswered, getInteractiveNextUnansweredIndex, getInteractiveQuestionOptions,
    isInteractiveQuestionAnswered, isInteractiveOtherTrigger, getInteractiveComposerStatusNotice,
    getActiveSession, normalizePendingQuestionBatch, shouldForceInteractiveGuardrail, getInteractiveSequenceState,
    clearInteractiveDraft, patchSessionSummary, getSessionTurnEventState, getSessionMessages, setSessionMessages,
    setSessionTurnEventState, createNormalizedMessage, resolveSessionId,
    upsertSessionSummary, removeSessionState, rekeySessionState, buildAttachmentBudget,
    clearComposerStatusNotice, showComposerActionError,
    syncWorkspaceFromStore, applyWorkspaceSnapshot, activateWorkspaceSession, openArtifactTarget,
    handleCreateSessionWithWorkspace,
    setChatSendLifecycle, clearChatSendLifecycle, moveChatSendLifecycle, buildInteractiveAnswerPrompt,
    buildInteractiveSelectedAnswers, ensureInteractiveDraft, getInteractiveDraft, persistRuntimePreferences,
    queueInteractiveComposerFocus, getActiveSendPreflight, setComposerStatusNotice,
    handleWorkspaceActivityStreamEvent, buildInteractiveQuestionBatchVisibleText, toastStore,
    mergeMessageReasoning, setActivityChangeListener, handleActivityChange,
    pushIncomingLog, syncBackendActivityFromStatus, getRendererElapsedMs,
    resetArtifactsState, openSetupTileSafe, syncThreadScrollState, renderWorkspaceChrome,
    toggleInteractiveRoundRecap, toggleContextCompactionDetails, syncThinkingBlockNode, dismissToast, resolveActivity,
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
    syncComposerInputHeight,
    flushPendingStreamCommitsForSession,
    rehydrateSessionFromPersistedTurnEvents,
    clearProjectionContextCacheForSession,
    rekeyProjectionContextCache,
    updateAssistantSpritePositionRef,
    renderLiveThinkingChip,
  } = controllerComposition);
  const {
    contextUsageModule = null,
    ensureLogRowMounted = () => false,
    scrollLogsToBottom = noop, navigateToDiagnosticsTrace = noop, hideAssistantSprite = noop,
    updateAssistantSpritePosition = noop, renderLayout = noop, renderHeader = noop, renderMessages = noop,
    renderLogs = noop, syncComposerVisualState = noop, renderComposerJumpControls = noop, renderComposerState = noop,
    renderAll = noop, applySurfaceEffect: controllerApplySurfaceEffect = noop,
    syncBackendActivityFromStatus: controllerSyncBackendActivityFromStatus = noop, setSessionOrigin = noop,
    setPendingOrigin = noop, clearPendingOrigin = noop, closeComposerPopover = noop, openComposerPopover = noop,
    resetAttachmentQueue = noop, beginAttachmentToken = () => null, cancelAttachmentToken = () => false,
    removeQueuedAttachment = noop, mergePreparedAttachments = noop, handleAttachmentPicker = noopAsync,
    prepareDroppedAttachments = noopAsync, queueInlineImageAttachment = noopAsync, setDropActive = noop,
    suppressFileDropNavigation = (e) => { e.preventDefault(); e.stopPropagation(); },
    getDroppedFilePaths = noopArr, loadSessions = noopAsync, refreshSessionSummariesWithWorkspace = noopAsync, openSession = noopAsync, refreshSnapshots = noopAsync,
    bootstrap = noopAsync, handleRenameSession = noopAsync, refreshComposerToolToggles = noopAsync,
    queueDeferredStartupTask = noop,
    handleCreateSessionWithWorkspace: controllerHandleCreateSessionWithWorkspace = noopAsync,
    handleDeleteSessionWithWorkspace = noopAsync, startPromptSend = noopAsync, handleStopActiveStream = noopAsync,
  } = controllerComposition;
  // Suggested changes (row 35): the lazily loaded review UI sends the comment digest and reads streaming state here.
  const suggestedChangesHost = Object.freeze({ startPromptSend: (...a) => startPromptSend(...a), isSessionStreaming: (id) => isSessionStreaming(id), showToastMessage: (...a) => showToastMessage(...a) });
  window.rendererSuggestedChangesHost = suggestedChangesHost;
  registerRendererCleanup(() => { if (window.rendererSuggestedChangesHost === suggestedChangesHost) window.rendererSuggestedChangesHost = null; });
  applySurfaceEffect = controllerApplySurfaceEffect;
  handleCreateSessionWithWorkspace = controllerHandleCreateSessionWithWorkspace;
  syncBackendActivityFromStatus = controllerSyncBackendActivityFromStatus;
  // Split view W1-4c: pane 1 is built by the SAME builders as pane 0 (the three
  // compositions export them) and routed by the render frame through
  // renderSessionPane; with one pane every entry point answers "not mine".
  paneComposition = window.rendererAppSplitViewComposition.createSplitView({
    ACTIVITY_SCOPE, TOAST_SOURCE, ThinkingPanelController, activateWorkspaceSession, applyActivityAttributes,
    beginAttachmentToken, buildModelOptionMarkup, cancelAttachmentToken, chatInput, chatShellController, chatView,
    clearComposerStatusNotice, contextPanelController, controllerComposition, getActivitySnapshot,
    getChatSendLifecycle, getDroppedFilePaths, getProjectSwitcher, getRuntimePreferencesFromSession,
    getSessionMessages, getVisibleSessionMessages, handleAttachmentPicker, hasPendingToolApprovalForSession,
    isActivityBusy, isSessionStreaming, lifecycleComposition, paneLayoutController, paneSharedStore,
    prepareDroppedAttachments, queueInlineImageAttachment, removeQueuedAttachment, renderAll, renderAttachmentTray,
    renderComposerStatusNotice, renderMessages, resetAttachmentQueue, setFollowLatest, setSessionMessages,
    setSessionTurnEventState, shellArtifactBridge, showToastMessage, state, suppressFileDropNavigation, surfaceDom,
    thinkingController, toErrorMessage, workspaceStateController,
    appendClientLog: (...a) => appendClientLog(...a), getPaneComposition: () => paneComposition,
  });
  registerRendererCleanup(() => paneComposition?.dispose?.());
  workspaceChromeController?.setPaneDropTarget?.(paneComposition?.getDropTarget?.() || null); // W2-1: rail tab drag -> drop zones
  // Agent hooks open a chat the way the sidebar does (workspace activation selects its tab);
  // a bare openSession left the tab strip on the previous chat, so the next settle snapped back.
  state.harness.agentActions = {
    loadSessions,
    setActiveView,
    openSession: async (sessionId) => {
      await activateWorkspaceSession(sessionId);
      return String(state.currentSessionId || '').trim() === String(sessionId || '').trim();
    },
  };
  await window.rendererAppShellBindingsComposition.bindAppShellFromApp({
    SURFACE_EFFECT_STAGES, TOAST_SOURCE, _ensureComposerFeatureStateLoaded, _handleLifecycleBackendStatus,
    _logSurfaceEffectFailure, activateSurfaceEffect, activateWorkspaceSession, applyAppearancePreferences,
    applySetupBackendStatusSafe, applySurfaceEffect, attachFilesButton, attachmentTray, beginAttachmentToken,
    bootstrap, cancelAttachmentToken, captureScreenButton, chatInput, chatShellController, chatTimeline, chatView,
    chatWayfinderController, clearProjectionContextCacheForSession, closeComposerPopover, closeIdeBottomPanelSafe,
    commandPaletteCount, commandPaletteFieldIcon, commandPaletteInput, commandPaletteLegend, commandPaletteList,
    commandPaletteOverlay, commandPaletteScope, commandPaletteStatus, composerAttachMenu, composerAttachShortcut,
    composerWrap, contextPanelController, contextUsageModule, conversationGroups, copyLogsReportButton, dismissToast,
    disposeComposerHolo, disposeViewportController, ensureLogRowMounted, escapeHtml, estimateTokens,
    finishSidebarResize, getCurrentRuntimePreferences, getDroppedFilePaths, getIdeCommandItemsSafe,
    getProjectSwitcher, getRendererElapsedMs, getSessionMessages, handleAttachmentPicker,
    handleDeleteSessionWithWorkspace, handleLinkedSessionPopover, handleRenameSession, handleSidebarResizeKeydown,
    handleSidebarResizeMove, handleSidebarResizeStart, handleStopActiveStream, handleWorkspaceRootChoose,
    handleWorkspaceShortcut, hydrateCachedLazyShellState, initSetupControllerSafe, isSendPreflightPending,
    lifecycleController, loadSessions, localProfileSettingsMount, logAutoScrollToggle, logLevelFilter, logList,
    logSearchInput, logSourceFilter, mergePreparedAttachments, multiStreamController, navigateToDiagnosticsTrace,
    newChatButton, openComposerPopover, openIdeHelpOverlaySafe, openIdeTerminalSafe, openSettingsSection,
    openSetupTileSafe, paneLayoutController, persistRuntimePreferences,
    prepareDroppedAttachments, queueDeferredStartupTask, queueInlineImageAttachment, queueStartupLazyHydration,
    refreshApprovedMemoriesSafe, refreshComposerToolToggles, refreshDefaultChatTimelineBatch4Preference,
    refreshPendingMemoriesSafe, refreshPhasePercentiles, refreshSessionSummariesWithWorkspace, refreshSnapshots, refreshWorkspaceRootState,
    registerRendererCleanup, removeQueuedAttachment, renderAll, renderAttachmentTray, renderComposerState, renderHeader,
    renderLogs, renderOfflineManagerSafe, renderSessions, renderSettings, resetAttachmentQueue, resetLogsViewState,
    resetPhasePercentiles, resetSidebarWidth, runIdeTaskTerminalSafe, runStartupAuditAutoSend, scrollLogsToBottom,
    searchInput, sendButton, sessionActionButton, setActiveView, setDropActive, setRovingChatSession,
    setSessionMessages, setSidebarCollapsed, settingsShellController, shellArtifactBridge, shellStatusController,
    showComposerActionError, showSessionActionError, showShellErrorToast, showToastMessage, sidebarResizer,
    signalRendererReadyOnce, state, suppressFileDropNavigation, syncBackendActivityFromStatus,
    syncComposerInputHeight, syncComposerVisualState, syncWorkspaceFromStore, thinkingIndicator, titlebarPalettePill,
    toErrorMessage, toggleChatsScope, updateComposerSafeOffset, workspace, workspaceChromeController,
    workspaceStateController,
    appendClientLog: (...a) => appendClientLog(...a), isRendererDisposed: () => rendererDisposed,
    getRenderComposerPopover: () => renderComposerPopover,
    thinkingIndicatorRenderFrameRef: {
      get: () => thinkingIndicatorRenderFrame,
      set: (next) => { thinkingIndicatorRenderFrame = next; },
    },
  });
})().catch((error) => {
  // #8 (STARTUP_POLISH_FINDINGS): last-resort guard for the top-level composition
  // IIFE. The in-lifecycle error boundary only attaches partway through wiring, so
  // a throw before that (or in any controller factory) would leave the user stuck
  // behind the startup overlay -- the window still reveals on the reveal-timeout
  // fallback, but the overlay sits frozen with no recovery. Surface the failure
  // visibly, force the window to reveal, report it, and offer a reload.
  const message = String((error && error.message) || error || jt('app.startup.rendererFailed', 'Renderer startup failed.'));
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
        sublabel.textContent = jt('setup.startup.failed', 'Jenny could not start');
      }
      const secondary = document.getElementById('startupOverlaySecondary');
      if (secondary) {
        secondary.textContent = jt('app.startup.retryInstructions', 'Something went wrong while loading. Press Retry to reload.');
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
