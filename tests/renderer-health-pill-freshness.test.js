const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createHealthPillController } = require('../renderer/shell/renderer-health-pill-utils');

function snapshot(state = 'ready', server = {}) {
  return { runtime: { lifecycle: { available: true, state }, llama_server: server } };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}
function setup(t, fetch, createController = createHealthPillController) {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>', { pretendToBeVisual: true });
  const { window } = dom;
  const timers = new Map();
  let id = 0;
  let visibility = 'visible';
  Object.defineProperty(window.document, 'visibilityState', { get: () => visibility });
  window.setTimeout = (fn, ms) => { timers.set(++id, { fn, ms }); return id; };
  window.clearTimeout = (key) => timers.delete(key);
  window.jennyShell = { diagnostics: { getJennyStatus: fetch } };
  const slot = window.document.getElementById('slot');
  const controller = createController({ window, slot });
  t.after(() => { controller.dispose(); window.close(); });
  return {
    window, slot, controller, timers,
    visibility(value) {
      visibility = value;
      window.document.dispatchEvent(new window.Event('visibilitychange'));
    },
    async tick() {
      assert.equal(timers.size, 1, 'exactly one reconciliation timer');
      const [key, timer] = timers.entries().next().value;
      timers.delete(key);
      timer.fn();
      await settle();
      return timer.ms;
    },
  };
}

test('closed pill coalesces a ready event burst during an old startup request', async (t) => {
  const old = deferred();
  const next = deferred();
  let calls = 0;
  const h = setup(t, () => (++calls === 1 ? old.promise : next.promise));
  const initial = h.controller.refresh({ silent: true });
  for (let i = 0; i < 20; i += 1) h.controller.refresh({ silent: true });
  assert.equal(calls, 1);
  old.resolve(snapshot('starting'));
  await settle();
  assert.equal(calls, 2, 'a follow-up fetch is not lost');
  next.resolve(snapshot());
  await initial;
  await settle();
  assert.equal(h.controller.getState().label, 'Ready');
  assert.equal(h.controller.isPopoverOpen(), false);
  assert.equal(calls, 2);
  assert.equal(h.timers.size, 0, 'stable closed pill does not poll');
});

test('startup reconciles without clicks with capped backoff then stops when ready', async (t) => {
  let current = snapshot('starting');
  const h = setup(t, async () => current);
  await h.controller.refresh({ silent: true });
  const delays = [];
  for (let i = 0; i < 7; i += 1) delays.push(await h.tick());
  assert.equal(delays[0], 4000);
  assert.ok(delays.every((ms) => ms >= 4000 && ms <= 30000));
  assert.equal(delays.at(-1), 30000);
  current = snapshot();
  await h.tick();
  assert.equal(h.controller.getState().label, 'Ready');
  assert.equal(h.timers.size, 0);
});

test('a failed trailing refresh recovers automatically without clicking', async (t) => {
  const old = deferred();
  let calls = 0;
  const h = setup(t, () => {
    calls += 1;
    if (calls === 1) return old.promise;
    if (calls === 2) return Promise.reject(new Error('temporary diagnostics failure'));
    return Promise.resolve(snapshot());
  });
  h.controller.refresh({ silent: true });
  h.controller.refresh({ silent: true });
  old.resolve(snapshot('starting'));
  await settle();
  assert.match(h.controller.getState().error, /temporary/);
  await h.tick();
  assert.equal(h.controller.getState().label, 'Ready');
  assert.equal(h.controller.getState().error, '');
  assert.equal(h.timers.size, 0);
});

test('missing diagnostics bridge is reconciled after it returns', async (t) => {
  const h = setup(t, async () => snapshot());
  delete h.window.jennyShell.diagnostics;
  await h.controller.refresh({ silent: true });
  await h.tick();
  assert.equal(h.controller.getState().label, 'Unknown');
  h.window.jennyShell.diagnostics = { getJennyStatus: async () => snapshot() };
  await h.tick();
  assert.equal(h.controller.getState().label, 'Ready');
});

test('hidden windows suspend timers and visibility restoration refreshes stable status', async (t) => {
  let calls = 0;
  let current = snapshot('starting');
  const h = setup(t, async () => { calls += 1; return current; });
  await h.controller.refresh({ silent: true });
  h.visibility('hidden');
  assert.equal(h.timers.size, 0);
  current = snapshot();
  h.visibility('visible');
  await settle();
  assert.equal(calls, 2);
  assert.equal(h.controller.getState().label, 'Ready');
  h.visibility('hidden');
  current = snapshot('error');
  h.visibility('visible');
  await settle();
  assert.equal(h.controller.getState().label, 'Error');
});

test('dispose clears timers and queued refreshes and removes visibility listener', async (t) => {
  const old = deferred();
  let calls = 0;
  const h = setup(t, () => { calls += 1; return old.promise; });
  h.controller.refresh({ silent: true });
  h.controller.refresh({ silent: true });
  h.controller.dispose();
  old.resolve(snapshot('starting'));
  await settle();
  h.visibility('visible');
  await settle();
  assert.equal(calls, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.slot.innerHTML, '');
});

test('server-only changes update the popover and preserve surviving action focus', async (t) => {
  let current = snapshot('ready', { state: 'ready', alias: 'one', port: 8033 });
  const h = setup(t, async () => current);
  await h.controller.refresh({ silent: true });
  h.slot.querySelector('button').click();
  await settle();
  const popover = () => h.window.document.getElementById('workbenchHealthPopover');
  const action = (name) => popover().querySelector(`[data-health-pill-action="${name}"]`);
  action('open-runtime-health').focus();
  current = snapshot('ready', { state: 'crashed', alias: 'one', port: 8033 });
  await h.controller.refresh({ silent: true });
  assert.match(popover().textContent, /stopped unexpectedly/);
  assert.ok(action('restart-llama-server'));
  assert.equal(h.window.document.activeElement, action('open-runtime-health'));
  const unchanged = popover();
  await h.controller.refresh({ silent: true });
  assert.equal(popover(), unchanged, 'identical snapshot preserves DOM');
  action('restart-llama-server').focus();
  current = snapshot('ready', { state: 'ready', alias: 'two', port: 8034, acceleration_mode: 'mtp' });
  await h.controller.refresh({ silent: true });
  assert.match(popover().textContent, /serving two on :8034 · mtp/);
  assert.equal(action('restart-llama-server'), null);
  assert.equal(h.window.document.activeElement, popover(), 'removed action falls back to dialog');
  current = snapshot('ready', { state: 'stopped', last_error: 'first failure' });
  await h.controller.refresh({ silent: true });
  current.runtime.llama_server.last_error = 'second failure';
  await h.controller.refresh({ silent: true });
  assert.match(popover().textContent, /second failure/);
});

test('focused pill survives status updates and closing startup popover retains reconciliation', async (t) => {
  let current = snapshot();
  const h = setup(t, async () => current);
  await h.controller.refresh({ silent: true });
  h.slot.querySelector('button').focus();
  current = snapshot('starting');
  await h.controller.refresh({ silent: true });
  assert.equal(h.window.document.activeElement, h.slot.querySelector('button'));
  h.slot.querySelector('button').click();
  await settle();
  assert.equal(await h.tick(), 4000, 'open popover retains four-second cadence');
  h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(h.controller.isPopoverOpen(), false);
  assert.equal(h.window.document.activeElement, h.slot.querySelector('button'));
  assert.equal(h.timers.size, 1);
  h.controller.dispose();
  assert.equal(h.timers.size, 0);
});


test('translated unknown and stopping labels keep reconciling until offline or ready', async (t) => {
  const modulePath = require.resolve('../renderer/shell/renderer-health-pill-utils');
  const previousI18n = globalThis.jennyI18n;
  const cached = require.cache[modulePath];
  let createTranslatedController;
  try {
    globalThis.jennyI18n = { t: (key, fallback) => ({
      'healthPill.unknown': 'Unbekannt', 'healthPill.stopping': 'Wird beendet',
    })[key] || fallback };
    delete require.cache[modulePath];
    createTranslatedController = require(modulePath).createHealthPillController;
  } finally {
    require.cache[modulePath] = cached;
    if (previousI18n === undefined) delete globalThis.jennyI18n;
    else globalThis.jennyI18n = previousI18n;
  }
  let current = snapshot('unknown');
  const h = setup(t, async () => current, createTranslatedController);
  await h.controller.refresh({ silent: true });
  assert.equal(h.controller.getState().label, 'Unbekannt');
  await h.tick();
  current = snapshot('stopping');
  await h.tick();
  assert.equal(h.controller.getState().label, 'Wird beendet');
  current = snapshot('stopped');
  await h.tick();
  assert.equal(h.timers.size, 0, 'offline is stable even with translated labels');
  current = snapshot();
  await h.controller.refresh({ silent: true });
  assert.equal(h.timers.size, 0);
});
