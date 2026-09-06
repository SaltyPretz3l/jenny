/* renderer/shell/renderer-shell-state-runtime-utils.js - shell registry state/runtime helpers (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererShellStateRuntimeUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const asyncFence = (typeof globalThis !== 'undefined' && globalThis.rendererAsyncFence)
    || (typeof require === 'function' ? require('../shared/async-fence') : null);
  function noop() {}
  function noopObj() { return {}; }
  function noopNull() { return null; }
  function noopAsync() { return Promise.resolve(); }

  function isPlainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  function mergeObjectDefaults(current, next) {
    return {
      ...(isPlainObject(current) ? current : {}),
      ...(isPlainObject(next) ? next : {}),
    };
  }

  function createShellStateRuntimeUtils(deps) {
    const {
      state = {},
      windowRef = {},
      workspaceRootService = null,
      constants = {},
      registerCleanup = noop,
      callbacks = {},
    } = deps || {};
    const { TOAST_SOURCE = {} } = constants;
    const {
      appendClientLog = noop,
      showShellErrorToast = noop,
      renderSettings = noop,
      renderAll = noop,
      getSettingsShellController = noopNull,
      ensureProactiveController = noop,
      ensureSkillsController = noop,
      ensureTipsController = noop,
      applyProactivePayload = noopObj,
      applySkillsPayload = noopObj,
      applyTipsPayload = noopObj,
      bindSkillsShellEventsIfNeeded = noop,
      bindTipsShellEventsIfNeeded = noop,
      refreshProactiveStateSafe = noopAsync,
      refreshSkillsStateSafe = noopAsync,
      refreshTipsStateSafe = noopAsync,
      refreshPersonalityWorkspaceSafe = noopAsync,
      refreshCompanionStateSafe = noopAsync,
    } = callbacks;
    const phasePercentilesGate = asyncFence.createGenerationGate();

    function syncPretextLayoutDataset(featureState) {
      if (!windowRef?.document?.documentElement) {
        return;
      }
      windowRef.document.documentElement.dataset.pretextLayout =
        featureState?.featureFlags?.pretext_layout === true ? 'true' : 'false';
    }

    // katex_math reaches the stateless markdown pipeline through the shared
    // markdown-math-utils module toggle: renderSanitizedMarkdown consults it
    // per render (cache keys are partitioned by the bit, so a flip mid-
    // session can never serve stale HTML).
    function syncMathRenderingFlag(featureState) {
      let mathUtils = windowRef?.markdownMathUtils
        || (typeof globalThis !== 'undefined' ? globalThis.markdownMathUtils : null);
      if (!mathUtils) {
        try { mathUtils = require('../shared/markdown-math-utils'); } catch (_e) { /* unavailable */ }
      }
      if (!mathUtils || typeof mathUtils.setMathRenderingEnabled !== 'function') {
        return;
      }
      mathUtils.setMathRenderingEnabled(featureState?.featureFlags?.katex_math === true);
    }

    function loadSurfaceGallery(featureState) {
      const documentRef = windowRef?.document;
      if (featureState?.featureFlags?.surface_effect_gallery !== true || !documentRef
        || documentRef.querySelector('script[data-jenny-surface-gallery]')) return;
      const stylesheet = documentRef.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = 'styles/views-surface-gallery.css';
      stylesheet.dataset.jennySurfaceGallery = 'true';
      (documentRef.head || documentRef.documentElement).appendChild(stylesheet);
      const script = documentRef.createElement('script');
      script.src = 'renderer/shell/renderer-surface-gallery-utils.js';
      script.dataset.jennySurfaceGallery = 'true';
      script.addEventListener('load', function installSurfaceGallery() {
        windowRef.rendererSurfaceGalleryUtils?.installSurfaceEffectGallery?.({
          windowRef, documentRef, registerCleanup,
          reducedMotionQuery: windowRef.matchMedia?.('(prefers-reduced-motion: reduce)'),
          getEffectRegistry: () => windowRef.appearanceUtils?.getSurfaceEffectPresets?.() || [],
        });
      });
      (documentRef.body || documentRef.documentElement).appendChild(script);
    }

    function applyFeatureStatePayload(payload) {
      if (isPlainObject(payload)) {
        const currentFeatures = isPlainObject(state.features) ? state.features : {};
        state.features = {
          ...currentFeatures,
          ...payload,
          tools: mergeObjectDefaults(currentFeatures.tools, payload.tools),
          memory: mergeObjectDefaults(currentFeatures.memory, payload.memory),
          featureFlags: mergeObjectDefaults(currentFeatures.featureFlags, payload.featureFlags),
          featureOverrides: mergeObjectDefaults(currentFeatures.featureOverrides, payload.featureOverrides),
          availability: mergeObjectDefaults(currentFeatures.availability, payload.availability),
          // Display-only: a real payload has now been merged in, so status
          // chips keyed off this flag may stop showing 'loading'. Never
          // gates tools/featureFlags/availability themselves.
          availabilityResolved: true,
        };
      }
      syncPretextLayoutDataset(state.features);
      syncMathRenderingFlag(state.features);
      loadSurfaceGallery(state.features);
      return state.features;
    }

    function applyWorkspaceRootStatePayload(payload) {
      const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const status =
        source.workspaceRootStatus
        && typeof source.workspaceRootStatus === 'object'
        && !Array.isArray(source.workspaceRootStatus)
          ? {
              state: String(source.workspaceRootStatus.state || 'missing').trim() || 'missing',
              message: String(source.workspaceRootStatus.message || '').trim(),
            }
          : {
              state: 'missing',
              message: 'No workspace root is configured yet.',
            };
      // Canonical root identity (WIDE-030): workspaceRoot.getState() includes
      // the root coordinator's context { rootId, generation } when the
      // coordinator is wired. The File Map keys its persistence and scan
      // bindings off THIS — absent context leaves rootId '' (nothing persists).
      const context = source.context && typeof source.context === 'object' && !Array.isArray(source.context)
        ? source.context
        : {};
      state.workspaceRoot = {
        path: String(source.workspaceRoot || '').trim(),
        status,
        rootId: String(context.rootId || '').trim(),
        generation: Number.isFinite(Number(context.generation)) ? Number(context.generation) : 0,
      };
      return state.workspaceRoot;
    }

    async function refreshFeatureState(patch) {
      const payload = patch && typeof patch === 'object'
        ? await windowRef?.jennyShell?.features?.updateSettings?.(patch)
        : await windowRef?.jennyShell?.features?.getState?.();
      applyFeatureStatePayload(payload);
      return state.features;
    }

    async function refreshWorkspaceRootState() {
      const service = workspaceRootService || windowRef?.jennyShell?.workspaceRoot || null;
      const payload = typeof service?.getState === 'function' ? await service.getState.call(service) : null;
      applyWorkspaceRootStatePayload(payload);
      return state.workspaceRoot;
    }

    function ensurePhasePercentilesState() {
      if (!state.phasePercentiles || typeof state.phasePercentiles !== 'object') {
        state.phasePercentiles = { payload: null, loading: false, error: '', loadedAt: 0, revision: 0 };
      } else if (!Number.isFinite(Number(state.phasePercentiles.revision))) {
        state.phasePercentiles.revision = 0;
      }
      return state.phasePercentiles;
    }

    function isCurrentPhasePercentilesRevision(phaseState, revision, token) {
      return Number(phaseState.revision || 0) === revision
        && phasePercentilesGate.isCurrent(token);
    }

    async function refreshPhasePercentiles(options) {
      const phaseState = ensurePhasePercentilesState();
      if (!windowRef?.jennyShell?.diagnostics?.phasePercentiles?.get) {
        return null;
      }
      const render = options?.render !== false;
      phaseState.revision = Number(phaseState.revision || 0) + 1;
      phasePercentilesGate.bump();
      const requestRevision = Number(phaseState.revision || 0);
      const requestToken = phasePercentilesGate.capture();
      phaseState.loading = true;
      phaseState.error = '';
      if (render) {
        renderSettings();
      }
      try {
        const payload = await windowRef.jennyShell.diagnostics.phasePercentiles.get();
        if (isCurrentPhasePercentilesRevision(phaseState, requestRevision, requestToken)) {
          phaseState.payload = payload && typeof payload === 'object' && !Array.isArray(payload)
            ? payload
            : null;
          phaseState.loadedAt = Date.now();
        }
        return phaseState.payload;
      } catch (error) {
        if (isCurrentPhasePercentilesRevision(phaseState, requestRevision, requestToken)) {
          phaseState.error = error?.message || String(error);
        } else {
          return phaseState.payload;
        }
        throw error;
      } finally {
        if (isCurrentPhasePercentilesRevision(phaseState, requestRevision, requestToken)) {
          phaseState.loading = false;
        }
        if (render && isCurrentPhasePercentilesRevision(phaseState, requestRevision, requestToken)) {
          renderSettings();
        }
      }
    }

    async function resetPhasePercentiles(options) {
      const phaseState = ensurePhasePercentilesState();
      if (!windowRef?.jennyShell?.diagnostics?.phasePercentiles?.reset) {
        return null;
      }
      const render = options?.render !== false;
      phaseState.revision = Number(phaseState.revision || 0) + 1;
      phasePercentilesGate.bump();
      const resetRevision = Number(phaseState.revision || 0);
      const resetToken = phasePercentilesGate.capture();
      phaseState.loading = true;
      phaseState.error = '';
      if (render) {
        renderSettings();
      }
      try {
        const payload = await windowRef.jennyShell.diagnostics.phasePercentiles.reset();
        if (isCurrentPhasePercentilesRevision(phaseState, resetRevision, resetToken)) {
          phaseState.payload = payload && typeof payload === 'object' && !Array.isArray(payload)
            ? payload
            : null;
          phaseState.loadedAt = Date.now();
        }
        return phaseState.payload;
      } catch (error) {
        if (isCurrentPhasePercentilesRevision(phaseState, resetRevision, resetToken)) {
          phaseState.error = error?.message || String(error);
        } else {
          return phaseState.payload;
        }
        throw error;
      } finally {
        if (isCurrentPhasePercentilesRevision(phaseState, resetRevision, resetToken)) {
          phaseState.loading = false;
        }
        if (render && isCurrentPhasePercentilesRevision(phaseState, resetRevision, resetToken)) {
          renderSettings();
        }
      }
    }

    function refreshVisibleLazySections() {
      const settingsShellController = getSettingsShellController();
      return {
        proactive: settingsShellController?.isSectionInitialized?.('proactive') === true,
        skills: settingsShellController?.isSectionInitialized?.('skills') === true,
        tips: settingsShellController?.isSectionInitialized?.('tips') === true,
        personality: settingsShellController?.isSectionInitialized?.('personality') === true,
        diagnostics: settingsShellController?.isSectionInitialized?.('diagnostics') === true,
      };
    }

    async function refreshWorkspaceRootDependents() {
      // Root-scoped surfaces without a callback seam here (the chat rail's
      // file preview) invalidate off this event; a stale preview would show
      // the OLD root's bytes under a path that now resolves in the new root.
      try {
        windowRef?.dispatchEvent?.(new windowRef.CustomEvent('workspace:root-committed'));
      } catch { /* jsdom harnesses without CustomEvent stay silent */ }
      const visibleSections = refreshVisibleLazySections();
      const refreshTasks = [
        refreshWorkspaceRootState(),
        refreshFeatureState(),
      ];
      if (visibleSections.proactive) {
        refreshTasks.push(refreshProactiveStateSafe());
      }
      if (visibleSections.skills) {
        refreshTasks.push(refreshSkillsStateSafe());
      }
      if (visibleSections.tips) {
        refreshTasks.push(refreshTipsStateSafe());
      }
      if (visibleSections.personality) {
        refreshTasks.push(refreshPersonalityWorkspaceSafe());
      }
      if (visibleSections.diagnostics) {
        refreshTasks.push(refreshPhasePercentiles({ render: false }));
      }
      if (windowRef?.jennyShell?.companion?.getState) {
        refreshTasks.push(Promise.resolve(refreshCompanionStateSafe()));
      }
      const results = await Promise.allSettled(refreshTasks);
      const failures = results
        .filter(function findRejected(result) { return result.status === 'rejected'; })
        .map(function getFailure(result) { return result.reason; });
      if (failures.length) {
        appendClientLog('WARN', 'workspace_root.dependent_refresh_partial_failure', {
          count: failures.length,
          messages: failures.map(function mapFailure(error) {
            return error?.message || String(error);
          }).join(' | '),
        });
        showShellErrorToast(
          'Some workspace-dependent views may still be stale. Try the action again if something looks off.',
          {
            title: 'Workspace Root Refresh Incomplete',
            source: TOAST_SOURCE.settings,
            dedupeKey: `${TOAST_SOURCE.settings}:workspace-root:partial-refresh`,
          }
        );
      }
      renderAll();
      return {
        workspaceRoot: state.workspaceRoot,
        failures,
      };
    }

    function getCachedBridgeState(key) {
      const bridgeState = windowRef?.jennyShell?.__state;
      if (!bridgeState || typeof bridgeState !== 'object' || Array.isArray(bridgeState)) {
        return null;
      }
      const payload = bridgeState[key];
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null;
      }
      return payload;
    }

    function getBootstrapHarnessOptions() {
      const options = windowRef?.jennyShell?.__options;
      if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return null;
      }
      return options;
    }

    function shouldBootstrapLazyServiceAtStartup(serviceId) {
      const options = getBootstrapHarnessOptions();
      if (!options) {
        return false;
      }
      const hasServiceOverride = Boolean(options[serviceId]);
      if (!hasServiceOverride) {
        return false;
      }
      const competingLazyOverrides = [
        'workspaceRoot',
        'proactive',
        'skills',
        'tips',
        'offline',
        'harness',
        'companion',
      ].filter(function filterCompetingOverrides(key) {
        return key !== serviceId && Boolean(options[key]);
      });
      if (serviceId === 'proactive') {
        return competingLazyOverrides.length === 0 || (
          competingLazyOverrides.length === 1 && competingLazyOverrides[0] === 'harness'
        );
      }
      if (serviceId === 'skills' || serviceId === 'tips') {
        return competingLazyOverrides.length === 0 || (
          competingLazyOverrides.length === 1
          && (competingLazyOverrides[0] === 'skills' || competingLazyOverrides[0] === 'tips')
        );
      }
      return competingLazyOverrides.length === 0;
    }

    function hydrateCachedLazyShellState() {
      const cachedProactiveState = getCachedBridgeState('proactiveState');
      if (cachedProactiveState) {
        ensureProactiveController();
        applyProactivePayload(cachedProactiveState);
      }
      const cachedSkillsState = getCachedBridgeState('skillsState');
      if (cachedSkillsState) {
        ensureSkillsController();
        applySkillsPayload(cachedSkillsState);
        bindSkillsShellEventsIfNeeded(state.skills?.featureEnabled === true);
      }
      const cachedTipsState = getCachedBridgeState('tipsState');
      if (cachedTipsState) {
        ensureTipsController();
        applyTipsPayload(cachedTipsState);
        bindTipsShellEventsIfNeeded(state.tips?.featureEnabled === true);
      }
    }

    function queueStartupLazyHydration() {
      if (shouldBootstrapLazyServiceAtStartup('proactive')) {
        Promise.resolve()
          .then(function refreshProactiveBootstrap() {
            return refreshProactiveStateSafe();
          })
          .then(function rerenderAfterProactiveBootstrap() {
            renderAll();
          })
          .catch(function handleProactiveBootstrapError(error) {
            appendClientLog('WARN', 'proactive.bootstrap_failed', {
              message: error?.message || String(error),
            });
          });
      }
      if (shouldBootstrapLazyServiceAtStartup('skills')) {
        Promise.resolve()
          .then(function refreshSkillsBootstrap() {
            return refreshSkillsStateSafe();
          })
          .then(function rerenderAfterSkillsBootstrap() {
            renderAll();
          })
          .catch(function handleSkillsBootstrapError(error) {
            appendClientLog('WARN', 'skills.bootstrap_failed', {
              message: error?.message || String(error),
            });
          });
      }
      // Contextual tips are Home-owned now, not a lazy Settings surface. Read
      // their bounded state at startup so the one Home preference takes effect
      // without requiring the user to visit Settings first.
      Promise.resolve()
        .then(function refreshTipsBootstrap() { return refreshTipsStateSafe(); })
        .then(function rerenderAfterTipsBootstrap() { renderAll(); })
        .catch(function handleTipsBootstrapError(error) {
          appendClientLog('WARN', 'tips.bootstrap_failed', {
            message: error?.message || String(error),
          });
        });
    }

    async function runWorkspaceRootTransition(mode) {
      const invoke = workspaceRootService?.[mode];
      if (typeof invoke !== 'function') {
        const transition = {
          committed: false, changed: false, canceled: false, blocked: true,
          mode, stage: 'renderer', code: 'transition_controller_unavailable',
        };
        showShellErrorToast('Workspace folder changes are unavailable in this shell mode.', {
          title: 'Workspace',
          source: TOAST_SOURCE.settings,
          dedupeKey: `${TOAST_SOURCE.settings}:workspace-root:unavailable`,
        });
        return { workspaceRoot: state.workspaceRoot, failures: [], transition, blocked: true };
      }
      try {
        const transition = await invoke.call(workspaceRootService);
        return {
          workspaceRoot: state.workspaceRoot,
          failures: [],
          transition,
          canceled: transition?.canceled === true,
          blocked: transition?.blocked === true,
        };
      } catch (error) {
        appendClientLog('WARN', 'workspace_root.transition_call_failed', {
          mode,
          message: error?.message || String(error),
        });
        const transition = {
          committed: false, changed: false, canceled: false, blocked: true,
          mode, stage: 'renderer', code: 'transition_call_failed',
        };
        return { workspaceRoot: state.workspaceRoot, failures: [error], transition, blocked: true };
      }
    }

    function handleWorkspaceRootChoose() {
      return runWorkspaceRootTransition('choose');
    }

    return {
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
    };
  }

  function createCompanionSafeHandlers(deps) {
    const {
      state = {},
      windowRef = {},
      callbacks = {},
    } = deps || {};
    const {
      ensureCompanionController = noopNull,
      getCompanionController = noopNull,
    } = callbacks;

    function applyCompanionPayload(payload) {
      const nextCompanionState = ensureCompanionController()?.applyCompanionPayload?.(payload);
      if (nextCompanionState && typeof nextCompanionState === 'object' && !Array.isArray(nextCompanionState)) {
        state.companion = nextCompanionState;
      } else if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        state.companion = payload;
      }
      return state.companion;
    }

    function refreshCompanionStateSafe() {
      const controller = ensureCompanionController();
      if (controller?.refreshCompanionState) {
        return controller.refreshCompanionState(...arguments);
      }
      if (windowRef?.jennyShell?.companion?.getState) {
        return Promise.resolve(windowRef.jennyShell.companion.getState(...arguments))
          .then(function applyCompanionShellPayload(payload) {
            return applyCompanionPayload(payload);
          });
      }
      return Promise.resolve(state.companion);
    }

    function renderHomePanelSafe() {
      if (!getCompanionController() && state.ui?.activeView !== 'home') {
        return null;
      }
      return ensureCompanionController()?.renderHomePanel?.(...arguments);
    }

    function shouldRenderHomePanelSafe() {
      return state.ui?.activeView === 'home' || Boolean(getCompanionController());
    }

    function getAvailableCompanionDeferPresets() {
      return Array.isArray(state.companion?.availableDeferPresets)
        ? state.companion.availableDeferPresets.filter(function filterPreset(entry) {
          return entry
            && typeof entry === 'object'
            && String(entry.preset || '').trim()
            && String(entry.label || '').trim();
        })
        : [];
    }

    return {
      refreshCompanionStateSafe,
      shouldRenderHomePanelSafe,
      renderHomePanelSafe,
      applyCompanionPayload,
      getAvailableCompanionDeferPresets,
    };
  }

  function createSetupSafeHandlers(deps) {
    const {
      state = {},
      callbacks = {},
    } = deps || {};
    const {
      ensureSetupController = noopNull,
      ensureSetupService = noopNull,
      getSetupController = noopNull,
      appendClientLog = noop,
    } = callbacks;

    const setupSafe = (invoke) => (...args) => {
      ensureSetupController();
      return invoke(...args);
    };
    const initSetupControllerSafe = setupSafe((...args) => {
      const controller = getSetupController();
      return controller && typeof controller.init === 'function'
        ? controller.init(...args)
        : Promise.resolve(state.setup);
    });
    const refreshSetupStateSafe = setupSafe((...args) => {
      const controller = getSetupController();
      return controller && typeof controller.refresh === 'function'
        ? controller.refresh(...args)
        : Promise.resolve(state.setup);
    });
    const applySetupBackendStatusSafe = setupSafe((...args) => {
      const controller = getSetupController();
      return controller && typeof controller.applyBackendStatus === 'function'
        ? controller.applyBackendStatus(...args)
        : state.setup;
    });
    const openSetupTileSafe = setupSafe((...args) => {
      const controller = getSetupController();
      return controller && typeof controller.openTile === 'function'
        ? controller.openTile(...args)
        : null;
    });
    const showSetupFromSettingsSafe = setupSafe(() => {
      const controller = getSetupController();
      if (controller && typeof controller.showFromSettings === 'function') {
        controller.showFromSettings();
      }
    });
    const showSetupHelpSafe = setupSafe(() => {
      const controller = getSetupController();
      return controller && typeof controller.openHelp === 'function'
        ? controller.openHelp()
        : null;
    });
    const showFactoryResetSafe = setupSafe(() => {
      const controller = getSetupController();
      return controller && typeof controller.openFactoryReset === 'function'
        ? controller.openFactoryReset()
        : null;
    });

    async function handleRunSetupAgain() {
      const service = ensureSetupService();
      if (!service) {
        return state.setup;
      }
      ensureSetupController();
      const controller = getSetupController();
      try {
        const snapshot = await service.updateState({ dismissed: false, setupComplete: false });
        if (snapshot && controller?.applySnapshot) {
          controller.applySnapshot(snapshot);
        }
      } catch (error) {
        appendClientLog('WARN', 'setup.run_again_failed', {
          message: error?.message || String(error),
        });
      }
      // resumeSetup opens the flow at the first unresolved step and is idempotent;
      // fall back to showFromSettings when resumeSetup is unavailable.
      if (controller?.resumeSetup) {
        controller.resumeSetup();
      } else if (controller?.showFromSettings) {
        controller.showFromSettings();
      }
      return state.setup;
    }

    return {
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
    createCompanionSafeHandlers,
    createSetupSafeHandlers,
    createShellStateRuntimeUtils,
  };
});
