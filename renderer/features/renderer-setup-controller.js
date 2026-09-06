/**
 * renderer/features/renderer-setup-controller.js
 *
 * Owns the renderer-side Phase 7B setup lifecycle: hydrates `state.setup`
 * from the 7A bridge, renders the Companion Home tile group, and orchestrates
 * the registry-backed setup scenes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSetupController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function noop() {}

  var sceneUtils = (typeof globalThis !== 'undefined' && globalThis.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./setup-scenes/scene-utils') : null);
  var globalRef = typeof globalThis !== 'undefined' ? globalThis : null;

  function isTerminalStatus(status) {
    return sceneUtils && typeof sceneUtils.isTerminalStatus === 'function'
      ? sceneUtils.isTerminalStatus(status)
      : status === 'done' || status === 'skipped';
  }

  function snakeStepKey(camelKey) {
    return sceneUtils && typeof sceneUtils.snakeStepKey === 'function'
      ? sceneUtils.snakeStepKey(camelKey)
      : String(camelKey || '');
  }

  function makeDefaultState() {
    var defaultSteps = {};
    var stepOrder = sceneUtils && Array.isArray(sceneUtils.STEP_ORDER)
      ? sceneUtils.STEP_ORDER
      : ['workspaceRoot', 'localModel', 'endpoint', 'personality', 'skills', 'capabilities'];
    stepOrder.forEach(function seedStep(stepId) { defaultSteps[stepId] = 'pending'; });
    return {
      loaded: false,
      setupComplete: false,
      firstRunCompleted: false,
      seen: false,
      dismissed: false,
      completedAt: '',
      updatedAt: '',
      steps: defaultSteps,
      assistantIdentity: { agentName: 'Jenny', profile: 'balanced', customText: '', updatedAt: '' },
      mcpToolsDiscovered: false,
      toolsWorkspaceRootConfigured: false,
      toolsWorkspaceRoot: '',
      workspaceRootStatus: { state: 'missing', message: 'No workspace root is configured.' },
      readiness: {},
      pullInFlight: null,
    };
  }

  function allStepsTerminal(steps) {
    var values = Object.keys(steps || {}).map(function readStep(key) { return steps[key]; });
    return values.length > 0 && values.every(isTerminalStatus);
  }

  // UIUX-005: derives setup HEALTH from step truth (workspaceRoot + model
  // access) rather than trusting the persisted setupComplete boolean, which a
  // skip-through wizard run used to set unconditionally. Falls back to a safe
  // 'pending' verdict (never a false 'complete') if scene-utils failed to load.
  function computeHealth(setup) {
    if (sceneUtils && typeof sceneUtils.computeSetupHealth === 'function') {
      return sceneUtils.computeSetupHealth(setup);
    }
    return { state: 'pending', pendingSteps: [], skippedSteps: [] };
  }

  function hasCurrentMinimumReadiness(setup) {
    var readiness = setup && setup.readiness ? setup.readiness : {};
    return readiness.workspaceRoot && readiness.workspaceRoot.ready === true
      && ((readiness.localModel && readiness.localModel.ready === true)
        || (readiness.endpoint && readiness.endpoint.ready === true));
  }

  function mergeSetupPayload(target, payload) {
    var merged = Object.assign({}, target || {}, payload || {});
    merged.steps = Object.assign({}, target && target.steps, payload && payload.steps);
    merged.assistantIdentity = Object.assign(
      {},
      target && target.assistantIdentity,
      payload && payload.assistantIdentity
    );
    merged.workspaceRootStatus = Object.assign(
      {},
      target && target.workspaceRootStatus,
      payload && payload.workspaceRootStatus
    );
    merged.readiness = Object.assign({}, target && target.readiness, payload && payload.readiness);
    merged.loaded = true;
    merged.pullInFlight = target && target.pullInFlight ? target.pullInFlight : null;
    return merged;
  }

  function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function setupStatusSignature(setupState) {
    var source = plainObject(setupState);
    var steps = plainObject(source.steps);
    var workspaceRootStatus = plainObject(source.workspace_root_status);
    var readiness = plainObject(source.readiness);
    var stepStatuses = {};
    var readinessStatuses = {};
    var stepOrder = sceneUtils && Array.isArray(sceneUtils.STEP_ORDER)
      ? sceneUtils.STEP_ORDER
      : ['workspaceRoot', 'localModel', 'endpoint', 'personality', 'skills', 'capabilities'];
    stepOrder.forEach(function readStep(stepId) {
      var snakeKey = snakeStepKey(stepId);
      stepStatuses[snakeKey] = String(steps[snakeKey] || 'pending');
      readinessStatuses[snakeKey] = plainObject(readiness[snakeKey]);
    });
    return JSON.stringify({
      setupComplete: source.setup_complete === true,
      updatedAt: String(source.updated_at || ''),
      toolsWorkspaceRoot: String(source.tools_workspace_root || ''),
      workspaceRootStatus: {
        state: String(workspaceRootStatus.state || ''),
        message: String(workspaceRootStatus.message || ''),
      },
      mcpToolsDiscovered: source.mcp_tools_discovered === true,
      steps: stepStatuses,
      readiness: readinessStatuses,
    });
  }

  function createSetupController(deps) {
    var d = deps || {};
    var state = d.state;
    var setupService = d.setupService;
    var workspaceRootService = d.workspaceRootService || null;
    var chooseWorkspaceRoot = typeof d.chooseWorkspaceRoot === 'function'
      ? d.chooseWorkspaceRoot
      : null;
    var dom = d.dom || {};
    var modules = d.modules || {};
    var callbacks = d.callbacks || {};
    var documentRef = d.documentRef || (typeof globalThis !== 'undefined' && globalThis.document) || null;

    var appendClientLog = typeof callbacks.appendClientLog === 'function' ? callbacks.appendClientLog : noop;
    var showToastMessage = typeof callbacks.showToastMessage === 'function' ? callbacks.showToastMessage : noop;
    var showShellErrorToast = typeof callbacks.showShellErrorToast === 'function' ? callbacks.showShellErrorToast : noop;
    var setActiveView = typeof callbacks.setActiveView === 'function' ? callbacks.setActiveView : noop;

    if (!state.setup) {
      state.setup = makeDefaultState();
    }

    var sceneFactories = modules.scenes || {};
    var stepModal = modules.stepModal || null;
    var hubFactory = modules.setupHub && typeof modules.setupHub.createSetupHub === 'function'
      ? modules.setupHub.createSetupHub
      : null;
    var persistPreferredModel = typeof d.persistPreferredModel === 'function' ? d.persistPreferredModel : null;
    var persistFeatureSettings = typeof d.persistFeatureSettings === 'function' ? d.persistFeatureSettings : null;

    var modalRoot = dom.homeSetupModalRoot || null;
    var activeScene = null;
    var activeFlow = null;
    var modalLifecycle = null;
    var disposed = false;
    var lifecycleGeneration = 0;
    var completeInFlight = null;

    function ensureModalRoot() {
      if (modalRoot) return modalRoot;
      if (!documentRef) return null;
      modalRoot = documentRef.getElementById('homeSetupModalRoot');
      if (!modalRoot) {
        modalRoot = documentRef.createElement('div');
        modalRoot.id = 'homeSetupModalRoot';
        documentRef.body && documentRef.body.appendChild(modalRoot);
      }
      return modalRoot;
    }

    function ensureModalLifecycle() {
      if (modalLifecycle) return modalLifecycle;
      var rootEl = ensureModalRoot();
      if (!rootEl || !stepModal || typeof stepModal.createLifecycle !== 'function') return null;
      modalLifecycle = stepModal.createLifecycle({
        documentRef: documentRef,
        mountRoot: rootEl,
        getOverlayManager: function getOverlayManager() {
          return d.overlayManager
            || (globalRef && globalRef.rendererOverlayManagerController)
            || null;
        },
        inertTargets: function getBackgroundTargets() {
          var appShell = documentRef && documentRef.getElementById('appShell');
          return appShell ? [appShell] : [];
        },
        appendClientLog: appendClientLog,
      });
      return modalLifecycle;
    }

    function applySnapshot(payload) {
      if (disposed || !payload) return state.setup;
      state.setup = mergeSetupPayload(state.setup, payload);
      maybeAutoFinishSetup(computeCanFinish(state.setup));
      return state.setup;
    }

    function applyBackendStatus(statusPayload) {
      if (disposed) return state.setup;
      var source = statusPayload && typeof statusPayload === 'object' && !Array.isArray(statusPayload)
        ? statusPayload
        : {};
      var nextSetupState = source.setup_state && typeof source.setup_state === 'object'
        && !Array.isArray(source.setup_state)
        ? source.setup_state
        : null;
      if (!nextSetupState) {
        return state.setup;
      }
      var currentSignature = setupStatusSignature(state.setup.raw);
      var nextSignature = setupStatusSignature(nextSetupState);
      if (state.setup.loaded && nextSignature === currentSignature
        && (source.setup_complete === true) === state.setup.setupComplete) {
        return state.setup;
      }
      refresh().catch(function logRefreshFailure(error) {
        appendClientLog('WARN', 'setup.status_refresh_failed', {
          message: error && error.message ? error.message : String(error),
        });
      });
      return state.setup;
    }

    function maybeStartFirstRunFlow() {
      if (disposed) return;
      var setup = state.setup;
      if (!setup || setup.loaded !== true) return;
      if (setup.firstRunCompleted === true || setup.setupComplete === true) return;
      if (activeFlow || !hubFactory) return;
      startLinearFlow();
    }

    async function init() {
      if (disposed) return state.setup;
      var generation = lifecycleGeneration;
      try {
        var fetched = await setupService.getState();
        if (disposed || generation !== lifecycleGeneration) return state.setup;
        if (fetched) {
          applySnapshot(fetched);
        } else {
          state.setup.loaded = true;
        }
      } catch (_error) {
        if (disposed || generation !== lifecycleGeneration) return state.setup;
        state.setup.loaded = true;
      }
      maybeStartFirstRunFlow();
      return state.setup;
    }

    async function refresh() {
      if (disposed) return state.setup;
      var generation = lifecycleGeneration;
      try {
        var fetched = await setupService.getState();
        if (disposed || generation !== lifecycleGeneration) return state.setup;
        if (fetched) {
          applySnapshot(fetched);
        }
      } catch (error) {
        if (disposed || generation !== lifecycleGeneration) return state.setup;
        appendClientLog('WARN', 'setup.refresh_failed', {
          message: error && error.message ? error.message : String(error),
        });
      }
      return state.setup;
    }

    async function markStep(name, status) {
      if (disposed) return state.setup;
      var generation = lifecycleGeneration;
      var stepKey = snakeStepKey(name);
      var nextStatus = isTerminalStatus(status) || status === 'pending' || status === 'error' ? status : 'done';
      var patch = { steps: {} };
      patch.steps[stepKey] = nextStatus;
      try {
        var snapshot = await setupService.updateState(patch);
        if (disposed || generation !== lifecycleGeneration) return state.setup;
        if (snapshot) applySnapshot(snapshot);
      } catch (error) {
        if (disposed || generation !== lifecycleGeneration) return state.setup;
        showShellErrorToast(
          'Could not save the setup step. Try again in a moment.',
          { title: 'Setup Update Failed' }
        );
        appendClientLog('WARN', 'setup.mark_step_failed', {
          step: name,
          status: nextStatus,
          message: error && error.message ? error.message : String(error),
        });
        throw error;
      }
      return state.setup;
    }

    async function applyAssistantIdentity(patch) {
      if (disposed) return state.setup;
      var generation = lifecycleGeneration;
      try {
        var snapshot = await setupService.updateState({ assistantIdentity: patch || {} });
        if (disposed || generation !== lifecycleGeneration) return state.setup;
        if (snapshot) applySnapshot(snapshot);
      } catch (error) {
        if (disposed || generation !== lifecycleGeneration) return state.setup;
        appendClientLog('WARN', 'setup.identity_update_failed', {
          message: error && error.message ? error.message : String(error),
        });
        throw error;
      }
      return state.setup;
    }

    async function completeSetup() {
      if (disposed) return state.setup;
      if (completeInFlight) return completeInFlight;
      completeInFlight = (async function runCompleteSetup() {
        var generation = lifecycleGeneration;
        var health = computeHealth(state.setup);
        if (health.state !== 'complete') {
          showShellErrorToast(
            'Choose a workspace root and configure at least one model route before finishing setup.',
            { title: 'Setup Not Ready' }
          );
          appendClientLog('INFO', 'setup.complete_blocked', {
            pendingSteps: health.pendingSteps,
            skippedSteps: health.skippedSteps,
            currentReadiness: hasCurrentMinimumReadiness(state.setup),
          });
          return state.setup;
        }
        try {
          var snapshot = await setupService.complete();
          if (disposed || generation !== lifecycleGeneration) return state.setup;
          if (snapshot) applySnapshot(snapshot);
        } catch (error) {
          if (disposed || generation !== lifecycleGeneration) return state.setup;
          showShellErrorToast(
            'Could not finish setup. Try again in a moment.',
            { title: 'Setup Finish Failed' }
          );
          appendClientLog('WARN', 'setup.complete_failed', {
            message: error && error.message ? error.message : String(error),
          });
          throw error;
        }
        return state.setup;
      })();
      try {
        return await completeInFlight;
      } finally {
        completeInFlight = null;
      }
    }

    // Escape affordance for the step modal (the shell renders no ✕ button):
    // The shared lifecycle arbitrates Escape and focus, while the scene owns
    // the semantic result. An in-flight Cancel wins over a plain close.
    var ESCAPE_ACTION_ORDER = ['cancelPull', 'cancel', 'finishGateCancel', 'close', 'skip'];

    function requestModalClose() {
      var rootEl = activeScene ? ensureModalRoot() : null;
      if (!rootEl) return;
      for (var i = 0; i < ESCAPE_ACTION_ORDER.length; i += 1) {
        var actionId = ESCAPE_ACTION_ORDER[i];
        var button = rootEl.querySelector('[data-step-modal-action="' + actionId + '"], [data-action="' + actionId + '"]');
        if (!button) continue;
        // A cancel request already in flight keeps ownership of the modal.
        // Falling through to Close would dispose its progress subscription
        // before the backend confirms whether the process actually stopped.
        if (button.disabled === true) return;
        if (typeof button.click === 'function') button.click();
        return;
      }
    }

    function disposeActiveScene() {
      if (modalLifecycle) modalLifecycle.close();
      if (activeScene && typeof activeScene.dispose === 'function') {
        try { activeScene.dispose(); } catch (_error) { /* ignore */ }
      }
      activeScene = null;
      var rootEl = ensureModalRoot();
      if (rootEl) rootEl.innerHTML = '';
    }

    function closeModal() {
      disposeActiveScene();
    }

    function openScene(name, overrides) {
      var factory = sceneFactories && sceneFactories[name];
      if (typeof factory !== 'function') {
        appendClientLog('WARN', 'setup.unknown_scene', { name: name });
        return null;
      }
      var rootEl = ensureModalRoot();
      if (!rootEl) return null;
      disposeActiveScene();
      var sceneDeps = {
        state: state.setup,
        shellState: state,
        windowRef: documentRef && documentRef.defaultView || globalRef,
        documentRef: documentRef,
        setupService: setupService,
        workspaceRootService: workspaceRootService,
        chooseWorkspaceRoot: chooseWorkspaceRoot,
        stepModal: stepModal,
        applySnapshot: applySnapshot,
        markStep: markStep,
        applyAssistantIdentity: applyAssistantIdentity,
        closeModal: (overrides && overrides.closeModal) || closeModal,
        showHome: function showHome() { setActiveView('home'); },
        showToastMessage: showToastMessage,
        showShellErrorToast: showShellErrorToast,
        appendClientLog: appendClientLog,
        persistPreferredModel: persistPreferredModel,
        persistFeatureSettings: persistFeatureSettings,
      };
      if (overrides && typeof overrides.openStep === 'function') sceneDeps.openStep = overrides.openStep;
      if (overrides && typeof overrides.finish === 'function') sceneDeps.finish = overrides.finish;
      if (overrides && typeof overrides.attemptComplete === 'function') sceneDeps.attemptComplete = overrides.attemptComplete;
      var scene = factory(sceneDeps);
      if (!scene) {
        return null;
      }
      activeScene = scene;
      try {
        if (typeof scene.mount === 'function') {
          scene.mount(rootEl);
        }
      } catch (error) {
        appendClientLog('ERROR', 'setup.scene_mount_failed', {
          name: name,
          message: error && error.message ? error.message : String(error),
        });
        disposeActiveScene();
        return null;
      }
      var lifecycle = ensureModalLifecycle();
      if (lifecycle) {
        lifecycle.open({
          id: 'setup-' + name,
          onRequestClose: requestModalClose,
        });
      }
      return scene;
    }

    function openTile(name) {
      return openScene(name);
    }

    var STEP_SCENE = sceneUtils && sceneUtils.STEP_SCENE
      ? sceneUtils.STEP_SCENE
      : { workspaceRoot: 'workspaceRoot', localModel: 'modelLibrary', endpoint: 'endpoint',
          localEngine: 'ollamaEngine', personality: 'personality', skills: 'skills', capabilities: 'capabilities' };

    // Single construction point for relaunch auto-start + explicit Resume.
    // The hub owns navigation; scenes remain standalone and return here by
    // closing through the override below.
    function createHub() {
      var hub = null;
      function openStep(stepId) { return hub && hub.openStep(stepId); }
      function finish(options) { return hub && hub.finish(options); }
      hub = hubFactory({
        renderHub: function renderHub() {
          return openScene('setupHub', {
            closeModal: function quietClose() { return finish({ force: true }); },
            openStep: openStep,
            finish: finish,
            attemptComplete: async function attemptComplete() {
              await completeSetup();
              return state.setup;
            },
          });
        },
        renderStep: function renderStep(stepId) {
          return openScene(STEP_SCENE[stepId], {
            closeModal: function returnToHub() { return hub.returnToHub(); },
          });
        },
        onFinish: finishSetup,
        appendClientLog: appendClientLog,
      });
      return hub;
    }

    function startLinearFlow() {
      if (!hubFactory) {
        return null;
      }
      activeFlow = createHub();
      if (activeFlow && typeof activeFlow.start === 'function') {
        activeFlow.start();
      }
      return activeFlow;
    }

    // Explicit "Resume setup" entry point. A second call while the hub is
    // active re-focuses Home without reconstructing the in-progress surface.
    function resumeSetup() {
      if (activeFlow) {
        setActiveView('home');
        return activeFlow;
      }
      if (!hubFactory) {
        resumeStandDownTicket += 1;
        showFromSettings();
        return null;
      }
      activeFlow = createHub();
      if (activeFlow && typeof activeFlow.start === 'function') {
        activeFlow.start();
      }
      setActiveView('home');
      return activeFlow;
    }

    async function finishSetup(_options) {
      if (disposed) return state.setup;
      var generation = lifecycleGeneration;
      if (activeFlow && typeof activeFlow.dispose === 'function') {
        try { activeFlow.dispose(); } catch (_error) { /* ignore */ }
      }
      activeFlow = null;
      try {
        await setupService.updateState({ firstRunCompleted: true });
        if (disposed || generation !== lifecycleGeneration) return state.setup;
      } catch (error) {
        if (disposed || generation !== lifecycleGeneration) return state.setup;
        appendClientLog('WARN', 'setup.first_run_persist_failed', {
          message: error && error.message ? error.message : String(error),
        });
      }
      // UIUX-005: setupComplete only becomes true when every REQUIRED step
      // (workspaceRoot + model access) is actually 'done' -- completeSetup()
      // used to fire unconditionally here, which is exactly how a skip-through
      // run used to end up lying about being finished.
      var health = computeHealth(state.setup);
      if (health.state === 'complete') {
        // setupComplete can be derived; completedAt distinguishes persisted backend completion.
        if (!(state.setup.setupComplete === true && state.setup.completedAt)) {
          try {
            await completeSetup();
            if (disposed || generation !== lifecycleGeneration) return state.setup;
            if (state.setup.setupComplete !== true) {
              showToastMessage("Setup isn't finished yet — Jenny still can't reach a model. Finish from Settings once the engine is up.");
            }
          } catch (_error) { /* already toasted */ }
        }
      } else {
        try {
          var snapshot = await setupService.updateState({ setupComplete: false });
          if (disposed || generation !== lifecycleGeneration) return state.setup;
          if (snapshot) applySnapshot(snapshot);
        } catch (error) {
          if (disposed || generation !== lifecycleGeneration) return state.setup;
          appendClientLog('WARN', 'setup.finish_incomplete_persist_failed', {
            message: error && error.message ? error.message : String(error),
          });
        }
      }
      closeModal();
      setActiveView('home');
    }

    function openHelp() {
      return openScene('help');
    }

    function openFactoryReset() {
      return openScene('factoryReset');
    }

    function showFromSettings() {
      setActiveView('home');
    }

    function computeCanFinish(setup) {
      return computeHealth(setup).state === 'complete'
        && hasCurrentMinimumReadiness(setup);
    }

    // The exact condition the auto-finish below acts on: setup is loaded, not
    // already complete, no flow owns the modal root, every step has been
    // reviewed, and the Finish gate is genuinely open.
    function isAutoFinishEligible(canFinish) {
      var setup = state.setup;
      return !disposed
        && !!setup
        && setup.loaded === true
        && setup.setupComplete !== true
        && activeFlow === null
        && canFinish === true
        && allStepsTerminal(setup.steps);
    }

    // Auto-finish once every step is reviewed and readiness is satisfied;
    // completeSetup revalidates health client-side and defers route readiness to the backend's complete().
    //
    // LATCHED, not debounced. The latch is set before the attempt and cleared
    // only by a snapshot that is no longer eligible, so the echo path
    // completeSetup -> applySnapshot cannot spin: if the persist comes back
    // still incomplete, the state is still eligible, the latch is still set,
    // and no second call is made.
    //
    // DEFERRED by a microtask so a caller that applies a snapshot and THEN
    // opens the flow within one synchronous run wins. Settings' "Run setup
    // again" persists setupComplete:false, applies the snapshot (which lands
    // here) and calls resumeSetup() before the microtask drains -- by then activeFlow
    // is set, the re-check fails, and the auto-finish stands down instead of
    // undoing the reset the user just asked for.
    // Flag-off Resume advances a ticket so the same deferred attempt stands down without a hub instance.
    var autoFinishLatched = false;
    var resumeStandDownTicket = 0;

    function maybeAutoFinishSetup(canFinish) {
      if (!isAutoFinishEligible(canFinish)) {
        autoFinishLatched = false;
        return;
      }
      if (autoFinishLatched) return;
      autoFinishLatched = true;
      var ticket = resumeStandDownTicket;
      Promise.resolve()
        .then(function runAutoFinish() {
          if (ticket !== resumeStandDownTicket) {
            autoFinishLatched = false;
            return null;
          }
          if (!isAutoFinishEligible(computeCanFinish(state.setup))) {
            // No attempt was made, so a later eligible render may still try.
            autoFinishLatched = false;
            return null;
          }
          appendClientLog('INFO', 'setup.auto_finish', {
            steps: Object.keys(state.setup.steps || {}).length,
          });
          return completeSetup();
        })
        .catch(function ignoreAutoFinishError() { /* completeSetup already toasted */ });
    }

    var bound = false;
    // Renderer-internal cross-module handshake (same idiom as
    // windowRef.jennyWindowExitPreflight): the Home dashboard widget has no
    // wiring path to this controller instance, so resumeSetup self-registers
    // on a well-known global rather than threading a callback through every
    // composition layer between them.
    function bind() {
      if (bound) return;
      disposed = false;
      // A dispose mid-attempt can leave the latch set; a fresh binding starts
      // from a clean auto-finish slate.
      autoFinishLatched = false;
      if (globalRef) {
        globalRef.jennySetupResume = resumeSetup;
      }
      bound = true;
    }

    function dispose() {
      disposed = true;
      lifecycleGeneration += 1;
      if (activeFlow && typeof activeFlow.dispose === 'function') {
        try { activeFlow.dispose(); } catch (_error) { /* ignore */ }
      }
      activeFlow = null;
      disposeActiveScene();
      if (modalLifecycle) modalLifecycle.dispose();
      modalLifecycle = null;
      if (globalRef && globalRef.jennySetupResume === resumeSetup) {
        globalRef.jennySetupResume = null;
      }
      bound = false;
    }

    return {
      init: init,
      refresh: refresh,
      bind: bind,
      dispose: dispose,
      applySnapshot: applySnapshot,
      applyBackendStatus: applyBackendStatus,
      markStep: markStep,
      applyAssistantIdentity: applyAssistantIdentity,
      completeSetup: completeSetup,
      openScene: openScene,
      openTile: openTile,
      startLinearFlow: startLinearFlow,
      resumeSetup: resumeSetup,
      openHelp: openHelp,
      openFactoryReset: openFactoryReset,
      closeModal: closeModal,
      showFromSettings: showFromSettings,
      // exposed for tests
      __internals: {
        allStepsTerminal: allStepsTerminal,
        mergeSetupPayload: mergeSetupPayload,
        makeDefaultState: makeDefaultState,
        computeHealth: computeHealth,
      },
    };
  }

  return {
    createSetupController: createSetupController,
    allStepsTerminal: allStepsTerminal,
    mergeSetupPayload: mergeSetupPayload,
    makeDefaultState: makeDefaultState,
  };
});
