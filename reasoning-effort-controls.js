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
  let lastUncatalogedRefreshKey = '';
  // Catalog reads are numbered when they start; an app-pushed snapshot counts
  // as the newest when it applies. A read older than the last applied catalog
  // is dropped, so a slow model_loading-era read cannot overwrite the ready one.
  let catalogRequestSeq = 0;
  let appliedCatalogSeq = 0;
  // Split view W2-2a: carrier pairs beyond pane 0's (attachCarriers).
  const attachedPairs = new Set();

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
    if (!modelId) {
      // "Use default" carries an empty value; the conversation then runs on the
      // backend's model, which renderSettings stamps on the select. A blank
      // value with NO selected option is a preferred model missing from the
      // options, not "Use default": it must not borrow the backend's efforts.
      if (!modelControl?.selectedOptions?.[0]) return { modelId: '', engineType: '' };
      return {
        modelId: String(modelControl?.dataset?.backendModel || '').trim(),
        engineType: String(modelControl?.dataset?.backendEngineType || '').trim().toLowerCase(),
      };
    }
    const option = modelControl?.selectedOptions?.[0];
    return {
      modelId,
      engineType: String(option?.dataset?.engineType || '').trim().toLowerCase(),
    };
  }

  // Catalog keys are engine-qualified. An option without an engine type (the
  // composer's "<model> (selected)" fallback for a preferred model the list
  // has not caught up with) resolves to the one entry with that id; two
  // engines listing the same id stay unresolved rather than guess.
  function catalogKeyFor(modelId, engineType) {
    const exact = capabilityKey(modelId, engineType);
    if (modelCapabilities.has(exact)) return exact;
    const untyped = capabilityKey(modelId);
    if (modelCapabilities.has(untyped)) return untyped;
    if (String(engineType || '').trim()) return '';
    const suffix = `::${String(modelId || '').trim()}`;
    let match = '';
    for (const key of modelCapabilities.keys()) {
      if (!key.endsWith(suffix) || key.indexOf('::') !== key.length - suffix.length) continue;
      if (match) return '';
      match = key;
    }
    return match;
  }

  function capabilitiesFor(modelId, engineType) {
    const key = catalogKeyFor(modelId, engineType);
    return key ? modelCapabilities.get(key) || null : null;
  }

  function applyModelCatalog(payload) {
    const applied = applyCatalogEntries(payload);
    if (applied) {
      catalogRequestSeq += 1;
      appliedCatalogSeq = catalogRequestSeq;
    }
    return applied;
  }

  function applyCatalogEntries(payload) {
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
    catalogRequestSeq += 1;
    const seq = catalogRequestSeq;
    try {
      const payload = await listModels();
      if (disposed || seq < appliedCatalogSeq) return;
      if (applyCatalogEntries(payload)) appliedCatalogSeq = seq;
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
    // The requested effort, not the select's value: options still built for
    // the previous model leave a valid saved effort blank, and normalizing the
    // blank would save Automatic over it.
    const prior = profiles.normalizeReasoningEffort(requestedEffort(select, modelControl));
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

  function isCataloged(modelId, engineType) {
    return Boolean(catalogKeyFor(modelId, engineType));
  }

  // renderSettings assigns the saved effort to the select; a value with no
  // matching option leaves it blank, so a stale effort would read as Automatic
  // and never be saved back. Once the catalog knows the model, the requested
  // value it carries is the one to normalize. Before that, a blank stays
  // Automatic so a startup without a catalog cannot erase a valid choice.
  function requestedEffort(select, modelControl) {
    const value = String(select?.value || '');
    if (value) return value;
    const { modelId, engineType } = selectedModelEntry(modelControl);
    return modelId && isCataloged(modelId, engineType)
      ? String(select?.dataset?.requestedEffort || '')
      : value;
  }

  // The backend can switch models (e.g. llama-server finishes loading) while
  // the composer stays on "Use default"; nothing re-fetches the catalog then.
  // Fetch once per model the catalog has not seen, never in a loop.
  function refreshForUncatalogedModel(modelControl) {
    const { modelId, engineType } = selectedModelEntry(modelControl);
    if (!modelId || isCataloged(modelId, engineType)) return;
    const key = capabilityKey(modelId, engineType);
    if (lastUncatalogedRefreshKey === key) return;
    lastUncatalogedRefreshKey = key;
    void refreshModelCapabilities();
  }

  function reconcile() {
    reconcileQueued = false;
    if (disposed) return;
    const composerModelControl = document.getElementById('composerModelSelect');
    const composerSelect = document.getElementById('composerEffortSelect');
    refreshForUncatalogedModel(composerModelControl);
    reconcileSelect(composerSelect, composerModelControl);
    for (const pair of attachedPairs) {
      refreshForUncatalogedModel(pair.modelSelect);
      reconcileSelect(pair.effortSelect, pair.modelSelect);
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

  // A second pane's model/effort carriers: the same capture listeners, options
  // observer and pointerdown reconcile as pane 0's pair, bound to that pair and
  // its pill slot. Returns the detach function; dispose() detaches every pair.
  function attachCarriers({ modelSelect = null, effortSelect = null, pillSlot = null } = {}) {
    if (disposed || (!modelSelect && !effortSelect)) return () => {};
    const onModelChange = () => {
      queueReconcile();
      void refreshModelCapabilities();
    };
    const onEffortChange = () => {
      const selected = selectedModelEntry(modelSelect);
      const normalized = profiles.normalizeReasoningEffortForModel(
        effortSelect.value,
        selected.modelId,
        capabilitiesFor(selected.modelId, selected.engineType),
      );
      if (effortSelect.value !== normalized) effortSelect.value = normalized;
    };
    const onPointerdown = (event) => {
      if (pillSlot && event.target && pillSlot.contains(event.target)) reconcile();
    };
    modelSelect?.addEventListener('change', onModelChange, { capture: true });
    effortSelect?.addEventListener('change', onEffortChange, { capture: true });
    const observer = new MutationObserver(queueReconcile);
    if (modelSelect) observer.observe(modelSelect, { childList: true, subtree: true });
    document.addEventListener('pointerdown', onPointerdown, { capture: true });
    const pair = { modelSelect, effortSelect, detach: null };
    pair.detach = () => {
      if (!attachedPairs.delete(pair)) return;
      modelSelect?.removeEventListener('change', onModelChange, { capture: true });
      effortSelect?.removeEventListener('change', onEffortChange, { capture: true });
      observer.disconnect();
      document.removeEventListener('pointerdown', onPointerdown, { capture: true });
    };
    attachedPairs.add(pair);
    queueReconcile();
    return pair.detach;
  }

  function dispose() {
    disposed = true;
    for (const pair of [...attachedPairs]) pair.detach();
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
    attachCarriers,
    dispose,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
