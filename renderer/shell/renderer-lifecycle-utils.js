(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-logging-utils'));
    return;
  }
  root.rendererLifecycleUtils = factory(root.rendererLoggingUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (loggingUtils) {
  const attachmentQueueUtils = globalThis.rendererAttachmentQueueUtils || {};
  const sessionCacheUtils = globalThis.rendererSessionCacheUtils || {};
  const sessionLifecycleUtils = globalThis.rendererSessionLifecycleUtils || {};
  const composerSessionStateUtils = globalThis.rendererComposerSessionState || {};
  const createClientLogAppender = typeof loggingUtils.createClientLogAppender === 'function'
    ? loggingUtils.createClientLogAppender
    : null;
  const clampLogTimestamp = typeof loggingUtils.clampLogTimestamp === 'function'
    ? loggingUtils.clampLogTimestamp
    : (ts) => ts;
  const sanitizeLogDetails = typeof loggingUtils.sanitizeLogDetails === 'function'
    ? loggingUtils.sanitizeLogDetails
    : (details) => (details && typeof details === 'object' && !Array.isArray(details) ? details : {});
  const LOG_RETENTION = globalThis.logContractUtils && globalThis.logContractUtils.LOG_RETENTION
    ? globalThis.logContractUtils.LOG_RETENTION
    : { rendererRetainedLimit: 500, rendererTrimThreshold: 550 };
  function resolveLifecycleModule(globalName, modulePath) {
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) return globalThis[globalName];
    if (typeof require === 'function') {
      try { return require(modulePath); } catch (_error) { /* not available */ }
    }
    return null;
  }
  const lifecycleAppearanceUtils = resolveLifecycleModule('rendererLifecycleAppearanceUtils', './renderer-lifecycle-appearance-utils');
  const lifecycleErrorUtils = resolveLifecycleModule('rendererLifecycleErrorUtils', './renderer-lifecycle-error-utils');
  const lifecycleStartupUtils = resolveLifecycleModule('rendererLifecycleStartupUtils', './renderer-lifecycle-startup-utils');
  const logForwarderUtils = resolveLifecycleModule('rendererLogForwarder', './renderer-log-forwarder');
  const logsViewStateUtils = resolveLifecycleModule('rendererDiagnosticsViewState', './renderer-diagnostics-view-state');
  const homeViewHydrateUtils = resolveLifecycleModule('rendererHomeViewHydrate', './renderer-home-view-hydrate');
  const snapshotRefreshUtils = resolveLifecycleModule('rendererSnapshotRefresh', './renderer-snapshot-refresh') || {};
  const asyncFenceUtils = resolveLifecycleModule('rendererAsyncFence', '../shared/async-fence') || {};
  // Pure value helpers live in a sibling module to keep this controller cohesive.
  const lifecycleFormatUtils = resolveLifecycleModule('rendererLifecycleFormatUtils', './renderer-lifecycle-format-utils') || {};
  const lifecycleNavigationUtils = resolveLifecycleModule('rendererLifecycleNavigation', './renderer-lifecycle-navigation');
  const lifecycleSessionActionsUtils = resolveLifecycleModule('rendererLifecycleSessionActions', './renderer-lifecycle-session-actions');
  const {
    escapeHtml,
    getSessionMonogram,
    normalizeModelToken,
    normalizeContextPreferences,
    buildModelOptionMarkup,
    mergeRequestedRuntimePreferences,
  } = lifecycleFormatUtils;
  const activeViewPersistence = resolveLifecycleModule('rendererActiveViewPersistence', './renderer-active-view-persistence') || {};
  const readPersistedActiveView = typeof activeViewPersistence.readPersistedActiveView === 'function'
    ? activeViewPersistence.readPersistedActiveView
    : function readPersistedActiveViewFallback() { return ''; };
  const persistActiveView = typeof activeViewPersistence.persistActiveView === 'function'
    ? activeViewPersistence.persistActiveView
    : function persistActiveViewFallback() {};

  function createLifecycleController(deps) {
    const { state } = deps;
    const { APPEARANCE_STORAGE_KEY, TOAST_SOURCE, INTERACTIVE_SEQUENCE_IDLE } = deps.constants;
    const {
      chatInput,
      composerAttachMenu,
      composerAttachShortcut,
    } = deps.dom;
    const {
      normalizeReasoningEffort,
      loadStoredAppearancePreferences,
      getDefaultAppearancePreferences,
      normalizeAppearancePreferences,
      applyAppearanceToDocument,
      saveStoredAppearancePreferences,
      getDefaultChatZoomPercent = function fallbackGetDefaultChatZoomPercent() { return 100; },
      normalizeChatZoomPercent = function fallbackNormalizeChatZoomPercent(value) { return Number(value) || 100; },
      applyChatZoomToDocument = function fallbackApplyChatZoomToDocument(_doc, value) {
        return normalizeChatZoomPercent(value);
      },
      isDefaultChatZoomPercent = function fallbackIsDefaultChatZoomPercent(value) {
        return normalizeChatZoomPercent(value) === getDefaultChatZoomPercent();
      },
    } = deps.callbacks;

    const call = deps.callbacks;
    let disposed = false;
    const lifecycleFence = asyncFenceUtils.createDisposalFence();
    const FWD_KEYS = ['renderComposerPopover', 'renderAttachmentTray', 'clearAttachmentNotice', 'buildAttachmentToastMessage', 'showToastMessage', 'reportError', 'renderAll', 'renderLayout', 'renderHeader', 'renderLogs', 'renderSettings', 'renderApprovedMemoryManager', 'renderIde', 'ensureIdeLoaded', 'activateIde', 'renderHomePanel', 'renderDashboard', 'notifyBootViewReady', 'syncStartupBackendStatus', 'resetArtifactsState', 'renderComposerState', 'syncComposerVisualState', 'renderPersonalityEditor', 'syncBackendNotice', 'renderSessions', 'refreshApprovedMemories', 'refreshPendingMemories', 'refreshPersonalityWorkspace', 'refreshCompanionState', 'toErrorMessage', 'refreshProactiveState', 'refreshSkillsState', 'refreshOfflineState', 'refreshAwayDigest', 'refreshPhasePercentiles', 'refreshObservability', 'syncUsageVisibility', 'initializeComposerHolo', 'initializeComposerLayoutObserver', 'warmCodeHighlighting', 'disposeCodeHighlighting', 'applyViewChrome', 'updateComposerSafeOffset', 'updateAssistantSpritePosition', 'hideAssistantSprite', 'setSidebarCollapsed', 'clearComposerStatusNotice', 'getCurrentVisibleMessages', 'getCurrentSessionMessages', 'getSessionMessages', 'setSessionMessages', 'setSessionTurnEventState', 'scrollThreadToTop', 'scrollThreadToBottom', 'scrollMessageIntoView', 'getLatestUserMessageId', 'getLatestReplyAssistantMessageId', 'isSendBusy', 'isAnySendBusy', 'setFollowLatest', 'clearStalePendingQuestionBatch', 'getPendingQuestionBatch', 'clearInteractiveDraft', 'getScrollMetrics', 'createNormalizedMessage', 'restoreSettingsNavSection', 'ensureSettingsSectionReady', 'refreshSettingsSection', 'upsertSessionSummary', 'removeSessionState', 'applySurfaceEffect', 'renderMessages', 'flushPendingStreamCommitsForSession'];
    const fwd = {};
    for (const k of FWD_KEYS) {
      fwd[k] = (...a) => (typeof call[k] === 'function' ? call[k](...a) : undefined);
    }
    const thinkingController = deps.controllers.thinkingController;
    const rendererBootstrapStartedAt =
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
    function markStartupAudit(name, details = {}) {
      try {
        globalThis.__jennyStartupAudit?.mark?.(name, details);
      } catch (_error) {
        // Best effort only.
      }
    }

    function getMultiStreamController() { return globalThis.rendererMultiStreamController || null; }

    function getActiveSession() {
      return state.sessions.find((session) => session.id === state.currentSessionId) || null;
    }
    function getRuntimePreferencesFromSession(session) {
      return {
        preferredModel: normalizeModelToken(session && session.preferred_model),
        reasoningEffort: normalizeReasoningEffort(session && session.reasoning_effort),
        runMode: session && session.run_mode,
        prePlanRunMode: session && session.pre_plan_run_mode,
        planMode: Boolean(session && session.plan_mode),
        contextPreferences: normalizeContextPreferences(session && session.context_preferences),
      };
    }

    function getCurrentRuntimePreferences() {
      const activeSession = getActiveSession();
      return activeSession
        ? getRuntimePreferencesFromSession(activeSession)
        : {
            preferredModel: normalizeModelToken(state.runtimeDraft.preferredModel),
            reasoningEffort: normalizeReasoningEffort(state.runtimeDraft.reasoningEffort),
            runMode: state.runtimeDraft.runMode,
            prePlanRunMode: state.runtimeDraft.prePlanRunMode,
            planMode: Boolean(state.runtimeDraft.planMode),
            contextPreferences: normalizeContextPreferences(state.runtimeDraft.contextPreferences),
          };
    }
    function patchSessionSummary(sessionId, patch) {
      const normalizedSessionId = String(sessionId || '').trim();
      state.sessions = state.sessions.map((session) =>
        session.id === normalizedSessionId
          ? {
              ...session,
              ...patch,
            }
          : session
      );
    }

    function syncRuntimeDraftFromActiveSession() {
      const activeSession = getActiveSession();
      if (!activeSession) {
        return;
      }
      const preferences = getRuntimePreferencesFromSession(activeSession);
      state.runtimeDraft = {
        preferredModel: preferences.preferredModel,
        reasoningEffort: preferences.reasoningEffort,
        runMode: preferences.runMode,
        prePlanRunMode: preferences.prePlanRunMode,
        planMode: preferences.planMode,
        contextPreferences: preferences.contextPreferences,
      };
    }

    function loadAppearancePreferences() {
      try {
        return loadStoredAppearancePreferences(window.localStorage);
      } catch (error) {
        return getDefaultAppearancePreferences();
      }
    }

    async function loadChatUiState() {
      try {
        const payload = await window.jennyShell?.chatUi?.getState?.();
        return {
          zoomPercent: normalizeChatZoomPercent(
            payload?.zoomPercent ?? getDefaultChatZoomPercent()
          ),
        };
      } catch (_error) {
        return {
          zoomPercent: getDefaultChatZoomPercent(),
        };
      }
    }

    // Mirrors renderer-originated entries into the on-disk shell.log (the
    // forwarder ignores electron-sourced entries arriving via pushIncomingLog).
    const clientLogForwarder = typeof logForwarderUtils?.createClientLogForwarder === 'function'
      ? logForwarderUtils.createClientLogForwarder({
        sendBatch: (batch) => {
          const appendRendererBatch = globalThis.jennyShell?.diagnostics?.logs?.appendRendererBatch;
          if (typeof appendRendererBatch === 'function') {
            appendRendererBatch(batch);
            return;
          }
          globalThis.jennyShell?.logs?.clientAppend?.(batch);
        },
        isDebugForwardingEnabled: () => state.features?.featureFlags?.agent_test_hooks === true,
      })
      : null;

    function pushLogEntry(entry) {
      const hasDiagnosticsAppender = typeof logsViewStateUtils?.appendEntryToState === 'function';
      const normalized = hasDiagnosticsAppender
        ? logsViewStateUtils.appendEntryToState(state, entry)
        : entry;
      if (!hasDiagnosticsAppender) state.logs.push(entry);
      clientLogForwarder?.enqueue(normalized);
      if (!hasDiagnosticsAppender && state.logs.length > LOG_RETENTION.rendererTrimThreshold) {
        state.logs.splice(0, state.logs.length - LOG_RETENTION.rendererRetainedLimit);
      }
    }

    const appendClientLog = createClientLogAppender
      ? createClientLogAppender({ pushLogEntry, component: 'renderer.lifecycle' })
      : function fallbackAppendClientLog(level, event, details = {}) {
        pushLogEntry({
          ts: new Date().toISOString(),
          level: String(level || 'INFO').trim().toUpperCase() || 'INFO',
          layer: 'renderer',
          component: 'renderer.lifecycle',
          event: String(event || 'renderer.event').trim() || 'renderer.event',
          message: String(details?.message || event || 'renderer.event'),
          data: details,
          details,
          source: 'renderer',
        });
      };

    function getRendererElapsedMs() {
      const now =
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now();
      return Math.max(Math.round(now - rendererBootstrapStartedAt), 0);
    }
    const deferredVisualStartupController = lifecycleStartupUtils.createDeferredVisualStartupController({
      window,
      state,
      fwd,
      appendClientLog,
      getElapsedMs: getRendererElapsedMs,
    });
    const {
      disposeLifecycleController: disposeDeferredVisualStartup,
      noteFirstRenderComplete,
      runDeferredVisualStartup,
      scheduleDeferredVisualStartup,
    } = deferredVisualStartupController;

    function disposeLifecycleController() {
      lifecycleFence.dispose();
      disposed = true;
      call.refreshObservability = undefined;
      clientLogForwarder?.dispose();
      disposeDeferredVisualStartup();
      snapshotRefresh.dispose?.(); // its catalog-retry timer
      appearanceController.disposeAppearanceRelay?.();
      attachmentQueueController?.dispose?.();
      composerSessionStateController?.clearAll?.();
      if (window.rendererComposerSessionStateController === composerSessionStateController) {
        window.rendererComposerSessionStateController = null;
      }
      if (window.rendererTaskSessionActions === taskSessionActions) window.rendererTaskSessionActions = null;
    }
    function pushIncomingLog(entry) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return;
      }
      /* Intake hardening (see renderer-logging-utils): clamp a malformed `ts`
         that would poison the newest-first sort, coerce non-string level/event,
         and size-cap / circular-guard `details` + `data`. */
      const ts = clampLogTimestamp(entry.ts);
      const details = sanitizeLogDetails(entry.details);
      const data = entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
        ? sanitizeLogDetails(entry.data)
        : details;
      pushLogEntry({
        ...entry,
        ts,
        level: entry.level == null || typeof entry.level === 'string' ? entry.level : String(entry.level),
        event: entry.event == null || typeof entry.event === 'string' ? entry.event : String(entry.event),
        layer: String(entry.layer || entry.source || '').trim() || 'electron',
        schema_version: Number(entry.schema_version || 1) || 1,
        redaction_mode: String(entry.redaction_mode || '').trim() || 'redacted',
        details,
        data,
      });
    }

    const globalErrorBoundary = lifecycleErrorUtils.createRendererGlobalErrorBoundary({
      window,
      appendClientLog,
      showToastMessage: fwd.showToastMessage,
      /* EH-W9: flag-gated intake route for global-boundary errors. */
      reportError: fwd.reportError,
      toastSource: TOAST_SOURCE.chat,
      reportRendererError(payload) {
        return window.jennyShell?.diagnostics?.reportRendererError?.(payload);
      },
    });
    const attachGlobalErrorBoundary = globalErrorBoundary.attach;
    const detachGlobalErrorBoundary = globalErrorBoundary.detach;

    function resetLogsViewState() {
      if (logsViewStateUtils && typeof logsViewStateUtils.resetLogsViewState === 'function') {
        logsViewStateUtils.resetLogsViewState(state);
      }
    }

    const homeViewHydrator = homeViewHydrateUtils
      && typeof homeViewHydrateUtils.createHomeViewHydrator === 'function'
      ? homeViewHydrateUtils.createHomeViewHydrator({ fwd, appendClientLog })
      : null;
    function hydrateHomeView(options) {
      if (homeViewHydrator) { homeViewHydrator.hydrateHomeView(options); }
    }

    const diagnosticsWorkspaceRefresher = logsViewStateUtils.createDiagnosticsWorkspaceRefresher({
      state,
      getShell: () => window.jennyShell || {},
      isDisposed: () => disposed,
      refreshPhasePercentiles: () => fwd.refreshPhasePercentiles({ render: false }),
      refreshObservability: () => fwd.refreshObservability({ silent: true }),
      renderIfVisible: () => { if (state.ui.activeView === 'logs') fwd.renderLogs(); },
      onError: (error) => appendClientLog('WARN', 'diagnostics.refresh_failed', {
        message: String(error?.message || error || ''),
      }),
    });
    function refreshDiagnosticsWorkspace() { return diagnosticsWorkspaceRefresher.refresh(); }

    const appearanceController = lifecycleAppearanceUtils.createLifecycleAppearanceUtils({
      state,
      dom: {},
      constants: { APPEARANCE_STORAGE_KEY },
      callbacks: {
        getDefaultAppearancePreferences,
        normalizeAppearancePreferences,
        applyAppearanceToDocument,
        saveStoredAppearancePreferences,
        getDefaultChatZoomPercent,
        normalizeChatZoomPercent,
        applyChatZoomToDocument,
      },
      fwd,
      call,
      appendClientLog,
      escapeHtml,
      window,
      document,
    });
    appearanceController.bindAppearanceRelay?.(); // row 88 D8: the Jenny chat's appearance reads and changes
    const {
      adjustChatZoomPercent,
      applyAppearancePreferences,
      applyChatZoomPercent,
      buildSelectOptionMarkup,
      isDefaultAppearancePreferences,
      resetChatZoomPercent,
      saveAppearancePreferences,
    } = appearanceController;

    function closeComposerPopover({ restoreFocus = false } = {}) {
      state.ui.composerPopoverOpen = false;
      fwd.renderComposerPopover();
      if (restoreFocus) composerAttachShortcut.focus();
    }

    function focusPopover(popover) {
      if (!popover || typeof popover.querySelector !== 'function') return;
      const target = [...popover.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].find((item) => !item.closest('[hidden], .hidden') && item.getAttribute('aria-disabled') !== 'true'
        && popover.ownerDocument.defaultView.getComputedStyle(item).display !== 'none'
        && popover.ownerDocument.defaultView.getComputedStyle(item).visibility !== 'hidden');
      if (target && typeof target.focus === 'function') {
        target.focus();
        return;
      }
      popover.setAttribute?.('tabindex', '-1');
      popover.focus?.();
    }

    function openComposerPopover() {
      state.ui.composerPopoverOpen = true;
      fwd.renderComposerPopover();
      focusPopover(composerAttachMenu);
    }

    const sessionCacheController = sessionCacheUtils.createSessionCacheController?.({
      state,
      getMultiStreamController,
      jennyShell: window.jennyShell || {},
      callbacks: {
        invalidateSessionArtifacts: (...a) => call.invalidateSessionArtifacts?.(...a),
        clearInteractiveDraft: (...a) => fwd.clearInteractiveDraft?.(...a),
        appendClientLog: (...a) => appendClientLog(...a),
      },
    }) || { collectSessionStreamIds: () => new Set(), getPinnedSessionIds: () => new Set(), evictColdSessionCaches: async () => {}, clearSessionStreamState: async () => {} };

    const sessionLifecycleController = sessionLifecycleUtils.createSessionLifecycleController?.({
      state,
      sessionCacheController,
      thinkingController,
      jennyShell: window.jennyShell || {},
      getMultiStreamController,
      callbacks: {
        syncRuntimeDraftFromActiveSession,
        resetAttachmentQueue: () => resetAttachmentQueue(),
        renderAll: (...a) => fwd.renderAll(...a),
        renderSessions: (...a) => fwd.renderSessions?.(...a),
        renderHeader: (...a) => fwd.renderHeader(...a),
        renderComposerState: (...a) => fwd.renderComposerState(...a),
        setFollowLatest: (...a) => fwd.setFollowLatest(...a),
        appendClientLog: (...a) => appendClientLog(...a),
        patchSessionSummary: (...a) => patchSessionSummary(...a),
        upsertSessionSummary: (...a) => fwd.upsertSessionSummary(...a),
        removeSessionState: (...a) => fwd.removeSessionState(...a),
        normalizeContextPreferences,
        clearStalePendingQuestionBatch: (...a) => fwd.clearStalePendingQuestionBatch(...a),
        getPendingQuestionBatch: (...a) => fwd.getPendingQuestionBatch(...a),
        clearInteractiveDraft: (...a) => fwd.clearInteractiveDraft(...a),
        setSessionMessages: (...a) => fwd.setSessionMessages(...a),
        setSessionTurnEventState: (...a) => fwd.setSessionTurnEventState?.(...a),
        clearComposerStatusNotice: (...a) => fwd.clearComposerStatusNotice(...a),
        resetArtifactsState: (...a) => fwd.resetArtifactsState?.(...a),
        getActiveSession,
        pruneSessionArtifacts: (...a) => call.pruneSessionArtifacts?.(...a),
        evictPretextArticlePredictions: () => {
          const _pretextUtils = typeof rendererPretextUtils !== 'undefined' ? rendererPretextUtils : null;
          if (_pretextUtils && typeof _pretextUtils.evictByPrefix === 'function') {
            _pretextUtils.evictByPrefix('article:');
          }
        },
        rehydrateLiveTurnState: (...a) => call.rehydrateSessionFromPersistedTurnEvents?.(...a),
        maybeAutoTitleSession: (...a) => globalThis.rendererSessionAutotitleController?.maybeAutoTitleSession?.(...a),
        prepareChatDockSessionTransition: (...a) => call.prepareChatDockSessionTransition?.(...a),
      },
    }) || { reconcileSessionCaches: async () => {}, refreshSessionSummaries: async () => ({ currentSessionId: '', validSessionIds: new Set() }), loadSessions: async () => {}, openSession: async () => {} };

    const collectSessionStreamIds = (...a) => sessionCacheController.collectSessionStreamIds(...a);
    const getPinnedSessionIds = (...a) => sessionCacheController.getPinnedSessionIds(...a);
    const evictColdSessionCaches = (...a) => sessionCacheController.evictColdSessionCaches(...a);
    const clearSessionStreamState = (...a) => sessionCacheController.clearSessionStreamState(...a);
    const reconcileSessionCaches = (...a) => sessionLifecycleController.reconcileSessionCaches(...a);
    const refreshSessionSummaries = (...a) => sessionLifecycleController.refreshSessionSummaries(...a);
    const loadSessions = (...a) => sessionLifecycleController.loadSessions(...a);
    const openSession = (...a) => sessionLifecycleController.openSession(...a);

    const snapshotRefresh = typeof snapshotRefreshUtils.createSnapshotRefresh === 'function'
      ? snapshotRefreshUtils.createSnapshotRefresh({
          state,
          getShell: () => window.jennyShell,
          onModelsUpdated: (models) => {
            window.reasoningEffortControls?.applyModelCatalog?.(models);
          },
          // A catalog back after "sidecar not ready": the full render rebuilds
          // both panes' model carriers (the snapshot render below does not).
          onModelCatalogRecovered: () => fwd.renderAll(),
          render: () => {
            fwd.renderHeader();
            fwd.renderSessions();
            fwd.renderComposerState();
            if (state.ui.activeView === 'settings') fwd.renderSettings();
          },
        })
      : { refreshSnapshots: async () => {} };
    const refreshSnapshots = (options = {}) => snapshotRefresh.refreshSnapshots(options);

    const lifecycleNavigation = lifecycleNavigationUtils.createLifecycleNavigation({
      state,
      fwd,
      chatInput,
      isDisposed: () => disposed,
      appendClientLog,
      markStartupAudit,
      getRendererElapsedMs,
      noteFirstRenderComplete,
      scheduleDeferredVisualStartup,
      attachGlobalErrorBoundary,
      readPersistedActiveView,
      persistActiveView,
      hydrateHomeView,
      refreshDiagnosticsWorkspace,
      loadSessions,
      refreshSnapshots,
    });
    const { bootstrap, setActiveView } = lifecycleNavigation;

    function handleJumpToTop() {
      if (!fwd.getCurrentVisibleMessages().length) {
        return;
      }
      fwd.scrollThreadToTop();
    }

    function handleJumpToBottom() {
      if (!fwd.getCurrentVisibleMessages().length) {
        return;
      }
      fwd.scrollThreadToBottom();
    }

    const lifecycleSessionActions = lifecycleSessionActionsUtils.createLifecycleSessionActions({
      state,
      fwd,
      call,
      chatInput,
      thinkingController,
      INTERACTIVE_SEQUENCE_IDLE,
      appendClientLog,
      getCurrentRuntimePreferences,
      mergeRequestedRuntimePreferences,
      normalizeReasoningEffort,
      getMultiStreamController,
      loadSessions,
      setActiveView,
      clearSessionStreamState,
      getComposerSessionStateController: () => composerSessionStateController,
    });
    const { handleCreateSession, handleRenameSession, handleDeleteSession, forgetDeletedSession } = lifecycleSessionActions;
    const taskSessionActions = { start: handleCreateSession }; window.rendererTaskSessionActions = taskSessionActions;
    window.rendererSessionTeardown = { forgetDeletedSession };

    const attachmentQueueController = attachmentQueueUtils.createAttachmentQueueController?.({ state, windowRef: window, constants: { TOAST_SOURCE }, callbacks: { clearAttachmentNotice: fwd.clearAttachmentNotice, buildAttachmentToastMessage: fwd.buildAttachmentToastMessage, showToastMessage: fwd.showToastMessage, renderAttachmentTray: fwd.renderAttachmentTray, renderComposerState: (...a) => fwd.renderComposerState(...a), closeComposerPopover, appendClientLog } }) || {};
    const { resetAttachmentQueue = () => {}, removeQueuedAttachment = () => {}, mergePreparedAttachments = () => {}, beginAttachmentToken = () => null, cancelAttachmentToken = () => false, handleAttachmentPicker = async () => {}, prepareDroppedAttachments = async () => {}, queueInlineImageAttachment = async () => null, setDropActive = () => {}, suppressFileDropNavigation = (event) => { event.preventDefault(); event.stopPropagation(); }, getDroppedFilePaths = () => [] } = attachmentQueueController;

    // UIUX-006: session-owned composer record (text/selection/attachments).
    // Exposed as a window singleton — the same pattern
    // window.rendererSessionAutotitleController already uses below — so
    // renderer-session-lifecycle-utils.js, renderer-session-utils.js,
    // renderer-attachment-queue-utils.js, renderer-send-utils.js, and
    // renderer-chat-event-utils.js can reach it without threading a new
    // dependency through every composition layer between here and there.
    const composerSessionStateController = composerSessionStateUtils.createComposerSessionState?.({
      state,
      getChatInput: () => chatInput,
      log: appendClientLog,
      releaseAssets: (paths) => window.jennyShell?.attachments?.releaseAssets?.(paths)?.catch?.(() => {}),
      renderAttachmentTray: fwd.renderAttachmentTray,
      syncComposerVisualState: fwd.syncComposerVisualState,
    }) || null;
    window.rendererComposerSessionStateController = composerSessionStateController;

    return { escapeHtml, getSessionMonogram, normalizeModelToken, normalizeContextPreferences, getActiveSession, getRuntimePreferencesFromSession, getCurrentRuntimePreferences, patchSessionSummary, syncRuntimeDraftFromActiveSession, buildModelOptionMarkup, loadAppearancePreferences, loadChatUiState, appendClientLog, getRendererElapsedMs, noteFirstRenderComplete, runDeferredVisualStartup, scheduleDeferredVisualStartup, disposeLifecycleController, pushIncomingLog, resetLogsViewState, setActiveView, refreshDiagnosticsWorkspace, setDiagnosticsObservabilityRefresh: (refresh) => { call.refreshObservability = typeof refresh === 'function' ? refresh : undefined; }, saveAppearancePreferences, applyAppearancePreferences, applyChatZoomPercent, adjustChatZoomPercent, resetChatZoomPercent, isDefaultAppearancePreferences, isDefaultChatZoomPercent, buildSelectOptionMarkup, closeComposerPopover, openComposerPopover, resetAttachmentQueue, removeQueuedAttachment, mergePreparedAttachments, beginAttachmentToken, cancelAttachmentToken, handleAttachmentPicker, prepareDroppedAttachments, queueInlineImageAttachment, setDropActive, suppressFileDropNavigation, getDroppedFilePaths, loadSessions, openSession, refreshSessionSummaries, refreshSnapshots, bootstrap, handleJumpToTop, handleJumpToBottom, handleCreateSession, handleRenameSession, handleDeleteSession, attachGlobalErrorBoundary, detachGlobalErrorBoundary };
  }

  return { createLifecycleController };
});
