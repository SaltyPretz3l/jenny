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
  const {
    escapeHtml,
    getSessionMonogram,
    normalizeModelToken,
    normalizeContextPreferences,
    buildModelOptionMarkup,
    mergeRequestedRuntimePreferences,
  } = lifecycleFormatUtils;
  function createLocalDraftSessionId() { return `session_local_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`; }

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
      composerSettingsPopover,
      composerSettingsButton,
      composerCommandPopover,
      composerTerminalShortcut,
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
    const FWD_KEYS = ['renderComposerPopover', 'renderCommandPopover', 'renderAttachmentTray', 'clearAttachmentNotice', 'buildAttachmentToastMessage', 'showToastMessage', 'reportError', 'renderAll', 'renderLayout', 'renderHeader', 'renderLogs', 'renderSettings', 'renderApprovedMemoryManager', 'renderIde', 'activateIde', 'renderHomePanel', 'renderDashboard', 'notifyBootViewReady', 'syncStartupBackendStatus', 'resetArtifactsState', 'renderPrompts', 'renderComposerState', 'syncComposerVisualState', 'renderPersonalityEditor', 'syncBackendNotice', 'renderSessions', 'refreshApprovedMemories', 'refreshPendingMemories', 'refreshPersonalityWorkspace', 'refreshCompanionState', 'toErrorMessage', 'refreshProactiveState', 'refreshSkillsState', 'refreshTipsState', 'refreshOfflineState', 'refreshPhasePercentiles', 'refreshObservability', 'syncUsageVisibility', 'initializeComposerHolo', 'initializeSpriteHolo', 'initializeComposerLayoutObserver', 'warmCodeHighlighting', 'disposeCodeHighlighting', 'applyViewChrome', 'updateComposerSafeOffset', 'updateAssistantSpritePosition', 'hideAssistantSprite', 'setSidebarCollapsed', 'clearComposerStatusNotice', 'getCurrentVisibleMessages', 'getCurrentSessionMessages', 'getSessionMessages', 'setSessionMessages', 'setSessionTurnEventState', 'scrollThreadToTop', 'scrollThreadToBottom', 'scrollMessageIntoView', 'getLatestUserMessageId', 'getLatestReplyAssistantMessageId', 'isSendBusy', 'isAnySendBusy', 'setFollowLatest', 'clearStalePendingQuestionBatch', 'getPendingQuestionBatch', 'clearInteractiveDraft', 'getScrollMetrics', 'createNormalizedMessage', 'restoreSettingsNavSection', 'ensureSettingsSectionReady', 'refreshSettingsSection', 'upsertSessionSummary', 'removeSessionState', 'applySurfaceEffect', 'renderMessages', 'flushPendingStreamCommitsForSession'];
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

    async function enableStartupAuditIfNeeded() {
      const diagnostics = globalThis?.jennyShell?.diagnostics;
      if (!diagnostics?.getStartupAuditConfig) {
        return null;
      }
      try {
        const config = await diagnostics.getStartupAuditConfig();
        if (config?.enabled === true) {
          globalThis.__jennyStartupAudit?.enable?.(config);
        }
        return config || null;
      } catch (_error) {
        return null;
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

    // One-shot first-open metrics for hidden surfaces.
    const hiddenSurfaceFirstActivationMarked = new Set();
    function markHiddenSurfaceFirstActivation(viewId) {
      if (hiddenSurfaceFirstActivationMarked.has(viewId)) {
        return;
      }
      hiddenSurfaceFirstActivationMarked.add(viewId);
      markStartupAudit('hidden-surface-first-activation', { view: viewId });
    }
    let pluginSessionViewGuardPass = false;
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
    function setActiveView(viewId) {
      const previousViewId = state.ui.activeView;
      // Session-bound plugin views own privileged operations independently of
      // renderer lifetime. Leaving one must await broker-confirmed teardown.
      if (!pluginSessionViewGuardPass && previousViewId === 'plugin' && viewId !== 'plugin') {
        const pluginSessions = globalThis.rendererPluginSessions?.instance || null;
        const activeSessionId = pluginSessions?.getActiveSessionId?.() || '';
        if (activeSessionId) {
          pluginSessions.guardLeaveSession(activeSessionId, 'view_switch').then((proceed) => {
            if (lifecycleFence.isDisposed() || !proceed) { return; }
            pluginSessionViewGuardPass = true;
            try { setActiveView(viewId); } finally { pluginSessionViewGuardPass = false; }
          }).catch(() => null);
          return;
        }
      }
      state.ui.activeView = viewId;
      persistActiveView(viewId);
      if (previousViewId === 'settings' && viewId !== 'settings') {
        fwd.syncUsageVisibility();
      }

      if (typeof document !== 'undefined' && document.documentElement?.dataset) {
        document.documentElement.dataset.activeView = String(viewId || '').trim() || 'chat';
      }
      fwd.applyViewChrome();
      fwd.renderLayout();
      fwd.renderHeader();
      if (viewId === 'ide') {
        markHiddenSurfaceFirstActivation('ide');
        fwd.renderIde?.();
        fwd.activateIde?.();
      }
      fwd.syncBackendNotice?.();
      if (viewId === 'logs') {
        markHiddenSurfaceFirstActivation('logs');
        fwd.renderLogs();
        refreshDiagnosticsWorkspace().catch(() => {});
      }
      if (viewId === 'settings') {
        markHiddenSurfaceFirstActivation('settings');
        fwd.renderSettings();
        fwd.restoreSettingsNavSection();
        const activeSection = String(state.ui.activeSettingsSection || 'models').trim() || 'models';
        fwd.ensureSettingsSectionReady?.(activeSection);
        fwd.refreshSettingsSection?.(activeSection).catch((error) => {
          if (activeSection === 'personality') {
            state.personality.loadStatus = `Unable to refresh workspace: ${error.message || String(error)}`;
            fwd.renderPersonalityEditor();
          }
          appendClientLog('WARN', 'settings.refresh_section_failed', {
            section: activeSection,
            message: String(error?.message || error || ''),
          });
        });
      }
      if (viewId === 'home') {
        hydrateHomeView();
      }
      if (viewId === 'chat') {
        const catchup = fwd.flushPendingStreamCommitsForSession(state.currentSessionId);
        fwd.renderMessages({ reason: catchup?.catchupRequired ? 'view_catchup' : 'view_activation' });
        fwd.renderComposerState();
        fwd.renderSessions();
        requestAnimationFrame(() => {
          chatInput.focus();
          fwd.updateComposerSafeOffset({
            force: true,
            syncViewport: true,
          });
          fwd.updateAssistantSpritePosition();

          if (state.ui.morphStartRect) {
            const startRect = state.ui.morphStartRect;
            delete state.ui.morphStartRect;

            /* Reduced motion: skip the morph flight — zeroed transitions never
               fire transitionend, stranding the sprite until MORPH_SAFETY_MS. */
            const motionPreferenceUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMotionPreferenceUtils) || null;
            const skipMorphFlight = Boolean(motionPreferenceUtils && motionPreferenceUtils.prefersReducedMotion());
            if (!skipMorphFlight) requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const chatSprite = document.getElementById('chatAssistantSprite');
                if (chatSprite) {
                  const endRect = chatSprite.getBoundingClientRect();
                  if (endRect.width > 0 && endRect.height > 0) {
                    const overlay = document.createElement('div');
                    overlay.className = 'presence-morph-overlay';
                    overlay.style.top = `${startRect.top}px`;
                    overlay.style.left = `${startRect.left}px`;
                    overlay.style.width = `${startRect.width}px`;
                    overlay.style.height = `${startRect.height}px`;
                    document.body.appendChild(overlay);

                    const originalOpacity = chatSprite.style.opacity;
                    chatSprite.style.opacity = '0';

                    overlay.offsetHeight; // trigger reflow

                    overlay.classList.add('morphing');
                    overlay.style.top = `${endRect.top}px`;
                    overlay.style.left = `${endRect.left}px`;
                    overlay.style.width = `${endRect.width}px`;
                    overlay.style.height = `${endRect.height}px`;

                    setTimeout(() => {
                      overlay.style.opacity = '0';
                    }, 260);

                    /* Safety: if transitionend never fires (animation
                       interruption, visibility change, reduced-motion
                       toggle), clean up after a generous deadline so the
                       overlay doesn't leak and the sprite stays visible. */
                    const MORPH_SAFETY_MS = 800;
                    const safetyTimer = setTimeout(() => {
                      chatSprite.style.opacity = originalOpacity;
                      if (overlay.parentNode) overlay.remove();
                    }, MORPH_SAFETY_MS);

                    overlay.addEventListener('transitionend', () => {
                      clearTimeout(safetyTimer);
                      chatSprite.style.opacity = originalOpacity;
                      overlay.remove();
                    }, { once: true });
                  }
                }
              });
            });
          }
        });
      } else {
        fwd.hideAssistantSprite();
      }
      fwd.applySurfaceEffect();
      appendClientLog('INFO', 'ui.view_changed', { viewId });
    }

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
    const {
      adjustChatZoomPercent,
      applyAppearancePreferences,
      applyChatZoomPercent,
      buildSelectOptionMarkup,
      isDefaultAppearancePreferences,
      resetChatZoomPercent,
      saveAppearancePreferences,
    } = appearanceController;

    function syncComposerPopoverFallback() {
      if (!composerSettingsPopover || !composerSettingsButton) {
        return;
      }
      const open = Boolean(state.ui.composerPopoverOpen);
      composerSettingsPopover.classList.toggle('hidden', !open);
      composerSettingsButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open || typeof composerSettingsButton.getBoundingClientRect !== 'function') {
        return;
      }
      const buttonRect = composerSettingsButton.getBoundingClientRect();
      const popoverRect = composerSettingsPopover.getBoundingClientRect();
      const viewportWidth = Math.max(Number(globalThis?.innerWidth || 0), 0);
      const top = Math.max(buttonRect.top - popoverRect.height - 10, 16);
      const left = Math.min(
        Math.max(buttonRect.right - popoverRect.width, 16),
        Math.max(viewportWidth - popoverRect.width - 16, 16)
      );
      composerSettingsPopover.style.top = `${top}px`;
      composerSettingsPopover.style.left = `${left}px`;
    }

    function closeComposerPopover({ restoreFocus = false } = {}) {
      state.ui.composerPopoverOpen = false;
      fwd.renderComposerPopover();
      syncComposerPopoverFallback();
      if (restoreFocus) composerSettingsButton.focus();
    }

    function focusPopover(popover) {
      if (!popover || typeof popover.querySelector !== 'function') return;
      const target = popover.querySelector(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (target && typeof target.focus === 'function') {
        target.focus();
        return;
      }
      popover.setAttribute?.('tabindex', '-1');
      popover.focus?.();
    }

    function openComposerPopover() {
      if (state.ui.commandPopoverOpen) closeCommandPopover();
      state.ui.composerPopoverOpen = true;
      fwd.renderComposerPopover();
      syncComposerPopoverFallback();
      focusPopover(composerSettingsPopover);
    }

    function closeCommandPopover({ restoreFocus = false } = {}) {
      state.ui.commandPopoverOpen = false;
      fwd.renderCommandPopover();
      if (restoreFocus) composerTerminalShortcut.focus();
    }

    function openCommandPopover() {
      if (state.ui.composerPopoverOpen) closeComposerPopover();
      state.ui.commandPopoverOpen = true;
      fwd.renderCommandPopover();
      focusPopover(composerCommandPopover);
    }

    const sessionCacheController = sessionCacheUtils.createSessionCacheController?.({
      state,
      getMultiStreamController,
      jennyShell: window.jennyShell || {},
      callbacks: {
        invalidateSessionArtifacts: (...a) => call.invalidateSessionArtifacts?.(...a),
        clearDismissedMemorySession: (...a) => call.clearDismissedMemorySession?.(...a),
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
        resetMemorySuggestionState: (...a) => call.resetMemorySuggestionState?.(...a),
        getActiveSession,
        clearDismissedMemorySession: (...a) => call.clearDismissedMemorySession?.(...a),
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
            window.rendererSettingsEditorSection?.invalidateInlineModelCatalog?.();
          },
          render: () => {
            fwd.renderHeader();
            fwd.renderSessions();
            fwd.renderComposerState();
            if (state.ui.activeView === 'settings') fwd.renderSettings();
          },
        })
      : { refreshSnapshots: async () => {} };
    const refreshSnapshots = (options = {}) => snapshotRefresh.refreshSnapshots(options);

    async function refreshSuggestions() {
      if (state.backend.phase !== 'ready') return;
      state.suggestions.requestId = (state.suggestions.requestId || 0) + 1;
      var myRequestId = state.suggestions.requestId;
      state.suggestions.status = 'loading';
      fwd.renderPrompts();
      try {
        var result = await window.jennyShell.suggestions.generate();
        if (state.suggestions.requestId !== myRequestId) return;
        var items = Array.isArray(result?.suggestions) ? result.suggestions : [];
        if (items.length > 0) {
          state.suggestions.status = 'ready';
          state.suggestions.items = items;
        } else {
          state.suggestions.status = 'error';
        }
      } catch (error) {
        if (state.suggestions.requestId !== myRequestId) return;
        state.suggestions.status = 'error';
        appendClientLog('WARN', 'suggestions.refresh_failed', { message: error?.message || String(error) });
      }
      fwd.renderPrompts();
    }

    async function bootstrap({ signalRendererReadyOnce = () => {} } = {}) {
      attachGlobalErrorBoundary();
      // The startup-audit probe buffers marks until this async config enables it.
      void enableStartupAuditIfNeeded();
      markStartupAudit('renderer-bootstrap-started', {
        readyState: typeof document !== 'undefined' ? document.readyState : '',
      });
      appendClientLog('INFO', 'renderer.bootstrap_started', {
        elapsedMs: getRendererElapsedMs(),
      });
      // Restore the last-active top-level view across launches. The render
      // pipeline (renderViewChrome) branches on state.ui.activeView for every
      // view, so seeding it before renderAll lands the user where they left off
      // without forcing a setActiveView() (which would fire premature backend
      // refreshes at cold boot). Fresh profiles read nothing here and keep the
      // 'chat' default until first-run setup completion persists 'home'.
      const restoredActiveView = readPersistedActiveView();
      if (restoredActiveView) {
        state.ui.activeView = restoredActiveView;
      }
      if (typeof document !== 'undefined' && document.documentElement?.dataset) {
        document.documentElement.dataset.activeView = String(state.ui?.activeView || '').trim() || 'chat';
      }
      fwd.renderPrompts();
      fwd.renderAll();
      noteFirstRenderComplete();
      markStartupAudit('first-render');
      // The painted startup curtain still hides and gates the workspace until
      // backend-ready plus boot-view-ready, so revealing the OS window is safe:
      // notifyBootViewReady() (the boot-view-ready half) no longer fires from
      // this function for chat/logs/settings -- bootstrapAppShell calls it
      // once hydration has actually landed. See F1 in the startup-reveal review.
      signalRendererReadyOnce();
      scheduleDeferredVisualStartup();

      try {
        const [backendStatus, authState, systemStats] = await Promise.all([
          window.jennyShell.backend.getStatus(),
          window.jennyShell.auth.getState(),
          window.jennyShell.system.getStats(),
        ]);
        const currentBackendPhase = String(state.backend?.phase || '').trim().toLowerCase();
        const nextBackendPhase = String(backendStatus?.phase || '').trim().toLowerCase();
        const currentBackendSettled = currentBackendPhase === 'ready' || currentBackendPhase === 'failed';
        const nextBackendTransient = !nextBackendPhase
          || nextBackendPhase === 'starting'
          || nextBackendPhase === 'retrying';
        if (!(currentBackendSettled && nextBackendTransient)) {
          state.backend = backendStatus;
        }
        state.auth = authState;
        state.systemStats = systemStats;
        if (backendStatus && backendStatus.phase === 'ready') {
          appendClientLog('INFO', 'renderer.backend_ready', {
            elapsedMs: getRendererElapsedMs(),
            startupStage: backendStatus.startupStage || '',
            startupMs: Number(backendStatus.startupMs || 0),
          });
        }
      } catch (error) {
        appendClientLog('ERROR', 'bootstrap.failed', { message: error.message || String(error) });
      }

      fwd.renderAll();
      fwd.syncStartupBackendStatus?.(state.backend);
      if (state.ui.activeView === 'logs') {
        // Fine: the refresher reports diagnostics.refresh_failed itself before rethrowing (mirrors :392).
        refreshDiagnosticsWorkspace().catch(() => {});
      }
      if (state.ui.activeView !== 'home') {
        Promise.resolve().then(() => fwd.refreshOfflineState()).catch((error) => {
          appendClientLog('WARN', 'offline.bootstrap_failed', {
            message: error?.message || String(error),
          });
          /* EH-W10: error-center-only intake route (no toast for pollers). */
          fwd.reportError({ message: 'Offline readiness could not be refreshed.', dedupeKey: 'offline-refresh:offline' }, { origin: 'offline-refresh' });
        });
      }

      // model_unavailable keeps the chat surface usable (send retries the
      // model load), so a reload in that state must still hydrate sessions.
      if ((state.backend.phase === 'ready' || state.backend.phase === 'model_unavailable') && state.auth.authenticated) {
        const results = await Promise.allSettled([loadSessions(), refreshSnapshots()]);
        ['sessions', 'snapshots'].forEach((operation, index) => {
          if (results[index].status !== 'rejected') { return; }
          appendClientLog('WARN', 'renderer.bootstrap_session_hydration_failed', {
            operation,
            message: String(results[index].reason?.message || results[index].reason || '').slice(0, 500),
          });
        });
      }

      // Restoring the boot view above set state.ui.activeView directly (skipping
      // setActiveView's refreshes), so Home never ran its activation hydration and
      // would stay stuck on its loading skeleton — the reported "infinite loading".
      // Backend is settled now, so back-fill Home, including its own offline pull.
      if (state.ui.activeView === 'home') {
        hydrateHomeView({ refreshOffline: true });
      } else if (state.ui.activeView === 'ide') {
        // Same latent bug as Home above: the boot path seeds state.ui.activeView
        // directly, so renderAll() only calls renderIde() (chrome paint) and the
        // IDE's one-time activation hydration — re-opening the persisted tabs and
        // ide.activeTabPath — never fires. Without this the restored workspace
        // shows no open files until the user navigates away and back. (Editor
        // *settings* are separately re-applied by the Settings "Editor" section,
        // so the open files are the piece this back-fill restores.) activateIde()
        // is idempotent (guarded by the controller's activated/hydrated flags), so
        // a later manual navigation won't re-hydrate.
        try {
          await Promise.resolve(fwd.activateIde?.());
        } catch (_error) {
          appendClientLog('WARN', 'ide.boot_activation_failed', { reason: 'persisted_tab_activation_failed' });
        } finally {
          fwd.notifyBootViewReady?.();
        }
      }

      appendClientLog('INFO', 'renderer.bootstrap_complete', {
        elapsedMs: getRendererElapsedMs(),
        backendPhase: state.backend.phase,
        authenticated: Boolean(state.auth && state.auth.authenticated),
      });
      markStartupAudit('renderer-bootstrap-complete', {
        backendPhase: state.backend.phase,
        authenticated: Boolean(state.auth && state.auth.authenticated),
      });
    }

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

    function handleJumpToLastPrompt() {
      const latestUserMessageId = fwd.getLatestUserMessageId(fwd.getCurrentVisibleMessages());
      if (!latestUserMessageId) {
        return;
      }
      const didScroll = fwd.scrollMessageIntoView(latestUserMessageId, {
        block: 'end',
        followLatest: false,
      });
      if (didScroll) {
        thinkingController.handleScroll(fwd.getScrollMetrics());
      }
    }

    async function handleCreateSession(options = {}) {
      const sessionType = options.sessionType === 'plugin' ? 'plugin' : 'chat';
      const previousCurrentSessionId = String(state.currentSessionId || '').trim();
      const knownSessionIds = new Set(
        Array.isArray(state.sessions)
          ? state.sessions.map((session) => String(session?.id || '').trim()).filter(Boolean)
          : []
      );
      fwd.clearComposerStatusNotice();
      if (fwd.isAnySendBusy() && sessionType === 'chat' && typeof options.initialPrompt !== 'string') {
        const runtimePreferences = mergeRequestedRuntimePreferences(getCurrentRuntimePreferences(), options.preferences, normalizeReasoningEffort);
        const sessionId = createLocalDraftSessionId();
        const timestamp = new Date().toISOString();
        fwd.upsertSessionSummary({
          id: sessionId, title: 'New Chat', session_type: 'chat',
          created_at: timestamp, updated_at: timestamp, message_count: 0,
          last_message_preview: '', last_model_used: '',
          preferred_model: runtimePreferences.preferredModel,
          reasoning_effort: runtimePreferences.reasoningEffort,
          conversation_mode: 'chat',
          pending_question_batch: null, interactive_sequence_state: INTERACTIVE_SEQUENCE_IDLE,
          interactive_round_count: 0, plan_mode: runtimePreferences.planMode === true,
          run_mode: runtimePreferences.runMode, pre_plan_run_mode: runtimePreferences.prePlanRunMode,
          context_preferences: {
            history_scope: runtimePreferences.contextPreferences.historyScope,
            include_personality: runtimePreferences.contextPreferences.includePersonality !== false,
            include_memory: runtimePreferences.contextPreferences.includeMemory !== false,
          },
          optimistic_local: true,
          local_draft: true,
        }, { prepend: true });
        fwd.setSessionMessages(sessionId, [], `session_${sessionId}`);
        state.currentSessionId = sessionId;
        state.runtimeDraft = {
          preferredModel: runtimePreferences.preferredModel,
          reasoningEffort: runtimePreferences.reasoningEffort,
          runMode: runtimePreferences.runMode,
          prePlanRunMode: runtimePreferences.prePlanRunMode,
          planMode: runtimePreferences.planMode,
          contextPreferences: runtimePreferences.contextPreferences,
        };
        fwd.renderAll();
        chatInput.focus();
        appendClientLog('INFO', 'sessions.created_local_draft', { sessionId });
        return sessionId;
      }
      const runtimePreferences = mergeRequestedRuntimePreferences(getCurrentRuntimePreferences(), options.preferences, normalizeReasoningEffort);
      const payload = await window.jennyShell.sessions.create({
        title: String(options.title || (sessionType === 'plugin' ? 'New Plugin Session' : 'New Chat')).trim(),
        ...(typeof options.initialPrompt === 'string' ? { initialPrompt: options.initialPrompt } : {}), ...(typeof options.linkedTaskId === 'string' && options.linkedTaskId ? { linkedTaskId: options.linkedTaskId } : {}),
        ...(sessionType === 'plugin' ? {
          sessionType: 'plugin', providerAuthority: options.providerAuthority,
        } : {}),
        preferences: {
          preferred_model: runtimePreferences.preferredModel,
          reasoning_effort: runtimePreferences.reasoningEffort,
          context_preferences: {
            history_scope: runtimePreferences.contextPreferences.historyScope,
            include_personality: runtimePreferences.contextPreferences.includePersonality,
            include_memory: runtimePreferences.contextPreferences.includeMemory,
          },
        },
      });
      const createdSessionId = String(payload?.data?.id || '').trim();
      composerSessionStateController?.captureActive(previousCurrentSessionId, 'session_create');
      state.currentSessionId = createdSessionId;
      thinkingController.resumeAutoScroll();
      fwd.setFollowLatest(true);
      fwd.setSessionMessages(createdSessionId, [], `session_${createdSessionId}`);
      await loadSessions(createdSessionId, { skipOpenCurrent: true });
      if (state.currentSessionId === createdSessionId) { // navigation during the await: never restore over another session's composer
        composerSessionStateController?.restoreForSession(createdSessionId);
        if (createdSessionId && typeof options.initialPrompt === 'string') setActiveView('chat');
        fwd.renderAll(); chatInput.focus();
      }
      appendClientLog('INFO', 'sessions.created', { sessionId: createdSessionId });
      refreshSuggestions().catch((err) => { appendClientLog('WARN', 'sessions.refresh_suggestions_failed', { message: String(err?.message || err || '') }); });
      return createdSessionId
        && createdSessionId !== previousCurrentSessionId
        && !knownSessionIds.has(createdSessionId)
        ? createdSessionId
        : '';
    }
    const taskSessionActions = { start: handleCreateSession }; window.rendererTaskSessionActions = taskSessionActions;

    async function handleRenameSession(sessionId, nextTitleInput) {
      const session = state.sessions.find((item) => item.id === sessionId);
      const currentTitle = session && session.title ? session.title : 'New Chat';
      const nextTitle = String(nextTitleInput == null ? '' : nextTitleInput).trim();
      if (!nextTitle || nextTitle === currentTitle.trim()) {
        return;
      }
      await window.jennyShell.sessions.rename(sessionId, nextTitle);
      await loadSessions(sessionId, { skipOpenCurrent: true });
      fwd.renderSessions();
      fwd.renderHeader();
      appendClientLog('INFO', 'sessions.renamed', { sessionId });
    }

    async function handleDeleteSession(sessionId) {
      // Confirmation moved to the undo window: renderer-session-actions defers
      // this hard delete behind an Undo toast; callers reach it via that path.
      // Session deletion must not outrun a supervised plugin host. The backend
      // independently enforces the same invariant for non-renderer callers.
      const pluginSessions = globalThis.rendererPluginSessions?.instance || null;
      if (pluginSessions && !(await pluginSessions.guardLeaveSession(sessionId, 'session_delete'))) {
        return;
      }
      const sessionSummary = state.sessions.find((session) => session.id === sessionId) || null;
      const isOptimisticLocal = sessionSummary?.optimistic_local === true;
      const normalizedSessionId = String(sessionId || '').trim();
      const controllerPreflight = getMultiStreamController()?.getPreflight?.(normalizedSessionId) || null;
      if (controllerPreflight) controllerPreflight.discarded = true;
      if (state.sendPreflight && (
        String(state.sendPreflight.sessionId || '').trim() === normalizedSessionId
        || String(state.sendPreflight.optimisticSessionId || '').trim() === normalizedSessionId
      )) {
        state.sendPreflight.discarded = true;
      }
      await clearSessionStreamState(sessionId, { cancelActive: true });
      if (!isOptimisticLocal) {
        const deleteResult = await window.jennyShell.sessions.delete(sessionId);
        if (
          deleteResult
          && typeof deleteResult === 'object'
          && Object.prototype.hasOwnProperty.call(deleteResult, 'deleted')
          && deleteResult.deleted !== true
        ) {
          throw new Error('Session could not be deleted because the session store refused the delete request.');
        }
      }
      // tombstone: the backend delete above succeeded (or the session was
      // optimistic-local and never reached the backend), so a stale list
      // snapshot must not resurrect the id (Audit A2).
      fwd.removeSessionState(normalizedSessionId, { tombstone: true });
      if (typeof call.invalidateSessionArtifacts === 'function') {
        call.invalidateSessionArtifacts(sessionId);
      }
      call.clearDismissedMemorySession?.(sessionId);
      await loadSessions();
      fwd.renderAll();
      appendClientLog('INFO', 'sessions.deleted', { sessionId });
    }

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

    return { escapeHtml, getSessionMonogram, normalizeModelToken, normalizeContextPreferences, getActiveSession, getRuntimePreferencesFromSession, getCurrentRuntimePreferences, patchSessionSummary, syncRuntimeDraftFromActiveSession, buildModelOptionMarkup, loadAppearancePreferences, loadChatUiState, appendClientLog, getRendererElapsedMs, noteFirstRenderComplete, runDeferredVisualStartup, scheduleDeferredVisualStartup, disposeLifecycleController, pushIncomingLog, resetLogsViewState, setActiveView, refreshDiagnosticsWorkspace, setDiagnosticsObservabilityRefresh: (refresh) => { call.refreshObservability = typeof refresh === 'function' ? refresh : undefined; }, saveAppearancePreferences, applyAppearancePreferences, applyChatZoomPercent, adjustChatZoomPercent, resetChatZoomPercent, isDefaultAppearancePreferences, isDefaultChatZoomPercent, buildSelectOptionMarkup, closeComposerPopover, openComposerPopover, closeCommandPopover, openCommandPopover, resetAttachmentQueue, removeQueuedAttachment, mergePreparedAttachments, beginAttachmentToken, cancelAttachmentToken, handleAttachmentPicker, prepareDroppedAttachments, queueInlineImageAttachment, setDropActive, suppressFileDropNavigation, getDroppedFilePaths, loadSessions, openSession, refreshSessionSummaries, refreshSnapshots, bootstrap, handleJumpToTop, handleJumpToBottom, handleJumpToLastPrompt, handleCreateSession, handleRenameSession, handleDeleteSession, refreshSuggestions, attachGlobalErrorBoundary, detachGlobalErrorBoundary };
  }

  return { createLifecycleController };
});
