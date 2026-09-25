(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      root,
      require('../inventory/number-input'),
      require('./renderer-model-tuning-engine-utils'),
      require('./renderer-model-library-format-utils')
    );
    return;
  }
  root.rendererModelTuningDrawer = factory(root, root.inventoryNumberInput, root.rendererModelTuningEngineUtils, root.rendererModelLibraryFormatUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, bundledNumberInput, engineUtils, formatUtils) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
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
      title: jt('models.tuning.contextAndMemory', 'Context and memory'),
      fields: [
        { key: 'contextLength', label: jt('models.tuning.contextWindow', 'Context window'), kind: 'context' },
        { key: 'ratio', label: jt('models.tuning.summarizeAt', 'Summarize at'), kind: 'ratio' },
      ],
    },
    {
      title: jt('models.tuning.sampling', 'Sampling'),
      fields: [
        { key: 'temperature', label: jt('models.tuning.temperature', 'Temperature'), kind: 'profile' },
        { key: 'topP', label: jt('models.tuning.topP', 'Top P'), kind: 'profile' },
        { key: 'topK', label: jt('models.tuning.topK', 'Top K'), kind: 'profile' },
        { key: 'minP', label: jt('models.tuning.minP', 'Min P'), kind: 'profile' },
      ],
    },
    {
      title: jt('models.tuning.repetitionAndLength', 'Repetition and length'),
      fields: [
        { key: 'repetitionPenalty', label: jt('models.tuning.repetitionPenalty', 'Repetition penalty'), kind: 'profile' },
        { key: 'presencePenalty', label: jt('models.tuning.presencePenalty', 'Presence penalty'), kind: 'profile' },
        { key: 'maxOutputTokens', label: jt('models.tuning.maximumOutput', 'Maximum output'), kind: 'profile' },
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
  // Engine restarts owed by model key ({runtimeChanged, launch}): a reflected
  // engine write on the served model whose restart could not run (a chat was
  // streaming, or its tuning follow-up failed). Per window, so they survive the
  // drawer's close and reopen; each runs on its model's next Apply, and only on
  // the llama-server launch it was owed on.
  var owedRestartsByWindow = new WeakMap();

  function createModelTuningDrawerController(deps) {
    var d = deps || {};
    var shellState = d.state || {};
    var windowRef = d.windowRef || root;
    var documentRef = d.documentRef || windowRef.document;
    var owedRestarts = owedRestartsByWindow.get(windowRef) || new Map();
    owedRestartsByWindow.set(windowRef, owedRestarts);
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
    var engineTypeHint = '';
    var pickFailure = ''; // the status copy a failed pick put up
    var pickingGguf = null; // the drawer generation whose pick (dialog, then probe) is in flight
    var pickingRuntime = null;
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
      var servedEngine = activeModel === activeModelId
        ? String(shellState?.status?.engine || shellState?.status?.engine_type
          || shellState?.modelList?.engine_type || '').trim().toLowerCase()
        : '';
      // Last: the opener's hint (a Local GGUF card that is neither listed nor served).
      return servedEngine || engineTypeHint;
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
      return parsed ? Math.round(parsed / 1024) + 'K' : jt('models.tuning.modelDefault', 'Model default');
    }

    function resolveProfile() {
      return activeState?.generationProfilesByModel?.[activeModelId] || {};
    }

    function engineLabel(engineType) {
      if (engineType === 'ollama') return 'Ollama';
      if (engineType === 'vllm') return 'vLLM';
      if (engineType === 'openai-compatible') return 'llama-server';
      return engineType || jt('models.tuning.engineUnknown', 'engine unknown');
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
          options: [{ value: '', label: jt('models.tuning.modelDefault', 'Model default') }].concat(contextSteps.map(function (step) {
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
          placeholder: jt('models.tuning.modelDefault', 'Model default'),
          disabled: controlsDisabled,
          dataset: { 'model-tuning-field': definition.key },
        });
        range = 'range ' + escapeHtml(Number(bounds.min).toLocaleString(globalThis.jennyI18n?.tag?.()))
          + '–' + escapeHtml(Number(bounds.max).toLocaleString(globalThis.jennyI18n?.tag?.()));
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
        runtimeRowAvailable: typeof windowRef?.jennyShell?.llamaServer?.chooseRuntime === 'function',
      });
    }

    function buildBodyHtml() {
      var selectField = inventory.selectField || windowRef.inventorySelectField;
      var numberInput = inventory.numberInput || windowRef.inventoryNumberInput || bundledNumberInput;
      var actionButton = inventory.actionButton || windowRef.inventoryActionButton;
      if (!selectField || !numberInput || !actionButton) return '<p>' + escapeHtml(jt('models.tuning.controlsUnavailable', 'Model tuning controls are unavailable.')) + '</p>';
      var engineType = resolveEngineType();
      var engineUnknown = !engineType;
      if (engineType && !supportsTuning()) {
        return '<p class="model-tuning-drawer-copy">' + escapeHtml(jt('models.tuning.advancedUnavailableFor', 'Advanced generation tuning is not available for'))
          + ' <strong>' + escapeHtml(activeModelId) + '</strong>' + escapeHtml(jt('models.tuning.engineOwnsControlsSuffix', '. This engine owns its generation controls.')) + '</p>';
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
          + (group.fields[0]?.key === 'contextLength' && (engineUnknown || supportsContextTuning())
            ? '<p class="model-tuning-section-hint">' + escapeHtml(jt('models.tuning.contextWindowHint', 'Larger context windows retain more history and tool output but consume more RAM or VRAM.')) + '</p>'
            : '')
          + rows
          + '</section>';
      }).join('');
      return ''
        + '<p class="model-tuning-drawer-subtitle">' + escapeHtml(activeModelId) + ' · '
        + escapeHtml(engineLabel(engineType)) + ' ' + escapeHtml(jt('models.tuning.appliesAfterRuntimeConfirms', '· applies after the runtime confirms')) + '</p>'
        + (engineUnknown
          ? '<div class="model-tuning-drawer-warning" role="status"><span>' + escapeHtml(jt('models.tuning.engineUnverified', 'Jenny can\'t verify this model\'s engine yet, so tuning is paused.')) + '</span>'
            + actionButton({ id: 'recheck-model-tuning-engine', label: jt('models.tuning.recheck', 'Re-check'), variant: 'ghost', size: 'sm' })
            + '</div>'
          : '')
        // One block-level wrapper: the drawer body is a grid, and a sticky footer
        // placed directly in a grid cell has no travel. Also the container-query root.
        + '<div class="model-tuning-drawer-scroll">'
        + '<div class="model-tuning-drawer-grid"' + (engineUnknown ? ' data-disabled="true"' : '') + '>'
        + buildEngineSection() + sections
        + '</div>'
        + '<div class="model-tuning-drawer-footer">'
        + actionButton({ id: 'save-model-tuning', label: pending ? jt('models.tuning.applying', 'Applying…') : jt('models.tuning.applyNoChanges', 'Apply 0 changes'), variant: 'primary', disabled: true })
        + actionButton({ id: 'reset-model-tuning', label: jt('models.tuning.resetToDefaults', 'Reset to defaults'), variant: 'secondary', disabled: controlsDisabled })
        + '<p class="model-tuning-drawer-status" aria-live="polite">' + escapeHtml(statusMessage) + '</p>'
        + '</div>'
        + '</div>';
    }

    function recheckEngine() {
      statusMessage = resolveEngineType()
        ? ''
        : jt('models.tuning.engineStillUnverified', "Still can't verify the engine. Refresh the model list and try again.");
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
          ? jt('models.tuning.applying', 'Applying…')
          : jtn('models.tuning.applyChanges', dirty.length, { count: dirty.length }, 'Apply {count} change', 'Apply {count} changes');
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
      var runtimeRow = boundActionsHost?.querySelector?.('[data-model-tuning-row="runtimePath"]');
      if (runtimeRow) runtimeRow.hidden = engineDraft.engine !== 'llama-server';
      var status = boundActionsHost?.querySelector?.('[data-model-tuning-row="engine"] .model-tuning-row-range');
      if (status) status.textContent = engineUtils.engineStatusText(engineView, engineDraft, serverStatus);
      updateDirtyState(boundActionsHost);
    }

    function handleMtpChange(event) {
      if (event?.detail?.id !== 'modelTuningMtp' || !engineDraft) return;
      engineDraft.mtp = Boolean(event.detail.checked);
      updateDirtyState(boundActionsHost);
    }

    // Picker failures patch the status line in place: render() rebuilds the
    // inputs and would drop unapplied edits. The next successful pick (or Use
    // bundled) clears that copy, never a line a pending Apply or restart took.
    function showStatusInPlace(message) {
      statusMessage = message;
      pickFailure = message;
      var status = boundActionsHost?.querySelector?.('.model-tuning-drawer-status');
      if (status) status.textContent = message;
      else render();
    }

    function clearPickFailure() {
      if (pickFailure && !pending && statusMessage === pickFailure) showStatusInPlace('');
      pickFailure = '';
    }

    // One pick at a time per picker and drawer session: the dialog is modal, but
    // its probe can take seconds. A reopened drawer picks afresh (the old result is stale).
    async function chooseGguf() {
      if (pickingGguf === generation) return;
      var operationGeneration = pickingGguf = generation, operationModelId = activeModelId;
      try {
        var result = await windowRef.jennyShell.llamaServer.chooseGguf({
          defaultPath: engineUtils.pickerDefaultDir(engineView, engineDraft),
        });
        if (disposed || generation !== operationGeneration || activeModelId !== operationModelId) return;
        if (result && result.ok === false) return showStatusInPlace(engineUtils.pickerFailureText(result));
        if (!result?.path) return;
        engineUtils.applyPickedGguf(engineView, engineDraft, result);
        clearPickFailure();
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
          showStatusInPlace(jt('models.tuning.filePickerFailed', 'Could not open the file picker.'));
        }
      } finally {
        if (pickingGguf === operationGeneration) pickingGguf = null;
      }
    }

    // The build row, patched in place from the draft (no re-render: unapplied
    // inputs survive). Hiding a focused "Use bundled" hands focus to Choose….
    function syncRuntimeRow() {
      clearPickFailure();
      var code = boundActionsHost?.querySelector?.('[data-model-tuning-runtime]');
      if (code) { code.textContent = engineUtils.runtimeValueText(engineDraft); code.title = engineDraft.runtimePath; }
      var useBundled = boundActionsHost?.querySelector?.('[data-action="use-bundled-llama-server"]');
      if (useBundled) {
        if (!engineDraft.runtimePath && documentRef?.activeElement === useBundled) {
          boundActionsHost.querySelector('[data-action="choose-llama-server-runtime"]')?.focus?.();
        }
        useBundled.hidden = !engineDraft.runtimePath;
      }
      updateDirtyState(boundActionsHost);
    }

    // Mirrors chooseGguf: the pick only edits the draft; Apply is the commit.
    async function chooseRuntime() {
      if (pickingRuntime === generation) return;
      var operationGeneration = pickingRuntime = generation, operationModelId = activeModelId;
      try {
        var result = await windowRef.jennyShell.llamaServer.chooseRuntime({
          defaultPath: engineUtils.runtimePickerDefaultDir(engineDraft),
        });
        if (disposed || generation !== operationGeneration || activeModelId !== operationModelId) return;
        if (result && result.ok === false) return showStatusInPlace(engineUtils.runtimePickerFailureText(result));
        if (engineUtils.applyPickedRuntime(engineView, engineDraft, result)) syncRuntimeRow();
      } catch (_error) {
        if (!disposed && visible && generation === operationGeneration && activeModelId === operationModelId) {
          showStatusInPlace(jt('models.tuning.filePickerFailed', 'Could not open the file picker.'));
        }
      } finally {
        if (pickingRuntime === operationGeneration) pickingRuntime = null;
      }
    }

    function useBundledRuntime() {
      if (!engineDraft) return;
      engineDraft.runtimePath = '';
      engineDraft.runtimeBuild = 0;
      syncRuntimeRow();
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
      host?.querySelector?.('[data-action="choose-llama-server-runtime"]')?.addEventListener('click', chooseRuntime);
      host?.querySelector?.('[data-action="use-bundled-llama-server"]')?.addEventListener('click', useBundledRuntime);
      updateDirtyState(host);
    }

    function render() {
      if (!drawer || disposed || !visible) return false;
      rendering = true;
      try {
        var opened = drawer.open({
          title: jt('models.tuning.tuneModel', 'Tune {model}', { model: activeDisplayName || activeModelId }),
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
        statusMessage = jt('models.tuning.engineOwnsControls', 'This engine owns its generation controls.');
        render();
        return false;
      }
      var operationGeneration = generation;
      var operationModelId = activeModelId;
      pending = true;
      statusMessage = jt('models.tuning.applyingCheckingRuntime', 'Applying and checking the runtime…');
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
          statusMessage = jt('models.tuning.changeApplyFailed', 'The change could not be applied.');
        }
        return false;
      } finally {
        if (!disposed) {
          pending = false;
          if (visible) render();
        }
      }
    }

    // Nothing new is live yet: the restart was declined, reused a server, or its
    // model is no longer served.
    function savedNextRestartText(reason) {
      return reason === 'engine'
        ? jt('models.tuning.engineSavedNextRestart', 'Setting saved. The new engine settings will take effect on the next llama-server restart.')
        : jt('models.tuning.contextSavedNextRestart', 'Setting saved. The new context window will take effect on the next llama-server restart.');
    }

    function appliedPressUseText() {
      return jt('models.tuning.appliedPressUse', 'Applied. Press Use on this model to run it with these settings.');
    }

    // Not served now, so nothing restarts. Where the drawer showed the model
    // serving, the setting waits for a restart. Otherwise an engine write waits
    // for the model's next Use, and a context window is live at once on Ollama
    // but read by llama-server only as -c at launch: say when it takes effect.
    function notServedText(reason) {
      if (engineView?.serving) return savedNextRestartText(reason);
      if (reason === 'engine') return appliedPressUseText();
      return resolveEngineType() === 'openai-compatible'
        ? jt('models.tuning.contextSavedNextStart', 'Saved. The new context window applies the next time llama-server starts.')
        : statusMessage;
    }

    // Success copy: 'context' keeps its own; 'engine' names the build it now runs
    // when the build changed (runtimeLabel is main's bounded token, never shown raw).
    function restartSucceededText(reason, opts) {
      var label = String(serverStatus?.runtimeLabel || '');
      // A reused server Jenny did not launch ('unknown') was not relaunched: it
      // never took the new -c or engine settings.
      if (label === 'unknown') return savedNextRestartText(reason);
      if (reason !== 'engine') return jt('models.tuning.restartSucceeded', 'Restarted llama-server. The new context window is live.');
      var build = /^build ([1-9]\d{0,8})$/.exec(label);
      if (opts?.runtimeChanged && build) return jt('models.tuning.restartSucceededBuild', 'Restarted llama-server. It now runs build {build}.', { build: build[1] });
      if (opts?.runtimeChanged && label === 'bundled') return jt('models.tuning.restartSucceededBundled', 'Restarted llama-server. It now runs the bundled build.');
      return jt('models.tuning.restartSucceededEngine', 'Restarted llama-server. The new engine settings are live.');
    }

    function streamingCount() {
      var ids = getStreamingSessionIds();
      return Array.isArray(ids) ? ids.filter(Boolean).length : 0;
    }

    // The llama-server launch serving this model now, from a fresh status: its
    // pid (0 for a reused server) and the time it became ready, which any
    // relaunch changes. '' when the model is not served, null when the status
    // could not be read.
    async function servedLaunch(modelId) {
      try {
        var status = await windowRef.jennyShell.llamaServer.getStatus();
        return engineUtils.servesModel(status, modelId) ? (Number(status.pid) || 0) + '@' + (Number(status.changedAt) || 0) : '';
      } catch (_error) {
        return null;
      }
    }

    function dropOwedRestart(key) {
      var owed = owedRestarts.get(key) || null;
      owedRestarts.delete(key);
      return owed;
    }

    // Owed to the launch serving the model now; nothing when it is not served
    // (its next launch reads the saved entry).
    async function oweRestart(modelId, key, opts, launch) {
      launch = launch || await servedLaunch(modelId);
      if (!launch || disposed) return;
      var prior = owedRestarts.get(key);
      owedRestarts.set(key, {
        launch: launch,
        runtimeChanged: opts?.runtimeChanged === true || (prior?.launch === launch && prior.runtimeChanged === true),
      });
    }

    // An owed restart runs only while the launch it was owed on still serves its
    // model, checked on a fresh status (never open()'s): a relaunch already read
    // the saved entry, and restart() without a spec relaunches main's last spec,
    // which may be another model. Dropped otherwise; kept if the drawer went
    // stale or the status could not be read.
    async function takeOwedRestart(key, modelId, stale) {
      var owed = owedRestarts.get(key);
      if (!owed) return null;
      var launch = await servedLaunch(modelId);
      if (stale() || owedRestarts.get(key) !== owed || launch === null) return null;
      owedRestarts.delete(key);
      return launch && launch === owed.launch ? owed : null;
    }

    // A reflected engine write whose drawer closed or moved on still goes live,
    // with no drawer UI: restart now, or, while a chat streams, owe it. Only
    // while llama-server still serves that very model.
    async function settleDetachedRestart(modelId, key, opts) {
      var launch = await servedLaunch(modelId);
      if (!launch || disposed) return;
      if (streamingCount()) return oweRestart(modelId, key, opts, launch);
      try {
        await windowRef.jennyShell.llamaServer.restart();
      } catch (_error) { /* fail-soft: the saved entry applies at the next launch */ }
    }

    // Makes a saved setting live on the served model. reason 'context' (context
    // window) or 'engine' (engine, MTP, GGUF file, build) picks the copy; the
    // flow is shared: a fresh status, confirm only while a chat streams, then restart().
    async function restartManagedServer(reason, opts) {
      if (pending || disposed) return false;
      var engineChange = reason === 'engine';
      var operationGeneration = generation;
      var operationModelId = activeModelId;
      var stale = function () {
        return disposed || !visible || generation !== operationGeneration || activeModelId !== operationModelId;
      };
      pending = true;
      try {
        // Only while a fresh status shows this model served (an owed restart
        // brings the launch it checked), never open()'s: restart() relaunches
        // main's last spec, which may be another model by now, and a model
        // served since open() needs the restart too. A failed fetch is not
        // served; the drawer closed meanwhile: nothing. No Engine section: no restart.
        var served = engineView && (opts?.launch || await servedLaunch(operationModelId));
        if (stale()) return false;
        if (!served) {
          statusMessage = notServedText(reason);
          return false;
        }
        var streaming = streamingCount();
        if (streaming) {
          var confirmed = false;
          if (typeof confirmDialog?.confirm === 'function') {
            try {
              confirmed = await confirmDialog.confirm({
                title: jt('models.tuning.restartConfirmTitle', 'Restart llama-server?'),
                message: engineChange
                  ? jtn('models.tuning.restartStreamingWarningEngine', streaming, { count: streaming }, 'A chat is still streaming. Restarting llama-server will end that response. The new engine settings only take effect after a restart.', '{count} chats are still streaming. Restarting llama-server will end those responses. The new engine settings only take effect after a restart.')
                  : jtn('models.tuning.restartStreamingWarning', streaming, { count: streaming }, 'A chat is still streaming. Restarting llama-server will end that response. The new context window only takes effect after a restart.', '{count} chats are still streaming. Restarting llama-server will end those responses. The new context window only takes effect after a restart.'),
                confirmLabel: jt('models.tuning.restartAnyway', 'Restart anyway'),
                cancelLabel: jt('models.tuning.notNow', 'Not now'),
                variant: 'danger',
              });
            } catch (_error) { /* unavailable confirmations cancel safely */ }
          }
          if (!confirmed) {
            if (!stale()) statusMessage = savedNextRestartText(reason);
            return false;
          }
          // The dialog can stay open while llama-server moves on: check again. An
          // owed restart still needs its own launch, and drops silently otherwise.
          served = await servedLaunch(operationModelId);
          if (stale()) return false;
          if (!served || (opts?.launch && served !== opts.launch)) {
            if (!opts?.launch) statusMessage = notServedText(reason);
            return false;
          }
        }
        statusMessage = jt('models.tuning.restartingLlamaServer', 'Restarting llama-server…');
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
        if (stale()) return false;
        deriveEngineState();
        var restarted = !restartFailed && serverStatus?.ok !== false && engineView?.serving;
        // A launch code (missing build, unreadable file) names its fix instead.
        statusMessage = restarted
          ? restartSucceededText(reason, opts)
          : formatUtils?.llamaServerFailureText?.(serverStatus?.lastError, activeModelId)
            || jt('models.tuning.restartFailedSettingSaved', 'llama-server restart failed. The setting was saved and is not live yet.');
        return restarted;
      } finally {
        pending = false;
        if (!disposed && visible) render();
      }
    }

    async function save() {
      if (pending || disposed) return;
      var operationGeneration = generation, operationModelId = activeModelId;
      var stale = function () {
        return disposed || !visible || generation !== operationGeneration || activeModelId !== operationModelId;
      };
      var host = documentRef?.getElementById?.('modelTuningDrawer');
      var dirty = dirtyFields(host);
      var tuningDirty = dirty.filter(function (field) { return !['engine', 'mtp', 'modelPath', 'runtimePath'].includes(field); });
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
        // An engine restart this model still owes runs once now (it covers the context too).
        // Pending while it is checked: a second Apply would cancel the restart below.
        var owedRestart = null;
        if (applied && engineView && !pending) {
          pending = true;
          try { owedRestart = await takeOwedRestart(engineView.key, operationModelId, stale); } finally { pending = false; }
        }
        if (owedRestart) await restartManagedServer('engine', owedRestart);
        else if (applied && contextChanged && !stale()) await restartManagedServer('context');
        return applied;
      }
      var request = engineUtils.buildManagedPatch(activeModelId, engineView, engineDraft);
      var requestKey = engineView.key;
      // Engine write first; the tuning patch follows ONLY when the runtime reflected
      // the entry. `finally` clears pending even for a stale (closed/re-targeted) result.
      // A reflected write on llama-server restarts its model once, after the
      // follow-up, while it is served: engine, MTP, GGUF-file and build changes go
      // live right away.
      var toLlamaServer = request.entry.engine === 'llama-server';
      var buildSent = Object.hasOwn(request.entry, 'runtimePath');
      var restartOptions = null;
      var followUp = null;
      pending = true; statusMessage = jt('models.tuning.applyingCheckingRuntime', 'Applying and checking the runtime…'); render();
      try {
        var result = await windowRef.jennyShell.engines.updateSettings(request.payload);
        // The write landed: the library (app-wide state) hears it even if this drawer went stale.
        if (result?.localEngines) d.onEngineSettingsChanged?.(result.localEngines);
        var reflected = engineUtils.returnedEntryMatches(result?.localEngines, requestKey, request.entry, request.runtimeBuild);
        if (stale()) {
          // Closed or moved on: the write still settles what its model owed, and a
          // served model still gets its restart (no drawer UI).
          if (reflected && !disposed) {
            var owedBefore = dropOwedRestart(requestKey);
            if (toLlamaServer) {
              void settleDetachedRestart(operationModelId, requestKey, { runtimeChanged: buildSent || owedBefore?.runtimeChanged === true });
            }
          }
          return;
        }
        if (!reflected) {
          statusMessage = jt('models.tuning.engineSettingsUpdateFailed', 'Could not update the engine settings.'); // draft kept: Apply stays live for a retry
        } else {
          engineSettings = Object.assign({}, engineSettings || {}, { localEngines: result.localEngines });
          deriveEngineState();
          // This write's own restart (if any) supersedes an owed one and keeps its build
          // copy; a write off llama-server drops it.
          var owed = dropOwedRestart(requestKey);
          restartOptions = toLlamaServer ? { runtimeChanged: buildSent || owed?.runtimeChanged === true } : null;
          if (tuningDirty.length) followUp = patch;
          else if (!toLlamaServer) statusMessage = appliedPressUseText();
        }
      } catch (_error) {
        if (!stale()) statusMessage = jt('models.tuning.engineSettingsApplyFailed', 'The engine settings could not be applied.');
      } finally {
        if (!disposed) {
          pending = false;
          if (visible && !followUp) render();
        }
      }
      if (followUp) {
        var followUpApplied = await applyPatch(followUp);
        if (restartOptions) {
          if (stale()) {
            if (!disposed) await settleDetachedRestart(operationModelId, requestKey, restartOptions); // closed mid follow-up
          } else if (followUpApplied) {
            await restartManagedServer('engine', restartOptions); // exactly one restart, context included
          } else {
            // The follow-up's message stays; the model's next successful Apply restarts, after a reopen too.
            await oweRestart(operationModelId, requestKey, restartOptions);
          }
        } else if (followUpApplied && contextChanged && !stale()) {
          // Off llama-server nothing restarts: the context goes live with the next
          // Use, on the new engine (said as for any context window when it was not served).
          statusMessage = engineView?.serving ? appliedPressUseText() : notServedText('context');
          render();
        }
        return followUpApplied;
      }
      if (restartOptions) await restartManagedServer('engine', restartOptions);
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
      engineTypeHint = String(options?.engineTypeHint || '').trim().toLowerCase(); // per open(): resolveEngineType's last resort
      statusMessage = jt('models.tuning.loadingProfile', 'Loading model profile…');
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
      statusMessage = results[0].status === 'rejected' ? jt('models.tuning.profileUnavailable', 'Model profile is unavailable.') : '';
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
