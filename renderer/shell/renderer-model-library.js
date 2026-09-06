/* Model Library owns installed local-model lifecycle, tuning, and the local
 * inference role. Pulls use setup-service plumbing and never `models.load`. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererModelLibrary = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var GROUP_ID = 'modelLibraryGroup';
  var MODEL_LOAD_TIMEOUT_MS = 120000;
  // Must stay ABOVE sidecar-request-timeouts.js 'models.unload' (35s), which is
  // itself above the sidecar's own 30s eviction timeout. Rejecting first would
  // report a bogus timeout for work that is still running and may still succeed.
  var MODEL_UNLOAD_TIMEOUT_MS = 40000;
  // Card-scoped because nav items carry the same data-settings-section
  // attribute and precede cards in the DOM.
  var MODELS_SECTION_SELECTOR = '.settings-card[data-settings-section="models"]';

  function resolveStringUtils() {
    return (root && root.stringUtils)
      || (typeof require === 'function' ? require('../shared/string-utils') : null)
      || {};
  }

  function resolveSetupServiceFactory() {
    return (root && root.rendererSetupService)
      || (typeof require === 'function' ? require('../services/renderer-setup-service') : null)
      || null;
  }

  function resolveActionButton() {
    return (root && root.inventoryActionButton)
      || (typeof require === 'function' ? require('../inventory/action-button') : null)
      || null;
  }

  function resolveTextField() {
    return (root && root.inventoryTextField)
      || (typeof require === 'function' ? require('../inventory/text-field') : null)
      || null;
  }

  function resolveSelectField() {
    return (root && root.inventorySelectField)
      || (typeof require === 'function' ? require('../inventory/select-field') : null)
      || null;
  }

  var escapeHtml = resolveStringUtils().escapeHtml || function fallbackEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  // Pure formatters live in a sibling module; this file sits at the size cap.
  var formatUtils = (root && root.rendererModelLibraryFormatUtils)
    || (typeof require === 'function' ? require('./renderer-model-library-format-utils') : {});
  var formatHumanSize = formatUtils.formatHumanSize;
  var formatBytesShort = formatUtils.formatBytesShort;
  var canonicalOllamaTag = formatUtils.canonicalOllamaTag;
  var boundedErrorMessage = formatUtils.boundedErrorMessage;

  function resolveTimeoutValue(modelTuning, modelId) {
    var byModel = modelTuning && modelTuning.streamInactivitySecondsByModel;
    if (!byModel || typeof byModel !== 'object' || Array.isArray(byModel)) return null;
    if (Object.prototype.hasOwnProperty.call(byModel, modelId)) return byModel[modelId];
    var canonicalModelId = canonicalOllamaTag(modelId);
    var alias = Object.keys(byModel).find(function (candidate) {
      return canonicalOllamaTag(candidate) === canonicalModelId;
    });
    return alias ? byModel[alias] : null;
  }

  function normalizeModelEntries(modelList) {
    var data = modelList && Array.isArray(modelList.data) ? modelList.data : [];
    return data
      .map(function (entry) {
        if (!entry) {
          return null;
        }
        var id = String((typeof entry === 'string' ? entry : entry.id) || '').trim();
        if (!id) {
          return null;
        }
        var sizeBytes = typeof entry === 'object' ? Number(entry.size) : NaN;
        return {
          id: id,
          sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
          engineType: typeof entry === 'object'
            ? String(entry.engine_type || entry.engineType || '').trim().toLowerCase()
            : '',
          available: typeof entry !== 'object' || entry.available !== false,
          reason: typeof entry === 'object' ? boundedErrorMessage(entry.reason, '') : '',
        };
      })
      .filter(Boolean);
  }

  function buildRowHtml(entry, activeModel, pendingDeleteId, modelTuning, pendingTuningModelId, openAdvancedModelIds, pendingRuntimeAction, pendingRuntimeModelId, preferredLocalModel, pendingLocalModelId) {
    var isActive = Boolean(activeModel)
      && canonicalOllamaTag(entry.id) === canonicalOllamaTag(activeModel);
    var isPendingDelete = pendingDeleteId === entry.id;
    var sizeLabel = formatHumanSize(entry.sizeBytes);
    var runtimeBusy = Boolean(pendingRuntimeAction);
    var actionButton = resolveActionButton();
    var badgeHtml = isActive ? '<span class="settings-badge model-library-inuse-badge">Loaded</span>' : '';
    var localInferenceEligible = entry.engineType === 'ollama' || entry.engineType === 'vllm';
    var isLocalInferenceModel = localInferenceEligible
      && canonicalOllamaTag(entry.id) === canonicalOllamaTag(preferredLocalModel);
    var localBadgeHtml = isLocalInferenceModel ? '<span class="settings-badge">Local inference</span>' : '';
    // State-or-action: the designated model shows only the "Local inference"
    // badge; the select action renders only on the other eligible models.
    var localActionHtml = (localInferenceEligible && !isLocalInferenceModel) ? actionButton({
      plain: true,
      className: 'settings-secondary',
      label: pendingLocalModelId === entry.id ? 'Selecting…' : 'Use for local inference',
      ariaLabel: 'Use ' + entry.id + ' for local inference',
      title: 'Set as the model used for local inference',
      disabled: Boolean(pendingLocalModelId) || runtimeBusy || !entry.available,
      dataset: { 'model-library-action': 'select-local-inference', 'model-id': entry.id },
    }) : '';
    var runtimeLabel = isActive
      ? (pendingRuntimeAction === 'unload' ? 'Unloading…' : 'Unload')
      : (pendingRuntimeAction === 'load' && pendingRuntimeModelId === entry.id
        ? (activeModel ? 'Switching…' : 'Loading…')
        : (activeModel ? 'Switch' : 'Load'));
    var runtimeActionHtml = actionButton({
      plain: true,
      className: isActive ? 'settings-secondary' : 'settings-primary',
      label: runtimeLabel,
      ariaLabel: (isActive ? 'Unload ' : (activeModel ? 'Switch to ' : 'Load ')) + entry.id,
      title: isActive
        ? 'Unload this model from the runtime'
        : (activeModel ? 'Switch the active model to this one' : 'Load this model into the runtime'),
      disabled: runtimeBusy || (!isActive && !entry.available),
      dataset: { 'model-library-action': isActive ? 'unload' : 'load', 'model-id': entry.id },
    });
    var removeActionHtml = isActive ? '' : actionButton({
        plain: true,
        className: 'settings-secondary model-library-remove-btn',
        label: isPendingDelete ? 'Removing…' : 'Remove',
        ariaLabel: 'Remove ' + entry.id,
        title: 'Delete this model from disk (cannot be undone)',
        disabled: isPendingDelete || runtimeBusy,
        dataset: { 'model-library-action': 'remove', 'model-id': entry.id },
      });
    var tuningSupported = !entry.engineType
      || ['ollama', 'vllm', 'openai-compatible'].includes(entry.engineType);
    var tuneActionHtml = tuningSupported ? actionButton({
      plain: true,
      className: 'settings-secondary',
      label: 'Tune',
      ariaLabel: 'Tune ' + entry.id,
      title: 'Open per-model tuning parameters',
      disabled: runtimeBusy,
      dataset: { 'model-library-action': 'tune', 'model-id': entry.id },
    }) : '';
    var actionHtml = localActionHtml + tuneActionHtml + runtimeActionHtml + removeActionHtml;
    var timeoutValue = resolveTimeoutValue(modelTuning, entry.id);
    var tuningPending = pendingTuningModelId === entry.id;
    var advancedOpen = Array.isArray(openAdvancedModelIds) && openAdvancedModelIds.includes(entry.id);
    var timeoutOptions = [
      { value: '', label: 'Automatic' },
      { value: '60', label: '60 seconds' },
      { value: '120', label: '120 seconds' },
      { value: '180', label: '180 seconds' },
      { value: '300', label: '300 seconds' },
    ];
    var timeoutSelect = resolveSelectField()({
      label: 'Stream inactivity timeout',
      value: timeoutValue == null ? '' : String(timeoutValue),
      options: timeoutOptions,
      ariaLabel: 'Stream inactivity timeout for ' + entry.id,
      className: 'model-library-timeout-field',
      dataset: {
        'model-library-action': 'stream-timeout',
        'model-id': entry.id,
      },
    });
    var pendingCopy = tuningPending
      ? 'Saving…'
      : 'Applies the next time the model runtime initializes.';
    return ''
      + '<div class="settings-field-row model-library-row" data-model-id="' + escapeHtml(entry.id) + '">'
      + '<div class="settings-field-row-text">'
      + '<span class="settings-field-label model-library-row-id">' + escapeHtml(entry.id) + '</span>'
      + (sizeLabel ? '<p class="settings-field-description model-library-row-size">' + escapeHtml(sizeLabel) + '</p>' : '')
      + (!entry.available && entry.reason ? '<p class="settings-field-description model-library-row-unavailable">' + escapeHtml(entry.reason) + '</p>' : '')
      + '</div>'
      + '<div class="model-library-row-actions">'
      + (badgeHtml || localBadgeHtml ? '<span class="model-library-row-tags">' + badgeHtml + localBadgeHtml + '</span>' : '')
      + actionHtml + '</div>'
      + '<details class="model-library-advanced"' + (advancedOpen ? ' open' : '') + '>'
      + '<summary aria-label="Advanced settings for ' + escapeHtml(entry.id) + '">Advanced</summary>'
      + '<div class="model-library-advanced-body">'
      + '<p class="settings-field-description">How long this model may stay silent between streamed chunks.</p>'
      + timeoutSelect
      + '<p class="settings-note model-library-apply-note" aria-live="polite">' + escapeHtml(pendingCopy) + '</p>'
      + '</div></details>'
      + '</div>';
  }

  function buildConfirmModalHtml(modelId, stepModal) {
    if (!stepModal || typeof stepModal.renderStepModal !== 'function') {
      return '';
    }
    return stepModal.renderStepModal({
      id: 'model-library-confirm-delete',
      tone: 'danger',
      title: 'Remove model?',
      summary: 'This deletes "' + modelId + '" from your local engine (ollama rm). This cannot be undone.',
      bodyHtml: '',
      actions: [
        { id: 'cancel', label: 'Cancel', variant: 'secondary' },
        { id: 'confirm', label: 'Remove', variant: 'danger' },
      ],
    });
  }

  function buildGroupHtml(view) {
    var rowsHtml = view.models.length
      ? view.models.map(function (entry) {
        return buildRowHtml(
          entry,
          view.activeModel,
          view.pendingDeleteId,
          view.modelTuning,
          view.pendingTuningModelId,
          view.openAdvancedModelIds,
          view.pendingRuntimeAction,
          view.pendingRuntimeModelId,
          view.preferredLocalModel,
          view.pendingLocalModelId
        );
      }).join('')
      : '<p class="settings-note">No local models installed yet.</p>';

    var actionButton = resolveActionButton();
    var pullDisabled = view.pullStatus === 'running';
    var cancelButtonHtml = pullDisabled
      ? actionButton({
        plain: true,
        className: 'settings-secondary',
        label: 'Cancel',
        dataset: { 'model-library-action': 'cancel-pull' },
      })
      : '';
    var progressHtml = '';
    if (pullDisabled) {
      var pct = Number.isFinite(view.pullPercent) ? Math.max(0, Math.min(100, view.pullPercent)) : 0;
      var transferred = formatBytesShort(view.pullBytes);
      var total = formatBytesShort(view.pullTotalBytes);
      var transferText = transferred && total ? (' (' + transferred + ' / ' + total + ')') : '';
      progressHtml = '<div class="settings-note model-library-pull-progress" aria-live="polite">'
        + escapeHtml(pct + '%' + transferText + (view.pullSummary ? ' — ' + view.pullSummary : ''))
        + '</div>';
    }

    return ''
      + '<div class="settings-group model-library-group" role="group" aria-labelledby="modelLibraryHeading" id="' + GROUP_ID + '">'
      + '<h4 class="settings-group-heading" id="modelLibraryHeading">Model library</h4>'
      + '<p class="settings-group-copy">Load, switch, unload, pull, tune, or remove models on your local engine.</p>'
      + '<div class="model-library-list">' + rowsHtml + '</div>'
      + '<div class="settings-field-row model-library-pull-row">'
      + '<div class="settings-field-row-text">'
      + '<label class="settings-field-label" for="modelLibraryPullInput">Pull a model</label>'
      + '<p class="settings-field-description">Enter any Ollama model tag (e.g. hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M).</p>'
      + '</div>'
      + resolveTextField()({
        id: 'modelLibraryPullInput',
        placeholder: 'hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M',
        value: view.pullInputValue || '',
        disabled: pullDisabled,
        ariaLabel: 'Model tag to pull',
        className: 'model-library-pull-input',
      })
      + '</div>'
      + '<div class="settings-actions">'
      + actionButton({
        plain: true,
        className: 'settings-primary',
        label: pullDisabled ? 'Pulling…' : 'Pull',
        disabled: pullDisabled,
        dataset: { 'model-library-action': 'pull' },
      })
      + cancelButtonHtml
      + '</div>'
      + progressHtml
      + '<div class="settings-note model-library-status" aria-live="polite">' + escapeHtml(view.statusMessage || '') + '</div>'
      + '</div>';
  }

  function createModelLibraryController(deps) {
    var d = deps || {};
    var state = d.state || {};
    var windowRef = d.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    var documentRef = d.documentRef || windowRef.document || null;
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function noop() {};
    var openModelTuning = typeof d.openModelTuning === 'function' ? d.openModelTuning : function noop() {};
    var refreshModelPickers = typeof d.refreshModelPickers === 'function' ? d.refreshModelPickers : function noop() {};
    var stepModal = d.stepModal
      || (root && root.inventoryStepModal)
      || (typeof require === 'function' ? require('../inventory/step-modal') : null)
      || null;

    var setupServiceFactory = resolveSetupServiceFactory();
    var setupService = d.setupService || (setupServiceFactory && typeof setupServiceFactory.createSetupService === 'function'
      ? setupServiceFactory.createSetupService({ windowRef: windowRef, appendClientLog: appendClientLog })
      : null);

    var mountedRoot = null;
    var unsubscribePull = null;
    var pendingConfirmModel = '';
    var disposed = false;
    var runtimeOperationId = 0;
    var runtimeTimeoutId = null;

    var view = {
      models: [],
      activeModel: '',
      pendingDeleteId: '',
      pendingRuntimeAction: '',
      pendingRuntimeModelId: '',
      preferredLocalModel: String(state?.offline?.preferredLocalModel || '').trim(),
      pendingLocalModelId: '',
      pullStatus: 'idle',
      pullRequestId: '',
      pullPercent: 0,
      pullBytes: 0,
      pullTotalBytes: 0,
      pullSummary: '',
      pullInputValue: '',
      statusMessage: '',
      modelTuning: { streamInactivitySecondsByModel: {} },
      pendingTuningModelId: '',
      openAdvancedModelIds: [],
      focusTuningModelId: '',
    };

    // The legacy flat-row group yields to the dedicated card-grid section while
    // model_library_section is on; an absent key preserves legacy test fixtures.
    function isFeatureEnabled() {
      return Boolean(
        state
        && state.features
        && state.features.featureFlags
        && state.features.featureFlags.model_management_ui === true
        && state.features.featureFlags.model_library_section !== true
      );
    }

    function findModelsCard() {
      if (!documentRef || typeof documentRef.querySelector !== 'function') {
        return null;
      }
      return documentRef.querySelector(MODELS_SECTION_SELECTOR);
    }

    function removeExistingGroup() {
      var card = findModelsCard();
      var existing = card ? card.querySelector('#' + GROUP_ID) : (documentRef && documentRef.getElementById(GROUP_ID));
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }

    function readActiveModel() {
      return String(
        (state.status && state.status.model)
        || (state.modelList && state.modelList.active_model)
        || ''
      ).trim();
    }

    function render() {
      if (disposed) return;
      if (!isFeatureEnabled()) {
        removeExistingGroup();
        mountedRoot = null;
        return;
      }
      var card = findModelsCard();
      if (!card) {
        return;
      }
      view.activeModel = readActiveModel();
      // Preserve a half-typed pull tag across re-renders (e.g. opening the
      // Remove confirm re-renders the group and would otherwise wipe the input).
      var liveInput = card.querySelector('#modelLibraryPullInput');
      if (liveInput && view.pullStatus !== 'running') {
        view.pullInputValue = String(liveInput.value || '');
      }
      view.openAdvancedModelIds = Array.from(card.querySelectorAll('.model-library-advanced[open]'))
        .map(function (details) { return details.closest('.model-library-row')?.getAttribute('data-model-id') || ''; })
        .filter(Boolean);
      var activeElement = documentRef.activeElement;
      if (activeElement?.getAttribute?.('data-model-library-action') === 'stream-timeout') {
        view.focusTuningModelId = String(activeElement.getAttribute('data-model-id') || '').trim();
      }
      var html = buildGroupHtml(view);
      var existing = card.querySelector('#' + GROUP_ID);
      if (existing) {
        existing.outerHTML = html;
      } else {
        card.insertAdjacentHTML('beforeend', html);
      }
      mountedRoot = card.querySelector('#' + GROUP_ID);
      if (view.focusTuningModelId) {
        var focusTarget = Array.from(card.querySelectorAll('[data-model-library-action="stream-timeout"]'))
          .find(function (candidate) {
            return candidate.getAttribute('data-model-id') === view.focusTuningModelId;
          });
        if (focusTarget && typeof focusTarget.focus === 'function') {
          focusTarget.focus({ preventScroll: true });
        }
      }
      renderConfirmModalIfNeeded();
    }

    function renderConfirmModalIfNeeded() {
      var backdropId = 'model-library-confirm-delete';
      var existingBackdrop = documentRef && documentRef.querySelector('[data-step-modal="' + backdropId + '"]');
      if (existingBackdrop && existingBackdrop.parentNode) {
        existingBackdrop.parentNode.removeChild(existingBackdrop);
      }
      if (!pendingConfirmModel || !documentRef || !documentRef.body) {
        return;
      }
      var html = buildConfirmModalHtml(pendingConfirmModel, stepModal);
      if (!html) {
        return;
      }
      documentRef.body.insertAdjacentHTML('beforeend', html);
    }

    function loadModelList() {
      return Promise.resolve()
        .then(function () {
          return windowRef.jennyShell && windowRef.jennyShell.models && typeof windowRef.jennyShell.models.list === 'function'
            ? windowRef.jennyShell.models.list()
            : null;
        })
        .then(function (modelList) {
          if (disposed) return;
          if (modelList) {
            state.modelList = modelList;
            view.models = normalizeModelEntries(modelList);
            if (modelList.available === false && !view.statusMessage) {
              var reason = boundedErrorMessage(modelList.reason, '');
              view.statusMessage = reason
                ? 'Local engine unavailable: ' + reason + ' Use Ollama engine health below or Diagnostics.'
                : 'Local engine unavailable. Use Ollama engine health below or Diagnostics.';
            }
          }
        })
        .catch(function (error) {
          if (disposed) return;
          appendClientLog('WARN', 'model_library.list_refresh_failed', {
            message: boundedErrorMessage(error, 'Could not refresh the model list.'),
          });
        });
    }

    function loadModelTuning() {
      var getState = windowRef.jennyShell && windowRef.jennyShell.modelTuning
        && windowRef.jennyShell.modelTuning.getState;
      if (typeof getState !== 'function') return Promise.resolve();
      return Promise.resolve().then(function () { return getState(); }).then(function (tuning) {
        if (disposed) return;
        if (tuning && typeof tuning === 'object') view.modelTuning = tuning;
      }).catch(function (error) {
        if (disposed) return;
        appendClientLog('WARN', 'model_library.tuning_load_failed', {
          message: boundedErrorMessage(error, 'Could not load model tuning.'),
        });
      });
    }

    function refreshModelListAndPickers() {
      return loadModelList().then(function () {
        if (disposed) return;
        refreshModelPickers();
        render();
      });
    }

    function teardownPullSubscription() {
      if (typeof unsubscribePull === 'function') {
        try {
          unsubscribePull();
        } catch (_error) {
          /* ignore */
        }
        unsubscribePull = null;
      }
    }

    function applyPullPayload(payload) {
      if (disposed || !payload || payload.requestId !== view.pullRequestId) {
        return;
      }
      view.pullSummary = boundedErrorMessage(payload.label || payload.summary, view.pullSummary);
      if (Number.isFinite(payload.percent)) {
        view.pullPercent = payload.percent;
      }
      if (Number.isFinite(payload.bytes)) {
        view.pullBytes = payload.bytes;
      }
      if (Number.isFinite(payload.totalBytes)) {
        view.pullTotalBytes = payload.totalBytes;
      }
      if (payload.status === 'completed') {
        view.pullStatus = 'idle';
        view.statusMessage = 'Pull complete: ' + view.pullInputValue + '.';
        teardownPullSubscription();
        refreshModelListAndPickers();
        return;
      }
      if (payload.status === 'failed') {
        view.pullStatus = 'idle';
        view.statusMessage = boundedErrorMessage(payload.error || payload.summary, 'Pull failed.');
        teardownPullSubscription();
        render();
        return;
      }
      if (payload.status === 'cancelled') {
        view.pullStatus = 'idle';
        view.statusMessage = 'Pull cancelled.';
        teardownPullSubscription();
        render();
        return;
      }
      view.pullStatus = 'running';
      render();
    }

    function generateRequestId() {
      if (windowRef.crypto && typeof windowRef.crypto.randomUUID === 'function') {
        return windowRef.crypto.randomUUID();
      }
      return 'model_library_pull_' + Date.now().toString(16) + '_' + Math.random().toString(16).slice(2, 10);
    }

    function readPullInput() {
      var input = mountedRoot && mountedRoot.querySelector('#modelLibraryPullInput');
      return input ? String(input.value || '').trim() : '';
    }

    function handleStartPull() {
      if (!setupService) {
        view.statusMessage = 'Pull is unavailable right now.';
        render();
        return;
      }
      var tag = readPullInput();
      if (!tag) {
        view.statusMessage = 'Enter a model tag first.';
        render();
        return;
      }
      view.pullInputValue = tag;
      view.pullRequestId = generateRequestId();
      view.pullStatus = 'running';
      view.pullPercent = 0;
      view.pullBytes = 0;
      view.pullTotalBytes = 0;
      view.pullSummary = 'Starting Ollama pull.';
      view.statusMessage = '';
      render();
      teardownPullSubscription();
      unsubscribePull = setupService.subscribePullProgress(applyPullPayload);
      setupService.startOllamaPull({ model: tag, requestId: view.pullRequestId })
        .then(function (result) {
          if (disposed) return;
          if (result && result.requestId) {
            view.pullRequestId = result.requestId;
          }
          if (result && result.status === 'failed') {
            view.pullStatus = 'idle';
            view.statusMessage = boundedErrorMessage(result.error || result.message || result.summary, 'Could not start the pull.');
            teardownPullSubscription();
            render();
          }
        })
        .catch(function (error) {
          if (disposed) return;
          view.pullStatus = 'idle';
          view.statusMessage = boundedErrorMessage(error, 'Could not start the pull.');
          teardownPullSubscription();
          appendClientLog('WARN', 'model_library.pull_start_failed', { message: view.statusMessage });
          render();
        });
    }

    function handleCancelPull() {
      if (!setupService || view.pullStatus !== 'running') {
        return;
      }
      setupService.cancelOllamaPull({ requestId: view.pullRequestId, model: view.pullInputValue }).then(function (result) {
          if (disposed) return;
          if (!result || result.cancelled !== true) { view.statusMessage = boundedErrorMessage(result && (result.error || result.message), 'Could not cancel the pull.'); appendClientLog('WARN', 'model_library.pull_cancel_failed', { message: view.statusMessage }); render(); return; }
          view.pullStatus = 'idle'; view.statusMessage = 'Pull cancelled.'; teardownPullSubscription(); render();
        })
        .catch(function (error) {
          if (disposed) return;
          view.statusMessage = boundedErrorMessage(error, 'Could not cancel the pull.'); appendClientLog('WARN', 'model_library.pull_cancel_failed', { message: view.statusMessage }); render();
        });
    }

    function invokeRuntimeAction(workFactory, timeoutMs, timeoutMessage) {
      var configuredTimeout = Number(d.runtimeActionTimeoutMs);
      var effectiveTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : timeoutMs;
      return new Promise(function (resolve, reject) {
        runtimeTimeoutId = windowRef.setTimeout(function () {
          runtimeTimeoutId = null;
          reject(new Error(timeoutMessage));
        }, effectiveTimeout);
        Promise.resolve().then(workFactory).then(function (result) {
          if (runtimeTimeoutId != null) windowRef.clearTimeout(runtimeTimeoutId);
          runtimeTimeoutId = null;
          resolve(result);
        }, function (error) {
          if (runtimeTimeoutId != null) windowRef.clearTimeout(runtimeTimeoutId);
          runtimeTimeoutId = null;
          reject(error);
        });
      });
    }

    function handleRuntimeAction(action, modelId) {
      if (view.pendingRuntimeAction) return;
      var activeModel = readActiveModel();
      var entry = view.models.find(function (candidate) { return candidate.id === modelId; });
      if (action === 'load' && (!entry || entry.available === false)) {
        view.statusMessage = entry && entry.reason ? entry.reason : 'That model is unavailable right now.';
        render();
        return;
      }
      if (action === 'unload' && canonicalOllamaTag(activeModel) !== canonicalOllamaTag(modelId)) {
        view.statusMessage = 'The loaded model changed. Refreshing the model library.';
        refreshModelListAndPickers();
        return;
      }
      var modelsBridge = windowRef.jennyShell && windowRef.jennyShell.models;
      var invoke = action === 'unload' ? modelsBridge && modelsBridge.unload : modelsBridge && modelsBridge.load;
      if (typeof invoke !== 'function') {
        view.statusMessage = 'Model lifecycle controls are unavailable right now.';
        render();
        return;
      }
      var operationId = ++runtimeOperationId;
      var switching = action === 'load' && Boolean(activeModel);
      view.pendingRuntimeAction = action;
      view.pendingRuntimeModelId = modelId;
      view.statusMessage = action === 'unload'
        ? 'Unloading "' + modelId + '"…'
        : (switching ? 'Switching to "' + modelId + '"…' : 'Loading "' + modelId + '"…');
      render();
      var payload = entry && entry.engineType
        ? { model: entry.id, engine_type: entry.engineType }
        : modelId;
      invokeRuntimeAction(
        function () { return action === 'unload' ? invoke() : invoke(payload); },
        action === 'unload' ? MODEL_UNLOAD_TIMEOUT_MS : MODEL_LOAD_TIMEOUT_MS,
        action === 'unload'
          ? 'The unload request timed out. Model state will be re-checked.'
          : 'The load request timed out. Model state will be re-checked.'
      )
        .then(function () {
          if (disposed || operationId !== runtimeOperationId) return;
          view.pendingRuntimeAction = '';
          view.pendingRuntimeModelId = '';
          view.statusMessage = action === 'unload'
            ? 'Model unloaded.'
            : (switching ? 'Switched to "' + modelId + '".' : 'Loaded "' + modelId + '".');
          appendClientLog('INFO', action === 'unload' ? 'models.unloaded' : 'models.loaded', { model: modelId });
          return refreshModelListAndPickers();
        })
        .catch(function (error) {
          if (disposed || operationId !== runtimeOperationId) return;
          view.pendingRuntimeAction = '';
          view.pendingRuntimeModelId = '';
          var message = boundedErrorMessage(error, action === 'unload' ? 'Could not unload the model.' : 'Could not load the model.');
          view.statusMessage = message;
          appendClientLog('WARN', action === 'unload' ? 'model_library.unload_failed' : 'model_library.load_failed', {
            model: modelId,
            message: message,
          });
          render();
        });
    }

    function handleRemoveClick(modelId) {
      pendingConfirmModel = modelId;
      render();
    }

    function handleLocalInferenceSelection(modelId) {
      if (!modelId || view.pendingLocalModelId) return;
      var update = windowRef.jennyShell?.offline?.updateSettings;
      if (typeof update !== 'function') { view.statusMessage = 'Local inference selection is unavailable right now.'; render(); return; }
      view.pendingLocalModelId = modelId; render();
      Promise.resolve(update({ preferredLocalModel: modelId })).then(function (payload) {
        if (disposed) return;
        var selected = String(payload?.preferredLocalModel || '').trim();
        if (canonicalOllamaTag(selected) !== canonicalOllamaTag(modelId)) throw new Error('Local inference selection was not acknowledged.');
        state.offline = { ...(state.offline || {}), ...payload };
        view.preferredLocalModel = selected; view.pendingLocalModelId = '';
        view.statusMessage = 'Selected "' + modelId + '" for local inference.'; render();
      }).catch(function (error) {
        if (disposed) return;
        view.pendingLocalModelId = ''; view.statusMessage = boundedErrorMessage(error, 'Could not select the local inference model.');
        appendClientLog('WARN', 'model_library.local_inference_selection_failed', { model: modelId, message: view.statusMessage }); render();
      });
    }

    function handleStreamTimeoutChange(select) {
      var modelId = String(select.getAttribute('data-model-id') || '').trim();
      var rawValue = String(select.value || '').trim();
      var seconds = rawValue ? Number(rawValue) : null;
      if (view.pendingTuningModelId) {
        render();
        return;
      }
      var update = windowRef.jennyShell && windowRef.jennyShell.modelTuning
        && windowRef.jennyShell.modelTuning.update;
      if (!modelId || typeof update !== 'function') {
        view.statusMessage = 'Model tuning is unavailable right now.';
        render();
        return;
      }
      var previousTuning = {
        ...view.modelTuning,
        streamInactivitySecondsByModel: {
          ...(view.modelTuning?.streamInactivitySecondsByModel || {}),
        },
      };
      var nextByModel = { ...previousTuning.streamInactivitySecondsByModel };
      if (seconds == null) delete nextByModel[modelId];
      else nextByModel[modelId] = seconds;
      view.modelTuning = { ...view.modelTuning, streamInactivitySecondsByModel: nextByModel };
      view.pendingTuningModelId = modelId;
      view.openAdvancedModelIds = Array.from(new Set([...(view.openAdvancedModelIds || []), modelId]));
      view.focusTuningModelId = modelId;
      render();
      Promise.resolve().then(function () {
        return update({ modelId: modelId, streamInactivitySeconds: seconds });
      })
        .then(function (result) {
          if (disposed) return;
          if (!result || (result.status && result.status !== 'applied')) {
            view.modelTuning = previousTuning;
            view.pendingTuningModelId = '';
            view.statusMessage = 'Stream timeout was not saved: '
              + String(result.reason || 'validation failed').replaceAll('_', ' ') + '.';
            render();
            return;
          }
          var tuning = result?.state || result;
          view.modelTuning = tuning && typeof tuning === 'object' ? tuning : view.modelTuning;
          view.pendingTuningModelId = '';
          view.statusMessage = 'Stream timeout saved for "' + modelId + '". It applies on the next runtime initialization.';
          render();
        })
        .catch(function (error) {
          if (disposed) return;
          view.modelTuning = previousTuning;
          view.pendingTuningModelId = '';
          view.statusMessage = boundedErrorMessage(error, 'Could not save model tuning.');
          render();
        });
    }

    function handleConfirmCancel() {
      pendingConfirmModel = '';
      render();
    }

    function handleConfirmDelete() {
      var modelId = pendingConfirmModel;
      pendingConfirmModel = '';
      if (!modelId) {
        render();
        return;
      }
      var stillExists = view.models.some(function (entry) { return entry.id === modelId; });
      if (!stillExists) {
        view.statusMessage = '"' + modelId + '" is no longer in the model list.';
        render();
        return;
      }
      view.pendingDeleteId = modelId;
      render();
      var deleteFn = windowRef.jennyShell && windowRef.jennyShell.models && windowRef.jennyShell.models.delete;
      if (typeof deleteFn !== 'function') {
        view.pendingDeleteId = '';
        view.statusMessage = 'Delete is unavailable right now.';
        render();
        return;
      }
      Promise.resolve(deleteFn({ model: modelId }))
        .then(function (result) {
          if (disposed) return;
          view.pendingDeleteId = '';
          if (result && result.status === 'deleted') {
            view.statusMessage = '"' + modelId + '" removed.';
            return refreshModelListAndPickers();
          }
          var code = result && result.code;
          if (code === 'model_in_use') {
            view.statusMessage = '"' + modelId + '" is currently loaded. Unload it first.';
          } else if (code === 'not_found') {
            view.statusMessage = '"' + modelId + '" was already removed.';
            return refreshModelListAndPickers();
          } else if (code === 'invalid_tag') {
            view.statusMessage = 'That model tag is not valid.';
          } else {
            view.statusMessage = boundedErrorMessage(result && result.message, 'Could not remove that model.');
          }
          render();
        })
        .catch(function (error) {
          if (disposed) return;
          view.pendingDeleteId = '';
          view.statusMessage = boundedErrorMessage(error, 'Could not remove that model.');
          appendClientLog('WARN', 'model_library.delete_failed', { message: view.statusMessage });
          render();
        });
    }

    function handleClick(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      var actionEl = target.closest('[data-model-library-action]');
      if (actionEl) {
        var action = actionEl.getAttribute('data-model-library-action');
        if (action === 'pull') {
          handleStartPull();
        } else if (action === 'cancel-pull') {
          handleCancelPull();
        } else if (action === 'load' || action === 'unload') {
          handleRuntimeAction(action, actionEl.getAttribute('data-model-id') || '');
        } else if (action === 'select-local-inference') {
          handleLocalInferenceSelection(actionEl.getAttribute('data-model-id') || '');
        } else if (action === 'tune') {
          openModelTuning(actionEl.getAttribute('data-model-id') || '', actionEl);
        } else if (action === 'remove') {
          var modelId = actionEl.getAttribute('data-model-id') || '';
          handleRemoveClick(modelId);
        }
        return;
      }
      var stepModalAction = target.closest ? target.closest('[data-step-modal-action]') : null;
      if (stepModalAction && stepModalAction.closest('[data-step-modal="model-library-confirm-delete"]')) {
        var stepAction = stepModalAction.getAttribute('data-step-modal-action');
        if (stepAction === 'confirm') {
          handleConfirmDelete();
        } else if (stepAction === 'cancel') {
          handleConfirmCancel();
        }
        return;
      }
      // Backdrop click (inside the modal's backdrop but outside the dialog
      // panel) dismisses, matching standard modal affordances.
      var backdrop = target.closest('[data-step-modal="model-library-confirm-delete"]');
      if (backdrop && pendingConfirmModel && !target.closest('.inv-step-modal')) {
        handleConfirmCancel();
      }
    }

    function handleChange(event) {
      var target = event && event.target;
      if (!target || typeof target.getAttribute !== 'function') return;
      if (target.getAttribute('data-model-library-action') === 'stream-timeout') {
        handleStreamTimeoutChange(target);
      }
    }

    function handleKeydown(event) {
      if (event && event.key === 'Escape' && pendingConfirmModel) {
        handleConfirmCancel();
      }
    }

    // Re-derive the row set from state.modelList (which the shell's periodic
    // refreshSnapshots keeps fresh) and re-render ONLY when something actually
    // changed — an unconditional 15s re-render would wipe pull-input focus.
    function syncFromState() {
      if (!isFeatureEnabled() || !state.modelList) {
        return;
      }
      var entries = normalizeModelEntries(state.modelList);
      var preferredLocalModel = String(state?.offline?.preferredLocalModel || '').trim();
      var changed = entries.length !== view.models.length
        || entries.some(function (entry, i) {
          return entry.id !== view.models[i].id
            || entry.sizeBytes !== view.models[i].sizeBytes
            || entry.engineType !== view.models[i].engineType
            || entry.available !== view.models[i].available
            || entry.reason !== view.models[i].reason;
        })
        || readActiveModel() !== view.activeModel
        || preferredLocalModel !== view.preferredLocalModel;
      if (changed) {
        view.models = entries;
        view.preferredLocalModel = preferredLocalModel;
        render();
      }
    }

    function bind() {
      if (disposed || !documentRef || typeof documentRef.addEventListener !== 'function') {
        return;
      }
      documentRef.addEventListener('click', handleClick);
      documentRef.addEventListener('change', handleChange);
      documentRef.addEventListener('keydown', handleKeydown);
      // Initial population: nothing else feeds the library list at startup
      // (pull/delete refreshes only run after an action). Skips the picker
      // refresh -- the lifecycle already populates the Composer picker at boot.
      if (isFeatureEnabled()) {
        Promise.all([loadModelList(), loadModelTuning()]).then(function () {
          if (disposed) return;
          render();
        });
      }
    }

    function dispose() {
      disposed = true;
      runtimeOperationId += 1;
      if (runtimeTimeoutId != null) {
        windowRef.clearTimeout(runtimeTimeoutId);
        runtimeTimeoutId = null;
      }
      teardownPullSubscription();
      if (documentRef && typeof documentRef.removeEventListener === 'function') {
        documentRef.removeEventListener('click', handleClick);
        documentRef.removeEventListener('change', handleChange);
        documentRef.removeEventListener('keydown', handleKeydown);
      }
      removeExistingGroup();
      var backdrop = documentRef && documentRef.querySelector('[data-step-modal="model-library-confirm-delete"]');
      if (backdrop && backdrop.parentNode) {
        backdrop.parentNode.removeChild(backdrop);
      }
    }

    function refresh() {
      return refreshModelListAndPickers();
    }

    function syncFeatureState() {
      if (!isFeatureEnabled()) {
        render();
        return Promise.resolve();
      }
      return refresh();
    }

    return {
      bind: bind,
      dispose: dispose,
      render: render,
      refresh: refresh,
      syncFeatureState: syncFeatureState,
      syncFromState: syncFromState,
      isFeatureEnabled: isFeatureEnabled,
      _view: view,
    };
  }

  return {
    createModelLibraryController: createModelLibraryController,
    normalizeModelEntries: normalizeModelEntries,
    formatHumanSize: formatHumanSize,
    formatBytesShort: formatBytesShort,
  };
});
