/* Flag-gated Settings section for the shared Model Library card grid. */
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

  var CARD_SELECTOR = '.settings-card[data-settings-section="modelLibrary"]';
  var NAV_SELECTOR = '.settings-nav [data-settings-section="modelLibrary"]';
  var TOOLBAR_HOST_ID = 'modelLibrarySectionToolbarHost';
  var HOST_ID = 'modelLibrarySectionHost';
  var MODAL_ID = 'model-library-section-confirm-delete';
  var ACTIONS = ['use', 'unload', 'tune', 'pull', 'cancel', 'menu'];

  if (!sourcesModule || typeof sourcesModule.createModelLibrarySource !== 'function'
    || typeof sourcesModule.createPullController !== 'function'
    || !runtimeActionsModule
    || typeof runtimeActionsModule.createModelLibraryRuntimeActions !== 'function'
    || !mergeModule || typeof mergeModule.mergeModelLibrary !== 'function'
    || typeof mergeModule.filterCounts !== 'function'
    || !viewModule || typeof viewModule.buildModelGrid !== 'function'
    || typeof viewModule.buildModelCard !== 'function'
    || typeof viewModule.buildFilterChips !== 'function'
    || typeof viewModule.buildHardwareSummaryLine !== 'function'
    || typeof inventoryActionButton !== 'function'
    || typeof inventoryTextField !== 'function'
    || !inventoryStepModal || typeof inventoryStepModal.renderStepModal !== 'function'
    || !inventoryContextMenu || typeof inventoryContextMenu.show !== 'function'
    || !formatUtils || typeof formatUtils.canonicalOllamaTag !== 'function') {
    throw new Error('renderer-settings-model-library-section: missing required dependency');
  }

  var canonicalOllamaTag = formatUtils.canonicalOllamaTag;
  var boundedErrorMessage = formatUtils.boundedErrorMessage;

  function resolveFoldersModule() {
    return (root && root.rendererModelLibraryFolders)
      || (typeof require === 'function' ? require('./renderer-model-library-folders') : null);
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
    var openSettingsSection = typeof d.openSettingsSection === 'function'
      ? d.openSettingsSection : function noop() {};
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
    var sourceData = null;
    var merged = null;
    var disposed = false;
    var boundCard = null;
    var unsubscribeFeatures = null;
    var pendingConfirmModel = '';
    var pendingDeleteModel = '';
    var contextSignature = '';
    var view = { filter: 'all', pullTag: '', statusMessage: '' };

    function card() {
      return documentRef && documentRef.querySelector
        ? documentRef.querySelector(CARD_SELECTOR) : null;
    }

    function nav() {
      return documentRef && documentRef.querySelector
        ? documentRef.querySelector(NAV_SELECTOR) : null;
    }

    function host() {
      return documentRef && documentRef.getElementById
        ? documentRef.getElementById(HOST_ID) : null;
    }

    function toolbarHost() {
      return documentRef && documentRef.getElementById
        ? documentRef.getElementById(TOOLBAR_HOST_ID) : null;
    }

    function enabled() {
      var flags = state && state.features && state.features.featureFlags;
      return Boolean(flags
        && flags.model_management_ui === true
        && flags.model_library_section === true);
    }

    function syncVisibility(show) {
      var item = nav();
      var section = card();
      if (item) {
        item.setAttribute('data-feature-gated', 'model_library_section');
        item.hidden = !show;
        item.classList.toggle('hidden', !show);
      }
      if (section) {
        section.hidden = !show;
        if (!show) section.classList.remove('settings-section-active');
      }
      if (!show && state.ui && state.ui.activeSettingsSection === 'modelLibrary') {
        openSettingsSection(
          root.rendererSettingsSectionRegistry?.getDefaultSettingsSection?.() || 'models'
        );
      }
    }

    function activeModel() {
      return String(state && state.status && state.status.model || '').trim();
    }

    function preferredLocalModel() {
      return String(state && state.offline && state.offline.preferredLocalModel || '').trim();
    }

    function accelerationFlagEnabled() {
      return state.features?.featureFlags?.llama_server_acceleration === true;
    }

    function mergeSignature() {
      return [
        activeModel(),
        preferredLocalModel(),
        JSON.stringify(state.localEngines?.openaiCompatible?.managed || null),
        Boolean(state.accelerationCatalog),
      ].join('\n');
    }

    function buildMerged() {
      if (!sourceData) return null;
      contextSignature = mergeSignature();
      return mergeModule.mergeModelLibrary({
        installed: sourceData.installed,
        ollamaTags: sourceData.ollamaTags,
        recommendations: sourceData.recommendations,
        fitEstimates: sourceData.fitEstimates,
        hardware: sourceData.hardware,
        memory: sourceData.memory,
        catalogMeta: sourceData.catalogMeta,
        activeModel: activeModel(),
        preferredLocalModel: preferredLocalModel(),
        // Kill switch: with the flag off none of the per-model engine inputs are
        // projected (no engine or Serving pills), so the library renders exactly
        // as it did before W4.
        managed: accelerationFlagEnabled() ? (state.localEngines?.openaiCompatible?.managed || null) : null,
        localGgufs: accelerationFlagEnabled() ? (sourceData.localGgufs || []) : [],
        llamaServer: accelerationFlagEnabled() ? (sourceData.llamaServer || null) : null,
        acceleration: {
          enabled: accelerationFlagEnabled() && Boolean(state.accelerationCatalog),
          headroomMb: Number(state.accelerationCatalog?.defaults?.vramHeadroomMb) || 2048,
          families: state.accelerationCatalog?.families || [],
        },
      });
    }

    function toolbarHtml() {
      var modelView = merged || { hardware: {}, cards: [] };
      var cards = Array.isArray(modelView.cards) ? modelView.cards : [];
      return '<div class="model-library-section-toolbar">'
        + viewModule.buildFilterChips(view.filter, mergeModule.filterCounts(cards))
        + '<div class="model-library-section-toolbar-actions">'
        + inventoryTextField({
          id: 'modelLibrarySectionPullInput',
          value: view.pullTag,
          placeholder: 'ollama tag, e.g. qwen3:8b',
          ariaLabel: 'Ollama model tag',
          className: 'model-library-section-pull-input',
          dataset: { 'model-library-section-input': 'pull-tag' },
        })
        + inventoryActionButton({
          id: 'pull-tag',
          label: 'Pull',
          variant: 'secondary',
          size: 'sm',
          dataset: { 'model-library-section-action': 'pull-tag' },
        })
        + inventoryActionButton({
          id: 'refresh',
          label: '↻',
          ariaLabel: 'Refresh catalog',
          variant: 'ghost',
          size: 'sm',
          className: 'model-library-section-refresh',
          dataset: { 'model-library-section-action': 'refresh' },
        })
        + '</div></div>'
        + viewModule.buildHardwareSummaryLine(modelView.hardware)
        + (accelerationFlagEnabled() ? '<div id="modelLibraryFoldersHost"></div>' : '');
    }

    function renderFolders() {
      if (!accelerationFlagEnabled()) return;
      if (!foldersController) {
        var foldersModule = resolveFoldersModule();
        if (!foldersModule || typeof foldersModule.createModelLibraryFoldersController !== 'function') return;
        foldersController = foldersModule.createModelLibraryFoldersController({
          windowRef: windowRef,
          documentRef: documentRef,
          getRoots: function () {
            return state.localEngines?.openaiCompatible?.managed?.libraryRoots || [];
          },
          onSettings: syncEngineSettings,
          refresh: function () { return refresh({ force: true }); },
          hostId: 'modelLibraryFoldersHost',
        });
      }
      foldersController.bind();
      foldersController.render();
    }

    function currentPulls() {
      return pullController ? pullController.getPulls() : {};
    }

    // Last pull status rendered per model key; see handlePullChange.
    var pullRenderStatus = Object.create(null);

    // inventoryContextMenu is a process-wide singleton, so this controller may
    // only dismiss a menu it opened itself - a background render must never
    // close (and steal focus from) an Explorer or chat menu. show() dismisses
    // any prior menu first, firing its onHide, so this flag cannot go stale.
    var menuOpen = false;

    function hideOwnContextMenu() {
      if (!menuOpen) return;
      menuOpen = false;
      contextMenu?.hide?.();
    }

    function updateStatusLine() {
      var target = card();
      var status = target && target.querySelector('.model-library-section-status');
      if (status) status.textContent = view.statusMessage;
    }

    function setStatusMessage(message) {
      view.statusMessage = String(message || '');
      updateStatusLine();
    }

    function removeConfirmModal() {
      var existing = documentRef && documentRef.querySelector(
        '[data-step-modal="' + MODAL_ID + '"]'
      );
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    }

    function renderConfirmModal() {
      removeConfirmModal();
      var section = card();
      if (!pendingConfirmModel || !section) return;
      section.insertAdjacentHTML('beforeend', stepModal.renderStepModal({
        id: MODAL_ID,
        tone: 'danger',
        title: 'Remove model?',
        summary: 'This deletes "' + pendingConfirmModel
          + '" from your local engine (ollama rm). This cannot be undone.',
        bodyHtml: '',
        actions: [
          { id: 'cancel', label: 'Cancel', variant: 'secondary' },
          { id: 'confirm', label: 'Remove', variant: 'danger' },
        ],
      }));
    }

    function renderToolbar() {
      if (disposed) return;
      var target = toolbarHost();
      if (!target) return;
      if (!enabled()) {
        target.innerHTML = '';
        return;
      }
      var activeElement = documentRef.activeElement;
      var preservePullFocus = activeElement
        && activeElement.getAttribute?.('data-model-library-section-input') === 'pull-tag';
      var pullFocus = preservePullFocus ? {
        value: String(activeElement.value || ''),
        selectionStart: activeElement.selectionStart,
        selectionEnd: activeElement.selectionEnd,
        selectionDirection: activeElement.selectionDirection,
      } : null;
      if (pullFocus) view.pullTag = pullFocus.value;
      target.innerHTML = toolbarHtml();
      renderFolders();
      if (pullFocus) {
        var nextInput = target.querySelector('[data-model-library-section-input="pull-tag"]');
        if (nextInput) {
          nextInput.value = pullFocus.value;
          try { nextInput.focus({ preventScroll: true }); }
          catch (_focusError) { nextInput.focus(); }
          if (typeof nextInput.setSelectionRange === 'function'
            && Number.isInteger(pullFocus.selectionStart)
            && Number.isInteger(pullFocus.selectionEnd)) {
            nextInput.setSelectionRange(
              pullFocus.selectionStart,
              pullFocus.selectionEnd,
              pullFocus.selectionDirection || 'none'
            );
          }
        }
      }
    }

    function renderRows() {
      hideOwnContextMenu();
      if (disposed) return;
      var target = host();
      if (!target) return;
      if (!enabled()) {
        target.innerHTML = '';
        removeConfirmModal();
        return;
      }
      var activeElement = documentRef.activeElement;
      var activeRow = activeElement && target.contains(activeElement)
        ? activeElement.closest?.('[data-model-key]') : null;
      var rowFocus = activeRow ? {
        action: activeElement.getAttribute?.('data-model-card-action') || '',
        key: activeRow.getAttribute('data-model-key') || '',
      } : null;
      var modelView = merged || { hardware: {}, cards: [] };
      target.innerHTML = viewModule.buildModelGrid(modelView, {
        filter: view.filter,
        actions: ACTIONS,
        pulls: currentPulls(),
        compact: false,
        activation: runtimeActions.activationState(),
      });
      var duplicateHardware = target.querySelector(
        '.model-library-view > .model-library-hardware-summary'
      );
      if (duplicateHardware) duplicateHardware.remove();
      var duplicateChips = target.querySelector('.model-library-view > .model-library-filter-chips');
      if (duplicateChips) duplicateChips.remove();
      if (rowFocus && rowFocus.action && rowFocus.key) {
        var nextRow = Array.from(target.querySelectorAll('[data-model-key]')).find(
          function (candidate) {
            return candidate.getAttribute('data-model-key') === rowFocus.key;
          }
        );
        var nextAction = nextRow && nextRow.querySelector(
          '[data-model-card-action="' + rowFocus.action + '"]'
        );
        if (nextAction) {
          try { nextAction.focus({ preventScroll: true }); }
          catch (_focusError) { nextAction.focus(); }
        }
      }
      renderConfirmModal();
    }

    function render() {
      renderToolbar();
      renderRows();
    }

    // force: this refresh answers a user action or follows a mutation, so it must
    // start its own read instead of joining one that began before the change.
    function refresh(options) {
      if (disposed || !enabled()) return Promise.resolve(null);
      return source.load({
        llamaServer: accelerationFlagEnabled(),
        force: Boolean(options && options.force === true),
      }).then(function (result) {
        if (disposed || result.generation !== source.latestGeneration()) return null;
        sourceData = result;
        merged = buildMerged();
        var unavailable = Object.keys(result.unavailable || {}).map(function (key) {
          return result.unavailable[key];
        }).filter(Boolean);
        setStatusMessage(unavailable.length ? unavailable.join(' ') : '');
        render();
        return result;
      }).catch(function (error) {
        if (!disposed) {
          setStatusMessage(boundedErrorMessage(error, 'Could not refresh the model library.'));
          appendClientLog('WARN', 'model_library.section_refresh_failed', {
            message: view.statusMessage,
          });
          render();
        }
        return null;
      });
    }

    function findModel(keyOrTag) {
      var key = canonicalOllamaTag(keyOrTag);
      var cards = merged && Array.isArray(merged.cards) ? merged.cards : [];
      return cards.find(function (model) { return model.key === key; }) || null;
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
        setStatusMessage('Pull complete: ' + pull.tag + '.');
        void refresh({ force: true }).then(function () { refreshModelPickers(); });
        return;
      }
      if (pull.status === 'error') setStatusMessage(pull.message || 'Pull failed.');
      if (pull.cancelFailed === true) {
        setStatusMessage(pull.message || 'Could not cancel the pull.');
      }
      if (!replaceRow(key) && pullRenderStatus[key] !== previousPullStatus) renderRows();
    }

    // Progress ticks patch one row in place; group membership only changes on
    // 'done', which goes through refresh() above.
    function replaceRow(key) {
      var section = host();
      var model = findModel(key);
      if (!section || !model) return false;
      var element = Array.from(section.querySelectorAll('[data-model-key]')).find(function (candidate) {
        return candidate.getAttribute('data-model-key') === key;
      });
      if (!element) return false;
      var pulls = currentPulls();
      element.outerHTML = viewModule.buildModelRow(Object.assign({}, model, {
        budgetMb: Number(merged && merged.hardware && merged.hardware.budgetMb) || 0,
      }), {
        actions: ACTIONS,
        pull: pulls[key] || {},
        activation: runtimeActions.activationState(),
      });
      return true;
    }

    function ensurePullController() {
      if (!pullController) {
        pullController = sourcesModule.createPullController({
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

    function handleConfirmDelete() {
      var modelId = pendingConfirmModel;
      pendingConfirmModel = '';
      removeConfirmModal();
      if (!modelId) return;
      if (pendingDeleteModel) {
        setStatusMessage('Still removing the previous model.');
        return;
      }
      if (!findModel(modelId)) {
        setStatusMessage('"' + modelId + '" is no longer in the model list.');
        return;
      }
      var deleteFn = windowRef.jennyShell?.models?.delete;
      if (typeof deleteFn !== 'function') {
        setStatusMessage('Delete is unavailable right now.');
        return;
      }
      pendingDeleteModel = modelId;
      Promise.resolve(deleteFn({ model: modelId })).then(function (result) {
        if (disposed) return null;
        pendingDeleteModel = '';
        if (result && result.status === 'deleted') {
          setStatusMessage('"' + modelId + '" removed.');
          return refresh({ force: true }).then(function () { refreshModelPickers(); });
        }
        var code = result && result.code;
        if (code === 'model_in_use') {
          setStatusMessage('"' + modelId + '" is currently loaded. Unload it first.');
        } else if (code === 'not_found') {
          setStatusMessage('"' + modelId + '" was already removed.');
          return refresh({ force: true }).then(function () { refreshModelPickers(); });
        } else if (code === 'invalid_tag') {
          setStatusMessage('That model tag is not valid.');
        } else {
          setStatusMessage(boundedErrorMessage(
            result && result.message,
            'Could not remove that model.'
          ));
        }
        return null;
      }).catch(function (error) {
        if (disposed) return;
        pendingDeleteModel = '';
        setStatusMessage(boundedErrorMessage(error, 'Could not remove that model.'));
        appendClientLog('WARN', 'model_library.delete_failed', {
          model: modelId,
          message: view.statusMessage,
        });
      });
    }

    function startPull(tag) {
      var model = String(tag || '').trim();
      if (!model) {
        setStatusMessage('Enter a model tag first.');
        return;
      }
      view.pullTag = model;
      setStatusMessage('Starting Ollama pull.');
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
          contextMenu.show({
            rootEl: card(),
            anchorEl: modelAction,
            restoreFocusTo: modelAction,
            onHide: function () { menuOpen = false; },
            items: [
              {
                // Same gate the standalone Remove button carried: ollama only,
                // and never the loaded model (the main process rejects that
                // delete with model_in_use, so offering it is a dead end).
                label: 'Remove…',
                danger: true,
                disabled: String(model.engineType || '').toLowerCase() !== 'ollama'
                  || model.active === true,
                action: function () {
                  pendingConfirmModel = tag;
                  renderConfirmModal();
                },
              },
              {
                // Returned so the menu wrapper owns the rejection and the
                // status line reports what actually happened - a denied or
                // absent clipboard must not read as a successful copy.
                label: 'Copy tag',
                action: function () {
                  var writeText = windowRef.navigator?.clipboard?.writeText;
                  if (typeof writeText !== 'function') {
                    setStatusMessage('Clipboard access is unavailable right now.');
                    return null;
                  }
                  return Promise.resolve(writeText.call(windowRef.navigator.clipboard, tag))
                    .then(function () {
                      if (!disposed) setStatusMessage('Copied ' + tag);
                      return null;
                    })
                    .catch(function () {
                      if (!disposed) setStatusMessage('Could not copy ' + tag + ' to the clipboard.');
                      return null;
                    });
                },
              },
            ],
          });
          menuOpen = true;
        } else if (action === 'use') runtimeActions.handleUse(tag);
        else if (action === 'unload') runtimeActions.handleUnload(tag);
        else if (action === 'tune') {
          // The card's merged engine facts (Ollama/GGUF availability) seed the
          // drawer so both surfaces agree on what can run this model.
          openModelTuning(tag, modelAction, {
            displayName: findModel(tag)?.displayName || '',
            engines: findModel(tag)?.engines || null,
          });
        }
        else if (action === 'remove') {
          pendingConfirmModel = tag;
          renderConfirmModal();
        } else if (action === 'pull') startPull(tag);
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
      var modalAction = target.closest('[data-step-modal-action]');
      if (modalAction && modalAction.closest('[data-step-modal="' + MODAL_ID + '"]')) {
        if (modalAction.getAttribute('data-step-modal-action') === 'confirm') handleConfirmDelete();
        else {
          pendingConfirmModel = '';
          removeConfirmModal();
        }
        return;
      }
      var backdrop = target.closest('[data-step-modal="' + MODAL_ID + '"]');
      if (backdrop && pendingConfirmModel && !target.closest('.inv-step-modal')) {
        pendingConfirmModel = '';
        removeConfirmModal();
      }
    }

    function handleInput(event) {
      var target = event && event.target;
      if (target && target.getAttribute
        && target.getAttribute('data-model-library-section-input') === 'pull-tag') {
        view.pullTag = String(target.value || '');
      }
    }
    function handleKeydown(event) {
      if (event && event.key === 'Escape' && pendingConfirmModel) {
        pendingConfirmModel = '';
        removeConfirmModal();
      }
    }

    function syncFeatureState() {
      var show = enabled();
      syncVisibility(show);
      if (!show) {
        render();
        return Promise.resolve(null);
      }
      return refresh();
    }

    function syncFromState() {
      if (!enabled() || !sourceData) return;
      var nextSignature = mergeSignature();
      if (nextSignature === contextSignature) return;
      merged = buildMerged();
      render();
    }

    function syncEngineSettings(localEngines) {
      if (localEngines) state.localEngines = localEngines;
      syncFromState();
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
      hideOwnContextMenu();
      removeConfirmModal();
    }

    return {
      bind: bind,
      dispose: dispose,
      render: render,
      refresh: refresh,
      syncFeatureState: syncFeatureState,
      syncFromState: syncFromState,
      syncEngineSettings: syncEngineSettings,
    };
  }

  return { createModelLibrarySectionController: createModelLibrarySectionController };
});
