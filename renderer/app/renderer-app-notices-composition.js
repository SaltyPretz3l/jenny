/* renderer/app/renderer-app-notices-composition.js -- toasts, the error center and intake, the update dialog and the backend status notice */
/* eslint no-with: "off", no-undef: "off", no-useless-assignment: "off" -- a with(ctx) section: names resolve through the scope the root hands it */
/**
 * Extracted from renderer-app-lifecycle-composition.js (a with(ctx) section), in the order
 * the root built them: the toast controller and its viewport listeners, the EH-W11 error
 * center store and render-time recorder, the EH-W8 error intake (flag-gated error toast
 * wrappers), the update dialog, and the shell (backend / runtime preference) status
 * controller. Returns the names the root and app.js read.
 *
 * The root passes `{ __proto__: ctx, ...its locals }`: shorthand values for root
 * locals already initialized, accessors for the ones bound later (so a call
 * before they exist throws exactly as the inline code did).
 */
(function (root) {
  function createNoticesComposition(ctx) {
    with (ctx) {
  /* toastController */
  const toastController = toastControllerUtils.createToastController?.({
    toastStore, toastActionHandlers,
    constants: { TOAST_SOURCE }, dom: { toastViewport },
  }) || null;
  const {
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
      getCurrentRuntimePreferences, getRuntimePreferencesFromSession,
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
      renderSessions: (...a) => renderSessions(...a), renderSessionComposer: (sessionId) => window.rendererAppPaneComposition?.getPaneComposition?.()?.renderSessionPane?.(sessionId, 'composer'),
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
  } = shellStatusController || {};
  return {
    dismissToast, renderToastViewport, showToastMessage, showShellErrorToast, toErrorMessage, showSessionActionError,
    showComposerActionError, reportError, reportErrorWhenActive, errorCenterStore, shellStatusController,
    getRuntimePreferenceSnapshot, renderComposerStatusNotice, handleActivityChange, runRuntimePreferenceActivity,
    persistRuntimePreferences, syncBackendNotice, retryBackendStart, _handleLifecycleProgress,
    _handleLifecycleBackendStatus, beginModelSwitch, updateModelSwitch, failModelSwitch,
  };
    }
  }

  root.rendererAppNoticesComposition = {
    createNoticesComposition,
  };
})(window);
