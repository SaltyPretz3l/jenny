/* renderer/app/renderer-app-shell-services-composition.js -- the shell service registry (IDE, personality, skills, offline, memory, companion, setup) */
/* eslint no-with: "off", no-undef: "off", no-useless-assignment: "off" -- a with(ctx) section: names resolve through the scope the root hands it */
/**
 * Extracted from renderer-app-lifecycle-composition.js (a with(ctx) section). It builds the
 * shell service registry (renderer/shell/renderer-shell-service-registry.js) with its module
 * factories, setup scene factories and callbacks, and returns it; the root destructures the
 * service entry points and runs initializeEagerServices.
 *
 * The root passes `{ __proto__: ctx, ...its locals }`: shorthand values for root
 * locals already initialized, accessors for the ones bound later (so a call
 * before they exist throws exactly as the inline code did).
 */
(function (root) {
  function createShellServicesComposition(ctx) {
    with (ctx) {
  return (window.rendererShellServiceRegistryUtils || {}).createShellServiceRegistry?.({
    state,
    windowRef: window,
    documentRef: document,
    surfaceDom,
    lazyDom,
    constants: {
      TOAST_SOURCE,
      ACTIVITY_SCOPE,
    },
    modules: {
      personalityEditorUtils,
      proactiveUtils: window.rendererProactiveUtils || {},
      skillsUtils: window.rendererSkillsUtils || {},
      offlineUtils: window.rendererOfflineUtils || {},
      memoryManagerUtils,
      getIdeControllerUtils: () => window.rendererIdeController || {},
      companionUtils: window.rendererCompanionUtils || {},
      dashboardUtils: window.rendererDashboardUtils || {},
      setupServiceUtils: window.rendererSetupService || {},
      setupControllerUtils: window.rendererSetupController || {},
      setupSceneFactories: {
        acknowledgement: (window.rendererSetupSceneAcknowledgement || {}).createScene,
        workspaceRoot: (window.rendererSetupSceneWorkspaceRoot || {}).createScene,
        endpoint: (window.rendererSetupSceneEndpoint || {}).createScene,
        personality: (window.rendererSetupScenePersonality || {}).createScene,
        skills: (window.rendererSetupSceneSkills || {}).createScene,
        help: (window.rendererSetupSceneHelp || {}).createScene,
        factoryReset: (window.rendererSetupSceneFactoryReset || {}).createScene,
        modelLibrary: (window.rendererSetupSceneModelLibrary || {}).createScene,
        ollamaEngine: (window.rendererSetupSceneOllamaEngineGate || {}).createScene,
        capabilities: (window.rendererSetupSceneCapabilities || {}).createScene,
        setupHub: (window.rendererSetupSceneSetupHub || {}).createScene,
      },
      stepModalUtils: window.inventoryStepModal || {},
    },
    registerCleanup: registerRendererCleanup,
    callbacks: {
      escapeHtml,
      appendClientLog: (...a) => appendClientLog(...a),
      noteScrollProgrammaticWrite: (reason) => chatScrollCoordinator?.noteProgrammaticWrite?.(reason),
      showToastMessage: (...a) => showToastMessage(...a),
      showShellErrorToast: (...a) => showShellErrorToast(...a),
      toErrorMessage: (...a) => toErrorMessage(...a),
      renderAll: (...a) => renderAll(...a),
      renderSettings: (...a) => renderSettings(...a),
      renderComposerState: (...a) => renderComposerState(...a),
      syncComposerInputHeight: (...a) => syncComposerInputHeight(...a),
      loadSessions: (...a) => loadSessions(...a),
      openSession: (...a) => openSession(...a),
      scrollMessageIntoView: (...a) => scrollMessageIntoView(...a),
      getCurrentMessageById: (...a) => getCurrentMessageById(...a),
      setActiveView: (...a) => setActiveView(...a),
      openSettingsSection: (...a) => openSettingsSection(...a),
      getSettingsShellController: () => settingsShellController,
      activateWorkspaceSession: (...a) => activateWorkspaceSession(...a),
      handleCreateSessionWithWorkspace: (...a) => handleCreateSessionWithWorkspace(...a),
      setSessionOrigin: (...a) => setSessionOrigin(...a),
      setPendingOrigin: (...a) => setPendingOrigin(...a),
      clearPendingOrigin: (...a) => clearPendingOrigin(...a),
      dismissToast: (...a) => dismissToast(...a),
      beginActivity,
      resolveActivity,
      failActivity,
      getActivitySnapshot,
      getMostRecentActivity,
      isActivityBusy,
      applyActivityAttributes,
      buildPersonalityStatusTextModel,
      resolvePreferredPersonalityTab,
      // Declared later in this scope (function declarations hoist); the IDE
      // changes panel reads the same turn view-models as the code-review rail.
      getTurnViewModelsForActiveSession: (...a) => getTurnViewModelsForActiveSession(...a),
      getSessionMessages: (sessionId) => getSessionMessages(sessionId),
      getChangesUndoController: () => shellArtifactBridge?.getChangesUndoController?.() || null,
      chatInput,
      composerOfflineLabel,
      homeView,
    },
  }) || {};
    }
  }

  root.rendererAppShellServicesComposition = {
    createShellServicesComposition,
  };
})(window);
