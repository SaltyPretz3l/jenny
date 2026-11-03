'use strict';

// Row 103 O2: the pending per-root Workspace IDE write is flushed without
// waiting for the 500 ms debounce. The exit preflight request is main's existing
// renderer hook for a native close and for before-quit (whose app.exit() never
// fires beforeunload); a root switch flushes the old root in prepareTransition.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIdePersistence } = require('../renderer/features/renderer-ide-persistence');

const ROOT_A = Object.freeze({ rootPath: 'G:/root-a', rootId: 'root-a', generation: 7, phase: 'ready' });
const ROOT_B = Object.freeze({ rootPath: 'G:/root-b', rootId: 'root-b', generation: 8, phase: 'ready' });

const settleIo = () => new Promise((resolve) => setImmediate(resolve));

function persisted(context, rootState = {}) {
  return { ok: true, context, preferences: {}, rootState, ...rootState };
}

function createTimers() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    setTimeoutImpl(callback) { const id = nextId++; callbacks.set(id, callback); return id; },
    clearTimeoutImpl(id) { callbacks.delete(id); },
    fireAll() { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach((callback) => callback()); },
    get size() { return callbacks.size; },
  };
}

function fakeShellWindow() {
  const listeners = new Set();
  return {
    onExitPreflightRequest(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitExitPreflight(payload = { requestId: 'r1' }) {
      for (const listener of [...listeners]) listener(payload);
    },
    get listenerCount() { return listeners.size; },
  };
}

function createHarness({ states = [persisted(ROOT_A)], shellWindow = null } = {}) {
  const timers = createTimers();
  const ide = { openTabs: [], activeTabPath: '' };
  const events = [];
  const writes = [];
  const queue = [...states];
  const persistence = createIdePersistence({
    getIde: () => ide,
    getWorkspaceIdeApi: () => ({
      async getState() { events.push('hydrate'); return queue.shift(); },
      async updateState(payload) {
        writes.push(payload);
        events.push(`write:${payload.expectedRootId}:${payload.rootState.openTabs.map((tab) => tab.path).join(',')}`);
        return { updated: true };
      },
    }),
    ideStateUtils: {
      toPersistedState: (value) => ({ openTabs: value.openTabs.map((tab) => ({ ...tab })), activeTabPath: value.activeTabPath }),
      applyPersistedState(value, payload) {
        value.openTabs = (payload.openTabs || []).map((tab) => ({ ...tab }));
        value.activeTabPath = payload.activeTabPath || '';
      },
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    getShellWindowApi: () => shellWindow,
  });
  return { ide, persistence, timers, events, writes };
}

test('a pending change is written once on the exit preflight request, without waiting 500 ms', async (t) => {
  const shellWindow = fakeShellWindow();
  const harness = createHarness({ shellWindow });
  t.after(() => harness.persistence.dispose());
  await harness.persistence.hydratePersistedState();
  harness.ide.openTabs = [{ path: 'pending.txt' }];
  harness.persistence.schedulePersist();
  assert.equal(harness.timers.size, 1);

  shellWindow.emitExitPreflight();
  assert.equal(harness.writes.length, 1, 'the write is dispatched synchronously, before the preflight reply');
  assert.deepEqual(harness.writes[0].rootState.openTabs, [{ path: 'pending.txt' }]);
  assert.equal(harness.writes[0].expectedRootId, ROOT_A.rootId);
  assert.equal(harness.writes[0].expectedGeneration, ROOT_A.generation);
  assert.equal(harness.timers.size, 0, 'the debounce timer is cancelled');
  harness.timers.fireAll();
  await settleIo();
  assert.equal(harness.writes.length, 1, 'written exactly once');
});

test('a flush with nothing pending writes nothing, and nothing lands mid-transition', async (t) => {
  const shellWindow = fakeShellWindow();
  const harness = createHarness({ shellWindow });
  t.after(() => harness.persistence.dispose());
  await harness.persistence.hydratePersistedState();
  shellWindow.emitExitPreflight();
  assert.deepEqual(await harness.persistence.flushPending(), { updated: false, skipped: true });
  await settleIo();
  assert.equal(harness.writes.length, 0);

  // A change made while a root transition is suspended belongs to no root yet.
  await harness.persistence.prepareTransition(ROOT_A);
  const afterPrepare = harness.writes.length;
  harness.ide.openTabs = [{ path: 'during-transition.txt' }];
  harness.persistence.schedulePersist();
  shellWindow.emitExitPreflight();
  await settleIo();
  assert.equal(harness.writes.length, afterPrepare, 'no write lands in either root mid-transition');
});

test('a root switch writes the old root with its old state before the new root hydrates', async (t) => {
  const harness = createHarness({
    states: [
      persisted(ROOT_A, { openTabs: [{ path: 'a.txt' }], activeTabPath: 'a.txt' }),
      persisted(ROOT_B, { openTabs: [{ path: 'b.txt' }], activeTabPath: 'b.txt' }),
    ],
  });
  t.after(() => harness.persistence.dispose());
  await harness.persistence.hydratePersistedState();
  harness.ide.openTabs = [{ path: 'a.txt' }, { path: 'a-new.txt' }];
  harness.persistence.schedulePersist();

  await harness.persistence.prepareTransition(ROOT_A);
  await harness.persistence.hydrateForContext(ROOT_B);
  await harness.persistence.settleContext(ROOT_B, { committed: true });
  harness.timers.fireAll();
  await settleIo();

  assert.deepEqual(harness.events, ['hydrate', 'write:root-a:a.txt,a-new.txt', 'hydrate']);
  assert.deepEqual(harness.ide.openTabs, [{ path: 'b.txt' }]);
});

test('dispose stops listening for the exit preflight request', () => {
  const shellWindow = fakeShellWindow();
  const harness = createHarness({ shellWindow });
  assert.equal(shellWindow.listenerCount, 1);
  harness.persistence.dispose();
  assert.equal(shellWindow.listenerCount, 0);
});
