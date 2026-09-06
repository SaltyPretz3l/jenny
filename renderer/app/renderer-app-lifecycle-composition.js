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
    dom: { chatInput, composerSettingsPopover, composerSettingsButton, composerTerminalShortcut },
    callbacks: {
      normalizeReasoningEffort, loadStoredAppearancePreferences,
      getDefaultAppearancePreferences, normalizeAppearancePreferences, applyAppearanceToDocument,
      getDefaultChatZoomPercent: () => DEFAULT_CHAT_ZOOM_PERCENT,
      normalizeChatZoomPercent,
      applyChatZoomToDocument,
      saveStoredAppearancePreferences, getLatestUserMessageId,
      renderComposerPopover: (...a) => renderComposerPopover(...a), renderCommandPopover: (...a) => renderCommandPopover(...a), renderAttachmentTray: (...a) => renderAttachmentTray(...a),
      clearAttachmentNotice: (...a) => clearAttachmentNotice(...a), buildAttachmentToastMessage: (...a) => buildAttachmentToastMessage(...a),
      showToastMessage: (...a) => showToastMessage(...a), renderAll: (...a) => renderAll(...a),
      /* EH-W9: flag-gated intake route (null when error_intake_routing is off). */
      reportError: (...a) => reportErrorWhenActive(...a),
      renderLayout: (...a) => renderLayout(...a), renderHeader: (...a) => renderHeader(...a),
      renderLogs: (...a) => renderLogs(...a), renderSettings: (...a) => renderSettings(...a),
      renderApprovedMemoryManager: (...a) => renderApprovedMemoryManagerSafe(...a),
      renderIde: (...a) => renderIdeSafe(...a),
      activateIde: (...a) => activateIdeSafe(...a),
      renderHomePanel: (...a) => renderHomePanelSafe(...a),
      renderDashboard: (...a) => renderDashboardSafe(...a),
      notifyBootViewReady: (...a) => (notifyStartupBootViewReadyRef ? notifyStartupBootViewReadyRef(...a) : undefined),
      syncStartupBackendStatus: (...a) => (syncStartupBackendStatusRef ? syncStartupBackendStatusRef(...a) : undefined),
      invalidateSessionArtifacts: (...a) => invalidateSessionArtifacts(...a),
      pruneSessionArtifacts: (...a) => pruneSessionArtifacts(...a),
      resetArtifactsState: (...a) => resetArtifactsState(...a),
      renderPrompts: (...a) => renderPrompts(...a), renderComposerState: (...a) => renderComposerState(...a),
      renderPersonalityEditor: (...a) => renderPersonalityEditorSafe(...a), syncBackendNotice: (...a) => syncBackendNotice(...a),
      renderSessions: (...a) => renderSessions(...a), refreshApprovedMemories: (...a) => refreshApprovedMemoriesSafe(...a),
      refreshPendingMemories: (...a) => refreshPendingMemoriesSafe(...a),
      clearDismissedMemorySession: (...a) => clearDismissedMemorySessionSafe(...a),
      resetMemorySuggestionState: (...a) => resetMemorySuggestionStateSafe(...a),
      refreshCompanionState: (...a) => refreshCompanionStateSafe(...a),
      refreshProactiveState: (...a) => refreshProactiveStateSafe(...a),
      refreshSkillsState: (...a) => refreshSkillsStateSafe(...a),
      refreshTipsState: (...a) => refreshTipsStateSafe(...a),
      refreshOfflineState: (...a) => refreshOfflineStateSafe(...a),
      refreshPhasePercentiles: (...a) => refreshPhasePercentiles(...a),
      refreshPersonalityWorkspace: (...a) => refreshPersonalityWorkspaceSafe(...a), toErrorMessage: (...a) => toErrorMessage(...a),
      initializeComposerHolo: (...a) => initializeComposerHolo(...a), initializeSpriteHolo: (...a) => initializeSpriteHolo(...a), initializeComposerLayoutObserver: (...a) => initializeComposerLayoutObserver(...a),
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
    escapeHtml = (v) => String(v || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'),
    getSessionMonogram = () => 'J',
    normalizeModelToken = (v) => String(v || '').trim(),
    getActiveSession = noopNull,
    getRuntimePreferencesFromSession = () => ({
      preferredModel: '',
      reasoningEffort: 'default',
      planMode: false,
      contextPreferences: {
        historyScope: 'session',
        includePersonality: true,
        includeMemory: true,
      },
    }),
    getCurrentRuntimePreferences = () => ({
      preferredModel: '',
      reasoningEffort: 'default',
      planMode: false,
      contextPreferences: {
        historyScope: 'session',
        includePersonality: true,
        includeMemory: true,
      },
    }),
    patchSessionSummary = noop,
    syncRuntimeDraftFromActiveSession = noop,
    buildModelOptionMarkup = noopStr,
    loadAppearancePreferences = () => getDefaultAppearancePreferences(),
    adjustChatZoomPercent = async (direction) => stepChatZoomPercent(state.ui?.chatZoomPercent, direction),
    applyChatZoomPercent = async (value) => normalizeChatZoomPercent(value),
    resetChatZoomPercent = async () => DEFAULT_CHAT_ZOOM_PERCENT,
    appendClientLog = noop,
    getRendererElapsedMs = () => 0,
    noteFirstRenderComplete = noop,
    runDeferredVisualStartup = noop,
    scheduleDeferredVisualStartup = noop,
    pushIncomingLog = noop,
    resetLogsViewState = noop,
    setActiveView = noop,
    saveAppearancePreferences = noop,
    applyAppearancePreferences = (p) => normalizeAppearancePreferences(p),
    isDefaultAppearancePreferences = () => true,
    buildSelectOptionMarkup = noopStr,
    attachGlobalErrorBoundary = noop,
    detachGlobalErrorBoundary = noop,
  } = lifecycleController || {};
  const chatTimelinePreferenceController = appLifecyclePreferenceUtils.createChatTimelinePreferenceController({
    state,
    storage: window.localStorage,
    storageKeys: {
      batch4: CHAT_TIMELINE_BATCH4_STORAGE_KEY,
    },
    callbacks: {
      appendClientLog: (...a) => appendClientLog(...a),
      clearProjectionContextCacheForSession: (...a) => clearProjectionContextCacheForSession(...a),
      renderMessages: (...a) => renderMessages(...a),
    },
  });
  const {
    getChatTimelineRowModelEnabled,
    loadChatTimelineBatch4Preference,
    recordChatTimelineRolloutSignal,
    refreshDefaultChatTimelineBatch4Preference,
    rollbackChatTimelineRowModel,
    setChatTimelineRowModelEnabled,
  } = chatTimelinePreferenceController;
  let clearProjectionContextCacheForSession = noopFalse;
  let rekeyProjectionContextCache = noopStr;
  // Both are best-effort preload-backed preferences with no dependency on each
  // other, so issue the IPC round-trips concurrently rather than serially on
  // boot. Overall app zoom is applied natively by the main process
  // (webContents.setZoomFactor); the renderer only needs the value to seed the
  // Settings select.
  const [persistedChatZoomState, persistedWindowUiState] = await Promise.all([
    (async () => { try { return await window.jennyShell?.chatUi?.getState?.(); } catch (_error) { return null; } })(),
    (async () => { try { return await window.jennyShell?.windowUi?.getState?.(); } catch (_error) { return null; } })(),
  ]);
  /* restore saved preferences */
  const savedAppearancePreferences = loadAppearancePreferences();
  state.ui.appearance = normalizeAppearancePreferences(savedAppearancePreferences);
  state.ui.chatZoomPercent = normalizeChatZoomPercent(
    persistedChatZoomState?.zoomPercent ?? state.ui.chatZoomPercent ?? DEFAULT_CHAT_ZOOM_PERCENT
  );
  state.ui.appZoomPercent = Number(
    persistedWindowUiState?.appZoomPercent ?? state.ui.appZoomPercent ?? 100
  ) || 100;
  state.ui.chatTimelineBatch4FastPathEnabled = loadChatTimelineBatch4Preference();
  setChatTimelineRowModelEnabled(state.currentSessionId, getChatTimelineRowModelEnabled(state.currentSessionId), {
    source: 'bootstrap',
  });
  applyAppearanceToDocument(document, state.ui.appearance);
  applyChatZoomToDocument(document, state.ui.chatZoomPercent);
  const shellServiceRegistry = (window.rendererShellServiceRegistryUtils || {}).createShellServiceRegistry?.({
    state,
    windowRef: window,
    documentRef: document,
    surfaceDom,
    lazyDom,
    constants: {
      TOAST_SOURCE,
      ACTIVITY_SCOPE,
    },
    modules: {
      personalityEditorUtils,
      proactiveUtils: window.rendererProactiveUtils || {},
      skillsUtils: window.rendererSkillsUtils || {},
      tipsUtils: window.rendererTipsUtils || {},
      offlineUtils: window.rendererOfflineUtils || {},
      memoryManagerUtils,
      ideControllerUtils: window.rendererIdeController || {},
      companionUtils: window.rendererCompanionUtils || {},
      dashboardUtils: window.rendererDashboardUtils || {},
      setupServiceUtils: window.rendererSetupService || {},
      setupControllerUtils: window.rendererSetupController || {},
      setupSceneFactories: {
        workspaceRoot: (window.rendererSetupSceneWorkspaceRoot || {}).createScene,
        localModel: (window.rendererSetupSceneLocalModel || {}).createScene,
        endpoint: (window.rendererSetupSceneEndpoint || {}).createScene,
        personality: (window.rendererSetupScenePersonality || {}).createScene,
        skills: (window.rendererSetupSceneSkills || {}).createScene,
        help: (window.rendererSetupSceneHelp || {}).createScene,
        factoryReset: (window.rendererSetupSceneFactoryReset || {}).createScene,
        modelLibrary: (window.rendererSetupSceneModelLibrary || {}).createScene,
        ollamaEngine: (window.rendererSetupSceneOllamaEngineGate || {}).createScene,
        capabilities: (window.rendererSetupSceneCapabilities || {}).createScene,
        setupHub: (window.rendererSetupSceneSetupHub || {}).createScene,
      },
      stepModalUtils: window.inventoryStepModal || {},
    },
    registerCleanup: registerRendererCleanup,
    callbacks: {
      escapeHtml,
      appendClientLog: (...a) => appendClientLog(...a),
      noteScrollProgrammaticWrite: (reason) => chatScrollCoordinator?.noteProgrammaticWrite?.(reason),
      showToastMessage: (...a) => showToastMessage(...a),
      showShellErrorToast: (...a) => showShellErrorToast(...a),
      toErrorMessage: (...a) => toErrorMessage(...a),
      renderAll: (...a) => renderAll(...a),
      renderPrompts: (...a) => renderPrompts(...a),
      renderSettings: (...a) => renderSettings(...a),
      renderComposerState: (...a) => renderComposerState(...a),
      syncComposerInputHeight: (...a) => syncComposerInputHeight(...a),
      loadSessions: (...a) => loadSessions(...a),
      openSession: (...a) => openSession(...a),
      getCurrentMessageById: (...a) => getCurrentMessageById(...a),
      setActiveView: (...a) => setActiveView(...a),
      openSettingsSection: (...a) => openSettingsSection(...a),
      refreshSuggestions: (...a) => refreshSuggestions(...a),
      getSettingsShellController: () => settingsShellController,
      applyWorkspaceSnapshot: (...a) => applyWorkspaceSnapshot(...a),
      renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a),
      syncWorkspaceFromStore: (...a) => syncWorkspaceFromStore(...a),
      activateWorkspaceSession: (...a) => activateWorkspaceSession(...a),
      handleCreateSessionWithWorkspace: (...a) => handleCreateSessionWithWorkspace(...a), getCurrentRuntimePreferences: (...a) => getCurrentRuntimePreferences(...a),
      setSessionOrigin: (...a) => setSessionOrigin(...a),
      setPendingOrigin: (...a) => setPendingOrigin(...a),
      clearPendingOrigin: (...a) => clearPendingOrigin(...a),
      dismissToast: (...a) => dismissToast(...a),
      beginActivity,
      resolveActivity,
      failActivity,
      getActivitySnapshot,
      getMostRecentActivity,
      isActivityBusy,
      applyActivityAttributes,
      buildPersonalityStatusTextModel,
      resolvePreferredPersonalityTab,
      // Declared later in this scope (function declarations hoist); the IDE
      // changes panel reads the same turn view-models as the code-review rail.
      getTurnViewModelsForActiveSession: (...a) => getTurnViewModelsForActiveSession(...a),
      chatInput,
      composerOfflineLabel,
      homeView,
    },
  }) || {};
  const {
    initializeEagerServices = noop,
    applyFeatureStatePayload = noop,
    refreshFeatureState = noopAsync,
    refreshWorkspaceRootState = noopAsync,
    refreshPhasePercentiles = noopAsync,
    resetPhasePercentiles = noopAsync,
    hydrateCachedLazyShellState = noop,
    queueStartupLazyHydration = noop,
    handleWorkspaceRootChoose = noopAsync,
    getPersonalityActiveFileSafe = noopNull,
    setPersonalityDraftSafe = noop,
    refreshPersonalityWorkspaceSafe = noopAsync,
    renderPersonalityEditorSafe = noop,
    handlePersonalityTabChangeSafe = noopAsync,
    handlePersonalitySaveSafe = noopAsync,
    handlePersonalityResetSafe = noopAsync,
    handlePersonalityOpenFolderSafe = noopAsync,
    hasPersonalityUnsavedChangesSafe = noopFalse,
    refreshMemoryContextFilesSafe = noopAsync,
    renderMemoryContextFilesSafe = noop,
    loadMemoryContextFileSafe = noopAsync,
    setMemoryContextDraftSafe = noop,
    getMemoryContextActiveFileSafe = noopNull,
    saveMemoryContextFileSafe = noopAsync,
    resetMemoryContextFileSafe = noopAsync,
    hasMemoryContextUnsavedChangesSafe = noopFalse,
    refreshProactiveStateSafe = noopAsync,
    handleUseProactiveSuggestionMessageSafe = noopAsync,
    refreshSkillsStateSafe = noopAsync,
    renderSkillsManagerSafe = noop,
    updateSkillsSettingsSafe = noopAsync,
    openSkillsScopeFolderSafe = noopAsync,
    bindSkillsShellEventsSafe = noop,
    refreshTipsStateSafe = noopAsync,
    bindTipsShellEventsSafe = noop,
    refreshOfflineStateSafe = noopAsync,
    renderOfflineManagerSafe = noop,
    bindOfflineShellEventsSafe = noop,
    handleOfflineModeChangeSafe = noopAsync,
    refreshApprovedMemoriesSafe = noopAsync,
    refreshPendingMemoriesSafe = noopAsync,
    refreshMemoryStatusSafe = noopAsync,
    renderApprovedMemoryManagerSafe = noop,
    maybeSuggestMemoryCaptureSafe = noopAsync,
    handleApprovedMemorySaveSafe = noopAsync,
    handleApprovedMemoryDeleteSafe = noopAsync,
    upsertApprovedMemoryDraftSafe = noop,
    renderIdeSafe = noop,
    activateIdeSafe = noop,
    layoutIdeEditorSafe = noop,
    reconcileChatDockHostSafe = noopFalse, prepareChatDockSessionTransitionSafe = noopFalse, getIdeCommandItemsSafe = () => [], openIdeChangeDiffSafe = noopFalse, openIdeFileAtLineSafe = noopFalse,
    openIdeHelpOverlaySafe = noop,
    clearApprovedMemoryDraftSafe = noop,
    getApprovedMemoryByIdSafe = noopNull,
    hasApprovedMemoryDraftChangesSafe = noopFalse,
    clearDismissedMemorySessionSafe = noop,
    rekeyDismissedMemorySessionSafe = noopStr,
    resetMemorySuggestionStateSafe = noop,
    refreshCompanionStateSafe = noopAsync,
    shouldRenderHomePanelSafe = noopFalse,
    renderHomePanelSafe = noop,
    applyCompanionPayload = noop,
    getAvailableCompanionDeferPresets = noopArr,
    renderDashboardSafe = noop,
    initSetupControllerSafe = noopAsync,
    refreshSetupStateSafe = noopAsync,
    applySetupBackendStatusSafe = noop,
    openSetupTileSafe = noop,
    showSetupFromSettingsSafe = noop,
    showSetupHelpSafe = noop,
    showFactoryResetSafe = noop,
    handleRunSetupAgain = noopAsync,
  } = shellServiceRegistry;
  if (window.jennyShell?.features?.onChanged) {
    registerRendererCleanup(window.jennyShell.features.onChanged((payload) => {
      const nextFeatures = applyFeatureStatePayload(payload);
      if (nextFeatures?.featureFlags?.comet_overlay !== true) {
        handleCometOverlayToggleChange(false);
      }
      // Re-apply chrome after a Settings change so the rail and the per-view
      // panel layout stay in sync (e.g. palette or sidebar preference edits).
      topNavShellController?.applyViewChrome?.();
      renderSettings();
      chatShellController?.syncTurnElapsedClock?.();
    }));
  }
  initializeEagerServices();
  const composerStatusController = (window.rendererComposerV2Status || {}).createComposerV2StatusController?.({
    state,
    callbacks: {
      renderComposerStatusNotice: (...a) => renderComposerStatusNotice(...a),
      appendClientLog: (...a) => appendClientLog(...a),
      getRendererElapsedMs: (...a) => getRendererElapsedMs(...a),
    },
  }) || null;
  const {
    buildAttachmentBudget = () => ({ accepted: [], skipped: [] }),
    summarizeAttachmentPreparation = noopStr,
    buildAttachmentToastMessage = noopStr,
    // escapeSelectorValue is forwarded to the viewport runtime (syncThinkingBlockNode
    // builds a `[data-...]` selector from it). It is NOT in this composition's ctx and
    // is created later by the controller composition, so without this defaulted local
    // binding the with(ctx) wrappers below (escapeSelectorValue: (...a) => ...) throw
    // ReferenceError the moment a reasoning block is synced. Mirror the controller
    // composition's default.
    escapeSelectorValue = (v) => String(v || ''),
    setAttachmentNotice = noop, clearAttachmentNotice = noop,
    setComposerStatusNotice = noop, clearComposerStatusNotice = noop,
    getActiveSendPreflight = noopNull, isSendPreflightPending = noopFalse,
    getActiveStreamSessionId = noopStr, isAnySendBusy = noopFalse,
    isSessionStreaming = noopFalse, hasPendingToolApprovalForSession = noopFalse,
    isSendBusy = noopFalse,
  } = composerStatusController || {};
  /* toastController */
  const toastController = toastControllerUtils.createToastController?.({
    toastStore, toastActionHandlers,
    constants: { TOAST_SOURCE }, dom: { toastViewport },
  }) || null;
  const {
    enqueueToast = noopStr, registerToastActions = noop,
    dismissToast = noop, renderToastViewport = noop,
    showToastMessage = noopStr, showShellErrorToast: rawShowShellErrorToast = noopStr,
    toErrorMessage = (e, f) => String(e?.message || e || f || ''),
    showSessionActionError: rawShowSessionActionError = noopStr,
    showComposerActionError: rawShowComposerActionError = noopStr,
    installToastViewportListeners = null,
  } = toastController || {};
  /* Hover/focus hold the auto-dismiss countdowns, and Escape inside the stack
   * dismisses the focused toast. */
  if (typeof installToastViewportListeners === 'function') {
    registerRendererCleanup(installToastViewportListeners());
  }
  /* errorIntakeController — EH-W8 flag-gated unified error intake. The three
   * error toast wrappers become reportError adapters when error_intake_routing
   * is on (live flag check per call, so Settings flips apply without restart);
   * flag-off they pass straight through to the raw toast controller above.
   * Generic showToastMessage callsites are untouched. */
  /* EH-W11: bounded in-memory error center feeding the health-pill badge.
   * Fully removable — with no store the pill renders as before. The render-
   * time recorder global lets timeline error cards / failed-send chips feed
   * history; it checks the flag per call so flag-off stays identical. */
  const errorCenterStore = (window.rendererErrorCenterStore || {}).createErrorCenterStore?.() || null;
  const recordRenderedError = (entry) => {
    if (!errorCenterStore || state.features?.featureFlags?.error_intake_routing !== true) {
      return false;
    }
    return errorCenterStore.record(entry);
  };
  window.rendererErrorCenterRecord = recordRenderedError;
  registerRendererCleanup(() => {
    if (window.rendererErrorCenterRecord === recordRenderedError) {
      window.rendererErrorCenterRecord = null;
    }
  });
  const errorIntakeController = (window.rendererErrorIntakeControllerUtils || {}).createErrorIntakeController?.({
    isEnabled: () => state.features?.featureFlags?.error_intake_routing === true,
    constants: { TOAST_SOURCE },
    toast: {
      showToastMessage,
      showShellErrorToast: rawShowShellErrorToast,
      showSessionActionError: rawShowSessionActionError,
      showComposerActionError: rawShowComposerActionError,
      toErrorMessage,
    },
    sinks: { errorCenter: errorCenterStore || undefined },
  }) || null;
  const {
    reportError = (input) => ({ route: null, toastId: rawShowShellErrorToast(toErrorMessage(input, ''), {}) }),
    reportErrorWhenActive = () => null,
    showShellErrorToast = rawShowShellErrorToast,
    showSessionActionError = rawShowSessionActionError,
    showComposerActionError = rawShowComposerActionError,
  } = errorIntakeController || {};
  const updateDialogController = window.rendererUpdateDialogUtils?.createUpdateDialogController?.({
    windowRef: window,
    documentRef: document,
    jennyShell: window.jennyShell,
    renderMarkdown: window.markdownUtils?.renderMarkdown,
    showToastMessage,
    /* EH-W9: flag-gated intake route for update-action failures. */
    reportError: (...a) => reportErrorWhenActive(...a),
  }) || null;
  if (updateDialogController) {
    registerRendererCleanup(updateDialogController.bind());
  }
  /* activityPrefsController */
  const shellStatusController = (window.rendererShellStatusControllerUtils || {}).createShellStatusController?.({
    state,
    constants: { ACTIVITY_SCOPE },
    dom: surfaceDom.status,
    callbacks: {
      getCurrentRuntimePreferences,
      getActiveSession,
      patchSessionSummary,
      setSessionPreferences: (sessionId, preferences) =>
        window.jennyShell.sessions.setPreferences(sessionId, preferences),
      syncRuntimeDraftFromActiveSession,
      beginActivity,
      resolveActivity,
      failActivity,
      getActivitySnapshot,
      getMostRecentActivity,
      applyActivityAttributes,
      setComposerStatusNotice,
      clearComposerStatusNotice,
      renderPersonalityEditor: (...a) => renderPersonalityEditorSafe(...a),
      renderComposerState: (...a) => renderComposerState(...a),
      renderSettings: (...a) => renderSettings(...a),
      renderSessions: (...a) => renderSessions(...a),
      getVisibleSessionMessages: (...a) => getVisibleSessionMessages(...a),
      getRendererElapsedMs: (...a) => getRendererElapsedMs(...a),
      appendClientLog: (...a) => appendClientLog(...a),
      onStartupReady: () => runDeferredVisualStartup(),
      onStartupRemoved: () => syncBackendNotice(), openLogs: () => setActiveView('logs'), openSettingsSection: (section) => openSettingsSection(section),
      showToastMessage: (...a) => showToastMessage(...a), dismissToastsBySource: (source) => toastStore?.dismissBySource?.(source), toastSource: TOAST_SOURCE.backend,
    },
  }) || null;
  const {
    getRuntimePreferenceSnapshot = noopObj,
    renderComposerStatusNotice = noop,
    handleActivityChange = noop,
    runRuntimePreferenceActivity = noopAsync,
    persistRuntimePreferences = noopAsync,
    syncBackendNotice = noop, retryBackendStart = noop,
    handleLifecycleProgress: _handleLifecycleProgress = noop,
    handleLifecycleBackendStatus: _handleLifecycleBackendStatus = noop,
    beginModelSwitch = noop,
    updateModelSwitch = noop,
    failModelSwitch = noop,
    publishLifecycleStatus = noop,
    setTurnStatusPill = noop,
    clearTurnStatusPill = noop,
    clearTurnStatusPillSources = noop,
    renderTurnStatusPill = noop,
  } = shellStatusController || {};
  notifyStartupBootViewReadyRef = (shellStatusController || {}).notifyBootViewReady || noop; // bind late ref
  syncStartupBackendStatusRef = _handleLifecycleBackendStatus;
  /* transcriptRenderer */
  const transcriptRenderer = transcriptUtils.createTranscriptRenderer({
    MESSAGE_STATUS, buildMessageActionModel, escapeHtml,
    getReasoningEntries: (...a) => getReasoningEntries(...a),
    groupReasoningByPhase: typeof groupReasoningByPhase === 'function'
      ? (...a) => groupReasoningByPhase(...a)
      : (entries) => {
        const sourceEntries = Array.isArray(entries) ? entries : [];
        if (!sourceEntries.length) {
          return [];
        }
        const groups = [];
        let currentGroup = null;
        for (let index = 0; index < sourceEntries.length; index += 1) {
          const entry = sourceEntries[index];
          const thinkingId = String(entry?.thinkingId || '');
          if (!currentGroup || currentGroup.thinkingId !== thinkingId) {
            currentGroup = { thinkingId, entries: [] };
            groups.push(currentGroup);
          }
          currentGroup.entries.push(entry);
        }
        return groups;
      },
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
  /* interactivePanelController */
  const interactivePanelController = interactivePanelUtils.createInteractivePanelRenderer?.({
    state, dom: { composer, chatInput, chatTimeline },
    callbacks: { getInteractiveQuestionOptions, isInteractiveQuestionAnswered, areInteractiveQuestionsAnswered, isInteractiveOtherTrigger, isSendBusy, escapeHtml, getPendingQuestionBatch: (...a) => getPendingQuestionBatch(...a), hasStalePendingQuestionBatch: (...a) => hasStalePendingQuestionBatch(...a), getInteractiveDraft: (...a) => getInteractiveDraft(...a), escapeSelectorValue: (...a) => escapeSelectorValue(...a) },
  }) || null;
  const {
    queueInteractiveComposerFocus = noop, flushInteractiveComposerFocus = noop,
    renderComposerInteractivePanel = noop, clearStalledTimer = noop,
  } = interactivePanelController || {};
  registerRendererCleanup(() => clearStalledTimer?.());
  const chatScrollCoordinator = (window.rendererChatScrollCoordinator || {}).createChatScrollCoordinator?.({
    state, scrollContainer: chatThreadScroll, timelineContainer: chatTimeline, window,
    appendClientLog: (...a) => appendClientLog(...a), renderJumpControls: (...a) => renderComposerJumpControls?.(...a),
    isStreaming: () => isSessionStreaming?.(state.currentSessionId) === true,
  }) || null;
  registerRendererCleanup(() => chatScrollCoordinator?.dispose?.());
  /* viewportController */
  const viewportController = viewportUtils.createViewportController?.({
    state,
    constants: { MESSAGE_STATUS },
    dom: {
      chatView,
      chatSurfaceEffects,
      chatSurfaceEffectLeft,
      chatThreadStage,
      chatThreadColumn,
      composerWrap,
      chatTimeline,
      chatThreadScroll,
    },
    controllers: { thinkingController, reducedMotionQuery, scrollCoordinator: chatScrollCoordinator },
    callbacks: { mergeReasoningEntries, deriveFollowLatestFromScroll, shouldAutoScrollThread, escapeSelectorValue: (...a) => escapeSelectorValue(...a), getCurrentSessionMessages: (...a) => getCurrentSessionMessages(...a), buildInteractiveRecapViewModel: (...a) => buildInteractiveRecapViewModel(...a), renderMessages: (...a) => renderMessages(...a), updateAssistantSpritePosition: (...a) => updateAssistantSpritePosition(...a), appendClientLog: (...a) => appendClientLog(...a) },
  }) || null;
  const {
    composerLayoutRuntime = { measureCanvas: null, measureContext: null, resizeObserver: null, safeOffset: 0 },
    getReasoningEntries = (m) => m?.reasoning?.entries && Array.isArray(m.reasoning.entries) ? m.reasoning.entries : [],
    mergeMessageReasoning = (msg, payload) => {
      if (!payload || !Array.isArray(payload.entriesDelta) || !payload.entriesDelta.length) {
        return msg.reasoning || { source: 'none', entries: [] };
      }
      const existing = msg?.reasoning?.entries && Array.isArray(msg.reasoning.entries) ? msg.reasoning.entries : [];
      return { source: String(payload.source || 'provider'), entries: mergeReasoningEntries(existing, payload.entriesDelta) };
    },
    getScrollMetrics = () => ({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 }),
    getScrollBehavior = () => 'auto',
    setFollowLatest = (v) => { state.ui.followLatest = Boolean(v); },
    syncThreadScrollState = () => true,
    getComposerSafeOffset = () => 0, measureComposerSafeOffset = () => 0,
    updateComposerSafeOffset = noop, initializeComposerLayoutObserver = noop,
    scrollThreadToTop = noop, scrollThreadToBottom = noop,
    scrollMessageIntoView = noopFalse, viewportReveal = null, getCurrentMessageById = noopNull,
    isInteractiveRoundRecapExpanded = () => false,
    pruneInteractiveRoundRecapExpansionState = noop,
    toggleInteractiveRoundRecap = noopAsync, clearCopyFeedback = noop,
    showCopyFeedback = noop, syncRenderedThinkingPanels = noop,
    syncThinkingBlockNode = noop, scheduleMessageViewportSync = noop,
    disposeViewportController = noop,
  } = viewportController || {}; chatScrollCoordinator?.setViewportController?.(viewportController);
  if (lifecycleController) lifecycleController.viewportReveal = viewportReveal;

  /* pinToTopController */
  const pinToTopUtils = window.rendererPinToTopUtils || {};
  let chatWayfinderController = null;
  const pinToTopController = (typeof pinToTopUtils.createPinToTopController === 'function'
    ? pinToTopUtils.createPinToTopController({
        scrollContainer: chatThreadScroll,
        timelineContainer: chatTimeline,
        pinnableSelector: '.chat-entry[data-message-role="user"]',
        topOffset: 88, listenForScroll: false,
        onStateChange: function (nextState) {
          getChatWayfinderController?.()?.setPinState?.({
            ...nextState,
            sessionId: state.currentSessionId,
          });
          renderComposerJumpControls?.();
        },
      })
    : null); chatScrollCoordinator?.setPinController?.(pinToTopController);

  /* sessionManager */
  const buildArtifactsFromMessages = typeof artifactsUtils.buildArtifactsFromMessages === 'function'
    ? artifactsUtils.buildArtifactsFromMessages
    : () => [];
  const codeReviewRenderUtils = window.rendererCodeReviewRender || {};
  const codeReviewRailUtils = window.rendererCodeReviewRail || {};
  const diffHunksRenderUtils = window.rendererDiffHunksRender || {};
  const jennyChangeLedgerUtils = window.rendererJennyChangeLedger || {};
  const sessionDiffReviewModelUtils = window.rendererSessionDiffReviewModel || {};
  function getTurnViewModelsForActiveSession() {
    const ctx = uiRuntime.projectionContextBySession?.get?.(String(state.currentSessionId || '').trim())?.currentContext;
    if (!ctx || !(ctx.viewModelByTurnId instanceof Map)) return [];
    return Array.from(ctx.viewModelByTurnId.values());
  }
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
      ARTIFACT_REVIEW_STORAGE_KEY: 'jenny.artifactReview.v1',
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
      getProjectionContext: () => uiRuntime.projectionContextBySession?.get?.(String(state.currentSessionId || '').trim())?.currentContext || null,
      getChatTimelineRowModelEnabled: (...a) => getChatTimelineRowModelEnabled(...a),
      recordChatTimelineRolloutSignal: (...a) => recordChatTimelineRolloutSignal(...a),
      rollbackChatTimelineRowModel: (...a) => rollbackChatTimelineRowModel(...a),
    },
    codeReview: {
      codeReviewRenderFactory: codeReviewRenderUtils.createCodeReviewRenderer,
      codeReviewRailFactory: codeReviewRailUtils.createCodeReviewRail,
      renderDiffHunks: diffHunksRenderUtils.renderDiffHunks,
      buildJennyChangeLedgerFromTurnViewModels: jennyChangeLedgerUtils.buildJennyChangeLedgerFromTurnViewModels,
      buildSessionDiffReviewModel: sessionDiffReviewModelUtils.buildSessionDiffReviewModel,
      resolveReviewScope: sessionDiffReviewModelUtils.resolveReviewScope,
      getTurnViewModelsForActiveSession,
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
  /* contextPanelController */
  const contextPanelUtils = window.rendererContextPanelUtils || {};
  const contextPanelController = (typeof contextPanelUtils.createContextPanelController === 'function'
    ? contextPanelUtils.createContextPanelController : null)?.({
    state,
    dom: { chatContextPanel, contextArtifactList, contextPulse, contextSessionLogs, contextPanelToggle, contextArtifactExpand, composerModelSelect },
    callbacks: {
      escapeHtml,
      estimateTokens: (...a) => estimateTokens(...a),
      getCurrentVisibleMessages: (...a) => getCurrentVisibleMessages(...a),
      formatTokenUsageDisplay,
      setActiveView: (...a) => setActiveView(...a),
      updateComposerSafeOffset: (...a) => updateComposerSafeOffset(...a),
      openArtifactTarget: (...a) => openArtifactTarget(...a),
      selectArtifact: (...a) => selectArtifact(...a),
      getArtifactsForSession: (...a) => getArtifactsForSession(...a),
      getLogEntries: () => {
        const sid = String(state.currentSessionId || '').trim();
        if (!sid) return (state.logs || []).slice(-(10));
        const sessionLogs = (state.logs || []).filter(
          (e) => !e.session_id || e.session_id === sid
        );
        return sessionLogs.slice(-(10));
      },
    },
    constants: { MAX_CONTEXT_LOGS: 10 },
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
      rekeyDismissedMemorySession: (...a) => rekeyDismissedMemorySessionSafe(...a),
      rekeySessionArtifacts: (...a) => rekeySessionArtifacts(...a),
      clearProjectionContextCacheForSession: (...a) => clearProjectionContextCacheForSession(...a),
      rekeyProjectionContextCache: (...a) => rekeyProjectionContextCache(...a),
      onRemoveSessionState: (sessionId) => {
        fileDiffBindings.clearFileDiffSession?.(sessionId);
        saveReasoningPhaseExpansionPreferences();
      },
      onRekeySessionState: () => {
        saveReasoningPhaseExpansionPreferences();
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
    getInteractiveDraft = noopNull, buildInteractiveQuestionBatchSummary = noopStr,
    buildInteractiveQuestionBatchVisibleText = noopStr, shouldForceInteractiveGuardrail = noopFalse,
    buildInteractiveSelectedAnswers = noopArr, buildInteractiveAnswerPrompt = noopStr,
    getCurrentSessionMessages = noopArr, getCurrentVisibleMessages = noopArr,
    getTokenCountedMessages = noopArr, estimateTokens = () => 0,
    upsertSessionSummary = noopNull, removeSessionState = noop, rekeySessionState = noopStr,
  } = sessionManager || {};
  /* sidebarController */
  const sidebarController = sidebarControllerUtils.createSidebarController?.({
    state,
    dom: { chatView, attachmentTray, attachmentNotice },
    callbacks: { escapeHtml },
  }) || null;
  const {
    updateTokenDisplay = noop, renderAttachmentTray = noop,
  } = sidebarController || {};
  let chatsPanelController = null;
  /* topNavShellController (top navigation shell dispatcher) */
  topNavShellController = (window.rendererTopNavShell || {}).createTopNavShellController?.({
    state,
    constants: { SIDEBAR_STORAGE_KEY, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MAIN_STAGE_MIN_WIDTH },
    // Resolve rail nodes directly because they are not part of the app.js DOM bindings.
    dom: { workspace, viewPanel: sidebar, sidebarResizer, searchInput, topRail: document.getElementById('topRail'), topRailTabs: document.getElementById('topRailTabs'), topRailIndicator: document.getElementById('topRailIndicator'), topRailActions: document.getElementById('topRailActions'), artifactSplitViewToggle: document.getElementById('artifactSplitViewToggle') },
    callbacks: {
      setActiveView: (...a) => setActiveView(...a),
      escapeHtml,
      appendClientLog: (...a) => appendClientLog(...a),
      updateComposerSafeOffset: (...a) => updateComposerSafeOffset(...a),
      onLayoutChanged: () => syncArtifactReviewLayout({ refreshChatChrome: true }),
      // Chats-strip plumbing (W11): open rides the workspace activation path
      // (late-bound below); New Chat reuses the panel button's full pipeline.
      getSessionMonogram,
      openSession: (...a) => activateWorkspaceSession(...a),
      newChat: () => document.getElementById('newChatButton')?.click?.(),
      prepareChatsPanelForExpansion: () => chatsPanelController?.prepareForStripExpansion?.(),
    },
  }) || null;
  _applySidebarLayout = (...a) => topNavShellController?.applyViewChrome?.(...a);
  topNavShellController?.bind?.();
  window.rendererTopNavShellController = topNavShellController;
  registerRendererCleanup(() => {
    topNavShellController?.dispose?.();
    if (window.rendererTopNavShellController === topNavShellController) {
      window.rendererTopNavShellController = null;
    }
  });
  // Shared collapse entry point for the rail, Settings, and command palette.
  function setSidebarCollapsed(collapsed) { topNavShellController?.setActivePanelCollapsed(Boolean(collapsed)); }
  chatsPanelController = (window.rendererChatsPanel || {}).createChatsPanelController?.({
    state, documentRef: document, windowRef: window,
    dom: { conversationGroups, conversationCount, searchInput,
      scopeSlot: document.getElementById('chatsScopeSlot'), status: document.getElementById('chatsPanelStatus') },
    inventory: { actionButton: window.inventoryActionButton, segmentedControl: window.inventorySegmentedControl },
    callbacks: { escapeHtml, newChat: () => document.getElementById('newChatButton')?.click?.(),
      appendClientLog: (...a) => appendClientLog(...a),
      afterRenderSessions: (...a) => { renderWorkspaceSidebarBadges(...a); topNavShellController?.syncChatsStrip?.(); } },
  }) || null;
  const { renderSessions = noop, loadMore: loadMoreChats = noop,
    setRovingSession: setRovingChatSession = noop, toggleScope: toggleChatsScope = noop } = chatsPanelController || {};
  registerRendererCleanup(() => chatsPanelController?.dispose?.());
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
  /* lifecycleController continued (late-bound) */
  attachGlobalErrorBoundary();
  registerRendererCleanup(() => detachGlobalErrorBoundary());
  const multiStreamController = (window.rendererMultiStreamUtils || {}).createMultiStreamController?.({
    getState: () => state,
    appendClientLog: (...a) => appendClientLog(...a),
  }) || null;
  window.rendererMultiStreamController = multiStreamController;
  registerRendererCleanup(() => {
    multiStreamController?.dispose?.();
    if (window.rendererMultiStreamController === multiStreamController) {
      window.rendererMultiStreamController = null;
    }
  });
  const _wsUtils = window.rendererWorkspaceSessionUtils || {};
  const workspaceSessionCoordinator = _wsUtils.createWorkspaceSessionCoordinator?.({
    state, windowRef: window,
    constants: { TOAST_SOURCE },
    dom: { workspaceRailShell },
    callbacks: {
      openSession: (...a) => openSession(...a),
      renderAll: (...a) => renderAll(...a),
      renderSessions: (...a) => renderSessions(...a),
      renderSettings: (...a) => renderSettings(...a),
      renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a),
      syncChatsStrip: () => topNavShellController?.syncChatsStrip?.(),
      patchChatsStripRuntime: () => topNavShellController?.patchChatsStripRuntime?.(),
      showToastMessage: (...a) => showToastMessage(...a),
      showSessionActionError: (...a) => showSessionActionError(...a),
      patchSessionSummary: (...a) => patchSessionSummary(...a),
      getOpenSessionsInNewTab: () => (globalThis.sessionOpenPrefUtils?.getOpenSessionsInNewTab?.() === true),
    },
    controllers: {
      getMultiStreamController: () => multiStreamController,
      getWorkspaceStateController: () => workspaceStateController,
      getWorkspaceChromeController: () => workspaceChromeController,
    },
  }) || {};
  const {
    normalizeSessionId = (v) => String(v || '').trim(),
    getApprovalSessionIds = () => [],
    getStreamingSessionIds = () => [],
    isWorkspaceSessionBusy = () => false,
    getSessionSummary = () => null,
    applyWorkspaceSnapshot = (s) => s,
    syncWorkspaceFromStore = async () => state.workspace,
    activateWorkspaceSession = async (sid, opts) => { await openSession(sid, opts); return state.workspace; },
    closeWorkspaceSession = async () => false,
    reorderWorkspaceSession = async () => {},
    closeOtherWorkspaceSessions = async () => {},
    closeWorkspaceSessionsToRight = async () => {},
    closeAllWorkspaceSessions = async () => {},
    renderWorkspaceSidebarBadges = noop,
    handleLinkedSessionPopover = noop,
    renderWorkspaceChrome = noop,
    handleWorkspaceShortcut = noop,
  } = workspaceSessionCoordinator;
  workspaceStateController = workspaceStateUtils.createWorkspaceStateController?.({ jennyShell: window.jennyShell, isSessionBusy: isWorkspaceSessionBusy, onStateChanged: applyWorkspaceSnapshot, onPersistenceError: (failure) => appendClientLog('WARN', 'workspace.state_persist_failed', failure) }) || null;
  workspaceChromeController = workspaceChromeUtils.createWorkspaceChromeController?.({
    containerEl: workspaceRailShell,
    getSessionSummary,
    isSessionBusy: isWorkspaceSessionBusy,
    onSessionActivated: (sessionId) => activateWorkspaceSession(sessionId),
    onSessionClosed: (sessionId) => closeWorkspaceSession(sessionId),
    onLinkSessionsRequested: (sessionId) => handleLinkedSessionPopover(sessionId),
    onNewSessionRequested: () => handleCreateSessionWithWorkspace(),
    onSessionReordered: (sessionId, newIndex) => reorderWorkspaceSession(sessionId, newIndex),
    onCloseOtherSessions: (keepId) => closeOtherWorkspaceSessions(keepId),
    onCloseSessionsToRight: (anchorId) => closeWorkspaceSessionsToRight(anchorId),
    onCloseAllSessions: () => closeAllWorkspaceSessions(),
  }) || null;
    result = {
      lifecycleController, escapeHtml, getSessionMonogram, normalizeModelToken, getActiveSession, getRuntimePreferencesFromSession, getCurrentRuntimePreferences,
      patchSessionSummary, syncRuntimeDraftFromActiveSession, buildModelOptionMarkup, loadAppearancePreferences, adjustChatZoomPercent, applyChatZoomPercent, resetChatZoomPercent,
      appendClientLog, getRendererElapsedMs, noteFirstRenderComplete, runDeferredVisualStartup, scheduleDeferredVisualStartup, pushIncomingLog, resetLogsViewState, setActiveView,
      saveAppearancePreferences, applyAppearancePreferences, isDefaultAppearancePreferences, buildSelectOptionMarkup, attachGlobalErrorBoundary,
      detachGlobalErrorBoundary, getChatTimelineRowModelEnabled, recordChatTimelineRolloutSignal, refreshDefaultChatTimelineBatch4Preference, rollbackChatTimelineRowModel,
      clearProjectionContextCacheForSession, rekeyProjectionContextCache, initializeEagerServices, applyFeatureStatePayload, refreshFeatureState,
      refreshWorkspaceRootState, refreshPhasePercentiles, resetPhasePercentiles, hydrateCachedLazyShellState, queueStartupLazyHydration, handleWorkspaceRootChoose,
      getPersonalityActiveFileSafe, setPersonalityDraftSafe, refreshPersonalityWorkspaceSafe, renderPersonalityEditorSafe, handlePersonalityTabChangeSafe, handlePersonalitySaveSafe, handlePersonalityResetSafe,
      handlePersonalityOpenFolderSafe, hasPersonalityUnsavedChangesSafe,
      refreshMemoryContextFilesSafe, renderMemoryContextFilesSafe, loadMemoryContextFileSafe,
      setMemoryContextDraftSafe, getMemoryContextActiveFileSafe, saveMemoryContextFileSafe,
      resetMemoryContextFileSafe, hasMemoryContextUnsavedChangesSafe,
      refreshProactiveStateSafe, handleUseProactiveSuggestionMessageSafe, refreshSkillsStateSafe, renderSkillsManagerSafe, updateSkillsSettingsSafe,
      openSkillsScopeFolderSafe, bindSkillsShellEventsSafe, refreshTipsStateSafe, bindTipsShellEventsSafe, refreshOfflineStateSafe, renderOfflineManagerSafe,
      bindOfflineShellEventsSafe, handleOfflineModeChangeSafe, refreshApprovedMemoriesSafe, refreshPendingMemoriesSafe, refreshMemoryStatusSafe, renderApprovedMemoryManagerSafe,
      maybeSuggestMemoryCaptureSafe, handleApprovedMemorySaveSafe, handleApprovedMemoryDeleteSafe, upsertApprovedMemoryDraftSafe, clearApprovedMemoryDraftSafe, renderIdeSafe, activateIdeSafe, layoutIdeEditorSafe,
      reconcileChatDockHostSafe, getIdeCommandItemsSafe, openIdeHelpOverlaySafe, openIdeChangeDiffSafe, openIdeFileAtLineSafe,
      getApprovedMemoryByIdSafe, hasApprovedMemoryDraftChangesSafe, clearDismissedMemorySessionSafe, rekeyDismissedMemorySessionSafe, resetMemorySuggestionStateSafe, refreshCompanionStateSafe, shouldRenderHomePanelSafe, renderHomePanelSafe,
      applyCompanionPayload, getAvailableCompanionDeferPresets, initSetupControllerSafe, refreshSetupStateSafe, applySetupBackendStatusSafe, openSetupTileSafe, showSetupFromSettingsSafe,
      showSetupHelpSafe, showFactoryResetSafe, handleRunSetupAgain, buildAttachmentBudget, summarizeAttachmentPreparation, buildAttachmentToastMessage, setAttachmentNotice,
      clearAttachmentNotice, setComposerStatusNotice, clearComposerStatusNotice, getActiveSendPreflight, isSendPreflightPending, getActiveStreamSessionId, isAnySendBusy, isSessionStreaming,
      hasPendingToolApprovalForSession, isSendBusy, enqueueToast, registerToastActions,
      dismissToast, renderToastViewport, showToastMessage, showShellErrorToast, toErrorMessage, showSessionActionError, showComposerActionError, reportError, reportErrorWhenActive, errorCenterStore, shellStatusController,
      getRuntimePreferenceSnapshot, renderComposerStatusNotice, handleActivityChange, runRuntimePreferenceActivity, persistRuntimePreferences, syncBackendNotice, retryBackendStart, _handleLifecycleProgress, _handleLifecycleBackendStatus,
      beginModelSwitch, updateModelSwitch, failModelSwitch, publishLifecycleStatus, setTurnStatusPill, clearTurnStatusPill, clearTurnStatusPillSources, renderTurnStatusPill,
      renderMessageAttachments, buildInteractiveRecapViewModel, renderInteractiveRoundRecap, renderMessageHoverRow, renderAgentStatusWidget, renderAssistantFailureNotice, renderContextCompactedNotice, renderThinkingWidget,
      renderToolCallBlock, setToolCallExpansion, renderProactiveSuggestionBlock, renderSlashCommandOutput, interactivePanelController, queueInteractiveComposerFocus, flushInteractiveComposerFocus, renderComposerInteractivePanel, clearStalledTimer,
      viewportController, chatScrollCoordinator, composerLayoutRuntime, getReasoningEntries, mergeMessageReasoning, getScrollMetrics, getScrollBehavior, setFollowLatest, syncThreadScrollState,
      getComposerSafeOffset, measureComposerSafeOffset, updateComposerSafeOffset, initializeComposerLayoutObserver, scrollThreadToTop, scrollThreadToBottom, scrollMessageIntoView, viewportReveal, getCurrentMessageById,
      isInteractiveRoundRecapExpanded, pruneInteractiveRoundRecapExpansionState, toggleInteractiveRoundRecap, clearCopyFeedback, showCopyFeedback, syncRenderedThinkingPanels, syncThinkingBlockNode, scheduleMessageViewportSync,
      disposeViewportController, chatWayfinderController, pinToTopController, buildArtifactsFromMessages, shellArtifactBridge, getArtifactsForSession, selectArtifact,
      invalidateSessionArtifacts, pruneSessionArtifacts, resetArtifactsState, isArtifactReviewVisible, renderArtifactReviewPanelSafe,
      openArtifactTarget, syncArtifactReviewLayout, openCodeReviewTarget, openFilePreviewTarget, contextPanelController, sessionManager, getSessionMessages, setSessionMessages, getSessionTurnEventState,
      setSessionTurnEventState, getCurrentSessionMessages, getVisibleSessionMessages, getCurrentVisibleMessages, createNormalizedMessage, resolveSessionId,
      normalizePendingQuestionBatch, getPendingQuestionBatch, getInteractiveSequenceState, hasStalePendingQuestionBatch,
      clearStalePendingQuestionBatch, clearInteractiveDraft, ensureInteractiveDraft, getInteractiveDraft, buildInteractiveQuestionBatchSummary,
      buildInteractiveQuestionBatchVisibleText, shouldForceInteractiveGuardrail, buildInteractiveSelectedAnswers, buildInteractiveAnswerPrompt,
      getTokenCountedMessages, estimateTokens, getLatestUserMessageId,
      upsertSessionSummary, removeSessionState, rekeySessionState,
      sidebarController, chatsPanelController, updateTokenDisplay, renderAttachmentTray, renderSessions, setSidebarCollapsed, resetSidebarWidth, loadMoreChats, setRovingChatSession, toggleChatsScope, handleSidebarResizeStart, handleSidebarResizeMove,
      finishSidebarResize, handleSidebarResizeKeydown, multiStreamController, workspaceSessionCoordinator, syncWorkspaceFromStore, applyWorkspaceSnapshot, activateWorkspaceSession, closeWorkspaceSession,
      reorderWorkspaceSession, closeOtherWorkspaceSessions, closeWorkspaceSessionsToRight, closeAllWorkspaceSessions, renderWorkspaceSidebarBadges, handleLinkedSessionPopover, renderWorkspaceChrome, handleWorkspaceShortcut,
      workspaceStateController, workspaceChromeController,
    };
    }
    return result || {};
  }

  root.rendererAppLifecycleComposition = {
    createLifecycleComposition,
  };
})(window);
