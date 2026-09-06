/* Runtime activate/unload machinery for the Model Library card grid: single-flight
 * activation state, timeout-fenced models.load/unload, preferred-local persistence
 * after a confirmed load, and snapshot-before-list refresh ordering (the card's
 * active flag derives from state.status, which only a snapshot refresh updates). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../renderer-model-library-format-utils'));
    return;
  }
  root.modelLibraryRuntimeActions = factory(root.rendererModelLibraryFormatUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (formatUtils) {
  'use strict';

  if (!formatUtils || typeof formatUtils.canonicalOllamaTag !== 'function'
    || typeof formatUtils.boundedErrorMessage !== 'function') {
    throw new Error('model-library-runtime-actions: missing required dependency');
  }

  var canonicalOllamaTag = formatUtils.canonicalOllamaTag;
  var boundedErrorMessage = formatUtils.boundedErrorMessage;
  var MODEL_LOAD_TIMEOUT_MS = 120000;
  // Must stay ABOVE sidecar-request-timeouts.js 'models.unload' (35s), which is
  // itself above the sidecar's own 30s eviction timeout. Rejecting first would
  // report a bogus timeout for work that is still running and may still succeed.
  var MODEL_UNLOAD_TIMEOUT_MS = 40000;

  function createModelLibraryRuntimeActions(deps) {
    var d = deps || {};
    var windowRef = d.windowRef;
    var state = d.state || {};
    var findModel = d.findModel;
    var activeModel = d.activeModel;
    var refresh = d.refresh;
    var refreshModelPickers = d.refreshModelPickers;
    var render = d.render;
    var setStatusMessage = d.setStatusMessage;
    var showToastMessage = d.showToastMessage;
    var appendClientLog = d.appendClientLog;

    var disposed = false;
    var activation = { status: 'idle', key: '', message: '' };
    var runtimeOperationId = 0;
    var runtimeTimeoutId = null;

    function invokeRuntimeAction(workFactory, timeoutMs, timeoutMessage) {
      return new Promise(function (resolve, reject) {
        var timeoutId = windowRef.setTimeout(function () {
          if (runtimeTimeoutId === timeoutId) runtimeTimeoutId = null;
          reject(new Error(timeoutMessage));
        }, timeoutMs);
        runtimeTimeoutId = timeoutId;
        Promise.resolve().then(workFactory).then(function (result) {
          windowRef.clearTimeout(timeoutId);
          if (runtimeTimeoutId === timeoutId) runtimeTimeoutId = null;
          resolve(result);
        }, function (error) {
          windowRef.clearTimeout(timeoutId);
          if (runtimeTimeoutId === timeoutId) runtimeTimeoutId = null;
          reject(error);
        });
      });
    }

    // Snapshot refresh must land BEFORE the list refresh re-renders: a card's
    // active flag derives from state.status.model, which models.list cannot move.
    function resyncThen(operationId, statusMessage) {
      return Promise.resolve(refreshModelPickers()).catch(function () { return null; })
        .then(function () { return refresh(); })
        .then(function () {
          if (disposed || operationId !== runtimeOperationId) return;
          setStatusMessage(statusMessage);
        });
    }

    function failRuntimeAction(operationId, key, modelId, error, eventName, fallback) {
      if (disposed || operationId !== runtimeOperationId) return;
      var message = boundedErrorMessage(error, fallback);
      activation = { status: 'idle', key: key, message: message };
      setStatusMessage(message);
      appendClientLog('WARN', eventName, { model: modelId, message: message });
      render();
      void resyncThen(operationId, message).catch(function () {});
    }

    function updatePreferredLocalModel(modelId, operationId) {
      var update = windowRef.jennyShell?.offline?.updateSettings;
      return Promise.resolve().then(function () {
        if (typeof update !== 'function') throw new Error('Local preference controls are unavailable.');
        return update({ preferredLocalModel: modelId });
      }).then(function (payload) {
        if (disposed || operationId !== runtimeOperationId) return '';
        var selected = String(payload && payload.preferredLocalModel || '').trim();
        if (canonicalOllamaTag(selected) !== canonicalOllamaTag(modelId)) {
          throw new Error('The local model preference was not acknowledged.');
        }
        state.offline = Object.assign({}, state.offline || {}, payload);
        return '';
      }).catch(function (error) {
        if (disposed || operationId !== runtimeOperationId) return '';
        var message = boundedErrorMessage(error, 'Could not save the local model preference.');
        appendClientLog('WARN', 'model_library.preferred_local_update_failed', {
          model: modelId,
          message: message,
        });
        return 'Now chatting with "' + modelId
          + '", but the local preference could not be saved.';
      });
    }

    function handleUse(tag) {
      var modelId = String(tag || '').trim();
      if (!modelId) return;
      if (activation.status === 'running') {
        setStatusMessage('Still switching models.');
        return;
      }
      var load = windowRef.jennyShell?.models?.load;
      if (typeof load !== 'function') {
        setStatusMessage('Model lifecycle controls are unavailable right now.');
        return;
      }
      var model = findModel(modelId);
      var key = model ? model.key : canonicalOllamaTag(modelId);
      var operationId = ++runtimeOperationId;
      activation = { status: 'running', key: key, message: '' };
      var engineHint = model && model.selectedEngine === 'llama-server' ? 'openai-compatible'
        : model && model.selectedEngine === 'ollama' && model.engines && model.engines.ollama
          && model.engines.ollama.available === true ? 'ollama'
          : (model && model.engineType) || '';
      setStatusMessage(engineHint === 'openai-compatible'
        && model.selectedEngine === 'llama-server'
        ? 'Starting llama-server for "' + modelId + '"…'
        : 'Switching to "' + modelId + '"…');
      render();
      var payload = engineHint ? { model: model.tag, engine_type: engineHint } : modelId;
      invokeRuntimeAction(
        function () { return load(payload); },
        MODEL_LOAD_TIMEOUT_MS,
        'The load request timed out. Model state will be re-checked.'
      ).then(function () {
        if (disposed || operationId !== runtimeOperationId) return;
        activation = { status: 'idle', key: '', message: '' };
        return updatePreferredLocalModel(modelId, operationId).then(function (preferenceNote) {
          if (disposed || operationId !== runtimeOperationId) return;
          showToastMessage('Now chatting with "' + modelId + '"', { tone: 'success' });
          appendClientLog('INFO', 'models.loaded', { model: modelId });
          return resyncThen(
            operationId,
            preferenceNote || 'Now chatting with "' + modelId + '".'
          );
        });
      }, function (error) {
        failRuntimeAction(
          operationId,
          key,
          modelId,
          error,
          'model_library.activate_failed',
          'Could not load the model.'
        );
      });
    }

    function handleUnload(tag) {
      var modelId = String(tag || '').trim();
      if (!modelId) return;
      if (activation.status === 'running') {
        setStatusMessage('Still switching models.');
        return;
      }
      if (canonicalOllamaTag(activeModel()) !== canonicalOllamaTag(modelId)) {
        var staleOperationId = runtimeOperationId;
        setStatusMessage('The loaded model changed. Refreshing the model library.');
        void resyncThen(staleOperationId, 'The loaded model changed. Refreshed the model library.')
          .catch(function () {});
        return;
      }
      var unload = windowRef.jennyShell?.models?.unload;
      if (typeof unload !== 'function') {
        setStatusMessage('Model lifecycle controls are unavailable right now.');
        return;
      }
      var model = findModel(modelId);
      var key = model ? model.key : canonicalOllamaTag(modelId);
      var operationId = ++runtimeOperationId;
      activation = { status: 'running', key: key, message: '' };
      setStatusMessage('Unloading "' + modelId + '"…');
      render();
      invokeRuntimeAction(
        function () { return unload(); },
        MODEL_UNLOAD_TIMEOUT_MS,
        'The unload request timed out. Model state will be re-checked.'
      ).then(function () {
        if (disposed || operationId !== runtimeOperationId) return;
        activation = { status: 'idle', key: '', message: '' };
        showToastMessage('Unloaded "' + modelId + '"', { tone: 'success' });
        appendClientLog('INFO', 'models.unloaded', { model: modelId });
        return resyncThen(operationId, 'Unloaded "' + modelId + '".');
      }, function (error) {
        failRuntimeAction(
          operationId,
          key,
          modelId,
          error,
          'model_library.unload_failed',
          'Could not unload the model.'
        );
      });
    }

    function activationState() {
      return activation;
    }

    function clearActivationMessage() {
      if (activation.status === 'idle' && activation.message) {
        activation = { status: 'idle', key: '', message: '' };
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      runtimeOperationId += 1;
      if (runtimeTimeoutId != null) {
        windowRef.clearTimeout(runtimeTimeoutId);
        runtimeTimeoutId = null;
      }
    }

    return {
      handleUse: handleUse,
      handleUnload: handleUnload,
      activationState: activationState,
      clearActivationMessage: clearActivationMessage,
      dispose: dispose,
    };
  }

  return { createModelLibraryRuntimeActions: createModelLibraryRuntimeActions };
});
