/* renderer/shell/renderer-settings-api-providers.js
 *
 * Settings > Models API-key providers (row 78, variant A): rows inside the
 * Cloud models group, the editor in place under its row. The main process
 * owns instances, keys and discovery (services/backend/api-provider-service.js);
 * this controller owns the view state of one host, the bridge subscription and
 * the row actions. A key goes out once through the write-only setKey; it is
 * never stored here, and the state the main process sends carries only hasKey.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsApiProviders = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const viewModule = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsApiProvidersView)
    || (typeof require === 'function' ? require('./renderer-settings-api-providers-view') : null);

  // Fields whose value and focus survive a repaint (a push can land mid-typing).
  const KEPT_FIELDS = [
    'api-provider-key', 'api-provider-name', 'api-provider-search', 'api-provider-add-model', 'api-custom',
  ];

  function normalizeState(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      enabled: source.enabled === true,
      localOnly: source.localOnly === true,
      presets: Array.isArray(source.presets) ? source.presets : [],
      maxInstances: Number.isInteger(source.maxInstances) ? source.maxInstances : 0,
      instances: (Array.isArray(source.instances) ? source.instances : []).map((instance) => ({
        ...instance,
        models: Array.isArray(instance?.models) ? instance.models : [],
        discovery: instance?.discovery && typeof instance.discovery === 'object'
          ? instance.discovery : { fetchedAt: null, error: null, rows: [] },
      })),
    };
  }

  function emptyDraft() {
    return { label: '', endpoint: '', transport: 'openai_chat_completions_v1', authProfile: 'api_key_bearer' };
  }

  function createApiProvidersController(options = {}) {
    const windowRef = options.windowRef || (typeof globalThis !== 'undefined' ? globalThis.window || globalThis : null);
    const documentRef = options.documentRef || windowRef?.document || null;
    const host = options.host || documentRef?.getElementById?.('apiProvidersHost') || null;
    const inventory = options.inventory || windowRef?.inventory || globalThis.inventory || {};
    const getBridge = typeof options.getBridge === 'function'
      ? options.getBridge : () => windowRef?.jennyShell?.apiProviders || null;
    const refreshComposerModels = typeof options.refreshComposerModels === 'function'
      ? options.refreshComposerModels
      : () => windowRef?.rendererSnapshotRefresh?.instance?.refreshSnapshots?.();
    const view = viewModule.createView({
      inventory,
      textField: (opts) => (windowRef?.inventoryTextField || globalThis.inventoryTextField)?.(opts) || '',
      selectField: (opts) => (windowRef?.inventorySelectField || globalThis.inventorySelectField)?.(opts) || '',
    });
    let state = normalizeState(null);
    const ui = {
      editing: '', replacingKey: '', pinOpen: '', confirmRemove: '', query: '', busy: '',
      addPreset: '', customDraft: null, errors: {},
    };
    let generation = 0;
    let disposed = false;
    let bound = false;
    let unsubscribe = null;
    const listeners = [];

    function instanceById(id) {
      return state.instances.find((instance) => instance.id === id) || null;
    }

    function keptFieldKey(element) {
      for (const name of KEPT_FIELDS) {
        const value = element?.getAttribute?.(`data-${name}`);
        if (value !== null && value !== undefined) return `${name}=${value}`;
      }
      return '';
    }

    function captureFields() {
      const kept = new Map();
      for (const element of host.querySelectorAll('input')) {
        const key = keptFieldKey(element);
        if (key) kept.set(key, element.value);
      }
      const active = documentRef?.activeElement;
      return { kept, focused: host.contains(active) ? keptFieldKey(active) : '' };
    }

    function restoreFields(snapshot) {
      for (const element of host.querySelectorAll('input')) {
        const key = keptFieldKey(element);
        if (key && snapshot.kept.has(key)) element.value = snapshot.kept.get(key);
        if (key && key === snapshot.focused) element.focus();
      }
    }

    function applySearch() {
      const query = ui.query.trim().toLowerCase();
      for (const row of host.querySelectorAll('[data-api-model]')) {
        row.hidden = Boolean(query) && !row.getAttribute('data-api-model').toLowerCase().includes(query);
      }
    }

    function render() {
      if (disposed || !host || typeof inventory.settingsField !== 'function') return;
      if (!ui.addPreset) ui.addPreset = state.presets[0]?.id || viewModule.CUSTOM_PRESET_ID;
      if (ui.editing && !instanceById(ui.editing)) ui.editing = '';
      const snapshot = captureFields();
      host.innerHTML = view.render(state, ui);
      restoreFields(snapshot);
      applySearch();
    }

    function adopt(raw) {
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.instances)) return false;
      state = normalizeState(raw);
      return true;
    }

    async function refresh() {
      const ticket = ++generation;
      try {
        const result = await getBridge()?.getState?.();
        if (!disposed && ticket === generation) adopt(result);
      } catch (_error) { /* the group renders nothing until a state arrives */ }
      render();
    }

    function refreshComposerSoon() {
      if (!disposed) Promise.resolve().then(refreshComposerModels).catch(() => {});
    }

    // One action at a time; the main process pushes the new state, and a
    // refused action shows its coded message under the editor or the add row.
    async function run(kind, errorScope, task) {
      if (disposed || ui.busy) return null;
      ui.busy = kind;
      delete ui.errors[errorScope];
      render();
      let result = null;
      try {
        result = await task(getBridge());
        if (result && result.ok === false && kind !== `discover:${errorScope}`) {
          ui.errors[errorScope] = viewModule.errorText(result.code, instanceById(errorScope)?.label, result.status);
        }
      } catch (_error) {
        ui.errors[errorScope] = viewModule.errorText('');
      } finally {
        ui.busy = '';
        render();
      }
      return result;
    }

    function inputValue(selector) {
      return String(host.querySelector(selector)?.value || '');
    }

    function closeEditorState() {
      ui.replacingKey = '';
      ui.pinOpen = '';
      ui.confirmRemove = '';
      ui.query = '';
    }

    async function saveKey(instanceId) {
      const field = host.querySelector(`[data-api-provider-key="${instanceId}"]`);
      const key = String(field?.value || '').trim();
      if (!key) {
        ui.errors[instanceId] = viewModule.errorText('invalid_key');
        render();
        return;
      }
      // Another action in flight: keep the pasted key in the field rather than drop it.
      if (disposed || ui.busy) return;
      if (field) field.value = '';
      const result = await run('key', instanceId, (bridge) => bridge.setKey({ instanceId, key }));
      if (result?.ok) {
        ui.replacingKey = '';
        // A fresh key with nothing listed yet loads the list straight away.
        const instance = instanceById(instanceId);
        if (instance && !instance.discovery.fetchedAt) void discover(instanceId);
        else render();
      }
    }

    function discover(instanceId) {
      return run(`discover:${instanceId}`, instanceId, (bridge) => bridge.discover({ instanceId }));
    }

    async function addProvider() {
      if (ui.addPreset === viewModule.CUSTOM_PRESET_ID) {
        if (!ui.customDraft) {
          ui.customDraft = emptyDraft();
          render();
          host.querySelector('[data-api-custom="label"]')?.focus?.();
          return;
        }
      }
      const request = ui.addPreset === viewModule.CUSTOM_PRESET_ID
        ? { presetId: viewModule.CUSTOM_PRESET_ID, ...ui.customDraft }
        : { presetId: ui.addPreset };
      const result = await run('add', 'add', (bridge) => bridge.addInstance(request));
      if (result?.ok) {
        ui.customDraft = null;
        closeEditorState();
        ui.editing = result.instanceId;
        render();
        host.querySelector(`[data-api-provider-key="${result.instanceId}"]`)?.focus?.();
      }
    }

    function pinValue(selector) {
      const value = Number.parseInt(inputValue(selector), 10);
      return Number.isFinite(value) && value > 0 ? value : undefined;
    }

    const ACTIONS = {
      apiProvidersToggleEditor: (id) => {
        ui.editing = ui.editing === id ? '' : id;
        closeEditorState();
        render();
      },
      apiProvidersSaveKey: (id) => saveKey(id),
      apiProvidersReplaceKey: (id) => { ui.replacingKey = id; render(); host.querySelector(`[data-api-provider-key="${id}"]`)?.focus?.(); },
      apiProvidersCancelReplace: () => { ui.replacingKey = ''; render(); },
      apiProvidersClearKey: (id) => run('key', id, (bridge) => bridge.clearKey({ instanceId: id })),
      apiProvidersDiscover: (id) => discover(id),
      apiProvidersLimits: (_id, target) => {
        const model = target.getAttribute('data-model') || '';
        ui.pinOpen = ui.pinOpen === model ? '' : model;
        render();
      },
      apiProvidersSavePin: (_id, target) => {
        // Read before run() repaints the row.
        const pin = { contextLength: pinValue('#apiProvidersPinContext'), maxOutputTokens: pinValue('#apiProvidersPinOutput') };
        return run('pin', ui.editing, (bridge) => bridge.setModelPin({
          instanceId: ui.editing, modelId: target.getAttribute('data-model'), pin,
        }));
      },
      apiProvidersClearPin: (_id, target) => run('pin', ui.editing, (bridge) => bridge.setModelPin({
        instanceId: ui.editing, modelId: target.getAttribute('data-model'), pin: {},
      })).then(() => { ui.pinOpen = ''; render(); }),
      apiProvidersAddModel: async (id) => {
        const modelId = inputValue(`[data-api-provider-add-model="${id}"]`).trim();
        if (!modelId) return;
        const result = await run('model', id, (bridge) => bridge.setModelEnabled({ instanceId: id, modelId, enabled: true }));
        const field = host.querySelector(`[data-api-provider-add-model="${id}"]`);
        if (result?.ok && field) field.value = '';
      },
      apiProvidersRemoveAsk: (id) => { ui.confirmRemove = id; render(); },
      apiProvidersRemoveCancel: () => { ui.confirmRemove = ''; render(); },
      apiProvidersRemoveConfirm: async (id) => {
        const result = await run('remove', id, (bridge) => bridge.removeInstance({ instanceId: id }));
        if (result?.ok) {
          ui.editing = '';
          closeEditorState();
          render();
        }
      },
      apiProvidersAdd: () => addProvider(),
      apiProvidersCustomSubmit: () => addProvider(),
      apiProvidersCustomCancel: () => { ui.customDraft = null; delete ui.errors.add; render(); },
    };

    function onClick(event) {
      const target = event?.target?.closest?.('[data-action]');
      if (!target || target.disabled || !host?.contains?.(target)) return;
      const handler = ACTIONS[target.getAttribute('data-action')];
      if (handler) void handler(target.getAttribute('data-instance') || '', target);
    }

    function onInput(event) {
      const target = event?.target;
      if (target?.hasAttribute?.('data-api-provider-search')) {
        ui.query = target.value;
        applySearch();
      } else if (target?.hasAttribute?.('data-api-custom') && ui.customDraft) {
        ui.customDraft[target.getAttribute('data-api-custom')] = target.value;
      }
    }

    function onChange(event) {
      const target = event?.target;
      if (!target?.getAttribute) return;
      const toggle = target.getAttribute('data-api-model-toggle');
      if (toggle !== null && ui.editing) {
        void run('model', ui.editing, (bridge) => bridge.setModelEnabled({
          instanceId: ui.editing, modelId: toggle, enabled: target.checked === true,
        }));
      } else if (target.hasAttribute('data-api-provider-preset')) {
        ui.addPreset = target.value;
        if (ui.addPreset !== viewModule.CUSTOM_PRESET_ID) ui.customDraft = null;
        delete ui.errors.add;
        render();
      } else if (target.hasAttribute('data-api-custom') && ui.customDraft) {
        ui.customDraft[target.getAttribute('data-api-custom')] = target.value;
        if (target.getAttribute('data-api-custom') === 'transport') {
          ui.customDraft.authProfile = viewModule.TRANSPORT_AUTH[target.value]?.[0] || 'api_key_bearer';
          render();
        }
      } else if (target.hasAttribute('data-api-provider-name')) {
        const instanceId = target.getAttribute('data-api-provider-name');
        const label = String(target.value || '').trim();
        if (label && label !== instanceById(instanceId)?.label) {
          void run('rename', instanceId, (bridge) => bridge.renameInstance({ instanceId, label }));
        }
      }
    }

    function onKeyDown(event) {
      if (event.key !== 'Enter') return;
      const target = event.target;
      const keyFor = target?.getAttribute?.('data-api-provider-key');
      const modelFor = target?.getAttribute?.('data-api-provider-add-model');
      if (keyFor) {
        event.preventDefault();
        void saveKey(keyFor);
      } else if (modelFor) {
        event.preventDefault();
        void ACTIONS.apiProvidersAddModel(modelFor);
      } else if (target?.hasAttribute?.('data-api-custom')) {
        event.preventDefault();
        void addProvider();
      }
    }

    function onChanged(raw) {
      if (disposed) return;
      generation += 1;
      if (adopt(raw)) refreshComposerSoon();
      render();
    }

    function bind() {
      if (bound || disposed) return;
      bound = true;
      if (host?.addEventListener) {
        const register = (target, type, handler) => {
          target.addEventListener(type, handler);
          listeners.push(() => target.removeEventListener(type, handler));
        };
        register(host, 'click', onClick);
        register(host, 'input', onInput);
        register(host, 'change', onChange);
        register(host, 'keydown', onKeyDown);
      }
      try {
        const maybe = getBridge()?.onChanged?.(onChanged);
        if (typeof maybe === 'function') unsubscribe = maybe;
      } catch (_error) { /* the group still refreshes on bind */ }
      void refresh();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      try { unsubscribe?.(); } catch (_error) { /* best effort */ }
      for (const cleanup of listeners.splice(0)) cleanup();
    }

    return { bind, dispose, refresh, render, getState: () => normalizeState(state), ui };
  }

  function bindApiProvidersSettings(windowRef, registerCleanup) {
    const controller = createApiProvidersController({ windowRef, documentRef: windowRef.document });
    controller.bind();
    registerCleanup(() => controller.dispose());
    return controller;
  }

  return { bindApiProvidersSettings, createApiProvidersController, normalizeState };
});
