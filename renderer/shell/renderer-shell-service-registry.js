(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererShellServiceRegistryUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const shellStateRuntimeUtils = (typeof globalThis !== 'undefined' && globalThis.rendererShellStateRuntimeUtils)
    || (typeof require === 'function' ? require('./renderer-shell-state-runtime-utils') : null)
    || {};
  const ideRootServiceUtils = (typeof globalThis !== 'undefined' && globalThis.rendererShellIdeRootService)
    || (typeof require === 'function' ? require('./renderer-shell-ide-root-service') : null)
    || {};
  function noop() {}
  function noopStr() { return ''; }
  function noopObj() { return {}; }
  function noopNull() { return null; }
  function noopFalse() { return false; }
  function noopArr() { return []; }
  function noopAsync() { return Promise.resolve(); }
  const MEMORY_CONTROLLER_DEFAULTS = Object.freeze({
    refreshApprovedMemories: async function fallbackApprovedMemories() {
      return { memories: [] };
    },
    refreshPendingMemories: async function fallbackPendingMemories() {
      return { candidates: [] };
    },
    refreshMemoryStatus: async function fallbackMemoryStatus() {
      return { status: null };
    },
    renderApprovedMemoryManager: noop,
    handleApprovedMemorySave: noopAsync,
    handleApprovedMemoryDelete: noopAsync,
    maybeSuggestMemoryCapture: noopAsync,
    upsertApprovedMemoryDraft: noop,
    clearApprovedMemoryDraft: noop,
    getApprovedMemoryById: noopNull,
    hasApprovedMemoryDraftChanges: noopFalse,
    clearDismissedMemorySession: noop,
    rekeyDismissedMemorySession: noopStr,
    resetMemorySuggestionState: noop,
  });

  function createShellServiceRegistry(deps) {
    const {
      state,
      windowRef = globalRef.window || globalRef,
      documentRef = (globalRef.window || globalRef).document || null,
      surfaceDom = {},
      lazyDom = {},
      constants = {},
      modules = {},
      registerCleanup = noop,
      callbacks = {},
    } = deps || {};

    const {
      TOAST_SOURCE = {},
      ACTIVITY_SCOPE = {},
    } = constants;
    const {
      personalityEditorUtils = {},
      proactiveUtils = {},
      skillsUtils = {},
      tipsUtils = {},
      offlineUtils = {},
      memoryManagerUtils = {},
      ideControllerUtils = {},
      companionUtils = {},
      dashboardUtils = {},
      setupServiceUtils = {},
      setupControllerUtils = {},
      setupSceneFactories = {},
      setupHubUtils = globalRef.rendererSetupHub || {},
      stepModalUtils = {},
    } = modules;
    const {
      escapeHtml = function fallbackEscapeHtml(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      },
      appendClientLog = noop,
      noteScrollProgrammaticWrite = noop,
      showToastMessage = noop,
      showShellErrorToast = noop,
      toErrorMessage = function fallbackToErrorMessage(error) {
        return String(error && error.message || error || '');
      },
      renderAll = noop,
      renderPrompts = noop,
      renderSettings = noop,
      renderComposerState = noop,
      syncComposerInputHeight = noop,
      loadSessions = noopAsync,
      openSession = noopAsync,
      getCurrentMessageById = noopNull,
      setActiveView = noop,
      openSettingsSection = noop,
      refreshSuggestions = noopAsync,
      getSettingsShellController = noopNull,
      applyWorkspaceSnapshot = noop,
      renderWorkspaceChrome = noop,
      syncWorkspaceFromStore = noopAsync,
      activateWorkspaceSession = noopAsync,
      handleCreateSessionWithWorkspace = noopAsync,
      getCurrentRuntimePreferences = noopObj,
      setSessionOrigin = noop,
      setPendingOrigin = noop,
      clearPendingOrigin = noop,
      dismissToast = noop,
      beginActivity = noop,
      resolveActivity = noop,
      failActivity = noop,
      getActivitySnapshot = noopObj,
      getMostRecentActivity = noopNull,
      isActivityBusy = noopFalse,
      applyActivityAttributes = noop,
      buildPersonalityStatusTextModel = noopObj,
      resolvePreferredPersonalityTab = noopStr,
      getTurnViewModelsForActiveSession = noopArr,
      chatInput = null,
      composerOfflineLabel = null,
      homeView = null,
    } = callbacks;

    let personalityController = null;
    let getPersonalityActiveFile = noopNull;
    let getPersonalityDraft = noopStr;
    let setPersonalityDraft = noop;
    let loadPersonalityTabContent = noopAsync;
    let refreshPersonalityWorkspace = noopAsync;
    let renderPersonalityEditor = noop;
    let handlePersonalityTabChange = noopAsync;
    let handlePersonalitySave = noopAsync;
    let handlePersonalityReset = noopAsync;
    let handlePersonalityOpenFolder = noopAsync; let hasPersonalityUnsavedChanges = noopFalse;
    let memoryContextController = null;
    let proactiveController = null;
    let refreshProactiveState = noopAsync;
    let handleUseProactiveSuggestionMessage = noopAsync;
    let applyProactivePayload = noopObj;

    let skillsController = null;
    let skillsShellEventsBound = false;
    let refreshSkillsState = noopAsync;
    let renderSkillsManager = noop;
    let updateSkillsSettings = noopAsync;
    let openSkillsScopeFolder = noopAsync;
    let applySkillsPayload = noopObj;

    let tipsController = null;
    let tipsShellEventsBound = false;
    let refreshTipsState = noopAsync;
    let applyTipsPayload = noopObj;

    let offlineController = null;
    let offlineShellEventsBound = false;
    let refreshOfflineState = noopAsync;
    let renderOfflineManager = noop;
    let handleOfflineModeChange = noopAsync;

    let memoryController = null;
    let refreshApprovedMemories = MEMORY_CONTROLLER_DEFAULTS.refreshApprovedMemories;
    let refreshPendingMemories = MEMORY_CONTROLLER_DEFAULTS.refreshPendingMemories;
    let refreshMemoryStatus = MEMORY_CONTROLLER_DEFAULTS.refreshMemoryStatus;
    let renderApprovedMemoryManager = MEMORY_CONTROLLER_DEFAULTS.renderApprovedMemoryManager;
    let handleApprovedMemorySave = MEMORY_CONTROLLER_DEFAULTS.handleApprovedMemorySave;
    let handleApprovedMemoryDelete = MEMORY_CONTROLLER_DEFAULTS.handleApprovedMemoryDelete;
    let maybeSuggestMemoryCapture = MEMORY_CONTROLLER_DEFAULTS.maybeSuggestMemoryCapture;
    let upsertApprovedMemoryDraft = MEMORY_CONTROLLER_DEFAULTS.upsertApprovedMemoryDraft;
    let clearApprovedMemoryDraft = MEMORY_CONTROLLER_DEFAULTS.clearApprovedMemoryDraft;
    let getApprovedMemoryById = MEMORY_CONTROLLER_DEFAULTS.getApprovedMemoryById;
    let hasApprovedMemoryDraftChanges = MEMORY_CONTROLLER_DEFAULTS.hasApprovedMemoryDraftChanges;
    let clearDismissedMemorySession = MEMORY_CONTROLLER_DEFAULTS.clearDismissedMemorySession;
    let rekeyDismissedMemorySession = MEMORY_CONTROLLER_DEFAULTS.rekeyDismissedMemorySession;
    let resetMemorySuggestionState = MEMORY_CONTROLLER_DEFAULTS.resetMemorySuggestionState;

    let refreshWorkspaceRootDependents = noopAsync;

    let companionController = null;
    let companionControllerBound = false;
    let dashboardController = null;

    let setupController = null;
    let setupControllerBound = false;
    let setupServiceInstance = null;

    function ensurePersonalityController() {
      if (personalityController) {
        return personalityController;
      }
      personalityController = personalityEditorUtils.createPersonalityEditor?.({
        state,
        getSetupService: ensureSetupService,
        windowRef,
        renderSettings,
        dom: surfaceDom.settings?.getSectionDom?.('personality') || {},
        callbacks: {
          ACTIVITY_SCOPE,
          beginActivity,
          resolveActivity,
          failActivity,
          getActivitySnapshot,
          getMostRecentActivity,
          isActivityBusy,
          applyActivityAttributes,
          buildPersonalityStatusTextModel,
          resolvePreferredPersonalityTab,
          escapeHtml,
        },
      }) || null;
      ({
        getPersonalityActiveFile = noopNull,
        getPersonalityDraft = noopStr,
        setPersonalityDraft = noop,
        loadPersonalityTabContent = noopAsync,
        refreshPersonalityWorkspace = noopAsync,
        renderPersonalityEditor = noop,
        handlePersonalityTabChange = noopAsync,
        handlePersonalitySave = noopAsync,
        handlePersonalityReset = noopAsync,
        handlePersonalityOpenFolder = noopAsync,
        hasPersonalityUnsavedChanges = noopFalse,
      } = personalityController || {});
      registerCleanup(() => personalityController?.dispose?.());
      return personalityController;
    }

    function ensureMemoryContextController() {
      if (memoryContextController) return memoryContextController;
      memoryContextController = personalityEditorUtils.createMemoryContextEditor?.({ state, windowRef,
        dom: surfaceDom.settings?.getSectionDom?.('memories') || {} }) || null;
      registerCleanup(() => memoryContextController?.dispose?.());
      return memoryContextController;
    }
    function ensureProactiveController() {
      if (proactiveController) {
        return proactiveController;
      }
      proactiveController = proactiveUtils.createProactiveManager?.({
        state,
        dom: {
          ...(surfaceDom.settings?.getSectionDom?.('proactive') || {}),
          chatInput,
        },
        callbacks: {
          escapeHtml,
          showShellErrorToast: (...args) => showShellErrorToast(...args),
          toErrorMessage: (...args) => toErrorMessage(...args),
          renderSettings: (...args) => renderSettings(...args),
          renderComposerState: (...args) => renderComposerState(...args),
          syncComposerInputHeight: (...args) => syncComposerInputHeight(...args),
          getCurrentMessageById: (...args) => getCurrentMessageById(...args),
          setActiveView: (...args) => setActiveView(...args),
          openSettingsSection: (...args) => openSettingsSection(...args),
        },
      }) || null;
      ({
        applyProactivePayload = noopObj,
        refreshProactiveState = noopAsync,
        handleUseProactiveSuggestionMessage = noopAsync,
      } = proactiveController || {});
      return proactiveController;
    }

    function bindSkillsShellEventsIfNeeded(force) {
      if (skillsShellEventsBound || !skillsController || (!force && state.skills?.featureEnabled !== true)) {
        return;
      }
      const disposeSkillBindings = skillsController?.bindShellEvents?.();
      if (typeof disposeSkillBindings === 'function') {
        skillsShellEventsBound = true;
        registerCleanup(function disposeSkillsShellEvents() {
          skillsShellEventsBound = false;
          disposeSkillBindings();
        });
      }
    }

    function ensureSkillsController() {
      if (skillsController) {
        return skillsController;
      }
      skillsController = skillsUtils.createSkillsManager?.({
        state,
        constants: { TOAST_SOURCE },
        dom: surfaceDom.settings?.getSectionDom?.('skills') || {},
        callbacks: {
          escapeHtml,
          renderSettings: (...args) => renderSettings(...args),
          showToastMessage: (...args) => showToastMessage(...args),
          showShellErrorToast: (...args) => showShellErrorToast(...args),
          toErrorMessage: (...args) => toErrorMessage(...args),
        },
      }) || null;
      ({
        applySkillsPayload = noopObj,
        refreshSkillsState = noopAsync,
        renderSkillsManager = noop,
        updateSettings: updateSkillsSettings = noopAsync,
        openScopeFolder: openSkillsScopeFolder = noopAsync,
      } = skillsController || {});
      bindSkillsShellEventsIfNeeded(false);
      return skillsController;
    }

    function bindTipsShellEventsIfNeeded(force) {
      if (tipsShellEventsBound || !tipsController || (!force && state.tips?.featureEnabled !== true)) {
        return;
      }
      const disposeTipBindings = tipsController?.bindShellEvents?.();
      if (typeof disposeTipBindings === 'function') {
        tipsShellEventsBound = true;
        registerCleanup(function disposeTipsShellEvents() {
          tipsShellEventsBound = false;
          disposeTipBindings();
        });
      }
    }

    function ensureTipsController() {
      if (tipsController) {
        return tipsController;
      }
      tipsController = tipsUtils.createTipsManager?.({
        state,
        callbacks: {
          renderPrompts: (...args) => renderPrompts(...args),
        },
      }) || null;
      ({
        applyTipsPayload = noopObj,
        refreshTipsState = noopAsync,
      } = tipsController || {});
      bindTipsShellEventsIfNeeded(false);
      return tipsController;
    }

    function ensureOfflineController() {
      if (offlineController) {
        return offlineController;
      }
      offlineController = offlineUtils.createOfflineManager?.({
        state,
        constants: { TOAST_SOURCE },
        dom: {
          composerOfflineLabel,
        },
        getDom: function getOfflineDom() {
          return {
            offlineBadge: documentRef?.getElementById?.('offlineBadge') || null,
            offlineSummary: documentRef?.getElementById?.('offlineSummary') || null,
            offlineStatus: documentRef?.getElementById?.('offlineStatus') || null,
            offlineLocalOnlyList: documentRef?.getElementById?.('offlineLocalOnlyList') || null,
            offlineModelStatus: documentRef?.getElementById?.('offlineModelStatus') || null,
            offlineModelActions: documentRef?.getElementById?.('offlineModelActions') || null,
          };
        },
        callbacks: {
          escapeHtml,
          appendClientLog: (...args) => appendClientLog(...args),
          showShellErrorToast: (...args) => showShellErrorToast(...args),
          toErrorMessage: (...args) => toErrorMessage(...args),
          renderSettings: (...args) => renderSettings(...args),
          openSettingsSection: (...args) => openSettingsSection(...args),
        },
      }) || null;
      ({
        refreshOfflineState = noopAsync,
        renderOfflineManager = noop,
        handleOfflineModeChange = noopAsync,
      } = offlineController || {});
      return offlineController;
    }

    function ensureMemoryController() {
      if (memoryController) {
        return memoryController;
      }
      function getElementById(id) {
        return documentRef?.getElementById?.(id) || null;
      }
      memoryController = memoryManagerUtils.createMemoryManager?.({
        state,
        constants: { TOAST_SOURCE },
        getDom: function getMemoryDom() {
          return {
            settings: {},
            hub: {
              memorySection: getElementById('memorySettingsSection'),
              memoryPageHeading: getElementById('memoryPageHeading'),
              memoryBadge: getElementById('memoryBadge'),
              memorySummary: getElementById('memorySummary'),
              memoryHealthNote: getElementById('memoryHealthNote'),
              memoryCapturePreferenceHost: getElementById('memoryCapturePreferenceHost'),
              pendingMemorySortHost: getElementById('pendingMemorySortHost'),
              pendingMemoryCount: getElementById('pendingMemoryCount'),
              pendingMemoryStatus: getElementById('pendingMemoryStatus'),
              pendingMemoryList: getElementById('pendingMemoryList'),
              pendingMemoryMoreHost: getElementById('pendingMemoryMoreHost'),
              memoryKindFilterHost: getElementById('memoryKindFilterHost'),
              memorySearchHost: getElementById('memorySearchHost'),
              approvedMemoryCount: getElementById('approvedMemoryCount'),
              approvedMemoryStatus: getElementById('approvedMemoryStatus'),
              approvedMemoryList: getElementById('approvedMemoryList'),
              approvedMemoryMoreHost: getElementById('approvedMemoryMoreHost'),
            },
          };
        },
        registerCleanup,
        callbacks: {
          escapeHtml,
          appendClientLog: (...args) => appendClientLog(...args),
          showToastMessage: (...args) => showToastMessage(...args),
          showShellErrorToast: (...args) => showShellErrorToast(...args),
          toErrorMessage: (...args) => toErrorMessage(...args),
          dismissToast: (...args) => dismissToast(...args),
          openSettingsSection: (...args) => openSettingsSection(...args),
        },
      }) || null;
      ({
        refreshApprovedMemories = MEMORY_CONTROLLER_DEFAULTS.refreshApprovedMemories,
        refreshPendingMemories = MEMORY_CONTROLLER_DEFAULTS.refreshPendingMemories,
        refreshMemoryStatus = MEMORY_CONTROLLER_DEFAULTS.refreshMemoryStatus,
        renderApprovedMemoryManager = MEMORY_CONTROLLER_DEFAULTS.renderApprovedMemoryManager,
        handleApprovedMemorySave = MEMORY_CONTROLLER_DEFAULTS.handleApprovedMemorySave,
        handleApprovedMemoryDelete = MEMORY_CONTROLLER_DEFAULTS.handleApprovedMemoryDelete,
        maybeSuggestMemoryCapture = MEMORY_CONTROLLER_DEFAULTS.maybeSuggestMemoryCapture,
        upsertApprovedMemoryDraft = MEMORY_CONTROLLER_DEFAULTS.upsertApprovedMemoryDraft,
        clearApprovedMemoryDraft = MEMORY_CONTROLLER_DEFAULTS.clearApprovedMemoryDraft,
        getApprovedMemoryById = MEMORY_CONTROLLER_DEFAULTS.getApprovedMemoryById,
        hasApprovedMemoryDraftChanges = MEMORY_CONTROLLER_DEFAULTS.hasApprovedMemoryDraftChanges,
        clearDismissedMemorySession = MEMORY_CONTROLLER_DEFAULTS.clearDismissedMemorySession,
        rekeyDismissedMemorySession = MEMORY_CONTROLLER_DEFAULTS.rekeyDismissedMemorySession,
        resetMemorySuggestionState = MEMORY_CONTROLLER_DEFAULTS.resetMemorySuggestionState,
      } = memoryController || {});
      return memoryController;
    }

    const ideRootService = ideRootServiceUtils.createIdeRootService?.({
      state,
      windowRef,
      surfaceDom,
      ideControllerUtils,
      registerCleanup,
      constants: { TOAST_SOURCE },
      callbacks: {
        chatInput,
        escapeHtml,
        appendClientLog: (...args) => appendClientLog(...args),
        noteScrollProgrammaticWrite: (...args) => noteScrollProgrammaticWrite?.(...args),
        showToastMessage: (...args) => showToastMessage(...args),
        showShellErrorToast: (...args) => showShellErrorToast(...args),
        toErrorMessage: (...args) => toErrorMessage(...args),
        setActiveView: (...args) => setActiveView(...args),
        getTurnViewModelsForActiveSession: (...args) => getTurnViewModelsForActiveSession(...args),
        activateWorkspaceSession: (...args) => activateWorkspaceSession(...args),
        handleCreateSession: (...args) => handleCreateSessionWithWorkspace(...args),
        syncComposerInputHeight: (...args) => syncComposerInputHeight(...args),
        renderComposerState: (...args) => renderComposerState(...args),
        renderAll: (...args) => renderAll(...args),
        refreshWorkspaceRootDependents: (...args) => refreshWorkspaceRootDependents(...args),
      },
    }) || null;
    const workspaceRootService = ideRootService?.workspaceRootService || null;
    let ideController = null;
    function ensureIdeController() {
      ideController = ideRootService?.ensureIdeController?.() || null;
      return ideController;
    }
    const openIdeHelpOverlay = (...args) => ensureIdeController()?.openHelpOverlay?.(...args);

    // UIUX-003 window-exit dirty-buffer coordinator. Non-constructing peek at the
    // already-mounted IDE controller (a never-opened IDE fails open), self-
    // registered on the window global for the window-controls + update-dialog
    // surfaces, plus a native-close request subscription.
    const windowExitPreflight = (windowRef.rendererWindowExitPreflight || {}).createWindowExitPreflight?.({
      root: windowRef,
      getCloseOrchestrator: () => ideController?.getCloseOrchestrator?.() || null,
      getShell: () => windowRef.jennyShell || null,
      showToast: (message) => callbacks.showToastMessage?.(message, { tone: 'warning' }),
      appendClientLog: (...args) => callbacks.appendClientLog?.(...args),
    }) || null;
    if (windowExitPreflight) {
      windowRef.jennyWindowExitPreflight = windowExitPreflight;
      registerCleanup(windowExitPreflight.bind());
      registerCleanup(() => {
        if (windowRef.jennyWindowExitPreflight === windowExitPreflight) {
          windowRef.jennyWindowExitPreflight = null;
        }
      });
    }

    function ensureCompanionController() {
      if (companionController) {
        return companionController;
      }
      try {
        companionController = companionUtils.createCompanionManager?.({
          state,
          dom: {
            homeView,
            chatInput,
            ...(lazyDom.getHomeDom?.() || {}),
          },
          callbacks: {
            escapeHtml,
            appendClientLog: (...args) => appendClientLog(...args),
            showToastMessage: (...args) => showToastMessage(...args),
            showShellErrorToast: (...args) => showShellErrorToast(...args),
            toErrorMessage: (...args) => toErrorMessage(...args),
            renderAll: (...args) => renderAll(...args),
            renderComposerState: (...args) => renderComposerState(...args),
            syncComposerInputHeight: (...args) => syncComposerInputHeight(...args),
            setActiveView: (...args) => setActiveView(...args),
            openSettingsSection: (...args) => openSettingsSection(...args),
            activateWorkspaceSession: (...args) => activateWorkspaceSession(...args),
            handleCreateSession: (...args) => handleCreateSessionWithWorkspace(...args),
            refreshSuggestions: (...args) => refreshSuggestions(...args),
            setSessionOrigin: (...args) => setSessionOrigin(...args),
            setPendingOrigin: (...args) => setPendingOrigin(...args),
            clearPendingOrigin: (...args) => clearPendingOrigin(...args),
            showSetupHelp: (...args) => showSetupHelpSafe(...args),
          },
        }) || null;
        if (companionController && !companionControllerBound) {
          companionController.bind?.();
          companionControllerBound = true;
          registerCleanup(function disposeCompanionController() {
            companionController?.dispose?.();
            companionController = null;
            companionControllerBound = false;
          });
        }
      } catch (error) {
        companionController?.dispose?.();
        companionController = null;
        companionControllerBound = false;
        appendClientLog('ERROR', 'home.surface_init_failed', {
          message: error?.message || String(error),
        });
        return null;
      }
      return companionController;
    }

    function ensureDashboardController() {
      if (dashboardController) {
        return dashboardController;
      }
      try {
        const homeDom = lazyDom.getHomeDom?.() || {};
        dashboardController = dashboardUtils.createDashboardManager?.({
          state,
          documentRef,
          shell: windowRef?.jennyShell || null,
          dom: { homeInfoStrip: homeDom.homeInfoStrip || null, homeDashboardGrid: homeDom.homeDashboardGrid || null,
            homeDaybook: homeDom.homeDaybook || null, homeDashboardRail: homeDom.homeDashboardRail || null,
            homeRailResizer: homeDom.homeRailResizer || null, homeRailGrip: homeDom.homeRailGrip || null },
          callbacks: { appendClientLog: (...args) => appendClientLog(...args), clearPendingOrigin: (...args) => clearPendingOrigin(...args),
            activateWorkspaceSession: (...args) => activateWorkspaceSession(...args), setActiveView: (...args) => setActiveView(...args), renderAll: (...args) => renderAll(...args),
            applyCompanionPayload: (...args) => applyCompanionPayload(...args),
            // Ask-pill mini-composer: the same create path the New Chat button
            // uses, plus the live runtime pair the pill's draft seeds from.
            handleCreateSession: (...args) => handleCreateSessionWithWorkspace(...args),
            getRuntimePreferences: (...args) => getCurrentRuntimePreferences(...args) },
        }) || null;
        if (dashboardController) {
          dashboardController.bind?.();
          registerCleanup(function disposeDashboardController() {
            dashboardController?.dispose?.();
            dashboardController = null;
          });
        }
      } catch (error) {
        dashboardController?.dispose?.();
        dashboardController = null;
        appendClientLog('ERROR', 'home.dashboard_init_failed', { message: error?.message || String(error) });
        return null;
      }
      return dashboardController;
    }
    function renderDashboardSafe() {
      try { return ensureDashboardController()?.render?.() ?? null; } catch (_err) { return null; }
    }

    function ensureSetupService() {
      if (setupServiceInstance) {
        return setupServiceInstance;
      }
      const factory = setupServiceUtils?.createSetupService;
      if (typeof factory !== 'function') {
        return null;
      }
      setupServiceInstance = factory({
        windowRef,
        appendClientLog: (...args) => appendClientLog(...args),
        toErrorMessage: (...args) => toErrorMessage(...args),
      });
      return setupServiceInstance;
    }

    function ensureSetupController() {
      if (setupController) {
        return setupController;
      }
      const factory = setupControllerUtils?.createSetupController;
      if (typeof factory !== 'function') {
        return null;
      }
      const service = ensureSetupService();
      if (!service) {
        return null;
      }
      try {
        const homeDom = lazyDom.getHomeDom?.() || {};
        const setupHubEnabled = state?.features?.featureFlags?.setup_hub === true;
        const offlineBridge = windowRef?.jennyShell?.offline || null;
        const featuresBridge = windowRef?.jennyShell?.features || null;
        const persistPreferredModel = (tag) => (offlineBridge && typeof offlineBridge.updateSettings === 'function' ? offlineBridge.updateSettings({ preferredLocalModel: tag }) : Promise.resolve(null));
        const persistFeatureSettings = (patch) => (featuresBridge && typeof featuresBridge.updateSettings === 'function' ? featuresBridge.updateSettings(patch) : Promise.resolve(null));
        setupController = factory({
          state,
          documentRef,
          setupService: service,
          workspaceRootService,
          chooseWorkspaceRoot: handleWorkspaceRootChoose,
          persistPreferredModel,
          persistFeatureSettings,
          dom: {
            homeSetupModalRoot: documentRef?.getElementById?.('homeSetupModalRoot') || null,
          },
          modules: {
            setupHub: setupHubEnabled ? setupHubUtils : {},
            scenes: {
              workspaceRoot: setupSceneFactories.workspaceRoot,
              localModel: setupSceneFactories.localModel,
              endpoint: setupSceneFactories.endpoint,
              personality: setupSceneFactories.personality,
              skills: setupSceneFactories.skills,
              help: setupSceneFactories.help,
              factoryReset: setupSceneFactories.factoryReset,
              modelLibrary: setupSceneFactories.modelLibrary
                || globalRef.rendererSetupSceneModelLibrary?.createScene,
              ollamaEngine: setupSceneFactories.ollamaEngine || globalRef.rendererSetupSceneOllamaEngineGate?.createScene,
              capabilities: setupSceneFactories.capabilities,
              setupHub: setupHubEnabled
                ? (setupSceneFactories.setupHub || globalRef.rendererSetupSceneSetupHub?.createScene)
                : undefined,
            },
            stepModal: stepModalUtils,
          },
          callbacks: {
            appendClientLog: (...args) => appendClientLog(...args),
            showToastMessage: (...args) => showToastMessage(...args),
            showShellErrorToast: (...args) => showShellErrorToast(...args),
            setActiveView: (...args) => setActiveView(...args),
            renderHomeAfterChange: () => {
              if (state.ui?.activeView === 'home') {
                renderAll();
              }
            },
          },
        }) || null;
        if (setupController && !setupControllerBound) {
          setupController.bind?.();
          setupControllerBound = true;
          registerCleanup(function disposeSetupController() {
            setupController?.dispose?.();
            setupController = null;
            setupControllerBound = false;
          });
        }
      } catch (error) {
        setupController?.dispose?.();
        setupController = null;
        setupControllerBound = false;
        appendClientLog('ERROR', 'setup.controller_init_failed', {
          message: error?.message || String(error),
        });
        return null;
      }
      return setupController;
    }

    function bindOfflineShellEventsIfNeeded() {
      if (offlineShellEventsBound || !offlineController) {
        return;
      }
      const disposeOfflineBindings = offlineController?.bindShellEvents?.();
      if (typeof disposeOfflineBindings === 'function') {
        offlineShellEventsBound = true;
        registerCleanup(function disposeOfflineShellEvents() {
          offlineShellEventsBound = false;
          disposeOfflineBindings();
        });
      }
    }

    registerCleanup(function disposeOfflineController() {
      offlineController?.dispose?.();
      offlineController = null;
      offlineShellEventsBound = false;
    });

    const stateRuntime = shellStateRuntimeUtils.createShellStateRuntimeUtils?.({
      state,
      windowRef,
      workspaceRootService,
      constants: { TOAST_SOURCE },
      registerCleanup,
      callbacks: {
        appendClientLog: (...args) => appendClientLog(...args),
        showShellErrorToast: (...args) => showShellErrorToast(...args),
        renderSettings: (...args) => renderSettings(...args),
        renderAll: (...args) => renderAll(...args),
        getSettingsShellController: (...args) => getSettingsShellController(...args),
        ensureProactiveController: (...args) => ensureProactiveController(...args),
        ensureSkillsController: (...args) => ensureSkillsController(...args),
        ensureTipsController: (...args) => ensureTipsController(...args),
        applyProactivePayload: (...args) => applyProactivePayload(...args),
        applySkillsPayload: (...args) => applySkillsPayload(...args),
        applyTipsPayload: (...args) => applyTipsPayload(...args),
        bindSkillsShellEventsIfNeeded: (...args) => bindSkillsShellEventsIfNeeded(...args),
        bindTipsShellEventsIfNeeded: (...args) => bindTipsShellEventsIfNeeded(...args),
        refreshProactiveStateSafe: (...args) => refreshProactiveStateSafe(...args),
        refreshSkillsStateSafe: (...args) => refreshSkillsStateSafe(...args),
        refreshTipsStateSafe: (...args) => refreshTipsStateSafe(...args),
        refreshPersonalityWorkspaceSafe: (...args) => refreshPersonalityWorkspaceSafe(...args),
        refreshCompanionStateSafe: (...args) => refreshCompanionStateSafe(...args),
      },
    }) || {};
    const {
      applyFeatureStatePayload = noopObj,
      applyWorkspaceRootStatePayload = noopObj,
      refreshFeatureState = noopAsync,
      refreshWorkspaceRootState = noopAsync,
      refreshPhasePercentiles = noopAsync, resetPhasePercentiles = noopAsync,
      refreshWorkspaceRootDependents: refreshWorkspaceRootDependentsImpl = noopAsync,
      hydrateCachedLazyShellState = noop, queueStartupLazyHydration = noop,
      handleWorkspaceRootChoose = noopAsync,
    } = stateRuntime;
    refreshWorkspaceRootDependents = refreshWorkspaceRootDependentsImpl;

    const safeInvoke = (ensure, invoke) => (...args) => {
      try { ensure(); } catch (error) {
        appendClientLog('ERROR', 'shell.controller_init_failed', { ensure: (ensure && ensure.name) || 'unknown', message: String(error && error.message || error || '') });
        return undefined; // isolate the failed lazy controller; don't abort the render/refresh pass
      }
      return invoke(...args);
    };
    const personalitySafe = (invoke) => safeInvoke(ensurePersonalityController, invoke);
    const proactiveSafe = (invoke) => safeInvoke(ensureProactiveController, invoke);
    const offlineSafe = (invoke) => safeInvoke(ensureOfflineController, invoke);
    const memorySafe = (invoke) => safeInvoke(ensureMemoryController, invoke);
    const ideSafe = (invoke) => safeInvoke(ensureIdeController, invoke);

    const getPersonalityActiveFileSafe = personalitySafe((...args) => getPersonalityActiveFile(...args));
    const setPersonalityDraftSafe = personalitySafe((...args) => setPersonalityDraft(...args));
    const refreshPersonalityWorkspaceSafe = personalitySafe((...args) => refreshPersonalityWorkspace(...args));
    const renderPersonalityEditorSafe = personalitySafe((...args) => renderPersonalityEditor(...args));
    const handlePersonalityTabChangeSafe = personalitySafe((...args) => handlePersonalityTabChange(...args));
    const handlePersonalitySaveSafe = personalitySafe((...args) => handlePersonalitySave(...args));
    const handlePersonalityResetSafe = personalitySafe((...args) => handlePersonalityReset(...args));
    const handlePersonalityOpenFolderSafe = personalitySafe((...args) => handlePersonalityOpenFolder(...args));
    const hasPersonalityUnsavedChangesSafe = personalitySafe(() => hasPersonalityUnsavedChanges());
    const refreshMemoryContextFilesSafe = (...args) => ensureMemoryContextController()?.refresh?.(...args); const renderMemoryContextFilesSafe = (...args) => ensureMemoryContextController()?.render?.(...args);
    const loadMemoryContextFileSafe = (...args) => ensureMemoryContextController()?.load?.(...args); const setMemoryContextDraftSafe = (...args) => ensureMemoryContextController()?.setDraft?.(...args);
    const getMemoryContextActiveFileSafe = () => ensureMemoryContextController()?.activeFile?.() || null; const saveMemoryContextFileSafe = (...args) => ensureMemoryContextController()?.save?.(...args);
    const resetMemoryContextFileSafe = (...args) => ensureMemoryContextController()?.reset?.(...args); const hasMemoryContextUnsavedChangesSafe = () => ensureMemoryContextController()?.hasUnsavedChanges?.() === true;
    const refreshProactiveStateSafe = proactiveSafe((...args) => refreshProactiveState(...args));
    const handleUseProactiveSuggestionMessageSafe = proactiveSafe((...args) => handleUseProactiveSuggestionMessage(...args));

    const refreshSkillsStateSafe = (...args) => {
      ensureSkillsController();
      return Promise.resolve(refreshSkillsState(...args)).then(function handleSkillsRefresh(result) {
        const settingsShellController = getSettingsShellController();
        if (state.skills?.featureEnabled === true) {
          settingsShellController?.ensureSettingsSectionReady?.('skills');
        }
        bindSkillsShellEventsIfNeeded(settingsShellController?.isSectionInitialized?.('skills') === true);
        return result;
      });
    };
    const renderSkillsManagerSafe = safeInvoke(ensureSkillsController, (...args) => renderSkillsManager(...args));
    const updateSkillsSettingsSafe = safeInvoke(ensureSkillsController, (...args) => updateSkillsSettings(...args));
    const openSkillsScopeFolderSafe = safeInvoke(ensureSkillsController, (...args) => openSkillsScopeFolder(...args));
    const bindSkillsShellEventsSafe = (...args) => {
      ensureSkillsController();
      return bindSkillsShellEventsIfNeeded(...args);
    };

    const refreshTipsStateSafe = (...args) => {
      ensureTipsController();
      return Promise.resolve(refreshTipsState(...args)).then(function handleTipsRefresh(result) {
        // Contextual tips are Home-owned and must stay live without visiting a
        // retired Settings section first.
        bindTipsShellEventsIfNeeded(true);
        return result;
      });
    };
    const bindTipsShellEventsSafe = (...args) => {
      ensureTipsController();
      return bindTipsShellEventsIfNeeded(...args);
    };

    const refreshOfflineStateSafe = (...args) => {
      ensureOfflineController();
      bindOfflineShellEventsIfNeeded();
      return refreshOfflineState(...args);
    };
    const renderOfflineManagerSafe = offlineSafe((...args) => renderOfflineManager(...args));
    const bindOfflineShellEventsSafe = (...args) => {
      ensureOfflineController();
      return bindOfflineShellEventsIfNeeded(...args);
    };
    const handleOfflineModeChangeSafe = offlineSafe((...args) => handleOfflineModeChange(...args));

    const refreshApprovedMemoriesSafe = memorySafe((...args) => refreshApprovedMemories(...args));
    const refreshPendingMemoriesSafe = memorySafe((...args) => refreshPendingMemories(...args));
    const refreshMemoryStatusSafe = memorySafe((...args) => refreshMemoryStatus(...args));
    const renderApprovedMemoryManagerSafe = memorySafe((...args) => renderApprovedMemoryManager(...args));
    const maybeSuggestMemoryCaptureSafe = memorySafe((...args) => maybeSuggestMemoryCapture(...args));
    const handleApprovedMemorySaveSafe = memorySafe((...args) => handleApprovedMemorySave(...args));
    const handleApprovedMemoryDeleteSafe = memorySafe((...args) => handleApprovedMemoryDelete(...args));
    const upsertApprovedMemoryDraftSafe = memorySafe((...args) => upsertApprovedMemoryDraft(...args));

    const renderIdeSafe = ideSafe((...args) => ensureIdeController()?.renderIde?.(...args));
    const activateIdeSafe = ideSafe((...args) => ensureIdeController()?.activateIde?.(...args));
    const layoutIdeEditorSafe = ideSafe((...args) => ensureIdeController()?.layoutIdeEditor?.(...args));
    const reconcileChatDockHostSafe = () => { try { return ideController?.chatDock?.reconcile?.() === true; } catch (error) { appendClientLog('WARN', 'ide_chat_dock.reconcile_failed', { message: String(error?.message || error).slice(0, 200) }); return false; } }; // chat render must not construct the IDE controller
    const prepareChatDockSessionTransitionSafe = (...args) => { try { return ideController?.chatDock?.prepareSessionTransition?.(...args) === true; } catch (error) { appendClientLog('WARN', 'ide_chat_dock.anchor_capture_failed', { message: String(error?.message || error).slice(0, 200) }); return false; } };
    const getIdeCommandItemsSafe = ideSafe((...args) => ensureIdeController()?.getIdeCommandItems?.(...args) || []);
    const openIdeHelpOverlaySafe = ideSafe((...args) => openIdeHelpOverlay(...args)); const openIdeChangeDiffSafe = ideSafe((...args) => ideController?.openLedgerChangeById?.(...args)); const openIdeFileAtLineSafe = ideSafe((...args) => ideController?.openFileAtLine?.(...args)); // an explicit user click may construct it
    const clearApprovedMemoryDraftSafe = memorySafe((...args) => clearApprovedMemoryDraft(...args));
    const getApprovedMemoryByIdSafe = memorySafe((...args) => getApprovedMemoryById(...args));
    const hasApprovedMemoryDraftChangesSafe = memorySafe((...args) => hasApprovedMemoryDraftChanges(...args));
    const clearDismissedMemorySessionSafe = memorySafe((...args) => clearDismissedMemorySession(...args));
    const rekeyDismissedMemorySessionSafe = memorySafe((...args) => rekeyDismissedMemorySession(...args));
    const resetMemorySuggestionStateSafe = memorySafe((...args) => resetMemorySuggestionState(...args));

    const companionHandlers = shellStateRuntimeUtils.createCompanionSafeHandlers?.({
      state,
      windowRef,
      callbacks: {
        ensureCompanionController: (...args) => ensureCompanionController(...args),
        getCompanionController: () => companionController,
      },
    }) || {};
    const {
      refreshCompanionStateSafe = noopAsync,
      shouldRenderHomePanelSafe = noopFalse,
      renderHomePanelSafe = noopNull,
      applyCompanionPayload = noopObj,
      getAvailableCompanionDeferPresets = function fallbackCompanionDeferPresets() { return []; },
    } = companionHandlers;

    const setupHandlers = shellStateRuntimeUtils.createSetupSafeHandlers?.({
      state,
      callbacks: {
        ensureSetupController: (...args) => ensureSetupController(...args),
        ensureSetupService: (...args) => ensureSetupService(...args),
        getSetupController: () => setupController,
        appendClientLog: (...args) => appendClientLog(...args),
      },
    }) || {};
    const {
      initSetupControllerSafe = noopAsync,
      refreshSetupStateSafe = noopAsync,
      applySetupBackendStatusSafe = noopObj,
      openSetupTileSafe = noopNull,
      showSetupFromSettingsSafe = noop,
      showSetupHelpSafe = noopNull,
      showFactoryResetSafe = noopNull,
      handleRunSetupAgain = noopAsync,
    } = setupHandlers;

    function initializeEagerServices() {
      ensureOfflineController();
      bindOfflineShellEventsIfNeeded();
    }

    return {
      initializeEagerServices,
      applyFeatureStatePayload,
      applyWorkspaceRootStatePayload,
      refreshFeatureState,
      refreshWorkspaceRootState,
      refreshPhasePercentiles,
      resetPhasePercentiles,
      refreshWorkspaceRootDependents,
      hydrateCachedLazyShellState,
      queueStartupLazyHydration,
      handleWorkspaceRootChoose,
      getPersonalityActiveFileSafe,
      getPersonalityDraftSafe: (...args) => {
        ensurePersonalityController();
        return getPersonalityDraft(...args);
      },
      setPersonalityDraftSafe,
      loadPersonalityTabContentSafe: (...args) => {
        ensurePersonalityController();
        return loadPersonalityTabContent(...args);
      },
      refreshPersonalityWorkspaceSafe,
      renderPersonalityEditorSafe,
      handlePersonalityTabChangeSafe,
      handlePersonalitySaveSafe,
      handlePersonalityResetSafe,
      handlePersonalityOpenFolderSafe,
      hasPersonalityUnsavedChangesSafe, refreshMemoryContextFilesSafe, renderMemoryContextFilesSafe,
      loadMemoryContextFileSafe, setMemoryContextDraftSafe, getMemoryContextActiveFileSafe,
      saveMemoryContextFileSafe, resetMemoryContextFileSafe, hasMemoryContextUnsavedChangesSafe,
      refreshProactiveStateSafe,
      handleUseProactiveSuggestionMessageSafe,
      refreshSkillsStateSafe,
      renderSkillsManagerSafe,
      updateSkillsSettingsSafe,
      openSkillsScopeFolderSafe,
      bindSkillsShellEventsSafe,
      refreshTipsStateSafe,
      bindTipsShellEventsSafe,
      refreshOfflineStateSafe,
      renderOfflineManagerSafe,
      bindOfflineShellEventsSafe,
      handleOfflineModeChangeSafe,
      refreshApprovedMemoriesSafe,
      refreshPendingMemoriesSafe,
      refreshMemoryStatusSafe,
      renderApprovedMemoryManagerSafe,
      maybeSuggestMemoryCaptureSafe,
      handleApprovedMemorySaveSafe,
      handleApprovedMemoryDeleteSafe,
      upsertApprovedMemoryDraftSafe,
      ensureIdeController,
      renderIdeSafe,
      activateIdeSafe,
      layoutIdeEditorSafe, reconcileChatDockHostSafe, prepareChatDockSessionTransitionSafe, openIdeChangeDiffSafe, openIdeFileAtLineSafe,
      getIdeCommandItemsSafe,
      openIdeHelpOverlaySafe,
      clearApprovedMemoryDraftSafe,
      getApprovedMemoryByIdSafe,
      hasApprovedMemoryDraftChangesSafe,
      clearDismissedMemorySessionSafe,
      rekeyDismissedMemorySessionSafe,
      resetMemorySuggestionStateSafe,
      refreshCompanionStateSafe,
      shouldRenderHomePanelSafe,
      renderHomePanelSafe,
      applyCompanionPayload,
      getAvailableCompanionDeferPresets,
      renderDashboardSafe,
      ensureSetupController,
      initSetupControllerSafe,
      refreshSetupStateSafe,
      applySetupBackendStatusSafe,
      openSetupTileSafe,
      showSetupFromSettingsSafe,
      showSetupHelpSafe,
      showFactoryResetSafe,
      handleRunSetupAgain,
    };
  }

  return {
    createShellServiceRegistry,
  };
});
