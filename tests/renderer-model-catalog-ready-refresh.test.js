'use strict';

// Live gate 2026-10-05 (1 of 3 cold launches, managed llama-server model):
// the backend sat in model_loading ~20 s, then went ready. The composer model
// select kept "Use default" + "<model> (selected)" (no data-engine-type) and
// the effort picker stayed hidden until a renderer reload, although
// models.list() already listed the model with its efforts.
//
// This wires the real snapshot refresher, the real effort controls and the
// real option builder over jsdom fakes. The app's full render (renderAll ->
// renderSettings) is the only path that rebuilds #composerModelSelect; the
// snapshot render on the chat view does not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createSnapshotRefresh } = require('../renderer/shell/renderer-snapshot-refresh');
const { buildModelOptionMarkup } = require('../renderer/shell/renderer-lifecycle-format-utils');

const profilesSource = fs.readFileSync(path.join(__dirname, '..', 'reasoning-effort-profiles.js'), 'utf8');
const controlsSource = fs.readFileSync(path.join(__dirname, '..', 'reasoning-effort-controls.js'), 'utf8');

const ORNITH = 'ornith-1.5-9b-q6_k';
const LOADING_CATALOG = { available: true, engine_type: 'openai-compatible', active_model: ORNITH, data: [] };
const READY_CATALOG = {
  available: true,
  engine_type: 'openai-compatible',
  active_model: ORNITH,
  data: [
    {
      id: ORNITH,
      engine_type: 'openai-compatible',
      capabilities: { thinking: true, reasoning_effort: true, reasoning_efforts: ['none', 'low', 'medium', 'high'] },
    },
    { id: 'qwen3.5:4b', engine_type: 'ollama', capabilities: null },
  ],
};

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createHarness(t) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="composerModelPillSlot">
      <select id="composerModelSelect"></select>
      <label class="composer-select-shell"><select id="composerEffortSelect"><option value="default">Use default</option></select></label>
    </div>
  </body></html>`, { runScripts: 'outside-only' });
  const { window } = dom;
  const doc = window.document;
  const state = { backend: { phase: 'model_loading' }, auth: { authenticated: true }, ui: { activeView: 'chat' }, modelList: null };
  let readyRead = null;
  window.jennyShell = {
    models: {
      // While the model loads the catalog has no entries; once ready, every
      // read shares one slow (~4.5 s on the gate) response the test releases.
      list: () => (state.backend.phase === 'ready' ? readyRead.promise : Promise.resolve(LOADING_CATALOG)),
    },
  };
  const modelSelect = doc.getElementById('composerModelSelect');
  const effortSelect = doc.getElementById('composerEffortSelect');
  // renderSettings' composer rebuild, reached only through the full render.
  const renderAll = () => {
    modelSelect.innerHTML = buildModelOptionMarkup(state.modelList?.data || [], ORNITH, { compact: true });
    modelSelect.value = ORNITH;
  };
  renderAll();
  window.eval(profilesSource);
  window.eval(controlsSource);
  t.after(() => window.reasoningEffortControls.dispose());
  doc.dispatchEvent(new window.Event('DOMContentLoaded'));
  const refresher = createSnapshotRefresh({
    state,
    getShell: () => window.jennyShell,
    onModelsUpdated: (models) => { window.reasoningEffortControls.applyModelCatalog(models); },
    onModelCatalogRecovered: renderAll,
    render: () => {}, // renderHeader/renderSessions/renderComposerState: no carrier rebuild on chat
    setTimeout: () => null,
    clearTimeout: () => {},
  });
  t.after(() => refresher.dispose());
  return {
    state,
    modelSelect,
    effortSelect,
    renderAll,
    refresher,
    goReady() {
      let resolve;
      readyRead = { promise: new Promise((done) => { resolve = done; }) };
      readyRead.resolve = resolve;
      state.backend = { phase: 'ready' };
      return readyRead;
    },
  };
}

function assertPopulated(harness) {
  const options = [...harness.modelSelect.options].map((option) => [option.value, option.dataset.engineType || '']);
  assert.deepEqual(options, [
    ['', ''],
    [ORNITH, 'openai-compatible'],
    ['qwen3.5:4b', 'ollama'],
  ]);
  assert.equal(harness.effortSelect.dataset.reasoningSupported, 'true');
  assert.deepEqual([...harness.effortSelect.options].map((option) => option.value), ['default', 'none', 'low', 'medium', 'high']);
}

test('a catalog that lands after the ready render still repopulates the composer and its efforts', async (t) => {
  const harness = createHarness(t);
  await flush();
  assert.deepEqual([...harness.modelSelect.options].map((option) => option.textContent), ['Use default', `${ORNITH} (selected)`]);
  assert.equal(harness.effortSelect.dataset.reasoningSupported, 'false');

  const readyRead = harness.goReady();
  // The ready handler starts the model-inclusive refresh...
  const refresh = harness.refresher.refreshSnapshots();
  await flush();
  // ...a newer backend status supersedes it and renders in full before the
  // slow models.list answers (the superseded handler never renders again).
  harness.renderAll();
  readyRead.resolve(READY_CATALOG);
  await refresh;
  await flush();
  await flush();

  assertPopulated(harness);
});

test('a runtime-only poll during the slow ready read does not leave the composer on the fallback', async (t) => {
  const harness = createHarness(t);
  await flush();
  const readyRead = harness.goReady();
  const refresh = harness.refresher.refreshSnapshots();
  await flush();
  await harness.refresher.refreshSnapshots({ includeModels: false });
  readyRead.resolve(READY_CATALOG);
  await refresh;
  await flush();
  await flush();

  assert.equal(harness.state.modelList, READY_CATALOG);
  assertPopulated(harness);
});
