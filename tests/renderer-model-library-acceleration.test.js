'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createModelLibrarySectionController,
} = require('../renderer/shell/renderer-settings-model-library-section');
const modelLibraryView = require('../renderer/shell/model-library/model-library-view');
const { mergeModelLibrary } = require('../renderer/shell/model-library/model-library-merge');

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
    <nav class="settings-nav"><button data-settings-section="models">Models</button></nav>
    <section class="settings-card" data-settings-section="models">
      <div id="modelLibrarySectionToolbarHost"></div>
      <div class="model-library-section-status" aria-live="polite"></div>
      <div id="modelRunningHost"></div>
      <div id="modelLibrarySectionHost"></div>
    </section>
  </body>`, { pretendToBeVisual: true, url: 'http://localhost/' });
}

function makeState({ accelerationFlag = false, mode = 'off', catalog, managed } = {}) {
  const featureFlags = {};
  if (accelerationFlag) featureFlags.llama_server_acceleration = true;
  const openaiCompatible = { acceleration: { mode, draftNMax: 4 } };
  if (managed !== undefined) openaiCompatible.managed = managed;
  const state = {
    features: { featureFlags },
    localEngines: { openaiCompatible },
    status: { model: '' },
    offline: { preferredLocalModel: '' },
      ui: { activeSettingsSection: 'models' },
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

const readyFlags = (h) => Array.from(h.document.querySelectorAll('.mrow-flag'))
  .filter((flag) => flag.textContent === 'MTP ready');
const gemmaGguf = (extra) => ({
  listLocalGgufs: async () => ({ ok: true, entries: [{ tag: 'gemma4:12b', dir: 'G:\\m', mainGguf: 'g.gguf', drafterGguf: '', sizeBytes: 1, ...extra }] }),
  getStatus: async () => ({ ok: true, state: 'stopped' }),
});

test('flag-on catalog projection marks a gemma4 installed card with a drafter MTP ready exactly once', async (t) => {
  const h = harness(t, {
    state: makeState({ accelerationFlag: true, mode: 'mtp', catalog: ACCELERATION_CATALOG }),
    installed: [{ id: 'gemma4:12b', size: 1024, engine_type: 'openai-compatible' }],
    llamaServer: gemmaGguf({ drafterGguf: 'mtp-gemma4.gguf' }),
  });
  await bindAndFlush(h);

  assert.equal(readyFlags(h).length, 1);
});

test('MTP ready needs a drafter beside the model or a head built into it (F7)', async (t) => {
  const installed = [{ id: 'gemma4:12b', size: 1024, engine_type: 'openai-compatible' }];
  const state = () => makeState({ accelerationFlag: true, mode: 'mtp', catalog: ACCELERATION_CATALOG });
  const bare = harness(t, { state: state(), installed, llamaServer: gemmaGguf({}) });
  const unscanned = harness(t, { state: state(), installed });
  await Promise.all([bindAndFlush(bare), bindAndFlush(unscanned)]);

  assert.equal(readyFlags(bare).length, 0, 'an eligible family with no drafter and no head cannot run MTP');
  assert.equal(readyFlags(unscanned).length, 0);
});

test('the merged card is MTP-runnable with a drafter or a built-in head only', () => {
  const card = (entry) => mergeModelLibrary({
    installed: [{ id: 'gemma4:12b', engineType: 'openai-compatible' }],
    acceleration: { enabled: true, headroomMb: 2048, families: ACCELERATION_CATALOG.families },
    localGgufs: entry ? [{ tag: 'gemma4:12b', dir: 'G:\\m', mainGguf: 'g.gguf', ...entry }] : [],
  }).cards.find((c) => c.tag === 'gemma4:12b');

  assert.equal(card({ drafterGguf: 'mtp-gemma4.gguf' }).mtpRunnable, true);
  assert.equal(card({ embeddedMtpLayers: 1 }).mtpRunnable, true);
  assert.equal(card({ embeddedMtpLayers: 0 }).mtpRunnable, false);
  assert.equal(card({}).mtpRunnable, false);
  assert.equal(card(null).mtpRunnable, false);
  const html = (entry) => new JSDOM(modelLibraryView.buildModelCard(card(entry), {})).window.document.body.textContent;
  assert.match(html({ embeddedMtpLayers: 1 }), /MTP ready/);
  assert.doesNotMatch(html({}), /MTP ready/);
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

  // A served model that is not the chat's model still holds GPU memory, so its row says so.
  const flagsOf = (row) => Array.from(row.querySelectorAll('.mrow-flag')).map((flag) => flag.textContent);
  const mtpRow = mtp.host.querySelector('[data-model-key="gemma4:12b"]');
  assert.deepEqual(flagsOf(mtpRow).slice(0, 2), ['MTP', 'Serving on :8033']);
  assert.match(mtpRow.querySelector('.mrow-meta').textContent, /^llama-server/);
  assert.equal(mtp.document.querySelector('.model-library-acceleration-row'), null);

  const offRow = off.host.querySelector('[data-model-key="gemma4:12b"]');
  assert.deepEqual(flagsOf(offRow).slice(0, 2), ['MTP ready', 'Serving on :8033']);
  assert.match(offRow.querySelector('.mrow-meta').textContent, /^llama-server/);
});

// Owner gate P2: while an image render holds the GPU the chat GPU handoff
// parks llama-server (stopped, identity retained for the exact relaunch). The
// card said "Serving on :8033" from its stale snapshot; the periodic sync now
// rereads the status, reads that parked state as paused, and says Serving
// again once the restore lands, without refetching the other sources.
test('a serving card reads paused while an image render parks llama-server, then serving again', async (t) => {
  const statuses = [
    { ok: true, state: 'ready', alias: 'gemma4:12b', port: 8033, accelerationMode: 'off' },
    { ok: true, state: 'stopped', alias: 'gemma4:12b', port: 8033, accelerationMode: 'off', identityRetained: true },
    { ok: true, state: 'ready', alias: 'gemma4:12b', port: 8033, accelerationMode: 'off', identityRetained: false },
  ];
  let reads = 0;
  const llamaServer = {
    listLocalGgufs: async () => ({ ok: true, entries: [] }),
    getStatus: async () => statuses[Math.min(reads++, statuses.length - 1)],
  };
  const h = harness(t, {
    state: makeState({
      accelerationFlag: true,
      catalog: ACCELERATION_CATALOG,
      managed: { enabled: true, perModel: { 'gemma4-12b': { engine: 'llama-server', mtp: { mode: 'off' } } } },
    }),
    llamaServer,
  });
  h.state.status.model = 'gemma4:12b';
  await bindAndFlush(h);
  // The active model sits in Running now, whose meta line carries the port or the pause.
  const meta = () => h.document.querySelector('#modelRunningHost .mm-meta').textContent;
  assert.equal(h.host.querySelector('[data-model-key="gemma4:12b"]'), null, 'the active model is not a Library row');
  assert.match(meta(), /port 8033/);

  h.controller.syncFromState();
  await flush();
  assert.match(meta(), /Paused for an image render/);
  assert.doesNotMatch(meta(), /port 8033/);

  h.controller.syncFromState();
  await flush();
  assert.match(meta(), /port 8033/);
  assert.doesNotMatch(meta(), /Paused/);
  assert.equal(h.modelListCalls(), 1, 'only the llama-server status is reread');
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
  const row = h.host.querySelector('[data-model-key="gemma4:12b"]');
  assert.match(row.querySelector('.mrow-meta').textContent, /^llama-server/);
  assert.equal(row.querySelector('.mrow-flag').textContent, 'MTP');
  assert.equal(h.modelListCalls(), 1);
});
