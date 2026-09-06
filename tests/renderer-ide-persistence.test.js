'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeferred } = require('./helpers/deferred');
const {
  createIdePersistence,
} = require('../renderer/features/renderer-ide-persistence');

const ROOT_A = Object.freeze({
  rootPath: 'G:/root-a', rootId: 'root-a', generation: 7, phase: 'ready',
});
const ROOT_A_NEXT = Object.freeze({ ...ROOT_A, generation: 8 });
const ROOT_B = Object.freeze({
  rootPath: 'G:/root-b', rootId: 'root-b', generation: 8, phase: 'ready',
});

function createTimerHarness() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    setTimeoutImpl(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeoutImpl(id) { callbacks.delete(id); },
    fireAll() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    get size() { return callbacks.size; },
  };
}

function persisted(context, rootState = {}, preferences = {}) {
  return {
    ok: true,
    context,
    preferences,
    rootState,
    ...preferences,
    ...rootState,
  };
}

function createHarness({ states = [persisted(ROOT_A)], updateState = null } = {}) {
  const timers = createTimerHarness();
  const ide = { openTabs: [], activeTabPath: '', fontSize: 13 };
  const writes = [];
  const preferenceWrites = [];
  const notices = [];
  const stateQueue = [...states];
  const persistence = createIdePersistence({
    getIde: () => ide,
    getWorkspaceIdeApi: () => ({
      async getState() { return stateQueue.shift(); },
      async updateState(payload) {
        writes.push(payload);
        return updateState ? updateState(payload) : { updated: true, context: ROOT_A };
      },
      async updateSettings(patch) {
        preferenceWrites.push(patch);
        return { updated: true, ...patch };
      },
    }),
    ideStateUtils: {
      toPersistedState(value) {
        return {
          openTabs: value.openTabs.map((tab) => ({ ...tab })),
          activeTabPath: value.activeTabPath,
          expandedDirs: [],
          activeStageSurface: 'editor',
          previewPath: '',
          fontSize: value.fontSize,
        };
      },
      applyPersistedState(value, payload) {
        value.openTabs = (payload.openTabs || []).map((tab) => ({ ...tab }));
        value.activeTabPath = payload.activeTabPath || '';
        value.fontSize = payload.fontSize || 13;
      },
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    showToastMessage: (message, opts) => notices.push({ message, opts }),
  });
  return { ide, persistence, timers, writes, preferenceWrites, notices };
}

test('hydration surfaces one deduped root-eviction toast and stays silent without a count', async () => {
  const evicted = createHarness({ states: [{ ...persisted(ROOT_A), evictedRootCount: 2 }] });
  await evicted.persistence.hydratePersistedState();
  await evicted.persistence.hydratePersistedState();
  assert.deepEqual(evicted.notices, [{
    message: "Workspace memory for an older folder was released to make room — its open tabs won't be restored there.",
    opts: { dedupeKey: 'ide:root-lru-evicted', sticky: false },
  }]);

  const ordinary = createHarness();
  await ordinary.persistence.hydratePersistedState();
  assert.equal(ordinary.notices.length, 0);
});

test('preference commits project normalized values only after an acknowledged write', async () => {
  const harness = createHarness();
  const pending = harness.persistence.commitPreference('fontSize', 18);
  assert.equal(harness.ide.fontSize, 13, 'runtime stays unchanged until acknowledgement');
  const result = await pending;
  assert.deepEqual(result, { updated: true, key: 'fontSize', value: 18 });
  assert.equal(harness.ide.fontSize, 18);
  assert.deepEqual(harness.preferenceWrites, [{ fontSize: 18 }]);
});

test('a refused preference commit preserves the prior runtime value', async () => {
  const ide = { fontSize: 13 };
  const failures = [];
  const persistence = createIdePersistence({
    getIde: () => ide,
    getWorkspaceIdeApi: () => ({ updateSettings: async () => ({ updated: false, code: 'config_write_blocked' }) }),
    onPreferenceError: (key, error) => failures.push({ key, code: error.code }),
  });
  assert.deepEqual(await persistence.commitPreference('fontSize', 18), {
    updated: false,
    code: 'config_write_blocked',
  });
  assert.equal(ide.fontSize, 13);
  assert.deepEqual(failures, [{ key: 'fontSize', code: 'config_write_blocked' }]);
});

test('debounced writes preserve the snapshot and root token captured at schedule time', async () => {
  const harness = createHarness({
    states: [persisted(ROOT_A, {
      openTabs: [{ path: 'old.txt' }], activeTabPath: 'old.txt',
    }, { fontSize: 14 })],
  });
  assert.equal((await harness.persistence.hydratePersistedState()).hydrated, true);
  harness.ide.openTabs = [{ path: 'captured.txt' }];
  harness.ide.activeTabPath = 'captured.txt';
  harness.persistence.schedulePersist();
  harness.ide.openTabs = [{ path: 'later.txt' }];
  harness.ide.activeTabPath = 'later.txt';

  harness.timers.fireAll();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].expectedRootId, ROOT_A.rootId);
  assert.equal(harness.writes[0].expectedGeneration, ROOT_A.generation);
  assert.deepEqual(harness.writes[0].rootState.openTabs, [{ path: 'captured.txt' }]);
  assert.equal(harness.writes[0].preferences.fontSize, 14);
});

test('transition flush suspends old-root writes and cancellation rebinds the new generation', async () => {
  const harness = createHarness({ states: [persisted(ROOT_A)] });
  await harness.persistence.hydratePersistedState();
  harness.ide.openTabs = [{ path: 'before-prepare.txt' }];
  harness.persistence.schedulePersist();

  await harness.persistence.prepareTransition(ROOT_A);
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.persistence.getState().suspended, true);

  harness.ide.openTabs = [{ path: 'during-dialog.txt' }];
  harness.persistence.schedulePersist();
  assert.equal(harness.persistence.getState().dirtyWhileSuspended, true);
  assert.equal(harness.timers.size, 0);

  await harness.persistence.settleContext(ROOT_A_NEXT, { committed: false });
  assert.equal(harness.persistence.getState().suspended, false);
  assert.equal(harness.timers.size, 1);
  harness.timers.fireAll();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.writes.length, 2);
  assert.equal(harness.writes[1].expectedGeneration, ROOT_A_NEXT.generation);
  assert.deepEqual(harness.writes[1].rootState.openTabs, [{ path: 'during-dialog.txt' }]);
});

test('committed root changes hydrate the new bucket before persistence resumes', async () => {
  const harness = createHarness({
    states: [
      persisted(ROOT_A, { openTabs: [{ path: 'a.txt' }], activeTabPath: 'a.txt' }),
      persisted(ROOT_B, { openTabs: [{ path: 'b.txt' }], activeTabPath: 'b.txt' }, { fontSize: 18 }),
    ],
  });
  await harness.persistence.hydratePersistedState();
  await harness.persistence.prepareTransition(ROOT_A);
  const hydrated = await harness.persistence.hydrateForContext(ROOT_B);
  const settled = await harness.persistence.settleContext(ROOT_B, { committed: true });

  assert.equal(hydrated.hydrated, true);
  assert.equal(settled.settled, true);
  assert.deepEqual(harness.ide.openTabs, [{ path: 'b.txt' }]);
  assert.equal(harness.ide.activeTabPath, 'b.txt');
  assert.equal(harness.ide.fontSize, 18);
  assert.deepEqual(harness.persistence.getState().boundContext, ROOT_B);
});

test('stale hydrate responses fail closed without applying another root state', async () => {
  const harness = createHarness({
    states: [persisted(ROOT_B, { openTabs: [{ path: 'wrong.txt' }] })],
  });

  await assert.rejects(
    harness.persistence.hydrateForContext(ROOT_A),
    (error) => error.code === 'stale_root_context'
  );
  assert.deepEqual(harness.ide.openTabs, []);
  assert.equal(harness.persistence.getState().hydrated, false);
});

test('dispose supersedes an in-flight hydrate and prevents post-await mutation', async () => {
  const response = createDeferred();
  const ide = { openTabs: [] };
  const persistence = createIdePersistence({
    getIde: () => ide,
    getWorkspaceIdeApi: () => ({ getState: () => response.promise }),
    ideStateUtils: {
      applyPersistedState() { ide.openTabs = [{ path: 'late.txt' }]; },
    },
  });
  const hydration = persistence.hydrateForContext(ROOT_A);
  persistence.dispose();
  response.resolve(persisted(ROOT_A, { openTabs: [{ path: 'late.txt' }] }));

  assert.equal((await hydration).code, 'superseded');
  assert.deepEqual(ide.openTabs, []);
});

// First-run choose starts from the coordinator's no-root context (empty
// rootPath, null rootId — which the transition controller normalizes to '').
// That origin has nothing bound to flush: prepare must suspend and skip
// instead of throwing invalid_root_context, or the first root can never be
// chosen.
test('a no-root ready context is a valid transition origin that suspends and skips', async () => {
  const harness = createHarness();
  const result = await harness.persistence.prepareTransition({
    rootPath: '', rootId: '', generation: 1, phase: 'ready',
  });

  assert.equal(result.skipped, true);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.persistence.getState().suspended, true);

  await assert.rejects(
    harness.persistence.prepareTransition({ rootPath: '', rootId: '', generation: 1, phase: 'transitioning' }),
    (error) => error.code === 'invalid_root_context'
  );
});

test('an unhydrated transition never overwrites a root bucket with default UI state', async () => {
  const harness = createHarness();
  const result = await harness.persistence.prepareTransition(ROOT_A);

  assert.equal(result.skipped, true);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.persistence.getState().suspended, true);
});

test('the IDE controller passes showToastMessage through to persistence', () => {
  const previous = globalThis.rendererIdePersistence;
  let received = null;
  let harness = null;
  globalThis.rendererIdePersistence = {
    createIdePersistence(deps) {
      received = deps;
      return createIdePersistence(deps);
    },
  };
  try {
    const controllerHarness = require('./helpers/renderer-ide-harness');
    harness = controllerHarness.createHarness();
    assert.equal(typeof received?.showToastMessage, 'function');
    received.showToastMessage('wired', { dedupeKey: 'ide:wiring-probe' });
    assert.deepEqual(harness.infoToasts, [{
      message: 'wired', meta: { dedupeKey: 'ide:wiring-probe' },
    }]);
  } finally {
    harness?.dispose();
    if (previous === undefined) delete globalThis.rendererIdePersistence;
    else globalThis.rendererIdePersistence = previous;
  }
});
