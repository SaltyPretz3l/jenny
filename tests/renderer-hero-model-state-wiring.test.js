'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { bindHeroActions } = require('../renderer/chat/renderer-hero-model-state');
const reader = require('../renderer/shared/model-load-failure');
const { createPullController } = require('../renderer/shell/model-library/model-library-sources');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

test('in the app: hero Download reaches the section bridge, shared progress repaints, and Cancel restores the hero', async (t) => {
  const calls = [];
  const app = await loadRendererApp({ shell: { models: {
    async list() { return { available: true, data: [] }; },
    async load(model) { calls.push(['load', model]); return { status: 'ok' }; },
  } } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  let progress;
  shell.setup = { ...shell.setup,
    onModelPullProgress(listener) { progress = listener; return () => { progress = null; }; },
    async startOllamaPull(payload) { calls.push(['start', payload]); return { status: 'running' }; },
    async cancelOllamaPull(payload) { calls.push(['cancel', payload]); return { cancelled: true }; },
  };
  window.__rendererState.modelRecommendation = { tag: 'fit:3b', downloadSizeMb: 2000 };
  window.dispatchEvent(new window.CustomEvent('jenny:model-state-changed'));
  await waitForUi(window);
  doc.querySelector('[data-hero-action="download"]').click();
  await waitForUi(window);
  assert.equal(calls[0][1].model, 'fit:3b');
  assert.equal(doc.getElementById('heroTitle').closest('.hero-stage').dataset.modelState, 'downloading');
  assert.equal(doc.getElementById('composerLoadingLine').textContent, 'Jenny is downloading fit:3b. Send turns on when it is ready.');
  assert.equal(doc.getElementById('sendButton').title, doc.getElementById('composerLoadingLine').textContent);
  assert.equal(doc.getElementById('chatInput').disabled, false);
  progress({ requestId: calls[0][1].requestId, percent: 50, bytes: 1024, totalBytes: 2048 });
  await waitForUi(window);
  assert.equal(Object.values(window.__rendererState.modelPulls)[0].completedBytes, 1024);
  assert.match(doc.getElementById('heroSubtitle').textContent, /1 KB of 2 KB/);
  doc.querySelector('[data-hero-action="cancel-download"]').click();
  await waitForUi(window);
  assert.equal(calls[1][1].requestId, calls[0][1].requestId);
  assert.equal(doc.getElementById('heroTitle').textContent, 'Pick a model to start');
  assert.equal(Object.keys(window.__rendererState.modelPulls).length, 0);
  const input = doc.getElementById('chatInput');
  input.value = 'retry'; input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await shell.__emitBackendStatus({ phase: 'model_unavailable', model_lifecycle: { failure: { cause: 'timeout', model: 'large' } } });
  await waitForUi(window);
  assert.equal(doc.getElementById('composerLoadingLine').textContent, 'Sending retries the load.');
  assert.equal(doc.querySelector('[data-composer-failure-action]'), null);
  assert.equal(doc.getElementById('sendButton').disabled, false);
  doc.querySelector('[data-hero-action="retry"]').click();
  await waitForUi(window);
  assert.deepEqual(calls.at(-1), ['load', 'large']);
  doc.querySelector('[data-hero-action="retry"]').click();
  await waitForUi(window);
  assert.deepEqual(calls.at(-1), ['load', 'large']);
});

test('hero delegation dispatches download, browse, cancel and every recovery; cleanup removes it', async (t) => {
  const page = new JSDOM('<body></body>');
  t.after(() => page.window.close());
  const failure = { cause: 'out_of_memory', model: 'large', context: 40960, engine: 'llama-server' };
  const state = { backend: { phase: 'model_unavailable', model_lifecycle: { failure } } };
  const load = { model: 'large', engine_type: 'llama-server' };
  const calls = [];
  let cleanup;
  let applied = true;
  const dep = (name) => (...args) => { calls.push([name, ...args]); };
  Object.defineProperty(page.window.navigator, 'clipboard', { value: { writeText: dep('copy') }, configurable: true });
  bindHeroActions({ documentRef: page.window.document, windowRef: page.window, state, reader,
    registerCleanup: (fn) => { cleanup = fn; }, startPull: dep('start'), cancelPull: dep('cancel'),
    openSettingsSection: dep('settings'), openLogs: dep('logs'), loadModel: dep('load'),
    persistContext: async (payload) => { calls.push(['persist', payload]); return { status: applied ? 'applied' : 'failed' }; },
  });
  async function click(action, model = 'fit') {
    page.window.document.body.innerHTML = `<button data-hero-action="${action}" data-hero-model="${model}"><span>click</span></button>`;
    page.window.document.querySelector('span').click();
    await new Promise((resolve) => setImmediate(resolve));
  }
  for (const action of ['download', 'browse', 'cancel-download', 'retry', 'loadSmaller', 'showFits', 'diagnostics', 'copyDetails']) await click(action);
  assert.deepEqual(calls, [['start', 'fit'], ['settings', 'models'], ['cancel', 'fit'], ['load', load],
    ['persist', { modelId: 'large', contextLength: 32768 }], ['load', load], ['settings', 'models'], ['logs'],
    ['copy', reader.failureDetails(reader.readModelLoadFailure(state.backend))]]);
  applied = false;
  await click('loadSmaller');
  assert.equal(calls.at(-1)[0], 'persist', 'failed persistence must not load');
  delete page.window.navigator.clipboard;
  await click('copyDetails');
  cleanup();
  const count = calls.length;
  await click('download');
  assert.equal(calls.length, count);
});

test('pull notifications publish snapshots, numeric bytes and start time before the state event', async (t) => {
  const page = new JSDOM();
  t.after(() => page.window.close());
  const state = {};
  let progress;
  const snapshots = [];
  page.window.addEventListener('jenny:model-state-changed', () => snapshots.push(state.modelPulls));
  const controller = createPullController({ state, windowRef: page.window, setupService: {
    subscribePullProgress: (listener) => { progress = listener; return () => {}; },
    startOllamaPull: async () => ({ status: 'running' }), cancelOllamaPull: async () => ({ cancelled: true }),
  } });
  t.after(() => controller.dispose());
  const before = Date.now();
  await controller.start('fit:3b');
  const first = Object.values(state.modelPulls)[0];
  assert.ok(first.startedAt >= before && first.startedAt <= Date.now());
  progress({ requestId: first.requestId, status: 'downloading', percent: 50, bytes: 100, totalBytes: 200 });
  assert.deepEqual(state.modelPulls, controller.getPulls());
  assert.equal(Object.values(state.modelPulls)[0].completedBytes, 100);
  assert.equal(Object.values(state.modelPulls)[0].totalBytes, 200);
  assert.equal(Object.values(snapshots[0])[0].percent, 0, 'published records are snapshots');
  await controller.cancel('fit:3b');
  assert.deepEqual(state.modelPulls, {});
  assert.equal(snapshots.length, 3);
});
