(function (root) {
  async function createLifecycleComposition(ctx) {
    let result = null;
    with (ctx) {
  // Late-bound: constructed after the sidebar controller below; the lifecycle
  // callbacks bag closes over it so applyViewChrome routes through the top
  // navigation shell once it exists (the legacy layout is the fallback before).
  let topNavShellController = null;
  // Late-bound like topNavShellController (bound below) so hydrateHomeView can signal the startup overlay.
  let notifyStartupBootViewReadyRef = null;
  let syncStartupBackendStatusRef = null;
  /* lifecycleController */
  const lifecycleController = lifecycleUtils.createLifecycleController?.({
    state, controllers: { thinkingController },
    constants: { APPEARANCE_STORAGE_KEY, TOAST_SOURCE },
    dom: { chatInput, composerAttachMenu, composerAttachShortcut },
    callbacks: {
      normalizeReasoningEffort, loadStoredAppearancePreferences,
      getDefaultAppearancePreferences, normalizeAppearancePreferences, applyAppearanceToDocument,
      getDefaultChatZoomPercent: () => DEFAULT_CHAT_ZOOM_PERCENT,
      normalizeChatZoomPercent,
      applyChatZoomToDocument,
      saveStoredAppearancePreferences, getLatestUserMessageId,
      renderComposerPopover: (...a) => renderComposerPopover(...a), renderAttachmentTray: (...a) => renderAttachmentTray(...a),
      clearAttachmentNotice: (...a) => clearAttachmentNotice(...a), buildAttachmentToastMessage: (...a) => buildAttachmentToastMessage(...a),
      showToastMessage: (...a) => showToastMessage(...a), renderAll: (...a) => renderAll(...a),
      /* EH-W9: flag-gated intake route (null when error_intake_routing is off). */
      reportError: (...a) => reportErrorWhenActive(...a),
      renderLayout: (...a) => renderLayout(...a), renderHeader: (...a) => renderHeader(...a),
      renderLogs: (...a) => renderLogs(...a), renderSettings: (...a) => renderSettings(...a),
      renderApprovedMemoryManager: (...a) => renderApprovedMemoryManagerSafe(...a),
      ensureIdeLoaded: () => ensureIdeLoaded(),
      renderIde: (...a) => renderIdeSafe(...a),
      activateIde: (...a) => activateIdeSafe(...a),
      renderHomePanel: (...a) => renderHomePanelSafe(...a),
      renderDashboard: (...a) => renderDashboardSafe(...a),
      notifyBootViewReady: (...a) => (notifyStartupBootViewReadyRef ? notifyStartupBootViewReadyRef(...a) : undefined),
      syncStartupBackendStatus: (...a) => (syncStartupBackendStatusRef ? syncStartupBackendStatusRef(...a) : undefined),
      invalidateSessionArtifacts: (...a) => invalidateSessionArtifacts(...a), pruneSessionArtifacts: (...a) => pruneSessionArtifacts(...a),
      resetArtifactsState: (...a) => resetArtifactsState(...a),
      renderComposerState: (...a) => renderComposerState(...a),
      renderPersonalityEditor: (...a) => renderPersonalityEditorSafe(...a), syncBackendNotice: (...a) => syncBackendNotice(...a),
      renderSessions: (...a) => renderSessions(...a), refreshApprovedMemories: (...a) => refreshApprovedMemoriesSafe(...a),
      refreshPendingMemories: (...a) => refreshPendingMemoriesSafe(...a),
      refreshCompanionState: (...a) => refreshCompanionStateSafe(...a), refreshProactiveState: (...a) => refreshProactiveStateSafe(...a),
      refreshSkillsState: (...a) => refreshSkillsStateSafe(...a),
      refreshOfflineState: (...a) => refreshOfflineStateSafe(...a), refreshAwayDigest: (...a) => refreshAwayDigestSafe(...a),
      refreshPhasePercentiles: (...a) => refreshPhasePercentiles(...a),
      refreshPersonalityWorkspace: (...a) => refreshPersonalityWorkspaceSafe(...a), toErrorMessage: (...a) => toErrorMessage(...a),
      initializeComposerHolo: (...a) => initializeComposerHolo(...a), initializeComposerLayoutObserver: (...a) => initializeComposerLayoutObserver(...a),
      warmCodeHighlighting: () => codeHighlight.warmCodeHighlighting?.({ monacoUtils: monacoEditorUtils, root: document, log: appendClientLog }),
      disposeCodeHighlighting: () => codeHighlight.disposeCodeHighlighting?.(),
      applySidebarLayout: (...a) => _applySidebarLayout(...a), updateComposerSafeOffset: (...a) => updateComposerSafeOffset(...a),
      applyViewChrome: (...a) => (topNavShellController ? topNavShellController.applyViewChrome(...a) : _applySidebarLayout(...a)),
      updateAssistantSpritePosition: (...a) => updateAssistantSpritePosition(...a), hideAssistantSprite: (...a) => hideAssistantSprite(...a),
      setSidebarCollapsed: (...a) => setSidebarCollapsed(...a),
      clearComposerStatusNotice: (...a) => clearComposerStatusNotice(...a),
      getCurrentVisibleMessages: (...a) => getCurrentVisibleMessages(...a), getCurrentSessionMessages: (...a) => getCurrentSessionMessages(...a),
      getSessionMessages: (...a) => getSessionMessages(...a), setSessionMessages: (...a) => setSessionMessages(...a), setSessionTurnEventState: (...a) => setSessionTurnEventState(...a),
      scrollThreadToTop: (...a) => scrollThreadToTop(...a), scrollThreadToBottom: (...a) => scrollThreadToBottom(...a),
      scrollMessageIntoView: (...a) => scrollMessageIntoView(...a), isSendBusy: (...a) => isSendBusy(...a), isAnySendBusy: (...a) => isAnySendBusy(...a),
      setFollowLatest: (...a) => setFollowLatest(...a), clearStalePendingQuestionBatch: (...a) => clearStalePendingQuestionBatch(...a),
      getPendingQuestionBatch: (...a) => getPendingQuestionBatch(...a), clearInteractiveDraft: (...a) => clearInteractiveDraft(...a),
      getScrollMetrics: (...a) => getScrollMetrics(...a), createNormalizedMessage: (...a) => createNormalizedMessage(...a), upsertSessionSummary: (...a) => upsertSessionSummary(...a),
      removeSessionState: (...a) => removeSessionState(...a),
      restoreSettingsNavSection: () => settingsShellController?.restoreSettingsNavSection?.(),
      ensureSettingsSectionReady: (...a) => settingsShellController?.ensureSettingsSectionReady?.(...a),
      refreshSettingsSection: (...a) => settingsShellController?.refreshSettingsSection?.(...a),
      syncUsageVisibility: (...a) => settingsShellController?.syncUsageVisibility?.(...a),
      refreshActiveSurfaceEffect: (...a) => refreshActiveSurfaceEffect(...a),
      activateSurfaceEffect: (...a) => activateSurfaceEffect(...a),
      applySurfaceEffect: (...a) => applySurfaceEffect(...a),
      renderMessages: (...a) => renderMessages(...a),
      flushPendingStreamCommitsForSession: (...a) => flushPendingStreamCommitsForSession(...a),
      rehydrateSessionFromPersistedTurnEvents: (...a) => rehydrateSessionFromPersistedTurnEvents(...a),
      prepareChatDockSessionTransition: (...a) => prepareChatDockSessionTransitionSafe(...a),
    },
  }) || null;
  const {
    escapeHtml, getSessionMonogram, getActiveSession, getRuntimePreferencesFromSession,
    getCurrentRuntimePreferences, patchSessionSummary, syncRuntimeDraftFromActiveSession, buildModelOptionMarkup,
    loadAppearancePreferences, adjustChatZoomPercent, applyChatZoomPercent, resetChatZoomPercent, appendClientLog,
    getRendererElapsedMs, runDeferredVisualStartup,
    pushIncomingLog, resetLogsViewState, setActiveView, applyAppearancePreferences,
    isDefaultAppearancePreferences, buildSelectOptionMarkup, attachGlobalErrorBoundary, detachGlobalErrorBoundary,
  } = lifecycleController || {};
  // Boot preferences: chat-timeline rollout prefs, persisted chatUi/windowUi state, first feature flags.
  const bootPreferences = await window.rendererAppBootPreferencesComposition.createBootPreferencesComposition({
    __proto__: ctx, appendClientLog, loadAppearancePreferences,
  });
  if (bootPreferences.disposed) return {};
  const {
    getChatTimelineRowModelEnabled, recordChatTimelineRolloutSignal, refreshDefaultChatTimelineBatch4Preference,
    rollbackChatTimelineRowModel, prefetchedFeatureState,
  } = bootPreferences;
  // Shell services (renderer-app-shell-services-composition.js); the names bound below it are read through accessors.
  const shellServiceRegistry = window.rendererAppShellServicesComposition.createShellServicesComposition({
    __proto__: ctx, appendClientLog, escapeHtml, setActiveView, getTurnViewModelsForActiveSession,
    get activateWorkspaceSession() { return activateWorkspaceSession; },
    get chatScrollCoordinator() { return chatScrollCoordinator; },
    get dismissToast() { return dismissToast; },
    get getCurrentMessageById() { return getCurrentMessageById; },
    get getSessionMessages() { return getSessionMessages; },
    get scrollMessageIntoView() { return scrollMessageIntoView; },
    get shellArtifactBridge() { return shellArtifactBridge; },
    get showShellErrorToast() { return showShellErrorToast; },
    get showToastMessage() { return showToastMessage; },
    get toErrorMessage() { return toErrorMessage; },
  });
  const {
    initializeEagerServices, applyFeatureStatePayload, refreshFeatureState, refreshWorkspaceRootState,
    refreshPhasePercentiles, resetPhasePercentiles, hydrateCachedLazyShellState, queueStartupLazyHydration,
    handleWorkspaceRootChoose, clearWorkspaceRoot, getProjectSwitcher, getPersonalityActiveFileSafe,
    setPersonalityDraftSafe, refreshPersonalityWorkspaceSafe, renderPersonalityEditorSafe,
    handlePersonalityTabChangeSafe, handlePersonalitySaveSafe, handlePersonalityResetSafe,
    handlePersonalityOpenFolderSafe, hasPersonalityUnsavedChangesSafe, refreshProactiveStateSafe,
    handleUseProactiveSuggestionMessageSafe, refreshSkillsStateSafe, renderSkillsManagerSafe,
    updateSkillsSettingsSafe, openSkillsScopeFolderSafe, bindSkillsShellEventsSafe, refreshOfflineStateSafe,
    renderOfflineManagerSafe, bindOfflineShellEventsSafe, handleOfflineModeChangeSafe, refreshApprovedMemoriesSafe,
    refreshPendingMemoriesSafe, refreshMemoryStatusSafe, renderApprovedMemoryManagerSafe, ensureIdeLoaded,
    renderIdeSafe, activateIdeSafe, layoutIdeEditorSafe, reconcileChatDockHostSafe,
    prepareChatDockSessionTransitionSafe, getIdeCommandItemsSafe, openIdeChangeDiffSafe, openIdeFileAtLineSafe, revealIdePathSafe,
    openIdeTestOutputSafe, openIdeGitViewSafe, revealIdeChangesSafe, openIdeHelpOverlaySafe,
    openIdeTerminalSafe, runIdeTaskTerminalSafe, closeIdeBottomPanelSafe,
    refreshCompanionStateSafe, shouldRenderHomePanelSafe, renderHomePanelSafe, applyCompanionPayload,
    getAvailableCompanionDeferPresets,
    renderDashboardSafe, refreshAwayDigestSafe = (...a) => Promise.resolve(state.awayDigestReader?.refresh?.(...a) ?? false),
    initSetupControllerSafe, applySetupBackendStatusSafe, openSetupTileSafe, showSetupHelpSafe, showFactoryResetSafe, handleRunSetupAgain,
  } = shellServiceRegistry;
  if (prefetchedFeatureState) applyFeatureStatePayload(prefetchedFeatureState);
  if (window.jennyShell?.features?.onChanged) {
    registerRendererCleanup(window.jennyShell.features.onChanged((payload) => {
      applyFeatureStatePayload(payload);
      // Re-apply chrome after a Settings change so the rail and the per-view
      // panel layout stay in sync (e.g. palette or sidebar preference edits).
      topNavShellController?.applyViewChrome?.();
      renderSettings();
      chatShellController?.syncTurnElapsedClock?.();
    }));
  }
  // Row 88 D6: chatUi / windowUi / IDE-preference commits from any writer repaint the shell and Settings at once.
  const externalSettingsSync = window.rendererSettingsSupport?.createExternalSettingsSync?.({
    state, windowRef: window, renderAll: () => renderAll(), renderSettings: () => renderSettings(), appendClientLog: (...a) => appendClientLog(...a),
    reapplyIde: () => { if (state.ui?.activeView === 'ide') activateIdeSafe?.(); },
  });
  if (externalSettingsSync) registerRendererCleanup(externalSettingsSync.bind());
  initializeEagerServices();
  const composerStatusController = (window.rendererComposerV2Status || {}).createComposerV2StatusController?.({
    state,
    callbacks: {
      renderComposerStatusNotice: (...a) => renderComposerStatusNotice(...a),
      appendClientLog: (...a) => appendClientLog(...a),
      getRendererElapsedMs: (...a) => getRendererElapsedMs(...a),
      renderSessionComposer: (sessionId) => window.rendererAppPaneComposition?.getPaneComposition?.()?.renderSessionPane?.(sessionId, 'composer'), // W3-1
    },
  }) || null;
  const {
    buildAttachmentBudget = () => ({ accepted: [], skipped: [] }),
    buildAttachmentToastMessage = noopStr,
    // escapeSelectorValue is forwarded to the viewport runtime (syncThinkingBlockNode
    // builds a `[data-...]` selector from it). It is NOT in this composition's ctx and
    // is created later by the controller composition, so without this defaulted local
    // binding the with(ctx) wrappers below (escapeSelectorValue: (...a) => ...) throw
    // ReferenceError the moment a reasoning block is synced. Mirror the controller
    // composition's default.
    escapeSelectorValue = (v) => String(v || ''), clearAttachmentNotice = noop,
    setComposerStatusNotice = noop, clearComposerStatusNotice = noop,
    getActiveSendPreflight = noopNull, isSendPreflightPending = noopFalse,
    getActiveStreamSessionId = noopStr, isAnySendBusy = noopFalse,
    isSessionStreaming = noopFalse, hasPendingToolApprovalForSession = noopFalse,
    isSendBusy = noopFalse,
  } = composerStatusController || {};
  // Toasts, error center/intake, update dialog, backend status (renderer-app-notices-composition.js).
  const {
    dismissToast, renderToastViewport, showToastMessage, showShellErrorToast, toErrorMessage, showSessionActionError,
    showComposerActionError, reportError, reportErrorWhenActive, errorCenterStore, shellStatusController,
    getRuntimePreferenceSnapshot, renderComposerStatusNotice, handleActivityChange, runRuntimePreferenceActivity,
    persistRuntimePreferences, syncBackendNotice, retryBackendStart, _handleLifecycleProgress,
    _handleLifecycleBackendStatus, beginModelSwitch, updateModelSwitch, failModelSwitch,
  } = window.rendererAppNoticesComposition.createNoticesComposition({
    __proto__: ctx, appendClientLog, clearComposerStatusNotice, getActiveSession, getCurrentRuntimePreferences,
    getRendererElapsedMs, getRuntimePreferencesFromSession, patchSessionSummary, renderPersonalityEditorSafe,
    runDeferredVisualStartup, setActiveView, setComposerStatusNotice, syncRuntimeDraftFromActiveSession,
    get getVisibleSessionMessages() { return getVisibleSessionMessages; }, get renderSessions() { return renderSessions; },
  });
  notifyStartupBootViewReadyRef = (shellStatusController || {}).notifyBootViewReady || noop; // bind late ref
  syncStartupBackendStatusRef = _handleLifecycleBackendStatus;
  /* transcriptRenderer */
  const transcriptRenderer = transcriptUtils.createTranscriptRenderer({
    MESSAGE_STATUS, buildMessageActionModel, escapeHtml,
    getApprovalCardState: (ref) => globalThis.rendererApprovalBlock?.resolveApprovalCardState?.(state, ref) || null,
    getReasoningEntries: (...a) => getReasoningEntries(...a),
    groupReasoningByPhase,
    isInteractiveRecapExpanded: (recapId, sessionId) => {
      const resolvedSessionId = String(sessionId || state.currentSessionId || '').trim();
      const resolvedRecapId = String(recapId || '').trim();
      if (!resolvedSessionId || !resolvedRecapId) {
        return false;
      }
      const expandedBySession = state.ui?.interactiveRecapExpandedBySession;
      if (!expandedBySession || typeof expandedBySession.get !== 'function') {
        return false;
      }
      const expandedSet = expandedBySession.get(resolvedSessionId);
      return Boolean(expandedSet && typeof expandedSet.has === 'function' && expandedSet.has(resolvedRecapId));
    },
    /* The compaction notice re-renders by innerHTML, so its open/closed flag
       has to come from state on every render rather than living in the DOM. */
    isContextCompactionExpanded: (...a) => isContextCompactionExpanded(...a),
    getThinkingSummary, shouldShowThinkingToggle, thinkingController, toolCallUtils,
    renderMarkdown: (...a) => (window.markdownUtils?.renderMarkdown ? window.markdownUtils.renderMarkdown(...a) : escapeHtml(String(a[0] || ''))),
    renderStreamingMarkdownUnits: (...a) => (
      window.markdownUtils?.renderStreamingMarkdownUnits
        ? window.markdownUtils.renderStreamingMarkdownUnits(...a)
        : {
            html: escapeHtml(String(a[0] || '')),
            units: [],
            fingerprints: [],
            changedStartIndex: -1,
          }
    ),
  });
  const {
    renderMessageAttachments,
    buildInteractiveRecapViewModel,
    renderInteractiveRoundRecap,
    renderMessageHoverRow,
    renderAgentStatusWidget,
    renderAssistantFailureNotice,
    renderContextCompactedNotice,
    renderThinkingWidget,
    renderToolCallBlock,
    setToolCallExpansion,
    renderProactiveSuggestionBlock,
    renderSlashCommandOutput,
  } = transcriptRenderer;
  registerRendererCleanup(() => transcriptRenderer.dispose?.());
  /* interactivePanelController */
  const interactivePanelController = interactivePanelUtils.createInteractivePanelRenderer?.({
    state, dom: { composer, chatInput, chatTimeline },
    callbacks: { getInteractiveQuestionOptions, isInteractiveQuestionAnswered, areInteractiveQuestionsAnswered, isInteractiveOtherTrigger, isSendBusy, escapeHtml, getPendingQuestionBatch: (...a) => getPendingQuestionBatch(...a), hasStalePendingQuestionBatch: (...a) => hasStalePendingQuestionBatch(...a), getInteractiveDraft: (...a) => getInteractiveDraft(...a), escapeSelectorValue: (...a) => escapeSelectorValue(...a) },
  }) || null;
  const {
    queueInteractiveComposerFocus = noop,
    renderComposerInteractivePanel = noop, clearStalledTimer = noop,
  } = interactivePanelController || {};
  registerRendererCleanup(() => clearStalledTimer?.());
  /* chat pane surface cluster (split view W0-1): the scroll coordinator and the viewport
     controller for ONE pane, constructed and wired together in renderer/chat/renderer-chat-pane-surface-controllers.js because this file
     sat at the 1015-line hard cap. paneId 0 is today's only chat surface; the seam is
     inert until a later slice builds a second pane. Its dispose() runs viewport ->
     scroll, the order the cleanup registry (which pops LIFO) already tears them down in. */
  // Pane 0's own session, not the focused mirror (one pane: currentSessionId). Pane 1 overrides all three readers.
  const paneZeroSessionId = () => window.rendererPaneVisibilityUtils?.resolvePaneSessionId?.(state, 0) ?? state.currentSessionId;
  const buildPaneSurface = (pane = {}) => (window.rendererChatPaneSurfaceControllers || {}).createChatPaneSurfaceControllers?.({
    state, paneId: pane.paneId || 0, windowRef: window, constants: { MESSAGE_STATUS }, followState: pane.followState, getSessionId: pane.getSessionId || paneZeroSessionId,
    dom: { chatView, chatSurfaceEffects, chatSurfaceEffectLeft, chatThreadStage, chatThreadColumn, composerWrap, chatTimeline, chatThreadScroll, chatTimelineUtilityCluster: document.getElementById('chatTimelineUtilityCluster'), ...pane.dom },
    factories: { scrollCoordinatorUtils: window.rendererChatScrollCoordinator || {}, viewportUtils },
    controllers: { thinkingController, reducedMotionQuery, ...pane.controllers },
    callbacks: {
      appendClientLog: (...a) => appendClientLog(...a), renderJumpControls: (...a) => renderComposerJumpControls?.(...a),
      isStreaming: () => isSessionStreaming?.(paneZeroSessionId()) === true,
      mergeReasoningEntries, deriveFollowLatestFromScroll, shouldAutoScrollThread, escapeSelectorValue: (...a) => escapeSelectorValue(...a), getCurrentSessionMessages: () => getSessionMessages(paneZeroSessionId()), buildInteractiveRecapViewModel: (...a) => buildInteractiveRecapViewModel(...a), renderMessages: (...a) => renderMessages(...a), updateAssistantSpritePosition: (...a) => updateAssistantSpritePosition(...a),
      ...pane.overrides,
    },
  }) || {};
  const paneSurface = buildPaneSurface();
  const chatScrollCoordinator = paneSurface.scrollCoordinator || null;
  const viewportController = paneSurface.viewport || null;
  registerRendererCleanup(() => paneSurface?.dispose?.());
  const {
    composerLayoutRuntime, getReasoningEntries, mergeMessageReasoning, getScrollMetrics, getScrollBehavior,
    setFollowLatest, syncThreadScrollState, getComposerSafeOffset, measureComposerSafeOffset, updateComposerSafeOffset,
    initializeComposerLayoutObserver, scrollThreadToTop, scrollThreadToBottom, scrollMessageIntoView, viewportReveal,
    getCurrentMessageById, isInteractiveRoundRecapExpanded, pruneInteractiveRoundRecapExpansionState, toggleInteractiveRoundRecap,
    isContextCompactionExpanded, toggleContextCompactionDetails,
    clearCopyFeedback, showCopyFeedback, syncRenderedThinkingPanels, syncThinkingBlockNode, scheduleMessageViewportSync,
    disposeViewportController,
  } = paneSurface.viewportApi || {};
  if (lifecycleController) lifecycleController.viewportReveal = viewportReveal;
  let chatWayfinderController = null;
  /* sessionManager */
  const buildArtifactsFromMessages = typeof artifactsUtils.buildArtifactsFromMessages === 'function'
    ? artifactsUtils.buildArtifactsFromMessages
    : () => [];
  const codeReviewRailUtils = window.rendererCodeReviewRail || {};
  const diffHunksRenderUtils = window.rendererDiffHunksRender || {};
  const jennyChangeLedgerUtils = window.rendererJennyChangeLedger || {};
  function getTurnViewModelsForActiveSession(sessionId) { // the side panel passes its owning chat (split view)
    const ctx = uiRuntime.projectionContextBySession?.get?.(String(sessionId || state.currentSessionId || '').trim())?.currentContext;
    if (!ctx || !(ctx.viewModelByTurnId instanceof Map)) return [];
    return Array.from(ctx.viewModelByTurnId.values());
  }
  // Pane 0 then pane 1: the side-panel column motion brackets each reflow with their reader anchors.
  const getScrollCoordinators = () => [chatScrollCoordinator, window.rendererAppPaneComposition?.getPaneComposition?.()?.getPane?.(1)?.surface?.scrollCoordinator].filter(Boolean);
  const shellArtifactBridge = (window.rendererShellArtifactBridgeUtils || {}).createShellArtifactBridge?.({
    state,
    windowRef: window,
    dom: {
      workspace,
      sidebar,
      sidebarResizer,
      chatView,
      chatTimeline,
      artifactReviewPanel,
    },
    lazyDom: {
      getArtifactsDom: (...a) => lazyDom.getArtifactsDom(...a),
    },
    constants: {
      ARTIFACT_REVIEW_MIN_STAGE_WIDTH: 1080,
    },
    buildArtifactsFromMessages,
    artifactsUtils,
    registerCleanup: registerRendererCleanup,
    callbacks: {
      escapeHtml,
      getActiveSession: (...a) => getActiveSession(...a),
      getSessionMonogram: (...a) => getSessionMonogram(...a),
      setActiveView: (...a) => setActiveView(...a),
      scrollMessageIntoView: (...a) => scrollMessageIntoView(...a),
      renderAll: (...a) => renderAll(...a),
      updateComposerSafeOffset: (...a) => updateComposerSafeOffset(...a),
      appendClientLog: (...a) => appendClientLog(...a),
      showToastMessage: (...a) => showToastMessage(...a),
      toErrorMessage: (...a) => toErrorMessage(...a),
      activateWorkspaceSession: (...a) => activateWorkspaceSession(...a),
      getProjectSwitcher: (...a) => getProjectSwitcher(...a),
      getProjectionContext: () => uiRuntime.projectionContextBySession?.get?.(String(state.currentSessionId || '').trim())?.currentContext || null,
      getChatTimelineRowModelEnabled: (...a) => getChatTimelineRowModelEnabled(...a),
      recordChatTimelineRolloutSignal: (...a) => recordChatTimelineRolloutSignal(...a),
      rollbackChatTimelineRowModel: (...a) => rollbackChatTimelineRowModel(...a),
      getScrollCoordinators,
    },
    codeReview: {
      codeReviewRailFactory: codeReviewRailUtils.createCodeReviewRail,
      // The Changes view loads on first open (row 34 S5); the IDE manifest lists the same files.
      loadChangesView: () => codeReviewRailUtils.loadChangesViewModules?.({
        ensureScript: window.scriptLoaderUtils?.ensureScript,
        windowRef: window,
        log: (...a) => appendClientLog(...a),
      }),
      renderDiffHunks: diffHunksRenderUtils.renderDiffHunks,
      buildJennyChangeLedgerFromTurnViewModels: jennyChangeLedgerUtils.buildJennyChangeLedgerFromTurnViewModels,
      getTurnViewModelsForActiveSession,
      getSessionMessages: (sessionId) => getSessionMessages(sessionId),
      // A chat docked in the Workspace shows its review in the dock's Changes tab.
      revealInDock: (payload) => revealIdeChangesSafe({ turnId: payload?.turnId, fileKey: payload?.fileKey, scope: payload?.scope, toolCallId: payload?.toolCallId, secondChat: Boolean(payload?.contextNode?.closest?.('[data-pane-hosted]')) }),
      openChangeInWorkspace: (changeId) => {
        setActiveView('ide');
        return openIdeChangeDiffSafe(changeId);
      },
      getWorkspaceId: () => String(state.workspace?.activeWorkspaceId || 'default'),
      showComposerActionError: (error, title) => showComposerActionError?.(error, title),
    },
  }) || {};
  const {
    isArtifactReviewVisible = noopFalse,
    getArtifactsForSession = noopArr,
    invalidateSessionArtifacts = noop,
    rekeySessionArtifacts = noopStr,
    pruneSessionArtifacts = noop,
    resetArtifactsState = noop,
    openArtifactTarget = noopAsync,
    openCodeReviewTarget = noopAsync, openFilePreviewTarget = noopAsync,
    renderArtifactReviewPanelSafe = noop,
    syncArtifactReviewLayout = noop,
    selectArtifact = noop,
  } = shellArtifactBridge;
  window.rendererChatWorkspaceDetail?.configure?.({ openActivity: () => contextPanelController?.openActivity?.(), openInGit: async () => { setActiveView('ide'); return openIdeGitViewSafe(); } }); // session rail rows (row 59 cp2)
  /* contextPanelController */
  const contextPanelUtils = window.rendererChatActivity || {};
  const contextPanelController = (typeof contextPanelUtils.createContextPanelController === 'function'
    ? contextPanelUtils.createContextPanelController : null)?.({
    state,
    dom: { chatContextPanel },
    callbacks: {
      setActiveView: (...a) => setActiveView(...a),
      updateComposerSafeOffset: (...a) => updateComposerSafeOffset(...a),
      closeArtifact: () => shellArtifactBridge.collapseSidePanel?.(),
      openActivityOutput: async (output) => {setActiveView('ide');await openIdeTestOutputSafe(output);},
      sidePanel: shellArtifactBridge.sidePanel || null, // split view W3-2: the panel owner (renderer-shell-artifact-bridge.js)
    },
  }) || null;
  const sessionManager = sessionUtils.createSessionManager?.({
    state,
    constants: { INTERACTIVE_SEQUENCE_IDLE, INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE, INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED, MAX_INTERACTIVE_ROUNDS, MAX_INTERACTIVE_QUESTIONS },
    callbacks: {
      normalizeChatMessage,
      normalizeChatMessages,
      isInteractiveOtherTrigger,
      getActiveSession,
      patchSessionSummary,
      rekeySessionArtifacts: (...a) => rekeySessionArtifacts(...a),
      clearProjectionContextCacheForSession: (...a) => clearProjectionContextCacheForSession(...a),
      rekeyProjectionContextCache: (...a) => rekeyProjectionContextCache(...a),
      onRemoveSessionState: (sessionId) => {
        fileDiffBindings.clearFileDiffSession?.(sessionId);
        saveReasoningPhaseExpansionPreferences();
        ctx.transcriptViewController?.forgetSession?.(sessionId);
      },
      onRekeySessionState: (sourceSessionId, targetSessionId) => {
        saveReasoningPhaseExpansionPreferences();
        ctx.paneLayoutController?.rekey?.(sourceSessionId, targetSessionId);
        ctx.transcriptViewController?.rekeySession?.(sourceSessionId, targetSessionId);
        // Enqueue before acceptance can refresh summaries/restore the workspace.
        // The workspace owns focus: promotion must not activate a background tab.
        // A first send's optimistic chat never held a tab: give the promoted chat one
        // per the open-in-new-tab preference (default: the active tab's place) while on screen.
        workspaceStateController?.rekeySession(sourceSessionId, targetSessionId)
          .then((workspace) => (!workspace?.openSessionIds?.includes(targetSessionId)
            && String(state.currentSessionId || '').trim() === targetSessionId
            ? globalThis.sessionOpenPrefUtils?.openSessionPerPreference(workspaceStateController, targetSessionId) : workspace))
          .then(() => renderWorkspaceChrome())
          .catch((error) => appendClientLog('WARN', 'workspace.session_rekey_failed', {
            message: String(error?.message || error),
          }));
      },
      notifySessionMessagesReplaced: (sessionId, messages) => {
        invalidateSessionArtifacts(sessionId, messages);
        pruneInteractiveRoundRecapExpansionState(sessionId, messages);
      },
      appendClientLog: (...a) => appendClientLog(...a),
    },
  }) || null;
  registerRendererCleanup(() => sessionManager?.dispose?.());
  const {
    getSessionMessages = noopArr, getSessionTurnEventState = noopObj, getVisibleSessionMessages = noopArr,
    setSessionMessages = noop, setSessionTurnEventState = noop, createNormalizedMessage = noopObj,
    resolveSessionId = noopStr,
    normalizePendingQuestionBatch = noopNull, getPendingQuestionBatch = noopNull,
    getInteractiveSequenceState = () => 'idle',
    hasStalePendingQuestionBatch = noopFalse,
    clearStalePendingQuestionBatch = async () => false,
    clearInteractiveDraft = noop, ensureInteractiveDraft = noopNull,
    getInteractiveDraft = noopNull,
    buildInteractiveQuestionBatchVisibleText = noopStr, shouldForceInteractiveGuardrail = noopFalse,
    buildInteractiveSelectedAnswers = noopArr, buildInteractiveAnswerPrompt = noopStr,
    getCurrentSessionMessages = noopArr, getCurrentVisibleMessages = noopArr, estimateTokens = () => 0,
    upsertSessionSummary = noopNull, removeSessionState = noop, rekeySessionState = noopStr,
  } = sessionManager || {};
  // Shared collapse entry point for the rail, Settings, and command palette.
  function setSidebarCollapsed(collapsed) { topNavShellController?.setActivePanelCollapsed(Boolean(collapsed)); }
  function resetSidebarWidth() { topNavShellController?.resetActivePanelWidth?.(); }
  function finishSidebarResize(event) {
    if (sidebarRuntime.resizePointerId !== event.pointerId) return;
    sidebarResizer.classList.remove('dragging'); sidebarResizer.releasePointerCapture(event.pointerId);
    sidebarRuntime.resizePointerId = null; topNavShellController?.setPanelResizing?.(false);
    const panelState = topNavShellController?.getActivePanelState?.();
    if (panelState) topNavShellController?.setActivePanelWidth?.(panelState.width, { persist: true });
  }
  function handleSidebarResizeMove(event) {
    if (sidebarRuntime.resizePointerId !== event.pointerId) return;
    topNavShellController?.setActivePanelWidth?.(sidebarRuntime.startWidth + (event.clientX - sidebarRuntime.startX), { persist: false });
  }
  function handleSidebarResizeStart(event) {
    if (topNavShellController?.isActivePanelCollapsed?.()) return;
    if (Number.isFinite(Number(event.button)) && Number(event.button) !== 0) return;
    event.preventDefault();
    const panelState = topNavShellController?.getActivePanelState?.(); if (!panelState) return;
    sidebarRuntime.resizePointerId = event.pointerId; sidebarRuntime.startX = event.clientX; sidebarRuntime.startWidth = panelState.width;
    sidebarResizer.classList.add('dragging'); topNavShellController?.setPanelResizing?.(true); sidebarResizer.setPointerCapture(event.pointerId);
  }
  function handleSidebarResizeKeydown(event) {
    if (topNavShellController?.isActivePanelCollapsed?.()) return;
    const panelState = topNavShellController?.getActivePanelState?.();
    if (!panelState) return;
    if (event.key === 'ArrowLeft') { event.preventDefault(); topNavShellController.setActivePanelWidth(panelState.width - SIDEBAR_KEYBOARD_STEP); return; }
    if (event.key === 'ArrowRight') { event.preventDefault(); topNavShellController.setActivePanelWidth(panelState.width + SIDEBAR_KEYBOARD_STEP); return; }
    if (event.key === 'Home') { event.preventDefault(); topNavShellController.resetActivePanelWidth(); }
  }
  // Sidebar, top navigation, Chats panel, workspace tabs (renderer-app-navigation-composition.js).
  const {
    updateTokenDisplay, renderAttachmentTray, renderSessions, setRovingChatSession, toggleChatsScope,
    multiStreamController, syncWorkspaceFromStore, applyWorkspaceSnapshot, activateWorkspaceSession,
    handleLinkedSessionPopover, renderWorkspaceChrome, handleWorkspaceShortcut,
  } = window.rendererAppNavigationComposition.createNavigationComposition({
    __proto__: ctx, appendClientLog, escapeHtml, getSessionMonogram, isArtifactReviewVisible, setActiveView,
    syncArtifactReviewLayout, updateComposerSafeOffset, getProjectSwitcher, showToastMessage, attachGlobalErrorBoundary,
    detachGlobalErrorBoundary, lifecycleController, patchSessionSummary, showSessionActionError, setSidebarCollapsed,
    get topNavShellController() { return topNavShellController; },
    set topNavShellController(value) { topNavShellController = value; },
    get _applySidebarLayout() { return _applySidebarLayout; },
    set _applySidebarLayout(value) { _applySidebarLayout = value; },
  });
    result = {
      lifecycleController, escapeHtml, getActiveSession, getRuntimePreferencesFromSession, getCurrentRuntimePreferences,
      patchSessionSummary, buildModelOptionMarkup, adjustChatZoomPercent, applyChatZoomPercent, resetChatZoomPercent,
      appendClientLog, getRendererElapsedMs, pushIncomingLog, resetLogsViewState, setActiveView,
      applyAppearancePreferences, isDefaultAppearancePreferences, buildSelectOptionMarkup,
      getChatTimelineRowModelEnabled, recordChatTimelineRolloutSignal, refreshDefaultChatTimelineBatch4Preference, rollbackChatTimelineRowModel,
      refreshFeatureState,
      refreshWorkspaceRootState, refreshPhasePercentiles, resetPhasePercentiles, hydrateCachedLazyShellState, queueStartupLazyHydration, handleWorkspaceRootChoose, clearWorkspaceRoot, getProjectSwitcher,
      getPersonalityActiveFileSafe, setPersonalityDraftSafe, refreshPersonalityWorkspaceSafe, renderPersonalityEditorSafe, handlePersonalityTabChangeSafe, handlePersonalitySaveSafe, handlePersonalityResetSafe,
      handlePersonalityOpenFolderSafe, hasPersonalityUnsavedChangesSafe,
      refreshProactiveStateSafe, handleUseProactiveSuggestionMessageSafe, refreshSkillsStateSafe, renderSkillsManagerSafe, updateSkillsSettingsSafe,
      openSkillsScopeFolderSafe, bindSkillsShellEventsSafe, refreshOfflineStateSafe, renderOfflineManagerSafe,
      bindOfflineShellEventsSafe, handleOfflineModeChangeSafe, refreshApprovedMemoriesSafe, refreshPendingMemoriesSafe, refreshMemoryStatusSafe, renderApprovedMemoryManagerSafe,
      renderIdeSafe, activateIdeSafe, layoutIdeEditorSafe,
      reconcileChatDockHostSafe, getIdeCommandItemsSafe, openIdeHelpOverlaySafe, openIdeChangeDiffSafe, openIdeFileAtLineSafe, revealIdePathSafe,
      openIdeTerminalSafe, runIdeTaskTerminalSafe, closeIdeBottomPanelSafe,
      refreshCompanionStateSafe, shouldRenderHomePanelSafe, renderHomePanelSafe,
      applyCompanionPayload, getAvailableCompanionDeferPresets, initSetupControllerSafe, applySetupBackendStatusSafe, openSetupTileSafe,
      showSetupHelpSafe, showFactoryResetSafe, handleRunSetupAgain, buildAttachmentBudget,
      setComposerStatusNotice, clearComposerStatusNotice, getActiveSendPreflight, isSendPreflightPending, getActiveStreamSessionId, isAnySendBusy, isSessionStreaming,
      hasPendingToolApprovalForSession, isSendBusy,
      dismissToast, renderToastViewport, showToastMessage, showShellErrorToast, toErrorMessage, showSessionActionError, showComposerActionError, reportError, reportErrorWhenActive, errorCenterStore, shellStatusController,
      getRuntimePreferenceSnapshot, renderComposerStatusNotice, handleActivityChange, runRuntimePreferenceActivity, persistRuntimePreferences, syncBackendNotice, retryBackendStart, _handleLifecycleProgress, _handleLifecycleBackendStatus,
      beginModelSwitch, updateModelSwitch, failModelSwitch,
      renderMessageAttachments, buildInteractiveRecapViewModel, renderInteractiveRoundRecap, renderMessageHoverRow, renderAgentStatusWidget, renderAssistantFailureNotice, renderContextCompactedNotice, renderThinkingWidget,
      renderToolCallBlock, setToolCallExpansion, renderProactiveSuggestionBlock, renderSlashCommandOutput, queueInteractiveComposerFocus, renderComposerInteractivePanel,
      chatScrollCoordinator, composerLayoutRuntime, mergeMessageReasoning, getScrollMetrics, setFollowLatest, syncThreadScrollState,
      updateComposerSafeOffset, scrollThreadToTop, scrollThreadToBottom, scrollMessageIntoView, viewportReveal, getCurrentMessageById,
      isInteractiveRoundRecapExpanded, pruneInteractiveRoundRecapExpansionState, toggleInteractiveRoundRecap, isContextCompactionExpanded, toggleContextCompactionDetails, showCopyFeedback, syncThinkingBlockNode, scheduleMessageViewportSync,
      disposeViewportController, chatWayfinderController, shellArtifactBridge, getArtifactsForSession, selectArtifact,
      invalidateSessionArtifacts, pruneSessionArtifacts, resetArtifactsState, isArtifactReviewVisible, renderArtifactReviewPanelSafe,
      openArtifactTarget, openCodeReviewTarget, openFilePreviewTarget, contextPanelController, getSessionMessages, setSessionMessages, getSessionTurnEventState,
      setSessionTurnEventState, getCurrentSessionMessages, getVisibleSessionMessages, getCurrentVisibleMessages, createNormalizedMessage, resolveSessionId,
      normalizePendingQuestionBatch, getPendingQuestionBatch, getInteractiveSequenceState, hasStalePendingQuestionBatch,
      clearInteractiveDraft, ensureInteractiveDraft, getInteractiveDraft,
      buildInteractiveQuestionBatchVisibleText, shouldForceInteractiveGuardrail, buildInteractiveSelectedAnswers, buildInteractiveAnswerPrompt,
      estimateTokens, getLatestUserMessageId,
      upsertSessionSummary, removeSessionState, rekeySessionState,
      updateTokenDisplay, renderAttachmentTray, renderSessions, setSidebarCollapsed, resetSidebarWidth, setRovingChatSession, toggleChatsScope, handleSidebarResizeStart, handleSidebarResizeMove,
      finishSidebarResize, handleSidebarResizeKeydown, multiStreamController, syncWorkspaceFromStore, applyWorkspaceSnapshot, activateWorkspaceSession,
      handleLinkedSessionPopover, renderWorkspaceChrome, handleWorkspaceShortcut,
      workspaceStateController, workspaceChromeController, buildPaneSurface,
    };
    }
    return result || {};
  }

  root.rendererAppLifecycleComposition = {
    createLifecycleComposition,
  };
})(window);
