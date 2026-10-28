'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const reader = require('../renderer/shared/model-load-failure');
const mergeModule = require('../renderer/shell/model-library/model-library-merge');
const sourcesModule = require('../renderer/shell/model-library/model-library-sources');
const { createModelLibrarySectionMerge } = require('../renderer/shell/model-library/model-library-section-merge');
const { createModelLibrarySectionLiveSync } = require('../renderer/shell/model-library/model-library-section-live-sync');
const { createModelLibrarySectionDelete, MODAL_ID } = require('../renderer/shell/model-library/model-library-section-delete');
const { createModelLibrarySectionMenu } = require('../renderer/shell/model-library/model-library-section-menu');

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('merge inputs: the signature tracks the state the last merge read', () => {
  const events = [];
  const state = { status: { model: 'qwen3:8b' }, features: { featureFlags: {} } };
  let sourceData = null;
  const merge = createModelLibrarySectionMerge({
    state, sourcesModule, mergeModule, loadFailureReader: reader,
    windowRef: { dispatchEvent: (event) => events.push(event.type), CustomEvent: class { constructor(type) { this.type = type; } } },
    getSourceData: () => sourceData, getEngineBlocks: () => null,
  });
  assert.equal(merge.buildMerged(), null, 'nothing merges before the sources load');
  assert.equal(merge.signatureUnchanged(), false);
  sourceData = { installed: [], ollamaTags: [], recommendations: [], hardware: {} };
  const merged = merge.buildMerged();
  assert.ok(Array.isArray(merged.cards));
  assert.equal(merge.signatureUnchanged(), true);
  state.status.model = 'llama3:8b';
  assert.equal(merge.signatureUnchanged(), false, 'a new active model invalidates the merge');
  assert.equal(merge.activeModel(), 'llama3:8b');
  assert.equal(merge.accelerationFlagEnabled(), false);
  state.features.featureFlags.llama_server_acceleration = true;
  assert.equal(merge.accelerationFlagEnabled(), true);
});

function liveSyncHarness(overrides = {}) {
  const calls = [];
  const timers = [];
  let disposed = false;
  let sourceData = { backendPending: true };
  const state = { backend: { phase: 'ready' }, modelList: { available: true }, features: {} };
  const windowRef = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => calls.push(['clearTimeout', id]),
    jennyShell: {},
  };
  const sync = createModelLibrarySectionLiveSync({
    windowRef, state, sourcesModule,
    source: { latestGeneration: () => 1 },
    isDisposed: () => disposed,
    accelerationFlagEnabled: () => true,
    getSourceData: () => sourceData,
    applyLlamaServer: (next) => calls.push(['apply', next]),
    refresh: () => { calls.push(['refresh']); return Promise.resolve(null); },
    rebuildFromState: () => calls.push(['rebuild']),
    ...overrides,
  });
  return { sync, calls, timers, state, windowRef, setSourceData: (value) => { sourceData = value; }, dispose: () => { disposed = true; } };
}

test('live sync: a pending load re-reads at most five times until a ready load restores the budget', () => {
  const h = liveSyncHarness();
  for (let i = 0; i < 7; i += 1) h.sync.syncFromState();
  assert.equal(h.calls.filter(([name]) => name === 'refresh').length, 5);
  assert.equal(h.calls.filter(([name]) => name === 'rebuild').length, 2, 'past the budget the tick only re-merges');
  h.sync.noteLoad({ backendPending: false });
  h.calls.length = 0;
  h.sync.syncFromState();
  assert.deepEqual(h.calls, [['refresh']]);
});

test('live sync: a parked llama-server is rechecked once, and dispose clears the timer', async () => {
  const h = liveSyncHarness();
  h.setSourceData({ llamaServer: null });
  const parked = { ok: true, state: 'stopped', identityRetained: true };
  h.windowRef.jennyShell.llamaServer = { getStatus: () => parked };
  h.sync.syncFromState();
  await flush();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 3000);
  assert.equal(h.calls.filter(([name]) => name === 'apply').length, 1);
  h.sync.syncFromState();
  await flush();
  assert.equal(h.timers.length, 1, 'one recheck timer at a time');
  h.sync.dispose();
  assert.deepEqual(h.calls.at(-1), ['clearTimeout', 1]);
});

function deleteHarness(windowRef) {
  const calls = [];
  const nodes = [];
  // The dialog mounts on the body; the section only supplies the ⋯ buttons.
  const documentRef = {
    querySelector: (selector) => (selector === '[data-step-modal="' + MODAL_ID + '"]' ? nodes[0] || null : null),
    body: {
      insertAdjacentHTML: (_where, html) => {
        const node = {
          html,
          parentNode: { removeChild: () => nodes.splice(0, 1) },
          addEventListener: () => {},
          removeEventListener: () => {},
        };
        nodes.push(node);
      },
    },
  };
  const section = { querySelectorAll: () => [] };
  const flow = createModelLibrarySectionDelete({
    windowRef, documentRef, card: () => section,
    stepModal: { renderStepModal: (options) => 'modal:' + options.summary },
    boundedErrorMessage: (_error, fallback) => fallback,
    findModel: (tag) => (tag === 'qwen3:8b' ? { key: tag } : null),
    isDisposed: () => false,
    setStatusMessage: (message) => calls.push(['status', message]),
    statusMessage: () => '',
    refresh: () => { calls.push(['refresh']); return Promise.resolve(null); },
    refreshModelPickers: () => calls.push(['pickers']),
    appendClientLog: () => {},
  });
  return { flow, calls, nodes };
}

test('delete flow: Escape dismisses the dialog, and a re-render keeps an open one', () => {
  const h = deleteHarness({});
  h.flow.requestConfirm('qwen3:8b');
  assert.equal(h.nodes.length, 1);
  const open = h.nodes[0];
  h.flow.renderConfirmModal();
  assert.equal(h.nodes[0], open, 'the same dialog node survives a row re-render');
  h.flow.handleKeydown({ key: 'Enter' });
  assert.equal(h.nodes.length, 1);
  h.flow.handleKeydown({ key: 'Escape' });
  assert.equal(h.nodes.length, 0);
});

test('delete flow: confirm deletes once, refreshes, and refuses a second delete in flight', async () => {
  let finish;
  const deletes = [];
  const h = deleteHarness({ jennyShell: { models: { delete: (payload) => { deletes.push(payload); return new Promise((resolve) => { finish = resolve; }); } } } });
  const confirmTarget = (action) => ({
    closest: (selector) => (selector === '[data-step-modal-action]'
      ? { getAttribute: () => action, closest: () => ({}) } : null),
  });
  h.flow.requestConfirm('qwen3:8b');
  h.flow.handleClick(confirmTarget('confirm'));
  assert.deepEqual(deletes, [{ model: 'qwen3:8b' }]);
  h.flow.requestConfirm('qwen3:8b');
  h.flow.handleClick(confirmTarget('confirm'));
  assert.deepEqual(h.calls.splice(0), [['status', 'Still removing the previous model.']]);
  finish({ status: 'deleted' });
  await flush();
  assert.deepEqual(h.calls, [['status', '"qwen3:8b" removed.'], ['refresh'], ['pickers']]);
});

test('menu: Tune options drop Ollama facts while its tag list is unreadable', () => {
  let sourceData = { unavailable: {} };
  const menu = createModelLibrarySectionMenu({
    state: {}, getSourceData: () => sourceData, ninferLibraryInput: () => null,
  });
  const engines = { ollama: { installed: true }, llamaServer: { ready: true } };
  assert.deepEqual(menu.tuneOptions({ displayName: 'Qwen', engines }), {
    displayName: 'Qwen', engines, engineTypeHint: '', ninfer: null,
  });
  sourceData = { unavailable: { ollamaTags: 'down' } };
  assert.deepEqual(menu.tuneOptions({ engines, libraryGguf: true }).engines, { ollama: null, llamaServer: { ready: true } });
  assert.equal(menu.tuneOptions({ libraryGguf: true }).engineTypeHint, 'openai-compatible');
});

test('delete flow: after a removal focus moves to the row now in its place, else to the status line', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<section><div class="settings-note model-library-section-status"></div><div id="rows"></div></section>');
  const doc = dom.window.document;
  const rows = doc.getElementById('rows');
  const paint = (tags) => {
    rows.innerHTML = tags.map((tag) => `<button data-model-card-action="menu" data-model-tag="${tag}">⋯</button>`).join('');
  };
  let tags = ['a:1', 'qwen3:8b', 'c:3'];
  paint(tags);
  const run = async (removed) => {
    const flow = createModelLibrarySectionDelete({
      windowRef: { jennyShell: { models: { delete: async () => ({ status: 'deleted' }) } } },
      documentRef: doc, card: () => doc.querySelector('section'),
      stepModal: { renderStepModal: () => '<div></div>' },
      boundedErrorMessage: (_error, fallback) => fallback,
      findModel: (tag) => (tags.includes(tag) ? { key: tag } : null),
      isDisposed: () => false, setStatusMessage: () => {}, statusMessage: () => '',
      refresh: async () => { tags = tags.filter((tag) => tag !== removed); paint(tags); },
      refreshModelPickers: () => {}, appendClientLog: () => {},
    });
    flow.requestConfirm(removed);
    flow.handleClick({ closest: (selector) => (selector === '[data-step-modal-action]' ? { getAttribute: () => 'confirm', closest: () => ({}) } : null) });
    for (let i = 0; i < 5; i += 1) await flush();
    return doc.activeElement;
  };
  const next = await run('qwen3:8b');
  assert.equal(next.getAttribute('data-model-tag'), 'c:3', 'the row that moved into the removed one\'s place');
  await run('c:3');
  await run('a:1');
  const last = doc.activeElement;
  assert.ok(last.classList.contains('model-library-section-status'), 'no rows left: the status line that says what happened');
  assert.equal(last.getAttribute('tabindex'), '-1');
  dom.window.close();
});
