'use strict';

// "Search by meaning" in Settings > Tools > Knowledge folders (semantic_catalog,
// roadmap row 41, placement A): flag-off parity, the per-folder signal, the
// status line per scheduler state, the settings controls reaching
// catalog.updateSettings, the delete confirmation and the throttled refresh.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createKnowledgeFoldersController } = require('../renderer/shell/renderer-knowledge-folders');
const { statusLine } = require('../renderer/shell/renderer-knowledge-catalog');

const NOTES = 'C:\\Users\\me\\Documents\\Notes';
const PROFILES = [
  { id: 'embeddinggemma', label: 'EmbeddingGemma', dims: [768, 512, 256, 128] },
  { id: 'none', label: 'None', dims: [] },
];

function makeDom() {
  return new JSDOM(`<!doctype html><html><body>
    <div id="appShell"><section class="settings-card" data-settings-section="tools"></section></div>
    <div id="srAnnouncePolite" role="status" aria-live="polite"></div>
    <div id="srAnnounceAssertive" role="alert" aria-live="assertive"></div>
  </body></html>`, { pretendToBeVisual: true, url: 'http://localhost/' });
}

function settings(overrides = {}) {
  return { enabled: true, modelPath: 'C:\\models\\embeddinggemma-2-Q4.gguf', profileId: '', device: 'cpu', dims: 0, ...overrides };
}

function status(overrides = {}) {
  return {
    state: 'caught_up',
    model: { name: 'EmbeddingGemma 2', profileId: 'embeddinggemma', dims: 256, device: 'cpu' },
    counts: { indexed: 100 },
    lastError: null,
    roots: [{ path: NOTES, indexed: 100, pending: 0, failed: 0, skipped: 0, skippedReasons: {}, scanComplete: true }],
    sizeBytes: 3 * 1024 * 1024,
    ...overrides,
  };
}

function makeCatalogBridge(initial) {
  const calls = [];
  const listeners = [];
  let current = initial;
  return {
    calls,
    listeners,
    set(next) { current = next; },
    bridge: {
      getStatus: async () => { calls.push(['getStatus']); return { ok: true, profiles: PROFILES, ...current }; },
      updateSettings: async (patch) => {
        calls.push(['updateSettings', patch]);
        current = { ...current, settings: { ...current.settings, ...patch } };
        return { ok: true, settings: current.settings };
      },
      chooseModel: async () => { calls.push(['chooseModel']); return { ok: false, reason: 'not_embedding_model' }; },
      rebuild: async () => { calls.push(['rebuild']); return { ok: true }; },
      deleteCatalog: async () => { calls.push(['deleteCatalog']); return { ok: true }; },
      retry: async () => { calls.push(['retry']); return { ok: true }; },
      onStatus: (listener) => {
        listeners.push(listener);
        return () => { calls.push(['unsubscribe']); };
      },
    },
  };
}

function createHarness(t, { flag = true, catalog } = {}) {
  const dom = makeDom();
  const knowledge = {
    getState: async (payload) => ({ schemaVersion: 1, revision: 1, roots: [{ id: 'kbroot_1', path: NOTES, label: 'Notes' }], enabled: true, projectId: payload.project_id }),
    onChanged: () => () => {},
  };
  const catalogStub = catalog || makeCatalogBridge({ settings: settings(), status: status() });
  const windowRef = Object.assign(dom.window, { jennyShell: { knowledge, catalog: catalogStub.bridge } });
  const controller = createKnowledgeFoldersController({
    state: {
      currentSessionId: 'session_alpha',
      sessions: [{ id: 'session_alpha', project_id: 'project_alpha' }],
      features: { featureFlags: { knowledge_layer: true, semantic_catalog: flag } },
    },
    windowRef,
    documentRef: dom.window.document,
    appendClientLog: () => {},
  });
  t.after(() => controller.dispose());
  return { dom, controller, catalog: catalogStub, doc: dom.window.document };
}

async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function mount(t, options) {
  const harness = createHarness(t, options);
  harness.controller.bind();
  harness.controller.render();
  await settle();
  harness.controller.render();
  return harness;
}

function signalText(doc) {
  const signal = doc.querySelector('[data-root-id="kbroot_1"] .knowledge-catalog-signal');
  return signal ? signal.textContent : '';
}

function statusText(doc) {
  return doc.querySelector('.knowledge-catalog-status').textContent;
}

test('flag off renders no catalog block and never probes the catalog bridge', async (t) => {
  const { doc, catalog } = await mount(t, { flag: false });
  assert.ok(doc.getElementById('knowledgeFoldersGroup'), 'the folders group still renders');
  assert.equal(doc.querySelector('[data-knowledge-catalog]'), null);
  assert.equal(signalText(doc), '');
  assert.deepEqual(catalog.calls, []);
  assert.equal(catalog.listeners.length, 0);
});

test('without a model the block asks for one and the rows stay quiet', async (t) => {
  const catalog = makeCatalogBridge({ settings: settings({ modelPath: '' }), status: status({ state: 'waiting_model', roots: [] }) });
  const { doc } = await mount(t, { catalog });
  assert.match(statusText(doc), /Needs an embedding model/);
  assert.equal(signalText(doc), '');
  assert.ok(doc.querySelector('[data-catalog-action="choose"]'));
  assert.equal(doc.querySelector('.knowledge-catalog-facts'), null, 'model facts appear only once a model is picked');
  doc.querySelector('[data-catalog-action="explain"]').click();
  assert.match(doc.querySelector('[data-knowledge-catalog]').textContent, /doesn’t download one/);
});

test('cataloging shows progress per folder with the working dot', async (t) => {
  const catalog = makeCatalogBridge({
    settings: settings(),
    status: status({ state: 'indexing', roots: [{ path: `${NOTES}\\`, indexed: 40, pending: 60, failed: 0, skipped: 0, skippedReasons: {}, scanComplete: true }] }),
  });
  const { doc } = await mount(t, { catalog });
  assert.match(signalText(doc), /40 of 100 files/);
  assert.ok(doc.querySelector('.knowledge-catalog-signal .status-dot--active.knowledge-catalog-dot--working'));
  assert.match(statusText(doc), /Cataloging · pauses the moment you start a chat/);
  assert.match(doc.querySelector('.knowledge-catalog-model-name').textContent, /EmbeddingGemma 2/);
});

test('a finished folder with skips warns and explains the skips in its tooltip', async (t) => {
  const catalog = makeCatalogBridge({
    settings: settings(),
    status: status({ roots: [{ path: NOTES, indexed: 90, pending: 0, failed: 1, skipped: 9, skippedReasons: { pdf_addon_missing: 9 }, scanComplete: true }] }),
  });
  const { doc } = await mount(t, { catalog });
  const signal = doc.querySelector('.knowledge-catalog-signal');
  assert.match(signal.textContent, /90 files · 10 skipped/);
  assert.ok(signal.querySelector('.status-dot--warn'));
  assert.match(signal.getAttribute('title'), /9 PDFs need the PDF reading add-on/);
  assert.match(signal.getAttribute('title'), /1 couldn’t be read/);
  assert.match(statusText(doc), /Up to date/);
});

test('the toggle, CPU/GPU, profile and dimensions reach catalog.updateSettings', async (t) => {
  const { doc, catalog, dom } = await mount(t);
  const fire = (el, type, detail) => el.dispatchEvent(new dom.window.CustomEvent(type, { bubbles: true, detail }));
  fire(doc.querySelector('[data-inv-toggle="knowledge-catalog-enabled"]'), 'inv-toggle-change', { id: 'knowledge-catalog-enabled', checked: false });
  await settle();
  fire(doc.querySelector('[data-inv-segmented="knowledge-catalog-device"]'), 'inv-segmented-change', { id: 'knowledge-catalog-device', value: 'gpu' });
  await settle();
  // Re-enable so the Advanced fold shows the dimension choices again.
  fire(doc.querySelector('[data-inv-toggle="knowledge-catalog-enabled"]'), 'inv-toggle-change', { id: 'knowledge-catalog-enabled', checked: true });
  await settle();
  fire(doc.querySelector('[data-inv-segmented="knowledge-catalog-dims"]'), 'inv-segmented-change', { id: 'knowledge-catalog-dims', value: '512' });
  await settle();
  const select = doc.querySelector('[data-catalog-select="profile"]');
  select.value = 'none';
  select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await settle();
  const patches = catalog.calls.filter(([name]) => name === 'updateSettings').map(([, patch]) => patch);
  assert.deepEqual(patches, [{ enabled: false }, { device: 'gpu' }, { enabled: true }, { dims: 512 }, { profileId: 'none' }]);
});

test('a refused model file is explained inline, never as a raw reason', async (t) => {
  const { doc } = await mount(t);
  doc.querySelector('[data-catalog-action="choose"]').click();
  await settle();
  assert.match(doc.querySelector('[data-knowledge-catalog]').textContent, /That file is a chat model, not an embedding model\./);
  assert.doesNotMatch(doc.querySelector('[data-knowledge-catalog]').textContent, /not_embedding_model/);
});

test('rebuild runs directly while on and delete is not offered', async (t) => {
  const catalog = makeCatalogBridge({ settings: settings(), status: status() });
  const { doc } = await mount(t, { catalog });
  doc.querySelector('[data-catalog-action="rebuild"]').click();
  await settle();
  assert.ok(catalog.calls.some(([name]) => name === 'rebuild'));
  assert.equal(doc.querySelector('[data-catalog-action="delete"]'), null, 'delete is offered only while off');
});

test('delete confirmation: cancel keeps the catalog, confirm deletes it', async (t) => {
  const catalog = makeCatalogBridge({ settings: settings({ enabled: false }), status: status({ state: 'off', roots: [] }) });
  const { doc } = await mount(t, { catalog });
  assert.match(statusText(doc), /Off · the catalog is kept \(100 files, 3 MB\)/);
  doc.querySelector('[data-catalog-action="delete"]').focus();
  doc.querySelector('[data-catalog-action="delete"]').click();
  const modal = doc.querySelector('[data-step-modal="knowledge-catalog-confirm-delete"]');
  assert.ok(modal);
  await settle();
  assert.ok(modal.contains(doc.activeElement), 'focus moves into the dialog');
  assert.ok(doc.getElementById('appShell').inert || doc.getElementById('appShell').hasAttribute('inert'), 'the app behind it is inert');
  doc.querySelector('[data-step-modal-action="cancel"]').click();
  assert.equal(doc.querySelector('[data-step-modal="knowledge-catalog-confirm-delete"]'), null);
  assert.ok(!doc.getElementById('appShell').inert && !doc.getElementById('appShell').hasAttribute('inert'), 'inert is restored');
  assert.ok(!catalog.calls.some(([name]) => name === 'deleteCatalog'));

  doc.querySelector('[data-catalog-action="delete"]').click();
  doc.querySelector('[data-step-modal-action="confirm"]').click();
  await settle();
  assert.ok(catalog.calls.some(([name]) => name === 'deleteCatalog'));
  assert.equal(doc.querySelector('[data-step-modal="knowledge-catalog-confirm-delete"]'), null);
});

test('a status change is spoken through the shared live region, not a nested one', async (t) => {
  const catalog = makeCatalogBridge({ settings: settings(), status: status() });
  const { doc } = await mount(t, { catalog });
  assert.equal(doc.querySelector('[data-knowledge-catalog] [aria-live]'), null);
  assert.equal(doc.getElementById('srAnnouncePolite').textContent, '', 'the first render is shown, not spoken');
  catalog.set({ settings: settings(), status: status({ state: 'indexing' }) });
  catalog.listeners[0]({ state: 'indexing' });
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.match(doc.getElementById('srAnnouncePolite').textContent, /Cataloging · pauses the moment you start a chat/);
});

test('status pushes refresh through one throttled read; dispose unsubscribes', async (t) => {
  const { controller, catalog } = await mount(t);
  const before = catalog.calls.filter(([name]) => name === 'getStatus').length;
  catalog.listeners[0]({ state: 'indexing' });
  catalog.listeners[0]({ state: 'indexing' });
  catalog.listeners[0]({ state: 'indexing' });
  await new Promise((resolve) => setTimeout(resolve, 2100));
  await settle();
  assert.equal(catalog.calls.filter(([name]) => name === 'getStatus').length, before + 1);
  controller.dispose();
  assert.ok(catalog.calls.some(([name]) => name === 'unsubscribe'));
});

test('statusLine names a model the bundled engine cannot load, even while the catalog backs off (row 41 gate)', () => {
  const on = settings();
  const status = { state: 'error', lastError: { code: 'embedder_backoff' }, engine: { status: 'failed', lastError: 'llama_server_model_unsupported:bundled' } };
  const line = statusLine(status, on);
  assert.equal(line.strong, 'Can’t load this model');
  assert.match(line.text, /doesn’t support its format/);
  assert.equal(line.action, 'chooseAnother', 'retrying cannot help');
  assert.match(statusLine({ ...status, engine: { status: 'failed', lastError: 'embedder_exited' } }, on).text, /quit unexpectedly/);
});

test('statusLine classifies engine stops, step problems and refusals', () => {
  const on = settings();
  assert.equal(statusLine({ state: 'error', lastError: { code: 'embedder_failed' } }, on).action, 'retry');
  assert.match(statusLine({ state: 'error', lastError: { code: 'embedder_failed' } }, on).text, /quit unexpectedly/);
  assert.equal(statusLine({ state: 'error', lastError: { code: 'step_failed' } }, on).tone, 'warn');
  const refused = statusLine({ state: 'error', lastError: { code: 'embedding_model_refused', reason: 'not_gguf' } }, on);
  assert.equal(refused.action, 'chooseAnother');
  assert.match(refused.error, /isn’t a GGUF model/);
  assert.match(statusLine({ state: 'paused_busy' }, on).text, /resumes 30 s after/);
  assert.match(statusLine({ state: 'idle_wait' }, on).text, /idle for 30 s/);
  assert.equal(statusLine({ state: 'starting_engine' }, on).strong, 'Starting');
  for (const code of ['embedder_start_failed', 'llama_server_binary_not_found', 'llama_server_runtime_missing']) {
    const line = statusLine({ state: 'error', lastError: { code } }, on);
    assert.match(line.text, /starts on llama-server in Model Library/, code);
    assert.equal(line.action, 'retry');
  }
  assert.match(statusLine({ state: 'error', lastError: { code: 'embedder_exited' } }, on).text, /quit unexpectedly/);
});
