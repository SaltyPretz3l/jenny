/* global document, MutationObserver */

(function reasoningEffortControlsBootstrap(root) {
  'use strict';

  const profiles = root.reasoningEffortProfiles;
  if (!profiles || !root.document) {
    return;
  }

  // Keep the existing renderer state/persistence path, but widen its shared
  // normalizer before app.js captures it. This avoids a second preference owner.
  if (root.chatbarUtils) {
    root.chatbarUtils.normalizeReasoningEffort = profiles.normalizeReasoningEffort;
  }

  const modelCapabilities = new Map();
  let reconcileQueued = false;
  let disposed = false;
  let modelObserver = null;
  let pointerdownHandler = null;

  function modelListEntries(payload) {
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.models)) return payload.models;
    return [];
  }

  function capabilityKey(modelId, engineType = '') {
    return `${String(engineType || '').trim().toLowerCase() || '*'}::${String(modelId || '').trim()}`;
  }

  function selectedModelEntry(modelControl) {
    const modelId = String(modelControl?.value || '').trim();
    const option = modelControl?.selectedOptions?.[0];
    return {
      modelId,
      engineType: String(option?.dataset?.engineType || '').trim().toLowerCase(),
    };
  }

  function capabilitiesFor(modelId, engineType) {
    return modelCapabilities.get(capabilityKey(modelId, engineType))
      || modelCapabilities.get(capabilityKey(modelId))
      || null;
  }

  function applyModelCatalog(payload) {
    if (!payload || typeof payload !== 'object' || payload.available === false) {
      return false;
    }
    const nextCapabilities = new Map();
    for (const entry of modelListEntries(payload)) {
      const id = String(typeof entry === 'string' ? entry : entry?.id || '').trim();
      if (!id) continue;
      const engineType = String(entry?.engine_type || entry?.engineType || '').trim().toLowerCase();
      nextCapabilities.set(capabilityKey(id, engineType), entry?.capabilities || null);
    }
    modelCapabilities.clear();
    for (const [key, capabilities] of nextCapabilities) {
      modelCapabilities.set(key, capabilities);
    }
    queueReconcile();
    return true;
  }

  async function refreshModelCapabilities() {
    const listModels = root.jennyShell?.models?.list;
    if (typeof listModels !== 'function') return;
    try {
      const payload = await listModels();
      applyModelCatalog(payload);
    } catch (_error) {
      // The existing model picker owns user-visible backend errors. Capability
      // refresh is additive and must not make an otherwise usable picker fail.
    }
  }

  function replaceOptions(select, options, selectedValue) {
    const signature = options.map((option) => `${option.value}:${option.label}`).join('|');
    if (select.dataset.reasoningOptionsSignature !== signature) {
      select.replaceChildren(...options.map((option) => {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        return node;
      }));
      select.dataset.reasoningOptionsSignature = signature;
    }
    select.value = options.some((option) => option.value === selectedValue)
      ? selectedValue
      : profiles.AUTOMATIC_REASONING_EFFORT;
  }

  function reconcileSelect(select, modelControl) {
    if (!select) return profiles.AUTOMATIC_REASONING_EFFORT;
    const { modelId, engineType } = selectedModelEntry(modelControl);
    const capabilities = capabilitiesFor(modelId, engineType);
    const options = profiles.buildReasoningEffortOptions(modelId, capabilities);
    const prior = profiles.normalizeReasoningEffort(select.value);
    const normalized = profiles.normalizeReasoningEffortForModel(prior, modelId, capabilities);
    replaceOptions(select, options, normalized);
    const supported = options.length > 1;
    select.dataset.reasoningSupported = supported ? 'true' : 'false';
    const shell = select.closest('.composer-select-shell');
    if (shell) shell.hidden = !supported;
    select.title = supported
      ? 'Automatic uses the model default.'
      : 'Reasoning effort is not supported by this model.';
    // Mirror the neighboring model control's runtime gate (auth, send busy,
    // backend readiness) while adding the capability gate. The first startup
    // pass runs before a model is selected; without explicitly clearing our
    // unsupported disable once the model arrives, the effort picker latches
    // disabled for the rest of the renderer lifetime.
    select.disabled = !supported || Boolean(modelControl?.disabled);
    return normalized;
  }

  function reconcile() {
    reconcileQueued = false;
    if (disposed) return;
    const composerModelControl = document.getElementById('composerModelSelect');
    const composerSelect = document.getElementById('composerEffortSelect');
    const previous = profiles.normalizeReasoningEffort(composerSelect?.value);
    const normalized = reconcileSelect(composerSelect, composerModelControl);
    if (composerSelect && previous !== normalized) {
      setTimeout(() => composerSelect.dispatchEvent(new Event('change', { bubbles: true })), 0);
    }
  }

  function queueReconcile() {
    if (disposed || reconcileQueued) return;
    reconcileQueued = true;
    queueMicrotask(reconcile);
  }

  function bind() {
    const composerModelSelect = document.getElementById('composerModelSelect');
    const composerSelect = document.getElementById('composerEffortSelect');
    composerModelSelect?.addEventListener('change', () => {
      queueReconcile();
      void refreshModelCapabilities();
    }, { capture: true });
    composerSelect?.addEventListener('change', () => {
      const selected = selectedModelEntry(composerModelSelect);
      const normalized = profiles.normalizeReasoningEffortForModel(
        composerSelect.value,
        selected.modelId,
        capabilitiesFor(selected.modelId, selected.engineType),
      );
      if (composerSelect.value !== normalized) composerSelect.value = normalized;
    }, { capture: true });
    modelObserver = new MutationObserver(queueReconcile);
    if (composerModelSelect) modelObserver.observe(composerModelSelect, { childList: true, subtree: true });
    // Session restoration assigns select.value programmatically, which does not
    // emit change and is not observable as an attribute mutation. Reconcile in
    // capture phase when the model popover is opened so the effort control is
    // correct before the browser performs the click that opens the <select>.
    pointerdownHandler = (event) => {
      const target = event.target;
      if (target && typeof target.closest === 'function' && target.closest('#composerModelPillSlot')) {
        reconcile();
      }
    };
    document.addEventListener('pointerdown', pointerdownHandler, { capture: true });
    queueReconcile();
    void refreshModelCapabilities();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
  } else {
    bind();
  }

  function dispose() {
    disposed = true;
    modelObserver?.disconnect();
    modelObserver = null;
    if (pointerdownHandler) {
      document.removeEventListener('pointerdown', pointerdownHandler, { capture: true });
      pointerdownHandler = null;
    }
  }

  root.reasoningEffortControls = Object.freeze({
    applyModelCatalog,
    refreshModelCapabilities,
    reconcile,
    dispose,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
