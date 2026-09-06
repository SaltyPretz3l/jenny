/**
 * Setup model-library scene: choose an installed model or pull a catalog card.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      root,
      require('../../shell/model-library/model-library-sources'),
      require('../../shell/model-library/model-library-merge'),
      require('../../shell/model-library/model-library-view'),
      require('./hardware-recommend-operations'),
      require('../../shell/renderer-model-library-format-utils'),
      require('./scene-utils')
    );
    return;
  }
  root.rendererSetupSceneModelLibrary = factory(
    root,
    root.modelLibrarySources,
    root.modelLibraryMerge,
    root.modelLibraryView,
    root.rendererHardwareRecommendOperations,
    root.rendererModelLibraryFormatUtils,
    root.rendererSetupSceneUtils
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (
  root,
  sourcesModule,
  mergeModule,
  viewModule,
  operationsModule,
  formatUtils,
  sceneUtils
) {
  'use strict';

  var ACTIONS = ['use', 'pull', 'cancel'];

  if (!sourcesModule || typeof sourcesModule.createModelLibrarySource !== 'function'
    || typeof sourcesModule.createPullController !== 'function'
    || !mergeModule || typeof mergeModule.mergeModelLibrary !== 'function'
    || !viewModule || typeof viewModule.buildModelGrid !== 'function'
    || typeof viewModule.buildModelCard !== 'function'
    || typeof viewModule.buildHardwareSummaryLine !== 'function'
    || !operationsModule || typeof operationsModule.createOperationCoordinator !== 'function'
    || !formatUtils || typeof formatUtils.canonicalOllamaTag !== 'function'
    || !sceneUtils || typeof sceneUtils.renderStepModalHtml !== 'function') {
    throw new Error('scene-model-library: missing required dependency');
  }

  var canonicalOllamaTag = formatUtils.canonicalOllamaTag;
  var boundedErrorMessage = formatUtils.boundedErrorMessage;

  function objectOrEmpty(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function createScene(deps) {
    var d = deps || {};
    var setupState = d.state || {};
    var shellState = d.shellState || {};
    var windowRef = d.windowRef || root;
    var setupService = d.setupService || null;
    var persistPreferredModel = typeof d.persistPreferredModel === 'function'
      ? d.persistPreferredModel : function () { return Promise.resolve(null); };
    var markStep = typeof d.markStep === 'function'
      ? d.markStep : function () { return Promise.resolve(); };
    var closeModal = typeof d.closeModal === 'function' ? d.closeModal : function () {};
    var appendClientLog = typeof d.appendClientLog === 'function'
      ? d.appendClientLog : function () {};
    var showToastMessage = typeof d.showToastMessage === 'function'
      ? d.showToastMessage : function () {};
    var source = sourcesModule.createModelLibrarySource({
      windowRef: windowRef,
      appendClientLog: appendClientLog,
    });
    var pullController = null;
    var rootEl = null;
    var disposed = true;
    var sourceGeneration = 0;
    var merged = { hardware: {}, cards: [] };
    var statusMessage = 'Loading model library…';
    var cardMessages = Object.create(null);
    var activeOperationKey = '';
    var settlingKey = '';

    var operationCoordinator = operationsModule.createOperationCoordinator();

    function activeModel() {
      return String(shellState && shellState.status && shellState.status.model || '').trim();
    }

    function preferredLocalModel() {
      return String(shellState && shellState.offline && shellState.offline.preferredLocalModel
        || setupState.preferredLocalModel
        || setupState.preferredModelTag
        || setupState.raw && setupState.raw.preferred_local_model
        || '').trim();
    }

    function currentPulls() {
      return pullController ? pullController.getPulls() : {};
    }

    function isStale(sceneToken, operationToken) {
      return disposed || sceneToken !== sourceGeneration || !rootEl
        || (operationToken !== undefined && operationCoordinator.isStale(operationToken));
    }

    function findCard(keyOrTag) {
      var key = canonicalOllamaTag(keyOrTag);
      var cards = Array.isArray(merged.cards) ? merged.cards : [];
      return cards.find(function (card) { return card && card.key === key; }) || null;
    }

    function findCardElement(key) {
      if (!rootEl) return null;
      return Array.from(rootEl.querySelectorAll('[data-model-key]')).find(function (element) {
        return element.getAttribute('data-model-key') === key;
      }) || null;
    }

    function messageForCard(key) {
      var pull = currentPulls()[key];
      if (pull && (pull.status === 'error' || pull.cancelFailed === true)) {
        return pull.message || (pull.cancelFailed ? 'Could not cancel the pull.' : 'Pull failed.');
      }
      return cardMessages[key] || '';
    }

    function decorateCardMessage(element, key) {
      var message = messageForCard(key);
      if (!element || !message) return;
      var messageEl = element.ownerDocument.createElement('p');
      messageEl.className = 'setup-model-library-card-message';
      messageEl.setAttribute('role', 'alert');
      messageEl.textContent = message;
      element.appendChild(messageEl);
    }

    function removeBuiltInGridFurniture() {
      if (!rootEl) return;
      var summary = rootEl.querySelector('.model-library-view > .model-library-hardware-summary');
      var filters = rootEl.querySelector('.model-library-view > .model-library-filter-chips');
      if (summary) summary.remove();
      if (filters) filters.remove();
    }

    function render() {
      if (!rootEl || disposed) return;
      var bodyHtml = '<div class="setup-scene-body setup-model-library-body">'
        + '<div class="setup-model-library-summary">'
        + viewModule.buildHardwareSummaryLine(merged.hardware)
        + '</div>'
        + '<p class="setup-model-library-status" aria-live="polite">'
        + sceneUtils.escapeHtml(statusMessage)
        + '</p>'
        + viewModule.buildModelGrid(merged, {
          compact: true,
          actions: ACTIONS,
          pulls: currentPulls(),
        })
        + '</div>';
      rootEl.innerHTML = sceneUtils.renderStepModalHtml({
        id: 'model-library',
        title: sceneUtils.STEPS.localModel.title,
        eyebrow: sceneUtils.setupStepEyebrow('localModel'),
        summary: 'Choose an installed model or pull one from the local catalog.',
        bodyHtml: bodyHtml,
        actions: [
          { id: 'close', label: 'Back', variant: 'secondary' },
          { id: 'skip', label: 'Skip for now', variant: 'ghost' },
        ],
      });
      removeBuiltInGridFurniture();
      Object.keys(cardMessages).concat(Object.keys(currentPulls())).forEach(function (key) {
        decorateCardMessage(findCardElement(key), key);
      });
    }

    function replaceCard(key) {
      var card = findCard(key);
      var element = findCardElement(key);
      if (!card || !element || disposed) return false;
      var hardware = objectOrEmpty(merged.hardware);
      var pulls = currentPulls();
      element.outerHTML = viewModule.buildModelCard(Object.assign({}, card, {
        budgetMb: Number(hardware.budgetMb) || 0,
      }), {
        compact: true,
        actions: ACTIONS,
        pull: pulls[key] || {},
      });
      decorateCardMessage(findCardElement(key), key);
      return true;
    }

    function releaseOperation(operationToken) {
      activeOperationKey = '';
      settlingKey = '';
      operationCoordinator.release(operationToken);
    }

    async function completeSelection(tag, operationToken) {
      var key = canonicalOllamaTag(tag);
      if (!key || settlingKey === key) return;
      settlingKey = key;
      var sceneToken = sourceGeneration;
      try {
        var persistResult = await persistPreferredModel(tag);
        if (isStale(sceneToken, operationToken)) return;
        if (persistResult === null) {
          appendClientLog('WARN', 'setup.persist_preferred_model_unavailable', { tag: tag });
        }
        await markStep('localModel', 'done');
        if (isStale(sceneToken, operationToken)) return;
        closeModal();
      } catch (error) {
        if (isStale(sceneToken, operationToken)) return;
        cardMessages[key] = boundedErrorMessage(error, 'Could not save the model selection.');
        appendClientLog('WARN', 'setup.model_library_selection_failed', {
          tag: tag,
          message: cardMessages[key],
        });
        replaceCard(key);
        releaseOperation(operationToken);
      }
    }

    function handlePullChange(key) {
      if (disposed) return;
      var pull = currentPulls()[key];
      replaceCard(key);
      if (!pull || key !== activeOperationKey) return;
      if (pull.status === 'done') {
        void completeSelection(pull.tag, operationCoordinator.capture());
      } else if (pull.status === 'error') {
        releaseOperation(operationCoordinator.capture());
      }
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

    function handleUse(tag, button) {
      var card = findCard(tag);
      if (!card || card.installed !== true || card.engineVisible !== true) return;
      if (!operationCoordinator.acquire()) {
        showToastMessage('Finish or cancel the model operation first.');
        return;
      }
      activeOperationKey = card.key;
      if (button) button.disabled = true;
      void completeSelection(card.tag, operationCoordinator.capture());
    }

    function handlePull(tag) {
      var card = findCard(tag);
      if (!card || card.installed === true) return;
      if (!operationCoordinator.acquire()) {
        showToastMessage('Finish or cancel the model operation first.');
        return;
      }
      activeOperationKey = card.key;
      delete cardMessages[card.key];
      void ensurePullController().start(card.tag);
    }

    async function handleCancel(tag, button) {
      var key = canonicalOllamaTag(tag);
      if (!key || key !== activeOperationKey || !pullController) return;
      if (button) button.disabled = true;
      var operationToken = operationCoordinator.capture();
      var sceneToken = sourceGeneration;
      var result = await pullController.cancel(tag);
      if (isStale(sceneToken, operationToken)) return;
      if (result && result.cancelled === true) {
        releaseOperation(operationToken);
        replaceCard(key);
      }
    }

    async function handleSkip() {
      if (!operationCoordinator.acquire()) {
        // A pull or selection holds the operation lock; a silent no-op reads
        // as a dead button, so say why Skip is unavailable.
        showToastMessage('Finish or cancel the model operation first.');
        return;
      }
      var operationToken = operationCoordinator.capture();
      var sceneToken = sourceGeneration;
      try {
        await markStep('localModel', 'skipped');
        if (!isStale(sceneToken, operationToken)) closeModal();
      } catch (error) {
        if (!isStale(sceneToken, operationToken)) {
          appendClientLog('WARN', 'setup.model_library_skip_failed', {
            message: boundedErrorMessage(error, 'Could not skip the model step.'),
          });
          releaseOperation(operationToken);
        }
      }
    }

    function handleClick(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') return;
      var modelAction = target.closest('[data-model-card-action]');
      if (modelAction && rootEl && rootEl.contains(modelAction)) {
        var action = modelAction.getAttribute('data-model-card-action');
        var tag = modelAction.getAttribute('data-model-tag') || '';
        if (action === 'use') handleUse(tag, modelAction);
        else if (action === 'pull') handlePull(tag);
        else if (action === 'cancel') void handleCancel(tag, modelAction);
        return;
      }
      var footerAction = target.closest('[data-step-modal-action]');
      if (!footerAction || !rootEl || !rootEl.contains(footerAction)) return;
      var footerId = footerAction.getAttribute('data-step-modal-action');
      if (footerId === 'close') closeModal();
      else if (footerId === 'skip') void handleSkip();
    }

    function loadLibrary() {
      var sceneToken = sourceGeneration;
      return source.load().then(function (result) {
        if (isStale(sceneToken) || result.generation !== source.latestGeneration()) return null;
        merged = mergeModule.mergeModelLibrary({
          installed: result.installed,
          ollamaTags: result.ollamaTags,
          recommendations: result.recommendations,
          fitEstimates: result.fitEstimates,
          hardware: result.hardware,
          memory: result.memory,
          catalogMeta: result.catalogMeta,
          activeModel: activeModel(),
          preferredLocalModel: preferredLocalModel(),
        });
        var unavailable = Object.keys(result.unavailable || {}).map(function (key) {
          return result.unavailable[key];
        }).filter(Boolean);
        statusMessage = unavailable.join(' ');
        render();
        return result;
      }).catch(function (error) {
        if (isStale(sceneToken)) return null;
        statusMessage = boundedErrorMessage(error, 'Could not load the model library.');
        appendClientLog('WARN', 'setup.model_library_load_failed', { message: statusMessage });
        render();
        return null;
      });
    }

    return {
      mount: function mount(rootElement) {
        rootEl = rootElement;
        disposed = false;
        sourceGeneration += 1;
        operationCoordinator.mount();
        rootEl.addEventListener('click', handleClick);
        render();
        void loadLibrary();
      },
      dispose: function dispose() {
        if (disposed) return;
        disposed = true;
        sourceGeneration += 1;
        operationCoordinator.dispose();
        if (pullController) pullController.dispose();
        pullController = null;
        if (rootEl) rootEl.removeEventListener('click', handleClick);
        rootEl = null;
        cardMessages = Object.create(null);
        activeOperationKey = '';
        settlingKey = '';
      },
    };
  }

  return { createScene: createScene };
});
