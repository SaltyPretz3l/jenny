'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createModelLibrarySectionController,
} = require('../renderer/shell/renderer-settings-model-library-section');
const modelLibraryView = require('../renderer/shell/model-library/model-library-view');

const ACCELERATION_CATALOG = {
  defaults: { vramHeadroomMb: 2048 },
  families: [{ family: 'gemma4', matchPrefixes: ['gemma4', 'gemma-4'], mtp: 'yes' }],
};

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function makeDom() {
  return new JSDOM(`<!doctype html><body>
    <nav class="settings-nav"><button data-settings-section="modelLibrary">Model library</button></nav>
    <section class="settings-card" data-settings-section="modelLibrary">
      <div id="modelLibrarySectionToolbarHost"></div>
      <div class="model-library-section-status" aria-live="polite"></div>
      <div id="modelLibrarySectionHost"></div>
    </section>
  </body>`, { pretendToBeVisual: true, url: 'http://localhost/' });
}

function makeState({ accelerationFlag = false, mode = 'off', catalog, managed } = {}) {
  const featureFlags = { model_management_ui: true, model_library_section: true };
  if (accelerationFlag) featureFlags.llama_server_acceleration = true;
  const openaiCompatible = { acceleration: { mode, draftNMax: 4 } };
  if (managed !== undefined) openaiCompatible.managed = managed;
  const state = {
    features: { featureFlags },
    localEngines: { openaiCompatible },
    status: { model: '' },
    offline: { preferredLocalModel: '' },
    ui: { activeSettingsSection: 'modelLibrary' },
  };
  if (catalog !== undefined) state.accelerationCatalog = catalog;
  return state;
}

function diagnostics() {
  return {
    hardwareProfile: {
      gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 16384 },
      memory: { total_mb: 32768, available_mb: 24576 },
    },
    memory: { totalMb: 32768, availableMb: 24576 },
    modelRecommendations: [],
  };
}

function harness(t, { state = makeState(), installed, llamaServer } = {}) {
  const dom = makeDom();
  const { window: windowRef } = dom;
  let modelListCalls = 0;
  windowRef.jennyShell = {
    models: {
      list: async () => {
        modelListCalls += 1;
        return {
          data: installed || [{ id: 'gemma4:12b', size: 1024, engine_type: 'openai-compatible' }],
        };
      },
      listOllamaTags: async () => ({ data: [] }),
    },
    offline: { getDiagnostics: async () => diagnostics() },
    ...(llamaServer ? { llamaServer } : {}),
    features: { onChanged: () => () => {} },
  };
  const controller = createModelLibrarySectionController({
    state,
    windowRef,
    documentRef: windowRef.document,
    setupService: {
      subscribePullProgress: () => () => {},
      startOllamaPull: async () => ({ status: 'running' }),
      cancelOllamaPull: async () => ({ cancelled: true }),
    },
  });
  t.after(() => controller.dispose());
  return {
    controller,
    document: windowRef.document,
    windowRef,
    state,
    host: windowRef.document.getElementById('modelLibrarySectionHost'),
    modelListCalls: () => modelListCalls,
  };
}

async function bindAndFlush(h) {
  h.controller.bind();
  await flush();
}

test('flag off omits acceleration UI and output even when catalog state is populated', async (t) => {
  const baseline = harness(t, { state: makeState({ mode: 'mtp' }) });
  const populated = harness(t, {
    state: makeState({
      mode: 'mtp',
      catalog: ACCELERATION_CATALOG,
      // A persisted per-model choice must not leak through the kill switch.
      managed: {
        enabled: true,
        perModel: { 'gemma4-12b': { engine: 'llama-server', mtp: { mode: 'mtp' } } },
      },
    }),
    // ...nor a live managed server (the Serving pill is gated the same way).
    llamaServer: {
      listLocalGgufs: async () => ({ ok: true, entries: [{ tag: 'gemma4:12b', dir: 'G:\\m', mainGguf: 'g.gguf', drafterGguf: '', sizeBytes: 1 }] }),
      getStatus: async () => ({ ok: true, state: 'ready', alias: 'gemma4:12b', port: 8033, accelerationMode: 'mtp' }),
    },
  });
  await Promise.all([bindAndFlush(baseline), bindAndFlush(populated)]);

  assert.equal(baseline.document.querySelector('.model-library-acceleration-row'), null);
  assert.equal(populated.document.querySelector('.model-library-acceleration-row'), null);
  assert.doesNotMatch(baseline.host.textContent, /MTP ready/);
  assert.doesNotMatch(populated.host.textContent, /MTP ready/);
  assert.doesNotMatch(baseline.host.textContent, /llama-server/);
  assert.doesNotMatch(populated.host.textContent, /llama-server/);
  assert.doesNotMatch(populated.host.textContent, /Serving/);
  assert.equal(populated.host.innerHTML, baseline.host.innerHTML);
  assert.equal(
    populated.document.getElementById('modelLibrarySectionToolbarHost').innerHTML,
    baseline.document.getElementById('modelLibrarySectionToolbarHost').innerHTML
  );
});

test('model card badges render MTP eligibility only when explicitly eligible', () => {
  const eligible = new JSDOM(modelLibraryView.buildModelCard({
    key: 'gemma4:12b', tag: 'gemma4:12b', displayName: 'Gemma 4',
    installed: true, accelerationEligible: true,
  }, {})).window.document.body;
  const ineligible = new JSDOM(modelLibraryView.buildModelCard({
    key: 'other:1b', tag: 'other:1b', displayName: 'Other',
    installed: true, accelerationEligible: false,
  }, {})).window.document.body;

  assert.match(eligible.textContent, /MTP ready/);
  assert.doesNotMatch(ineligible.textContent, /MTP ready/);
});

test('flag-on catalog projection marks a gemma4 installed card MTP ready exactly once', async (t) => {
  const h = harness(t, {
    state: makeState({ accelerationFlag: true, mode: 'mtp', catalog: ACCELERATION_CATALOG }),
    installed: [{ id: 'gemma4:12b', size: 1024, engine_type: 'openai-compatible' }],
  });
  await bindAndFlush(h);

  const badges = Array.from(h.document.querySelectorAll('.inv-badge'))
    .filter((badge) => badge.textContent === 'MTP ready');
  assert.equal(badges.length, 1);
});

test('managed llama-server rows show serving and per-model MTP state', async (t) => {
  const llamaServer = {
    listLocalGgufs: async () => ({
      ok: true,
      entries: [{
        tag: 'gemma4:12b',
        dir: 'G:\\models\\gemma4',
        mainGguf: 'gemma4.gguf',
        drafterGguf: 'mtp-gemma4.gguf',
        sizeBytes: 1,
      }],
    }),
    getStatus: async () => ({
      ok: true,
      state: 'ready',
      alias: 'gemma4:12b',
      port: 8033,
      accelerationMode: 'mtp',
      reused: false,
    }),
  };
  const mtp = harness(t, {
    state: makeState({
      accelerationFlag: true,
      catalog: ACCELERATION_CATALOG,
      managed: {
        enabled: true,
        perModel: { 'gemma4-12b': { engine: 'llama-server', mtp: { mode: 'mtp' } } },
      },
    }),
    llamaServer,
  });
  const off = harness(t, {
    state: makeState({
      accelerationFlag: true,
      catalog: ACCELERATION_CATALOG,
      managed: {
        enabled: true,
        perModel: { 'gemma4-12b': { engine: 'llama-server', mtp: { mode: 'off' } } },
      },
    }),
    llamaServer,
  });
  await Promise.all([bindAndFlush(mtp), bindAndFlush(off)]);

  const mtpRow = mtp.host.querySelector('[data-model-key="gemma4:12b"]');
  assert.match(mtpRow.textContent, /Serving on :8033/);
  assert.match(mtpRow.textContent, /llama-server · MTP/);
  assert.doesNotMatch(mtpRow.textContent, /MTP ready/);
  assert.equal(mtp.document.querySelector('.model-library-acceleration-row'), null);

  const offRow = off.host.querySelector('[data-model-key="gemma4:12b"]');
  assert.match(offRow.textContent, /Serving on :8033/);
  assert.match(offRow.textContent, /llama-server/);
  assert.doesNotMatch(offRow.textContent, /llama-server · MTP/);
  assert.match(offRow.textContent, /MTP ready/);
});

test('syncEngineSettings re-renders engine pills without refetching bridge sources', async (t) => {
  const h = harness(t, {
    state: makeState({ accelerationFlag: true, catalog: ACCELERATION_CATALOG }),
    llamaServer: {
      listLocalGgufs: async () => ({
        ok: true,
        entries: [{
          tag: 'gemma4:12b',
          dir: 'G:\\models\\gemma4',
          mainGguf: 'gemma4.gguf',
          drafterGguf: 'mtp-gemma4.gguf',
          sizeBytes: 1,
        }],
      }),
      getStatus: async () => ({ ok: true, state: 'idle' }),
    },
  });
  await bindAndFlush(h);
  assert.equal(h.modelListCalls(), 1);
  assert.doesNotMatch(h.host.textContent, /llama-server/);

  const nextLocalEngines = {
    openaiCompatible: {
      managed: {
        enabled: true,
        perModel: { 'gemma4-12b': { engine: 'llama-server', mtp: { mode: 'mtp' } } },
      },
    },
  };
  h.controller.syncEngineSettings(nextLocalEngines);

  assert.equal(h.state.localEngines, nextLocalEngines);
  assert.match(h.host.textContent, /llama-server · MTP/);
  assert.equal(h.modelListCalls(), 1);
});
