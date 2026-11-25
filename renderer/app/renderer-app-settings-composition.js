/* renderer/app/renderer-app-settings-composition.js -- the Settings shell controller and its callbacks */
/**
 * Extracted from renderer-app-controller-composition.js. It builds
 * the Settings shell controller (renderer/shell/renderer-settings-shell-controller.js) with
 * its appearance, personality, runtime, skills, offline, memory and diagnostics callbacks and
 * returns it; the root assigns it, plucks the composer renderers it owns and binds the
 * Settings page groups once the page is ready.
 *
 * The root passes `{ __proto__: ctx, ...its locals }`: shorthand values for root
 * locals already initialized, accessors for the ones bound later (so a call
 * before they exist throws exactly as the inline code did).
 */
(function (root) {
  function createSettingsShellController(ctx) {
  return (ctx.window.rendererSettingsShellControllerUtils || {}).createSettingsShellController?.({
    state: ctx.state,
    composerLayoutRuntime: ctx.composerLayoutRuntime,
    reducedMotionQuery: ctx.reducedMotionQuery,
    dom: ctx.surfaceDom.settings,
    chatInput: ctx.chatInput,
    constants: { ACTIVITY_SCOPE: ctx.ACTIVITY_SCOPE, TOAST_SOURCE: ctx.TOAST_SOURCE },
    callbacks: {
      setActiveView: (...a) => ctx.setActiveView(...a),
      renderAll: (...a) => ctx.renderAll(...a),
      renderSessions: (...a) => ctx.renderSessions(...a),
        applyAppearancePreferences: (...a) => ctx.applyAppearancePreferences(...a),
        applyChatZoomPercent: (...a) => ctx.applyChatZoomPercent(...a),
        appearanceUtils: ctx.appearanceUtils,
        getDefaultAppearancePreferences: ctx.getDefaultAppearancePreferences,
        getDefaultChatZoomPercent: () => ctx.DEFAULT_CHAT_ZOOM_PERCENT,
        getChatZoomOptions: ctx.getChatZoomOptions,
        isDefaultChatZoomPercent: ctx.isDefaultChatZoomPercent,
        normalizeChatZoomPercent: ctx.normalizeChatZoomPercent,
        applySurfaceEffect: (...a) => ctx.applySurfaceEffect(...a),
        activateSurfaceEffect: (...a) => ctx.activateSurfaceEffect(...a),
      handlePersonalityTabChange: (...a) => ctx.handlePersonalityTabChangeSafe(...a),
      getPersonalityActiveFile: (...a) => ctx.getPersonalityActiveFileSafe(...a),
      setPersonalityDraft: (...a) => ctx.setPersonalityDraftSafe(...a),
      renderPersonalityEditor: (...a) => ctx.renderPersonalityEditorSafe(...a),
      handlePersonalitySave: (...a) => ctx.handlePersonalitySaveSafe(...a),
      handlePersonalityReset: (...a) => ctx.handlePersonalityResetSafe(...a),
      handlePersonalityOpenFolder: (...a) => ctx.handlePersonalityOpenFolderSafe(...a),
      hasPersonalityUnsavedChanges: (...a) => ctx.hasPersonalityUnsavedChangesSafe(...a),
      showToastMessage: ctx.showToastMessage,
      showShellErrorToast: ctx.showShellErrorToast,
      toErrorMessage: ctx.toErrorMessage,
      appendClientLog: (...a) => ctx.appendClientLog(...a),
      showSessionActionError: ctx.showSessionActionError,
      getCurrentRuntimePreferences: ctx.getCurrentRuntimePreferences, getRuntimePreferencesFromSession: ctx.getRuntimePreferencesFromSession,
      getRuntimePreferenceSnapshot: (...a) => ctx.getRuntimePreferenceSnapshot(...a),
      runRuntimePreferenceActivity: (...a) => ctx.runRuntimePreferenceActivity(...a),
      handleWorkspaceRootChoose: (...a) => ctx.handleWorkspaceRootChoose(...a),
      clearWorkspaceRoot: (...a) => ctx.clearWorkspaceRoot(...a), getProjectSwitcher: (...a) => ctx.getProjectSwitcher?.(...a),
      handleRunSetupAgain: (...a) => ctx.handleRunSetupAgain(...a),
      showSetupHelp: (...a) => ctx.showSetupHelpSafe(...a),
      showFactoryReset: (...a) => ctx.showFactoryResetSafe(...a),
      refreshProactiveState: (...a) => ctx.refreshProactiveStateSafe(...a),
      refreshSkillsState: (...a) => ctx.refreshSkillsStateSafe(...a),
      bindSkillsShellEvents: (...a) => ctx.bindSkillsShellEventsSafe(...a),
      updateSkillsSettings: (...a) => ctx.updateSkillsSettingsSafe(...a),
      openSkillsScopeFolder: (...a) => ctx.openSkillsScopeFolderSafe(...a),
      refreshOfflineState: (...a) => ctx.refreshOfflineStateSafe(...a),
      bindOfflineShellEvents: (...a) => ctx.bindOfflineShellEventsSafe(...a),
      handleOfflineModeChange: (...a) => ctx.handleOfflineModeChangeSafe(...a),
      refreshFeatureState: (...a) => ctx.refreshFeatureState(...a),
      refreshPhasePercentiles: (...a) => ctx.refreshPhasePercentiles(...a),
      resetPhasePercentiles: (...a) => ctx.resetPhasePercentiles(...a),
      renderLogs: (...a) => ctx.renderLogs(...a),
      getCurrentSessionId: () => ctx.state.currentSessionId, openSession: (...a) => ctx.openSession?.(...a),
      navigateToDiagnosticsTrace: (...a) => ctx.navigateToDiagnosticsTrace(...a),
      refreshApprovedMemories: (...a) => ctx.refreshApprovedMemoriesSafe(...a),
      refreshPendingMemories: (...a) => ctx.refreshPendingMemoriesSafe(...a),
      refreshMemoryStatus: (...a) => ctx.refreshMemoryStatusSafe(...a),
      refreshPersonalityWorkspace: (...a) => ctx.refreshPersonalityWorkspaceSafe(...a),
      normalizeAppearancePreferences: ctx.normalizeAppearancePreferences,
      getPalettePresets: ctx.getPalettePresets,
      getTypographyPresets: ctx.getTypographyPresets,
      getSurfaceEffectPresets: ctx.getSurfaceEffectPresets,
      getThemeBundles: typeof ctx.appearanceUtils?.getThemeBundles === 'function'
        ? ctx.appearanceUtils.getThemeBundles.bind(ctx.appearanceUtils)
        : ctx.noopArr,
      getComposerHoloOptions: typeof ctx.appearanceUtils?.getComposerHoloOptions === 'function'
        ? ctx.appearanceUtils.getComposerHoloOptions.bind(ctx.appearanceUtils)
        : ctx.noopArr,
      getFontScalePresets: ctx.getFontScalePresets,
      getChatWidthPresets: typeof ctx.appearanceUtils?.getChatWidthPresets === 'function'
        ? ctx.appearanceUtils.getChatWidthPresets.bind(ctx.appearanceUtils)
        : ctx.noopArr,
      detectActiveThemeBundle: typeof ctx.appearanceUtils?.detectActiveThemeBundle === 'function'
        ? ctx.appearanceUtils.detectActiveThemeBundle.bind(ctx.appearanceUtils)
        : ctx.noopNull,
      getActivitySnapshot: ctx.getActivitySnapshot,
      getMostRecentActivity: ctx.getMostRecentActivity,
      isActivityBusy: ctx.isActivityBusy,
      applyActivityAttributes: ctx.applyActivityAttributes,
      getActiveSession: ctx.getActiveSession,
      buildModelOptionMarkup: ctx.buildModelOptionMarkup,
      buildSelectOptionMarkup: ctx.buildSelectOptionMarkup,
      isDefaultAppearancePreferences: ctx.isDefaultAppearancePreferences,
      resolveComposerModelSelectWidth: ctx.resolveComposerModelSelectWidth,
      updateComposerSafeOffset: (...a) => ctx.updateComposerSafeOffset(...a),
      renderSkillsManager: (...a) => ctx.renderSkillsManagerSafe(...a),
      renderOfflineManager: (...a) => ctx.renderOfflineManagerSafe(...a),
      escapeHtml: ctx.escapeHtml,
    },
    factories: {
      settingsRendererUtils: ctx.settingsRendererUtils,
      settingsEventUtils: ctx.window.rendererSettingsEventUtils || {},
      settingsNavUtils: ctx.window.rendererSettingsNavUtils || {},
    },
  }) || null;
  }

  root.rendererAppSettingsComposition = {
    createSettingsShellController,
  };
})(window);
