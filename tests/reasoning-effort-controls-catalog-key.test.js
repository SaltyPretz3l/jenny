'use strict';
/**
 * tests/reasoning-effort-controls-catalog-key.test.js
 *
 * Gate F7 (2026-10-05): the effort picker resolves an engine-less composer
 * option to its unique catalog entry and ignores a stale startup catalog read.
 * Split from reasoning-effort-controls.test.js to keep that file under the
 * 600-line test ratchet.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const profilesSource = fs.readFileSync(path.join(__dirname, '..', 'reasoning-effort-profiles.js'), 'utf8');
const controlsSource = fs.readFileSync(path.join(__dirname, '..', 'reasoning-effort-controls.js'), 'utf8');

function createDocument() {
  return new JSDOM(`<!doctype html><html><body>
    <div id="composerModelPillSlot">
      <select id="composerModelSelect"></select>
      <label class="composer-select-shell"><select id="composerEffortSelect"><option value="default">Use default</option></select></label>
    </div>
  </body></html>`, { runScripts: 'outside-only' });
}

// Live gate 2026-10-05: the composer's "<model> (selected)" fallback option
// carries no data-engine-type, while every catalog key is engine-qualified, so
// the effort picker hid although models.list() listed the model's efforts.
const ORNITH_ID = 'ornith-1.5-9b-q6_k';
const ORNITH_CATALOG = {
  available: true,
  data: [{
    id: ORNITH_ID,
    engine_type: 'openai-compatible',
    capabilities: { thinking: true, reasoning_effort: true, reasoning_efforts: ['none', 'low', 'medium', 'high'] },
  }],
};

test('an option without an engine type uses the one catalog entry with that model id', async (t) => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = { models: { list: async () => ORNITH_CATALOG } };
  const model = window.document.getElementById('composerModelSelect');
  model.append(new window.Option('Use default', ''), new window.Option(`${ORNITH_ID} (selected)`, ORNITH_ID));
  model.value = ORNITH_ID;
  window.eval(profilesSource);
  window.eval(controlsSource);
  t.after(() => window.reasoningEffortControls.dispose());
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const effort = window.document.getElementById('composerEffortSelect');
  assert.equal(effort.dataset.reasoningSupported, 'true');
  assert.deepEqual([...effort.options].map((option) => option.value), ['default', 'none', 'low', 'medium', 'high']);
});

test('an option without an engine type stays unresolved when two engines list that id', async (t) => {
  const dom = createDocument();
  const { window } = dom;
  window.jennyShell = {
    models: {
      list: async () => ({
        available: true,
        data: [
          ORNITH_CATALOG.data[0],
          { id: ORNITH_ID, engine_type: 'chatgpt', capabilities: { reasoning_efforts: ['low', 'xhigh'] } },
        ],
      }),
    },
  };
  const model = window.document.getElementById('composerModelSelect');
  model.append(new window.Option(ORNITH_ID, ORNITH_ID));
  model.value = ORNITH_ID;
  window.eval(profilesSource);
  window.eval(controlsSource);
  t.after(() => window.reasoningEffortControls.dispose());
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(window.document.getElementById('composerEffortSelect').dataset.reasoningSupported, 'false');
});

test('a slow startup catalog read cannot overwrite a newer catalog snapshot', async (t) => {
  const dom = createDocument();
  const { window } = dom;
  const reads = [];
  window.jennyShell = {
    models: {
      list: () => new Promise((resolve) => { reads.push(resolve); }),
    },
  };
  const model = window.document.getElementById('composerModelSelect');
  const option = new window.Option(ORNITH_ID, ORNITH_ID);
  option.dataset.engineType = 'openai-compatible';
  model.append(option);
  model.value = ORNITH_ID;
  window.eval(profilesSource);
  window.eval(controlsSource);
  t.after(() => window.reasoningEffortControls.dispose());
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(reads.length >= 1, 'bind reads the catalog while the model is still loading');

  // The app's snapshot refresher pushes the ready catalog first...
  window.reasoningEffortControls.applyModelCatalog(ORNITH_CATALOG);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // ...then the model_loading-era read lands with an empty list.
  reads.forEach((resolve) => resolve({ available: true, data: [] }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  window.reasoningEffortControls.reconcile();

  const effort = window.document.getElementById('composerEffortSelect');
  assert.equal(effort.dataset.reasoningSupported, 'true');
  assert.deepEqual([...effort.options].map((entry) => entry.value), ['default', 'none', 'low', 'medium', 'high']);
});
