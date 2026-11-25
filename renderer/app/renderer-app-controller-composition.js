(function (root) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function createControllerComposition(ctx) {
  // These renderers are built below, not passed in ctx: without them a settled
  // compaction left the composer disabled. A prototype overlay, not a spread:
  // ctx members such as renderSettings are assigned later.
  const compactionCoordinator = ctx.window.rendererCompactionCoordinator?.createAppCompactionCoordinator?.(Object.assign(Object.create(ctx), {
    renderComposerState: (...a) => renderComposerState(...a),
    renderMessages: (...a) => renderMessages(...a),
    refreshSessionSummaries: (...a) => refreshSessionSummaries(...a),
  })) || null;
  ctx.state.compactionCoordinator = compactionCoordinator;
  /* settingsShellController */
  ctx.settingsShellController = ctx.window.rendererAppSettingsComposition.createSettingsShellController({
    __proto__: ctx, navigateToDiagnosticsTrace,
    get applySurfaceEffect() { return applySurfaceEffect; }, get openSession() { return openSession; },
    get renderAll() { return renderAll; }, get renderLogs() { return renderLogs; },
  });
  ({
    renderSettings: ctx.renderSettings = ctx.noop,
    renderComposerCarriers: ctx.renderComposerCarriers = ctx.noop,
    renderComposerPopover: ctx.renderComposerPopover = ctx.noop,
    syncComposerInputHeight: ctx.syncComposerInputHeight = ctx.noop,
  } = ctx.settingsShellController || {});
  ctx.settingsShellController?.whenSettingsPageReady(() => {
    ctx.window.rendererSettingsCommandSandboxUtils?.bindCommandSandboxSettings?.(ctx.window, ctx.registerRendererCleanup);
    ctx.window.rendererSettingsCloudModels?.bindCloudModelsSettings?.(ctx.window, ctx.registerRendererCleanup);
    ctx.window.rendererSettingsApiProviders?.bindApiProvidersSettings?.(ctx.window, ctx.registerRendererCleanup);
    ctx.window.rendererSettingsConversationTransfer?.bindConversationTransferSettings?.(ctx.window, ctx.registerRendererCleanup, async (id) => {
      await loadSessions(); await openSession(id); ctx.setActiveView('chat');
    });
    ctx.window.rendererSettingsPdfAddonUtils?.bindPdfAddonSettings?.(ctx.window, ctx.registerRendererCleanup);
    ctx.window.rendererSettingsCliPath?.bindCliPathSettings?.(ctx.window, ctx.registerRendererCleanup);
  });
  /* logRendererController */
  const logRenderUtils = ctx.window.rendererDiagnosticsRenderUtils || {};
  const logRendererController = logRenderUtils.createLogRenderer?.({
    state: ctx.state,
    dom: { logList: ctx.logList },
    // Diagnostics > Runs attaches to the runtime console the Settings page group publishes.
    callbacks: { ensureSettingsPage: () => ctx.settingsShellController?.ensureSettingsPage?.() },
  }) || null;
  const {
    dispose: disposeDiagnosticsView = ctx.noop,
    ensureLogRowMounted = () => false,
  } = logRendererController || {};
  const scrollLogsToBottom = logRenderUtils.scrollLogsToBottom || ctx.noop;
  ctx.registerRendererCleanup(disposeDiagnosticsView);
  /* healthPillController (Phase 6F-A) */
  const healthPillUtils = ctx.window.rendererHealthPillUtils || {};
  const healthPillController = healthPillUtils.createHealthPillController?.({
    window: ctx.window,
    document: ctx.document,
    slot: ctx.workbenchHealthPillSlot,
    deriveRuntimeHealthState: (ctx.window.rendererRuntimeHealthUtils || {}).deriveRuntimeHealthState,
    setActiveView: (...a) => ctx.setActiveView(...a), retryBackendStart: (...a) => ctx.retryBackendStart(...a),
    setActiveDiagnosticsTab: (tab) => { ctx.state.ui.logs.activeTab = tab; renderLogs(); },
    setActiveSettingsSection: (sectionId) => ctx.openSettingsSection(sectionId),
    /* EH-W10: flag-gated intake route (error-center only). */
    reportError: (...a) => ctx.reportErrorWhenActive(...a),
    showToastMessage: (...a) => ctx.showToastMessage(...a),
    /* EH-W11: badge + Recent errors popover section; optional. */
    errorCenterStore: ctx.errorCenterStore,
  }) || null;
  if (healthPillController) {
    ctx.registerRendererCleanup(() => healthPillController.dispose?.());
    healthPillController.refresh?.({ silent: true }).catch(() => null);
  }
  const backendStatusTaskFence = ctx.window.rendererAsyncFence.createDisposalFence();
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
  ctx.registerRendererCleanup(() => backendStatusTaskFence.dispose());
  /* headerController */
  const headerUtils = ctx.globalThis.rendererHeaderUtils || {};
  const headerController = headerUtils.createHeaderController?.({
    state: ctx.state,
    dom: { metricList: ctx.metricList, newChatButton: ctx.newChatButton },
    callbacks: {
      escapeHtml: ctx.escapeHtml,
      isAnySendBusy: (...a) => ctx.isAnySendBusy(...a),
      isSendPreflightPending: (...a) => ctx.isSendPreflightPending(...a),
    },
  }) || null;
  ctx.registerRendererCleanup(() => headerController?.dispose?.());
  const { renderHeader: _extRenderHeader = ctx.noop } = headerController || {};
  // B7a: bind the inline interactive batch-row builder once (it needs the
  // session pending batch + draft + question-state helpers, all in ctx) and
  // forward it to the render pipeline -> createTurnRowRenderUtils.buildBatchRowMarkup.
  const buildInteractiveBatchRowMarkup = (ctx.window.rendererInteractivePanelUtils
    && typeof ctx.window.rendererInteractivePanelUtils.createInteractiveBatchRowBuilder === 'function')
    ? ctx.window.rendererInteractivePanelUtils.createInteractiveBatchRowBuilder({
      state: ctx.state, escapeHtml: ctx.escapeHtml, isSendBusy: ctx.isSendBusy, getPendingQuestionBatch: ctx.getPendingQuestionBatch, hasStalePendingQuestionBatch: ctx.hasStalePendingQuestionBatch,
      getInteractiveDraft: ctx.getInteractiveDraft, getInteractiveQuestionOptions: ctx.getInteractiveQuestionOptions, isInteractiveQuestionAnswered: ctx.isInteractiveQuestionAnswered,
      areInteractiveQuestionsAnswered: ctx.areInteractiveQuestionsAnswered, isInteractiveOtherTrigger: ctx.isInteractiveOtherTrigger,
    })
    : function noopBuildInteractiveBatchRowMarkup() { return ''; };
  // Bind the historical inert plan-proposal row builder with its sole runtime
  // dependency, HTML escaping, then forward it to the render pipeline.
  const buildPlanProposalRowMarkup = (ctx.window.rendererPlanProposalCard
    && typeof ctx.window.rendererPlanProposalCard.createPlanProposalRowBuilder === 'function')
    ? ctx.window.rendererPlanProposalCard.createPlanProposalRowBuilder({ escapeHtml: ctx.escapeHtml })
    : function noopBuildPlanProposalRowMarkup() { return ''; };
  // Body-level pinned-note overlay controller (assigned below, mounted alongside
  // the scratchpad capture popover). Declared here so the renderPinnedNotes
  // chrome callback can close over it before its creation site runs.
  let pinController = null;
  // The empty hero names the chat's project: one lookup for every pane, torn down with the renderer.
  const heroProjects = ctx.window.rendererHeroModelState?.createSessionProjectLookup?.({ registerCleanup: ctx.registerRendererCleanup,
    getProjectSwitcher: () => ctx.getProjectSwitcher?.(), isPrimarySession: (s) => ctx.window.stringUtils?.isPrimarySession?.(s) });
  /* renderPipelineController */
  const buildRenderPipeline = (pane = {}) => ctx.renderPipelineUtils.createRenderPipeline?.({
    state: ctx.state, constants: { MESSAGE_STATUS: ctx.MESSAGE_STATUS, ACTIVITY_SCOPE: ctx.ACTIVITY_SCOPE },
    dom: { homeView: ctx.homeView, chatView: ctx.chatView, ideView: ctx.ideView, chatSurface: ctx.chatSurface, logsView: ctx.logsView, settingsView: ctx.settingsView, homeNavButton: ctx.homeNavButton, metricList: ctx.metricList, sessionActionButton: ctx.sessionActionButton, newChatButton: ctx.newChatButton, chatTimeline: ctx.chatTimeline, chatThreadScroll: ctx.chatThreadScroll, chatThreadColumn: ctx.chatThreadColumn, chatSpriteLayer: ctx.chatSpriteLayer, chatAssistantSprite: ctx.chatAssistantSprite, heroTitle: ctx.heroTitle, heroSubtitle: ctx.heroSubtitle, heroRuntimeHint: ctx.heroRuntimeHint, heroStack: ctx.heroStack, logSearchInput: ctx.logSearchInput, logLevelFilter: ctx.logLevelFilter, logSourceFilter: ctx.logSourceFilter, logResultsLabel: ctx.logResultsLabel, logList: ctx.logList, chatInput: ctx.chatInput, stopStreamButton: ctx.stopStreamButton, sendButton: ctx.sendButton, composer: ctx.composer, composerModelSelect: ctx.composerModelSelect, composerEffortSelect: ctx.composerEffortSelect, jumpToTopButton: ctx.jumpToTopButton, jumpToBottomButton: ctx.jumpToBottomButton, composerModelSelectShell: ctx.composerModelSelectShell, composerEffortSelectShell: ctx.composerEffortSelectShell, chatSurfaceEffects: ctx.chatSurfaceEffects, chatSurfaceEffectLeft: ctx.chatSurfaceEffectLeft, chatThreadStage: ctx.chatThreadStage, composerWrap: ctx.composerWrap, chatOriginChip: ctx.chatOriginChip, chatOriginLabel: ctx.chatOriginLabel, ...pane.dom },
    callbacks: {
      escapeHtml: ctx.escapeHtml, getLatestAssistantMessageId: ctx.getLatestAssistantMessageId, getLatestReplyAssistantMessageId: ctx.getLatestReplyAssistantMessageId, getLatestUserMessageId: ctx.getLatestUserMessageId, resolveRegenerateRequest: ctx.resolveRegenerateRequest, buildAssistantMetaLabel: ctx.buildAssistantMetaLabel, shouldShowThinkingToggle: ctx.shouldShowThinkingToggle,
      buildLogViewModel: ctx.buildLogViewModel, getActivitySnapshot: ctx.getActivitySnapshot, getMostRecentActivity: ctx.getMostRecentActivity, isActivityBusy: ctx.isActivityBusy, applyActivityAttributes: ctx.applyActivityAttributes,
      clearActivity: ctx.clearActivity, failActivity: ctx.failActivity, beginActivity: ctx.beginActivity,
      buildInteractiveRecapViewModel: (...a) => ctx.buildInteractiveRecapViewModel(...a),
      renderToolCallBlock: (...a) => ctx.renderToolCallBlock(...a), renderInteractiveRoundRecap: (...a) => ctx.renderInteractiveRoundRecap(...a),
      renderProactiveSuggestionBlock: (...a) => ctx.renderProactiveSuggestionBlock(...a), renderSlashCommandOutput: (...a) => ctx.renderSlashCommandOutput(...a), renderMessageAttachments: (...a) => ctx.renderMessageAttachments(...a),
      renderThinkingWidget: (...a) => ctx.renderThinkingWidget(...a), renderAgentStatusWidget: (...a) => ctx.renderAgentStatusWidget(...a), renderAssistantFailureNotice: (...a) => ctx.renderAssistantFailureNotice(...a), renderContextCompactedNotice: (...a) => ctx.renderContextCompactedNotice(...a), renderMessageHoverRow: (...a) => ctx.renderMessageHoverRow(...a),
      getCurrentSessionMessages: (...a) => ctx.getCurrentSessionMessages(...a), getCurrentVisibleMessages: (...a) => ctx.getCurrentVisibleMessages(...a),
      getVisibleSessionMessages: (...a) => ctx.getVisibleSessionMessages(...a), getSessionMessages: (...a) => ctx.getSessionMessages(...a), isSendBusy: (...a) => ctx.isSendBusy(...a), isAnySendBusy: (...a) => ctx.isAnySendBusy(...a), isSessionStreaming: (...a) => ctx.isSessionStreaming(...a), hasPendingToolApprovalForSession: (...a) => ctx.hasPendingToolApprovalForSession(...a), getActiveStreamSessionId: (...a) => ctx.getActiveStreamSessionId(...a),
      isInteractiveRoundRecapExpanded: (...a) => ctx.isInteractiveRoundRecapExpanded(...a),
      pruneInteractiveRoundRecapExpansionState: (...a) => ctx.pruneInteractiveRoundRecapExpansionState(...a),
      isSendPreflightPending: (...a) => ctx.isSendPreflightPending(...a), updateTokenDisplay: (...a) => ctx.updateTokenDisplay(...a),
      syncTurnElapsedClock: (...a) => ctx.chatShellController?.syncTurnElapsedClock?.(...a),
      setFollowLatest: (...a) => ctx.setFollowLatest(...a),
      scheduleMessageViewportSync: (...a) => {
        ctx.chatWayfinderController?.refresh?.();
        ctx.scheduleMessageViewportSync(...a);
      },
      getPendingQuestionBatch: (...a) => ctx.getPendingQuestionBatch(...a), hasStalePendingQuestionBatch: (...a) => ctx.hasStalePendingQuestionBatch(...a),
      buildInteractiveBatchRowMarkup: (...a) => buildInteractiveBatchRowMarkup(...a),
      buildPlanProposalRowMarkup: (...a) => buildPlanProposalRowMarkup(...a),
      renderComposerInteractivePanel: (...a) => ctx.renderComposerInteractivePanel(...a), closeComposerPopover: (...a) => closeComposerPopover(...a),
      syncComposerInputHeight: (...a) => ctx.syncComposerInputHeight(...a), setComposerHoloState: (...a) => ctx.setComposerHoloState(...a),
      updateComposerSafeOffset: (...a) => ctx.updateComposerSafeOffset(...a), renderSessions: (...a) => ctx.renderSessions(...a),
      renderWorkspaceChrome: (...a) => ctx.renderWorkspaceChrome(...a),
      renderComposerCarriers: (...a) => ctx.renderComposerCarriers(...a),
      renderSettings: (...a) => ctx.renderSettings(...a), renderIde: (...a) => ctx.renderIdeSafe(...a), layoutIdeEditor: (...a) => ctx.layoutIdeEditorSafe(...a), reconcileChatDockHost: (...a) => ctx.reconcileChatDockHostSafe(...a),
      renderArtifactReviewPanel: (...a) => ctx.renderArtifactReviewPanelSafe(...a),
      isArtifactReviewVisible: (...a) => ctx.isArtifactReviewVisible(...a),
      getArtifactsForSession: (...a) => ctx.getArtifactsForSession(...a),
      selectArtifact: (...a) => ctx.selectArtifact(...a),
      renderContextPanel: () => ctx.contextPanelController?.renderContextPanel?.(),
      renderPinnedNotes: () => pinController?.render?.(),
      shouldRenderHomePanel: (...a) => ctx.shouldRenderHomePanelSafe(...a),
      renderHomePanel: (...a) => ctx.renderHomePanelSafe(...a),
      renderAttachmentTray: (...a) => ctx.renderAttachmentTray(...a), renderComposerStatusNotice: (...a) => ctx.renderComposerStatusNotice(...a), setComposerStatusNotice: (...a) => ctx.setComposerStatusNotice(...a), clearComposerStatusNotice: (...a) => ctx.clearComposerStatusNotice(...a), syncBackendNotice: (...a) => ctx.syncBackendNotice(...a),
      renderToastViewport: (...a) => ctx.renderToastViewport(...a), renderComposerPopover: (...a) => ctx.renderComposerPopover(...a),
      getCurrentRuntimePreferences: (...a) => ctx.getCurrentRuntimePreferences(...a), getRuntimePreferencesFromSession: ctx.getRuntimePreferencesFromSession, renderComposerEnhancements: (...a) => renderComposerEnhancements(...a),
      renderMarkdown: (...a) => (ctx.window.markdownUtils?.renderMarkdown ? ctx.window.markdownUtils.renderMarkdown(...a) : ctx.escapeHtml(String(a[0] || ''))),
      renderStreamingMarkdownUnits: (...a) => (
        ctx.window.markdownUtils?.renderStreamingMarkdownUnits
          ? ctx.window.markdownUtils.renderStreamingMarkdownUnits(...a)
          : {
              html: ctx.escapeHtml(String(a[0] || '')),
              units: [],
              fingerprints: [],
            changedStartIndex: -1,
          }
      ),
      syncPersistedReasoningPhaseExpansionState: (...a) => ctx.syncPersistedReasoningPhaseExpansionState(...a),
      getChatSendLifecycle: (...a) => ctx.getChatSendLifecycle(...a),
      getChatTimelineRowModelEnabled: (...a) => ctx.getChatTimelineRowModelEnabled(...a),
      recordChatTimelineRolloutSignal: (...a) => ctx.recordChatTimelineRolloutSignal(...a),
      rollbackChatTimelineRowModel: (...a) => ctx.rollbackChatTimelineRowModel(...a),
      refreshActiveSurfaceEffect: (...a) => ctx.refreshActiveSurfaceEffect(...a), onSurfaceLifecycleSync: (...a) => (typeof ctx.onSurfaceLifecycleSync === 'function' ? ctx.onSurfaceLifecycleSync(...a) : undefined),
      appendClientLog: (...a) => ctx.appendClientLog(...a),
      getSessionProject: (s) => heroProjects?.getSessionProject(s) || null, onProjectsChanged: (fn) => heroProjects?.onProjectsChanged(fn),
      renderHeader: (...a) => _extRenderHeader(...a), syncPaneLayout: (kind) => ctx.getPaneComposition?.()?.syncPaneLayout?.(kind), ...pane.overrides,
    },
    controllers: { thinkingController: ctx.thinkingController, reducedMotionQuery: ctx.reducedMotionQuery, thinkingIndicator: ctx.thinkingIndicator, logRenderer: logRendererController, scrollCoordinator: ctx.chatScrollCoordinator,
      getSendOutboxActions: () => ctx.chatShellController?.sendOutboxActions, ...pane.controllers,
    },
    runtime: { uiRuntime: ctx.uiRuntime, spriteRuntime: ctx.spriteRuntime, ...pane.runtime },
  }) || null;
  const renderPipelineController = buildRenderPipeline();
  /* observabilityController (Phase 6F-D) */
  const observabilityUtils = ctx.window.rendererObservabilityUtils || {};
  function navigateToDiagnosticsTrace(target = {}) {
    const streamId = String(target.streamId || '').trim();
    if (!streamId) return;
    // Traces come from the live runtime, so they focus the current run; the
    // previously selected run is kept in returnState.
    ctx.window.rendererDiagnosticsViewState.focusDiagnosticsTarget(ctx.state, { tab: 'activity', query: streamId, runId: '' });
    ctx.setActiveView('logs');
    ctx.window.dispatchEvent(new ctx.window.CustomEvent('diagnostics:focus-log-entry', { detail: { entryId: '' } }));
  }
  const observabilityController = observabilityUtils.createObservabilityController?.({
    window: ctx.window,
    dom: { toolLatencyTable: ctx.toolLatencyTable, slowOperationsList: ctx.slowOperationsList, recentTracesList: ctx.recentTracesList },
    callbacks: {
      getCurrentSessionId: () => ctx.state.currentSessionId,
      isVisible: () => ctx.state.ui.activeView === 'logs',
      // The Overview reads these three facets from the diagnostics status to decide which groups show.
      onSnapshot: (snapshot) => {
        if (!snapshot || typeof snapshot !== 'object') return;
        const facets = {};
        ['tool_observability', 'slow_operations', 'trace_timing'].forEach((key) => { facets[key] = snapshot[key]; });
        ctx.state.diagnosticsStatus = { ...(ctx.state.diagnosticsStatus || {}), ...facets };
        if (ctx.state.ui.activeView === 'logs') renderLogs();
      },
      onTraceLink: (streamId) => {
        navigateToDiagnosticsTrace({ streamId });
      },
    },
  }) || null;
  if (observabilityController) {
    ctx.lifecycleController?.setDiagnosticsObservabilityRefresh?.((options) => observabilityController.refresh?.(options));
    ctx.registerRendererCleanup(() => {
      ctx.lifecycleController?.setDiagnosticsObservabilityRefresh?.(null);
      observabilityController.dispose?.();
    });
  }
  if (ctx.observabilityRefreshButton) {
    // Busy stays focusable: aria-disabled, never the disabled property (focus would drop to body).
    const onRefreshClick = () => {
      if (ctx.observabilityRefreshButton.getAttribute('aria-disabled') === 'true') return;
      ctx.observabilityRefreshButton.setAttribute('aria-disabled', 'true');
      Promise.resolve(ctx.lifecycleController?.refreshDiagnosticsWorkspace?.())
        .catch(() => {})
        .finally(() => { ctx.observabilityRefreshButton.removeAttribute('aria-disabled'); });
    };
    ctx.observabilityRefreshButton.addEventListener('click', onRefreshClick);
    ctx.registerRendererCleanup(() => ctx.observabilityRefreshButton.removeEventListener('click', onRefreshClick));
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
  ctx.clearProjectionContextCacheForSession = (...a) => pipelineClearProjectionContextCacheForSession(...a);
  ctx.rekeyProjectionContextCache = (...a) => pipelineRekeyProjectionContextCache(...a);
  ctx.updateAssistantSpritePositionRef = (...a) => updateAssistantSpritePosition(...a);
  ctx.registerRendererCleanup(() => disposeRenderPipeline());
  ctx.renderLiveThinkingChip = _renderLiveThinkingChip;

  const contextUsageModule = ctx.window.rendererContextUsageUtils || null;
  const composerToggleModule = (ctx.window.rendererComposerV2Toggle || {}).createComposerV2ToggleController?.({
    state: ctx.state,
    getCurrentSessionId: () => ctx.state.currentSessionId,
    readBrowserDefault: async () => (await ctx.window.jennyShell?.chatUi?.getState?.())?.browserOnInNewChats === true,
    persistBrowserDefault: (enabled) => ctx.window.jennyShell?.chatUi?.updateSettings?.({ browserOnInNewChats: enabled }),
    persistSessionToolPreference: async (overrides, targetSessionId) => {
      const sessionId = String(targetSessionId || '').trim();
      if (!sessionId || !ctx.window.jennyShell?.sessions?.setPreferences) {
        throw new Error('Open a saved chat before setting session tool overrides.');
      }
      const persisted = await ctx.window.jennyShell.sessions.setPreferences(sessionId, overrides);
      if (!ctx.window.rendererComposerV2Toggle?.sessionToolOverrideEchoMatches?.(
        persisted, sessionId, overrides
      )) {
        throw new Error('Session tool override persistence acknowledgement did not match the requested change.');
      }
      ctx.patchSessionSummary(sessionId, {
        tool_category_overrides: persisted.tool_category_overrides,
        tool_connection_overrides: persisted.tool_connection_overrides,
      });
      return persisted;
    },
    onPersistError: (error, categoryId, details = {}) => {
      ctx.appendClientLog('WARN', 'composer.tool_toggle_persist_failed', {
        categoryId, message: error?.message || String(error),
      });
      if (details.isCurrent === false) return;
      ctx.showToastMessage(jt('app.shell.toolOverrideSaveFailed', "Couldn't save this chat's tools. Try again."), {
        title: jt('app.shell.toolOverrideNotSavedTitle', 'Tool Override Not Saved'), tone: 'danger',
        source: ctx.TOAST_SOURCE.chatStream,
        dedupeKey: `${ctx.TOAST_SOURCE.chatStream}:tool-override-persist`,
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
  } = ctx.lifecycleController || {};
  const chatWayfinderUtils = ctx.window.rendererChatWayfinderUtils || {};
  ctx.chatWayfinderController = (typeof chatWayfinderUtils.createChatWayfinderController === 'function'
      ? chatWayfinderUtils.createChatWayfinderController({
        state: ctx.state,
        onChange: () => renderComposerJumpControls?.(),
        getCurrentSessionId: () => ctx.state.currentSessionId,
        getCurrentSessionMessages: (...a) => ctx.getCurrentSessionMessages(...a),
        getScrollMetrics: (...a) => ctx.getScrollMetrics(...a),
        appendClientLog: (...a) => ctx.appendClientLog(...a),
      })
    : null); ctx.chatScrollCoordinator?.setWayfinderController?.(ctx.chatWayfinderController);
  // Chat links into another registered project (primary chat): the folder list and the open-in-IDE-after-switching route.
  const projectLinkHooks = ctx.window.jennyWorkspacePathResolve?.createProjectLinkHooks?.({
    getProjectSwitcher: (...a) => ctx.getProjectSwitcher?.(...a), openIdeFileAtLine: (...a) => ctx.openIdeFileAtLineSafe(...a), setActiveView: (...a) => ctx.setActiveView(...a),
  }) || {};
  const shellRuntimeController = (ctx.window.rendererShellRuntimeUtils || {}).createShellRuntimeController?.({
    state: ctx.state,
    windowRef: ctx.window,
    dom: {
      composerContextUsageSlot: ctx.composerContextUsageSlot,
      composerPlanUsageSlot: ctx.composerPlanUsageSlot,
      composerToolToggleSlot: ctx.composerToolToggleSlot,
    },
    constants: { TOAST_SOURCE: ctx.TOAST_SOURCE },
    modules: {
      contextUsageModule,
      composerToggleModule,
    },
    callbacks: {
      appendClientLog: (...a) => ctx.appendClientLog(...a),
      renderAll: (...a) => renderAll(...a),
      renderSettings: (...a) => ctx.renderSettings(...a),
      renderWorkspaceChrome: (...a) => ctx.renderWorkspaceChrome(...a),
      renderComposerState: (...a) => renderComposerState(...a),
      syncComposerInputHeight: (...a) => ctx.syncComposerInputHeight(...a),
      showToastMessage: (...a) => ctx.showToastMessage(...a),
      toErrorMessage: (...a) => ctx.toErrorMessage(...a),
      showComposerActionError: (...a) => ctx.showComposerActionError(...a),
      openSettingsSection: (...a) => ctx.openSettingsSection(...a),
      setActiveView: (...a) => ctx.setActiveView(...a),
      getLatestReplyAssistantMessageId: (...a) => ctx.getLatestReplyAssistantMessageId(...a),
      getCurrentVisibleMessages: (...a) => ctx.getCurrentVisibleMessages(...a),
      getCurrentMessageById: (...a) => ctx.getCurrentMessageById(...a),
      isSendPreflightPending: (...a) => ctx.isSendPreflightPending(...a),
      loadSessions: (...a) => loadSessions(...a),
      refreshSessionSummaries: (...a) => refreshSessionSummaries(...a),
      handleCreateSession: (...a) => handleCreateSession(...a),
      handleDeleteSession: (...a) => handleDeleteSession(...a),
      syncWorkspaceFromStore: (...a) => ctx.syncWorkspaceFromStore(...a),
      applyWorkspaceSnapshot: (...a) => ctx.applyWorkspaceSnapshot(...a),
      renderSessions: (...a) => ctx.renderSessions(...a),
      activateWorkspaceSession: (...a) => ctx.activateWorkspaceSession(...a), focusComposer: () => ctx.getPaneComposition?.()?.focusComposer?.() || ctx.chatInput?.focus?.(),
      openArtifactTarget: (...a) => ctx.openArtifactTarget(...a), openIdeFileAtLine: (...a) => ctx.openIdeFileAtLineSafe(...a), revealIdePath: (...a) => ctx.revealIdePathSafe(...a), openFilePreviewTarget: (...a) => ctx.openFilePreviewTarget(...a),
      openProjectFileInIde: projectLinkHooks.openProjectFileInIde, getProjectRoots: projectLinkHooks.getProjectRoots,
    },
  }) || {};
  const {
    renderComposerEnhancements = ctx.noop,
    refreshComposerToolToggles = ctx.noopAsync,
    getToolPreferences = ctx.noopObj,
    handleComposerToggleChange = ctx.noop,
    queueDeferredStartupTask = ctx.noop,
    handleErrorRecoveryAction: baseHandleErrorRecoveryAction = ctx.noopAsync,
    handleArtifactAction = ctx.noopAsync,
    loadSessionsWithWorkspace = ctx.noopAsync,
    refreshSessionSummariesWithWorkspace = ctx.noopAsync,
    handleCreateSessionWithWorkspace = ctx.noopAsync,
    handleDeleteSessionWithWorkspace = ctx.noopAsync,
  } = shellRuntimeController;
  const handleErrorRecoveryAction = (payload) => baseHandleErrorRecoveryAction(payload, {
    handleRegenerateMessage: (...a) => handleRegenerateMessage(...a),
    handleCreateSessionWithWorkspace: (...a) => handleCreateSessionWithWorkspace(...a),
  });
  // Auto-title the first send into an untitled session; expose the controller globally so openSession can reuse it.
  const sessionAutotitleController = (ctx.window.rendererSessionAutotitleUtils || {}).createSessionAutotitleController?.({
    state: ctx.state,
    windowRef: ctx.window,
    callbacks: {
      patchSessionSummary: (...a) => ctx.patchSessionSummary(...a),
      renderSessions: (...a) => ctx.renderSessions(...a),
      appendClientLog: (...a) => ctx.appendClientLog(...a),
    },
  }) || null;
  ctx.window.rendererSessionAutotitleController = sessionAutotitleController;
  ctx.registerRendererCleanup(() => {
    if (ctx.window.rendererSessionAutotitleController === sessionAutotitleController) {
      ctx.window.rendererSessionAutotitleController = null;
    }
  });
  const _composerV2FactoryFn = (ctx.window.rendererComposerV2Factory || {}).createComposerV2Factory;
  if (typeof _composerV2FactoryFn !== 'function') {
    throw new Error('Composer V2 factory is required');
  }
  const composerFactories = _composerV2FactoryFn({
    sendUtils: ctx.sendUtils,
    streamHandlerUtils: ctx.streamHandlerUtils,
    chatEventUtils: ctx.window.rendererChatEventUtils || {},
    createSlashCommandRegistry: ctx.shellModules.createSlashCommandRegistry,
    createContextCommand: ctx.shellModules.createContextCommand,
  });
  // Phase 3 capture-from-anywhere uses this instance only for /note captureToScratchpad.
  // without force-creating the (lazy, heavy) dashboard controller. Capture writes
  // immediately (no debounce), so this instance never arms a timer; it shares the
  // single source of truth in state.homeConfig.scratchpad.
  const scratchpadCaptureActions = (ctx.window.rendererDashboardScratchpadActions || {}).createScratchpadActions?.({
    shell: ctx.window.jennyShell || null,
    appendClientLog: (...a) => ctx.appendClientLog(...a),
    getScratchpad: () => (ctx.state.homeConfig ? ctx.state.homeConfig.scratchpad : null),
    getHomeConfig: () => ctx.state.homeConfig,
    onHomeConfig: (config) => {
      // The IPC echo is the full normalized home config; adopt it so a later
      // Home open shows the captured line, and repaint in case Home is visible.
      if (config && typeof config === 'object') {
        ctx.state.homeConfig = config;
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
    const pinEditorActions = (ctx.window.rendererDashboardScratchpadActions || {}).createScratchpadActions?.({
      shell: ctx.window.jennyShell || null,
      appendClientLog: (...a) => ctx.appendClientLog(...a),
      getScratchpad: () => (ctx.state.homeConfig ? ctx.state.homeConfig.scratchpad : null),
      getHomeConfig: () => ctx.state.homeConfig,
      onHomeConfig: (config) => {
        if (config && typeof config === 'object') {
          ctx.state.homeConfig = config;
        }
        // A visible Home pad must repaint too, or its unfocused textarea keeps
        // the pre-edit text and the next keystroke saves it over this edit.
        if (ctx.state.ui?.activeView === 'home') {
          renderAll();
        } else {
          pinController?.render?.();
        }
      },
    }) || null;
    pinController = (ctx.window.rendererScratchpadPin || {}).createScratchpadPinController?.({
      documentRef: ctx.document,
      tabsEl: ctx.document.getElementById('pinnedNoteTabs'),
      actionButton: ctx.window.inventoryActionButton,
      textField: ctx.window.inventoryTextField,
      getState: () => ctx.state,
      actions: pinEditorActions,
      onOpenInHome: (noteId) => {
        ctx.setActiveView('home');
        if (pinEditorActions && typeof pinEditorActions.setActiveNote === 'function') {
          pinEditorActions.setActiveNote(noteId);
        }
      },
      showToastMessage: ctx.showToastMessage,
      appendClientLog: (...a) => ctx.appendClientLog(...a),
    }) || null;
    if (pinController) {
      ctx.registerRendererCleanup(() => {
        pinEditorActions?.dispose?.();
        pinController.dispose?.();
      });
      pinController.render();
    }
  }
  // The chat shell controller builder (renderer-app-chat-shell-composition.js), pane 0 first.
  const buildChatShellController = ctx.window.rendererAppChatShellComposition.createChatShellBuilder({
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
  ctx.chatShellController = buildChatShellController();
  const {
    startPromptSend = ctx.noopAsync,
    handleStopActiveStream = ctx.noopAsync,
    handleRegenerateMessage = ctx.noopAsync,
    flushPendingStreamCommitsForSession: chatFlushPendingStreamCommitsForSession = () => ({ flushedCount: 0, catchupRequired: false }),
    rehydrateSessionFromPersistedTurnEvents: chatRehydrateSessionFromPersistedTurnEvents = () => null,
  } = ctx.chatShellController || {};
  // Row 117: the lazily loaded browser panel's "Tell Jenny to continue"; the composer's draft is left alone.
  ctx.window.rendererSendChatPrompt = (message, sessionIdOverride) => startPromptSend(message, { sessionIdOverride, preserveComposerDraft: true, replayImageAttachments: [] });
  ctx.chatScrollCoordinator?.setTimelineVirtualizer?.(timelineVirtualizer); ctx.flushPendingStreamCommitsForSession = chatFlushPendingStreamCommitsForSession;
  ctx.rehydrateSessionFromPersistedTurnEvents = chatRehydrateSessionFromPersistedTurnEvents;
  ctx.registerRendererCleanup(() => compactionCoordinator?.dispose?.());
    return {
      settingsShellController: ctx.settingsShellController, chatShellController: ctx.chatShellController, buildRenderPipeline, buildChatShellController,
      chatWayfinderController: ctx.chatWayfinderController,
      contextUsageModule,
      renderSettings: ctx.renderSettings, renderComposerCarriers: ctx.renderComposerCarriers, renderComposerPopover: ctx.renderComposerPopover,
      syncComposerInputHeight: ctx.syncComposerInputHeight,
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
      renderLiveThinkingChip: ctx.renderLiveThinkingChip,
      setSessionOrigin,
      setPendingOrigin,
      clearPendingOrigin,
      clearProjectionContextCacheForSession: ctx.clearProjectionContextCacheForSession,
      rekeyProjectionContextCache: ctx.rekeyProjectionContextCache,
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
      flushPendingStreamCommitsForSession: ctx.flushPendingStreamCommitsForSession,
      rehydrateSessionFromPersistedTurnEvents: ctx.rehydrateSessionFromPersistedTurnEvents,
      updateAssistantSpritePositionRef: ctx.updateAssistantSpritePositionRef,
    };
  }

  root.rendererAppControllerComposition = {
    createControllerComposition,
  };
})(window);
