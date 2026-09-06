(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      root,
      require('../inventory/number-input'),
      require('./renderer-model-tuning-engine-utils')
    );
    return;
  }
  root.rendererModelTuningDrawer = factory(root, root.inventoryNumberInput, root.rendererModelTuningEngineUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, bundledNumberInput, engineUtils) {
  'use strict';

  var GENERATION_PROFILE_BOUNDS = {
    temperature: { min: 0, max: 2 },
    topP: { min: 0, max: 1 },
    topK: { min: 0, max: 200 },
    minP: { min: 0, max: 1 },
    presencePenalty: { min: -2, max: 2 },
    repetitionPenalty: { min: 0, max: 2 },
    maxOutputTokens: { min: 1, max: 200000 },
  };
  var FIELD_GROUPS = [
    {
      title: 'Context and memory',
      fields: [
        { key: 'contextLength', label: 'Context window', kind: 'context' },
        { key: 'ratio', label: 'Summarize at', kind: 'ratio' },
      ],
    },
    {
      title: 'Sampling',
      fields: [
        { key: 'temperature', label: 'Temperature', kind: 'profile' },
        { key: 'topP', label: 'Top P', kind: 'profile' },
        { key: 'topK', label: 'Top K', kind: 'profile' },
        { key: 'minP', label: 'Min P', kind: 'profile' },
      ],
    },
    {
      title: 'Repetition and length',
      fields: [
        { key: 'repetitionPenalty', label: 'Repetition penalty', kind: 'profile' },
        { key: 'presencePenalty', label: 'Presence penalty', kind: 'profile' },
        { key: 'maxOutputTokens', label: 'Maximum output', kind: 'profile' },
      ],
    },
  ];
  var FIELD_DEFINITIONS = FIELD_GROUPS.reduce(function (definitions, group) {
    group.fields.forEach(function (field) {
      if (field.kind === 'profile') definitions.push([field.key, field.label]);
    });
    return definitions;
  }, []);
  var SUPPORTED_ENGINES = new Set(['ollama', 'vllm', 'openai-compatible']);

  function createModelTuningDrawerController(deps) {
    var d = deps || {};
    var shellState = d.state || {};
    var windowRef = d.windowRef || root;
    var documentRef = d.documentRef || windowRef.document;
    var inventory = d.inventory || windowRef.inventory || {};
    var drawerFactory = d.drawerFactory || windowRef.inventoryDrawer;
    var disposed = false;
    var generation = 0;
    var visible = false;
    var rendering = false;
    var returnFocusTarget = null;
    var activeModelId = '';
    var activeDisplayName = '';
    var activeState = null;
    var statusMessage = '';
    var pending = false;
    var boundActionsHost = null;
    var engineSettings = null;
    var localGgufs = null;
    var serverStatus = null;
    var engineView = null;
    var engineDraft = null;
    var engineHints = null;
    var getStreamingSessionIds = typeof d.getStreamingSessionIds === 'function'
      ? d.getStreamingSessionIds
      : function () { return []; };
    var confirmDialog = d.confirmDialog || null;
    if (!confirmDialog) {
      var confirmDialogFactory = windowRef?.rendererIdeConfirmDialog?.createIdeConfirmDialog;
      var helpOverlayFactory = windowRef?.inventoryHelpOverlay?.createHelpOverlay;
      if (typeof confirmDialogFactory === 'function' && typeof helpOverlayFactory === 'function') {
        confirmDialog = confirmDialogFactory({
          document: documentRef,
          actionButton: inventory.actionButton || windowRef.inventoryActionButton,
          helpOverlayFactory: helpOverlayFactory,
          hostId: 'modelTuningContextRestartConfirmOverlay',
        });
      }
    }
    var drawer = drawerFactory?.createDrawer?.({
      id: 'modelTuningDrawer',
      documentRef: documentRef,
      overlayManager: d.overlayManager || windowRef.rendererOverlayManagerController || null,
      onClose: function () {
        if (!rendering && visible) {
          visible = false;
          generation += 1;
        }
      },
    }) || null;

    function escapeHtml(value) {
      var actionButton = inventory.actionButton || windowRef.inventoryActionButton;
      return typeof actionButton?.escapeHtml === 'function'
        ? actionButton.escapeHtml(String(value == null ? '' : value))
        : String(value == null ? '' : value)
          .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    }

    function resolveEngineType() {
      var models = Array.isArray(shellState?.modelList?.data) ? shellState.modelList.data : [];
      var entry = models.find(function (candidate) {
        return String(candidate?.id || candidate?.model || candidate || '').trim() === activeModelId;
      });
      var entryEngine = entry && typeof entry === 'object'
        ? String(entry.engine_type || entry.engineType || '').trim().toLowerCase()
        : '';
      if (entryEngine) return entryEngine;
      var activeModel = String(shellState?.status?.model || shellState?.modelList?.active_model || '').trim();
      if (activeModel === activeModelId) {
        return String(shellState?.status?.engine || shellState?.status?.engine_type
          || shellState?.modelList?.engine_type || '').trim().toLowerCase();
      }
      return '';
    }

    function supportsTuning() {
      var engineType = resolveEngineType();
      return Boolean(engineType) && SUPPORTED_ENGINES.has(engineType);
    }

    function supportsContextTuning() {
      var engineType = resolveEngineType();
      return Boolean(engineType) && (engineType === 'ollama' || engineType === 'openai-compatible');
    }

    function engineSectionEnabled() {
      var engineType = resolveEngineType();
      return shellState?.features?.featureFlags?.llama_server_acceleration === true
        && (engineType === 'ollama' || engineType === 'openai-compatible')
        && Boolean(windowRef?.jennyShell?.engines);
    }

    function deriveEngineState() {
      engineView = engineUtils.deriveEngineView({
        activeModelId: activeModelId, engineType: resolveEngineType(), shellState: shellState,
        engineSettings: engineSettings, localGgufs: localGgufs, serverStatus: serverStatus, engineHints: engineHints,
      });
      engineDraft = engineView.draft;
    }

    function api() {
      return windowRef?.jennyShell?.modelTuning || null;
    }

    function formatContextLength(value) {
      var parsed = Number(value) || 0;
      return parsed ? Math.round(parsed / 1024) + 'K' : 'Model default';
    }

    function resolveProfile() {
      return activeState?.generationProfilesByModel?.[activeModelId] || {};
    }

    function engineLabel(engineType) {
      if (engineType === 'ollama') return 'Ollama';
      if (engineType === 'vllm') return 'vLLM';
      if (engineType === 'openai-compatible') return 'llama-server';
      return engineType || 'engine unknown';
    }

    function profileBounds(field) {
      var fallback = GENERATION_PROFILE_BOUNDS[field];
      var hydrated = activeState?.generationProfileBounds?.[field] || {};
      return {
        min: hydrated.min == null ? fallback.min : hydrated.min,
        max: hydrated.max == null ? fallback.max : hydrated.max,
      };
    }

    function renderRow(definition, controlsDisabled, contextSteps, contextValue, ratioValue, profile) {
      var selectField = inventory.selectField || windowRef.inventorySelectField;
      var numberInput = inventory.numberInput || windowRef.inventoryNumberInput || bundledNumberInput;
      var control;
      var range = '';
      if (definition.kind === 'context') {
        control = selectField({
          id: 'modelTuningContextLength',
          label: '',
          ariaLabel: definition.label,
          value: String(contextValue || ''),
          options: [{ value: '', label: 'Model default' }].concat(contextSteps.map(function (step) {
            return { value: String(step), label: formatContextLength(step) };
          })),
          disabled: controlsDisabled,
          dataset: { 'model-tuning-field': definition.key },
        });
      } else {
        var bounds = definition.kind === 'ratio'
          ? { min: 0.1, max: 0.99 }
          : profileBounds(definition.key);
        var value = definition.kind === 'ratio' ? ratioValue : profile[definition.key];
        // Integer fields step by 1: a numeric input takes its step BASE from
        // min, so a 256 step against min=1 makes every round value (4096,
        // 8192) step-mismatched and walks the spinner down to 3841.
        var integerField = definition.key === 'maxOutputTokens' || definition.key === 'topK';
        var step = integerField ? 1 : 0.01;
        control = numberInput({
          id: 'modelTuning' + definition.key[0].toUpperCase() + definition.key.slice(1),
          label: '',
          ariaLabel: definition.label,
          value: value == null ? '' : String(value),
          min: bounds.min,
          max: bounds.max,
          step: step,
          allowEmpty: true,
          placeholder: 'Model default',
          disabled: controlsDisabled,
          dataset: { 'model-tuning-field': definition.key },
        });
        range = 'range ' + escapeHtml(Number(bounds.min).toLocaleString('en-US'))
          + '–' + escapeHtml(Number(bounds.max).toLocaleString('en-US'));
      }
      return '<div class="model-tuning-row" data-model-tuning-row="' + escapeHtml(definition.key) + '">'
        + '<span class="model-tuning-row-label">' + escapeHtml(definition.label) + '</span>'
        + '<div class="model-tuning-row-control">' + control + '</div>'
        + '<span class="model-tuning-row-range" data-dirty="false">' + range + '</span>'
        + '</div>';
    }

    function buildEngineSection() {
      if (!engineSectionEnabled() || !engineView) return '';
      var segmented = inventory.segmentedControl || windowRef.inventorySegmentedControl;
      var toggleModule = inventory.toggleSwitch || windowRef.inventoryToggleSwitch;
      return engineUtils.buildEngineSectionHtml({
        view: engineView,
        draft: engineDraft,
        pending: pending,
        statusText: engineUtils.engineStatusText(engineView, engineDraft, serverStatus),
        segmentedControl: typeof segmented === 'function' ? segmented : segmented?.segmentedControl,
        toggleSwitch: typeof toggleModule === 'function' ? toggleModule : toggleModule?.toggleSwitch,
        actionButton: inventory.actionButton || windowRef.inventoryActionButton,
        escapeHtml: escapeHtml,
      });
    }

    function buildBodyHtml() {
      var selectField = inventory.selectField || windowRef.inventorySelectField;
      var numberInput = inventory.numberInput || windowRef.inventoryNumberInput || bundledNumberInput;
      var actionButton = inventory.actionButton || windowRef.inventoryActionButton;
      if (!selectField || !numberInput || !actionButton) return '<p>Model tuning controls are unavailable.</p>';
      var engineType = resolveEngineType();
      var engineUnknown = !engineType;
      if (engineType && !supportsTuning()) {
        return '<p class="model-tuning-drawer-copy">Advanced generation tuning is not available for '
          + '<strong>' + escapeHtml(activeModelId) + '</strong>. This engine owns its generation controls.</p>';
      }
      var controlsDisabled = pending || engineUnknown;
      var contextSteps = Array.isArray(activeState?.contextLengthSteps) ? activeState.contextLengthSteps : [];
      var contextValue = activeState?.contextLengthByModel?.[activeModelId] || '';
      var ratioValue = activeState?.ratioByModel?.[activeModelId];
      var profile = resolveProfile();
      var sections = FIELD_GROUPS.map(function (group) {
        var rows = group.fields.filter(function (definition) {
          return definition.kind !== 'context' || engineUnknown || supportsContextTuning();
        }).map(function (definition) {
          return renderRow(definition, controlsDisabled, contextSteps, contextValue, ratioValue, profile);
        }).join('');
        return '<section class="model-tuning-section">'
          + '<h4 class="model-tuning-section-title">' + escapeHtml(group.title) + '</h4>'
          + (group.title === 'Context and memory' && (engineUnknown || supportsContextTuning())
            ? '<p class="model-tuning-section-hint">Larger context windows retain more history and tool output but consume more RAM or VRAM.</p>'
            : '')
          + rows
          + '</section>';
      }).join('');
      return ''
        + '<p class="model-tuning-drawer-subtitle">' + escapeHtml(activeModelId) + ' · '
        + escapeHtml(engineLabel(engineType)) + ' · applies after the runtime confirms</p>'
        + (engineUnknown
          ? '<div class="model-tuning-drawer-warning" role="status"><span>Jenny can\'t verify this model\'s engine yet, so tuning is paused.</span>'
            + actionButton({ id: 'recheck-model-tuning-engine', label: 'Re-check', variant: 'ghost', size: 'sm' })
            + '</div>'
          : '')
        // One block-level wrapper: the drawer body is a grid, and a sticky footer
        // placed directly in a grid cell has no travel. Also the container-query root.
        + '<div class="model-tuning-drawer-scroll">'
        + '<div class="model-tuning-drawer-grid"' + (engineUnknown ? ' data-disabled="true"' : '') + '>'
        + buildEngineSection() + sections
        + '</div>'
        + '<div class="model-tuning-drawer-footer">'
        + actionButton({ id: 'save-model-tuning', label: pending ? 'Applying…' : 'Apply 0 changes', variant: 'primary', disabled: true })
        + actionButton({ id: 'reset-model-tuning', label: 'Reset to defaults', variant: 'secondary', disabled: controlsDisabled })
        + '<p class="model-tuning-drawer-status" aria-live="polite">' + escapeHtml(statusMessage) + '</p>'
        + '</div>'
        + '</div>';
    }

    function recheckEngine() {
      statusMessage = resolveEngineType()
        ? ''
        : "Still can't verify the engine. Refresh the model list and try again.";
      render();
    }

    function numericValuesMatch(left, right) {
      var leftEmpty = left == null || String(left).trim() === '';
      var rightEmpty = right == null || String(right).trim() === '';
      if (leftEmpty || rightEmpty) return leftEmpty && rightEmpty;
      var leftNumber = Number(left);
      var rightNumber = Number(right);
      if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
      return leftNumber === rightNumber;
    }

    function dirtyFields(host) {
      var dirty = [];
      var profile = resolveProfile();
      FIELD_DEFINITIONS.forEach(function (definition) {
        var input = host?.querySelector?.('[data-model-tuning-field="' + definition[0] + '"]');
        if (input && !numericValuesMatch(input.value, profile[definition[0]])) dirty.push(definition[0]);
      });
      var ratio = host?.querySelector?.('#modelTuningRatio');
      if (ratio && !numericValuesMatch(ratio.value, activeState?.ratioByModel?.[activeModelId])) {
        dirty.push('ratio');
      }
      var context = host?.querySelector?.('#modelTuningContextLength');
      if (context && !numericValuesMatch(context.value, activeState?.contextLengthByModel?.[activeModelId])) {
        dirty.push('contextLength');
      }
      if (engineSectionEnabled() && engineDraft) {
        dirty.push.apply(dirty, engineUtils.engineDirtyFields(engineView, engineDraft));
      }
      return dirty;
    }

    function updateDirtyState(host) {
      var dirty = dirtyFields(host);
      var dirtySet = new Set(dirty);
      var saveButton = host?.querySelector?.('[data-action="save-model-tuning"]');
      if (saveButton) {
        saveButton.textContent = pending
          ? 'Applying…'
          : 'Apply ' + dirty.length + (dirty.length === 1 ? ' change' : ' changes');
        saveButton.disabled = pending || !supportsTuning() || dirty.length === 0;
      }
      host?.querySelectorAll?.('[data-model-tuning-row]').forEach(function (row) {
        var range = row.querySelector('.model-tuning-row-range');
        if (range) range.dataset.dirty = dirtySet.has(row.dataset.modelTuningRow) ? 'true' : 'false';
      });
    }

    function handleTuningChange() {
      updateDirtyState(boundActionsHost);
    }

    function handleEngineChange(event) {
      if (event?.detail?.id !== 'modelTuningEngine' || !engineDraft) return;
      engineDraft.engine = event.detail.value;
      var mtpRow = boundActionsHost?.querySelector?.('[data-model-tuning-row="mtp"]');
      if (mtpRow) mtpRow.hidden = engineDraft.engine !== 'llama-server';
      var status = boundActionsHost?.querySelector?.('[data-model-tuning-row="engine"] .model-tuning-row-range');
      if (status) status.textContent = engineUtils.engineStatusText(engineView, engineDraft, serverStatus);
      updateDirtyState(boundActionsHost);
    }

    function handleMtpChange(event) {
      if (event?.detail?.id !== 'modelTuningMtp' || !engineDraft) return;
      engineDraft.mtp = Boolean(event.detail.checked);
      updateDirtyState(boundActionsHost);
    }

    async function chooseGguf() {
      var operationGeneration = generation, operationModelId = activeModelId;
      try {
        var result = await windowRef.jennyShell.llamaServer.chooseGguf({
          defaultPath: engineUtils.pickerDefaultDir(engineView, engineDraft),
        });
        if (disposed || generation !== operationGeneration || activeModelId !== operationModelId) return;
        if (result && result.ok === false) { statusMessage = engineUtils.pickerFailureText(result); return render(); }
        if (!result?.path) return;
        engineUtils.applyPickedGguf(engineView, engineDraft, result);
        var code = boundActionsHost?.querySelector?.('[data-model-tuning-gguf]');
        if (code) { code.textContent = engineUtils.modelPathName(result.path); code.title = result.path; }
        var note = boundActionsHost?.querySelector?.('[data-model-tuning-row="mtp"] .model-tuning-row-range');
        if (note) note.textContent = engineUtils.engineNote(engineView);
        var group = boundActionsHost?.querySelector?.('[data-inv-segmented="modelTuningEngine"]');
        var option = group?.querySelector?.('[data-value="llama-server"]');
        option?.removeAttribute?.('disabled'); option?.removeAttribute?.('aria-disabled');
        // The pick is the intent to run with llama-server: select() dispatches inv-segmented-change -> handleEngineChange (dirty state included).
        (inventory.segmentedControl || windowRef.inventorySegmentedControl)?.select?.(group, 'llama-server');
      } catch (_error) {
        if (!disposed && visible && generation === operationGeneration && activeModelId === operationModelId) {
          statusMessage = 'Could not open the file picker.';
          render();
        }
      }
    }

    function bindDrawerActions() {
      var host = documentRef?.getElementById?.('modelTuningDrawer');
      var segmented = inventory.segmentedControl || windowRef.inventorySegmentedControl;
      var toggleModule = inventory.toggleSwitch || windowRef.inventoryToggleSwitch;
      segmented?.initSegmentedHandlers?.(documentRef);
      toggleModule?.initToggleHandlers?.(documentRef);
      if (host && boundActionsHost !== host) {
        boundActionsHost = host;
        host.addEventListener('input', handleTuningChange);
        host.addEventListener('change', handleTuningChange);
        host.addEventListener('inv-segmented-change', handleEngineChange);
        host.addEventListener('inv-toggle-change', handleMtpChange);
      }
      // Load-bearing: the number-input primitive does not emit a disabled
      // attribute, so the numeric fields are only disabled here.
      var controlsDisabled = pending || !resolveEngineType();
      host?.querySelectorAll?.('.model-tuning-drawer-grid input, .model-tuning-drawer-grid select').forEach(function (control) {
        control.disabled = controlsDisabled;
      });
      host?.querySelector?.('[data-action="save-model-tuning"]')?.addEventListener('click', save);
      host?.querySelector?.('[data-action="reset-model-tuning"]')?.addEventListener('click', reset);
      host?.querySelector?.('[data-action="recheck-model-tuning-engine"]')?.addEventListener('click', recheckEngine);
      host?.querySelector?.('[data-action="choose-model-gguf"]')?.addEventListener('click', chooseGguf);
      updateDirtyState(host);
    }

    function render() {
      if (!drawer || disposed || !visible) return false;
      rendering = true;
      try {
        var opened = drawer.open({
          title: 'Tune ' + (activeDisplayName || activeModelId),
          bodyHtml: buildBodyHtml(),
          restoreFocusTo: returnFocusTarget,
        });
        bindDrawerActions();
        return opened;
      } finally {
        rendering = false;
      }
    }

    function collectProfile(host) {
      var profile = {};
      FIELD_DEFINITIONS.forEach(function (definition) {
        var input = host?.querySelector?.('[data-model-tuning-field="' + definition[0] + '"]');
        var value = String(input?.value || '').trim();
        if (value) profile[definition[0]] = Number(value);
      });
      return profile;
    }

    async function applyPatch(patch) {
      if (pending || disposed) return false;
      if (!supportsTuning()) {
        statusMessage = 'This engine owns its generation controls.';
        render();
        return false;
      }
      var operationGeneration = generation;
      var operationModelId = activeModelId;
      pending = true;
      statusMessage = 'Applying and checking the runtime…';
      render();
      try {
        var result = await api()?.update?.(Object.assign({ modelId: operationModelId }, patch));
        if (disposed || !visible || generation !== operationGeneration || activeModelId !== operationModelId) return false;
        activeState = result?.state || activeState;
        statusMessage = engineUtils.applyStatusMessage(result);
        // update() resolves with an object for every outcome, rejections included;
        // only 'applied' means the setting was written.
        return result?.status === 'applied';
      } catch (_error) {
        if (!disposed && visible && generation === operationGeneration && activeModelId === operationModelId) {
          statusMessage = 'The change could not be applied.';
        }
        return false;
      } finally {
        if (!disposed) {
          pending = false;
          if (visible) render();
        }
      }
    }

    async function restartManagedServerForContext() {
      if (pending || disposed) return false;
      var operationGeneration = generation;
      var operationModelId = activeModelId;
      pending = true;
      try {
        var streamingSessionIds = getStreamingSessionIds();
        var streamingCount = Array.isArray(streamingSessionIds) ? streamingSessionIds.filter(Boolean).length : 0;
        if (streamingCount) {
          var confirmed = false;
          if (typeof confirmDialog?.confirm === 'function') {
            try {
              confirmed = await confirmDialog.confirm({
                title: 'Restart llama-server?',
                message: streamingCount === 1
                  ? 'A chat is still streaming. Restarting llama-server will end that response. The new context window only takes effect after a restart.'
                  : streamingCount + ' chats are still streaming. Restarting llama-server will end those responses. The new context window only takes effect after a restart.',
                confirmLabel: 'Restart anyway',
                cancelLabel: 'Not now',
                variant: 'danger',
              });
            } catch (_error) { /* unavailable confirmations cancel safely */ }
          }
          if (!confirmed) {
            if (!disposed && visible && generation === operationGeneration && activeModelId === operationModelId) {
              statusMessage = 'Setting saved. The new context window will take effect on the next llama-server restart.';
            }
            return false;
          }
        }
        statusMessage = 'Restarting llama-server…';
        render();
        var restartResult = null;
        var restartFailed = false;
        try {
          restartResult = await windowRef.jennyShell.llamaServer.restart();
        } catch (_error) {
          restartFailed = true;
        }
        if (restartResult && typeof restartResult === 'object') {
          serverStatus = restartResult;
        } else {
          try {
            serverStatus = await windowRef.jennyShell.llamaServer.getStatus();
          } catch (_error) {
            serverStatus = null;
            restartFailed = true;
          }
        }
        if (disposed || !visible || generation !== operationGeneration || activeModelId !== operationModelId) return false;
        deriveEngineState();
        var restarted = !restartFailed && serverStatus?.ok !== false && engineView?.serving;
        statusMessage = restarted
          ? 'Restarted llama-server. The new context window is live.'
          : 'llama-server restart failed. The setting was saved and is not live yet.';
        return restarted;
      } finally {
        pending = false;
        if (!disposed && visible) render();
      }
    }

    // A saved context window is live immediately on Ollama, but llama-server only
    // reads it as -c at launch: restart when this model is the one being served,
    // and otherwise say when the number will take effect rather than nothing.
    async function settleContextChange(applied, contextChanged) {
      if (!applied || !contextChanged) return;
      if (engineView?.serving) {
        await restartManagedServerForContext();
        return;
      }
      if (resolveEngineType() !== 'openai-compatible' || disposed || !visible) return;
      statusMessage = 'Saved. The new context window applies the next time llama-server starts.';
      render();
    }

    async function save() {
      if (pending || disposed) return;
      var host = documentRef?.getElementById?.('modelTuningDrawer');
      var dirty = dirtyFields(host);
      var tuningDirty = dirty.filter(function (field) { return !['engine', 'mtp', 'modelPath'].includes(field); });
      var ratioRaw = String(host?.querySelector?.('#modelTuningRatio')?.value || '').trim();
      var ratio = ratioRaw ? Number(ratioRaw) : null;
      var hydratedRatio = activeState?.ratioByModel?.[activeModelId];
      hydratedRatio = hydratedRatio == null ? null : Number(hydratedRatio);
      var patch = { generationProfile: collectProfile(host) };
      if (ratio !== hydratedRatio) patch.ratio = ratio;
      var contextField = host?.querySelector?.('#modelTuningContextLength');
      if (contextField) {
        var contextRaw = String(contextField.value || '').trim();
        var contextLength = contextRaw ? Number(contextRaw) : null;
        var hydratedContextLength = activeState?.contextLengthByModel?.[activeModelId];
        hydratedContextLength = hydratedContextLength == null ? null : Number(hydratedContextLength);
        if (contextLength !== hydratedContextLength) patch.contextLength = contextLength;
      }
      var contextChanged = Object.hasOwn(patch, 'contextLength');
      if (tuningDirty.length === dirty.length) {
        var applied = await applyPatch(patch);
        await settleContextChange(applied, contextChanged);
        return applied;
      }
      var operationGeneration = generation, operationModelId = activeModelId;
      var request = engineUtils.buildManagedPatch(activeModelId, engineView, engineDraft);
      // Engine write first; the tuning patch follows ONLY when the runtime reflected
      // the entry. `finally` clears pending even for a stale (closed/re-targeted) result.
      var followUp = null;
      pending = true; statusMessage = 'Applying and checking the runtime…'; render();
      try {
        var result = await windowRef.jennyShell.engines.updateSettings(request.payload);
        // The write landed: the library (app-wide state) hears it even if this drawer went stale.
        if (result?.localEngines) d.onEngineSettingsChanged?.(result.localEngines);
        if (disposed || !visible || generation !== operationGeneration || activeModelId !== operationModelId) return;
        var reflected = engineUtils.returnedEntryMatches(result?.localEngines, engineView.key, request.entry);
        if (!reflected) {
          statusMessage = 'Could not update the engine settings.'; // draft kept: Apply stays live for a retry
        } else {
          engineSettings = Object.assign({}, engineSettings || {}, { localEngines: result.localEngines });
          deriveEngineState();
          if (tuningDirty.length) followUp = patch;
          else statusMessage = 'Applied. Press Use on this model to run it with these settings.';
        }
      } catch (_error) {
        if (!disposed && visible && generation === operationGeneration && activeModelId === operationModelId) {
          statusMessage = 'The engine settings could not be applied.';
        }
      } finally {
        if (!disposed) {
          pending = false;
          if (visible && !followUp) render();
        }
      }
      if (followUp) {
        var followUpApplied = await applyPatch(followUp);
        await settleContextChange(followUpApplied, contextChanged);
        return followUpApplied;
      }
    }

    function reset() {
      var patch = {
        ratio: null,
        generationProfile: {},
        resetGenerationProfile: true,
      };
      if (supportsContextTuning()) patch.contextLength = null;
      return applyPatch(patch);
    }

    async function open(modelId, restoreFocusTo, options) {
      var normalizedModelId = String(modelId || '').trim();
      if (!normalizedModelId || disposed) return false;
      if (!visible) {
        returnFocusTarget = restoreFocusTo || documentRef?.activeElement || null;
      }
      visible = true;
      var requestGeneration = ++generation;
      activeModelId = normalizedModelId;
      activeDisplayName = String(options?.displayName || normalizedModelId).trim() || normalizedModelId;
      engineSettings = null; localGgufs = null; serverStatus = null; engineView = null; engineDraft = null;
      engineHints = options?.engines || null; // the library card's merged engine facts, when opened from a card
      statusMessage = 'Loading model profile…';
      render();
      var requests = [Promise.resolve().then(function () { return api()?.getState?.(); })];
      if (engineSectionEnabled()) requests.push(
        Promise.resolve().then(function () { return windowRef.jennyShell.engines.getSettings(); }),
        Promise.resolve().then(function () { return windowRef.jennyShell.llamaServer?.listLocalGgufs?.(); }),
        Promise.resolve().then(function () { return windowRef.jennyShell.llamaServer?.getStatus?.(); })
      );
      var results = await Promise.allSettled(requests);
      if (disposed || requestGeneration !== generation) return false;
      activeState = results[0].status === 'fulfilled' && results[0].value && typeof results[0].value === 'object' ? results[0].value : {};
      statusMessage = results[0].status === 'rejected' ? 'Model profile is unavailable.' : '';
      if (requests.length > 1) {
        engineSettings = results[1].status === 'fulfilled' ? results[1].value : null;
        localGgufs = results[2].status === 'fulfilled' ? results[2].value : null;
        serverStatus = results[3].status === 'fulfilled' ? results[3].value : null;
        deriveEngineState();
      }
      return render();
    }

    function close() {
      if (!visible) return;
      visible = false;
      generation += 1;
      drawer?.close?.();
    }

    function dispose() {
      disposed = true;
      visible = false;
      generation += 1;
      boundActionsHost?.removeEventListener?.('input', handleTuningChange);
      boundActionsHost?.removeEventListener?.('change', handleTuningChange);
      boundActionsHost?.removeEventListener?.('inv-segmented-change', handleEngineChange);
      boundActionsHost?.removeEventListener?.('inv-toggle-change', handleMtpChange);
      boundActionsHost = null;
      confirmDialog?.dispose?.();
      drawer?.dispose?.();
      returnFocusTarget = null;
    }

    return { open: open, close: close, dispose: dispose };
  }

  return { createModelTuningDrawerController: createModelTuningDrawerController };
});
