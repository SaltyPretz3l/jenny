'use strict';

// W4a cards + the W4c library-side indicators: a Local GGUF entry in
// managed.perModel renders as its own Model library card ("Local GGUF · 6.7 GB",
// the llama-server pill), merges with its served alias, stays behind the
// llama_server_acceleration kill switch, and a custom llama-server build shows
// as a " · build N" suffix on the pill.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createModelLibrarySectionController,
} = require('../renderer/shell/renderer-settings-model-library-section');
const merge = require('../renderer/shell/model-library/model-library-merge');
const view = require('../renderer/shell/model-library/model-library-view');
const { createModelTuningDrawerController } = require('../renderer/shell/renderer-model-tuning-drawer');
const drawerFactory = require('../renderer/inventory/drawer');
const selectField = require('../renderer/inventory/select-field');
const textField = require('../renderer/inventory/text-field');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');
const toggleSwitch = require('../renderer/inventory/toggle-switch');

const OWNER_DIR = 'G:\\llmmodels\\gguf\\ternary-bonsai-2-27b';
const OWNER_FILE = OWNER_DIR + '\\Ternary-Bonsai-2-27B-PQ2_0.gguf';
const OWNER_TAG = 'ternary-bonsai-2-27b-pq2_0';
const OWNER_KEY = 'ternary-bonsai-2-27b-pq2-0';
const OWNER_CARD = 'ternary-bonsai-2-27b-pq2_0:latest';
const OWNER_BYTES = 7206168928;
const FORK = 'G:\\llmmodels\\runtimes\\llama-prism-b10683-cuda13.3\\llama-server.exe';
const CATALOG = {
  defaults: { vramHeadroomMb: 2048 },
  families: [{ family: 'gemma4', matchPrefixes: ['gemma4', 'gemma-4'], mtp: 'yes' }],
};

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function ownerEntry(extra = {}) {
  return { engine: 'llama-server', tag: OWNER_TAG, modelPath: OWNER_FILE, mtp: { mode: 'off', draftNMax: 4 }, ...extra };
}

function managedWith(entry = ownerEntry()) {
  return { enabled: true, libraryRoots: [], perModel: { [OWNER_KEY]: entry } };
}

function ownerScan() {
  return { tag: 'ternary-bonsai-2-27b', dir: OWNER_DIR, mainGguf: 'Ternary-Bonsai-2-27B-PQ2_0.gguf', drafterGguf: '', sizeBytes: OWNER_BYTES, source: 'root' };
}

function harness(t, options = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <nav class="settings-nav"><button data-settings-section="models">Models</button></nav>
    <section class="settings-card" data-settings-section="models">
      <div id="modelLibrarySectionToolbarHost"></div>
      <div class="settings-note model-library-section-status" aria-live="polite"></div>
      <div id="modelLibrarySectionHost"></div>
    </section>
  </body>`, { pretendToBeVisual: true, url: 'http://localhost/' });
  const windowRef = dom.window;
  const calls = [];
  const featureFlags = { model_management_ui: true };
  if (options.flag !== false) featureFlags.llama_server_acceleration = true;
  const state = {
    features: { featureFlags },
    localEngines: { openaiCompatible: { managed: options.managed === undefined ? managedWith() : options.managed } },
    status: { model: options.activeModel || '' },
    offline: { preferredLocalModel: '' },
    ui: { activeSettingsSection: 'models' },
  };
  if (options.catalog) state.accelerationCatalog = options.catalog;
  windowRef.jennyShell = {
    models: {
      list: async () => ({ data: options.installed || [] }),
      listOllamaTags: async () => options.ollamaTagsPayload || ({ data: options.ollamaTags || [] }),
      load: async (payload) => { calls.push(['load', payload]); return { status: 'ok' }; },
      unload: async () => ({ status: 'ok' }),
      delete: async (payload) => { calls.push(['delete', payload]); return { status: 'deleted' }; },
    },
    offline: {
      getDiagnostics: async () => ({ hardwareProfile: { gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 16384 } }, modelRecommendations: options.recommendations || [] }),
      updateSettings: async (payload) => payload,
    },
    engines: { updateSettings: async (payload) => ({ localEngines: { openaiCompatible: { managed: payload.managed } } }) },
    llamaServer: {
      listLocalGgufs: async () => ({ ok: true, entries: options.localGgufs || [ownerScan()] }),
      getStatus: async () => ({ ok: true, state: 'stopped', ...(options.status || {}) }),
      chooseLibraryFolder: async () => ({ ok: true, picked: false, path: '' }),
    },
    features: { onChanged: () => () => {} },
  };
  const controller = createModelLibrarySectionController({
    state,
    windowRef,
    documentRef: windowRef.document,
    refreshModelPickers: async () => {},
    openModelTuning: (...args) => calls.push(['tune', ...args]),
    setupService: { subscribePullProgress: () => () => {} },
    inventoryContextMenu: { show() {}, hide() {} },
  });
  t.after(() => controller.dispose());
  return { controller, windowRef, calls, state, host: windowRef.document.getElementById('modelLibrarySectionHost') };
}

function rowsFor(h, key) {
  return [...h.host.querySelectorAll('[data-model-key]')].filter((row) => row.getAttribute('data-model-key') === key);
}

function badgeTexts(row) {
  return [...row.querySelectorAll('.inv-badge')].map((badge) => badge.textContent);
}

test('a Local GGUF entry renders one Installed card reading "Local GGUF · 6.7 GB"', async (t) => {
  const h = harness(t, { installed: [{ id: 'installed:1b', size: 1024, engine_type: 'ollama' }] });
  h.controller.bind();
  await flush();

  const rows = rowsFor(h, OWNER_CARD);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.closest('[data-model-group]').getAttribute('data-model-group'), 'installed');
  assert.equal(row.querySelector('.model-row-name').textContent, OWNER_TAG);
  assert.equal(row.querySelector('.model-row-meta').textContent, 'Local GGUF · 6.7 GB');
  assert.deepEqual(badgeTexts(row), ['llama-server']);
  // Every other card keeps its meta line exactly.
  const other = rowsFor(h, 'installed:1b')[0];
  assert.doesNotMatch(other.querySelector('.model-row-meta').textContent, /Local GGUF/);
});

test('a served alias and its projection merge into one card that keeps the file size', async (t) => {
  const h = harness(t, {
    installed: [{ id: OWNER_TAG, engine_type: 'openai-compatible' }],
    status: { state: 'ready', alias: OWNER_TAG, port: 8093, accelerationMode: 'off' },
  });
  h.controller.bind();
  await flush();

  const rows = rowsFor(h, OWNER_CARD);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].querySelector('.model-row-meta').textContent, 'Local GGUF · 6.7 GB');
  assert.deepEqual(badgeTexts(rows[0]), ['Serving on :8093', 'llama-server']);
  assert.equal(h.host.querySelectorAll('.model-row').length, 1);
});

test('with the acceleration flag off a persisted Local GGUF entry makes no card', async (t) => {
  const h = harness(t, { flag: false, installed: [{ id: 'installed:1b', size: 1024, engine_type: 'ollama' }] });
  h.controller.bind();
  await flush();

  assert.equal(rowsFor(h, OWNER_CARD).length, 0);
  assert.doesNotMatch(h.host.textContent, /Local GGUF|ternary-bonsai/);
  assert.equal(h.host.querySelectorAll('.model-row').length, 1);
});

test('Use loads a Local GGUF card on llama-server', async (t) => {
  const h = harness(t);
  h.controller.bind();
  await flush();

  rowsFor(h, OWNER_CARD)[0].querySelector('[data-model-card-action="use"]')
    .dispatchEvent(new h.windowRef.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.deepEqual(
    h.calls.find((entry) => entry[0] === 'load'),
    ['load', { model: OWNER_TAG, engine_type: 'openai-compatible' }]
  );
});

// While Ollama's tag list is unreadable nobody knows whether Ollama has the
// model: Tune must not tell the drawer it doesn't, and keeps the llama-server
// facts. The drawer reads missing Ollama facts as unknown (the neutral hint).
test('Tune while Ollama\'s tags are unreadable leaves Ollama unknown and keeps the llama-server facts', async (t) => {
  const down = harness(t, { ollamaTagsPayload: { available: false, reason: 'Ollama is not running.' } });
  const up = harness(t, { ollamaTags: [{ name: 'other:1b', size: 1 }] });
  down.controller.bind();
  up.controller.bind();
  await flush();
  const handed = (h) => {
    rowsFor(h, OWNER_CARD)[0].querySelector('[data-model-card-action="tune"]')
      .dispatchEvent(new h.windowRef.MouseEvent('click', { bubbles: true }));
    return h.calls.filter((entry) => entry[0] === 'tune').pop()[3];
  };
  const whileDown = handed(down);
  const whileUp = handed(up);
  assert.equal(whileDown.engines.ollama, null);
  assert.deepEqual(whileDown.engines.llamaServer, { available: true, modelPath: OWNER_FILE, drafter: false });
  assert.deepEqual(whileUp.engines.ollama, { available: false });
  assert.deepEqual(whileUp.engines.llamaServer, whileDown.engines.llamaServer);
  const hint = async (options) => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    dom.window.jennyShell = {
      modelTuning: { getState: async () => ({ contextLengthSteps: [4096] }), update: async () => ({ status: 'applied' }) },
      engines: { getSettings: async () => ({ localEngines: down.state.localEngines, accelerationCatalog: { families: [] } }) },
      llamaServer: { listLocalGgufs: async () => ({ ok: true, entries: [] }), getStatus: async () => ({ ok: true, state: 'stopped' }) },
    };
    const drawer = createModelTuningDrawerController({
      state: { features: { featureFlags: { llama_server_acceleration: true } }, modelList: { data: [] }, status: { model: '' } },
      windowRef: dom.window,
      documentRef: dom.window.document,
      drawerFactory,
      inventory: { selectField, textField, actionButton, segmentedControl, toggleSwitch },
    });
    t.after(() => drawer.dispose());
    await drawer.open(OWNER_TAG, null, options);
    return dom.window.document.querySelector('.model-tuning-engine .model-tuning-section-hint').textContent;
  };
  assert.equal(await hint(whileDown), "Ollama or Jenny's own llama-server. llama-server can speed up verified models with multi-token prediction.");
  assert.equal(await hint(whileUp), "Ollama doesn't have this model, so it runs on Jenny's own llama-server.");
});

test('the llama-server pill names a custom build and stays plain for the bundled one', async (t) => {
  const custom = harness(t, { managed: managedWith(ownerEntry({ runtimePath: FORK, runtimeBuild: 10683 })) });
  const bundled = harness(t, { managed: managedWith(ownerEntry({ runtimeBuild: 10683 })) });
  const mtp = harness(t, {
    catalog: CATALOG,
    installed: [{ id: 'gemma4:12b', size: 1024, engine_type: 'ollama' }],
    managed: {
      enabled: true,
      perModel: {
        'gemma4-12b': { engine: 'llama-server', tag: 'gemma4:12b', modelPath: 'G:\\m\\gemma4.gguf', mtp: { mode: 'mtp' }, runtimePath: FORK, runtimeBuild: 10683 },
      },
    },
  });
  custom.controller.bind();
  bundled.controller.bind();
  mtp.controller.bind();
  await flush();

  assert.deepEqual(badgeTexts(rowsFor(custom, OWNER_CARD)[0]), ['llama-server · build 10683']);
  assert.deepEqual(badgeTexts(rowsFor(bundled, OWNER_CARD)[0]), ['llama-server']);
  assert.deepEqual(badgeTexts(rowsFor(mtp, 'gemma4:12b')[0]), ['llama-server · MTP · build 10683']);
});

function mergeCards(overrides = {}) {
  return merge.mergeModelLibrary({
    installed: [],
    ollamaTags: [],
    recommendations: [],
    hardware: { gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 16384 } },
    ...overrides,
  }).cards;
}

const PROJECTION = { id: OWNER_TAG, size: OWNER_BYTES, engine_type: 'openai-compatible', available: true, libraryGguf: true };

test('normalizeInstalledEntries carries libraryGguf and the projection size in either order', () => {
  const served = { id: OWNER_TAG, size: 0, engine_type: 'openai-compatible', available: true };
  for (const installed of [[served, PROJECTION], [PROJECTION, served]]) {
    const cards = mergeCards({ installed, managed: managedWith() });
    assert.equal(cards.length, 1);
    assert.equal(cards[0].libraryGguf, true);
    assert.equal(cards[0].sizeBytes, OWNER_BYTES);
    assert.equal(cards[0].selectedEngine, 'llama-server');
  }
  const plain = mergeCards({ installed: [served], managed: managedWith() });
  assert.equal(plain[0].libraryGguf, false);
  // A catalog card that is a library file says so too.
  const catalog = mergeCards({
    installed: [{ ...PROJECTION, id: 'gemma4' }],
    recommendations: [{ pullTag: 'gemma4', displayName: 'Gemma 4', recommended: true, vramRequiredMb: 1000 }],
  });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].source, 'both');
  assert.equal(catalog[0].libraryGguf, true);
  assert.equal(mergeCards({
    recommendations: [{ pullTag: 'gemma4', displayName: 'Gemma 4', vramRequiredMb: 1000 }],
  })[0].libraryGguf, false);
});

test('customBuild reaches both card shapes only for llama-server with a runtime path', () => {
  const build = (entry, managedExtra = {}, installed = [PROJECTION]) => mergeCards({
    installed,
    recommendations: installed === null ? [{ pullTag: OWNER_TAG, vramRequiredMb: 1000 }] : [],
    managed: { ...managedWith(entry), ...managedExtra },
  })[0].customBuild;
  assert.equal(build(ownerEntry({ runtimePath: FORK, runtimeBuild: 10683 })), 10683);
  assert.equal(build(ownerEntry({ runtimePath: FORK, runtimeBuild: 10683 }), {}, null), 10683);
  assert.equal(build(ownerEntry({ runtimePath: FORK, runtimeBuild: '10683' })), 10683);
  assert.equal(build(ownerEntry({ runtimePath: FORK })), 0);
  assert.equal(build(ownerEntry({ runtimePath: '', runtimeBuild: 10683 })), 0);
  assert.equal(build(ownerEntry({ runtimeBuild: 10683 })), 0);
  assert.equal(build(ownerEntry({ engine: 'ollama', runtimePath: FORK, runtimeBuild: 10683 })), 0);
  assert.equal(build(ownerEntry({ runtimePath: FORK, runtimeBuild: 10683 }), { enabled: false }), 0);
  assert.equal(mergeCards({ installed: [PROJECTION] })[0].customBuild, 0);
});

test('the row meta leads with Local GGUF only on library cards', () => {
  const card = {
    key: OWNER_CARD, tag: OWNER_TAG, displayName: OWNER_TAG, source: 'installed', installed: true,
    engineVisible: true, engineType: 'openai-compatible', sizeBytes: OWNER_BYTES, fitState: 'unknown',
  };
  const meta = (overrides) => JSDOM.fragment(view.buildModelRow({ ...card, ...overrides }, {}))
    .querySelector('.model-row-meta').textContent;
  assert.equal(meta({ libraryGguf: true }), 'Local GGUF · 6.7 GB');
  assert.equal(meta({ libraryGguf: true, params: '27B', quant: 'PQ2_0' }), 'Local GGUF · 27B · PQ2_0 · 6.7 GB');
  assert.equal(meta({ libraryGguf: true, sizeBytes: 0 }), 'Local GGUF · Size unknown');
  assert.equal(meta({ libraryGguf: true, source: 'both' }), `Local GGUF · ${OWNER_TAG} · 6.7 GB`);
  assert.equal(meta({}), '6.7 GB');
  assert.equal(meta({ libraryGguf: 'true' }), '6.7 GB');
});

test('the build suffix follows customBuild on the pill of rows and compact cards', () => {
  const card = {
    key: OWNER_CARD, tag: OWNER_TAG, installed: true, engineVisible: true, source: 'installed',
    engineType: 'openai-compatible', selectedEngine: 'llama-server', fitState: 'unknown',
  };
  const pills = (html) => [...JSDOM.fragment(html).querySelectorAll('.inv-badge')].map((badge) => badge.textContent);
  assert.ok(pills(view.buildModelRow({ ...card, customBuild: 10683 }, {})).includes('llama-server · build 10683'));
  assert.ok(pills(view.buildModelCard({ ...card, customBuild: 10683 }, { compact: true })).includes('llama-server · build 10683'));
  assert.ok(pills(view.buildModelRow({ ...card, customBuild: 0 }, {})).includes('llama-server'));
  assert.ok(pills(view.buildModelRow({ ...card, customBuild: -3 }, {})).includes('llama-server'));
  assert.ok(pills(view.buildModelRow(card, {})).includes('llama-server'));
  assert.ok(!pills(view.buildModelRow({ ...card, selectedEngine: 'ollama', customBuild: 10683 }, {}))
    .some((text) => text.includes('build')));
});
