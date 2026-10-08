'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const reader = require('../renderer/shared/model-load-failure');
const { bindComposerModelFailureActions } = require('../renderer/chat/renderer-composer-model-failure-actions');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function backend(cause = 'out_of_memory') {
  return { phase: 'model_unavailable', model_lifecycle: { requested_model: 'qwen3:8b', engine: 'ollama',
    failure: { cause, model: 'qwen3:8b', context: 40960, message: 'memory', engine: 'ollama', at: '2026-10-07T12:00:00Z' } } };
}

test('delegated composer recovery routes all four actions and cleans up', async (t) => {
  const dom = new JSDOM('<!doctype html><body></body>');
  t.after(() => dom.window.close());
  const documentRef = dom.window.document;
  const state = { backend: backend() };
  const calls = [];
  let cleanup;
  bindComposerModelFailureActions({ documentRef, windowRef: dom.window, state, reader,
    openSettingsSection: (section) => calls.push(['settings', section]), openLogs: () => calls.push(['logs']),
    loadModel: (model) => calls.push(['load', model]),
    persistContext: async (payload) => { calls.push(['persist', payload]); return { status: 'applied' }; },
    registerCleanup: (fn) => { cleanup = fn; } });
  // Added after binding: split panes share the document delegation.
  documentRef.body.innerHTML = ['models', 'retry', 'loadSmaller', 'diagnostics', 'showFits'].map((action) =>
    `<button data-composer-failure-action="${action}"><span>${action}</span></button>`).join('');
  for (const action of ['models', 'retry', 'loadSmaller', 'diagnostics', 'showFits']) {
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    documentRef.querySelector(`[data-composer-failure-action="${action}"] span`).dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(calls.splice(0), [['settings', 'models'], ['load', { model: 'qwen3:8b', engine_type: 'ollama' }],
    ['persist', { modelId: 'qwen3:8b', contextLength: 32768 }], ['load', { model: 'qwen3:8b', engine_type: 'ollama' }], ['logs'], ['settings', 'models']]);
  state.backend = { phase: 'ready' };
  documentRef.querySelector('[data-composer-failure-action="retry"]').click();
  assert.deepEqual(calls, []);
  state.backend = backend();
  cleanup();
  documentRef.querySelector('[data-composer-failure-action="retry"]').click();
  assert.deepEqual(calls, []);
});

test('in the app: failure line remains sendable and recovery uses shell APIs and navigation', async (t) => {
  const calls = [];
  const app = await loadRendererApp({ shell: {
    status: { async get() { return { model_loaded: false }; } },
    models: { async load(payload) { calls.push(['load', payload]); return { status: 'ok' }; } },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  shell.modelTuning = { async update(payload) { calls.push(['persist', payload]); return { status: 'applied' }; } };
  const doc = window.document;
  // A populated session: with an empty chat the hero tells the failure instead (item 5).
  doc.getElementById('newChatButton').click();
  await waitForUi(window);
  window.__rendererState.messagesBySession.set(window.__rendererState.currentSessionId, [{ kind: 'user', content: 'existing' }]);
  const input = doc.getElementById('chatInput');
  input.value = 'retry this model';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await shell.__emitBackendStatus(backend());
  await waitForUi(window);
  const line = doc.getElementById('composerLoadingLine');
  assert.equal(line?.dataset.tone, 'failed');
  assert.match(line.textContent, /qwen3:8b didn't load/);
  assert.equal(doc.getElementById('sendButton').dataset.modelLoading, 'false');
  assert.equal(doc.getElementById('sendButton').disabled, false);
  line.querySelector('[data-composer-failure-action="loadSmaller"]').click();
  await waitForUi(window);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.splice(0))), [['persist', { modelId: 'qwen3:8b', contextLength: 32768 }], ['load', { model: 'qwen3:8b', engine_type: 'ollama' }]]);
  line.querySelector('[data-composer-failure-action="models"]').click();
  await waitForUi(window);
  assert.equal(window.__rendererState.ui.activeView, 'settings');
  assert.equal(window.__rendererState.ui.activeSettingsSection, 'models');
  await shell.__emitBackendStatus(backend('engine_unreachable'));
  doc.getElementById('chatTopRailTab').click();
  await waitForUi(window);
  doc.querySelector('[data-composer-failure-action="diagnostics"]').click();
  await waitForUi(window);
  assert.equal(window.__rendererState.ui.activeView, 'logs');
  await shell.__emitBackendStatus({ phase: 'ready' });
  await waitForUi(window);
  assert.equal(doc.getElementById('composerLoadingLine'), null);
});
