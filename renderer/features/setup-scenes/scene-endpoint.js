/**
 * renderer/features/setup-scenes/scene-endpoint.js
 *
 * Local endpoint validation scene: select a local engine and URL, validate it,
 * and mark the step complete on success.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererSetupSceneEndpoint = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var sceneUtils = (root && root.rendererSetupSceneUtils)
    || (typeof require === 'function' ? require('./scene-utils') : null);
  var resolveDependency = sceneUtils && sceneUtils.resolveDependency;
  var escapeHtml = sceneUtils && sceneUtils.escapeHtml;
  var urlField = resolveDependency
    ? resolveDependency('inventoryUrlField', '../../inventory/url-field') : null;
  var selectField = resolveDependency
    ? resolveDependency('inventorySelectField', '../../inventory/select-field') : null;
  var actionButton = resolveDependency
    ? resolveDependency('inventoryActionButton', '../../inventory/action-button') : null;
  var badge = resolveDependency
    ? resolveDependency('inventoryBadge', '../../inventory/badge') : null;
  var spinner = resolveDependency
    ? resolveDependency('inventorySpinner', '../../inventory/spinner') : null;
  var ENGINE_OPTIONS = [
    { value: 'ollama', label: 'Ollama (http://127.0.0.1:11434)' },
    { value: 'vllm', label: 'vLLM (http://127.0.0.1:8000/v1)' },
    { value: 'openai-compatible', label: 'OpenAI-compatible local server' },
  ];

  var ENGINE_DEFAULT_URLS = {
    ollama: 'http://127.0.0.1:11434',
    vllm: 'http://127.0.0.1:8000/v1',
    'openai-compatible': 'http://127.0.0.1:8033/v1',
  };

  function buildBodyHtml(viewState) {
    var disabled = viewState.validating === true;
    var engineHtml = selectField ? selectField({
      id: 'setup-endpoint-engine',
      label: 'Engine type',
      value: viewState.engineType,
      options: ENGINE_OPTIONS,
      disabled: disabled,
      hint: 'Local-only options. Public/cloud URLs are rejected by setup validation.',
    }) : '';
    var urlHtml = urlField ? urlField({
      id: 'setup-endpoint-url',
      label: 'API URL',
      value: viewState.apiUrl,
      placeholder: ENGINE_DEFAULT_URLS[viewState.engineType] || ENGINE_DEFAULT_URLS.ollama,
      disabled: disabled,
      hint: 'Use a localhost or private-network URL. http(s):// only.',
    }) : '';
    var actionsHtml = '';
    if (actionButton) {
      actionsHtml = actionButton({
            id: 'validate',
            label: viewState.validating ? 'Validating…' : 'Validate',
            variant: 'primary',
            disabled: disabled || !viewState.apiUrl,
          })
          + actionButton({
            id: 'save',
            label: 'Save endpoint',
            variant: 'secondary',
            disabled: !viewState.lastResultOk,
          });
    }
    var resultHtml = '';
    if (viewState.validating && spinner) {
      resultHtml = '<div class="setup-scene-result">' + spinner({ label: 'Checking endpoint…' }) + '</div>';
    } else if (viewState.lastResult && badge) {
      var tone = viewState.lastResultOk ? 'success' : 'danger';
      var label = viewState.lastResultOk
        ? 'Endpoint reachable'
        : (viewState.lastResult.code || 'Endpoint check failed');
      resultHtml = '<div class="setup-scene-result">'
        + badge({ tone: tone, text: label, size: 'sm' })
        + '<p class="setup-scene-note">' + escapeHtml(viewState.lastResult.message || '') + '</p>'
        + '</div>';
    }
    return ''
      + '<div class="setup-scene-body">'
      + engineHtml
      + urlHtml
      + '<div class="setup-scene-actions">' + actionsHtml + '</div>'
      + resultHtml
      + '</div>';
  }

  function createScene(deps) {
    var d = deps || {};
    var setupService = d.setupService;
    var setupState = d.state || {};
    var markStep = typeof d.markStep === 'function' ? d.markStep : function () { return Promise.resolve(); };
    var applySnapshot = typeof d.applySnapshot === 'function' ? d.applySnapshot : function () {};
    var closeModal = typeof d.closeModal === 'function' ? d.closeModal : function () {};
    var showShellErrorToast = typeof d.showShellErrorToast === 'function' ? d.showShellErrorToast : function () {};
    var showToastMessage = typeof d.showToastMessage === 'function' ? d.showToastMessage : function () {};
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function () {};

    var modalId = 'setup-endpoint';
    var rootEl = null;
    var unbindClicks = null;
    var unbindInputs = null;
    var disposed = false;
    var generation = 0;
    var readiness = setupState.readiness && setupState.readiness.endpoint
      ? setupState.readiness.endpoint
      : {};
    var detectedEndpoint = readiness.ready === true;
    var detectedEngine = ENGINE_DEFAULT_URLS[readiness.engineType] ? readiness.engineType : 'ollama';
    var viewState = {
      engineType: detectedEngine,
      apiUrl: ENGINE_DEFAULT_URLS[detectedEngine],
      validating: false,
      lastResult: detectedEndpoint
        ? {
            ok: true,
            code: 'detected',
            message: 'A local endpoint was already detected through Jenny readiness.',
          }
        : null,
      lastResultOk: detectedEndpoint,
    };

    function readInputs() {
      if (!rootEl) return;
      var engineEl = rootEl.querySelector('#setup-endpoint-engine');
      var urlEl = rootEl.querySelector('#setup-endpoint-url');
      if (engineEl) viewState.engineType = String(engineEl.value || viewState.engineType);
      if (urlEl) viewState.apiUrl = String(urlEl.value || viewState.apiUrl);
    }

    function render() {
      if (!rootEl) return;
      var html = sceneUtils && sceneUtils.renderStepModalHtml ? sceneUtils.renderStepModalHtml({
        id: modalId,
        title: 'Validate your endpoint',
        eyebrow: sceneUtils.setupStepEyebrow('endpoint'),
        summary: 'Reach a local-only Ollama, vLLM, or OpenAI-compatible server.',
        bodyHtml: buildBodyHtml(viewState),
        actions: [
          { id: 'cancel', label: 'Cancel', variant: 'secondary' },
          { id: 'skip', label: 'Skip for now', variant: 'ghost' },
        ],
      }) : '';
      rootEl.innerHTML = html;
      if (typeof unbindInputs === 'function') {
        unbindInputs();
        unbindInputs = null;
      }
      var engineEl = rootEl.querySelector('#setup-endpoint-engine');
      var urlEl = rootEl.querySelector('#setup-endpoint-url');
      var onEngineChange = null;
      var onUrlInput = null;
      if (engineEl && typeof engineEl.addEventListener === 'function') {
        onEngineChange = function onEngineChange(evt) {
          var nextEngine = String(evt.target.value || '').trim();
          var isKnownLocal = !!ENGINE_DEFAULT_URLS[nextEngine];
          if (!isKnownLocal) return;
          viewState.engineType = nextEngine;
          viewState.apiUrl = ENGINE_DEFAULT_URLS[nextEngine] || '';
          viewState.lastResult = null;
          viewState.lastResultOk = false;
          render();
        };
        engineEl.addEventListener('change', onEngineChange);
      }
      if (urlEl && typeof urlEl.addEventListener === 'function') {
        onUrlInput = function onUrlInput(evt) {
          viewState.apiUrl = String(evt.target.value || '');
          if (!viewState.lastResult && !viewState.lastResultOk) return;
          viewState.lastResult = null;
          viewState.lastResultOk = false;
          var saveButton = rootEl && rootEl.querySelector('[data-action="save"]');
          var resultEl = rootEl && rootEl.querySelector('.setup-scene-result');
          if (saveButton) saveButton.disabled = true;
          if (resultEl) resultEl.hidden = true;
        };
        urlEl.addEventListener('input', onUrlInput);
      }
      unbindInputs = function unbind() {
        if (onEngineChange) engineEl.removeEventListener('change', onEngineChange);
        if (onUrlInput) urlEl.removeEventListener('input', onUrlInput);
      };
    }

    async function handleValidate() {
      readInputs();
      if (!viewState.apiUrl) {
        showShellErrorToast('Enter a URL first.', { title: 'Setup Step' });
        return;
      }
      viewState.validating = true;
      viewState.lastResult = null;
      viewState.lastResultOk = false;
      render();
      var operationGeneration = ++generation;
      try {
        var result = await setupService.validateEndpoint({
          engineType: viewState.engineType,
          apiUrl: viewState.apiUrl,
        });
        if (disposed || operationGeneration !== generation) return;
        viewState.validating = false;
        viewState.lastResult = result;
        viewState.lastResultOk = result && result.ok === true;
        render();
      } catch (error) {
        if (disposed || operationGeneration !== generation) return;
        viewState.validating = false;
        viewState.lastResult = {
          ok: false,
          message: error && error.message ? error.message : String(error),
        };
        viewState.lastResultOk = false;
        appendClientLog('WARN', 'setup.endpoint_validate_failed', {
          message: viewState.lastResult.message,
        });
        render();
      }
    }

    async function handleSave() {
      if (!viewState.lastResultOk) return;
      readInputs();
      viewState.validating = true;
      render();
      var operationGeneration = ++generation;
      try {
        var saved = await setupService.saveEndpoint({
          engineType: viewState.engineType,
          apiUrl: viewState.apiUrl,
        });
        if (disposed || operationGeneration !== generation) return;
        viewState.validating = false;
        viewState.lastResult = saved && saved.result;
        viewState.lastResultOk = !!(saved && saved.result && saved.result.ok);
        if (!viewState.lastResultOk) {
          render();
          showShellErrorToast(
            (viewState.lastResult && viewState.lastResult.message) || 'Could not save endpoint.',
            { title: 'Setup Step Failed' }
          );
          return;
        }
        if (saved.snapshot) applySnapshot(saved.snapshot);
        showToastMessage('Endpoint saved.');
        closeModal();
      } catch (error) {
        if (disposed || operationGeneration !== generation) return;
        viewState.validating = false;
        render();
        appendClientLog('WARN', 'setup.endpoint_save_failed', {
          message: error && error.message ? error.message : String(error),
        });
        showShellErrorToast('Could not save endpoint.', { title: 'Setup Step Failed' });
      }
    }

    async function handleSkip() {
      var operationGeneration = ++generation;
      try {
        await markStep('endpoint', 'skipped');
        if (disposed || operationGeneration !== generation) return;
        closeModal();
      } catch (_error) { /* toasted */ }
    }

    return {
      mount: function mount(rootElement) {
        disposed = false;
        rootEl = rootElement;
        render();
        unbindClicks = sceneUtils && sceneUtils.bindActionDelegation
          ? sceneUtils.bindActionDelegation(rootEl, {
              cancel: closeModal,
              validate: handleValidate,
              save: handleSave,
              skip: handleSkip,
              __onError: function onError(error) {
                appendClientLog('WARN', 'setup.endpoint_action_failed', {
                  message: error && error.message ? error.message : String(error),
                });
              },
            })
          : null;
      },
      dispose: function dispose() {
        disposed = true;
        generation += 1;
        if (typeof unbindClicks === 'function') {
          unbindClicks();
          unbindClicks = null;
        }
        if (typeof unbindInputs === 'function') {
          unbindInputs();
          unbindInputs = null;
        }
        rootEl = null;
      },
    };
  }

  return { createScene: createScene };
});
