'use strict';

// Status loader (2026-09-29, F6): while a model loads the composer says so in
// one line under the input, Send's disabled tooltip repeats the same sentence
// (one key), and the hero's "Model loads with your first message" hint shows
// only in the lazy state with no load in flight.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const composerRender = require('../renderer/chat/renderer-composer-v2-render');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const LOADING = 'Jenny is loading qwen3:8b. You can type; Send turns on when it is ready.';

test('describeModelLoading names the model only while one is loading', () => {
  const { describeModelLoading } = composerRender;
  assert.equal(describeModelLoading({ phase: 'model_loading', model_acquisition: { requested_model: 'qwen3:8b' } }), LOADING);
  assert.equal(describeModelLoading({ phase: 'model_acquiring', model_lifecycle: { requested_model: 'qwen3:8b' } }), LOADING);
  assert.equal(
    describeModelLoading({ phase: 'model_loading' }),
    'Jenny is loading the model. You can type; Send turns on when it is ready.',
  );
  for (const phase of ['ready', 'retrying', 'failed', 'starting', 'sidecar_spawned', 'model_unavailable']) {
    assert.equal(describeModelLoading({ phase, model_acquisition: { requested_model: 'qwen3:8b' } }), '', phase);
  }
  assert.equal(describeModelLoading(null), '');
});

test('syncComposerLoadingLine puts one line in the row, before the timer, and clears it', () => {
  const dom = new JSDOM('<!doctype html><body><div id="composerModeChips">'
    + '<div id="composerModeChipsAnnouncer"></div><span id="composerTurnTimer"></span></div></body>');
  const doc = dom.window.document;
  const row = doc.getElementById('composerModeChips');
  const line = composerRender.syncComposerLoadingLine(doc, LOADING);
  assert.equal(line.textContent, LOADING);
  assert.equal(line.className, 'composer-loading-line', 'the line owns its own caption class');
  assert.equal(line.parentElement, row);
  assert.equal(line.nextElementSibling, doc.getElementById('composerTurnTimer'), 'the line sits before the timer');
  assert.equal(composerRender.syncComposerLoadingLine(doc, LOADING), line, 'the same node across updates');
  assert.equal(composerRender.syncComposerLoadingLine(doc, ''), null);
  assert.equal(doc.getElementById('composerLoadingLine'), null);
  dom.window.close();
});

test('split view: every pane shows the loading line in its own row, and every pane clears', () => {
  const dom = new JSDOM('<!doctype html><body>'
    + '<div class="chat-pane" data-pane-id="0"><div id="composerModeChips">'
    + '<span id="composerTurnTimer"></span></div></div>'
    + '<div class="chat-pane" data-pane-id="1"><div class="composer-mode-chips chat-pane-mode-chips" data-chat-node="composerModeChips"></div></div>'
    + '</body>');
  const doc = dom.window.document;
  const paneOne = doc.querySelector('.chat-pane[data-pane-id="1"]');
  composerRender.syncComposerLoadingLines(doc, LOADING);
  assert.equal(doc.getElementById('composerLoadingLine')?.textContent, LOADING, 'pane 0 keeps its id-addressed line');
  const paneLine = paneOne.querySelector('[data-chat-node="composerLoadingLine"]');
  assert.equal(paneLine?.textContent, LOADING, 'pane 1 shows the same line in its own row');
  assert.equal(paneLine.parentElement, paneOne.querySelector('[data-chat-node="composerModeChips"]'));
  assert.equal(paneLine.id, '', 'no duplicate id in the second pane');
  assert.equal(doc.querySelectorAll('.composer-loading-line').length, 2, 'one line per pane, not two in pane 0');
  composerRender.syncComposerLoadingLines(doc, LOADING);
  assert.equal(paneOne.querySelector('[data-chat-node="composerLoadingLine"]'), paneLine, 'the same node across updates');
  composerRender.syncComposerLoadingLines(doc, '');
  assert.equal(doc.querySelectorAll('.composer-loading-line').length, 0);
  dom.window.close();
});

test('in the app: the load shows the composer line, the same tooltip and no hero hint; ready clears it', async (t) => {
  // A fresh boot: no session yet, so the load must still be the reason given.
  const app = await loadRendererApp({ shell: { status: { async get() { return { model_loaded: false }; } } } });
  t.after(async () => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  input.value = 'hello while it loads';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window);

  await shell.__emitBackendStatus({
    phase: 'model_loading', detail: '', mode: 'managed-dev',
    model_acquisition: { requested_model: 'qwen3:8b', stage: 'loading' },
  });
  await waitForUi(window);
  assert.equal(doc.getElementById('composerLoadingLine')?.textContent, LOADING);
  assert.equal(input.disabled, false, 'typing stays allowed');
  const sendButton = doc.getElementById('sendButton');
  assert.equal(sendButton.disabled, true);
  assert.equal(sendButton.getAttribute('title'), LOADING, 'the tooltip repeats the line');
  assert.equal(doc.getElementById('heroRuntimeHint').classList.contains('hidden'), true, 'no hero hint while a load is in flight');

  await shell.__emitBackendStatus({ phase: 'ready', detail: '', mode: 'managed-dev' });
  await waitForUi(window);
  assert.equal(doc.getElementById('composerLoadingLine'), null);
  assert.notEqual(sendButton.getAttribute('title'), LOADING);
});
