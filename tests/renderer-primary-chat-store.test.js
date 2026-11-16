'use strict';

// The renderer-side primary chat store (row 76): paused state over the primaryChat bridge,
// coalesced refresh, invalidation events, and an absent bridge.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPrimaryChatStore } = require('../renderer/chat/renderer-primary-chat-store');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const FLAGS = { controls: true, launch_permission: true, activity_log: true };

function fakeBridge(initial = {}) {
  const calls = [];
  const gates = [];
  let listener = null;
  let unsubscribed = 0;
  const bridge = {
    calls, gates,
    paused: initial.paused === true,
    pausedAt: initial.paused ? '2026-10-25T10:00:00.000Z' : null,
    hold: false,
    fail: null,
    model: initial.model || '',
    checkModel: initial.checkModel || '',
    emit(payload = {}) { if (listener) listener({ schema_version: 1, session_id: 'p', paused: bridge.paused, ...payload }); },
    get unsubscribed() { return unsubscribed; },
    async getState(request) {
      calls.push(['getState', request]);
      if (bridge.hold) await new Promise((resolve) => gates.push(resolve));
      if (bridge.fail) return bridge.fail;
      return { schema_version: 1, ok: true, session_id: 'p', paused: bridge.paused, paused_at: bridge.pausedAt, model: bridge.model, check_model: bridge.checkModel, permissions: [], history: [], flags: FLAGS };
    },
    async pause(request) {
      calls.push(['pause', request]);
      if (bridge.fail) return bridge.fail;
      bridge.paused = true; bridge.pausedAt = '2026-10-25T11:00:00.000Z';
      return { schema_version: 1, ok: true, paused: true, paused_at: bridge.pausedAt };
    },
    async resume(request) {
      calls.push(['resume', request]);
      if (bridge.fail) return bridge.fail;
      bridge.paused = false; bridge.pausedAt = null;
      return { schema_version: 1, ok: true, paused: false, paused_at: null, woke: null };
    },
    onChanged(fn) { listener = fn; return () => { unsubscribed += 1; listener = null; }; },
  };
  return bridge;
}

function make(bridge, extra = {}) {
  const state = { ui: {} };
  const changed = [];
  const store = createPrimaryChatStore({ getBridge: () => bridge, state, onChanged: () => changed.push(1), ...extra });
  return { store, state, changed };
}

test('the first refresh reads the state, sets state.ui.primaryChat and notifies', async () => {
  const bridge = fakeBridge({ paused: true });
  const { store, state, changed } = make(bridge);
  const seen = [];
  store.subscribe(() => seen.push(store.getSnapshot().paused));
  await store.refresh();
  assert.deepEqual(bridge.calls[0], ['getState', { schema_version: 1 }]);
  assert.equal(store.isPaused('p'), true);
  assert.equal(store.isPaused('other'), false);
  assert.deepEqual(state.ui.primaryChat, { paused: true, session_id: 'p' });
  assert.equal(store.getSnapshot().status, 'ready');
  assert.deepEqual(seen, [true]);
  assert.equal(changed.length, 1);
});

test('pause() applies the answer, notifies once per change and refreshes', async () => {
  const bridge = fakeBridge();
  const { store, changed } = make(bridge);
  await store.refresh();
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  const before = changed.length;
  const answer = await store.pause();
  assert.equal(answer.ok, true);
  assert.deepEqual(bridge.calls.slice(-2).map((call) => call[0]), ['pause', 'getState']);
  assert.equal(store.isPaused('p'), true);
  assert.equal(notified, 1, 'applying the answer and the refetch are one change');
  assert.equal(changed.length - before, 1);
  const resumed = await store.resume();
  assert.equal(resumed.ok, true);
  assert.equal(store.isPaused('p'), false);
  assert.equal(store.getSnapshot().paused_at, null);
  assert.equal(notified, 2);
});

test('a failed pause answers the reason and leaves the state alone', async () => {
  const bridge = fakeBridge();
  const { store } = make(bridge);
  await store.refresh();
  bridge.fail = { schema_version: 1, ok: false, code: 'CMP-PRIMARY-0003', reason: 'session_busy', retryable: true };
  const answer = await store.pause();
  assert.deepEqual({ ok: answer.ok, reason: answer.reason }, { ok: false, reason: 'session_busy' });
  assert.equal(store.isPaused('p'), false);
});

test('a thrown bridge call answers unavailable and never throws', async () => {
  const bridge = fakeBridge();
  bridge.pause = async () => { throw new Error('ipc down'); };
  const { store } = make(bridge);
  await store.refresh();
  const answer = await store.pause();
  assert.deepEqual(answer, { ok: false, reason: 'unavailable' });
});

test('an onChanged event refetches once and dispose unsubscribes', async () => {
  const bridge = fakeBridge();
  const { store } = make(bridge);
  store.start();
  await flush();
  assert.equal(bridge.calls.filter((call) => call[0] === 'getState').length, 1);
  bridge.paused = true; bridge.pausedAt = '2026-10-25T12:00:00.000Z';
  bridge.emit({ paused: false });
  await flush();
  assert.equal(bridge.calls.filter((call) => call[0] === 'getState').length, 2, 'one refetch per event');
  assert.equal(store.isPaused('p'), true, 'the payload is an invalidation; the refetched state wins');
  store.dispose();
  assert.equal(bridge.unsubscribed, 1);
  bridge.emit();
  await flush();
  assert.equal(bridge.calls.filter((call) => call[0] === 'getState').length, 2);
});

test('refreshes while one is in flight coalesce into at most one more call', async () => {
  const bridge = fakeBridge();
  bridge.hold = true;
  const { store } = make(bridge);
  const first = store.refresh();
  const second = store.refresh();
  const third = store.refresh();
  await flush();
  assert.equal(bridge.calls.length, 1);
  bridge.hold = false;
  bridge.gates.shift()();
  await flush();
  assert.equal(bridge.calls.length, 2);
  await Promise.all([first, second, third]);
  assert.equal(bridge.calls.length, 2);
});

test('no bridge reads as unavailable and nothing throws', async () => {
  const { store, state } = make(null);
  store.start();
  assert.equal(store.getSnapshot().status, 'unavailable');
  assert.deepEqual(await store.refresh(), store.getSnapshot());
  assert.deepEqual(await store.pause(), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await store.resume(), { ok: false, reason: 'unavailable' });
  assert.equal(store.isPaused('p'), false);
  assert.equal(store.isAvailable(), false);
  assert.equal(state.ui.primaryChat, undefined);
  assert.doesNotThrow(() => store.dispose());
});

test('a disabled answer hides every control flag', async () => {
  const bridge = fakeBridge();
  bridge.fail = { schema_version: 1, ok: false, code: 'CMP-PRIMARY-0002', reason: 'disabled', retryable: false };
  const { store } = make(bridge);
  await store.refresh();
  const snap = store.getSnapshot();
  assert.equal(snap.status, 'unavailable');
  assert.deepEqual(snap.flags, { controls: false, launch_permission: false, activity_log: false });
});

test('the default store is a singleton', () => {
  const mod = require('../renderer/chat/renderer-primary-chat-store');
  const a = mod.getDefaultPrimaryChatStore({ getBridge: () => null, state: { ui: {} } });
  assert.equal(mod.getDefaultPrimaryChatStore(), a);
  mod.resetDefaultPrimaryChatStore();
  assert.notEqual(mod.getDefaultPrimaryChatStore({ getBridge: () => null, state: { ui: {} } }), a);
  mod.resetDefaultPrimaryChatStore();
});

// Row 144: the model pins and the held-check toasts. Toasts go through the injected showToast / dismissToast.
function heldHarness(initial = {}) {
  const bridge = fakeBridge(initial);
  let heldListener = null;
  const toasts = [];
  const dismissed = [];
  const opened = [];
  bridge.held = initial.held || [];
  bridge.onCheckHeld = (fn) => { heldListener = fn; return () => { heldListener = null; bridge.heldOff = true; }; };
  bridge.heldChecks = async (request) => { bridge.calls.push(['heldChecks', request]); return { schema_version: 1, ok: true, held: bridge.held }; };
  bridge.runHeldCheck = async (request) => { bridge.calls.push(['runHeldCheck', request]); return bridge.runAnswer || { schema_version: 1, ok: true, ran: true, turn_id: 't1' }; };
  bridge.skipHeldCheck = async (request) => { bridge.calls.push(['skipHeldCheck', request]); return bridge.skipAnswer || { schema_version: 1, ok: true, skipped: true }; };
  bridge.setModels = async (request) => { bridge.calls.push(['setModels', request]); return bridge.setAnswer || { schema_version: 1, ok: true, changed: true, model: request.model ?? bridge.model, check_model: request.check_model ?? bridge.checkModel }; };
  const made = make(bridge, {
    showToast: (message, options) => { toasts.push({ message, ...options }); return `toast-${toasts.length}`; },
    dismissToast: (ref) => dismissed.push(ref),
    openSettings: (section, options) => opened.push([section, options]),
  });
  return { ...made, bridge, toasts, dismissed, opened, emitHeld: (event) => heldListener(event) };
}
const action = (toast, id) => toast.actions.find((entry) => entry.id === id);

test('row 144: the snapshot carries the Jenny model pin and the check model, and tolerates a build without them', async () => {
  const withPins = heldHarness({ model: 'qwen3:27b', checkModel: 'qwen3:8b' });
  await withPins.store.refresh();
  assert.deepEqual([withPins.store.getSnapshot().model, withPins.store.getSnapshot().check_model], ['qwen3:27b', 'qwen3:8b']);
  const bare = make(fakeBridge());
  assert.deepEqual([bare.store.getSnapshot().model, bare.store.getSnapshot().check_model], ['', '']);
  const odd = heldHarness({ model: 42 });
  await odd.store.refresh();
  assert.equal(odd.store.getSnapshot().model, '', 'a non-string pin reads as not pinned');
});

test('row 144: setModels sends only the changed key, refetches, and answers a refusal by reason', async () => {
  const h = heldHarness();
  await h.store.refresh();
  const answer = await h.store.setModels({ check_model: 'qwen3:8b' });
  assert.equal(answer.ok, true);
  assert.deepEqual(h.bridge.calls.find((call) => call[0] === 'setModels'), ['setModels', { schema_version: 1, check_model: 'qwen3:8b' }]);
  assert.equal(h.bridge.calls.at(-1)[0], 'getState', 'the answer is followed by a refetch');
  h.bridge.setAnswer = { schema_version: 1, ok: false, code: 'CMP-PRIMARY-0004', reason: 'invalid_request', retryable: false };
  assert.deepEqual(await h.store.setModels({ model: 'x' }), { ok: false, reason: 'invalid_request' });
  assert.deepEqual(await make(null).store.setModels({ model: 'x' }), { ok: false, reason: 'unavailable' });
});

test('row 144: a held check shows one sticky warning toast with Choose a model, Run on and Skip', async () => {
  const h = heldHarness();
  h.store.start();
  await flush();
  h.emitHeld({ type: 'held', reminder_id: 'r1', label: 'Morning summary', reason: 'model_too_small', model: 'lfm3:2b' });
  assert.equal(h.toasts.length, 1);
  const toast = h.toasts[0];
  assert.equal(toast.message, '“Morning summary” is waiting: lfm3:2b is too small for checks (under 7B).');
  assert.deepEqual([toast.tone, toast.sticky, toast.title, toast.dedupeKey], ['warning', true, 'Scheduled check waiting', 'primary:check-held:r1']);
  assert.deepEqual(toast.actions.map((entry) => [entry.label, entry.kind || 'secondary']),
    [['Choose a model', 'primary'], ['Run on lfm3:2b', 'secondary'], ['Skip', 'secondary']]);
  await action(toast, 'choose_model').onClick();
  assert.deepEqual(h.opened, [['chat', { focusId: 'checkModelSelect' }]]);
});

test('row 144: a model that is not available offers no Run action, and an empty label falls back', async () => {
  const h = heldHarness();
  h.store.start();
  await flush();
  h.emitHeld({ type: 'held', reminder_id: 'r2', label: '  ', reason: 'model_unavailable', model: 'qwen3:27b' });
  const toast = h.toasts[0];
  assert.equal(toast.message, '“Scheduled check” is waiting: qwen3:27b is not available.');
  assert.deepEqual(toast.actions.map((entry) => entry.label), ['Choose a model', 'Skip']);
  h.emitHeld({ type: 'held', reminder_id: 'r3', label: 'x', reason: 'rm_rf', model: 'm' });
  h.emitHeld({ type: 'held', reminder_id: 7, label: 'x', reason: 'model_too_small', model: 'm' });
  h.emitHeld({ type: 'bogus' });
  h.emitHeld(null);
  assert.equal(h.toasts.length, 1, 'an unknown reason, a bad id or a bad event paints nothing');
});

test('row 144: Run on calls runHeldCheck, names the model in an info toast and withdraws the held toast', async () => {
  const h = heldHarness();
  h.store.start();
  await flush();
  h.emitHeld({ type: 'held', reminder_id: 'r1', label: 'Morning summary', reason: 'model_too_small', model: 'lfm3:2b' });
  await action(h.toasts[0], 'run_anyway').onClick();
  assert.deepEqual(h.bridge.calls.find((call) => call[0] === 'runHeldCheck'), ['runHeldCheck', { schema_version: 1, reminder_id: 'r1' }]);
  assert.equal(h.toasts[1].message, 'Running “Morning summary” on lfm3:2b. Every tool still asks first.');
  assert.equal(h.toasts[1].tone, 'info');
  assert.deepEqual(h.dismissed, ['primary:check-held:r1']);
});

test('row 144: a Run that did not run says why in words and keeps the held toast', async () => {
  const h = heldHarness();
  h.store.start();
  await flush();
  h.emitHeld({ type: 'held', reminder_id: 'r1', label: 'Morning summary', reason: 'model_too_small', model: 'lfm3:2b' });
  h.bridge.runAnswer = { schema_version: 1, ok: true, ran: false, reason: 'still_waiting' };
  await action(h.toasts[0], 'run_anyway').onClick();
  assert.equal(h.toasts[1].tone, 'warning');
  assert.equal(h.toasts[1].message, '“Morning summary” is still waiting for a model.');
  assert.deepEqual(h.dismissed, [], 'the held toast stays while the check is still waiting');
  h.bridge.runAnswer = { schema_version: 1, ok: false, reason: 'unavailable' };
  await action(h.toasts[0], 'run_anyway').onClick();
  assert.equal(h.toasts[2].tone, 'warning');
  assert.equal(h.toasts[2].message, '“Morning summary” could not be changed just now.');
  h.bridge.runAnswer = { schema_version: 1, ok: true, ran: false, reason: 'not_held' };
  await action(h.toasts[0], 'run_anyway').onClick();
  assert.equal(h.toasts.length, 3, 'a check that is no longer held needs no warning, only its toast withdrawn');
  assert.deepEqual(h.dismissed, ['primary:check-held:r1'], 'a check that is no longer held loses its toast');
});

test('row 144: Skip calls skipHeldCheck and withdraws the toast; a cleared event dismisses it by key', async () => {
  const h = heldHarness();
  h.store.start();
  await flush();
  h.emitHeld({ type: 'held', reminder_id: 'r1', label: 'Morning summary', reason: 'model_too_small', model: 'lfm3:2b' });
  await action(h.toasts[0], 'skip').onClick();
  assert.deepEqual(h.bridge.calls.find((call) => call[0] === 'skipHeldCheck'), ['skipHeldCheck', { schema_version: 1, reminder_id: 'r1' }]);
  assert.deepEqual(h.dismissed, ['primary:check-held:r1']);
  h.emitHeld({ type: 'cleared', reminder_id: 'r1' });
  assert.deepEqual(h.dismissed, ['primary:check-held:r1', 'primary:check-held:r1']);
  h.emitHeld({ type: 'cleared', reminder_id: 5 });
  assert.equal(h.dismissed.length, 2, 'a bad id dismisses nothing');
});

test('row 144: checks already waiting when the page loads show their toasts, and dispose stops listening', async () => {
  const h = heldHarness({ held: [
    { reminder_id: 'a', label: 'One', reason: 'model_too_small', model: 'm1' },
    { reminder_id: 'b', label: 'Two', reason: 'model_unavailable', model: 'm2' },
    { reminder_id: 9, label: 'Bad', reason: 'model_too_small', model: 'm3' },
  ] });
  h.store.start();
  await flush();
  assert.deepEqual(h.bridge.calls.filter((call) => call[0] === 'heldChecks'), [['heldChecks', { schema_version: 1 }]]);
  assert.deepEqual(h.toasts.map((toast) => toast.dedupeKey), ['primary:check-held:a', 'primary:check-held:b']);
  h.store.dispose();
  assert.equal(h.bridge.heldOff, true);
});

test('row 144: an old bridge without the held-check calls never throws', async () => {
  const bridge = fakeBridge();
  const toasts = [];
  const { store } = make(bridge, { showToast: (message) => toasts.push(message) });
  assert.doesNotThrow(() => store.start());
  await flush();
  assert.deepEqual(toasts, []);
  assert.deepEqual(await store.runHeld('r1'), { ok: false, reason: 'unavailable' });
  assert.doesNotThrow(() => store.openSettings('model'));
});
