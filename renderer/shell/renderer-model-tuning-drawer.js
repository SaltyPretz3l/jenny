(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      root,
      require('../inventory/number-input'),
      require('./renderer-model-tuning-engine-utils'),
      require('./renderer-model-library-format-utils'),
      require('./renderer-model-tuning-rows')
    );
    return;
  }
  root.rendererModelTuningDrawer = factory(root, root.inventoryNumberInput, root.rendererModelTuningEngineUtils, root.rendererModelLibraryFormatUtils, root.rendererModelTuningRows);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, bundledNumberInput, engineUtils, formatUtils, rows) {
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
  // The generation-profile fields, in collect order (rows: renderer-model-tuning-rows.js).
  var PROFILE_KEYS = ['temperature', 'topP', 'topK', 'minP', 'repetitionPenalty', 'presencePenalty', 'maxOutputTokens'];
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
    // Row 54: an NInfer row's drawer (context window + MTP through jennyShell.ninfer).
    var ninferModule = root.rendererModelTuningNinfer || (typeof require === 'function' ? require('./renderer-model-tuning-ninfer') : null);
    var ninferSection = null;
    var pickFailure = ''; // the status copy a failed pick put up
    var pickingGguf = null; // the drawer generation whose pick (dialog, then probe) is in flight
    var pickingRuntime = null;
    var advancedOpen = null; // Advanced sampling fold: null until the first render decides
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

    const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
      || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

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

    function ninferActive() {
      return Boolean(ninferSection && ninferSection.active());
    }

    function supportsContextTuning() {
      var engineType = resolveEngineType();
      // NInfer's context window is the runtime's own (--max-context), set in its section.
      return Boolean(engineType) && (engineType === 'ollama' || engineType === 'openai-compatible') && !ninferActive();
    }

    function engineSectionEnabled() {
      var engineType = resolveEngineType();
      return shellState?.features?.featureFlags?.llama_server_acceleration === true
        && (engineType === 'ollama' || engineType === 'openai-compatible')
        && Boolean(windowRef?.jennyShell?.engines) && !ninferActive();
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
      if (engineType === 'openai-compatible') {
        // NInfer serves this engine when the row says so, or the status snapshot names NInfer as the
        // managed server for this very model; another row keeps its llama-server identity.
        var managed = (activeState?.status || shellState?.diagnosticsSnapshot)?.runtime?.managed_server;
        var servesThisModel = managed?.kind === 'ninfer' && String(managed.alias || '') === String(activeModelId || '');
        return ninferActive() || servesThisModel ? 'NInfer' : 'llama-server';
      }
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

    function buildEngineSection() {
      if (ninferActive()) {
        var selectFieldModule = inventory.selectField || windowRef.inventorySelectField;
        var ninferToggle = inventory.toggleSwitch || windowRef.inventoryToggleSwitch;
        return ninferSection.html({
          selectField: selectFieldModule, pending: pending,
          toggleSwitch: typeof ninferToggle === 'function' ? ninferToggle : ninferToggle?.toggleSwitch,
          actionButton: inventory.actionButton || windowRef.inventoryActionButton,
          rowHtml: rows.rowHtml, sectionHtml: rows.sectionHtml,
        });
      }
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

    function contextBounds() {
      var b = activeState?.contextLengthBounds || {};
      return { min: Number(b.min) || rows.CONTEXT_BOUNDS.min, max: Number(b.max) || rows.CONTEXT_BOUNDS.max };
    }

    function savedAnything() {
      return Object.keys(resolveProfile()).length > 0 || activeState?.ratioByModel?.[activeModelId] != null
        || (supportsContextTuning() && activeState?.contextLengthByModel?.[activeModelId] != null);
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
      var profile = resolveProfile();
      // Decided once the profile has loaded (the loading render must not close it).
      if (advancedOpen == null && activeState) advancedOpen = rows.advancedHasValues(profile);
      var sections = rows.tuningSectionsHtml({
        escapeHtml: escapeHtml, actionButton: actionButton, selectField: selectField, numberInput: numberInput,
        disabled: controlsDisabled, profile: profile, profileBounds: profileBounds,
        ratioValue: activeState?.ratioByModel?.[activeModelId],
        ratioBounds: activeState?.ratioBounds || { min: 0.1, max: 0.99 },
        showContext: engineUnknown || supportsContextTuning(),
        contextSteps: Array.isArray(activeState?.contextLengthSteps) ? activeState.contextLengthSteps : [],
        contextValue: activeState?.contextLengthByModel?.[activeModelId] || '',
        contextBounds: contextBounds(), formatContextLength: formatContextLength,
        contextNote: engineUtils.servedContextNote(engineView, serverStatus, formatContextLength),
        advancedOpen: advancedOpen === true,
      });
      var engineSection = buildEngineSection();
      return ''
        // No Engine section to name the engine: one line does.
        + (engineSection || engineUnknown ? '' : '<p class="model-tuning-drawer-subtitle">'
          + escapeHtml(jt('models.tuning.runsOn', 'Runs on {engine}.', { engine: engineLabel(engineType) })) + '</p>')
        + (engineUnknown
          ? '<div class="model-tuning-drawer-warning" role="status"><span>' + escapeHtml(jt('models.tuning.engineUnverified', 'Jenny can\'t verify this model\'s engine yet, so tuning is paused.')) + '</span>'
            + actionButton({ id: 'recheck-model-tuning-engine', label: jt('models.tuning.recheck', 'Re-check'), variant: 'ghost', size: 'sm' })
            + '</div>'
          : '')
        // One block-level wrapper: the drawer body is a grid, and a sticky footer
        // placed directly in a grid cell has no travel. Also the container-query root.
        + '<div class="model-tuning-drawer-scroll">'
        // data-engine-type: the engine Jenny resolved for this model (drivers read it).
        + '<div class="model-tuning-drawer-grid" data-engine-type="' + escapeHtml(engineType) + '"' + (engineUnknown ? ' data-disabled="true"' : '') + '>'
        + engineSection + sections
        + '</div>'
        + '<div class="model-tuning-drawer-footer">'
        + '<p class="model-tuning-drawer-status" aria-live="polite">' + escapeHtml(statusMessage) + '</p>'
        + '<div class="model-tuning-drawer-actions">'
        + actionButton({ id: 'save-model-tuning', label: pending ? jt('models.tuning.applying', 'Applying…') : jt('models.tuning.noChanges', 'No changes'), variant: 'primary', disabled: true })
        + rows.hiddenHtml(actionButton({ id: 'discard-model-tuning', label: jt('models.tuning.discard', 'Discard'), variant: 'secondary', disabled: pending }))
        + actionButton({ id: 'reset-model-tuning', label: jt('models.tuning.resetToDefaults', 'Reset to defaults'), variant: 'secondary', className: 'model-tuning-reset',
          title: jt('models.tuning.resetHint', 'Clears every sampling and memory value for this model. The engine choice stays. Apply to save.'),
          disabled: controlsDisabled || !savedAnything() })
        + '</div></div>'
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
      PROFILE_KEYS.forEach(function (key) {
        var input = host?.querySelector?.('[data-model-tuning-field="' + key + '"]');
        if (input && !numericValuesMatch(input.value, profile[key])) dirty.push(key);
      });
      // Summarize at is a percentage field over a stored ratio.
      var ratio = host?.querySelector?.('#modelTuningRatio');
      if (ratio && !numericValuesMatch(ratio.value, rows.ratioPercent(activeState?.ratioByModel?.[activeModelId]))) {
        dirty.push('ratio');
      }
      var contextValue = rows.readContextValue(host);
      if (contextValue != null && !numericValuesMatch(contextValue, activeState?.contextLengthByModel?.[activeModelId])) {
        dirty.push('contextLength');
      }
      if (engineSectionEnabled() && engineDraft) {
        dirty.push.apply(dirty, engineUtils.engineDirtyFields(engineView, engineDraft));
      }
      if (ninferActive()) dirty.push.apply(dirty, ninferSection.dirtyRows());
      return dirty;
    }

    function updateDirtyState(host) {
      var dirty = dirtyFields(host);
      var dirtySet = new Set(dirty);
      var busy = pending || (ninferActive() && ninferSection.busy());
      var contextInvalid = rows.contextValueInvalid(host, contextBounds());
      var saveButton = host?.querySelector?.('[data-action="save-model-tuning"]');
      if (saveButton) {
        saveButton.textContent = busy
          ? jt('models.tuning.applying', 'Applying…')
          : dirty.length
            ? jtn('models.tuning.applyChanges', dirty.length, { count: dirty.length }, 'Apply {count} change', 'Apply {count} changes')
            : jt('models.tuning.noChanges', 'No changes');
        saveButton.disabled = busy || !supportsTuning() || dirty.length === 0 || contextInvalid;
      }
      var discard = host?.querySelector?.('[data-action="discard-model-tuning"]');
      if (discard) Object.assign(discard, { hidden: dirty.length === 0, disabled: busy });
      host?.querySelectorAll?.('[data-model-tuning-row]').forEach(function (row) {
        var changed = row.querySelector('[data-model-tuning-changed]');
        if (changed) changed.hidden = !dirtySet.has(row.dataset.modelTuningRow);
        var revert = row.querySelector('[data-model-tuning-revert]');
        var input = revert && row.querySelector('[data-model-tuning-field]');
        // Revert follows its field: hidden when empty, disabled while the grid is locked.
        if (revert) Object.assign(revert, { hidden: !input || String(input.value || '').trim() === '', disabled: busy || !resolveEngineType() });
      });
      var contextNote = host?.querySelector?.('[data-model-tuning-row="contextLength"] [data-model-tuning-note]');
      if (contextNote) {
        contextNote.textContent = contextInvalid
          ? rows.contextInvalidText(contextBounds())
          : engineUtils.servedContextNote(engineView, serverStatus, formatContextLength);
        contextNote.dataset.invalid = contextInvalid ? 'true' : 'false';
      }
    }

    // Custom… shows the token field (seeded with the saved size); a preset hides it.
    function syncContextCustom(host, seed) {
      var select = host?.querySelector?.('#modelTuningContextLength');
      var wrap = host?.querySelector?.('[data-model-tuning-context-custom]');
      if (!select || !wrap) return;
      var custom = select.value === rows.CUSTOM_CONTEXT;
      var input = wrap.querySelector('input');
      if (custom && seed && input && !input.value) input.value = String(activeState?.contextLengthByModel?.[activeModelId] || '');
      wrap.hidden = !custom;
      if (custom && seed) input?.focus?.();
    }

    function revertField(event) {
      var key = event?.target?.closest?.('[data-model-tuning-revert]')?.dataset?.modelTuningRevert;
      var input = key && boundActionsHost?.querySelector?.('[data-model-tuning-field="' + key + '"]');
      if (!input || input.disabled || pending) return;
      input.value = '';
      input.focus?.();
      updateDirtyState(boundActionsHost);
    }

    // Back to the saved settings: every draft (fields, engine, NInfer) is rebuilt.
    function discardDraft() {
      // Never mid-apply: discarding the NInfer draft then would leave a change that undoes the apply.
      if (pending || (ninferActive() && ninferSection.busy())) return;
      if (engineView) deriveEngineState();
      if (ninferActive()) ninferSection.discard?.();
      statusMessage = '';
      render();
    }

    function handleTuningChange(event) {
      // The NInfer context select keeps its own draft and Apply; it is no generic tuning field.
      if (ninferActive() && ninferSection.onChange(event)) { render(); return; }
      if (event?.type === 'change' && event.target?.id === 'modelTuningContextLength') syncContextCustom(boundActionsHost, true);
      updateDirtyState(boundActionsHost);
    }

    function applyNinfer() {
      if (!ninferActive()) return;
      void ninferSection.apply(function () { if (visible && !disposed) render(); });
    }

    function handleEngineChange(event) {
      if (event?.detail?.id !== 'modelTuningEngine' || !engineDraft) return;
      engineDraft.engine = event.detail.value;
      var mtpRow = boundActionsHost?.querySelector?.('[data-model-tuning-row="mtp"]');
      if (mtpRow) mtpRow.hidden = engineDraft.engine !== 'llama-server';
      var runtimeRow = boundActionsHost?.querySelector?.('[data-model-tuning-row="runtimePath"]');
      if (runtimeRow) runtimeRow.hidden = engineDraft.engine !== 'llama-server';
      var status = boundActionsHost?.querySelector?.('[data-model-tuning-engine] [data-model-tuning-section-status]');
      if (status) status.textContent = engineUtils.engineStatusText(engineView, engineDraft, serverStatus);
      updateDirtyState(boundActionsHost);
    }

    function handleMtpChange(event) {
      if (ninferActive() && ninferSection.onToggle(event)) { render(); return; }
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
        var note = boundActionsHost?.querySelector?.('[data-model-tuning-row="mtp"] [data-model-tuning-note]');
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
      if (code) {
        code.textContent = engineUtils.runtimeValueText(engineDraft); code.title = engineDraft.runtimePath;
        code.classList?.toggle?.('model-tuning-gguf-path--plain', !engineDraft.runtimePath);
      }
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
        host.addEventListener('click', revertField);
      }
      // Load-bearing: the number-input primitive does not emit a disabled
      // attribute, so the numeric fields are only disabled here.
      var controlsDisabled = pending || !resolveEngineType();
      host?.querySelectorAll?.('.model-tuning-drawer-grid input, .model-tuning-drawer-grid select').forEach(function (control) {
        control.disabled = controlsDisabled;
      });
      host?.querySelector?.('[data-action="save-model-tuning"]')?.addEventListener('click', save);
      host?.querySelector?.('[data-action="reset-model-tuning"]')?.addEventListener('click', reset);
      host?.querySelector?.('[data-action="discard-model-tuning"]')?.addEventListener('click', discardDraft);
      host?.querySelector?.('[data-action="recheck-model-tuning-engine"]')?.addEventListener('click', recheckEngine);
      host?.querySelector?.('[data-action="choose-model-gguf"]')?.addEventListener('click', chooseGguf);
      host?.querySelector?.('[data-action="choose-llama-server-runtime"]')?.addEventListener('click', chooseRuntime);
      host?.querySelector?.('[data-action="use-bundled-llama-server"]')?.addEventListener('click', useBundledRuntime);
      host?.querySelector?.('[data-action="apply-ninfer-tuning"]')?.addEventListener('click', applyNinfer);
      updateDirtyState(host);
    }

    function render() {
      if (!drawer || disposed || !visible) return false;
      rendering = true;
      try {
        // innerHTML re-renders close a <details>: carry its state over.
        var fold = documentRef?.getElementById?.('modelTuningDrawer')?.querySelector?.('[data-model-tuning-fold]');
        if (fold && advancedOpen != null) advancedOpen = fold.open;
        var opened = drawer.open({
          title: jt('models.tuning.tuneModel', 'Tune {model}', { model: activeDisplayName || activeModelId }),
          bodyHtml: buildBodyHtml(),
          restoreFocusTo: returnFocusTarget,
        });
        var heading = documentRef?.getElementById?.('modelTuningDrawer')?.querySelector?.('.inv-drawer-header h2');
        heading?.setAttribute?.('data-tooltip', activeDisplayName || activeModelId);
        bindDrawerActions();
        return opened;
      } finally {
        rendering = false;
      }
    }

    function collectProfile(host) {
      var profile = {};
      PROFILE_KEYS.forEach(function (key) {
        var input = host?.querySelector?.('[data-model-tuning-field="' + key + '"]');
        var value = String(input?.value || '').trim();
        if (value) profile[key] = Number(value);
      });
      return profile;
    }

    // Every render rebuilds the fields from the saved state. An Apply refused
    // because the runtime is busy (an image render holds the GPU, or a reply is
    // streaming) puts the user's pending values back: its copy says to Apply
    // again, so the change must still be there (other failures re-render from
    // the stored profile, as before).
    var DRAFT_KEEPING_REFUSALS = { gpu_lease_held: true, active_stream: true };
    function readTuningDraft(host) {
      var draft = {};
      host?.querySelectorAll?.('[data-model-tuning-field]').forEach(function (control) {
        draft[control.dataset.modelTuningField] = control.value;
      });
      return draft;
    }

    function restoreTuningDraft(draft) {
      var host = documentRef?.getElementById?.('modelTuningDrawer');
      Object.keys(draft || {}).forEach(function (key) {
        var control = host?.querySelector?.('[data-model-tuning-field="' + key + '"]');
        if (control) control.value = draft[key];
      });
      syncContextCustom(host, false);
      updateDirtyState(host);
    }

    async function applyPatch(patch, draft) {
      if (pending || disposed) return false;
      if (!supportsTuning()) {
        statusMessage = jt('models.tuning.engineOwnsControls', 'This engine owns its generation controls.');
        render();
        return false;
      }
      var operationGeneration = generation;
      var operationModelId = activeModelId;
      var pendingDraft = draft || readTuningDraft(documentRef?.getElementById?.('modelTuningDrawer'));
      var keepDraft = false;
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
        keepDraft = result?.status === 'rejected' && DRAFT_KEEPING_REFUSALS[result?.reason] === true;
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
          if (keepDraft && visible && generation === operationGeneration && activeModelId === operationModelId) {
            restoreTuningDraft(pendingDraft);
          }
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
      if (pending || disposed || (ninferActive() && ninferSection.busy())) return;
      var operationGeneration = generation, operationModelId = activeModelId;
      var stale = function () {
        return disposed || !visible || generation !== operationGeneration || activeModelId !== operationModelId;
      };
      var host = documentRef?.getElementById?.('modelTuningDrawer');
      // NInfer rows count toward "Apply N changes": Apply commits them too, after the profile.
      var ninferRows = ninferActive() ? ninferSection.dirtyRows() : [];
      var dirty = dirtyFields(host).filter(function (field) { return !ninferRows.includes(field); });
      var draft = readTuningDraft(host);
      var tuningDirty = dirty.filter(function (field) { return !['engine', 'mtp', 'modelPath', 'runtimePath'].includes(field); });
      if (rows.contextValueInvalid(host, contextBounds())) return;
      var ratioRaw = String(host?.querySelector?.('#modelTuningRatio')?.value || '').trim();
      var patch = { generationProfile: collectProfile(host) };
      // Whole percents only: the field shows a rounded percent, so a stored 85.5 could never be typed back.
      if (dirty.includes('ratio')) patch.ratio = ratioRaw ? Math.round(Number(ratioRaw)) / 100 : null;
      var contextRaw = rows.readContextValue(host);
      if (contextRaw != null) {
        var contextLength = contextRaw ? Number(contextRaw) : null;
        var hydratedContextLength = activeState?.contextLengthByModel?.[activeModelId];
        hydratedContextLength = hydratedContextLength == null ? null : Number(hydratedContextLength);
        if (contextLength !== hydratedContextLength) patch.contextLength = contextLength;
      }
      var contextChanged = Object.hasOwn(patch, 'contextLength');
      if (ninferRows.length) { // no Engine section beside NInfer: nothing else restarts
        var profileApplied = dirty.length ? await applyPatch(patch, draft) : true;
        if (!dirty.length) statusMessage = '';
        return profileApplied && !stale() ? ninferSection.apply(function () { if (visible && !disposed) render(); }) : profileApplied;
      }
      if (tuningDirty.length === dirty.length) {
        var applied = await applyPatch(patch, draft);
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
        var followUpApplied = await applyPatch(followUp, draft);
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

    // Reset clears the fields into a draft (the engine choice stays); Apply commits it.
    function reset() {
      var host = boundActionsHost;
      host?.querySelectorAll?.('.model-tuning-drawer-grid [data-model-tuning-field]').forEach(function (control) {
        if (control.closest('[data-model-tuning-engine]') || control.closest('[data-model-tuning-ninfer]')) return;
        control.value = '';
      });
      syncContextCustom(host, false);
      updateDirtyState(host);
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
      advancedOpen = null; activeState = null; // the fold decides from this model's loaded profile
      if (!ninferSection && ninferModule && typeof ninferModule.createNinferTuningSection === 'function') {
        ninferSection = ninferModule.createNinferTuningSection({
          windowRef: windowRef, escapeHtml: escapeHtml, confirmDialog: confirmDialog,
          getStreamingCount: function () { return streamingCount(); },
        });
      }
      statusMessage = jt('models.tuning.loadingProfile', 'Loading model profile…');
      render();
      var requests = [Promise.resolve().then(function () { return api()?.getState?.(); })];
      if (ninferSection) requests.push(ninferSection.open(options?.ninfer || null));
      if (engineSectionEnabled()) requests.push(
        Promise.resolve().then(function () { return windowRef.jennyShell.engines.getSettings(); }),
        Promise.resolve().then(function () { return windowRef.jennyShell.llamaServer?.listLocalGgufs?.(); }),
        Promise.resolve().then(function () { return windowRef.jennyShell.llamaServer?.getStatus?.(); })
      );
      var results = await Promise.allSettled(requests);
      if (disposed || requestGeneration !== generation) return false;
      activeState = results[0].status === 'fulfilled' && results[0].value && typeof results[0].value === 'object' ? results[0].value : {};
      statusMessage = results[0].status === 'rejected' ? jt('models.tuning.profileUnavailable', 'Model profile is unavailable.') : '';
      // The NInfer section's read (when present) sits right after the profile; the engine reads follow it.
      var engineResults = ninferSection ? results.slice(2) : results.slice(1);
      if (engineResults.length) {
        engineSettings = engineResults[0].status === 'fulfilled' ? engineResults[0].value : null;
        localGgufs = engineResults[1].status === 'fulfilled' ? engineResults[1].value : null;
        serverStatus = engineResults[2].status === 'fulfilled' ? engineResults[2].value : null;
        deriveEngineState();
      }
      return render();
    }

    function close() {
      if (!visible) return;
      visible = false;
      generation += 1;
      if (ninferSection) ninferSection.close();
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
      boundActionsHost?.removeEventListener?.('click', revertField);
      boundActionsHost = null;
      confirmDialog?.dispose?.();
      drawer?.dispose?.();
      returnFocusTarget = null;
    }

    return { open: open, close: close, dispose: dispose };
  }

  return { createModelTuningDrawerController: createModelTuningDrawerController };
});
