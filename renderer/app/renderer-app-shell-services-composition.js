/* renderer/app/renderer-app-shell-services-composition.js -- the shell service registry (IDE, personality, skills, offline, memory, companion, setup) */
/**
 * Extracted from renderer-app-lifecycle-composition.js. It builds the
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
  return (ctx.window.rendererShellServiceRegistryUtils || {}).createShellServiceRegistry?.({
    state: ctx.state,
    windowRef: ctx.window,
    documentRef: ctx.document,
    surfaceDom: ctx.surfaceDom,
    lazyDom: ctx.lazyDom,
    constants: {
      TOAST_SOURCE: ctx.TOAST_SOURCE,
      ACTIVITY_SCOPE: ctx.ACTIVITY_SCOPE,
    },
    modules: {
      personalityEditorUtils: ctx.personalityEditorUtils,
      proactiveUtils: ctx.window.rendererProactiveUtils || {},
      skillsUtils: ctx.window.rendererSkillsUtils || {},
      offlineUtils: ctx.window.rendererOfflineUtils || {},
      memoryManagerUtils: ctx.memoryManagerUtils,
      getIdeControllerUtils: () => ctx.window.rendererIdeController || {},
      companionUtils: ctx.window.rendererCompanionUtils || {},
      dashboardUtils: ctx.window.rendererDashboardUtils || {},
      setupServiceUtils: ctx.window.rendererSetupService || {},
      setupControllerUtils: ctx.window.rendererSetupController || {},
      setupSceneFactories: {
        acknowledgement: (ctx.window.rendererSetupSceneAcknowledgement || {}).createScene,
        workspaceRoot: (ctx.window.rendererSetupSceneWorkspaceRoot || {}).createScene,
        endpoint: (ctx.window.rendererSetupSceneEndpoint || {}).createScene,
        personality: (ctx.window.rendererSetupScenePersonality || {}).createScene,
        skills: (ctx.window.rendererSetupSceneSkills || {}).createScene,
        help: (ctx.window.rendererSetupSceneHelp || {}).createScene,
        factoryReset: (ctx.window.rendererSetupSceneFactoryReset || {}).createScene,
        modelLibrary: (ctx.window.rendererSetupSceneModelLibrary || {}).createScene,
        ollamaEngine: (ctx.window.rendererSetupSceneOllamaEngineGate || {}).createScene,
        capabilities: (ctx.window.rendererSetupSceneCapabilities || {}).createScene,
        setupHub: (ctx.window.rendererSetupSceneSetupHub || {}).createScene,
      },
      stepModalUtils: ctx.window.inventoryStepModal || {},
    },
    registerCleanup: ctx.registerRendererCleanup,
    callbacks: {
      escapeHtml: ctx.escapeHtml,
      appendClientLog: (...a) => ctx.appendClientLog(...a),
      noteScrollProgrammaticWrite: (reason) => ctx.chatScrollCoordinator?.noteProgrammaticWrite?.(reason),
      showToastMessage: (...a) => ctx.showToastMessage(...a),
      showShellErrorToast: (...a) => ctx.showShellErrorToast(...a),
      toErrorMessage: (...a) => ctx.toErrorMessage(...a),
      renderAll: (...a) => ctx.renderAll(...a),
      renderSettings: (...a) => ctx.renderSettings(...a),
      renderComposerState: (...a) => ctx.renderComposerState(...a),
      syncComposerInputHeight: (...a) => ctx.syncComposerInputHeight(...a),
      mergePreparedAttachments: (...a) => ctx.mergePreparedAttachments(...a),
      loadSessions: (...a) => ctx.loadSessions(...a),
      openSession: (...a) => ctx.openSession(...a),
      scrollMessageIntoView: (...a) => ctx.scrollMessageIntoView(...a),
      getCurrentMessageById: (...a) => ctx.getCurrentMessageById(...a),
      setActiveView: (...a) => ctx.setActiveView(...a),
      openSettingsSection: (...a) => ctx.openSettingsSection(...a),
      getSettingsShellController: () => ctx.settingsShellController,
      activateWorkspaceSession: (...a) => ctx.activateWorkspaceSession(...a),
      handleCreateSessionWithWorkspace: (...a) => ctx.handleCreateSessionWithWorkspace(...a),
      setSessionOrigin: (...a) => ctx.setSessionOrigin(...a),
      setPendingOrigin: (...a) => ctx.setPendingOrigin(...a),
      clearPendingOrigin: (...a) => ctx.clearPendingOrigin(...a),
      dismissToast: (...a) => ctx.dismissToast(...a),
      beginActivity: ctx.beginActivity,
      resolveActivity: ctx.resolveActivity,
      failActivity: ctx.failActivity,
      getActivitySnapshot: ctx.getActivitySnapshot,
      getMostRecentActivity: ctx.getMostRecentActivity,
      isActivityBusy: ctx.isActivityBusy,
      applyActivityAttributes: ctx.applyActivityAttributes,
      buildPersonalityStatusTextModel: ctx.buildPersonalityStatusTextModel,
      resolvePreferredPersonalityTab: ctx.resolvePreferredPersonalityTab,
      // Declared later in this scope (function declarations hoist); the IDE
      // changes panel reads the same turn view-models as the code-review rail.
      getTurnViewModelsForActiveSession: (...a) => ctx.getTurnViewModelsForActiveSession(...a),
      getSessionMessages: (sessionId) => ctx.getSessionMessages(sessionId),
      getChangesUndoController: () => ctx.shellArtifactBridge?.getChangesUndoController?.() || null,
      chatInput: ctx.chatInput,
      composerOfflineLabel: ctx.composerOfflineLabel,
      homeView: ctx.homeView,
    },
  }) || {};
  }

  root.rendererAppShellServicesComposition = {
    createShellServicesComposition,
  };
})(window);
