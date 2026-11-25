/* renderer/app/renderer-app-notices-composition.js -- toasts, the error center and intake, the update dialog and the backend status notice */
/**
 * Extracted from renderer-app-lifecycle-composition.js, in the order
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
  /* toastController */
  const toastController = ctx.toastControllerUtils.createToastController?.({
    toastStore: ctx.toastStore, toastActionHandlers: ctx.toastActionHandlers,
    constants: { TOAST_SOURCE: ctx.TOAST_SOURCE }, dom: { toastViewport: ctx.toastViewport },
  }) || null;
  const {
    dismissToast = ctx.noop, renderToastViewport = ctx.noop,
    showToastMessage = ctx.noopStr, showShellErrorToast: rawShowShellErrorToast = ctx.noopStr,
    toErrorMessage = (e, f) => String(e?.message || e || f || ''),
    showSessionActionError: rawShowSessionActionError = ctx.noopStr,
    showComposerActionError: rawShowComposerActionError = ctx.noopStr,
    installToastViewportListeners = null,
  } = toastController || {};
  /* Hover/focus hold the auto-dismiss countdowns, and Escape inside the stack
   * dismisses the focused toast. */
  if (typeof installToastViewportListeners === 'function') {
    /* A failed toast action goes through the error-intake wrapper defined below
     * (read at click time, after it exists). */
    ctx.registerRendererCleanup(installToastViewportListeners({
      reportActionError: (message, options) => showShellErrorToast(message, options),
    }));
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
  const errorCenterStore = (ctx.window.rendererErrorCenterStore || {}).createErrorCenterStore?.() || null;
  const recordRenderedError = (entry) => {
    if (!errorCenterStore || ctx.state.features?.featureFlags?.error_intake_routing !== true) {
      return false;
    }
    return errorCenterStore.record(entry);
  };
  ctx.window.rendererErrorCenterRecord = recordRenderedError;
  ctx.registerRendererCleanup(() => {
    if (ctx.window.rendererErrorCenterRecord === recordRenderedError) {
      ctx.window.rendererErrorCenterRecord = null;
    }
  });
  const errorIntakeController = (ctx.window.rendererErrorIntakeControllerUtils || {}).createErrorIntakeController?.({
    isEnabled: () => ctx.state.features?.featureFlags?.error_intake_routing === true,
    constants: { TOAST_SOURCE: ctx.TOAST_SOURCE },
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
  const updateDialogController = ctx.window.rendererUpdateDialogUtils?.createUpdateDialogController?.({
    windowRef: ctx.window,
    documentRef: ctx.document,
    jennyShell: ctx.window.jennyShell,
    renderMarkdown: ctx.window.markdownUtils?.renderMarkdown,
    showToastMessage,
    /* EH-W9: flag-gated intake route for update-action failures. */
    reportError: (...a) => reportErrorWhenActive(...a),
  }) || null;
  if (updateDialogController) {
    ctx.registerRendererCleanup(updateDialogController.bind());
  }
  /* activityPrefsController */
  const shellStatusController = (ctx.window.rendererShellStatusControllerUtils || {}).createShellStatusController?.({
    state: ctx.state,
    constants: { ACTIVITY_SCOPE: ctx.ACTIVITY_SCOPE },
    dom: ctx.surfaceDom.status,
    callbacks: {
      getCurrentRuntimePreferences: ctx.getCurrentRuntimePreferences, getRuntimePreferencesFromSession: ctx.getRuntimePreferencesFromSession,
      getActiveSession: ctx.getActiveSession,
      patchSessionSummary: ctx.patchSessionSummary,
      setSessionPreferences: (sessionId, preferences) =>
        ctx.window.jennyShell.sessions.setPreferences(sessionId, preferences),
      syncRuntimeDraftFromActiveSession: ctx.syncRuntimeDraftFromActiveSession,
      beginActivity: ctx.beginActivity,
      resolveActivity: ctx.resolveActivity,
      failActivity: ctx.failActivity,
      getActivitySnapshot: ctx.getActivitySnapshot,
      getMostRecentActivity: ctx.getMostRecentActivity,
      applyActivityAttributes: ctx.applyActivityAttributes,
      setComposerStatusNotice: ctx.setComposerStatusNotice,
      clearComposerStatusNotice: ctx.clearComposerStatusNotice,
      renderPersonalityEditor: (...a) => ctx.renderPersonalityEditorSafe(...a),
      renderComposerState: (...a) => ctx.renderComposerState(...a),
      renderSettings: (...a) => ctx.renderSettings(...a),
      renderSessions: (...a) => ctx.renderSessions(...a), renderSessionComposer: (sessionId) => ctx.window.rendererAppPaneComposition?.getPaneComposition?.()?.renderSessionPane?.(sessionId, 'composer'),
      getVisibleSessionMessages: (...a) => ctx.getVisibleSessionMessages(...a),
      getRendererElapsedMs: (...a) => ctx.getRendererElapsedMs(...a),
      appendClientLog: (...a) => ctx.appendClientLog(...a),
      onStartupReady: () => ctx.runDeferredVisualStartup(),
      onStartupRemoved: () => syncBackendNotice(), openLogs: () => ctx.setActiveView('logs'), openSettingsSection: (section) => ctx.openSettingsSection(section),
      showToastMessage: (...a) => showToastMessage(...a), dismissToastsBySource: (source) => ctx.toastStore?.dismissBySource?.(source), toastSource: ctx.TOAST_SOURCE.backend,
    },
  }) || null;
  const {
    getRuntimePreferenceSnapshot = ctx.noopObj,
    renderComposerStatusNotice = ctx.noop,
    handleActivityChange = ctx.noop,
    runRuntimePreferenceActivity = ctx.noopAsync,
    persistRuntimePreferences = ctx.noopAsync,
    syncBackendNotice = ctx.noop, retryBackendStart = ctx.noop,
    handleLifecycleProgress: _handleLifecycleProgress = ctx.noop,
    handleLifecycleBackendStatus: _handleLifecycleBackendStatus = ctx.noop,
    beginModelSwitch = ctx.noop,
    updateModelSwitch = ctx.noop,
    failModelSwitch = ctx.noop,
  } = shellStatusController || {};
  return {
    dismissToast, renderToastViewport, showToastMessage, showShellErrorToast, toErrorMessage, showSessionActionError,
    showComposerActionError, reportError, reportErrorWhenActive, errorCenterStore, shellStatusController,
    getRuntimePreferenceSnapshot, renderComposerStatusNotice, handleActivityChange, runRuntimePreferenceActivity,
    persistRuntimePreferences, syncBackendNotice, retryBackendStart, _handleLifecycleProgress,
    _handleLifecycleBackendStatus, beginModelSwitch, updateModelSwitch, failModelSwitch,
  };
  }

  root.rendererAppNoticesComposition = {
    createNoticesComposition,
  };
})(window);
