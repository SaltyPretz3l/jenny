/* renderer/app/renderer-app-settings-composition.js -- the Settings shell controller and its callbacks */
/* eslint no-with: "off", no-undef: "off", no-useless-assignment: "off" -- a with(ctx) section: names resolve through the scope the root hands it */
/**
 * Extracted from renderer-app-controller-composition.js (a with(ctx) section). It builds
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
    with (ctx) {
  return (window.rendererSettingsShellControllerUtils || {}).createSettingsShellController?.({
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
      showToastMessage,
      showShellErrorToast,
      toErrorMessage,
      appendClientLog: (...a) => appendClientLog(...a),
      showSessionActionError,
      getCurrentRuntimePreferences, getRuntimePreferencesFromSession,
      getRuntimePreferenceSnapshot: (...a) => getRuntimePreferenceSnapshot(...a),
      runRuntimePreferenceActivity: (...a) => runRuntimePreferenceActivity(...a),
      handleWorkspaceRootChoose: (...a) => handleWorkspaceRootChoose(...a),
      clearWorkspaceRoot: (...a) => clearWorkspaceRoot(...a), getProjectSwitcher: (...a) => ctx.getProjectSwitcher?.(...a),
      handleRunSetupAgain: (...a) => handleRunSetupAgain(...a),
      showSetupHelp: (...a) => showSetupHelpSafe(...a),
      showFactoryReset: (...a) => showFactoryResetSafe(...a),
      refreshProactiveState: (...a) => refreshProactiveStateSafe(...a),
      refreshSkillsState: (...a) => refreshSkillsStateSafe(...a),
      bindSkillsShellEvents: (...a) => bindSkillsShellEventsSafe(...a),
      updateSkillsSettings: (...a) => updateSkillsSettingsSafe(...a),
      openSkillsScopeFolder: (...a) => openSkillsScopeFolderSafe(...a),
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
      renderSkillsManager: (...a) => renderSkillsManagerSafe(...a),
      renderOfflineManager: (...a) => renderOfflineManagerSafe(...a),
      escapeHtml,
    },
    factories: {
      settingsRendererUtils,
      settingsEventUtils: window.rendererSettingsEventUtils || {},
      settingsNavUtils: window.rendererSettingsNavUtils || {},
    },
  }) || null;
    }
  }

  root.rendererAppSettingsComposition = {
    createSettingsShellController,
  };
})(window);
