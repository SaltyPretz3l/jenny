/* renderer/shell/renderer-shell-status-controller.js - Internal shell-level status composition. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererShellStatusControllerUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function createShellStatusController(deps) {
    const { state } = deps;
    const { ACTIVITY_SCOPE } = deps.constants;
    const {
      composerStatusNotice,
      startupOverlay,
      startupOverlaySublabel,
      startupOverlaySecondary,
      turnStatusPill,
      titlebarStatus,
      metricList,
    } = deps.dom;
    const callbacks = deps.callbacks || {};

    const activityPrefsUtils = globalThis.rendererActivityPrefsUtils || {};
    const lifecycleProgressUtils = globalThis.lifecycleProgressUtils || {};
    const turnStatusPillUtils = globalThis.rendererTurnStatusPill || {};

    const {
      getCurrentRuntimePreferences,
      getActiveSession,
      patchSessionSummary,
      setSessionPreferences,
      syncRuntimeDraftFromActiveSession,
      beginActivity,
      resolveActivity,
      failActivity,
      getActivitySnapshot,
      getMostRecentActivity,
      applyActivityAttributes,
      setComposerStatusNotice,
      clearComposerStatusNotice,
      renderComposerState = function noop() {},
      renderSettings = function noop() {},
      renderPersonalityEditor = function noop() {},
      renderSessions = function noop() {},
      getRendererElapsedMs = function noopElapsedMs() { return 0; },
      appendClientLog = function noopLog() {},
      onStartupReady = function noopStartupReady() {},
      onStartupRemoved = function noopStartupRemoved() {},
      openLogs = function noopOpenLogs() {},
      showToastMessage = function noopShowToast() { return ''; },
      dismissToastsBySource = function noopDismissToasts() {},
      openSettingsSection = function noopOpenSettingsSection() {},
      toastSource = 'shell.backend',
    } = callbacks;

    let backendRetryInFlight = null;
    let statusControllerDisposed = false;

    /* The single retry latch for the whole renderer. The startup curtain, the
     * backend failure toast, and the workbench health pill's popover all route
     * here, so two of them firing at once still produces one retryStart(). */
    function retryBackendStart() {
      if (statusControllerDisposed) { return Promise.resolve(false); }
      if (backendRetryInFlight) { return backendRetryInFlight; }
      const shell = globalThis.jennyShell || (globalThis.window && globalThis.window.jennyShell);
      const backend = shell && shell.backend;
      if (!backend || typeof backend.retryStart !== 'function') {
        appendClientLog('WARN', 'startup.backend_retry_rejected', { reason: 'retry_unavailable' });
        return Promise.resolve(false);
      }
      backendRetryInFlight = Promise.resolve()
        .then(() => backend.retryStart())
        .then(() => true)
        .catch(() => {
          if (!statusControllerDisposed) {
            appendClientLog('WARN', 'startup.backend_retry_rejected', { reason: 'retry_start_rejected' });
          }
          return false;
        })
        .finally(() => {
          backendRetryInFlight = null;
        });
      return backendRetryInFlight;
    }

    /* These phases are fully narrated by the workbench health pill and must
     * not be duplicated on another surface. */
    const PILL_OWNED_PHASES = new Set([
      'ready',
      'starting',
      'sidecar_spawned',
      'model_acquiring',
      'model_loading',
    ]);

    /* Phases that genuinely need the user. Danger tones are sticky by default
     * in the toast store, so `sticky` is deliberately NOT forwarded here:
     * passing it defeats the store's hasOwnProperty check and overrides every
     * per-tone default. */
    const BACKEND_NOTICES = {
      retrying: {
        tone: 'warning',
        title: 'Reconnecting',
        message: 'Having trouble connecting to the backend. Retrying automatically.',
        actions: [],
      },
      model_unavailable: {
        tone: 'danger',
        title: 'Model failed to load',
        message: 'Send a message to retry, or pick another model in Settings.',
        actions: ['retry', 'models'],
      },
      failed: {
        tone: 'danger',
        title: 'Backend connection failed',
        message: 'Jenny could not reach its runtime. Check the logs for details.',
        actions: ['retry', 'logs'],
      },
      stopped: {
        tone: 'warning',
        title: 'Backend stopped',
        message: 'The backend has stopped. Retry to bring it back.',
        actions: ['retry'],
      },
    };

    function buildNoticeActions(keys) {
      const actions = [];
      for (const key of keys) {
        if (key === 'retry') {
          actions.push({ id: 'backend-retry', label: 'Retry', kind: 'primary', onClick: () => { retryBackendStart(); } });
        } else if (key === 'models') {
          actions.push({ id: 'backend-open-models', label: 'Open Models', kind: 'secondary', onClick: () => { openSettingsSection('models'); } });
        } else if (key === 'logs') {
          actions.push({ id: 'backend-open-logs', label: 'Open Diagnostics', kind: 'secondary', onClick: () => { openLogs(); } });
        }
      }
      return actions;
    }

    let lastNoticeSignature = '';

    function syncBackendNotice() {
      if (statusControllerDisposed) { return; }
      /* The mounted startup overlay owns the fatal alert, so suppress the toast
       * to avoid duplicate failure surfaces. */
      if (startupOverlay && startupOverlay.parentNode) { return; }

      const phase = state.backend.phase || 'starting';
      const notice = PILL_OWNED_PHASES.has(phase) ? null : BACKEND_NOTICES[phase];
      if (!notice) {
        if (lastNoticeSignature) { lastNoticeSignature = ''; }
        dismissToastsBySource(toastSource);
        return;
      }

      const message = String(state.backend.detail || '').trim() || notice.message;
      /* This runs on every render pass, and re-enqueuing an identical toast
       * bumps the store's repeat counter and re-emits to the viewport. Latch on
       * what was actually said so a phase that simply persists stays one
       * toast reading once, not a counter climbing every frame. */
      const signature = `${phase}\u0000${message}`;
      if (signature === lastNoticeSignature) { return; }
      lastNoticeSignature = signature;

      showToastMessage(message, {
        title: notice.title,
        tone: notice.tone,
        source: toastSource,
        dedupeKey: `${toastSource}:${phase}`,
        actions: buildNoticeActions(notice.actions),
      });
    }

    const activityPrefsController = activityPrefsUtils.createActivityPrefsController?.({
      state,
      constants: { ACTIVITY_SCOPE },
      dom: { composerStatusNotice },
      callbacks: {
        getCurrentRuntimePreferences,
        getActiveSession,
        patchSessionSummary,
        setSessionPreferences,
        syncRuntimeDraftFromActiveSession,
        beginActivity,
        resolveActivity,
        failActivity,
        getActivitySnapshot,
        getMostRecentActivity,
        applyActivityAttributes,
        setComposerStatusNotice,
        clearComposerStatusNotice,
        renderPersonalityEditor,
        renderComposerState: (...args) => renderComposerState(...args),
        renderSettings: (...args) => renderSettings(...args),
        syncBackendNotice: (...args) => syncBackendNotice(...args),
        renderSessions: (...args) => renderSessions(...args),
      },
    }) || null;

    const turnStatusPillController = turnStatusPillUtils.createTurnStatusPillController?.({
      state,
      dom: {
        turnStatusPill,
        titlebarStatus,
        metricList,
      },
    }) || null;

    function setTurnStatusPill(source, payload) {
      if (turnStatusPillController && typeof turnStatusPillController.set === 'function') {
        turnStatusPillController.set(source, payload);
      }
    }

    function clearTurnStatusPill(source) {
      if (turnStatusPillController && typeof turnStatusPillController.clear === 'function') {
        turnStatusPillController.clear(source);
      }
    }

    function clearTurnStatusPillSources(sources) {
      if (turnStatusPillController && typeof turnStatusPillController.clearSources === 'function') {
        turnStatusPillController.clearSources(sources);
      }
    }

    function renderTurnStatusPill() {
      if (turnStatusPillController && typeof turnStatusPillController.render === 'function') {
        turnStatusPillController.render();
      }
    }

    const lifecycleProgressController = lifecycleProgressUtils.createLifecycleProgressController?.({
      state,
      constants: { ACTIVITY_SCOPE },
      dom: {
        startupOverlay,
        startupOverlaySublabel,
        startupOverlaySecondary,
      },
      callbacks: {
        beginActivity,
        resolveActivity,
        failActivity,
        onStartupReady: (...args) => onStartupReady(...args),
        onStartupRemoved: (...args) => onStartupRemoved(...args),
        retryBackendStart,
        openLogs,
        appendClientLog,
        setTurnStatusPill,
        clearTurnStatusPill,
      },
    }) || null;

    const {
      renderComposerStatusNotice = function noopRenderComposerStatusNotice() {},
      handleActivityChange = function noopHandleActivityChange() {},
      getRuntimePreferenceSnapshot = function noopSnapshot() { return {}; },
      runRuntimePreferenceActivity = async function noopRunRuntimePreferenceActivity() {},
      persistRuntimePreferences = async function noopPersistRuntimePreferences() {},
    } = activityPrefsController || {};
    const {
      handleLifecycleProgress = function noopHandleLifecycleProgress() {},
      handleBackendStatus = function noopHandleBackendStatus() {},
      notifyBootViewReady = function noopNotifyBootViewReady() {},
      beginModelSwitch = function noopBeginModelSwitch() {},
      updateModelSwitch = function noopUpdateModelSwitch() {},
      failModelSwitch = function noopFailModelSwitch() {},
      publishLifecycleStatus = function noopPublishLifecycleStatus() {},
    } = lifecycleProgressController || {};

    function dispose() {
      statusControllerDisposed = true;
      if (lifecycleProgressController && typeof lifecycleProgressController.dispose === 'function') {
        try { lifecycleProgressController.dispose(); } catch (_e) { /* best-effort teardown */ }
      }
      if (turnStatusPillController && typeof turnStatusPillController.dispose === 'function') {
        try { turnStatusPillController.dispose(); } catch (_e) { /* best-effort teardown */ }
      }
    }

    return {
      dispose,
      syncBackendNotice,
      retryBackendStart,
      renderComposerStatusNotice,
      publishLifecycleStatus: publishLifecycleStatus,
      renderTurnStatusPill,
      setTurnStatusPill,
      clearTurnStatusPill,
      clearTurnStatusPillSources,
      handleActivityChange,
      handleLifecycleProgress,
      handleLifecycleBackendStatus: handleBackendStatus,
      notifyBootViewReady,
      beginModelSwitch,
      updateModelSwitch,
      failModelSwitch,
      getRuntimePreferenceSnapshot,
      runRuntimePreferenceActivity,
      persistRuntimePreferences,
      getRendererElapsedMs,
      appendClientLog,
    };
  }

  return {
    createShellStatusController,
  };
});
