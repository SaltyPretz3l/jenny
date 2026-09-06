(function (root) {
  function createControllerComposition(ctx) {
    let result = null;
    with (ctx) {
  const compactionCoordinator = window.rendererCompactionCoordinator?.createAppCompactionCoordinator?.(ctx) || null;
  state.compactionCoordinator = compactionCoordinator;
  /* settingsShellController */
  settingsShellController = (window.rendererSettingsShellControllerUtils || {}).createSettingsShellController?.({
    state,
    composerLayoutRuntime,
    reducedMotionQuery,
    dom: surfaceDom.settings,
    chatInput,
    constants: { ACTIVITY_SCOPE, TOAST_SOURCE },
    callbacks: {
      setActiveView: (...a) => setActiveView(...a),
      renderAll: (...a) => renderAll(...a),
      renderSessions: (...a) => renderSessions(...a),
      setSidebarCollapsed: (...a) => setSidebarCollapsed(...a),
      upsertApprovedMemoryDraft: (...a) => upsertApprovedMemoryDraftSafe(...a),
      getApprovedMemoryById: (...a) => getApprovedMemoryByIdSafe(...a),
      hasApprovedMemoryDraftChanges: (...a) => hasApprovedMemoryDraftChangesSafe(...a),
      clearApprovedMemoryDraft: (...a) => clearApprovedMemoryDraftSafe(...a),
      handleApprovedMemorySave: (...a) => handleApprovedMemorySaveSafe(...a),
      handleApprovedMemoryDelete: (...a) => handleApprovedMemoryDeleteSafe(...a),
        applyAppearancePreferences: (...a) => applyAppearancePreferences(...a),
        applyChatZoomPercent: (...a) => applyChatZoomPercent(...a),
        appearanceUtils,
        getDefaultAppearancePreferences,
        getDefaultChatZoomPercent: () => DEFAULT_CHAT_ZOOM_PERCENT,
        getChatZoomOptions,
        isDefaultChatZoomPercent,
        normalizeChatZoomPercent,
        applySurfaceEffect: (...a) => applySurfaceEffect(...a),
        activateSurfaceEffect: (...a) => activateSurfaceEffect(...a),
      handlePersonalityTabChange: (...a) => handlePersonalityTabChangeSafe(...a),
      getPersonalityActiveFile: (...a) => getPersonalityActiveFileSafe(...a),
      setPersonalityDraft: (...a) => setPersonalityDraftSafe(...a),
      renderPersonalityEditor: (...a) => renderPersonalityEditorSafe(...a),
      handlePersonalitySave: (...a) => handlePersonalitySaveSafe(...a),
      handlePersonalityReset: (...a) => handlePersonalityResetSafe(...a),
      handlePersonalityOpenFolder: (...a) => handlePersonalityOpenFolderSafe(...a),
      hasPersonalityUnsavedChanges: (...a) => hasPersonalityUnsavedChangesSafe(...a),
      refreshMemoryContextFiles: (...a) => refreshMemoryContextFilesSafe(...a),
      renderMemoryContextFiles: (...a) => renderMemoryContextFilesSafe(...a),
      loadMemoryContextFile: (...a) => loadMemoryContextFileSafe(...a),
      setMemoryContextDraft: (...a) => setMemoryContextDraftSafe(...a),
      getMemoryContextActiveFile: (...a) => getMemoryContextActiveFileSafe(...a),
      saveMemoryContextFile: (...a) => saveMemoryContextFileSafe(...a),
      resetMemoryContextFile: (...a) => resetMemoryContextFileSafe(...a),
      hasMemoryContextUnsavedChanges: (...a) => hasMemoryContextUnsavedChangesSafe(...a),
      showToastMessage,
      showShellErrorToast,
      toErrorMessage,
      appendClientLog: (...a) => appendClientLog(...a),
      showSessionActionError,
      getCurrentRuntimePreferences,
      getRuntimePreferenceSnapshot: (...a) => getRuntimePreferenceSnapshot(...a),
      runRuntimePreferenceActivity: (...a) => runRuntimePreferenceActivity(...a),
      handleWorkspaceRootChoose: (...a) => handleWorkspaceRootChoose(...a),
      handleRunSetupAgain: (...a) => handleRunSetupAgain(...a),
      showSetupHelp: (...a) => showSetupHelpSafe(...a),
      showFactoryReset: (...a) => showFactoryResetSafe(...a),
      refreshProactiveState: (...a) => refreshProactiveStateSafe(...a),
      refreshSkillsState: (...a) => refreshSkillsStateSafe(...a),
      bindSkillsShellEvents: (...a) => bindSkillsShellEventsSafe(...a),
      updateSkillsSettings: (...a) => updateSkillsSettingsSafe(...a),
      openSkillsScopeFolder: (...a) => openSkillsScopeFolderSafe(...a),
      refreshTipsState: (...a) => refreshTipsStateSafe(...a),
      bindTipsShellEvents: (...a) => bindTipsShellEventsSafe(...a),
      refreshOfflineState: (...a) => refreshOfflineStateSafe(...a),
      bindOfflineShellEvents: (...a) => bindOfflineShellEventsSafe(...a),
      handleOfflineModeChange: (...a) => handleOfflineModeChangeSafe(...a),
      refreshFeatureState: (...a) => refreshFeatureState(...a),
      refreshPhasePercentiles: (...a) => refreshPhasePercentiles(...a),
      resetPhasePercentiles: (...a) => resetPhasePercentiles(...a),
      renderLogs: (...a) => renderLogs(...a),
      getCurrentSessionId: () => state.currentSessionId, openSession: (...a) => openSession?.(...a),
      navigateToDiagnosticsTrace: (...a) => navigateToDiagnosticsTrace(...a),
      refreshApprovedMemories: (...a) => refreshApprovedMemoriesSafe(...a),
      refreshPendingMemories: (...a) => refreshPendingMemoriesSafe(...a),
      refreshMemoryStatus: (...a) => refreshMemoryStatusSafe(...a),
      refreshPersonalityWorkspace: (...a) => refreshPersonalityWorkspaceSafe(...a),
      listSlashCommands: () => chatShellController?.listSlashCommands?.() || [],
      normalizeAppearancePreferences,
      getPalettePresets,
      getTypographyPresets,
      getSurfaceEffectPresets,
      getThemeBundles: typeof appearanceUtils?.getThemeBundles === 'function'
        ? appearanceUtils.getThemeBundles.bind(appearanceUtils)
        : noopArr,
      getComposerHoloOptions: typeof appearanceUtils?.getComposerHoloOptions === 'function'
        ? appearanceUtils.getComposerHoloOptions.bind(appearanceUtils)
        : noopArr,
      getFontScalePresets,
      getChatWidthPresets: typeof appearanceUtils?.getChatWidthPresets === 'function'
        ? appearanceUtils.getChatWidthPresets.bind(appearanceUtils)
        : noopArr,
      detectActiveThemeBundle: typeof appearanceUtils?.detectActiveThemeBundle === 'function'
        ? appearanceUtils.detectActiveThemeBundle.bind(appearanceUtils)
        : noopNull,
      getActivitySnapshot,
      getMostRecentActivity,
      isActivityBusy,
      applyActivityAttributes,
      getActiveSession,
      buildModelOptionMarkup,
      buildSelectOptionMarkup,
      isDefaultAppearancePreferences,
      resolveComposerModelSelectWidth,
      updateComposerSafeOffset: (...a) => updateComposerSafeOffset(...a),
      renderApprovedMemoryManager: (...a) => renderApprovedMemoryManagerSafe(...a),
      renderSkillsManager: (...a) => renderSkillsManagerSafe(...a),
      renderOfflineManager: (...a) => renderOfflineManagerSafe(...a),
      escapeHtml,
    },
    factories: {
      settingsRendererUtils,
      settingsEventUtils: window.rendererSettingsEventUtils || {},
      settingsNavUtils: window.rendererSettingsNavUtils || {},
      createCometInstance: (window.cometModule || {}).createCometInstance || null,
    },
  }) || null;
  ({
    renderSettings = noop,
    renderComposerPopover = noop,
    renderCommandPopover = noop,
    syncComposerInputHeight = noop,
    syncComposerModelSelectWidth = noop,
  } = settingsShellController || {});
  /* logRendererController */
  const logRenderUtils = window.rendererDiagnosticsRenderUtils || {};
  const logRendererController = logRenderUtils.createLogRenderer?.({
    state,
    dom: { logList },
  }) || null;
  const {
    stopRelativeTimeRefresh = noop,
    getLogEntryById = () => null,
    ensureLogRowMounted = () => false,
  } = logRendererController || {};
  const scrollLogsToBottom = logRenderUtils.scrollLogsToBottom || noop;
  registerRendererCleanup(stopRelativeTimeRefresh);
  /* healthPillController (Phase 6F-A) */
  const healthPillUtils = window.rendererHealthPillUtils || {};
  const healthPillController = healthPillUtils.createHealthPillController?.({
    window,
    document,
    slot: workbenchHealthPillSlot,
    deriveRuntimeHealthState: (window.rendererRuntimeHealthUtils || {}).deriveRuntimeHealthState,
    setActiveView: (...a) => setActiveView(...a), retryBackendStart: (...a) => retryBackendStart(...a),
    setActiveSettingsSection: (sectionId) => openSettingsSection(sectionId),
    /* EH-W10: flag-gated intake route (error-center only). */
    reportError: (...a) => reportErrorWhenActive(...a),
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
    state, staticModel,
    dom: { metricList, sessionActionButton, newChatButton },
    callbacks: {
      escapeHtml,
      isSendBusy: (...a) => isSendBusy(...a),
      isAnySendBusy: (...a) => isAnySendBusy(...a),
      isSendPreflightPending: (...a) => isSendPreflightPending(...a),
      updateTokenDisplay: (...a) => updateTokenDisplay(...a),
      refreshSystemStats: () => window.jennyShell.system.refreshStats(),
    },
  }) || null;
  registerRendererCleanup(() => headerController?.dispose?.());
  const { renderHeader: _extRenderHeader = noop } = headerController || {};
  /* suggestionController */
  const suggestionUtils = globalThis.rendererSuggestionUtils || {};
  const suggestionController = suggestionUtils.createSuggestionController?.({
    state, staticModel,
    dom: { promptGrid },
    callbacks: { escapeHtml },
  }) || null;
  const { renderPrompts: _extRenderPrompts = noop, stopFallbackRotation: _extStopFallbackRotation = noop } = suggestionController || {};
  registerRendererCleanup(() => _extStopFallbackRotation());
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
  const renderPipelineController = renderPipelineUtils.createRenderPipeline?.({
    state, constants: { MESSAGE_STATUS, ACTIVITY_SCOPE, staticModel },
    dom: { homeView, chatView, ideView, chatSurface, logsView, settingsView, homeNavButton, metricList, sessionActionButton, newChatButton, promptGrid, chatTimeline, chatThreadScroll, chatThreadColumn, chatSpriteLayer, chatAssistantSprite, heroAvatar, heroTitle, heroSubtitle, heroRuntimeHint, heroStack, logSearchInput, logLevelFilter, logSourceFilter, logResultsLabel, logList, chatInput, stopStreamButton, sendButton, composer, composerModelSelect, composerEffortSelect, composerSettingsButton, jumpToTopButton, jumpToBottomButton, jumpToLastPromptButton, composerModelSelectShell, composerEffortSelectShell, chatSurfaceEffects, chatSurfaceEffectLeft, chatThreadStage, composerWrap, chatOriginChip, chatOriginLabel },
    callbacks: {
      escapeHtml, getLatestAssistantMessageId, getLatestReplyAssistantMessageId, getLatestUserMessageId, resolveRegenerateRequest, buildAssistantMetaLabel, shouldShowThinkingToggle,
      buildLogViewModel, getActivitySnapshot, getMostRecentActivity, isActivityBusy, applyActivityAttributes,
      clearActivity, failActivity, beginActivity,
      buildInteractiveRecapViewModel: (...a) => buildInteractiveRecapViewModel(...a),
      renderToolCallBlock: (...a) => renderToolCallBlock(...a), renderInteractiveRoundRecap: (...a) => renderInteractiveRoundRecap(...a),
      renderProactiveSuggestionBlock: (...a) => renderProactiveSuggestionBlock(...a), renderSlashCommandOutput: (...a) => renderSlashCommandOutput(...a), renderMessageAttachments: (...a) => renderMessageAttachments(...a),
      renderThinkingWidget: (...a) => renderThinkingWidget(...a), renderAgentStatusWidget: (...a) => renderAgentStatusWidget(...a), renderAssistantFailureNotice: (...a) => renderAssistantFailureNotice(...a), renderContextCompactedNotice: (...a) => renderContextCompactedNotice(...a), renderMessageHoverRow: (...a) => renderMessageHoverRow(...a),
      getCurrentSessionMessages: (...a) => getCurrentSessionMessages(...a), getCurrentVisibleMessages: (...a) => getCurrentVisibleMessages(...a),
      getVisibleSessionMessages: (...a) => getVisibleSessionMessages(...a), isSendBusy: (...a) => isSendBusy(...a), isAnySendBusy: (...a) => isAnySendBusy(...a), isSessionStreaming: (...a) => isSessionStreaming(...a), hasPendingToolApprovalForSession: (...a) => hasPendingToolApprovalForSession(...a), getActiveStreamSessionId: (...a) => getActiveStreamSessionId(...a),
      isInteractiveRoundRecapExpanded: (...a) => isInteractiveRoundRecapExpanded(...a),
      pruneInteractiveRoundRecapExpansionState: (...a) => pruneInteractiveRoundRecapExpansionState(...a),
      isSendPreflightPending: (...a) => isSendPreflightPending(...a), updateTokenDisplay: (...a) => updateTokenDisplay(...a),
      syncTurnElapsedClock: (...a) => chatShellController?.syncTurnElapsedClock?.(...a),
      setFollowLatest: (...a) => setFollowLatest(...a),
      scheduleMessageViewportSync: (...a) => {
        // B5: on a stream patch the decorator channel passes the resolved patchedRoot here
        // so pin-to-top does a scoped re-scan instead of the whole-timeline querySelectorAll.
        const pinScope = a[1] && typeof a[1] === 'object' ? a[1] : {};
        if (pinScope.patchedRoot && typeof pinToTopController?.refreshScoped === 'function') {
          pinToTopController.refreshScoped(pinScope.patchedRoot);
        } else {
          pinToTopController?.refresh();
        }
        chatWayfinderController?.refresh?.();
        scheduleMessageViewportSync(...a);
      },
      getPendingQuestionBatch: (...a) => getPendingQuestionBatch(...a), hasStalePendingQuestionBatch: (...a) => hasStalePendingQuestionBatch(...a),
      buildInteractiveBatchRowMarkup: (...a) => buildInteractiveBatchRowMarkup(...a),
      buildPlanProposalRowMarkup: (...a) => buildPlanProposalRowMarkup(...a),
      renderComposerInteractivePanel: (...a) => renderComposerInteractivePanel(...a), closeComposerPopover: (...a) => closeComposerPopover(...a),
      syncComposerInputHeight: (...a) => syncComposerInputHeight(...a), setComposerHoloState: (...a) => setComposerHoloState(...a), setSpriteHoloState: (...a) => setSpriteHoloState(...a),
      updateComposerSafeOffset: (...a) => updateComposerSafeOffset(...a), renderSessions: (...a) => renderSessions(...a),
      renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a),
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
      renderToastViewport: (...a) => renderToastViewport(...a), renderComposerPopover: (...a) => renderComposerPopover(...a), renderCommandPopover: (...a) => renderCommandPopover(...a),
      getCurrentRuntimePreferences: (...a) => getCurrentRuntimePreferences(...a), syncComposerModelSelectWidth: (...a) => syncComposerModelSelectWidth(...a), renderComposerEnhancements: (...a) => renderComposerEnhancements(...a),
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
      publishLifecycleStatus: (...a) => publishLifecycleStatus(...a),
      renderTurnStatusPill: (...a) => renderTurnStatusPill(...a),
      getChatSendLifecycle: (...a) => getChatSendLifecycle(...a),
      getChatTimelineRowModelEnabled: (...a) => getChatTimelineRowModelEnabled(...a),
      recordChatTimelineRolloutSignal: (...a) => recordChatTimelineRolloutSignal(...a),
      rollbackChatTimelineRowModel: (...a) => rollbackChatTimelineRowModel(...a),
      refreshActiveSurfaceEffect: (...a) => refreshActiveSurfaceEffect(...a), onSurfaceLifecycleSync: (...a) => (typeof onSurfaceLifecycleSync === 'function' ? onSurfaceLifecycleSync(...a) : undefined),
      appendClientLog: (...a) => appendClientLog(...a),
      renderHeader: (...a) => _extRenderHeader(...a),
      renderPrompts: (...a) => _extRenderPrompts(...a),
      stopFallbackRotation: (...a) => _extStopFallbackRotation(...a),
    },
    controllers: { thinkingController, reducedMotionQuery, thinkingIndicator, logRenderer: logRendererController, scrollCoordinator: chatScrollCoordinator },
    runtime: { uiRuntime, spriteRuntime },
  }) || null;
  /* approvalBatchController (Phase 6F-B) */
  const approvalBatchUtils = window.rendererApprovalBatchUtils || {};
  const approvalBatchController = approvalBatchUtils.bindApprovalBatchUx?.({
    scopeRoot: chatTimeline,
    document,
    callbacks: {
      approveOne: (callId, options) => window.jennyShell.tools.approve(callId, options || {}),
      denyOne: (callId) => window.jennyShell.tools.deny(callId),
      onError: (action, callId, error) => {
        const event = action === 'deny-all' ? 'tool.deny_failed' : 'tool.approve_failed';
        appendClientLog('ERROR', event, {
          callId,
          batch_action: action,
          message: error?.message || String(error),
        });
        // Surface batch failures with the same visible toast used by single-row approval actions.
        showComposerActionError?.(error, action === 'deny-all' ? 'Deny Failed' : 'Approval Failed');
      },
    },
  }) || null;
  if (approvalBatchController) {
    registerRendererCleanup(() => approvalBatchController.dispose?.());
  }
  /* observabilityController (Phase 6F-D) */
  const observabilityUtils = window.rendererObservabilityUtils || {};
  let _pendingTraceFocus = '';
  function navigateToDiagnosticsTrace(target = {}) {
    const streamId = String(target.streamId || '').trim();
    if (!streamId) return;
    _pendingTraceFocus = streamId;
    state.ui.diagnosticsTargetStreamId = streamId;
    state.ui.diagnosticsTargetSessionId = String(target.sessionId || '').trim();
    state.ui.diagnosticsTargetTraceId = String(target.traceId || '').trim();
    state.ui.logs.activeTab = 'activity';
    state.ui.logs.query = streamId;
    state.ui.logs.autoScroll = false;
    setActiveView('logs');
  }
  const observabilityController = observabilityUtils.createObservabilityController?.({
    window,
    dom: { toolLatencyTable, slowOperationsList, recentTracesList },
    callbacks: {
      getCurrentSessionId: () => state.currentSessionId,
      isVisible: () => state.ui.activeView === 'logs',
      peekPendingTraceFocus: () => state.ui.diagnosticsTargetStreamId || _pendingTraceFocus || '',
      clearPendingTraceFocus: (streamId) => {
        const target = String(streamId || '').trim();
        if (!target || state.ui.diagnosticsTargetStreamId === target) {
          state.ui.diagnosticsTargetStreamId = '';
        }
        if (!target || _pendingTraceFocus === target) {
          _pendingTraceFocus = '';
        }
      },
      onTraceLink: (streamId) => {
        navigateToDiagnosticsTrace({ streamId });
      },
      onSessionLink: (sessionId) => {
        if (!sessionId) return;
        try { openSession?.(sessionId); } catch (_error) { /* noop */ }
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
    const onRefreshClick = () => {
      if (observabilityRefreshButton.disabled) return;
      observabilityRefreshButton.disabled = true;
      Promise.resolve(lifecycleController?.refreshDiagnosticsWorkspace?.())
        .catch(() => {})
        .finally(() => { observabilityRefreshButton.disabled = false; });
    };
    observabilityRefreshButton.addEventListener('click', onRefreshClick);
    registerRendererCleanup(() => observabilityRefreshButton.removeEventListener('click', onRefreshClick));
  }
  const {
    formatSessionDate = () => 'Recent', formatLogTimestamp = () => '--',
    formatMessageTerminalTimestamp = noopStr, applyChatStateClasses = noop,
    syncChatState = noop,
    escapeSelectorValue = (v) => String(v || ''),
    hideAssistantSprite = noop, applyAssistantSprite = noop,
    updateAssistantSpritePosition = noop,
    renderLayout = noop, renderHeader = noop, renderPrompts = noop,
    renderMessages = noop, renderHero = noop,
    renderLogs = noop, syncComposerVisualState = noop,
    renderComposerJumpControls = noop,
    renderComposerState = noop, renderAll = noop,
    applySurfaceEffect = noop,
    syncBackendActivityFromStatus = noop,
    renderLiveThinkingChip: _renderLiveThinkingChip = noop,
    setSessionOrigin = noop,
    setPendingOrigin = noop,
    clearPendingOrigin = noop,
    attachPendingOriginToSession = noopStr,
    rekeySessionOrigin = noopStr,
    clearProjectionContextCacheForSession: pipelineClearProjectionContextCacheForSession = noopFalse,
    rekeyProjectionContextCache: pipelineRekeyProjectionContextCache = noopStr,
    invalidateProjectionStateForSession = noop,
    toggleThreadBranch = noop,
    timelineVirtualizer = null,
    dispose: disposeRenderPipeline = noop,
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
    persistSessionToolPreference: async (categoryKey, enabled, targetSessionId) => {
      const sessionId = String(targetSessionId || '').trim();
      if (!sessionId || !window.jennyShell?.sessions?.setPreferences) {
        throw new Error('Open a saved chat before setting session tool overrides.');
      }
      const active = Array.isArray(state.sessions)
        ? state.sessions.find((entry) => String(entry?.id || '') === sessionId)
        : null;
      const overrides = {
        ...(active?.tool_category_overrides && typeof active.tool_category_overrides === 'object'
          ? active.tool_category_overrides
          : {}),
        [categoryKey]: enabled === true,
      };
      const persisted = await window.jennyShell.sessions.setPreferences(sessionId, {
        tool_category_overrides: overrides,
      });
      const persistedOverrides = persisted?.tool_category_overrides;
      if (!window.rendererComposerV2Toggle?.sessionToolOverrideEchoMatches?.(
        persisted, sessionId, overrides
      )) {
        throw new Error('Session tool override persistence acknowledgement did not match the requested change.');
      }
      patchSessionSummary(sessionId, {
        tool_category_overrides: persistedOverrides,
      });
      return persisted;
    },
    onPersistError: (error, categoryId, details = {}) => {
      appendClientLog('WARN', 'composer.tool_toggle_persist_failed', {
        categoryId, message: error?.message || String(error),
      });
      if (details.isCurrent === false) return;
      showToastMessage('Could not save this chat\'s tool override. The previous value was restored.', {
        title: 'Tool Override Not Saved', tone: 'danger',
        source: TOAST_SOURCE.chatStream,
        dedupeKey: `${TOAST_SOURCE.chatStream}:tool-override-persist`,
      });
    },
  }) || null;
  /* lifecycleController late-bound (popover, attachments, sessions) */
  const {
    closeComposerPopover = noop, openComposerPopover = noop, closeCommandPopover = noop, openCommandPopover = noop, resetAttachmentQueue = noop,
    beginAttachmentToken = () => null, cancelAttachmentToken = () => false,
    removeQueuedAttachment = noop, mergePreparedAttachments = noop, handleAttachmentPicker = noopAsync,
    prepareDroppedAttachments = noopAsync, queueInlineImageAttachment = noopAsync, setDropActive = noop,
    suppressFileDropNavigation = (e) => { e.preventDefault(); e.stopPropagation(); }, getDroppedFilePaths = noopArr,
    loadSessions = noopAsync, openSession = noopAsync, refreshSessionSummaries = noopAsync,
    refreshSnapshots = noopAsync, bootstrap = noopAsync, refreshSuggestions = noopAsync,
    handleCreateSession = noopAsync, handleRenameSession = noopAsync, handleDeleteSession = noopAsync,
    handleJumpToTop = noop, handleJumpToLastPrompt = noop, handleJumpToBottom = noop,
    viewportReveal = null,
  } = lifecycleController || {};
  const chatWayfinderUtils = window.rendererChatWayfinderUtils || {};
  chatWayfinderController = (typeof chatWayfinderUtils.createChatWayfinderController === 'function'
      ? chatWayfinderUtils.createChatWayfinderController({
        state,
        document,
        host: document.getElementById('composerWayfinderHost'),
        getCurrentSessionId: () => state.currentSessionId,
        getCurrentSessionMessages: (...a) => getCurrentSessionMessages(...a),
        getScrollMetrics: (...a) => getScrollMetrics(...a),
        scrollMessageIntoView: (...a) => scrollMessageIntoView(...a),
        handleJumpToBottom: (...a) => handleJumpToBottom(...a),
        appendClientLog: (...a) => appendClientLog(...a),
      })
    : null); chatScrollCoordinator?.setWayfinderController?.(chatWayfinderController);
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
      refreshSuggestions: (...a) => refreshSuggestions(...a),
      activateWorkspaceSession: (...a) => activateWorkspaceSession(...a),
      openArtifactTarget: (...a) => openArtifactTarget(...a), openIdeFileAtLine: (...a) => openIdeFileAtLineSafe(...a), openFilePreviewTarget: (...a) => openFilePreviewTarget(...a),
    },
  }) || {};
  const {
    pruneContextUsageCache = noop,
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
    createSlashCommandRegistry: _fb.createSlashCommandRegistry,
    createContextCommand: _fb.createContextCommand,
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
  // ONLY the overlay (cheap), while the renderPinnedNotes chrome hook + the
  // dashboard manager's pins-change renderAll keep it in sync with edits made
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
        pinController?.render?.();
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
  chatShellController = (window.rendererChatShellControllerUtils || {}).createChatShellController?.({
    state,
    compactionCoordinator,
    windowRef: window,
    slashDependencies: {
      contextUsageModule,
      captureToScratchpad: (text, options) => (
        scratchpadCaptureActions
          ? scratchpadCaptureActions.captureToScratchpad(text, options)
          : Promise.resolve({ error: 'Scratchpad is unavailable.' })
      ),
      areInteractiveQuestionsAnswered,
      getInteractiveNextUnansweredIndex,
      getInteractiveQuestionOptions,
      isInteractiveQuestionAnswered,
      isInteractiveOtherTrigger,
      getInteractiveComposerStatusNotice,
    },
    dom: surfaceDom.chat,
    constants: {
      MESSAGE_STATUS,
      TOAST_SOURCE,
      ACTIVITY_SCOPE,
      MAX_INTERACTIVE_QUESTIONS,
      MAX_INTERACTIVE_ROUNDS,
      INTERACTIVE_GUARDRAIL_PROMPT,
      INTERACTIVE_SEQUENCE_IDLE,
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
    },
    controllers: {
      multiStreamController,
      thinkingController,
      thinkingIndicator,
      composerToggleModule,
      toastActionHandlers,
      timelineVirtualizer, chatScrollCoordinator,
    },
    callbacks: {
      renderAll: (...a) => renderAll(...a),
      setToolCallExpansion: (...a) => setToolCallExpansion(...a),
      appendClientLog: (...a) => appendClientLog(...a),
      escapeHtml,
      showToastMessage,
      /* EH-W9: flag-gated intake route (null when error_intake_routing is off). */
      reportError: (...a) => reportErrorWhenActive(...a),
      getCurrentSessionMessages: (...a) => getCurrentSessionMessages(...a),
      getCurrentRuntimePreferences,
      getRuntimePreferenceSnapshot: (...a) => getRuntimePreferenceSnapshot(...a),
      runRuntimePreferenceActivity: (...a) => runRuntimePreferenceActivity(...a),
      getActiveSession,
      getPendingQuestionBatch: (...a) => getPendingQuestionBatch(...a),
      normalizePendingQuestionBatch: (...a) => normalizePendingQuestionBatch(...a),
      shouldForceInteractiveGuardrail: (...a) => shouldForceInteractiveGuardrail(...a),
      getInteractiveSequenceState: (...a) => getInteractiveSequenceState(...a),
      clearInteractiveDraft: (...a) => clearInteractiveDraft(...a),
      patchSessionSummary: (...a) => patchSessionSummary(...a),
      getCurrentVisibleMessages: (...a) => getCurrentVisibleMessages(...a),
      getSessionTurnEventState: (...a) => getSessionTurnEventState(...a),
      getSessionMessages: (...a) => getSessionMessages(...a),
      setSessionMessages: (...a) => setSessionMessages(...a),
      setSessionTurnEventState: (...a) => setSessionTurnEventState(...a),
      createNormalizedMessage: (...a) => createNormalizedMessage(...a),
      resolveSessionId: (...a) => resolveSessionId(...a),
      buildAttachmentBudget: (...a) => buildAttachmentBudget(...a),
      resetAttachmentQueue: (...a) => resetAttachmentQueue(...a),
      clearComposerStatusNotice: (...a) => clearComposerStatusNotice(...a),
      isSendPreflightPending: (...a) => isSendPreflightPending(...a),
      showComposerActionError,
      renderComposerState: (...a) => renderComposerState(...a),
      renderComposerStatusNotice: (...a) => renderComposerStatusNotice(...a),
      renderLiveThinkingChip: (...a) => renderLiveThinkingChip(...a),
      renderMessages: (...a) => renderMessages(...a),
      renderSessions: (...a) => renderSessions(...a),
      renderSettings: (...a) => renderSettings(...a),
      renderWorkspaceChrome: (...a) => renderWorkspaceChrome(...a),
      renderHeader: (...a) => renderHeader(...a),
      syncComposerInputHeight: (...a) => syncComposerInputHeight(...a),
      syncComposerVisualState: (...a) => syncComposerVisualState(...a),
      setFollowLatest: (...a) => setFollowLatest(...a),
      loadSessions: (...a) => loadSessionsWithWorkspace(...a),
      refreshSessionSummaries: (...a) => refreshSessionSummariesWithWorkspace(...a),
      activateWorkspaceSession: (...a) => activateWorkspaceSession(...a),
      isSendBusy: (...a) => isSendBusy(...a),
      isAnySendBusy: (...a) => isAnySendBusy(...a),
      isSessionStreaming: (...a) => isSessionStreaming(...a),
      hasPendingToolApprovalForSession: (...a) => hasPendingToolApprovalForSession(...a),
      getCurrentMessageById: (...a) => getCurrentMessageById(...a),
      getElaboratePrompt,
      getLatestReplyAssistantMessageId,
      resolveRegenerateRequest,
      // F2: edit controller deps — projection cache invalidation + replay helpers
      clearProjectionContextCacheForSession: (...a) => clearProjectionContextCacheForSession(...a),
      invalidateProjectionStateForSession: (...a) => invalidateProjectionStateForSession(...a),
      showCopyFeedback: (...a) => showCopyFeedback(...a),
      upsertSessionSummary: (...a) => upsertSessionSummary(...a),
      removeSessionState: (...a) => removeSessionState(...a),
      rekeySessionState: (...a) => rekeySessionState(...a),
      attachPendingOriginToSession: (...a) => attachPendingOriginToSession(...a),
      rekeySessionOrigin: (...a) => rekeySessionOrigin(...a),
      onUserSendStarted: (...a) => {
        submitCometUserAction('new-message', ...a);
        sessionAutotitleController?.maybeAutoTitleSession(a[0]?.sessionId, { messageText: a[0]?.prompt });
      },
      getToolPreferences: (...a) => getToolPreferences(...a),
      setChatSendLifecycle: (...a) => setChatSendLifecycle(...a),
      clearChatSendLifecycle: (...a) => clearChatSendLifecycle(...a),
      moveChatSendLifecycle: (...a) => moveChatSendLifecycle(...a),
      buildInteractiveAnswerPrompt: (...a) => buildInteractiveAnswerPrompt(...a),
      buildInteractiveSelectedAnswers: (...a) => buildInteractiveSelectedAnswers(...a),
      ensureInteractiveDraft: (...a) => ensureInteractiveDraft(...a),
      escapeSelectorValue: (...a) => escapeSelectorValue(...a),
      getInteractiveDraft: (...a) => getInteractiveDraft(...a),
      persistRuntimePreferences: (...a) => persistRuntimePreferences(...a),
      queueInteractiveComposerFocus: (...a) => queueInteractiveComposerFocus(...a),
      renderComposerInteractivePanel: (...a) => renderComposerInteractivePanel(...a),
      getActiveSendPreflight: (...a) => getActiveSendPreflight(...a),
      setComposerStatusNotice: (...a) => setComposerStatusNotice(...a),
      setTurnStatusPill: (...a) => setTurnStatusPill(...a),
      clearTurnStatusPill: (...a) => clearTurnStatusPill(...a),
      clearTurnStatusPillSources: (...a) => clearTurnStatusPillSources(...a),
      setFaceReaction: (...a) => setFaceReaction(...a),
      handlePresenceStreamEvent: (...a) => handlePresenceStreamEvent(...a),
      handleWorkspaceActivityStreamEvent: (...a) => handleWorkspaceActivityStreamEvent(...a),
      buildInteractiveQuestionBatchVisibleText: (...a) => buildInteractiveQuestionBatchVisibleText(...a),
      refreshSnapshots: (...a) => refreshSnapshots(...a),
      refreshObservability: () => (settingsShellController?.notifyUsageTurnSettled?.(), observabilityController?.notifyTurnSettled?.(), Promise.resolve(null)),
      dismissStreamErrors: () => toastStore.dismissBySource(TOAST_SOURCE.chatStream),
      maybeSuggestMemoryCapture: (...a) => maybeSuggestMemoryCaptureSafe(...a),
      mergeMessageReasoning: (...a) => mergeMessageReasoning(...a), publishFirstTokenImpulse: (...a) => (typeof publishFirstTokenImpulse === 'function' ? publishFirstTokenImpulse(...a) : undefined),
      publishToolStartImpulse: (...a) => (typeof publishToolStartImpulse === 'function' ? publishToolStartImpulse(...a) : undefined),
      updateContextUsage: (...a) => contextUsageModule?.updateUsage?.(...a),
      getChatSendLifecycle: (...a) => getChatSendLifecycle(...a), publishCompleteImpulse: (...a) => (typeof publishCompleteImpulse === 'function' ? publishCompleteImpulse(...a) : undefined),
      getChatTimelineRowModelEnabled: (...a) => getChatTimelineRowModelEnabled(...a), publishCancelImpulse: (...a) => (typeof publishCancelImpulse === 'function' ? publishCancelImpulse(...a) : undefined),
      recordChatTimelineRolloutSignal: (...a) => recordChatTimelineRolloutSignal(...a),
      setActivityChangeListener,
      handleActivityChange: (...a) => handleActivityChange(...a),
      renderLogs: (...a) => renderLogs(...a),
      pushIncomingLog: (...a) => pushIncomingLog(...a),
      syncBackendActivityFromStatus: (...a) => syncBackendActivityFromStatus(...a),
      getRendererElapsedMs: (...a) => getRendererElapsedMs(...a),
      refreshSuggestions: (...a) => refreshSuggestions(...a),
      refreshApprovedMemories: (...a) => refreshApprovedMemoriesSafe(...a),
      resetArtifactsState: (...a) => resetArtifactsState(...a),
      resetMemorySuggestionState: (...a) => resetMemorySuggestionStateSafe(...a),
      closeComposerPopover: (...a) => closeComposerPopover(...a),
      openComposerPopover: (...a) => openComposerPopover(...a),
      closeCommandPopover: (...a) => closeCommandPopover(...a),
      openCommandPopover: (...a) => openCommandPopover(...a),
      hideAssistantSprite: (...a) => hideAssistantSprite(...a),
      updateAssistantSpritePosition: (...a) => updateAssistantSpritePosition(...a),
      setActiveView: (...a) => setActiveView(...a),
      openSetupTile: (...a) => openSetupTileSafe(...a),
      showSessionActionError,
      handleCreateSession: (...a) => handleCreateSessionWithWorkspace(...a),
      handleJumpToTop: (...a) => handleJumpToTop(...a),
      handleJumpToLastPrompt: (...a) => handleJumpToLastPrompt(...a),
      handleJumpToBottom: (...a) => handleJumpToBottom(...a),
      viewportReveal,
      syncThreadScrollState: function () {
        if (chatScrollCoordinator?.scheduleFrame) { chatScrollCoordinator.scheduleFrame(); return; }
        syncThreadScrollState();
        pinToTopController?.handleScroll();
        chatWayfinderController?.handleScroll?.();
        renderComposerJumpControls();
      },
      onUnreadOrientationStateChange: function (nextState) {
        chatWayfinderController?.setUnreadState?.(nextState);
        renderComposerJumpControls();
      },
      setUnreadOrientationController: function (nextController) {
        chatScrollCoordinator?.setUnreadController?.(nextController); chatWayfinderController?.setUnreadController?.(nextController);
      },
      toggleInteractiveRoundRecap: (...a) => toggleInteractiveRoundRecap(...a),
      toggleThreadBranch: (...a) => toggleThreadBranch(...a),
      handleFollowUpMessage: (...a) => handleFollowUpMessage(...a),
      setReasoningPhaseExpandedPreference: (...a) => setReasoningPhaseExpandedPreference(...a),
      setReasoningPhaseExpandedPreferences: (...a) => setReasoningPhaseExpandedPreferences(...a),
      syncThinkingBlockNode: (...a) => syncThinkingBlockNode(...a),
      dismissToast,
      showShellErrorToast,
      toErrorMessage,
      beginActivity,
      resolveActivity,
      failActivity,
      handleSaveProactiveSuggestionMessage: (...a) => handleSaveProactiveSuggestionMessage(...a),
      handleLaterProactiveSuggestionMessage: (...a) => handleLaterProactiveSuggestionMessage(...a),
      handleUseProactiveSuggestionMessage: (...a) => handleUseProactiveSuggestionMessageSafe(...a),
      handleLifecycleProgress: (...a) => _handleLifecycleProgress(...a),
      handleLifecycleBackendStatus: (...a) => {
        const result = _handleLifecycleBackendStatus(...a);
        const backendStatus = a[0] || {};
        const normalizedPhase = String(backendStatus?.phase || '').trim().toLowerCase();
        if (normalizedPhase === 'ready') {
          scheduleBackendStatusTask(() => {
            runStartupAuditAutoSend().catch((error) => {
              appendClientLog('WARN', 'startup_audit.auto_send_failed', {
                message: String(error?.message || error),
              });
            });
          });
        }
        if (healthPillController && typeof healthPillController.refresh === 'function') {
          scheduleBackendStatusTask(() => {
            healthPillController.refresh({ silent: true }).catch(() => null);
          });
        }
        return result;
      },
      beginModelSwitch: (...a) => beginModelSwitch(...a),
      updateModelSwitch: (...a) => updateModelSwitch(...a),
      failModelSwitch: (...a) => failModelSwitch(...a),
      adjustChatZoomPercent: (...a) => adjustChatZoomPercent(...a),
      resetChatZoomPercent: (...a) => resetChatZoomPercent(...a),
      openSettingsSection: (...a) => openSettingsSection(...a),
      handleErrorRecoveryAction: (...a) => handleErrorRecoveryAction(...a),
      handleArtifactAction: (...a) => handleArtifactAction(...a),
      handleCodeReviewAction: async (payload) => {
        try {
          return await openCodeReviewTarget(payload);
        } catch (error) {
          showComposerActionError?.(error, 'Code Review Failed');
          return false;
        }
      },
      // Diff-rows open-in-editor (ide_chat_dock Commit 2): from main chat the
      // view switches to the Workspace first (same surface rule the spec
      // pins), then the IDE resolves the changeId from its own ledger and
      // opens the diff://change/ review tab.
      handleOpenChangeDiff: async (payload) => {
        const changeId = String(payload?.changeId || '').trim();
        if (!changeId) return false;
        try {
          setActiveView('ide');
          const opened = await Promise.resolve(openIdeChangeDiffSafe(changeId));
          // 'read_failed' means the diff controller already showed its specific
          // "Jenny's Changes" toast for this click — don't stack a generic one.
          if (opened !== true && opened !== 'read_failed') {
            showComposerActionError?.(new Error('Could not find that change in the current session.'), 'Open Diff Failed');
          }
          return opened === true;
        } catch (error) {
          showComposerActionError?.(error, 'Open Diff Failed');
          return false;
        }
      },
      handleComposerToggleChange: (...a) => handleComposerToggleChange(...a),
      openArtifactTarget: (...a) => openArtifactTarget(...a),
    },
    factories: composerFactories,
  }) || null;
  const {
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
    handleRegenerateMessage = noopAsync,
    flushPendingStreamCommitsForSession: chatFlushPendingStreamCommitsForSession = () => ({ flushedCount: 0, catchupRequired: false }),
    rehydrateSessionFromPersistedTurnEvents: chatRehydrateSessionFromPersistedTurnEvents = () => null,
  } = chatShellController || {};
  chatScrollCoordinator?.setTimelineVirtualizer?.(timelineVirtualizer); flushPendingStreamCommitsForSession = chatFlushPendingStreamCommitsForSession;
  rehydrateSessionFromPersistedTurnEvents = chatRehydrateSessionFromPersistedTurnEvents;
  registerRendererCleanup(() => compactionCoordinator?.dispose?.());
    result = {
      settingsShellController, chatShellController,
      chatWayfinderController,
      contextUsageModule,
      renderSettings, renderComposerPopover,
      renderCommandPopover,
      syncComposerInputHeight,
      syncComposerModelSelectWidth,
      getLogEntryById,
      ensureLogRowMounted,
      scrollLogsToBottom,
      navigateToDiagnosticsTrace,
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
      attachPendingOriginToSession,
      rekeySessionOrigin,
      clearProjectionContextCacheForSession,
      rekeyProjectionContextCache,
      toggleThreadBranch,
      timelineVirtualizer,
      closeComposerPopover,
      openComposerPopover,
      closeCommandPopover,
      openCommandPopover,
      resetAttachmentQueue, beginAttachmentToken, cancelAttachmentToken,
      removeQueuedAttachment,
      mergePreparedAttachments,
      handleAttachmentPicker,
      prepareDroppedAttachments,
      queueInlineImageAttachment,
      setDropActive,
      suppressFileDropNavigation,
      getDroppedFilePaths,
      loadSessions,
      openSession,
      refreshSessionSummaries,
      refreshSnapshots,
      bootstrap,
      refreshSuggestions,
      handleCreateSession,
      handleRenameSession,
      handleDeleteSession,
      handleJumpToTop,
      handleJumpToLastPrompt,
      handleJumpToBottom,
      pruneContextUsageCache,
      renderComposerEnhancements,
      refreshComposerToolToggles,
      getToolPreferences,
      handleComposerToggleChange,
      queueDeferredStartupTask,
      handleErrorRecoveryAction,
      handleArtifactAction,
      loadSessionsWithWorkspace,
      refreshSessionSummariesWithWorkspace,
      handleCreateSessionWithWorkspace,
      handleDeleteSessionWithWorkspace,
      startPromptSend,
      handleStopActiveStream,
      handleSend,
      handleInteractiveOptionSelect,
      handleInteractiveOtherConfirm,
      handleInteractiveOtherInputChange,
      handleInteractiveSkip,
      handleInteractiveSkipQuestion,
      handleInteractiveSkipAll,
      handleInteractiveSubmit,
      handleCopyMessage,
      handleElaborateMessage,
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
