'use strict';

// Row 111: the Full auto surfaces in the renderer. The store's read, the accept step,
// and the chip, segment and menu row on the Jenny chat versus every other chat.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createPrimaryChatStore, getDefaultPrimaryChatStore, peekDefaultPrimaryChatStore, resetDefaultPrimaryChatStore } = require('../renderer/chat/renderer-primary-chat-store');
const { createIdeConfirmDialog } = require('../renderer/features/renderer-ide-confirm-dialog');
const composerRender = require('../renderer/chat/renderer-composer-v2-render');
const composerState = require('../renderer/chat/renderer-composer-v2-state');
const actionButton = require('../renderer/inventory/action-button');
const { createRunModeHarness, restoreGlobal } = require('./helpers/run-mode-harness');

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// ---- store ----

function bridgeWith(fullAuto) {
  const calls = [];
  const bridge = {
    calls,
    async getState() {
      return { schema_version: 1, ok: true, session_id: 'p', paused: false, paused_at: null, permissions: [], history: [], flags: {} };
    },
    onChanged() { return () => {}; },
  };
  if (fullAuto) {
    bridge.getFullAuto = async () => ({ ok: true, ...fullAuto });
    bridge.armFullAuto = async () => { calls.push('arm'); fullAuto.armed = true; return { ok: true, armed: true }; };
    bridge.disarmFullAuto = async () => { calls.push('disarm'); fullAuto.armed = false; return { ok: true, armed: false }; };
  }
  return bridge;
}

async function storeOver(bridge) {
  const store = createPrimaryChatStore({ getBridge: () => bridge, state: {}, onChanged() {}, appendClientLog() {} });
  await store.refresh();
  return store;
}

test('fullAutoFor offers it on the Jenny chat only', async () => {
  const store = await storeOver(bridgeWith({ available: true, armed: false }));
  assert.equal(store.fullAutoFor('p'), 'offered');
  assert.equal(store.fullAutoFor('other'), '');
  assert.equal(store.fullAutoFor(''), '');
});

test('fullAutoFor reads as not offered while the switch is off or the bridge is old', async () => {
  assert.equal((await storeOver(bridgeWith({ available: false, armed: false }))).fullAutoFor('p'), '');
  assert.equal((await storeOver(bridgeWith(null))).fullAutoFor('p'), '');
});

test('arm and disarm go to the bridge and the store reads the new state back', async () => {
  const bridge = bridgeWith({ available: true, armed: false });
  const store = await storeOver(bridge);
  assert.equal((await store.armFullAuto()).armed, true);
  assert.equal(store.fullAutoFor('p'), 'armed');
  assert.equal((await store.disarmFullAuto()).armed, false);
  assert.equal(store.fullAutoFor('p'), 'offered');
  assert.deepEqual(bridge.calls, ['arm', 'disarm']);
});

test('a failed read keeps showing an armed chat as armed', async () => {
  const bridge = bridgeWith({ available: true, armed: true });
  const store = await storeOver(bridge);
  assert.equal(store.fullAutoFor('p'), 'armed');
  bridge.getFullAuto = async () => { throw new Error('ipc gone'); };
  await store.refresh();
  assert.equal(store.fullAutoFor('p'), 'armed');
});

test('arming over an old bridge answers not armed instead of throwing', async () => {
  const store = await storeOver(bridgeWith(null));
  assert.deepEqual(await store.armFullAuto(), { ok: false, armed: false, reason: 'unavailable' });
});

test('peek never builds the default store', (t) => {
  t.after(resetDefaultPrimaryChatStore);
  resetDefaultPrimaryChatStore();
  assert.equal(peekDefaultPrimaryChatStore(), null);
  const built = getDefaultPrimaryChatStore({ getBridge: () => null, state: {}, onChanged() {}, appendClientLog() {} });
  assert.equal(peekDefaultPrimaryChatStore(), built);
});

// ---- accept step ----

function acceptDialog() {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const opened = [];
  const helpOverlayFactory = () => ({
    open: (cfg) => { opened.push(cfg); host.innerHTML = cfg.bodyHtml; },
    close: () => { host.innerHTML = ''; },
    destroy: () => { host.remove(); },
  });
  const dialog = createIdeConfirmDialog({ document: doc, actionButton, helpOverlayFactory });
  const pending = dialog.accept({
    title: 'Turn on?', message: 'Message <b>', points: ['One', 'Two'], footnote: 'Foot',
    noLabel: 'No', noDetail: 'Nothing', yesLabel: 'Yes', yesDetail: 'Everything',
  });
  const button = (action) => doc.querySelector(`[data-ide-confirm-action="${action}"]`);
  const press = (key, init = {}) => doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  return { doc, opened, pending, button, press };
}

test('accept: only the explicit yes resolves true', async () => {
  const yes = acceptDialog();
  yes.button('yes').click();
  assert.equal(await yes.pending, true);
  const no = acceptDialog();
  no.button('no').click();
  assert.equal(await no.pending, false);
});

test('accept: keys 1 and 2 answer, and the no answer holds focus', async () => {
  const two = acceptDialog();
  assert.equal(two.doc.activeElement, two.button('no'));
  two.press('2');
  assert.equal(await two.pending, true);
  const one = acceptDialog();
  one.press('1');
  assert.equal(await one.pending, false);
});

test('accept: a modified or held key never answers', async () => {
  const ui = acceptDialog();
  for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }]) ui.press('2', init);
  ui.button('no').click();
  assert.equal(await ui.pending, false);
});

test('accept: closing the overlay resolves false', async () => {
  const ui = acceptDialog();
  ui.opened[0].onClose();
  assert.equal(await ui.pending, false);
});

test('accept: arrows walk the answers and a stray key does not answer', async () => {
  const ui = acceptDialog();
  ui.press('ArrowDown');
  assert.equal(ui.doc.activeElement, ui.button('yes'));
  ui.press('ArrowDown');
  assert.equal(ui.doc.activeElement, ui.button('no'));
  ui.press('ArrowUp');
  assert.equal(ui.doc.activeElement, ui.button('yes'));
  ui.press('Enter');
  ui.press('3');
  ui.button('no').click();
  assert.equal(await ui.pending, false);
});

test('accept: labels and points are escaped, and without the button primitive it resolves false', async () => {
  const ui = acceptDialog();
  assert.equal(ui.doc.querySelector('.ide-confirm-message').textContent, 'Message <b>');
  assert.deepEqual([...ui.doc.querySelectorAll('.ide-confirm-points li')].map((li) => li.textContent), ['One', 'Two']);
  ui.button('no').click();
  await ui.pending;
  assert.equal(await createIdeConfirmDialog({ document: ui.doc, helpOverlayFactory: () => ({}) }).accept({}), false);
});

// ---- chip, segments, menu ----

// The render module keeps one dialog for the app's life, so every harness answers through this one.
let answerWarning = () => Promise.resolve(false);
const warningDialog = { accept: (config) => answerWarning(config) };

function fullAutoHarness(t, { status = 'offered', runMode = 'auto', sessionId = 'p', accept = true, armAnswer = null } = {}) {
  const store = {
    status,
    calls: [],
    fullAutoFor: (id) => (id === 'p' ? store.status : ''),
    async armFullAuto() {
      store.calls.push('arm');
      if (armAnswer) return armAnswer;
      store.status = 'armed';
      return { ok: true, armed: true };
    },
    async disarmFullAuto() {
      store.calls.push('disarm');
      store.status = 'offered';
      return { ok: true, armed: false };
    },
  };
  const previous = {
    rendererPrimaryChatStore: globalThis.rendererPrimaryChatStore,
    rendererComposerV2Render: globalThis.rendererComposerV2Render,
    inventoryContextMenu: globalThis.inventoryContextMenu,
  };
  globalThis.rendererPrimaryChatStore = { peekDefaultPrimaryChatStore: () => store };
  globalThis.rendererComposerV2Render = composerRender;
  const menus = [];
  globalThis.inventoryContextMenu = { show: (config) => menus.push(config), hide() {} };
  t.after(() => { for (const key of Object.keys(previous)) restoreGlobal(key, previous[key]); });

  const harness = createRunModeHarness(t, { switcher: true, runMode, currentSessionId: sessionId, withDialog: false });
  const accepts = [];
  answerWarning = (config) => { accepts.push(config); return Promise.resolve(accept); };
  globalThis.rendererIdeConfirmDialog = { createIdeConfirmDialog: () => warningDialog };
  const sync = () => harness.switcher.sync();
  sync();
  const chip = harness.doc.getElementById('composerRunModeChip');
  const segment = (option) => harness.runModeSlot.querySelector(`[data-run-mode-option="${option}"]`);
  return { ...harness, accepts, chip, menus, segment, store, sync };
}

test('an armed Jenny chat shows the Full auto chip and pressed segment', (t) => {
  const h = fullAutoHarness(t, { status: 'armed' });
  assert.ok(h.chip.classList.contains('composer-run-mode-full_auto'));
  assert.equal(h.chip.classList.contains('composer-run-mode-auto'), false);
  assert.match(h.chip.textContent, /Full auto/);
  assert.equal(h.segment('full_auto').getAttribute('aria-pressed'), 'true');
  assert.equal(h.segment('auto').getAttribute('aria-pressed'), 'false');
});

test('turning it off puts the plain Auto chip back without a remount', (t) => {
  const h = fullAutoHarness(t, { status: 'armed' });
  h.store.status = 'offered';
  h.sync();
  assert.ok(h.chip.classList.contains('composer-run-mode-auto'));
  assert.equal(h.chip.classList.contains('composer-run-mode-full_auto'), false);
  assert.equal(h.segment('auto').getAttribute('aria-pressed'), 'true');
  assert.equal(h.segment('full_auto').getAttribute('aria-pressed'), 'false');
});

test('armed state never relabels a chat that has left Auto', (t) => {
  const h = fullAutoHarness(t, { status: 'armed', runMode: 'plan' });
  assert.ok(h.chip.classList.contains('composer-run-mode-plan'));
});

test('any other chat keeps the plain four segments and no Full auto chip', (t) => {
  const h = fullAutoHarness(t, { sessionId: 'someone-else' });
  assert.equal(h.segment('full_auto'), null);
  assert.equal(h.runModeSlot.querySelectorAll('[data-run-mode-option]').length, 4);
  assert.ok(h.chip.classList.contains('composer-run-mode-auto'));
});

test('the segment goes away when the Jenny chat stops offering it', (t) => {
  const h = fullAutoHarness(t);
  assert.ok(h.segment('full_auto'));
  h.store.status = '';
  h.sync();
  assert.equal(h.segment('full_auto'), null);
});

test('a read-only chip disables the Full auto segment too', (t) => {
  const h = fullAutoHarness(t);
  h.store.status = '';
  h.sync();
  h.chip.disabled = true;
  h.store.status = 'offered';
  h.sync();
  assert.equal(h.segment('full_auto').disabled, true);
});

test('the menu lists Full auto after a separator on the Jenny chat only', (t) => {
  const h = fullAutoHarness(t);
  h.chip.click();
  const items = h.menus[0].items;
  assert.deepEqual(items.map((item) => item.value || 'sep'), ['ask', 'auto', 'plan', 'propose', 'sep', 'full_auto']);
  assert.equal(items.at(-1).danger, true);
  assert.equal(items.at(-1).checked, false);
  assert.equal(items[1].checked, true);
});

test('the armed menu checks Full auto instead of Auto', (t) => {
  const h = fullAutoHarness(t, { status: 'armed' });
  h.chip.click();
  const items = h.menus[0].items;
  assert.equal(items.at(-1).checked, true);
  assert.equal(items[1].checked, false);
});

test('another chat\'s menu has no Full auto row', (t) => {
  const h = fullAutoHarness(t, { sessionId: 'someone-else' });
  h.chip.click();
  assert.deepEqual(h.menus[0].items.map((item) => item.value), ['ask', 'auto', 'plan', 'propose']);
});

test('declining the warning arms nothing and leaves the run mode alone', async (t) => {
  const h = fullAutoHarness(t, { accept: false, runMode: 'ask' });
  h.segment('full_auto').click();
  await flush();
  assert.equal(h.accepts.length, 1);
  assert.deepEqual(h.store.calls, []);
  assert.equal(h.prefs.runMode, 'ask');
});

test('a chat that changed while the warning was up is not armed', async (t) => {
  const h = fullAutoHarness(t);
  answerWarning = () => { h.store.status = ''; return Promise.resolve(true); };
  h.segment('full_auto').click();
  await flush();
  assert.deepEqual(h.store.calls, []);
});

test('accepting from Ask moves to Auto first, then arms', async (t) => {
  const h = fullAutoHarness(t, { runMode: 'ask' });
  h.segment('full_auto').click();
  await flush();
  assert.equal(h.prefs.runMode, 'auto');
  assert.deepEqual(h.store.calls, ['arm']);
  assert.equal(h.calls.errors.length, 0);
});

test('a refused arm reports the failure and never claims Full auto', async (t) => {
  const h = fullAutoHarness(t, { armAnswer: { ok: true, armed: false, reason: 'not_auto' } });
  h.segment('full_auto').click();
  await flush();
  assert.equal(h.calls.errors.length, 1);
  assert.doesNotMatch(String(h.calls.errors[0].error.message), /not_auto/, 'a reason code is for the log');
  assert.equal(h.calls.logs.at(-1).details.reason, 'not_auto');
  assert.equal(h.calls.toasts.some((message) => /Full auto/.test(message)), false);
});

test('picking Auto while armed turns Full auto off and keeps Auto', async (t) => {
  const h = fullAutoHarness(t, { status: 'armed' });
  h.segment('auto').click();
  await flush();
  assert.deepEqual(h.store.calls, ['disarm']);
  assert.equal(h.prefs.runMode, 'auto');
});

test('an armed chat never gets the plain Auto send warning', (t) => {
  const h = fullAutoHarness(t, { status: 'armed' });
  assert.equal(h.control.confirmAutoSend(), true);
});

test('Shift+Tab never lands on Full auto', () => {
  const seen = new Set();
  let mode = 'ask';
  for (let i = 0; i < 8; i += 1) { seen.add(mode); mode = composerState.nextRunMode(mode); }
  assert.equal(seen.has('full_auto'), false);
  assert.equal(composerState.normalizeRunMode('full_auto') === 'full_auto', false, 'never a stored run mode');
});
