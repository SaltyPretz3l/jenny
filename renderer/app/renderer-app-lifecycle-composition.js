(function (root) {
  async function createLifecycleComposition(ctx) {
  // Late-bound: constructed after the sidebar controller below; the lifecycle
  // callbacks bag closes over it so applyViewChrome routes through the top
  // navigation shell once it exists (the legacy layout is the fallback before).
  let topNavShellController = null;
  // Late-bound like topNavShellController (bound below) so hydrateHomeView can signal the startup overlay.
  let notifyStartupBootViewReadyRef = null;
  let syncStartupBackendStatusRef = null;
  // Bound by the navigation section below (through the accessors it is handed).
  let workspaceStateController = null;
  let workspaceChromeController = null;
  /* lifecycleController */
  const lifecycleController = ctx.lifecycleUtils.createLifecycleController?.({
    state: ctx.state, controllers: { thinkingController: ctx.thinkingController },
    constants: { APPEARANCE_STORAGE_KEY: ctx.APPEARANCE_STORAGE_KEY, TOAST_SOURCE: ctx.TOAST_SOURCE },
    dom: { chatInput: ctx.chatInput, composerAttachMenu: ctx.composerAttachMenu, composerAttachShortcut: ctx.composerAttachShortcut },
    callbacks: {
      normalizeReasoningEffort: ctx.normalizeReasoningEffort, loadStoredAppearancePreferences: ctx.loadStoredAppearancePreferences,
      getDefaultAppearancePreferences: ctx.getDefaultAppearancePreferences, normalizeAppearancePreferences: ctx.normalizeAppearancePreferences, applyAppearanceToDocument: ctx.applyAppearanceToDocument,
      getDefaultChatZoomPercent: () => ctx.DEFAULT_CHAT_ZOOM_PERCENT,
      normalizeChatZoomPercent: ctx.normalizeChatZoomPercent,
      applyChatZoomToDocument: ctx.applyChatZoomToDocument,
      saveStoredAppearancePreferences: ctx.saveStoredAppearancePreferences, getLatestUserMessageId: ctx.getLatestUserMessageId,
      renderComposerPopover: (...a) => ctx.renderComposerPopover(...a), renderAttachmentTray: (...a) => renderAttachmentTray(...a),
      clearAttachmentNotice: (...a) => clearAttachmentNotice(...a), buildAttachmentToastMessage: (...a) => buildAttachmentToastMessage(...a),
      showToastMessage: (...a) => showToastMessage(...a), renderAll: (...a) => ctx.renderAll(...a),
      /* EH-W9: flag-gated intake route (null when error_intake_routing is off). */
      reportError: (...a) => reportErrorWhenActive(...a),
      renderLayout: (...a) => ctx.renderLayout(...a), renderHeader: (...a) => ctx.renderHeader(...a),
      renderLogs: (...a) => ctx.renderLogs(...a), renderSettings: (...a) => ctx.renderSettings(...a),
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
      renderComposerState: (...a) => ctx.renderComposerState(...a),
      renderPersonalityEditor: (...a) => renderPersonalityEditorSafe(...a), syncBackendNotice: (...a) => syncBackendNotice(...a),
      renderSessions: (...a) => renderSessions(...a), refreshApprovedMemories: (...a) => refreshApprovedMemoriesSafe(...a),
      refreshPendingMemories: (...a) => refreshPendingMemoriesSafe(...a),
      refreshCompanionState: (...a) => refreshCompanionStateSafe(...a), refreshProactiveState: (...a) => refreshProactiveStateSafe(...a),
      refreshSkillsState: (...a) => refreshSkillsStateSafe(...a),
      refreshOfflineState: (...a) => refreshOfflineStateSafe(...a), refreshAwayDigest: (...a) => refreshAwayDigestSafe(...a),
      refreshPhasePercentiles: (...a) => refreshPhasePercentiles(...a),
      refreshPersonalityWorkspace: (...a) => refreshPersonalityWorkspaceSafe(...a), toErrorMessage: (...a) => toErrorMessage(...a),
      initializeComposerHolo: (...a) => ctx.initializeComposerHolo(...a), initializeComposerLayoutObserver: (...a) => initializeComposerLayoutObserver(...a),
      warmCodeHighlighting: () => ctx.codeHighlight.warmCodeHighlighting?.({ monacoUtils: ctx.monacoEditorUtils, root: ctx.document, log: appendClientLog }),
      disposeCodeHighlighting: () => ctx.codeHighlight.disposeCodeHighlighting?.(),
      applySidebarLayout: (...a) => ctx._applySidebarLayout(...a), updateComposerSafeOffset: (...a) => updateComposerSafeOffset(...a),
      applyViewChrome: (...a) => (topNavShellController ? topNavShellController.applyViewChrome(...a) : ctx._applySidebarLayout(...a)),
      updateAssistantSpritePosition: (...a) => ctx.updateAssistantSpritePosition(...a), hideAssistantSprite: (...a) => ctx.hideAssistantSprite(...a),
      clearComposerStatusNotice: (...a) => clearComposerStatusNotice(...a),
      getCurrentVisibleMessages: (...a) => getCurrentVisibleMessages(...a), getCurrentSessionMessages: (...a) => getCurrentSessionMessages(...a),
      getSessionMessages: (...a) => getSessionMessages(...a), setSessionMessages: (...a) => setSessionMessages(...a), setSessionTurnEventState: (...a) => setSessionTurnEventState(...a),
      scrollThreadToTop: (...a) => scrollThreadToTop(...a), scrollThreadToBottom: (...a) => scrollThreadToBottom(...a),
      scrollMessageIntoView: (...a) => scrollMessageIntoView(...a), isSendBusy: (...a) => isSendBusy(...a), isAnySendBusy: (...a) => isAnySendBusy(...a),
      setFollowLatest: (...a) => setFollowLatest(...a), clearStalePendingQuestionBatch: (...a) => clearStalePendingQuestionBatch(...a),
      getPendingQuestionBatch: (...a) => getPendingQuestionBatch(...a), clearInteractiveDraft: (...a) => clearInteractiveDraft(...a),
      getScrollMetrics: (...a) => getScrollMetrics(...a), createNormalizedMessage: (...a) => createNormalizedMessage(...a), upsertSessionSummary: (...a) => upsertSessionSummary(...a),
      removeSessionState: (...a) => removeSessionState(...a),
      restoreSettingsNavSection: () => ctx.settingsShellController?.restoreSettingsNavSection?.(),
      ensureSettingsSectionReady: (...a) => ctx.settingsShellController?.ensureSettingsSectionReady?.(...a),
      refreshSettingsSection: (...a) => ctx.settingsShellController?.refreshSettingsSection?.(...a),
      syncUsageVisibility: (...a) => ctx.settingsShellController?.syncUsageVisibility?.(...a),
      refreshActiveSurfaceEffect: (...a) => ctx.refreshActiveSurfaceEffect(...a),
      activateSurfaceEffect: (...a) => ctx.activateSurfaceEffect(...a),
      applySurfaceEffect: (...a) => ctx.applySurfaceEffect(...a),
      renderMessages: (...a) => ctx.renderMessages(...a),
      flushPendingStreamCommitsForSession: (...a) => ctx.flushPendingStreamCommitsForSession(...a),
      rehydrateSessionFromPersistedTurnEvents: (...a) => ctx.rehydrateSessionFromPersistedTurnEvents(...a),
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
  const bootPreferences = await ctx.window.rendererAppBootPreferencesComposition.createBootPreferencesComposition({
    __proto__: ctx, appendClientLog, loadAppearancePreferences,
  });
  if (bootPreferences.disposed) return {};
  const {
    getChatTimelineRowModelEnabled, recordChatTimelineRolloutSignal, refreshDefaultChatTimelineBatch4Preference,
    rollbackChatTimelineRowModel, prefetchedFeatureState,
  } = bootPreferences;
  // Shell services (renderer-app-shell-services-composition.js); the names bound below it are read through accessors.
  const shellServiceRegistry = ctx.window.rendererAppShellServicesComposition.createShellServicesComposition({
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
    openIdeTerminalSafe, runIdeTaskTerminalSafe, openIdeOutsideFilesSafe, closeIdeBottomPanelSafe,
    refreshCompanionStateSafe, shouldRenderHomePanelSafe, renderHomePanelSafe, applyCompanionPayload,
    getAvailableCompanionDeferPresets,
    renderDashboardSafe, refreshAwayDigestSafe = (...a) => Promise.resolve(ctx.state.awayDigestReader?.refresh?.(...a) ?? false),
    initSetupControllerSafe, applySetupBackendStatusSafe, openSetupTileSafe, showSetupHelpSafe, showFactoryResetSafe, handleRunSetupAgain,
  } = shellServiceRegistry;
  if (prefetchedFeatureState) applyFeatureStatePayload(prefetchedFeatureState);
  if (ctx.window.jennyShell?.features?.onChanged) {
    ctx.registerRendererCleanup(ctx.window.jennyShell.features.onChanged((payload) => {
      applyFeatureStatePayload(payload);
      // Re-apply chrome after a Settings change so the rail and the per-view
      // panel layout stay in sync (e.g. palette or sidebar preference edits).
      topNavShellController?.applyViewChrome?.();
      ctx.renderSettings();
      ctx.chatShellController?.syncTurnElapsedClock?.();
    }));
  }
  // Row 88 D6: chatUi / windowUi / IDE-preference commits from any writer repaint the shell and Settings at once.
  const externalSettingsSync = ctx.window.rendererSettingsSupport?.createExternalSettingsSync?.({
    state: ctx.state, windowRef: ctx.window, renderAll: () => ctx.renderAll(), renderSettings: () => ctx.renderSettings(), appendClientLog: (...a) => appendClientLog(...a),
    reapplyIde: () => { if (ctx.state.ui?.activeView === 'ide') activateIdeSafe?.(); },
  });
  if (externalSettingsSync) ctx.registerRendererCleanup(externalSettingsSync.bind());
  initializeEagerServices();
  const composerStatusController = (ctx.window.rendererComposerV2Status || {}).createComposerV2StatusController?.({
    state: ctx.state,
    callbacks: {
      renderComposerStatusNotice: (...a) => renderComposerStatusNotice(...a),
      appendClientLog: (...a) => appendClientLog(...a),
      getRendererElapsedMs: (...a) => getRendererElapsedMs(...a),
      renderSessionComposer: (sessionId) => ctx.window.rendererAppPaneComposition?.getPaneComposition?.()?.renderSessionPane?.(sessionId, 'composer'), // W3-1
    },
  }) || null;
  const {
    buildAttachmentBudget = () => ({ accepted: [], skipped: [] }),
    buildAttachmentToastMessage = ctx.noopStr,
    // escapeSelectorValue is forwarded to the viewport runtime (syncThinkingBlockNode
    // builds a `[data-...]` selector from it). It is NOT in this composition's ctx and
    // is created later by the controller composition, so without this defaulted local
    // binding the wrappers below (escapeSelectorValue: (...a) => ...) throw
    // ReferenceError the moment a reasoning block is synced. Mirror the controller
    // composition's default.
    escapeSelectorValue = (v) => String(v || ''), clearAttachmentNotice = ctx.noop,
    setComposerStatusNotice = ctx.noop, clearComposerStatusNotice = ctx.noop,
    getActiveSendPreflight = ctx.noopNull, isSendPreflightPending = ctx.noopFalse,
    getActiveStreamSessionId = ctx.noopStr, isAnySendBusy = ctx.noopFalse,
    isSessionStreaming = ctx.noopFalse, hasPendingToolApprovalForSession = ctx.noopFalse,
    isSendBusy = ctx.noopFalse,
  } = composerStatusController || {};
  // Toasts, error center/intake, update dialog, backend status (renderer-app-notices-composition.js).
  const {
    dismissToast, renderToastViewport, showToastMessage, showShellErrorToast, toErrorMessage, showSessionActionError,
    showComposerActionError, reportError, reportErrorWhenActive, errorCenterStore, shellStatusController,
    getRuntimePreferenceSnapshot, renderComposerStatusNotice, handleActivityChange, runRuntimePreferenceActivity,
    persistRuntimePreferences, syncBackendNotice, retryBackendStart, _handleLifecycleProgress,
    _handleLifecycleBackendStatus, beginModelSwitch, updateModelSwitch, failModelSwitch,
  } = ctx.window.rendererAppNoticesComposition.createNoticesComposition({
    __proto__: ctx, appendClientLog, clearComposerStatusNotice, getActiveSession, getCurrentRuntimePreferences,
    getRendererElapsedMs, getRuntimePreferencesFromSession, patchSessionSummary, renderPersonalityEditorSafe,
    runDeferredVisualStartup, setActiveView, setComposerStatusNotice, syncRuntimeDraftFromActiveSession,
    get getVisibleSessionMessages() { return getVisibleSessionMessages; }, get renderSessions() { return renderSessions; },
  });
  notifyStartupBootViewReadyRef = (shellStatusController || {}).notifyBootViewReady || ctx.noop; // bind late ref
  syncStartupBackendStatusRef = _handleLifecycleBackendStatus;
  /* transcriptRenderer */
  const transcriptRenderer = ctx.transcriptUtils.createTranscriptRenderer({
    MESSAGE_STATUS: ctx.MESSAGE_STATUS, buildMessageActionModel: ctx.buildMessageActionModel, escapeHtml,
    getApprovalCardState: (ref) => ctx.globalThis.rendererApprovalBlock?.resolveApprovalCardState?.(ctx.state, ref) || null,
    getReasoningEntries: (...a) => getReasoningEntries(...a),
    groupReasoningByPhase: ctx.groupReasoningByPhase,
    isInteractiveRecapExpanded: (recapId, sessionId) => {
      const resolvedSessionId = String(sessionId || ctx.state.currentSessionId || '').trim();
      const resolvedRecapId = String(recapId || '').trim();
      if (!resolvedSessionId || !resolvedRecapId) {
        return false;
      }
      const expandedBySession = ctx.state.ui?.interactiveRecapExpandedBySession;
      if (!expandedBySession || typeof expandedBySession.get !== 'function') {
        return false;
      }
      const expandedSet = expandedBySession.get(resolvedSessionId);
      return Boolean(expandedSet && typeof expandedSet.has === 'function' && expandedSet.has(resolvedRecapId));
    },
    /* The compaction notice re-renders by innerHTML, so its open/closed flag
       has to come from state on every render rather than living in the DOM. */
    isContextCompactionExpanded: (...a) => isContextCompactionExpanded(...a),
    getThinkingSummary: ctx.getThinkingSummary, shouldShowThinkingToggle: ctx.shouldShowThinkingToggle, thinkingController: ctx.thinkingController, toolCallUtils: ctx.toolCallUtils,
    renderMarkdown: (...a) => (ctx.window.markdownUtils?.renderMarkdown ? ctx.window.markdownUtils.renderMarkdown(...a) : escapeHtml(String(a[0] || ''))),
    renderStreamingMarkdownUnits: (...a) => (
      ctx.window.markdownUtils?.renderStreamingMarkdownUnits
        ? ctx.window.markdownUtils.renderStreamingMarkdownUnits(...a)
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
  ctx.registerRendererCleanup(() => transcriptRenderer.dispose?.());
  /* interactivePanelController */
  const interactivePanelController = ctx.interactivePanelUtils.createInteractivePanelRenderer?.({
    state: ctx.state, dom: { composer: ctx.composer, chatInput: ctx.chatInput, chatTimeline: ctx.chatTimeline },
    callbacks: { getInteractiveQuestionOptions: ctx.getInteractiveQuestionOptions, isInteractiveQuestionAnswered: ctx.isInteractiveQuestionAnswered, areInteractiveQuestionsAnswered: ctx.areInteractiveQuestionsAnswered, isInteractiveOtherTrigger: ctx.isInteractiveOtherTrigger, isSendBusy, escapeHtml, getPendingQuestionBatch: (...a) => getPendingQuestionBatch(...a), hasStalePendingQuestionBatch: (...a) => hasStalePendingQuestionBatch(...a), getInteractiveDraft: (...a) => getInteractiveDraft(...a), escapeSelectorValue: (...a) => escapeSelectorValue(...a) },
  }) || null;
  const {
    queueInteractiveComposerFocus = ctx.noop,
    renderComposerInteractivePanel = ctx.noop, clearStalledTimer = ctx.noop,
  } = interactivePanelController || {};
  ctx.registerRendererCleanup(() => clearStalledTimer?.());
  /* chat pane surface cluster (split view W0-1): the scroll coordinator and the viewport
     controller for ONE pane, constructed and wired together in renderer/chat/renderer-chat-pane-surface-controllers.js because this file
     sat at the 1015-line hard cap. paneId 0 is today's only chat surface; the seam is
     inert until a later slice builds a second pane. Its dispose() runs viewport ->
     scroll, the order the cleanup registry (which pops LIFO) already tears them down in. */
  // Pane 0's own session, not the focused mirror (one pane: currentSessionId). Pane 1 overrides all three readers.
  const paneZeroSessionId = () => ctx.window.rendererPaneVisibilityUtils?.resolvePaneSessionId?.(ctx.state, 0) ?? ctx.state.currentSessionId;
  const buildPaneSurface = (pane = {}) => (ctx.window.rendererChatPaneSurfaceControllers || {}).createChatPaneSurfaceControllers?.({
    state: ctx.state, paneId: pane.paneId || 0, windowRef: ctx.window, constants: { MESSAGE_STATUS: ctx.MESSAGE_STATUS }, followState: pane.followState, getSessionId: pane.getSessionId || paneZeroSessionId,
    dom: { chatView: ctx.chatView, chatSurfaceEffects: ctx.chatSurfaceEffects, chatSurfaceEffectLeft: ctx.chatSurfaceEffectLeft, chatThreadStage: ctx.chatThreadStage, chatThreadColumn: ctx.chatThreadColumn, composerWrap: ctx.composerWrap, chatTimeline: ctx.chatTimeline, chatThreadScroll: ctx.chatThreadScroll, chatTimelineUtilityCluster: ctx.document.getElementById('chatTimelineUtilityCluster'), ...pane.dom },
    factories: { scrollCoordinatorUtils: ctx.window.rendererChatScrollCoordinator || {}, viewportUtils: ctx.viewportUtils },
    controllers: { thinkingController: ctx.thinkingController, reducedMotionQuery: ctx.reducedMotionQuery, ...pane.controllers },
    callbacks: {
      appendClientLog: (...a) => appendClientLog(...a), renderJumpControls: (...a) => ctx.renderComposerJumpControls?.(...a),
      isStreaming: () => isSessionStreaming?.(paneZeroSessionId()) === true,
      mergeReasoningEntries: ctx.mergeReasoningEntries, deriveFollowLatestFromScroll: ctx.deriveFollowLatestFromScroll, shouldAutoScrollThread: ctx.shouldAutoScrollThread, escapeSelectorValue: (...a) => escapeSelectorValue(...a), getCurrentSessionMessages: () => getSessionMessages(paneZeroSessionId()), buildInteractiveRecapViewModel: (...a) => buildInteractiveRecapViewModel(...a), renderMessages: (...a) => ctx.renderMessages(...a), updateAssistantSpritePosition: (...a) => ctx.updateAssistantSpritePosition(...a),
      ...pane.overrides,
    },
  }) || {};
  const paneSurface = buildPaneSurface();
  const chatScrollCoordinator = paneSurface.scrollCoordinator || null;
  const viewportController = paneSurface.viewport || null;
  ctx.registerRendererCleanup(() => paneSurface?.dispose?.());
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
  const buildArtifactsFromMessages = typeof ctx.artifactsUtils.buildArtifactsFromMessages === 'function'
    ? ctx.artifactsUtils.buildArtifactsFromMessages
    : () => [];
  const codeReviewRailUtils = ctx.window.rendererCodeReviewRail || {};
  const diffHunksRenderUtils = ctx.window.rendererDiffHunksRender || {};
  const jennyChangeLedgerUtils = ctx.window.rendererJennyChangeLedger || {};
  function getTurnViewModelsForActiveSession(sessionId) { // the side panel passes its owning chat (split view)
    const projection = ctx.uiRuntime.projectionContextBySession?.get?.(String(sessionId || ctx.state.currentSessionId || '').trim())?.currentContext;
    if (!projection || !(projection.viewModelByTurnId instanceof Map)) return [];
    return Array.from(projection.viewModelByTurnId.values());
  }
  let chatWorkbench = null; // row 190: the Chat room's workbench, composed once the bridge exists (below)
  const shellArtifactBridge = (ctx.window.rendererShellArtifactBridgeUtils || {}).createShellArtifactBridge?.({
    state: ctx.state,
    windowRef: ctx.window,
    dom: {
      chatView: ctx.chatView,
      chatTimeline: ctx.chatTimeline,
      artifactReviewPanel: ctx.artifactReviewPanel,
    },
    lazyDom: {
      getArtifactsDom: (...a) => ctx.lazyDom.getArtifactsDom(...a),
    },
    buildArtifactsFromMessages,
    artifactsUtils: ctx.artifactsUtils,
    registerCleanup: ctx.registerRendererCleanup,
    callbacks: {
      escapeHtml,
      getActiveSession: (...a) => getActiveSession(...a),
      getSessionMonogram: (...a) => getSessionMonogram(...a),
      setActiveView: (...a) => setActiveView(...a),
      scrollMessageIntoView: (...a) => scrollMessageIntoView(...a),
      renderAll: (...a) => ctx.renderAll(...a),
      updateComposerSafeOffset: (...a) => updateComposerSafeOffset(...a),
      appendClientLog: (...a) => appendClientLog(...a),
      showToastMessage: (...a) => showToastMessage(...a),
      toErrorMessage: (...a) => toErrorMessage(...a),
      activateWorkspaceSession: (...a) => activateWorkspaceSession(...a),
      getProjectSwitcher: (...a) => getProjectSwitcher(...a),
      // Row 138, the Background tasks panel's Stop on a linked chat. handleStopActiveStream is built later (controller
      // composition), so this cancels the stream the renderer knows; null sends the panel to the main process's turn.
      stopSessionStream: async (sessionId) => {
        const streamId = String(multiStreamController?.getActiveStreamIdForCancel?.(sessionId) || '').trim();
        if (!streamId || typeof ctx.window.jennyShell?.chat?.cancelStream !== 'function') return null;
        const result = await ctx.window.jennyShell.chat.cancelStream(streamId);
        return multiStreamController.isCancelStreamRefused?.(result) ? null : { streamId, sessionId };
      },
      getProjectionContext: () => ctx.uiRuntime.projectionContextBySession?.get?.(String(ctx.state.currentSessionId || '').trim())?.currentContext || null,
      getChatTimelineRowModelEnabled: (...a) => getChatTimelineRowModelEnabled(...a),
      recordChatTimelineRolloutSignal: (...a) => recordChatTimelineRolloutSignal(...a),
      rollbackChatTimelineRowModel: (...a) => rollbackChatTimelineRowModel(...a),
      // Row 190: the right stack of the room on screen: Chat's, or the one the Workspace or the Board registered.
      getChatLayoutHost: () => (ctx.state.ui?.activeView === 'chat' ? chatWorkbench?.getController?.()?.getRightStack?.()
        : ctx.window.rendererChatRightStack?.roomStack?.(ctx.state.ui?.activeView)) || null,
    },
    codeReview: {
      codeReviewRailFactory: codeReviewRailUtils.createCodeReviewRail,
      // The Changes view loads on first open (row 34 S5); the IDE manifest lists the same files.
      loadChangesView: () => codeReviewRailUtils.loadChangesViewModules?.({
        ensureScript: ctx.window.scriptLoaderUtils?.ensureScript,
        windowRef: ctx.window,
        log: (...a) => appendClientLog(...a),
      }),
      renderDiffHunks: diffHunksRenderUtils.renderDiffHunks,
      buildJennyChangeLedgerFromTurnViewModels: jennyChangeLedgerUtils.buildJennyChangeLedgerFromTurnViewModels,
      getTurnViewModelsForActiveSession,
      getSessionMessages: (sessionId) => getSessionMessages(sessionId),
      // A chat docked in the Workspace shows its review in the dock's Changes tab.
      revealInDock: (payload) => revealIdeChangesSafe({ turnId: payload?.turnId, fileKey: payload?.fileKey, scope: payload?.scope, toolCallId: payload?.toolCallId }),
      openChangeInWorkspace: (changeId) => {
        setActiveView('ide');
        return openIdeChangeDiffSafe(changeId);
      },
      getWorkspaceId: () => String(ctx.state.workspace?.activeWorkspaceId || 'default'),
      showComposerActionError: (error, title) => showComposerActionError?.(error, title),
    },
  }) || {};
  const {
    isArtifactReviewVisible = ctx.noopFalse,
    getArtifactsForSession = ctx.noopArr,
    invalidateSessionArtifacts = ctx.noop,
    rekeySessionArtifacts = ctx.noopStr,
    pruneSessionArtifacts = ctx.noop,
    resetArtifactsState = ctx.noop,
    openArtifactTarget = ctx.noopAsync,
    openCodeReviewTarget = ctx.noopAsync, openFilePreviewTarget = ctx.noopAsync,
    renderArtifactReviewPanelSafe = ctx.noop,
    syncArtifactReviewLayout = ctx.noop,
    selectArtifact = ctx.noop,
  } = shellArtifactBridge;
  // Row 190: the Chat workbench's scripts (the IDE manifest's `chatWorkbench` list) load in order at boot, then it composes.
  let chatWorkbenchDisposed = false;
  ctx.registerRendererCleanup?.(() => { chatWorkbenchDisposed = true; });
  void (async () => {
    const win = ctx.window;
    for (const [src, name] of win.rendererIdeScriptManifest?.chatWorkbench || []) {
      if (!(await win.scriptLoaderUtils?.ensureScript?.({ src, isReady: () => Boolean(win[name]), log: appendClientLog }))) return;
    }
    if (chatWorkbenchDisposed) return;
    chatWorkbench = win.rendererAppChatWorkbenchComposition?.composeChatWorkbench?.({
      state: ctx.state, windowRef: win, documentRef: ctx.document, getArtifactBridge: () => shellArtifactBridge,
      applyViewChrome: () => topNavShellController?.applyViewChrome?.(), appendClientLog: (...a) => appendClientLog(...a), registerCleanup: ctx.registerRendererCleanup,
    }) || null;
  })().catch((error) => appendClientLog('ERROR', 'chat_workbench.load_failed', { message: String(error?.message || error) }));
  ctx.window.rendererChatWorkspaceDetail?.configure?.({ openActivity: () => contextPanelController?.openActivity?.(), openInGit: async () => { setActiveView('ide'); return openIdeGitViewSafe(); } }); // session rail rows (row 59 cp2)
  /* contextPanelController */
  const contextPanelUtils = ctx.window.rendererChatActivity || {};
  const contextPanelController = (typeof contextPanelUtils.createContextPanelController === 'function'
    ? contextPanelUtils.createContextPanelController : null)?.({
    state: ctx.state,
    dom: { chatContextPanel: ctx.chatContextPanel },
    callbacks: {
      setActiveView: (...a) => setActiveView(...a),
      updateComposerSafeOffset: (...a) => updateComposerSafeOffset(...a),
      closeArtifact: () => shellArtifactBridge.collapseSidePanel?.(),
      openActivityOutput: async (output) => {setActiveView('ide');await openIdeTestOutputSafe(output);},
      sidePanel: shellArtifactBridge.sidePanel || null, // split view W3-2: the panel owner (renderer-shell-artifact-bridge.js)
    },
  }) || null;
  const sessionManager = ctx.sessionUtils.createSessionManager?.({
    state: ctx.state,
    constants: { INTERACTIVE_SEQUENCE_IDLE: ctx.INTERACTIVE_SEQUENCE_IDLE, INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: ctx.INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE, INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: ctx.INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED, MAX_INTERACTIVE_ROUNDS: ctx.MAX_INTERACTIVE_ROUNDS, MAX_INTERACTIVE_QUESTIONS: ctx.MAX_INTERACTIVE_QUESTIONS },
    callbacks: {
      normalizeChatMessage: ctx.normalizeChatMessage,
      normalizeChatMessages: ctx.normalizeChatMessages,
      isInteractiveOtherTrigger: ctx.isInteractiveOtherTrigger,
      getActiveSession,
      patchSessionSummary,
      rekeySessionArtifacts: (...a) => rekeySessionArtifacts(...a),
      clearProjectionContextCacheForSession: (...a) => ctx.clearProjectionContextCacheForSession(...a),
      rekeyProjectionContextCache: (...a) => ctx.rekeyProjectionContextCache(...a),
      onRemoveSessionState: (sessionId) => {
        ctx.fileDiffBindings.clearFileDiffSession?.(sessionId);
        ctx.saveReasoningPhaseExpansionPreferences();
        ctx.transcriptViewController?.forgetSession?.(sessionId);
      },
      onRekeySessionState: (sourceSessionId, targetSessionId) => {
        ctx.saveReasoningPhaseExpansionPreferences();
        ctx.paneLayoutController?.rekey?.(sourceSessionId, targetSessionId);
        ctx.transcriptViewController?.rekeySession?.(sourceSessionId, targetSessionId);
        // Enqueue before acceptance can refresh summaries/restore the workspace.
        // The workspace owns focus: promotion must not activate a background tab.
        // A first send's optimistic chat never held a tab: give the promoted chat one
        // per the open-in-new-tab preference (default: the active tab's place) while on screen.
        workspaceStateController?.rekeySession(sourceSessionId, targetSessionId)
          .then((workspace) => (!workspace?.openSessionIds?.includes(targetSessionId)
            && String(ctx.state.currentSessionId || '').trim() === targetSessionId
            ? ctx.globalThis.sessionOpenPrefUtils?.openSessionPerPreference(workspaceStateController, targetSessionId) : workspace))
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
  ctx.registerRendererCleanup(() => sessionManager?.dispose?.());
  const {
    getSessionMessages = ctx.noopArr, getSessionTurnEventState = ctx.noopObj, getVisibleSessionMessages = ctx.noopArr,
    setSessionMessages = ctx.noop, setSessionTurnEventState = ctx.noop, createNormalizedMessage = ctx.noopObj,
    resolveSessionId = ctx.noopStr,
    normalizePendingQuestionBatch = ctx.noopNull, getPendingQuestionBatch = ctx.noopNull,
    getInteractiveSequenceState = () => 'idle',
    hasStalePendingQuestionBatch = ctx.noopFalse,
    clearStalePendingQuestionBatch = async () => false,
    clearInteractiveDraft = ctx.noop, ensureInteractiveDraft = ctx.noopNull,
    getInteractiveDraft = ctx.noopNull,
    buildInteractiveQuestionBatchVisibleText = ctx.noopStr, shouldForceInteractiveGuardrail = ctx.noopFalse,
    buildInteractiveSelectedAnswers = ctx.noopArr, buildInteractiveAnswerPrompt = ctx.noopStr,
    getCurrentSessionMessages = ctx.noopArr, getCurrentVisibleMessages = ctx.noopArr, estimateTokens = () => 0,
    upsertSessionSummary = ctx.noopNull, removeSessionState = ctx.noop, rekeySessionState = ctx.noopStr,
  } = sessionManager || {};
  // Sidebar, top navigation, Chats panel, workspace tabs (renderer-app-navigation-composition.js).
  const {
    updateTokenDisplay, renderAttachmentTray, renderSessions, setRovingChatSession, toggleChatsScope,
    multiStreamController, syncWorkspaceFromStore, applyWorkspaceSnapshot, activateWorkspaceSession,
    handleLinkedSessionPopover, renderWorkspaceChrome, handleWorkspaceShortcut,
  } = ctx.window.rendererAppNavigationComposition.createNavigationComposition({
    __proto__: ctx, appendClientLog, escapeHtml, setActiveView,
    syncArtifactReviewLayout, updateComposerSafeOffset, getProjectSwitcher, showToastMessage, showShellErrorToast, chatScrollCoordinator, attachGlobalErrorBoundary,
    detachGlobalErrorBoundary, lifecycleController, patchSessionSummary, showSessionActionError,
    get topNavShellController() { return topNavShellController; },
    set topNavShellController(value) { topNavShellController = value; },
    get _applySidebarLayout() { return ctx._applySidebarLayout; },
    set _applySidebarLayout(value) { ctx._applySidebarLayout = value; },
    get workspaceStateController() { return workspaceStateController; },
    set workspaceStateController(value) { workspaceStateController = value; },
    get workspaceChromeController() { return workspaceChromeController; },
    set workspaceChromeController(value) { workspaceChromeController = value; },
  });
    return {
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
      openIdeTerminalSafe, runIdeTaskTerminalSafe, openIdeOutsideFilesSafe, closeIdeBottomPanelSafe,
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
      estimateTokens, getLatestUserMessageId: ctx.getLatestUserMessageId,
      upsertSessionSummary, removeSessionState, rekeySessionState,
      updateTokenDisplay, renderAttachmentTray, renderSessions, setRovingChatSession, toggleChatsScope, multiStreamController, syncWorkspaceFromStore, applyWorkspaceSnapshot, activateWorkspaceSession,
      handleLinkedSessionPopover, renderWorkspaceChrome, handleWorkspaceShortcut,
      workspaceStateController, workspaceChromeController, buildPaneSurface,
    };
  }

  root.rendererAppLifecycleComposition = {
    createLifecycleComposition,
  };
})(window);
