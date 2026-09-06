/**
 * renderer/features/setup-scenes/scene-local-model.js
 *
 * Ollama model-pull scene with progress subscription and setup-step completion.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupSceneLocalModel = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var resolveDependency = sceneUtils && sceneUtils.resolveDependency;
  var escapeHtml = sceneUtils && sceneUtils.escapeHtml;
  var textField = resolveDependency
    ? resolveDependency('inventoryTextField', '../../inventory/text-field') : null;
  var actionButton = resolveDependency
    ? resolveDependency('inventoryActionButton', '../../inventory/action-button') : null;
  var progressBar = resolveDependency
    ? resolveDependency('inventoryProgressBar', '../../inventory/progress-bar') : null;
  var badge = resolveDependency
    ? resolveDependency('inventoryBadge', '../../inventory/badge') : null;

  var DEFAULT_MODEL_PLACEHOLDER = 'hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M';

  function buildBodyHtml(viewState) {
    var status = viewState.status || 'idle';
    var modelInputDisabled = status === 'running';
    var modelHtml = textField ? textField({
      id: 'setup-local-model-name',
      label: 'Model name',
      value: viewState.model || '',
      placeholder: DEFAULT_MODEL_PLACEHOLDER,
      disabled: modelInputDisabled,
      hint: 'Use any model tag your Ollama server can pull (e.g. hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M, batiai/gemma4-12b:q4).',
    }) : '<p>No inventory text field available.</p>';
    var actionsHtml = '';
    if (actionButton) {
      if (status === 'running') {
        actionsHtml = actionButton({
          id: 'cancelPull',
          label: viewState.cancelInFlight ? 'Cancelling…' : (viewState.cancelFailed ? 'Retry cancel' : 'Cancel pull'),
          variant: 'danger',
          disabled: viewState.cancelInFlight,
        });
      } else {
        actionsHtml = actionButton({
          id: 'startPull',
          label: status === 'failed' ? 'Try again' : 'Pull model',
          variant: 'primary',
          disabled: !viewState.model,
        });
      }
    }
    var progressHtml = '';
    if (status === 'running' && progressBar) {
      var percent = Number.isFinite(viewState.percent) ? viewState.percent : 0;
      progressHtml = '<div class="setup-scene-progress">'
        + progressBar({
            value: Math.max(0, Math.min(100, percent)),
            max: 100,
            label: 'Pulling model',
            displayText: viewState.summary || 'Starting…',
          })
        + '</div>';
    }
    var statusBadge = '';
    if (status === 'completed' && badge) {
      statusBadge = badge({ tone: 'success', text: 'Pull complete', size: 'sm' });
    } else if (status === 'failed' && badge) {
      statusBadge = badge({ tone: 'danger', text: 'Pull failed', size: 'sm' });
    } else if (status === 'cancelled' && badge) {
      statusBadge = badge({ tone: 'muted', text: 'Cancelled', size: 'sm' });
    }
    return ''
      + '<div class="setup-scene-body">'
      + modelHtml
      + '<div class="setup-scene-actions">' + actionsHtml + statusBadge + '</div>'
      + progressHtml
      + (viewState.summary && status !== 'running'
          ? '<p class="setup-scene-note">' + escapeHtml(viewState.summary) + '</p>'
          : '')
      + (viewState.cancelFailed
          ? '<p class="setup-scene-note" role="status">Cancel was not confirmed. The pull may still be running.</p>'
          : '')
      + '</div>';
  }

  function generateRequestId() {
    if (typeof globalThis !== 'undefined'
      && globalThis.crypto
      && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return 'pull_' + Date.now().toString(16) + '_' + Math.random().toString(16).slice(2, 10);
  }

  function createScene(deps) {
    var d = deps || {};
    var setupService = d.setupService;
    var setupState = d.state || {};
    var markStep = typeof d.markStep === 'function' ? d.markStep : function () { return Promise.resolve(); };
    var closeModal = typeof d.closeModal === 'function' ? d.closeModal : function () {};
    var showShellErrorToast = typeof d.showShellErrorToast === 'function' ? d.showShellErrorToast : function () {};
    var showToastMessage = typeof d.showToastMessage === 'function' ? d.showToastMessage : function () {};
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};

    var modalId = 'setup-local-model';
    var rootEl = null;
    var unbindClicks = null;
    var unsubscribePull = null;
    var disposed = false;
    var operationGeneration = 0;

    var readiness = setupState.readiness && setupState.readiness.localModel
      ? setupState.readiness.localModel
      : {};
    var detectedModel = setupState.steps && setupState.steps.localModel === 'done'
      || readiness.ready === true;
    var detectedCount = Number(readiness.modelCount || 0) || 0;
    var viewState = {
      model: '',
      status: detectedModel ? 'completed' : 'idle',  // idle | running | completed | failed | cancelled
      summary: detectedModel
        ? (detectedCount > 0
          ? detectedCount + ' installed local model' + (detectedCount === 1 ? ' was detected.' : 's were detected.')
          : 'An installed local model was detected.')
        : '',
      percent: detectedModel ? 100 : 0,
      requestId: '',
      cancelInFlight: false,
      cancelFailed: false,
    };

    function readModelInput() {
      if (!rootEl) return '';
      var input = rootEl.querySelector('#setup-local-model-name');
      return input ? String(input.value || '').trim() : viewState.model;
    }

    function handleModelInput(event) {
      if (!event || !event.target || event.target.id !== 'setup-local-model-name') return;
      viewState.model = String(event.target.value || '').trim();
      var startButton = rootEl && rootEl.querySelector('[data-action="startPull"]');
      if (startButton) startButton.disabled = !viewState.model;
    }

    function render() {
      if (!rootEl) return;
      var html = sceneUtils && sceneUtils.renderStepModalHtml ? sceneUtils.renderStepModalHtml({
        id: modalId,
        title: 'Pull a local model',
        eyebrow: sceneUtils.setupStepEyebrow('localModel'),
        summary: 'Stream a model to your local Ollama install.',
        bodyHtml: buildBodyHtml(viewState),
        actions: viewState.status === 'running' ? [] : [
          { id: 'close', label: viewState.status === 'completed' ? 'Done' : 'Close', variant: 'secondary' },
          { id: 'skip', label: 'Skip for now', variant: 'ghost' },
        ],
      }) : '';
      rootEl.innerHTML = html;
    }

    function updateProgressInPlace() {
      if (!rootEl) return;
      var bar = rootEl.querySelector('.inv-progress');
      if (!bar) return;
      bar.style.setProperty('--progress', viewState.percent + '%');
      bar.setAttribute('aria-valuenow', String(viewState.percent));
      var text = bar.querySelector('.inv-progress-text');
      if (text) text.textContent = viewState.summary || (viewState.percent + '%');
    }

    function applyPullPayload(payload) {
      if (!payload || payload.requestId !== viewState.requestId) return;
      var prevStatus = viewState.status;
      viewState.summary = payload.label || payload.summary || viewState.summary;
      // Real numeric percent now arrives from the bridge (parsed `ollama pull`).
      if (Number.isFinite(payload.percent)) {
        viewState.percent = payload.percent;
      }
      if (payload.status === 'completed') {
        viewState.status = 'completed';
        viewState.percent = 100;
      } else if (payload.status === 'failed') {
        viewState.status = 'failed';
        viewState.summary = payload.error || payload.label || payload.summary || 'Pull failed.';
      } else if (payload.status === 'cancelled') {
        viewState.status = 'cancelled';
      } else if (payload.status === 'running') {
        viewState.status = 'running';
      }
      if (viewState.status !== 'running') {
        viewState.cancelInFlight = false;
        viewState.cancelFailed = false;
      }
      if (prevStatus === 'running' && viewState.status === 'running') {
        updateProgressInPlace();
      } else {
        render();
      }
      if (viewState.status === 'completed' || viewState.status === 'failed' || viewState.status === 'cancelled') {
        teardownPullSubscription();
      }
      if (viewState.status === 'completed') {
        markStep('localModel', 'done').catch(function ignore() { /* toasted */ });
        showToastMessage('Model pull complete.');
      }
    }

    function teardownPullSubscription() {
      if (typeof unsubscribePull === 'function') {
        try { unsubscribePull(); } catch (_error) { /* ignore */ }
        unsubscribePull = null;
      }
    }

    async function handleStartPull() {
      var model = readModelInput();
      if (!model) {
        showShellErrorToast('Enter a model tag first.', { title: 'Setup Step' });
        return;
      }
      viewState.model = model;
      viewState.requestId = generateRequestId();
      viewState.status = 'running';
      viewState.cancelInFlight = false;
      viewState.cancelFailed = false;
      viewState.summary = 'Starting Ollama pull.';
      viewState.percent = 5;
      operationGeneration += 1;
      var startGeneration = operationGeneration;
      render();
      teardownPullSubscription();
      unsubscribePull = setupService.subscribePullProgress(applyPullPayload);
      try {
        var result = await setupService.startOllamaPull({ model: model, requestId: viewState.requestId });
        if (disposed || operationGeneration !== startGeneration) return;
        if (result && result.requestId) {
          viewState.requestId = result.requestId;
        }
      } catch (error) {
        if (disposed || operationGeneration !== startGeneration) return;
        viewState.status = 'failed';
        viewState.summary = error && error.message ? error.message : String(error);
        teardownPullSubscription();
        appendClientLog('WARN', 'setup.local_model_pull_start_failed', {
          message: viewState.summary,
        });
        render();
      }
    }

    async function handleCancelPull() {
      if (viewState.status !== 'running') {
        return true;
      }
      if (viewState.cancelInFlight) {
        return false;
      }
      viewState.cancelInFlight = true;
      viewState.cancelFailed = false;
      render();
      var cancelGeneration = operationGeneration;
      var result = { cancelled: false };
      try {
        result = await setupService.cancelOllamaPull({
          requestId: viewState.requestId,
          model: viewState.model,
        });
      } catch (_error) { /* swallow — service logs */ }
      if (disposed || operationGeneration !== cancelGeneration || viewState.status !== 'running') return false;
      viewState.cancelInFlight = false;
      if (!result || result.cancelled !== true) {
        viewState.cancelFailed = true;
        viewState.summary = 'Jenny could not confirm cancellation. Progress updates will continue.';
        render();
        return false;
      }
      viewState.status = 'cancelled';
      viewState.summary = result.summary || 'Ollama pull cancelled.';
      teardownPullSubscription();
      render();
      return true;
    }

    async function handleSkip() {
      if (viewState.status === 'running' && !await handleCancelPull()) return;
      teardownPullSubscription();
      try {
        await markStep('localModel', 'skipped');
      } catch (_error) { /* toasted */ }
      closeModal();
    }

    async function handleClose() {
      if (viewState.status === 'running' && !await handleCancelPull()) return;
      teardownPullSubscription();
      closeModal();
    }

    return {
      mount: function mount(rootElement) {
        disposed = false;
        rootEl = rootElement;
        render();
        rootEl.addEventListener('input', handleModelInput);
        unbindClicks = sceneUtils && sceneUtils.bindActionDelegation
          ? sceneUtils.bindActionDelegation(rootEl, {
              startPull: handleStartPull,
              cancelPull: handleCancelPull,
              close: handleClose,
              skip: handleSkip,
              __onError: function onError(error) {
                appendClientLog('WARN', 'setup.local_model_action_failed', {
                  message: error && error.message ? error.message : String(error),
                });
              },
            })
          : null;
      },
      dispose: function dispose() {
        disposed = true;
        operationGeneration += 1;
        teardownPullSubscription();
        if (rootEl) rootEl.removeEventListener('input', handleModelInput);
        if (typeof unbindClicks === 'function') {
          unbindClicks();
          unbindClicks = null;
        }
        rootEl = null;
      },
    };
  }

  return { createScene: createScene };
});
