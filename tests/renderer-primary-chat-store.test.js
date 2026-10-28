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
    emit(payload = {}) { if (listener) listener({ schema_version: 1, session_id: 'p', paused: bridge.paused, ...payload }); },
    get unsubscribed() { return unsubscribed; },
    async getState(request) {
      calls.push(['getState', request]);
      if (bridge.hold) await new Promise((resolve) => gates.push(resolve));
      if (bridge.fail) return bridge.fail;
      return { schema_version: 1, ok: true, session_id: 'p', paused: bridge.paused, paused_at: bridge.pausedAt, permissions: [], history: [], flags: FLAGS };
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
