/* Runtime activate/unload machinery for the Model Library card grid: single-flight
 * activation state, timeout-fenced models.load/unload, preferred-local persistence
 * after a confirmed load, and snapshot-before-list refresh ordering (the card's
 * active flag derives from state.status, which only a snapshot refresh updates).
 * Also the recovery clicks for the library's classified model-load failure. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../renderer-model-library-format-utils'), require('../../shared/model-load-failure'));
    return;
  }
  root.modelLibraryRuntimeActions = factory(root.rendererModelLibraryFormatUtils, root.jennyModelLoadFailure);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (formatUtils, defaultReader) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  if (!formatUtils || typeof formatUtils.canonicalOllamaTag !== 'function'
    || typeof formatUtils.boundedErrorMessage !== 'function'
    || typeof formatUtils.llamaServerFailureText !== 'function') {
    throw new Error('model-library-runtime-actions: missing required dependency');
  }

  var canonicalOllamaTag = formatUtils.canonicalOllamaTag;
  var boundedErrorMessage = formatUtils.boundedErrorMessage;
  var llamaServerFailureText = formatUtils.llamaServerFailureText;
  // MODEL_*_TIMEOUT_MS are SOFT thresholds: they only show "Still switching
  // models."; the controls stay locked and the wrapper keeps waiting, because the
  // models.load / models.unload IPC call cannot be cancelled and a conflicting
  // action would race it. (The name is kept: sidecar-timeout-hierarchy.test.js
  // reads MODEL_UNLOAD_TIMEOUT_MS.)
  var MODEL_LOAD_TIMEOUT_MS = 120000;
  // Must stay ABOVE sidecar-request-timeouts.js 'models.unload' (35s), which is
  // itself above the sidecar's own 30s eviction timeout. Noticing first would
  // report a stall for work that is still running and may still succeed.
  var MODEL_UNLOAD_TIMEOUT_MS = 40000;
  // Hard backstops: the UI never stays locked forever if the IPC call never settles.
  var MODEL_LOAD_HARD_TIMEOUT_MS = 1200000;
  var MODEL_UNLOAD_HARD_TIMEOUT_MS = 120000;

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
    var runtimeSoftTimeoutId = null;
    var runtimeHardTimeoutId = null;
    // Row 142: "Use build N" under a failed llama-server Use. The shared module loads with the
    // Settings scripts, so it is made on the first failure that needs it; until then nothing shows.
    var remedies = null;
    var failedTag = '';

    function resolveBuilds() {
      return globalThis.modelLibraryRuntimeBuilds
        || (typeof require === 'function' ? require('./model-library-runtime-builds') : null);
    }

    function remediesFor() {
      var builds = remedies || disposed ? null : resolveBuilds();
      if (builds && typeof builds.createRemedies === 'function') {
        remedies = builds.createRemedies({
          windowRef: windowRef,
          scope: 'row',
          allowDownload: true,
          onChange: function () { if (!disposed) render(); },
          onSwitched: function (tag, build) { handleUse(tag, { note: builds.rowStartingText(build) }); },
          onSettings: function (localEngines) { if (localEngines) state.localEngines = localEngines; },
          noneText: function (base) { return base + ' ' + builds.noOtherBuildRowText(); },
        });
        // The row buttons are re-rendered with the grid, so one document-level click reaches them.
        if (windowRef.document && typeof windowRef.document.addEventListener === 'function') {
          windowRef.document.addEventListener('click', onRemedyClick);
        }
      }
      return remedies;
    }

    function onRemedyClick(event) {
      if (remedies && event) remedies.handleClick(event.target);
    }

    function clearRemedies() {
      if (remedies) remedies.clear();
      failedTag = '';
    }

    function clearRuntimeTimers() {
      if (runtimeSoftTimeoutId != null) {
        windowRef.clearTimeout(runtimeSoftTimeoutId);
        runtimeSoftTimeoutId = null;
      }
      if (runtimeHardTimeoutId != null) {
        windowRef.clearTimeout(runtimeHardTimeoutId);
        runtimeHardTimeoutId = null;
      }
    }

    function invokeRuntimeAction(operationId, workFactory, softMs, hardMs, timeoutMessage) {
      return new Promise(function (resolve, reject) {
        var softId = windowRef.setTimeout(function () {
          if (runtimeSoftTimeoutId === softId) runtimeSoftTimeoutId = null;
          if (disposed || operationId !== runtimeOperationId) return;
          setStatusMessage(jt('models.library.runtime.stillSwitching', 'Still switching models.'));
        }, softMs);
        var hardId = windowRef.setTimeout(function () {
          if (runtimeHardTimeoutId === hardId) runtimeHardTimeoutId = null;
          reject(new Error(timeoutMessage));
        }, hardMs);
        runtimeSoftTimeoutId = softId;
        runtimeHardTimeoutId = hardId;
        function settle() {
          windowRef.clearTimeout(softId);
          windowRef.clearTimeout(hardId);
          if (runtimeSoftTimeoutId === softId) runtimeSoftTimeoutId = null;
          if (runtimeHardTimeoutId === hardId) runtimeHardTimeoutId = null;
        }
        Promise.resolve().then(workFactory).then(function (result) {
          settle();
          resolve(result);
        }, function (error) {
          settle();
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
      // A managed llama-server launch code names its own fix (read raw, before bounding).
      var message = llamaServerFailureText(error && error.message ? error.message : error, modelId)
        || boundedErrorMessage(error, fallback);
      activation = { status: 'idle', key: key, message: message };
      setStatusMessage(message);
      appendClientLog('WARN', eventName, { model: modelId, message: message });
      render();
      var buildFailure = formatUtils.isBuildFailure && formatUtils.isBuildFailure(error && error.message ? error.message : error);
      var failedModel = eventName === 'model_library.activate_failed' && buildFailure ? findModel(modelId) : null;
      var asker = failedModel && failedModel.selectedEngine === 'llama-server' ? remediesFor() : null;
      if (asker) {
        failedTag = modelId;
        void asker.begin(modelId, message);
      }
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
        var message = boundedErrorMessage(error, jt('models.library.runtime.preferenceSaveFailed', 'Could not save the local model preference.'));
        appendClientLog('WARN', 'model_library.preferred_local_update_failed', {
          model: modelId,
          message: message,
        });
        return jt('models.library.runtime.nowChattingPreferenceSaveFailed', 'Now chatting with "{model}", but the local preference could not be saved.', { model: modelId });
      });
    }

    function handleUse(tag, useOptions) {
      var modelId = String(tag || '').trim();
      if (!modelId) return;
      if (activation.status === 'running') {
        setStatusMessage(jt('models.library.runtime.stillSwitching', 'Still switching models.'));
        return;
      }
      var load = windowRef.jennyShell?.models?.load;
      if (typeof load !== 'function') {
        setStatusMessage(jt('models.library.runtime.controlsUnavailable', 'Model lifecycle controls are unavailable right now.'));
        return;
      }
      var model = findModel(modelId);
      var key = model ? model.key : canonicalOllamaTag(modelId);
      var operationId = ++runtimeOperationId;
      clearRemedies();
      activation = { status: 'running', key: key, message: '' };
      if (useOptions && useOptions.note) activation.pendingNote = String(useOptions.note);
      var engineHint = model && model.selectedEngine === 'llama-server' ? 'openai-compatible'
        : model && model.selectedEngine === 'ollama' && model.engines && model.engines.ollama
          && model.engines.ollama.available === true ? 'ollama'
          : (model && model.engineType) || '';
      setStatusMessage(engineHint === 'openai-compatible'
        && model.selectedEngine === 'llama-server'
        ? jt('models.library.runtime.startingLlamaServerFor', 'Starting llama-server for "{model}"…', { model: modelId })
        : model && model.selectedEngine === 'ninfer'
          // C7 (row 54): the switch stops the other managed server first.
          ? jt('models.library.runtime.switchingToNinfer', 'Switching to {model} on NInfer… llama-server stops first so the GPU is free.', { model: String(model.displayName || modelId) })
          : jt('models.library.runtime.switchingTo', 'Switching to "{model}"…', { model: modelId }));
      render();
      var payload = engineHint ? { model: model.tag, engine_type: engineHint } : modelId;
      invokeRuntimeAction(
        operationId,
        function () { return load(payload); },
        MODEL_LOAD_TIMEOUT_MS,
        MODEL_LOAD_HARD_TIMEOUT_MS,
        jt('models.library.runtime.loadTimedOut', 'The load request timed out. Model state will be re-checked.')
      ).then(function () {
        if (disposed || operationId !== runtimeOperationId) return;
        activation = { status: 'idle', key: '', message: '' };
        return updatePreferredLocalModel(modelId, operationId).then(function (preferenceNote) {
          if (disposed || operationId !== runtimeOperationId) return;
          showToastMessage(jt('models.library.runtime.nowChattingWith', 'Now chatting with "{model}"', { model: modelId }), { tone: 'success' });
          appendClientLog('INFO', 'models.loaded', { model: modelId });
          return resyncThen(
            operationId,
            preferenceNote || jt('models.library.runtime.nowChattingWithPeriod', 'Now chatting with "{model}".', { model: modelId })
          );
        });
      }, function (error) {
        failRuntimeAction(
          operationId,
          key,
          modelId,
          error,
          'model_library.activate_failed',
          jt('models.library.runtime.loadFailed', 'Could not load the model.')
        );
      });
    }

    function handleUnload(tag) {
      var modelId = String(tag || '').trim();
      if (!modelId) return;
      if (activation.status === 'running') {
        setStatusMessage(jt('models.library.runtime.stillSwitching', 'Still switching models.'));
        return;
      }
      if (canonicalOllamaTag(activeModel()) !== canonicalOllamaTag(modelId)) {
        var staleOperationId = runtimeOperationId;
        setStatusMessage(jt('models.library.runtime.loadedModelChangedRefreshing', 'The loaded model changed. Refreshing the model library.'));
        void resyncThen(staleOperationId, jt('models.library.runtime.loadedModelChangedRefreshed', 'The loaded model changed. Refreshed the model library.'))
          .catch(function () {});
        return;
      }
      var unload = windowRef.jennyShell?.models?.unload;
      if (typeof unload !== 'function') {
        setStatusMessage(jt('models.library.runtime.controlsUnavailable', 'Model lifecycle controls are unavailable right now.'));
        return;
      }
      var model = findModel(modelId);
      var key = model ? model.key : canonicalOllamaTag(modelId);
      var operationId = ++runtimeOperationId;
      activation = { status: 'running', key: key, message: '' };
      setStatusMessage('Unloading "' + modelId + '"…');
      render();
      invokeRuntimeAction(
        operationId,
        function () { return unload(); },
        MODEL_UNLOAD_TIMEOUT_MS,
        MODEL_UNLOAD_HARD_TIMEOUT_MS,
        jt('models.library.runtime.unloadTimedOut', 'The unload request timed out. Model state will be re-checked.')
      ).then(function () {
        if (disposed || operationId !== runtimeOperationId) return;
        activation = { status: 'idle', key: '', message: '' };
        showToastMessage(jt('models.library.runtime.unloaded', 'Unloaded "{model}"', { model: modelId }), { tone: 'success' });
        appendClientLog('INFO', 'models.unloaded', { model: modelId });
        return resyncThen(operationId, 'Unloaded "' + modelId + '".');
      }, function (error) {
        failRuntimeAction(
          operationId,
          key,
          modelId,
          error,
          'model_library.unload_failed',
          jt('models.library.runtime.unloadFailed', 'Could not unload the model.')
        );
      });
    }

    function activationState() {
      var shown = failedTag && activation.status === 'idle' ? remedies.view(failedTag, activation.message) : null;
      return shown ? Object.assign({}, activation, { message: shown.text, actionsHtml: shown.actionsHtml }) : activation;
    }

    function clearActivationMessage() {
      if (activation.status === 'idle' && activation.message) {
        activation = { status: 'idle', key: '', message: '' };
        clearRemedies();
      }
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      runtimeOperationId += 1;
      clearRuntimeTimers();
      if (remedies) {
        if (windowRef.document && typeof windowRef.document.removeEventListener === 'function') {
          windowRef.document.removeEventListener('click', onRemedyClick);
        }
        remedies.dispose();
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

  // ---- Recovery clicks for the library's classified model-load failure ----
  function tuningWording(result) {
    var utils = globalThis.rendererModelTuningEngineUtils
      || (typeof require === 'function' ? require('../renderer-model-tuning-engine-utils') : null);
    return typeof utils?.applyStatusMessage === 'function' ? utils.applyStatusMessage(result) : '';
  }

  function createModelLibraryRecoveryActions(deps) {
    var d = deps || {};
    var reader = d.reader || defaultReader;
    var inFlight = false;

    function controlsUnavailable() {
      d.setStatusMessage(jt('models.library.runtime.controlsUnavailable', 'Model lifecycle controls are unavailable right now.'));
    }

    async function handle(action, tag) {
      var failure = reader.readModelLoadFailure(d.state.backend);
      if (!failure || formatUtils.canonicalOllamaTag(failure.model) !== formatUtils.canonicalOllamaTag(tag)) return;
      switch (action) {
        case 'retry': return d.runtimeActions.handleUse(tag);
        case 'showFits': return d.showCatalog();
        case 'diagnostics': return d.openDiagnostics?.();
        case 'loadSmaller': {
          var tuning = d.windowRef.jennyShell?.modelTuning;
          if (typeof tuning?.update !== 'function') return controlsUnavailable();
          if (inFlight) return;
          inFlight = true;
          try {
            var result = await tuning.update({ modelId: tag, contextLength: reader.retryContext(failure) });
            // A refused or rolled-back change reads as the Tune drawer would say it.
            if (result?.status !== 'applied') return d.setStatusMessage(tuningWording(result) || jt('models.library.tuning.notApplied', 'Not applied: {reason}.', { reason: String(result?.reason || 'validation failed').replaceAll('_', ' ') }));
            return d.runtimeActions.handleUse(tag);
          } catch (error) {
            return d.setStatusMessage(formatUtils.boundedErrorMessage(error, jt('models.library.runtime.controlsUnavailable', 'Model lifecycle controls are unavailable right now.')));
          } finally { inFlight = false; }
        }
        case 'copyDetails': {
          var clipboard = d.windowRef.navigator?.clipboard;
          if (typeof clipboard?.writeText !== 'function') {
            d.setStatusMessage(jt('settings.modelLibrary.clipboardUnavailable', 'Clipboard access is unavailable right now.'));
            return;
          }
          try {
            await clipboard.writeText(reader.failureDetails(failure));
            d.setStatusMessage('Copied ' + tag);
          } catch (_error) {
            d.setStatusMessage(jt('settings.modelLibrary.copyFailed', 'Could not copy {tag} to the clipboard.', { tag: tag }));
          }
          return;
        }
        default: return;
      }
    }
    return { handle: handle };
  }
  return { createModelLibraryRuntimeActions: createModelLibraryRuntimeActions, createModelLibraryRecoveryActions: createModelLibraryRecoveryActions };
});
