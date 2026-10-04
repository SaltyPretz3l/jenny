'use strict';

// The Settings > Models section binds at boot, before the managed sidecar
// attaches: its first read answers "Managed sidecar is not ready yet." from
// both the installed list and Ollama's tags, and the hardware probe never
// runs. These tests pin that the status line says so once, the hardware line
// reads neutral, and both clear once the app reads the backend ready.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createModelLibrarySectionController,
} = require('../renderer/shell/renderer-settings-model-library-section');

async function flush() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const NOT_READY = { available: false, reason: 'Managed sidecar is not ready yet.', data: [] };

function readyDiagnostics() {
  return {
    hardwareProfile: {
      gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 12000 },
      memory: { total_mb: 32000, available_mb: 24000 },
    },
    memory: { totalMb: 32000, availableMb: 24000 },
    modelRecommendations: [],
    managedSidecar: { ready: true },
  };
}

function harness(t, options = {}) {
  const { window: windowRef } = new JSDOM(`<!doctype html><body>
    <section class="settings-card settings-section-active" data-settings-section="models">
      <div id="modelLibrarySectionToolbarHost"></div>
      <div class="settings-note model-library-section-status" aria-live="polite"></div>
      <div id="modelLibrarySectionHost"></div>
    </section>
  </body>`, { pretendToBeVisual: true, url: 'http://localhost/' });
  const backend = { ready: false };
  const calls = [];
  const state = {
    features: { featureFlags: { model_management_ui: true } },
    status: { model: '' },
    offline: { preferredLocalModel: '' },
    ui: { activeSettingsSection: 'models' },
  };
  windowRef.jennyShell = {
    models: {
      async list() {
        calls.push('list');
        return backend.ready ? { data: [{ id: 'installed:1b', size: 1024, engine_type: 'ollama' }] } : NOT_READY;
      },
      async listOllamaTags() {
        calls.push('listOllamaTags');
        return backend.ready ? { data: [] } : NOT_READY;
      },
    },
    offline: {
      async getDiagnostics() {
        calls.push('getDiagnostics');
        if (options.neverReady || !backend.ready) return { hardwareProfile: null, managedSidecar: { ready: false } };
        return readyDiagnostics();
      },
    },
    features: { onChanged() { return () => {}; } },
  };
  const controller = createModelLibrarySectionController({
    state,
    windowRef,
    documentRef: windowRef.document,
    appendClientLog: () => {},
    refreshModelPickers: async () => {},
    openModelTuning: () => {},
    setupService: { subscribePullProgress() { return () => {}; } },
    inventoryContextMenu: { show() {}, hide() {} },
  });
  t.after(() => controller.dispose());
  const card = windowRef.document.querySelector('.settings-card');
  return {
    controller,
    backend,
    state,
    count: (name) => calls.filter((entry) => entry === name).length,
    statusText: () => card.querySelector('.model-library-section-status').textContent,
    hardwareText: () => card.querySelector('.model-library-hardware-summary').textContent,
    rows: () => card.querySelectorAll('.model-row').length,
    markAppReady() {
      backend.ready = true;
      state.backend = { phase: 'ready' };
      state.modelList = { available: true, data: [{ id: 'installed:1b' }] };
    },
  };
}

test('a read taken before the sidecar was ready reports its reason once and clears when the backend is ready', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  assert.equal(h.statusText(), 'Managed sidecar is not ready yet.');
  assert.equal(h.hardwareText(), 'Checking hardware…');

  // The app still reads not ready: the periodic tick only re-merges.
  const before = h.count('list');
  h.controller.syncFromState();
  await flush();
  assert.equal(h.count('list'), before, 'no re-read while the app reads the backend not ready');

  h.markAppReady();
  h.controller.syncFromState();
  await flush();

  assert.equal(h.count('list'), before + 1, 'the tick re-read the sources once the app read ready');
  assert.equal(h.statusText(), '');
  assert.equal(h.hardwareText(), 'Test GPU · 11.7 GB VRAM · 23.4 GB RAM available');
  assert.equal(h.rows(), 1);

  // Caught up: later ticks go back to re-merging only.
  h.controller.syncFromState();
  await flush();
  assert.equal(h.count('list'), before + 1);
});

test('catch-up re-reads are bounded when the hardware probe never reports ready', async (t) => {
  const h = harness(t, { neverReady: true });
  h.controller.bind();
  await flush();
  h.markAppReady();
  const before = h.count('getDiagnostics');
  for (let i = 0; i < 12; i += 1) {
    h.controller.syncFromState();
    await flush();
  }
  assert.equal(h.count('getDiagnostics'), before + 5);
  assert.equal(h.hardwareText(), 'Checking hardware…');
});
