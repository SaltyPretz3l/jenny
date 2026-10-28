/* The Model library renders inside Settings > Models. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      root,
      require('./model-library/model-library-sources'),
      require('./model-library/model-library-merge'),
      require('./model-library/model-library-view'),
      require('./model-library/model-library-runtime-actions'),
      require('../services/renderer-setup-service'),
      require('../inventory/action-button'),
      require('../inventory/text-field'),
      require('../inventory/step-modal'),
      require('../inventory/context-menu'),
      require('./renderer-model-library-format-utils')
    );
    return;
  }
  root.rendererSettingsModelLibrarySection = factory(
    root,
    root.modelLibrarySources,
    root.modelLibraryMerge,
    root.modelLibraryView,
    root.modelLibraryRuntimeActions,
    root.rendererSetupService,
    root.inventoryActionButton,
    root.inventoryTextField,
    root.inventoryStepModal,
    root.inventoryContextMenu,
    root.rendererModelLibraryFormatUtils
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  root,
  sourcesModule,
  mergeModule,
  viewModule,
  runtimeActionsModule,
  setupServiceFactory,
  inventoryActionButton,
  inventoryTextField,
  inventoryStepModal,
  inventoryContextMenu,
  formatUtils
) {
  'use strict';
  var loadFailureReader = root.jennyModelLoadFailure || (typeof require === 'function' ? require('../shared/model-load-failure') : null);
  var recoveryModule = root.rendererModelLibraryRecoveryActions || (typeof require === 'function' ? require('./model-library/model-library-recovery-actions') : null);
  var sectionMergeModule = root.modelLibrarySectionMerge || (typeof require === 'function' ? require('./model-library/model-library-section-merge') : null);
  var sectionRenderModule = root.modelLibrarySectionRender || (typeof require === 'function' ? require('./model-library/model-library-section-render') : null);
  var sectionMenuModule = root.modelLibrarySectionMenu || (typeof require === 'function' ? require('./model-library/model-library-section-menu') : null);
  var sectionDeleteModule = root.modelLibrarySectionDelete || (typeof require === 'function' ? require('./model-library/model-library-section-delete') : null);
  var sectionLiveSyncModule = root.modelLibrarySectionLiveSync || (typeof require === 'function' ? require('./model-library/model-library-section-live-sync') : null);

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var CARD_SELECTOR = '.settings-card[data-settings-section="models"]';
  var TOOLBAR_HOST_ID = 'modelLibrarySectionToolbarHost';
  var HOST_ID = 'modelLibrarySectionHost';
  var EXTRAS_HOST_ID = 'modelLibrarySectionExtrasHost'; // folders + image engine under the grid (else in the toolbar)
  var RECOVERY_ACTIONS = ['retry', 'loadSmaller', 'showFits', 'diagnostics', 'copyDetails'];
  var ACTIONS = ['use', 'unload', 'tune', 'pull', 'cancel', 'menu'].concat(RECOVERY_ACTIONS);

  if (!sourcesModule || typeof sourcesModule.createModelLibrarySource !== 'function'
    || typeof sourcesModule.createPullController !== 'function'
    || typeof sourcesModule.projectLibraryGgufs !== 'function'
    || typeof sourcesModule.isLibraryTag !== 'function'
    || !runtimeActionsModule
    || typeof runtimeActionsModule.createModelLibraryRuntimeActions !== 'function'
    || !mergeModule || typeof mergeModule.mergeModelLibrary !== 'function'
    || typeof mergeModule.filterCounts !== 'function'
    || !viewModule || typeof viewModule.buildModelGrid !== 'function'
    || typeof viewModule.buildFilterChips !== 'function'
    || typeof viewModule.buildHardwareSummaryLine !== 'function'
    || typeof inventoryActionButton !== 'function'
    || typeof inventoryTextField !== 'function'
    || !inventoryStepModal || typeof inventoryStepModal.renderStepModal !== 'function'
    || !inventoryContextMenu || typeof inventoryContextMenu.show !== 'function'
    || !formatUtils || typeof formatUtils.canonicalOllamaTag !== 'function'
    || typeof sectionMergeModule?.createModelLibrarySectionMerge !== 'function'
    || typeof sectionRenderModule?.createModelLibrarySectionRender !== 'function'
    || typeof sectionMenuModule?.createModelLibrarySectionMenu !== 'function'
    || typeof sectionDeleteModule?.createModelLibrarySectionDelete !== 'function'
    || typeof sectionLiveSyncModule?.createModelLibrarySectionLiveSync !== 'function') {
    throw new Error('renderer-settings-model-library-section: missing required dependency');
  }

  var canonicalOllamaTag = formatUtils.canonicalOllamaTag;
  var boundedErrorMessage = formatUtils.boundedErrorMessage;

  function resolveFoldersModule() {
    return (root && root.rendererModelLibraryFolders)
      || (typeof require === 'function' ? require('./renderer-model-library-folders') : null);
  }

  function resolveEngineBlocksModule() {
    return (root && root.modelLibraryEngineBlocks)
      || (typeof require === 'function' ? require('./model-library/model-library-engine-blocks') : null);
  }

  function createModelLibrarySectionController(deps) {
    var d = deps || {};
    var state = d.state || {};
    var windowRef = d.windowRef || root;
    var documentRef = d.documentRef || windowRef.document || null;
    var appendClientLog = typeof d.appendClientLog === 'function'
      ? d.appendClientLog : function noop() {};
    var showToastMessage = typeof d.showToastMessage === 'function'
      ? d.showToastMessage : function noop() {};
    var openModelTuning = typeof d.openModelTuning === 'function'
      ? d.openModelTuning : function noop() {};
    var refreshModelPickers = typeof d.refreshModelPickers === 'function'
      ? d.refreshModelPickers : function noop() {};
    var stepModal = d.stepModal || inventoryStepModal;
    var contextMenu = d.inventoryContextMenu
      || windowRef.inventoryContextMenu || inventoryContextMenu;
    var setupService = d.setupService || (setupServiceFactory
      && typeof setupServiceFactory.createSetupService === 'function'
      ? setupServiceFactory.createSetupService({
          windowRef: windowRef,
          appendClientLog: appendClientLog,
        })
      : null);
    var source = sourcesModule.createModelLibrarySource({
      windowRef: windowRef,
      appendClientLog: appendClientLog,
    });
    var pullController = null;
    var foldersController = null;
    var engineBlocks = null;
    var sourceData = null;
    var merged = null;
    var loadSettled = false; // until then the hardware line reads "Checking hardware…"
    var disposed = false;
    var boundCard = null;
    var unsubscribeFeatures = null;
    var view = { filter: 'all', pullTag: '', statusMessage: '' };
    // The status a load wrote; a later load clears only that, never an action's result ("removed").
    var loadStatusMessage = '';

    function card() {
      return documentRef && documentRef.querySelector
        ? documentRef.querySelector(CARD_SELECTOR) : null;
    }

    function byId(id) {
      return documentRef && documentRef.getElementById ? documentRef.getElementById(id) : null;
    }
    function host() { return byId(HOST_ID); }
    function toolbarHost() { return byId(TOOLBAR_HOST_ID); }
    function extrasHost() { return byId(EXTRAS_HOST_ID); }
    function isDisposed() { return disposed; }
    function getSourceData() { return sourceData; }
    function getMerged() { return merged; }
    function getEngineBlocks() { return engineBlocks; }

    // Flag readers and the merged card list (model-library-section-merge.js).
    var mergeInputs = sectionMergeModule.createModelLibrarySectionMerge({
      state: state, windowRef: windowRef, sourcesModule: sourcesModule, mergeModule: mergeModule,
      loadFailureReader: loadFailureReader, getSourceData: getSourceData, getEngineBlocks: getEngineBlocks,
    });
    var activeModel = mergeInputs.activeModel;
    var accelerationFlagEnabled = mergeInputs.accelerationFlagEnabled;
    var buildMerged = mergeInputs.buildMerged;
    engineBlocks = createEngineBlocks();

    function hardwarePending() {
      return !loadSettled || Boolean(sourceData && sourceData.hardwarePending === true);
    }

    // The NInfer and Image engine blocks (one lifecycle, see model-library-engine-blocks.js).
    function createEngineBlocks() {
      var module = resolveEngineBlocksModule();
      if (typeof module?.createModelLibraryEngineBlocks !== 'function') return null;
      return module.createModelLibraryEngineBlocks({ windowRef: windowRef, documentRef: documentRef, imageEngineEnabled: mergeInputs.imageEngineFlagEnabled,
        ninferEnabled: mergeInputs.ninferFlagEnabled, ninfer: { onState: rebuildFromState, onUse: function (modelId) { runtimeActions.handleUse(modelId); } } });
    }

    function folders() {
      if (disposed || !accelerationFlagEnabled()) return null;
      if (!foldersController) {
        var foldersModule = resolveFoldersModule();
        if (!foldersModule || typeof foldersModule.createModelLibraryFoldersController !== 'function') return null;
        foldersController = foldersModule.createModelLibraryFoldersController({
          windowRef: windowRef,
          documentRef: documentRef,
          getRoots: function () {
            return state.localEngines?.openaiCompatible?.managed?.libraryRoots || [];
          },
          // Collisions are checked against the loaded lists, never the
          // library's own projections, and against what failed to load.
          getLibrary: function () {
            return {
              managed: state.localEngines?.openaiCompatible?.managed || null,
              ollamaTags: sourceData ? sourceData.ollamaTags : [],
              installed: sourceData ? sourceData.installed : [],
              unavailable: sourceData ? sourceData.unavailable || {} : {},
            };
          },
          onSettings: syncEngineSettings,
          refresh: function () { return refresh({ force: true }); },
          // Only "Remove from library", a card ⋯ action, reports on this line.
          setStatus: setStatusMessage,
          hostId: 'modelLibraryFoldersHost',
        });
      }
      return foldersController;
    }

    function renderFolders() {
      var controller = folders();
      if (!controller) return;
      controller.bind();
      controller.render();
    }

    function currentPulls() {
      return pullController ? pullController.getPulls() : {};
    }

    // Last pull status rendered per model key; see handlePullChange.
    var pullRenderStatus = Object.create(null);

    function updateStatusLine() {
      var target = card();
      var status = target && target.querySelector('.model-library-section-status');
      if (status) status.textContent = view.statusMessage;
    }

    function setStatusMessage(message) {
      view.statusMessage = String(message || '');
      updateStatusLine();
    }

    // The Remove dialog and its delete (model-library-section-delete.js).
    var deleteFlow = sectionDeleteModule.createModelLibrarySectionDelete({
      windowRef: windowRef, documentRef: documentRef, stepModal: stepModal, boundedErrorMessage: boundedErrorMessage,
      card: card, findModel: findModel, isDisposed: isDisposed, setStatusMessage: setStatusMessage,
      statusMessage: function () { return view.statusMessage; }, refresh: refresh,
      refreshModelPickers: function () { refreshModelPickers(); }, appendClientLog: appendClientLog,
    });

    // A card's ⋯ menu and Tune options (model-library-section-menu.js).
    var menu = sectionMenuModule.createModelLibrarySectionMenu({
      windowRef: windowRef, documentRef: documentRef, state: state, contextMenu: contextMenu,
      isLibraryTag: sourcesModule.isLibraryTag, focusQuietly: sectionRenderModule.focusQuietly,
      card: card, host: host, toolbarHost: toolbarHost, folders: folders, isDisposed: isDisposed,
      setStatusMessage: setStatusMessage, ninferLibraryInput: mergeInputs.ninferLibraryInput,
      getSourceData: getSourceData, requestRemove: deleteFlow.requestConfirm,
    });

    // Toolbar and card grid rendering (model-library-section-render.js).
    var renderer = sectionRenderModule.createModelLibrarySectionRender({
      documentRef: documentRef, view: view, actions: ACTIONS, viewModule: viewModule, mergeModule: mergeModule,
      inventoryTextField: inventoryTextField, inventoryActionButton: inventoryActionButton,
      host: host, toolbarHost: toolbarHost, extrasHost: extrasHost, isDisposed: isDisposed,
      getMerged: getMerged, hardwarePending: hardwarePending, accelerationFlagEnabled: accelerationFlagEnabled,
      getEngineBlocks: getEngineBlocks, renderFolders: renderFolders, hideMenu: menu.hide,
      currentPulls: currentPulls, activationState: function () { return runtimeActions.activationState(); },
      renderConfirmModal: deleteFlow.renderConfirmModal, findModel: findModel,
    });
    var renderRows = renderer.renderRows;

    function render() {
      renderer.renderToolbar();
      renderRows();
    }

    // force: this refresh answers a user action or follows a mutation, so it must
    // start its own read instead of joining one that began before the change.
    function refresh(options) {
      if (disposed) return Promise.resolve(null);
      return source.load({
        llamaServer: accelerationFlagEnabled(),
        force: Boolean(options && options.force === true),
      }).then(function (result) {
        if (disposed || result.generation !== source.latestGeneration()) return null;
        sourceData = result;
        loadSettled = true;
        liveSync.noteLoad(result);
        merged = buildMerged();
        // One cause behind several reads ("Managed sidecar is not ready yet."
        // from both model lists before the sidecar attaches) reads once.
        var unavailable = [];
        Object.keys(result.unavailable || {}).forEach(function (key) {
          var reason = result.unavailable[key];
          if (reason && unavailable.indexOf(reason) < 0) unavailable.push(reason);
        });
        var nextLoadStatus = unavailable.join(' ');
        if (nextLoadStatus || view.statusMessage === loadStatusMessage) setStatusMessage(nextLoadStatus);
        loadStatusMessage = nextLoadStatus;
        render();
        return result;
      }).catch(function (error) {
        if (!disposed) {
          loadSettled = true;
          setStatusMessage(boundedErrorMessage(error, jt('settings.modelLibrary.refreshFailed', 'Could not refresh the model library.')));
          loadStatusMessage = view.statusMessage;
          appendClientLog('WARN', 'model_library.section_refresh_failed', {
            message: view.statusMessage,
          });
          render();
        }
        return null;
      });
    }

    // A card's own key first (a library card keyed apart answers to its bare
    // tag), then the canonical tag.
    function findModel(keyOrTag) {
      var exact = String(keyOrTag == null ? '' : keyOrTag).trim();
      var key = canonicalOllamaTag(keyOrTag);
      var cards = merged && Array.isArray(merged.cards) ? merged.cards : [];
      return cards.find(function (model) { return model.key === exact; })
        || cards.find(function (model) { return model.key === key; }) || null;
    }

    function handlePullChange(key) {
      if (disposed) return;
      var pull = currentPulls()[key];
      if (!pull) return;
      // Ollama progress events are unthrottled. A running tick never changes
      // row membership, so the missing-row fallback below must only fire on a
      // status TRANSITION - otherwise pulling a tag that has no row in the
      // current DOM (filter = Installed, or a tag outside the catalog) rebuilds
      // the whole list several times a second.
      var previousPullStatus = pullRenderStatus[key] || '';
      pullRenderStatus[key] = String(pull.status || '');
      if (pull.status === 'done') {
        setStatusMessage(jt('settings.modelLibrary.pullComplete', 'Pull complete: {tag}.', { tag: pull.tag }));
        void refresh({ force: true }).then(function () { refreshModelPickers(); });
        return;
      }
      if (pull.status === 'error') setStatusMessage(pull.message || jt('settings.modelLibrary.pullFailed', 'Pull failed.'));
      if (pull.cancelFailed === true) {
        setStatusMessage(jt('settings.modelLibrary.cancelPullFailed', 'Could not cancel the pull.'));
      }
      if (!renderer.replaceRow(key) && pullRenderStatus[key] !== previousPullStatus) renderRows();
    }

    function ensurePullController() {
      if (!pullController) {
        pullController = sourcesModule.createPullController({
          state: state, windowRef: windowRef,
          setupService: setupService,
          onChange: handlePullChange,
          appendClientLog: appendClientLog,
        });
      }
      return pullController;
    }

    var runtimeActions = runtimeActionsModule.createModelLibraryRuntimeActions({
      windowRef: windowRef,
      state: state,
      findModel: function (tag) { return findModel(tag); },
      activeModel: function () { return activeModel(); },
      refresh: function () { return refresh({ force: true }); },
      refreshModelPickers: function () { return refreshModelPickers(); },
      render: function () { renderRows(); },
      setStatusMessage: setStatusMessage,
      showToastMessage: showToastMessage,
      appendClientLog: appendClientLog,
    });

    var recovery = recoveryModule.createModelLibraryRecoveryActions({
      windowRef: windowRef, state: state, runtimeActions: runtimeActions, setStatusMessage: setStatusMessage,
      setFilter: function (filter) { view.filter = filter; render(); }, openDiagnostics: d.openDiagnostics, reader: loadFailureReader,
    });

    function startPull(tag) {
      var model = String(tag || '').trim();
      if (!model) {
        setStatusMessage(jt('settings.modelLibrary.enterTagFirst', 'Enter a model tag first.'));
        return;
      }
      view.pullTag = model;
      setStatusMessage(jt('settings.modelLibrary.startingPull', 'Starting Ollama pull.'));
      void ensurePullController().start(model);
    }

    function handleClick(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') return;
      var chip = target.closest('[data-inv-chip]');
      if (chip && card()?.contains(chip)) {
        var filter = chip.getAttribute('data-inv-chip');
        if (['all', 'installed', 'recommended'].includes(filter)) {
          view.filter = filter;
          render();
        }
        return;
      }
      var modelAction = target.closest('[data-model-card-action]');
      if (modelAction && card()?.contains(modelAction)) {
        var action = modelAction.getAttribute('data-model-card-action');
        var tag = modelAction.getAttribute('data-model-tag') || '';
        if (action === 'menu') {
          var model = findModel(tag);
          if (!model) return;
          menu.open(model, tag, modelAction);
        } else if (action === 'use') runtimeActions.handleUse(tag);
        else if (RECOVERY_ACTIONS.includes(action)) void recovery.handle(action, tag);
        else if (action === 'unload') runtimeActions.handleUnload(tag);
        else if (action === 'tune') openModelTuning(tag, modelAction, menu.tuneOptions(findModel(tag)));
        else if (action === 'pull') {
          // An NInfer row downloads through its block (engine + model, one set-up).
          var ninferRow = findModel(tag);
          if (ninferRow && ninferRow.selectedEngine === 'ninfer') void engineBlocks?.ninfer()?.setup();
          else startPull(tag);
        }
        else if (action === 'cancel') void ensurePullController().cancel(tag);
        return;
      }
      var sectionAction = target.closest('[data-model-library-section-action]');
      if (sectionAction && card()?.contains(sectionAction)) {
        var sectionActionId = sectionAction.getAttribute('data-model-library-section-action');
        if (sectionActionId === 'refresh') {
          runtimeActions.clearActivationMessage();
          void refresh({ force: true });
        }
        else if (sectionActionId === 'pull-tag') startPull(view.pullTag);
        return;
      }
      deleteFlow.handleClick(target);
    }

    function handleInput(event) {
      var target = event && event.target;
      if (target && target.getAttribute
        && target.getAttribute('data-model-library-section-input') === 'pull-tag') {
        view.pullTag = String(target.value || '');
      }
    }
    function handleKeydown(event) { deleteFlow.handleKeydown(event); }

    // features.onChanged fires for every shell-config change, not only flag
    // flips. Reload the sources only when a flag this section reads changed
    // or nothing has loaded yet; otherwise fold in the state this tick carries.
    // The boot seed marks the feature state unresolved: the first load waits
    // for the real payload, so startup reads the sources once, not twice.
    var featureSignature = null;
    function syncFeatureState() {
      if (state && state.features && state.features.availabilityResolved === false) {
        return Promise.resolve(null);
      }
      var nextSignature = String(accelerationFlagEnabled());
      var flagsChanged = nextSignature !== featureSignature;
      featureSignature = nextSignature;
      if (!flagsChanged && sourceData) {
        rebuildFromState();
        return Promise.resolve(null);
      }
      return refresh();
    }

    function rebuildFromState() {
      if (!sourceData) return;
      if (mergeInputs.signatureUnchanged()) return;
      merged = buildMerged();
      render();
    }

    // The state tick's catch-up re-read and llama-server status reread
    // (model-library-section-live-sync.js).
    var liveSync = sectionLiveSyncModule.createModelLibrarySectionLiveSync({
      windowRef: windowRef, state: state, source: source, sourcesModule: sourcesModule,
      isDisposed: isDisposed, accelerationFlagEnabled: accelerationFlagEnabled, getSourceData: getSourceData,
      applyLlamaServer: function (next) {
        sourceData = Object.assign({}, sourceData, { llamaServer: next });
        merged = buildMerged();
        render();
      },
      refresh: function () { return refresh(); }, rebuildFromState: rebuildFromState,
    });

    function syncEngineSettings(localEngines) {
      if (localEngines) state.localEngines = localEngines;
      rebuildFromState();
    }

    function bind() {
      if (disposed || !documentRef) return;
      boundCard = card();
      if (boundCard) {
        boundCard.addEventListener('click', handleClick);
        boundCard.addEventListener('input', handleInput);
      }
      documentRef.addEventListener('keydown', handleKeydown);
      var features = windowRef.jennyShell && windowRef.jennyShell.features;
      if (features && typeof features.onChanged === 'function') {
        unsubscribeFeatures = features.onChanged(syncFeatureState);
      }
      syncFeatureState();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      liveSync.dispose();
      runtimeActions.dispose();
      if (boundCard) {
        boundCard.removeEventListener('click', handleClick);
        boundCard.removeEventListener('input', handleInput);
      }
      documentRef.removeEventListener('keydown', handleKeydown);
      boundCard = null;
      if (typeof unsubscribeFeatures === 'function') {
        try { unsubscribeFeatures(); } catch (_error) { /* best-effort teardown */ }
      }
      unsubscribeFeatures = null;
      if (pullController) pullController.dispose();
      pullController = null;
      if (foldersController) foldersController.dispose();
      foldersController = null;
      if (engineBlocks) engineBlocks.dispose();
      engineBlocks = null;
      menu.hide();
      deleteFlow.removeConfirmModal();
    }

    return {
      bind: bind,
      dispose: dispose,
      render: render,
      refresh: refresh,
      syncFeatureState: syncFeatureState,
      syncFromState: liveSync.syncFromState,
      syncEngineSettings: syncEngineSettings,
      startPull: startPull,
      cancelPull: function (tag) { return ensurePullController().cancel(tag); },
    };
  }

  return { createModelLibrarySectionController: createModelLibrarySectionController };
});
