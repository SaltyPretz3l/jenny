'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeFimPicker } = require('../renderer/features/renderer-ide-fim-picker');
const popover = require('../renderer/inventory/popover');
const actionButton = require('../renderer/inventory/action-button');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function build({
  models,
  loaded = [],
  ide = { inlineSuggestModel: '' },
  loadOnComplete = false,
  completeReturn = { ok: true, completion: '' },
  loadedModelsFails = false,
} = {}) {
  const dom = new JSDOM('<div id="ideShell"></div>');
  const shell = dom.window.document.getElementById('ideShell');
  const anchor = dom.window.document.createElement('button');
  shell.appendChild(anchor);
  const calls = { complete: [], unload: [], loadedModels: 0 };
  const windowRef = {
    jennyShell: {
      models: {
        async listOllamaTags() { return { data: models }; },
      },
      inline: {
        async loadedModels() {
          calls.loadedModels += 1;
          // A degraded { ok:false } shape models a transient /api/ps query failure.
          return loadedModelsFails ? { ok: false, loaded: [] } : { ok: true, loaded };
        },
        async complete(payload) {
          calls.complete.push(payload);
          // Simulate the daemon loading the model so a follow-up /api/ps reflects it.
          if (loadOnComplete && !loaded.includes(payload.model)) { loaded.push(payload.model); }
          return completeReturn;
        },
        async unloadModel(payload) {
          calls.unload.push(payload);
          // Drop it from the daemon's loaded set so a refresh reflects ground truth.
          const i = loaded.indexOf(payload.model);
          if (i >= 0) { loaded.splice(i, 1); }
          return { ok: true };
        },
      },
    },
  };
  let renders = 0;
  const picker = createIdeFimPicker({
    getDom: () => ({ ideShell: shell }),
    getIde: () => ide,
    popover,
    actionButton,
    commitPreference: async (key, value) => {
      renders += 1; ide[key] = value; return { updated: true, value };
    },
    requestStatusRender: () => {},
    windowRef,
  });
  picker.initHandlers();
  return { dom, picker, shell, anchor, ide, calls, getPersists: () => renders };
}

const FIM = { id: 'qwen2.5-coder:1.5b-base', capabilities: { insert: true } };
const CHAT = { id: 'gemma4-vision:12b', capabilities: { vision: true } };

test('the menu lists only FIM models, marking the loaded one', async () => {
  const { picker, shell, anchor } = build({
    models: [FIM, CHAT],
    loaded: ['qwen2.5-coder:1.5b-base'],
  });
  picker.open(anchor);
  await flush();

  const popEl = shell.querySelector('.inv-popover');
  assert.ok(popEl && !popEl.hidden, 'the FIM menu opens');
  const rows = [...popEl.querySelectorAll('[data-ide-fim-model]')].map((b) => b.getAttribute('data-ide-fim-model'));
  assert.deepEqual(rows, ['qwen2.5-coder:1.5b-base'], 'chat model is excluded (FIM-only)');
  assert.equal(popEl.querySelector('[data-ide-fim-model]').getAttribute('title'), 'Choose the inline-completion model');
  const dot = popEl.querySelector('[data-ide-fim-model] .ide-fim-dot');
  assert.ok(dot.classList.contains('ide-fim-dot--on'), 'the loaded model shows a filled dot');
});

test('selecting a model sets + persists it and warms (loads) it', async () => {
  const { picker, shell, anchor, ide, calls, getPersists } = build({
    models: [FIM],
    loaded: [],
  });
  picker.open(anchor);
  await flush();
  const popEl = shell.querySelector('.inv-popover');
  popEl.querySelector('[data-ide-fim-model="qwen2.5-coder:1.5b-base"]').click();
  await flush();

  assert.equal(ide.inlineSuggestModel, 'qwen2.5-coder:1.5b-base', 'slice updated');
  assert.ok(getPersists() >= 1, 'persisted');
  assert.equal(calls.complete.length, 1, 'warmed via inline.complete');
  assert.equal(calls.complete[0].model, 'qwen2.5-coder:1.5b-base');
  assert.equal(calls.complete[0].maxTokens, 1, 'used a 1-token warm probe');
});

test('Unload evicts the selected model by tag and refreshes the loaded state', async () => {
  const { picker, shell, anchor, calls } = build({
    models: [FIM],
    loaded: ['qwen2.5-coder:1.5b-base'],
    ide: { inlineSuggestModel: 'qwen2.5-coder:1.5b-base' },
  });
  picker.open(anchor);
  await flush();
  let popEl = shell.querySelector('.inv-popover');
  // The dot starts filled (loaded).
  assert.ok(popEl.querySelector('.ide-fim-dot').classList.contains('ide-fim-dot--on'));

  popEl.querySelector('[data-ide-fim-action="unload"]').click();
  await flush();

  assert.equal(calls.unload.length, 1, 'called inline.unloadModel');
  assert.equal(calls.unload[0].model, 'qwen2.5-coder:1.5b-base');
  popEl = shell.querySelector('.inv-popover');
  assert.ok(!popEl.querySelector('.ide-fim-dot').classList.contains('ide-fim-dot--on'), 'dot clears after unload');
});

test('shows an empty state when no FIM models are installed', async () => {
  const { picker, shell, anchor } = build({ models: [CHAT] });
  picker.open(anchor);
  await flush();
  const popEl = shell.querySelector('.inv-popover');
  assert.equal(popEl.querySelectorAll('[data-ide-fim-model]').length, 0);
  assert.match(popEl.querySelector('.ide-fim-empty').textContent, /No fill-in-the-middle models/);
});

test('Load reports success once the daemon actually holds the model', async () => {
  const { picker, shell, anchor } = build({
    models: [FIM],
    loaded: [],
    ide: { inlineSuggestModel: 'qwen2.5-coder:1.5b-base' },
    loadOnComplete: true,
  });
  picker.open(anchor);
  await flush();
  let popEl = shell.querySelector('.inv-popover');
  popEl.querySelector('[data-ide-fim-action="load"]').click();
  await flush();

  popEl = shell.querySelector('.inv-popover');
  const status = popEl.querySelector('.ide-fim-status');
  assert.match(status.textContent, /Loaded/, 'shows a success confirmation, not silence');
  assert.ok(status.classList.contains('ide-fim-status--ok'), 'success uses the ok tone');
});

test('Load reports ready (not a false eviction) when the /api/ps re-query fails', async () => {
  const { picker, shell, anchor } = build({
    models: [FIM],
    loaded: [],
    ide: { inlineSuggestModel: 'qwen2.5-coder:1.5b-base' },
    completeReturn: { ok: true, completion: '' }, // warm succeeded → model is resident
    loadedModelsFails: true,                      // but the loaded-state query failed
  });
  picker.open(anchor);
  await flush();
  let popEl = shell.querySelector('.inv-popover');
  popEl.querySelector('[data-ide-fim-action="load"]').click();
  await flush();

  popEl = shell.querySelector('.inv-popover');
  const status = popEl.querySelector('.ide-fim-status');
  assert.match(status.textContent, /ready to autocomplete/, 'a successful warm reports ready');
  assert.doesNotMatch(status.textContent, /did not stay resident/, 'no false eviction advice when the query simply failed');
});

test('Load surfaces the backend reason when the warm call is not ok', async () => {
  const { picker, shell, anchor } = build({
    models: [FIM],
    loaded: [],
    ide: { inlineSuggestModel: 'qwen2.5-coder:1.5b-base' },
    completeReturn: { ok: false, reason: 'sidecar_not_ready' },
  });
  picker.open(anchor);
  await flush();
  let popEl = shell.querySelector('.inv-popover');
  popEl.querySelector('[data-ide-fim-action="load"]').click();
  await flush();

  popEl = shell.querySelector('.inv-popover');
  const status = popEl.querySelector('.ide-fim-status--warn');
  assert.ok(status, 'a failure is surfaced (not silent)');
  assert.match(status.textContent, /still starting/, 'maps the reason to a human message');
});

test('shows a paused hint when the autocomplete quick-toggle is off', async () => {
  const { picker, shell, anchor } = build({
    models: [FIM],
    loaded: ['qwen2.5-coder:1.5b-base'],
    ide: {
      inlineSuggestModel: 'qwen2.5-coder:1.5b-base',
      inlineSuggestEnabled: false,
    },
  });
  picker.open(anchor);
  await flush();
  const popEl = shell.querySelector('.inv-popover');
  const text = [...popEl.querySelectorAll('.ide-fim-status')].map((n) => n.textContent).join(' ');
  assert.match(text, /paused/, 'explains why loading alone produces no ghost text');
});

test('re-clicking the caret toggles the menu closed', async () => {
  const { picker, shell, anchor } = build({ models: [FIM] });
  picker.open(anchor);
  await flush();
  const popEl = shell.querySelector('.inv-popover');
  assert.equal(popEl.hidden, false);
  picker.open(anchor);
  assert.equal(popEl.hidden, true, 'second open closes it');
});

// Builds a harness whose inline.complete / unloadModel / loadedModels are
// DEFERRED (caller-controlled resolution order) so a test can resolve an
// earlier click's promises after a later click's, reproducing the race. The
// FIRST loadedModels() call (the initial refresh() triggered by open())
// resolves immediately so the menu actually populates with rows; only
// SUBSEQUENT calls (from load()/unload() ground-truth re-queries) are queued.
function buildDeferred({ ide = { inlineSuggestModel: '' }, initialLoaded = [], deferInitialRefresh = false } = {}) {
  const dom = new JSDOM('<div id="ideShell"></div>');
  const shell = dom.window.document.getElementById('ideShell');
  const anchor = dom.window.document.createElement('button');
  shell.appendChild(anchor);
  const completeQueue = [];
  const unloadQueue = [];
  const loadedQueue = [];
  const calls = { complete: [], unload: [], loadedModels: 0 };
  function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  }
  const windowRef = {
    jennyShell: {
      models: {
        async listOllamaTags() {
          return { data: [FIM] };
        },
      },
      inline: {
        complete(payload) {
          calls.complete.push(payload);
          const d = deferred();
          completeQueue.push(d);
          return d.promise;
        },
        unloadModel(payload) {
          calls.unload.push(payload);
          const d = deferred();
          unloadQueue.push(d);
          return d.promise;
        },
        loadedModels() {
          calls.loadedModels += 1;
          if (calls.loadedModels === 1 && !deferInitialRefresh) {
            return Promise.resolve({ ok: true, loaded: initialLoaded.slice() });
          }
          const d = deferred();
          loadedQueue.push(d);
          return d.promise;
        },
      },
    },
  };
  const picker = createIdeFimPicker({
    getDom: () => ({ ideShell: shell }),
    getIde: () => ide,
    popover,
    actionButton,
    commitPreference: async (key, value) => { ide[key] = value; return { updated: true, value }; },
    requestStatusRender: () => {},
    windowRef,
  });
  picker.initHandlers();
  return {
    picker, shell, anchor, ide, calls,
    completeQueue, unloadQueue, loadedQueue,
  };
}

test('Load superseding a deferred initial refresh settles the loading placeholder', async () => {
  const { picker, shell, anchor, completeQueue, loadedQueue } = buildDeferred({
    ide: { inlineSuggestModel: 'qwen2.5-coder:1.5b-base' },
    deferInitialRefresh: true,
  });
  picker.open(anchor);
  await flush();
  shell.querySelector('[data-ide-fim-action="load"]').click();
  await flush();

  completeQueue[0].resolve({ ok: true, completion: '' });
  await flush();
  loadedQueue[1].resolve({ ok: true, loaded: ['qwen2.5-coder:1.5b-base'] });
  await flush();
  loadedQueue[0].resolve({ ok: true, loaded: [] });
  await flush();

  assert.match(shell.querySelector('.ide-fim-status').textContent, /Loaded/);
  assert.doesNotMatch(shell.querySelector('.ide-fim-empty').textContent, /Loading models/);
});

test('rapid clicks on model A then B: resolving A after B leaves the menu reflecting B (latest)', async () => {
  const A = { id: 'model-a', capabilities: { insert: true } };
  const B = { id: 'model-b', capabilities: { insert: true } };
  const dom = new JSDOM('<div id="ideShell"></div>');
  const shell = dom.window.document.getElementById('ideShell');
  const anchor = dom.window.document.createElement('button');
  shell.appendChild(anchor);
  const ide = { inlineSuggestModel: '' };
  const completeResolvers = [];
  const loadedResolvers = [];
  let loadedCalls = 0;
  const windowRef = {
    jennyShell: {
      models: { async listOllamaTags() { return { data: [A, B] }; } },
      inline: {
        complete(payload) {
          return new Promise((resolve) => {
            completeResolvers.push({ model: payload.model, resolve });
          });
        },
        loadedModels() {
          loadedCalls += 1;
          // The initial refresh() from open() resolves immediately so the
          // menu actually populates; only the load()-triggered re-queries
          // (the ones under test) are deferred.
          if (loadedCalls === 1) {
            return Promise.resolve({ ok: true, loaded: [] });
          }
          return new Promise((resolve) => {
            loadedResolvers.push(resolve);
          });
        },
      },
    },
  };
  const picker = createIdeFimPicker({
    getDom: () => ({ ideShell: shell }),
    getIde: () => ide,
    popover,
    actionButton,
    commitPreference: async (key, value) => { ide[key] = value; return { updated: true, value }; },
    requestStatusRender: () => {},
    windowRef,
  });
  picker.initHandlers();
  picker.open(anchor);
  await flush();
  const popEl = shell.querySelector('.inv-popover');
  // Click A's row, then click B's row, before either's IPC resolves.
  popEl.querySelector('[data-ide-fim-model="model-a"]').click();
  await flush();
  popEl.querySelector('[data-ide-fim-model="model-b"]').click();
  await flush();

  assert.equal(completeResolvers.length, 2, 'api.complete fired for each click');
  assert.equal(completeResolvers[0].model, 'model-a');
  assert.equal(completeResolvers[1].model, 'model-b');

  // Resolve B's warm call first, then A's (out of order) — A is stale by the
  // time its promise settles, so its post-await guard must stop it before it
  // ever reaches fetchLoaded(); only B's op should query loaded-state.
  completeResolvers[1].resolve({ ok: true, completion: '' });
  await flush();
  completeResolvers[0].resolve({ ok: true, completion: '' });
  await flush();

  assert.equal(loadedResolvers.length, 1, 'the stale A op is guarded off before fetchLoaded(); only B queries it');
  loadedResolvers[0]({ ok: true, loaded: ['model-b'] });
  await flush();

  assert.equal(ide.inlineSuggestModel, 'model-b', 'the last click wins the selection');
  const status = shell.querySelector('.ide-fim-status');
  assert.match(status.textContent, /ready to autocomplete/, 'status reflects B, not A');
  assert.ok(status.classList.contains('ide-fim-status--ok'));
  const dotB = shell.querySelector('[data-ide-fim-model="model-b"] .ide-fim-dot');
  assert.ok(dotB.classList.contains('ide-fim-dot--on'), 'B renders as loaded');
});

test("stale first-clicked load's completion is ignored once superseded (busy/footer end in B's state)", async () => {
  const { picker, shell, anchor, completeQueue, loadedQueue } = buildDeferred();
  picker.open(anchor);
  await flush();
  const popEl = shell.querySelector('.inv-popover');
  // Re-query the row after each renderMenu() rebuild of host.innerHTML — a
  // stale reference to a since-replaced node won't bubble its click to host.
  const queryRow = () => shell.querySelector('[data-ide-fim-model="qwen2.5-coder:1.5b-base"]');
  queryRow().click();
  await flush();
  assert.equal(completeQueue.length, 1, 'first load started');

  // Resolve the first op's FIRST await only — this flips busy back to false
  // (before its ground-truth re-query runs), opening the window for a second,
  // overlapping load() to start via a second click before the first settles.
  completeQueue[0].resolve({ ok: true, completion: '' });
  await flush();
  queryRow().click();
  await flush();

  assert.equal(completeQueue.length, 2, 'second (overlapping) load op started');
  // Resolve the SECOND op's warm call, then its ground-truth re-query, fully first.
  completeQueue[1].resolve({ ok: true, completion: '' });
  await flush();
  assert.equal(loadedQueue.length, 2, 'one fetchLoaded per op');
  loadedQueue[1].resolve({ ok: true, loaded: ['qwen2.5-coder:1.5b-base'] });
  await flush();

  const statusAfterSecond = shell.querySelector('.ide-fim-status');
  assert.match(statusAfterSecond.textContent, /ready to autocomplete/, 'second op completed cleanly');

  // Now resolve the FIRST (stale) op's ground-truth re-query — it must not clobber state.
  loadedQueue[0].resolve({ ok: true, loaded: [] });
  await flush();

  const statusFinal = shell.querySelector('.ide-fim-status');
  assert.match(statusFinal.textContent, /ready to autocomplete/, 'stale op did not overwrite the final status');
  assert.ok(statusFinal.classList.contains('ide-fim-status--ok'), 'stale op did not flip the tone to warn');
});

test('Load then immediately Unload on the same model: Unload wins even if Load resolves afterward', async () => {
  // Start with the model already resident so the Unload button is enabled
  // from the outset. Load's own busy=true visually disables both action
  // buttons while it runs, and the picker does not re-render between
  // busy=false and the ground-truth re-query inside load() — so the DOM
  // doesn't reflect the "busy briefly cleared" instant a real click would
  // race against. The fimOpSeq guard exists precisely for that untelegraphed
  // window, so the test drives unload() directly (bypassing the stale
  // disabled attribute, same as a click landing in that window would) to
  // exercise the guard itself: whichever op is LATEST must win regardless of
  // resolution order, which is the contract fimOpSeq protects.
  const { picker, shell, anchor, completeQueue, unloadQueue, loadedQueue } = buildDeferred({
    ide: { inlineSuggestModel: 'qwen2.5-coder:1.5b-base' },
    initialLoaded: ['qwen2.5-coder:1.5b-base'],
  });
  picker.open(anchor);
  await flush();
  const queryRow = () => shell.querySelector('[data-ide-fim-model="qwen2.5-coder:1.5b-base"]');
  const queryAction = (action) => shell.querySelector(`[data-ide-fim-action="${action}"]`);

  // The Load button itself is disabled while the model already shows loaded,
  // so trigger load() the way a re-pick would: via the (unconditional) row click.
  queryRow().click();
  await flush();
  assert.equal(completeQueue.length, 1, 'load started');

  completeQueue[0].resolve({ ok: true, completion: '' });
  await flush();

  // Force the click through despite the stale disabled attribute — the DOM
  // hasn't re-rendered since busy flipped back to false inside load(), but a
  // real click landing in that instant would behave identically.
  queryAction('unload').disabled = false;
  queryAction('unload').click();
  await flush();
  assert.equal(unloadQueue.length, 1, 'unload started while load\'s tail was still pending');

  // Resolve Unload's IPC and its ground-truth re-query fully first...
  unloadQueue[0].resolve({ ok: true });
  await flush();
  assert.equal(loadedQueue.length, 2, 'one fetchLoaded from load\'s tail, one from unload');
  loadedQueue[1].resolve({ ok: true, loaded: [] });
  await flush();

  const statusAfterUnload = shell.querySelector('.ide-fim-status');
  assert.match(statusAfterUnload.textContent, /Unloaded/, 'unload (the latest op) reports its outcome');

  // ...then resolve Load's stale ground-truth re-query — it must not
  // overwrite Unload's outcome with a "Loaded" message.
  loadedQueue[0].resolve({ ok: true, loaded: ['qwen2.5-coder:1.5b-base'] });
  await flush();

  const statusFinal = shell.querySelector('.ide-fim-status');
  assert.match(statusFinal.textContent, /Unloaded/, 'stale Load tail does not clobber Unload\'s outcome');
});

test('post-dispose continuation is a no-op: no throw, no stale write after dispose', async () => {
  const { picker, shell, anchor, ide, completeQueue, loadedQueue } = buildDeferred({
    ide: { inlineSuggestModel: '' },
  });
  picker.open(anchor);
  await flush();
  const popEl = shell.querySelector('.inv-popover');
  popEl.querySelector('[data-ide-fim-model="qwen2.5-coder:1.5b-base"]').click();
  await flush();

  assert.equal(completeQueue.length, 1, 'load started');
  picker.dispose();

  // Resolve the in-flight promises AFTER dispose — must not throw and must
  // not write into the (now detached) host.
  assert.doesNotThrow(() => {
    completeQueue[0].resolve({ ok: true, completion: '' });
  });
  await flush();
  if (loadedQueue.length) {
    assert.doesNotThrow(() => {
      loadedQueue[0].resolve({ ok: true, loaded: ['qwen2.5-coder:1.5b-base'] });
    });
    await flush();
  }
  // No throw is the primary assertion; the host was removed by dispose().
  assert.equal(shell.querySelector('.ide-fim-popover'), null, 'host stays detached, no resurrection');
});

// Invariant: a stale pre-dispose load() continuation can never corrupt a
// reopened picker. This is jointly protected by dispose()'s fimOpSeq bump AND
// the reopen's own refresh() claiming a fresh op id (either alone supersedes the
// straggler); the test pins the end-to-end invariant, not one specific line.
test('a pre-dispose load continuation cannot write into a reopened picker', async () => {
  const { picker, shell, anchor, completeQueue, loadedQueue } = buildDeferred({
    ide: { inlineSuggestModel: '' },
  });
  picker.open(anchor);
  await flush();
  shell.querySelector('[data-ide-fim-model="qwen2.5-coder:1.5b-base"]').click();
  await flush();
  assert.equal(completeQueue.length, 1, 'the (soon-to-be-stale) load started');
  picker.dispose();       // bumps fimOpSeq; the reopen below also claims a fresh op id
  picker.open(anchor);    // fresh, live host — its own open()->refresh() queues a NEW loadedModels() call
  await flush();
  assert.equal(loadedQueue.length, 1, 'the reopened refresh() queued its own (legitimate) loaded-state query');
  // Let the reopened picker's own refresh() settle to a stable baseline FIRST —
  // that completion is legitimate (it belongs to the live op, not the stale
  // one), so it must be allowed to paint before we exercise the stale op.
  loadedQueue[0].resolve({ ok: true, loaded: [] });
  await flush();
  const markupBefore = shell.querySelector('.ide-fim-popover').innerHTML;
  const statusBefore = shell.querySelector('.ide-fim-status');
  // Now resolve the STALE (pre-dispose) load's api.complete(). Guarded, this
  // continuation must bail at the opId!==fimOpSeq check and never reach its
  // own fetchLoaded() — so no second loadedQueue entry should appear.
  completeQueue[0].resolve({ ok: true, completion: '' });
  await flush();
  assert.equal(loadedQueue.length, 1, 'the stale op never reached its own fetchLoaded() (guard bailed first)');
  assert.equal(shell.querySelector('.ide-fim-popover').innerHTML, markupBefore, 'stale op did not repaint the reopened host');
  const statusAfter = shell.querySelector('.ide-fim-status');
  if (statusBefore) { assert.equal(statusAfter && statusAfter.textContent, statusBefore.textContent, 'stale op did not overwrite the reopened status'); }
  else { assert.equal(statusAfter, null, 'stale op did not inject a status into the reopened host'); }
});
