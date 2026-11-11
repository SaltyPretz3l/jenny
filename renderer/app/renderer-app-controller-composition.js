(function (root) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function createControllerComposition(ctx) {
    let result = null;
    with (ctx) {
  // These renderers are built below, not passed in ctx: without them a settled
  // compaction left the composer disabled. A prototype overlay, not a spread:
  // ctx members such as renderSettings are assigned later.
  const compactionCoordinator = window.rendererCompactionCoordinator?.createAppCompactionCoordinator?.(Object.assign(Object.create(ctx), {
    renderComposerState: (...a) => renderComposerState(...a),
    renderMessages: (...a) => renderMessages(...a),
    refreshSessionSummaries: (...a) => refreshSessionSummaries(...a),
  })) || null;
  state.compactionCoordinator = compactionCoordinator;
  /* settingsShellController */
  settingsShellController = window.rendererAppSettingsComposition.createSettingsShellController({
    __proto__: ctx, navigateToDiagnosticsTrace,
    get applySurfaceEffect() { return applySurfaceEffect; }, get openSession() { return openSession; },
    get renderAll() { return renderAll; }, get renderLogs() { return renderLogs; },
  });
  ({
    renderSettings = noop,
    renderComposerCarriers = noop,
    renderComposerPopover = noop,
    syncComposerInputHeight = noop,
  } = settingsShellController || {});
  settingsShellController?.whenSettingsPageReady(() => {
    window.rendererSettingsCommandSandboxUtils?.bindCommandSandboxSettings?.(window, registerRendererCleanup);
    window.rendererSettingsCloudModels?.bindCloudModelsSettings?.(window, registerRendererCleanup);
    window.rendererSettingsApiProviders?.bindApiProvidersSettings?.(window, registerRendererCleanup);
    window.rendererSettingsConversationTransfer?.bindConversationTransferSettings?.(window, registerRendererCleanup, async (id) => {
      await loadSessions(); await openSession(id); setActiveView('chat');
    });
    window.rendererSettingsPdfAddonUtils?.bindPdfAddonSettings?.(window, registerRendererCleanup);
    window.rendererSettingsCliPath?.bindCliPathSettings?.(window, registerRendererCleanup);
  });
  /* logRendererController */
  const logRenderUtils = window.rendererDiagnosticsRenderUtils || {};
  const logRendererController = logRenderUtils.createLogRenderer?.({
    state,
    dom: { logList },
    // Diagnostics > Runs attaches to the runtime console the Settings page group publishes.
    callbacks: { ensureSettingsPage: () => settingsShellController?.ensureSettingsPage?.() },
  }) || null;
  const {
    dispose: disposeDiagnosticsView = noop,
    ensureLogRowMounted = () => false,
  } = logRendererController || {};
  const scrollLogsToBottom = logRenderUtils.scrollLogsToBottom || noop;
  registerRendererCleanup(disposeDiagnosticsView);
  /* healthPillController (Phase 6F-A) */
  const healthPillUtils = window.rendererHealthPillUtils || {};
  const healthPillController = healthPillUtils.createHealthPillController?.({
    window,
    document,
    slot: workbenchHealthPillSlot,
    deriveRuntimeHealthState: (window.rendererRuntimeHealthUtils || {}).deriveRuntimeHealthState,
    setActiveView: (...a) => setActiveView(...a), retryBackendStart: (...a) => retryBackendStart(...a),
    setActiveDiagnosticsTab: (tab) => { state.ui.logs.activeTab = tab; renderLogs(); },
    setActiveSettingsSection: (sectionId) => openSettingsSection(sectionId),
    /* EH-W10: flag-gated intake route (error-center only). */
    reportError: (...a) => reportErrorWhenActive(...a),
    showToastMessage: (...a) => showToastMessage(...a),
    /* EH-W11: badge + Recent errors popover section; optional. */
    errorCenterStore,
  }) || null;
  if (healthPillController) {
    registerRendererCleanup(() => healthPillController.dispose?.());
    healthPillController.refresh?.({ silent: true }).catch(() => null);
  }
  const backendStatusTaskFence = window.rendererAsyncFence.createDisposalFence();
  const backendStatusTimeoutHandles = new Set();
  function scheduleBackendStatusTask(task) {
    let timeoutHandle = null;
    timeoutHandle = setTimeout(backendStatusTaskFence.guard(() => {
      backendStatusTimeoutHandles.delete(timeoutHandle);
      task();
    }), 0);
    backendStatusTimeoutHandles.add(timeoutHandle);
  }
  backendStatusTaskFence.onDispose(() => {
    for (const timeoutHandle of backendStatusTimeoutHandles) {
      clearTimeout(timeoutHandle);
    }
    backendStatusTimeoutHandles.clear();
  });
  registerRendererCleanup(() => backendStatusTaskFence.dispose());
  /* headerController */
  const headerUtils = globalThis.rendererHeaderUtils || {};
  const headerController = headerUtils.createHeaderController?.({
    state,
    dom: { metricList, newChatButton },
    callbacks: {
      escapeHtml,
      isAnySendBusy: (...a) => isAnySendBusy(...a),
      isSendPreflightPending: (...a) => isSendPreflightPending(...a),
    },
  }) || null;
  registerRendererCleanup(() => headerController?.dispose?.());
  const { renderHeader: _extRenderHeader = noop } = headerController || {};
  // B7a: bind the inline interactive batch-row builder once (it needs the
  // session pending batch + draft + question-state helpers, all in ctx) and
  // forward it to the render pipeline -> createTurnRowRenderUtils.buildBatchRowMarkup.
  const buildInteractiveBatchRowMarkup = (window.rendererInteractivePanelUtils
    && typeof window.rendererInteractivePanelUtils.createInteractiveBatchRowBuilder === 'function')
    ? window.rendererInteractivePanelUtils.createInteractiveBatchRowBuilder({
      state, escapeHtml, isSendBusy, getPendingQuestionBatch, hasStalePendingQuestionBatch,
      getInteractiveDraft, getInteractiveQuestionOptions, isInteractiveQuestionAnswered,
      areInteractiveQuestionsAnswered, isInteractiveOtherTrigger,
    })
    : function noopBuildInteractiveBatchRowMarkup() { return ''; };
  // Bind the historical inert plan-proposal row builder with its sole runtime
  // dependency, HTML escaping, then forward it to the render pipeline.
  const buildPlanProposalRowMarkup = (window.rendererPlanProposalCard
    && typeof window.rendererPlanProposalCard.createPlanProposalRowBuilder === 'function')
    ? window.rendererPlanProposalCard.createPlanProposalRowBuilder({ escapeHtml })
    : function noopBuildPlanProposalRowMarkup() { return ''; };
  // Body-level pinned-note overlay controller (assigned below, mounted alongside
  // the scratchpad capture popover). Declared here so the renderPinnedNotes
  // chrome callback can close over it before its creation site runs.
  let pinController = null;
  /* renderPipelineController */
  const buildRenderPipeline = (pane = {}) => renderPipelineUtils.createRenderPipeline?.({
    state, constants: { MESSAGE_STATUS, ACTIVITY_SCOPE },
    dom: { homeView, chatView, ideView, chatSurface, logsView, settingsView, homeNavButton, metricList, sessionActionButton, newChatButton, chatTimeline, chatThreadScroll, chatThreadColumn, chatSpriteLayer, chatAssistantSprite, heroAvatar, heroTitle, heroSubtitle, heroRuntimeHint, heroStack, logSearchInput, logLevelFilter, logSourceFilter, logResultsLabel, logList, chatInput, stopStreamButton, sendButton, composer, composerModelSelect, composerEffortSelect, jumpToTopButton, jumpToBottomButton, composerModelSelectShell, composerEffortSelectShell, chatSurfaceEffects, chatSurfaceEffectLeft, chatThreadStage, composerWrap, chatOriginChip, chatOriginLabel, ...pane.dom },
    callbacks: {
      escapeHtml, getLatestAssistantMessageId, getLatestReplyAssistantMessageId, getLatestUserMessageId, resolveRegenerateRequest, buildAssistantMetaLabel, shouldShowThinkingToggle,
      buildLogViewModel, getActivitySnapshot, getMostRecentActivity, isActivityBusy, applyActivityAttributes,
      clearActivity, failActivity, beginActivity,
      buildInteractiveRecapViewModel: (...a) => buildInteractiveRecapViewModel(...a),
      renderToolCallBlock: (...a) => renderToolCallBlock(...a), renderInteractiveRoundRecap: (...a) => renderInteractiveRoundRecap(...a),
      renderProactiveSuggestionBlock: (...a) => renderProactiveSuggestionBlock(...a), renderSlashCommandOutput: (...a) => renderSlashCommandOutput(...a), renderMessageAttachments: (...a) => renderMessageAttachments(...a),
      renderThinkingWidget: (...a) => renderThinkingWidget(...a), renderAgentStatusWidget: (...a) => renderAgentStatusWidget(...a), renderAssistantFailureNotice: (...a) => renderAssistantFailureNotice(...a), renderContextCompactedNotice: (...a) => renderContextCompactedNotice(...a), renderMessageHoverRow: (...a) => renderMessageHoverRow(...a),
      getCurrentSessionMessages: (...a) => getCurrentSessionMessages(...a), getCurrentVisibleMessages: (...a) => getCurrentVisibleMessages(...a),
      getVisibleSessionMessages: (...a) => getVisibleSessionMessages(...a), getSessionMessages: (...a) => getSessionMessages(...a), isSendBusy: (...a) => isSendBusy(...a), isAnySendBusy: (...a) => isAnySendBusy(...a), isSessionStreaming: (...a) => isSessionStreaming(...a), hasPendingToolApprovalForSession: (...a) => hasPendingToolApprovalForSession(...a), getActiveStreamSessionId: (...a) => getActiveStreamSessionId(...a),
      isInteractiveRoundRecapExpanded: (...a) => isInteractiveRoundRecapExpanded(...a),
      pruneInteractiveRoundRecapExpansionState: (...a) => pruneInteractiveRoundRecapExpansionState(...a),
      isSendPreflightPending: (...a) => isSendPreflightPending(...a), updateTokenDisplay: (...a) => updateTokenDisplay(...a),
      syncTurnElapsedClock: (...a) => chatShellController?.syncTurnElapsedClock?.(...a),
      setFollowLatest: (...a) => setFollowLatest(...a),
      scheduleMessageViewportSync: (...a) => {
        chatWayfinderController?.refresh?.();
        scheduleMessageViewportSync(...a);
      },
      getPendingQuestionBatch: (...a) => getPendingQuestionBatch(...a), hasStalePendingQuestionBatch: (...a) => hasStalePendingQuestionBatch(...a),
      buildInteractiveBatchRowMarkup: (...a) => buildInteractiveBatchRowMarkup(...a),
      buildPlanProposalRowMarkup: (...a) => buildPlanProposalRowMarkup(...a),
      renderComposerInteractivePanel: (...a) => renderComposerInteractivePanel(...a), closeComposerPopover: (...a) => closeComposerPopover(...a),
      syncComposerInputHeight: (...a) => syncComposerInputHeight(...a), setComposerHoloState: (...a) => setComposerHoloState(...a),
      updateComposerSafeOffset: (...a) => updateComposerSafeOffset(...a), renderSessions: (...a) => renderSessions(...a),
      renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a),
      renderComposerCarriers: (...a) => renderComposerCarriers(...a),
      renderSettings: (...a) => renderSettings(...a), renderIde: (...a) => renderIdeSafe(...a), layoutIdeEditor: (...a) => layoutIdeEditorSafe(...a), reconcileChatDockHost: (...a) => reconcileChatDockHostSafe(...a),
      renderArtifactReviewPanel: (...a) => renderArtifactReviewPanelSafe(...a),
      isArtifactReviewVisible: (...a) => isArtifactReviewVisible(...a),
      getArtifactsForSession: (...a) => getArtifactsForSession(...a),
      selectArtifact: (...a) => selectArtifact(...a),
      renderContextPanel: () => contextPanelController?.renderContextPanel?.(),
      renderPinnedNotes: () => pinController?.render?.(),
      shouldRenderHomePanel: (...a) => shouldRenderHomePanelSafe(...a),
      renderHomePanel: (...a) => renderHomePanelSafe(...a),
      renderAttachmentTray: (...a) => renderAttachmentTray(...a), renderComposerStatusNotice: (...a) => renderComposerStatusNotice(...a), setComposerStatusNotice: (...a) => setComposerStatusNotice(...a), clearComposerStatusNotice: (...a) => clearComposerStatusNotice(...a), syncBackendNotice: (...a) => syncBackendNotice(...a),
      renderToastViewport: (...a) => renderToastViewport(...a), renderComposerPopover: (...a) => renderComposerPopover(...a),
      getCurrentRuntimePreferences: (...a) => getCurrentRuntimePreferences(...a), getRuntimePreferencesFromSession, renderComposerEnhancements: (...a) => renderComposerEnhancements(...a),
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
      syncPersistedReasoningPhaseExpansionState: (...a) => syncPersistedReasoningPhaseExpansionState(...a),
      getChatSendLifecycle: (...a) => getChatSendLifecycle(...a),
      getChatTimelineRowModelEnabled: (...a) => getChatTimelineRowModelEnabled(...a),
      recordChatTimelineRolloutSignal: (...a) => recordChatTimelineRolloutSignal(...a),
      rollbackChatTimelineRowModel: (...a) => rollbackChatTimelineRowModel(...a),
      refreshActiveSurfaceEffect: (...a) => refreshActiveSurfaceEffect(...a), onSurfaceLifecycleSync: (...a) => (typeof onSurfaceLifecycleSync === 'function' ? onSurfaceLifecycleSync(...a) : undefined),
      appendClientLog: (...a) => appendClientLog(...a),
      renderHeader: (...a) => _extRenderHeader(...a), syncPaneLayout: (kind) => ctx.getPaneComposition?.()?.syncPaneLayout?.(kind), ...pane.overrides,
    },
    controllers: { thinkingController, reducedMotionQuery, thinkingIndicator, logRenderer: logRendererController, scrollCoordinator: chatScrollCoordinator,
      getSendOutboxActions: () => chatShellController?.sendOutboxActions, ...pane.controllers,
    },
    runtime: { uiRuntime, spriteRuntime, ...pane.runtime },
  }) || null;
  const renderPipelineController = buildRenderPipeline();
  /* observabilityController (Phase 6F-D) */
  const observabilityUtils = window.rendererObservabilityUtils || {};
  function navigateToDiagnosticsTrace(target = {}) {
    const streamId = String(target.streamId || '').trim();
    if (!streamId) return;
    // Traces come from the live runtime, so they focus the current run; the
    // previously selected run is kept in returnState.
    window.rendererDiagnosticsViewState.focusDiagnosticsTarget(state, { tab: 'activity', query: streamId, runId: '' });
    setActiveView('logs');
    window.dispatchEvent(new window.CustomEvent('diagnostics:focus-log-entry', { detail: { entryId: '' } }));
  }
  const observabilityController = observabilityUtils.createObservabilityController?.({
    window,
    dom: { toolLatencyTable, slowOperationsList, recentTracesList },
    callbacks: {
      getCurrentSessionId: () => state.currentSessionId,
      isVisible: () => state.ui.activeView === 'logs',
      // The Overview reads these three facets from the diagnostics status to decide which groups show.
      onSnapshot: (snapshot) => {
        if (!snapshot || typeof snapshot !== 'object') return;
        const facets = {};
        ['tool_observability', 'slow_operations', 'trace_timing'].forEach((key) => { facets[key] = snapshot[key]; });
        state.diagnosticsStatus = { ...(state.diagnosticsStatus || {}), ...facets };
        if (state.ui.activeView === 'logs') renderLogs();
      },
      onTraceLink: (streamId) => {
        navigateToDiagnosticsTrace({ streamId });
      },
    },
  }) || null;
  if (observabilityController) {
    lifecycleController?.setDiagnosticsObservabilityRefresh?.((options) => observabilityController.refresh?.(options));
    registerRendererCleanup(() => {
      lifecycleController?.setDiagnosticsObservabilityRefresh?.(null);
      observabilityController.dispose?.();
    });
  }
  if (observabilityRefreshButton) {
    // Busy stays focusable: aria-disabled, never the disabled property (focus would drop to body).
    const onRefreshClick = () => {
      if (observabilityRefreshButton.getAttribute('aria-disabled') === 'true') return;
      observabilityRefreshButton.setAttribute('aria-disabled', 'true');
      Promise.resolve(lifecycleController?.refreshDiagnosticsWorkspace?.())
        .catch(() => {})
        .finally(() => { observabilityRefreshButton.removeAttribute('aria-disabled'); });
    };
    observabilityRefreshButton.addEventListener('click', onRefreshClick);
    registerRendererCleanup(() => observabilityRefreshButton.removeEventListener('click', onRefreshClick));
  }
  const {
    escapeSelectorValue = (v) => String(v || ''), hideAssistantSprite, updateAssistantSpritePosition, renderLayout, renderHeader,
    renderMessages, renderLogs, syncComposerVisualState, renderComposerJumpControls, renderComposerState,
    renderAll, applySurfaceEffect, syncBackendActivityFromStatus, renderLiveThinkingChip: _renderLiveThinkingChip,
    setSessionOrigin, setPendingOrigin, clearPendingOrigin, attachPendingOriginToSession, rekeySessionOrigin,
    clearProjectionContextCacheForSession: pipelineClearProjectionContextCacheForSession,
    rekeyProjectionContextCache: pipelineRekeyProjectionContextCache, invalidateProjectionStateForSession,
    toggleThreadBranch, timelineVirtualizer, dispose: disposeRenderPipeline,
  } = renderPipelineController || {};
  clearProjectionContextCacheForSession = (...a) => pipelineClearProjectionContextCacheForSession(...a);
  rekeyProjectionContextCache = (...a) => pipelineRekeyProjectionContextCache(...a);
  updateAssistantSpritePositionRef = (...a) => updateAssistantSpritePosition(...a);
  registerRendererCleanup(() => disposeRenderPipeline());
  renderLiveThinkingChip = _renderLiveThinkingChip;

  const contextUsageModule = window.rendererContextUsageUtils || null;
  const composerToggleModule = (window.rendererComposerV2Toggle || {}).createComposerV2ToggleController?.({
    state,
    getCurrentSessionId: () => state.currentSessionId,
    readBrowserDefault: async () => (await window.jennyShell?.chatUi?.getState?.())?.browserOnInNewChats === true,
    persistBrowserDefault: (enabled) => window.jennyShell?.chatUi?.updateSettings?.({ browserOnInNewChats: enabled }),
    persistSessionToolPreference: async (overrides, targetSessionId) => {
      const sessionId = String(targetSessionId || '').trim();
      if (!sessionId || !window.jennyShell?.sessions?.setPreferences) {
        throw new Error('Open a saved chat before setting session tool overrides.');
      }
      const persisted = await window.jennyShell.sessions.setPreferences(sessionId, overrides);
      if (!window.rendererComposerV2Toggle?.sessionToolOverrideEchoMatches?.(
        persisted, sessionId, overrides
      )) {
        throw new Error('Session tool override persistence acknowledgement did not match the requested change.');
      }
      patchSessionSummary(sessionId, {
        tool_category_overrides: persisted.tool_category_overrides,
        tool_connection_overrides: persisted.tool_connection_overrides,
      });
      return persisted;
    },
    onPersistError: (error, categoryId, details = {}) => {
      appendClientLog('WARN', 'composer.tool_toggle_persist_failed', {
        categoryId, message: error?.message || String(error),
      });
      if (details.isCurrent === false) return;
      showToastMessage(jt('app.shell.toolOverrideSaveFailed', "Couldn't save this chat's tools. Try again."), {
        title: jt('app.shell.toolOverrideNotSavedTitle', 'Tool Override Not Saved'), tone: 'danger',
        source: TOAST_SOURCE.chatStream,
        dedupeKey: `${TOAST_SOURCE.chatStream}:tool-override-persist`,
      });
    },
  }) || null;
  /* lifecycleController late-bound (popover, attachments, sessions) */
  const {
    closeComposerPopover, openComposerPopover, resetAttachmentQueue, beginAttachmentToken, cancelAttachmentToken,
    removeQueuedAttachment, mergePreparedAttachments, handleAttachmentPicker, prepareDroppedAttachments,
    queueInlineImageAttachment, setDropActive, suppressFileDropNavigation, getDroppedFilePaths, loadSessions,
    openSession, refreshSessionSummaries, refreshSnapshots, bootstrap, handleCreateSession, handleRenameSession,
    handleDeleteSession, handleJumpToTop, handleJumpToBottom, viewportReveal = null,
  } = lifecycleController || {};
  const chatWayfinderUtils = window.rendererChatWayfinderUtils || {};
  chatWayfinderController = (typeof chatWayfinderUtils.createChatWayfinderController === 'function'
      ? chatWayfinderUtils.createChatWayfinderController({
        state,
        onChange: () => renderComposerJumpControls?.(),
        getCurrentSessionId: () => state.currentSessionId,
        getCurrentSessionMessages: (...a) => getCurrentSessionMessages(...a),
        getScrollMetrics: (...a) => getScrollMetrics(...a),
        appendClientLog: (...a) => appendClientLog(...a),
      })
    : null); chatScrollCoordinator?.setWayfinderController?.(chatWayfinderController);
  // Chat links into another registered project (primary chat): the folder list and the open-in-IDE-after-switching route.
  const projectLinkHooks = window.jennyWorkspacePathResolve?.createProjectLinkHooks?.({
    getProjectSwitcher: (...a) => ctx.getProjectSwitcher?.(...a), openIdeFileAtLine: (...a) => openIdeFileAtLineSafe(...a), setActiveView: (...a) => setActiveView(...a),
  }) || {};
  const shellRuntimeController = (window.rendererShellRuntimeUtils || {}).createShellRuntimeController?.({
    state,
    windowRef: window,
    dom: {
      composerContextUsageSlot,
      composerPlanUsageSlot,
      composerToolToggleSlot,
    },
    constants: { TOAST_SOURCE },
    modules: {
      contextUsageModule,
      composerToggleModule,
    },
    callbacks: {
      appendClientLog: (...a) => appendClientLog(...a),
      renderAll: (...a) => renderAll(...a),
      renderSettings: (...a) => renderSettings(...a),
      renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a),
      renderComposerState: (...a) => renderComposerState(...a),
      syncComposerInputHeight: (...a) => syncComposerInputHeight(...a),
      showToastMessage: (...a) => showToastMessage(...a),
      toErrorMessage: (...a) => toErrorMessage(...a),
      showComposerActionError: (...a) => showComposerActionError(...a),
      openSettingsSection: (...a) => openSettingsSection(...a),
      setActiveView: (...a) => setActiveView(...a),
      getLatestReplyAssistantMessageId: (...a) => getLatestReplyAssistantMessageId(...a),
      getCurrentVisibleMessages: (...a) => getCurrentVisibleMessages(...a),
      getCurrentMessageById: (...a) => getCurrentMessageById(...a),
      isSendPreflightPending: (...a) => isSendPreflightPending(...a),
      loadSessions: (...a) => loadSessions(...a),
      refreshSessionSummaries: (...a) => refreshSessionSummaries(...a),
      handleCreateSession: (...a) => handleCreateSession(...a),
      handleDeleteSession: (...a) => handleDeleteSession(...a),
      syncWorkspaceFromStore: (...a) => syncWorkspaceFromStore(...a),
      applyWorkspaceSnapshot: (...a) => applyWorkspaceSnapshot(...a),
      renderSessions: (...a) => renderSessions(...a),
      activateWorkspaceSession: (...a) => activateWorkspaceSession(...a), focusComposer: () => ctx.getPaneComposition?.()?.focusComposer?.() || chatInput?.focus?.(),
      openArtifactTarget: (...a) => openArtifactTarget(...a), openIdeFileAtLine: (...a) => openIdeFileAtLineSafe(...a), revealIdePath: (...a) => revealIdePathSafe(...a), openFilePreviewTarget: (...a) => openFilePreviewTarget(...a),
      openProjectFileInIde: projectLinkHooks.openProjectFileInIde, getProjectRoots: projectLinkHooks.getProjectRoots,
    },
  }) || {};
  const {
    renderComposerEnhancements = noop,
    refreshComposerToolToggles = noopAsync,
    getToolPreferences = noopObj,
    handleComposerToggleChange = noop,
    queueDeferredStartupTask = noop,
    handleErrorRecoveryAction: baseHandleErrorRecoveryAction = noopAsync,
    handleArtifactAction = noopAsync,
    loadSessionsWithWorkspace = noopAsync,
    refreshSessionSummariesWithWorkspace = noopAsync,
    handleCreateSessionWithWorkspace = noopAsync,
    handleDeleteSessionWithWorkspace = noopAsync,
  } = shellRuntimeController;
  const handleErrorRecoveryAction = (payload) => baseHandleErrorRecoveryAction(payload, {
    handleRegenerateMessage: (...a) => handleRegenerateMessage(...a),
    handleCreateSessionWithWorkspace: (...a) => handleCreateSessionWithWorkspace(...a),
  });
  // Auto-title the first send into an untitled session; expose the controller globally so openSession can reuse it.
  const sessionAutotitleController = (window.rendererSessionAutotitleUtils || {}).createSessionAutotitleController?.({
    state,
    windowRef: window,
    callbacks: {
      patchSessionSummary: (...a) => patchSessionSummary(...a),
      renderSessions: (...a) => renderSessions(...a),
      appendClientLog: (...a) => appendClientLog(...a),
    },
  }) || null;
  window.rendererSessionAutotitleController = sessionAutotitleController;
  registerRendererCleanup(() => {
    if (window.rendererSessionAutotitleController === sessionAutotitleController) {
      window.rendererSessionAutotitleController = null;
    }
  });
  const _composerV2FactoryFn = (window.rendererComposerV2Factory || {}).createComposerV2Factory;
  if (typeof _composerV2FactoryFn !== 'function') {
    throw new Error('Composer V2 factory is required');
  }
  const composerFactories = _composerV2FactoryFn({
    sendUtils,
    streamHandlerUtils,
    chatEventUtils: window.rendererChatEventUtils || {},
    createSlashCommandRegistry: shellModules.createSlashCommandRegistry,
    createContextCommand: shellModules.createContextCommand,
  });
  // Phase 3 capture-from-anywhere uses this instance only for /note captureToScratchpad.
  // without force-creating the (lazy, heavy) dashboard controller. Capture writes
  // immediately (no debounce), so this instance never arms a timer; it shares the
  // single source of truth in state.homeConfig.scratchpad.
  const scratchpadCaptureActions = (window.rendererDashboardScratchpadActions || {}).createScratchpadActions?.({
    shell: window.jennyShell || null,
    appendClientLog: (...a) => appendClientLog(...a),
    getScratchpad: () => (state.homeConfig ? state.homeConfig.scratchpad : null),
    getHomeConfig: () => state.homeConfig,
    onHomeConfig: (config) => {
      // The IPC echo is the full normalized home config; adopt it so a later
      // Home open shows the captured line, and repaint in case Home is visible.
      if (config && typeof config === 'object') {
        state.homeConfig = config;
      }
      renderAll();
    },
  }) || null;
  // Pinnable sticky-note overlay: a shell-level controller (not the lazy dashboard
  // one) so the chips survive every view switch. It owns a dedicated scratchpad-
  // actions instance for the inline pin editor; that instance's echo re-renders
  // only the overlay unless Home is visible, while the renderPinnedNotes chrome
  // hook + the dashboard manager's pinned-content renderAll keep it in sync with edits made
  // elsewhere (pin/unpin from the tab menu, Home-pad edits, note deletes).
  {
    const pinEditorActions = (window.rendererDashboardScratchpadActions || {}).createScratchpadActions?.({
      shell: window.jennyShell || null,
      appendClientLog: (...a) => appendClientLog(...a),
      getScratchpad: () => (state.homeConfig ? state.homeConfig.scratchpad : null),
      getHomeConfig: () => state.homeConfig,
      onHomeConfig: (config) => {
        if (config && typeof config === 'object') {
          state.homeConfig = config;
        }
        // A visible Home pad must repaint too, or its unfocused textarea keeps
        // the pre-edit text and the next keystroke saves it over this edit.
        if (state.ui?.activeView === 'home') {
          renderAll();
        } else {
          pinController?.render?.();
        }
      },
    }) || null;
    pinController = (window.rendererScratchpadPin || {}).createScratchpadPinController?.({
      documentRef: document,
      tabsEl: document.getElementById('pinnedNoteTabs'),
      actionButton: window.inventoryActionButton,
      textField: window.inventoryTextField,
      getState: () => state,
      actions: pinEditorActions,
      onOpenInHome: (noteId) => {
        setActiveView('home');
        if (pinEditorActions && typeof pinEditorActions.setActiveNote === 'function') {
          pinEditorActions.setActiveNote(noteId);
        }
      },
      showToastMessage,
      appendClientLog: (...a) => appendClientLog(...a),
    }) || null;
    if (pinController) {
      registerRendererCleanup(() => {
        pinEditorActions?.dispose?.();
        pinController.dispose?.();
      });
      pinController.render();
    }
  }
  // The chat shell controller builder (renderer-app-chat-shell-composition.js), pane 0 first.
  const buildChatShellController = window.rendererAppChatShellComposition.createChatShellBuilder({
    __proto__: ctx,
    attachPendingOriginToSession, closeComposerPopover, compactionCoordinator, composerFactories,
    composerToggleModule, contextUsageModule, escapeSelectorValue, getToolPreferences, handleArtifactAction,
    handleComposerToggleChange, handleCreateSessionWithWorkspace, handleErrorRecoveryAction, handleJumpToBottom,
    handleJumpToTop, healthPillController, hideAssistantSprite,
    invalidateProjectionStateForSession, loadSessionsWithWorkspace, observabilityController, openComposerPopover,
    refreshComposerToolToggles, refreshSessionSummariesWithWorkspace, refreshSnapshots, rekeySessionOrigin,
    renderAll, renderComposerJumpControls, renderComposerState, renderHeader, renderLogs, renderMessages,
    resetAttachmentQueue, scheduleBackendStatusTask, scratchpadCaptureActions, sessionAutotitleController,
    syncBackendActivityFromStatus, syncComposerVisualState, timelineVirtualizer, toggleThreadBranch,
    updateAssistantSpritePosition, viewportReveal,
  });
  chatShellController = buildChatShellController();
  const {
    startPromptSend = noopAsync,
    handleStopActiveStream = noopAsync,
    handleRegenerateMessage = noopAsync,
    flushPendingStreamCommitsForSession: chatFlushPendingStreamCommitsForSession = () => ({ flushedCount: 0, catchupRequired: false }),
    rehydrateSessionFromPersistedTurnEvents: chatRehydrateSessionFromPersistedTurnEvents = () => null,
  } = chatShellController || {};
  // Row 117: the lazily loaded browser panel's "Tell Jenny to continue"; the composer's draft is left alone.
  window.rendererSendChatPrompt = (message, sessionIdOverride) => startPromptSend(message, { sessionIdOverride, preserveComposerDraft: true, replayImageAttachments: [] });
  chatScrollCoordinator?.setTimelineVirtualizer?.(timelineVirtualizer); flushPendingStreamCommitsForSession = chatFlushPendingStreamCommitsForSession;
  rehydrateSessionFromPersistedTurnEvents = chatRehydrateSessionFromPersistedTurnEvents;
  registerRendererCleanup(() => compactionCoordinator?.dispose?.());
    result = {
      settingsShellController, chatShellController, buildRenderPipeline, buildChatShellController,
      chatWayfinderController,
      contextUsageModule,
      renderSettings, renderComposerCarriers, renderComposerPopover,
      syncComposerInputHeight,
      ensureLogRowMounted,
      scrollLogsToBottom,
      navigateToDiagnosticsTrace,
      hideAssistantSprite,
      updateAssistantSpritePosition,
      renderLayout,
      renderHeader,
      renderMessages,
      renderLogs,
      syncComposerVisualState,
      renderComposerJumpControls,
      renderComposerState,
      renderAll,
      applySurfaceEffect,
      syncBackendActivityFromStatus,
      renderLiveThinkingChip,
      setSessionOrigin,
      setPendingOrigin,
      clearPendingOrigin,
      clearProjectionContextCacheForSession,
      rekeyProjectionContextCache,
      closeComposerPopover,
      openComposerPopover,
      resetAttachmentQueue, beginAttachmentToken, cancelAttachmentToken,
      removeQueuedAttachment,
      mergePreparedAttachments,
      handleAttachmentPicker,
      prepareDroppedAttachments,
      queueInlineImageAttachment,
      setDropActive,
      suppressFileDropNavigation,
      getDroppedFilePaths,
      loadSessions, refreshSessionSummariesWithWorkspace,
      openSession,
      refreshSnapshots,
      bootstrap,
      handleRenameSession,
      refreshComposerToolToggles,
      getToolPreferences,
      handleComposerToggleChange,
      queueDeferredStartupTask,
      handleCreateSessionWithWorkspace,
      handleDeleteSessionWithWorkspace,
      startPromptSend,
      handleStopActiveStream,
      handleRegenerateMessage,
      flushPendingStreamCommitsForSession,
      rehydrateSessionFromPersistedTurnEvents,
      updateAssistantSpritePositionRef,
    };
    }
    return result || {};
  }

  root.rendererAppControllerComposition = {
    createControllerComposition,
  };
})(window);
