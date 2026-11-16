'use strict';

// The Model Library section harness, shared by the section test files (the section file sat at its line cap).
const { JSDOM } = require('jsdom');

const {
  createModelLibrarySectionController,
} = require('../../renderer/shell/renderer-settings-model-library-section');

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDom() {
  return new JSDOM(`<!doctype html><body>
    <nav class="settings-nav">
      <button data-settings-section="models">Models</button>
    </nav>
    <section class="settings-card settings-section-active" data-settings-section="models">
      <div class="settings-card-header"><h3>Models</h3></div>
      <div id="modelRunningHost"></div>
      <div id="modelLibrarySectionToolbarHost"></div>
      <div class="settings-note model-library-section-status" aria-live="polite"></div>
      <div id="modelLibrarySectionHost"></div>
    </section>
  </body>`, { pretendToBeVisual: true, url: 'http://localhost/' });
}

function diagnostics() {
  return {
    hardwareProfile: {
      gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 12000 },
      memory: { total_mb: 32000, available_mb: 24000 },
    },
    memory: { totalMb: 32000, availableMb: 24000 },
    modelRecommendations: [
      {
        pullTag: 'installed:1b',
        displayName: 'Installed model',
        tier: 'Fast',
        params: '1B',
        recommended: false,
        fitsInVram: true,
        vramRequiredMb: 1000,
      },
      {
        pullTag: 'recommended:3b',
        displayName: 'Recommended model',
        tier: 'Balanced',
        params: '3B',
        recommended: true,
        fitsInVram: true,
        vramRequiredMb: 3000,
      },
    ],
    catalogMeta: { version: 4 },
  };
}

function state() {
  return {
    features: {
      featureFlags: {},
    },
    status: { model: '' },
    offline: { preferredLocalModel: '' },
    ui: { activeSettingsSection: 'models' },
  };
}

function click(windowRef, element) {
  element.dispatchEvent(new windowRef.MouseEvent('click', { bubbles: true }));
}

function harness(t, options = {}) {
  const dom = makeDom();
  const { window: windowRef } = dom;
  const calls = [];
  const inventoryContextMenu = options.inventoryContextMenu || {
    show(config) { calls.push(['contextMenu.show', config]); },
    hide() {},
  };
  const currentState = options.state || state();
  const engine = { loadedModel: String(currentState.status?.model || '') };
  let featureChanged = null;
  let progressListener = null;
  const models = {
    async list() {
      calls.push(['list']);
      return { data: [{ id: 'installed:1b', size: 1024, engine_type: 'ollama' }] };
    },
    async listOllamaTags() {
      calls.push(['listOllamaTags']);
      return { data: [] };
    },
    async delete(payload) {
      calls.push(['delete', payload]);
      return { status: 'deleted' };
    },
    // The load/unload fakes mutate only engine-side state; the renderer's
    // state.status moves solely through the refreshModelPickers snapshot sync
    // below, mirroring the real seam (models.load cannot touch renderer state).
    async load(payload) {
      calls.push(['load', payload]);
      engine.loadedModel = typeof payload === 'string' ? payload : payload.model;
      return { status: 'ok', model: engine.loadedModel };
    },
    async unload() {
      calls.push(['unload']);
      engine.loadedModel = '';
      return { status: 'ok', model: '' };
    },
    ...(options.models || {}),
  };
  const offline = {
    async getDiagnostics() {
      calls.push(['getDiagnostics']);
      return diagnostics();
    },
    async updateSettings(payload) {
      calls.push(['updateSettings', payload]);
      return payload;
    },
    ...(options.offline || {}),
  };
  windowRef.jennyShell = {
    models,
    offline,
    engines: {
      async updateSettings(payload) {
        calls.push(['engineSettings', payload]);
        return { localEngines: { openaiCompatible: { managed: payload.managed } } };
      },
      ...(options.engines || {}),
    },
    llamaServer: {
      async listLocalGgufs() { return { ok: true, entries: [] }; },
      async getStatus() { return { ok: true, state: 'stopped' }; },
      async chooseLibraryFolder() { return { ok: true, picked: false, path: '' }; },
      ...(options.llamaServer || {}),
    },
    features: {
      onChanged(listener) {
        featureChanged = listener;
        return () => { featureChanged = null; };
      },
    },
  };
  const setupService = {
    subscribePullProgress(listener) {
      progressListener = listener;
      calls.push(['subscribePullProgress']);
      return () => calls.push(['unsubscribePullProgress']);
    },
    async startOllamaPull(payload) {
      calls.push(['startOllamaPull', payload]);
      return { requestId: payload.requestId, status: 'running' };
    },
    async cancelOllamaPull(payload) {
      calls.push(['cancelOllamaPull', payload]);
      return { cancelled: true };
    },
    ...(options.setupService || {}),
  };
  const controllerDeps = {
    state: currentState,
    windowRef,
    documentRef: windowRef.document,
    appendClientLog: (...entry) => calls.push(['log', ...entry]),
    refreshModelPickers: async () => {
      calls.push(['refreshModelPickers']);
      currentState.status = Object.assign({}, currentState.status, { model: engine.loadedModel });
    },
    openModelTuning: (...args) => calls.push(['tune', ...args]),
    openDiagnostics: () => calls.push(['diagnostics']),
    setupService,
    inventoryContextMenu,
    ...(options.deps || {}),
  };
  if (options.showToast !== false) {
    controllerDeps.showToastMessage = (...args) => calls.push(['toast', ...args]);
  }
  const controller = createModelLibrarySectionController(controllerDeps);
  t.after(() => controller.dispose());
  return {
    controller,
    windowRef,
    document: windowRef.document,
    calls,
    engine,
    state: currentState,
    card: windowRef.document.querySelector('.settings-card[data-settings-section="models"]'),
    nav: windowRef.document.querySelector('.settings-nav [data-settings-section="models"]'),
    featureChanged: () => featureChanged,
    progressListener: () => progressListener,
  };
}

function contextMenuOptions(h) {
  return h.calls.slice().reverse().find((entry) => entry[0] === 'contextMenu.show')?.[1];
}

function contextMenuItem(h, label) {
  return contextMenuOptions(h)?.items.find((item) => item.label === label);
}

const rowKeys = (h) => [...h.card.querySelectorAll('.mrow[data-model-key]')].map((el) => el.getAttribute('data-model-key'));

module.exports = { flush, deferred, makeDom, diagnostics, state, click, harness, contextMenuOptions, contextMenuItem, rowKeys };
