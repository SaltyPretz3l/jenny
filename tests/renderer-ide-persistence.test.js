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

test('real-state persistence round-trip carries preview and saved view lines', async (t) => {
  const ideState = require('../renderer/features/renderer-ide-state');
  const { createIdeTabRestore } = require('../renderer/features/renderer-ide-tab-restore');
  const ide = ideState.createIdeUiState();
  let lines = { line: 5, top: 3 };
  const tabRestore = createIdeTabRestore({ editorHost: { getViewLines: (path) => path === 'loaded.js' ? lines : null } });
  let saved = { ...persisted(ROOT_A), openTabs: [{ path: 'preview.js', preview: true, line: 14, top: 9 }, { path: 'loaded.js' }], activeTabPath: 'preview.js' };
  const persistence = createIdePersistence({
    getIde: () => ide, ideStateUtils: ideState,
    getTabRestore: () => tabRestore,
    getWorkspaceIdeApi: () => ({ getState: async () => saved, updateState: async (write) => {
      saved = { context: ROOT_A, ...write.rootState };
      return { updated: true };
    } }),
  });
  t.after(() => persistence.dispose());
  await persistence.hydratePersistedState();
  persistence.schedulePersist();
  lines = { line: 6, top: 4 };
  await persistence.flushPersist();
  assert.deepEqual(saved.openTabs, [{ path: 'preview.js', preview: true, line: 14, top: 9 }, { path: 'loaded.js', line: 6, top: 4 }]);
  const restored = ideState.createIdeUiState();
  ideState.applyPersistedState(restored, saved);
  assert.equal(restored.openTabs[0].transientPreview, true);
  assert.deepEqual(restored.openTabs[0].restore, { line: 14, top: 9 });
  lines = { line: 8, top: 7 };
  persistence.flushIfPending();
  assert.deepEqual(saved.openTabs[1], { path: 'loaded.js', line: 8, top: 7 }, 'unload captures movement after the debounce already flushed');
});
const ROOT_A_NEXT = Object.freeze({ ...ROOT_A, generation: 8 });
const ROOT_B = Object.freeze({
  rootPath: 'G:/root-b', rootId: 'root-b', generation: 8, phase: 'ready',
});

function createTimerHarness() {
  let nextId = 1;
  const callbacks = new Map();
  const delays = [];
  return {
    delays,
    setTimeoutImpl(callback, ms) {
      const id = nextId++;
      delays.push(ms);
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
  const logs = [];
  const lateHydrated = [];
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
    appendClientLog: (level, event, data) => logs.push({ level, event, data }),
    onLateHydrated: (value) => lateHydrated.push(value.activeTabPath),
  });
  return { ide, persistence, timers, writes, preferenceWrites, notices, logs, lateHydrated };
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

// ---- Hydrate retry (row 40 W1-B) -------------------------------------------

const settleIo = () => new Promise((resolve) => setImmediate(resolve));

test('a failed first hydrate retries at 500/2000/8000 ms and re-enables persistence on success', async () => {
  const harness = createHarness({ states: [undefined, undefined, undefined, persisted(ROOT_A, { activeTabPath: 'late.js' })] });
  const first = await harness.persistence.hydratePersistedState();
  assert.equal(first.hydrated, false);
  assert.deepEqual(harness.timers.delays, [500]);
  for (const expected of [[500, 2000], [500, 2000, 8000]]) {
    harness.timers.fireAll();
    await settleIo();
    assert.deepEqual(harness.timers.delays, expected);
    assert.equal(harness.persistence.getState().hydrated, false);
  }
  harness.timers.fireAll();
  await settleIo();
  const state = harness.persistence.getState();
  assert.equal(state.hydrated, true);
  assert.equal(harness.ide.activeTabPath, 'late.js', 'a clean late hydrate applies the persisted state');
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.notices.length, 0);
  harness.persistence.schedulePersist();
  assert.equal(harness.timers.size, 1, 'persistence writes again once hydrated');
});

test('a late hydrate applies the saved layout and asks the controller to repaint once', async () => {
  const harness = createHarness({ states: [undefined, persisted(ROOT_A, { openTabs: [{ path: 'saved.js' }], activeTabPath: 'saved.js' })] });
  await harness.persistence.hydratePersistedState();
  harness.ide.openTabs = [{ path: 'early.js' }];
  harness.persistence.schedulePersist();
  assert.equal(harness.writes.length, 0, 'no write while unhydrated');
  assert.equal(harness.lateHydrated.length, 0);

  harness.timers.fireAll();
  await settleIo();
  assert.equal(harness.persistence.getState().hydrated, true);
  assert.deepEqual(harness.ide.openTabs, [{ path: 'saved.js' }, { path: 'early.js' }], 'the saved layout wins, and the tab opened meanwhile is kept');
  assert.deepEqual(harness.lateHydrated, ['saved.js'], 'the controller is told to repaint and reopen the active tab');
});

test('a late hydrate keeps a tab (and its group) opened while hydration was failing, so a dirty buffer is never orphaned', async () => {
  const harness = createHarness({ states: [undefined, persisted(ROOT_A, { openTabs: [{ path: 'saved.js' }, { path: 'both.js' }] })] });
  await harness.persistence.hydratePersistedState();
  harness.ide.openTabs = [{ path: 'both.js' }, { path: 'edited.js', group: 'g2' }];
  harness.ide.activeTabPath = 'edited.js';
  harness.ide.groupActive = { g2: 'edited.js' };
  harness.timers.fireAll();
  await settleIo();
  assert.deepEqual(harness.ide.openTabs.map((tab) => tab.path), ['saved.js', 'both.js', 'edited.js'], 'no duplicate, nothing dropped');
  assert.equal(harness.ide.openTabs[2].group, 'g2');
  assert.equal(harness.ide.groupActive.g2, 'edited.js');
});

test('a late hydrate of a full saved list keeps the live tab within the 64-tab cap main persists', async () => {
  const savedTabs = Array.from({ length: 64 }, (_, i) => ({ path: `saved-${i}.js` }));
  const harness = createHarness({ states: [undefined, persisted(ROOT_A, { openTabs: savedTabs, activeTabPath: 'saved-63.js' })] });
  await harness.persistence.hydratePersistedState();
  harness.ide.openTabs = [{ path: 'live.js' }];
  harness.ide.activeTabPath = 'live.js';
  harness.ide.groupActive = {};
  harness.timers.fireAll();
  await settleIo();
  assert.equal(harness.persistence.getState().hydrated, true);
  const paths = harness.ide.openTabs.map((tab) => tab.path);
  assert.equal(paths.length, 64, 'never more tabs than main keeps on save');
  assert.equal(paths.at(-1), 'live.js', 'the live (maybe dirty) tab survives');
  assert.deepEqual(paths.slice(0, 63), savedTabs.slice(0, 63).map((tab) => tab.path), 'saved tabs fill the rest in order');
  assert.ok(paths.includes(harness.ide.activeTabPath), 'the active tab is still open');
  assert.equal(harness.ide.activeTabPath, 'live.js', 'a dropped saved active tab falls back to the live one');
  for (const path of Object.values(harness.ide.groupActive)) assert.ok(paths.includes(path));
});

test('a retried hydrate keeps the live duplicate object in saved order and validates group pointers', async () => {
  const harness = createHarness({ states: [undefined, persisted(ROOT_A, { openTabs: [
    { path: 'saved.js' }, { path: 'a.js', group: 'editor-2' }, { path: 'secondary.js', group: 'editor-2' },
  ] })] });
  await harness.persistence.hydratePersistedState();
  const live = { path: 'a.js', pinned: true, restore: { line: 12, top: 8 } };
  harness.ide.openTabs = [live, { path: 'live-secondary.js', group: 'editor-3' }];
  harness.ide.activeTabPath = 'a.js';
  harness.ide.groupActive = { 'editor-2': 'a.js', 'editor-3': 'live-secondary.js', 'editor-4': 'missing.js' };
  harness.timers.fireAll();
  await settleIo();
  assert.equal(harness.persistence.getState().hydrated, true);
  assert.deepEqual(harness.ide.openTabs.map((tab) => tab.path), ['saved.js', 'a.js', 'secondary.js', 'live-secondary.js']);
  assert.equal(harness.ide.openTabs[1], live, 'the live primary tab and its state survive');
  assert.equal(harness.ide.activeTabPath, 'a.js');
  assert.ok(harness.ide.openTabs.some((tab) => tab.path === harness.ide.activeTabPath && !tab.group));
  assert.deepEqual(harness.ide.groupActive, { 'editor-3': 'live-secondary.js' });
  for (const [group, path] of Object.entries(harness.ide.groupActive)) {
    assert.ok(harness.ide.openTabs.some((tab) => tab.path === path && tab.group === group));
  }
});

test('a retried hydrate falls back only to a primary active tab, or empty', async () => {
  for (const [savedTabs, liveActive, expected] of [
    [[{ path: 'saved.js' }, { path: 'secondary.js', group: 'editor-2' }], 'secondary.js', 'saved.js'],
    [[{ path: 'secondary.js', group: 'editor-2' }], 'missing.js', ''],
  ]) {
    const harness = createHarness({ states: [undefined, persisted(ROOT_A, {
      openTabs: savedTabs, activeTabPath: 'secondary.js',
    })] });
    await harness.persistence.hydratePersistedState();
    harness.ide.openTabs = [{ path: 'secondary.js', group: 'editor-2' }];
    harness.ide.activeTabPath = liveActive;
    harness.ide.groupActive = { 'editor-2': 'secondary.js' };
    harness.timers.fireAll();
    await settleIo();
    assert.equal(harness.ide.activeTabPath, expected);
    assert.deepEqual(harness.ide.groupActive, { 'editor-2': 'secondary.js' });
  }
});

test('the FIRST hydrate still replaces the live tabs (only a retry keeps them)', async () => {
  const harness = createHarness({ states: [persisted(ROOT_A, { openTabs: [{ path: 'saved.js' }] })] });
  harness.ide.openTabs = [{ path: 'early.js' }];
  await harness.persistence.hydratePersistedState();
  assert.deepEqual(harness.ide.openTabs.map((tab) => tab.path), ['saved.js']);
});

test('a root switch while unhydrated cancels the old root retry', async () => {
  const harness = createHarness({ states: [undefined] });
  await harness.persistence.hydratePersistedState();
  assert.equal(harness.timers.size, 1);
  const result = await harness.persistence.prepareTransition(ROOT_B);
  assert.equal(result.skipped, true);
  assert.equal(harness.timers.size, 0, 'no retry can hydrate or write the old root into the new one');
  await harness.persistence.settleContext(ROOT_B, { committed: true });
  await settleIo();
  assert.equal(harness.timers.size, 0, 'settle does not restart the cancelled retry');
  assert.equal(harness.writes.length, 0);
});

test('a change before the FIRST hydrate does not override the saved layout', async () => {
  const harness = createHarness({ states: [persisted(ROOT_A, { openTabs: [{ path: 'saved.js' }] })] });
  harness.ide.openTabs = [{ path: 'early.js' }];
  harness.persistence.schedulePersist();
  assert.equal(harness.writes.length, 0, 'no write while unhydrated');
  await harness.persistence.hydratePersistedState();
  assert.equal(harness.persistence.getState().hydrated, true);
  assert.deepEqual(harness.ide.openTabs.map((tab) => tab.path), ['saved.js'], 'the saved layout is applied on a first hydrate');
});

test('after the final retry fails it logs and toasts once, then stops retrying', async () => {
  const harness = createHarness({ states: [] });
  await harness.persistence.hydratePersistedState();
  for (let i = 0; i < 3; i += 1) {
    harness.timers.fireAll();
    await settleIo();
  }
  assert.deepEqual(harness.timers.delays, [500, 2000, 8000]);
  assert.equal(harness.timers.size, 0, 'no fourth retry');
  assert.deepEqual(harness.notices, [{
    message: "Workspace layout couldn't be loaded. Panel changes in this session won't be saved.",
    opts: { dedupeKey: 'ide:persistence-load-failed', sticky: false },
  }]);
  assert.equal(harness.logs.filter((entry) => entry.event === 'ide.hydrate_failed').length, 4);
  assert.equal(harness.persistence.getState().hydrated, false);
});

test('settleContext while unhydrated retries immediately instead of waiting for the backoff', async () => {
  const harness = createHarness({ states: [undefined, persisted(ROOT_A, { activeTabPath: 'now.js' })] });
  await harness.persistence.hydratePersistedState();
  assert.equal(harness.timers.size, 1);

  const settled = await harness.persistence.settleContext(ROOT_A);
  assert.equal(settled.hydrated, false, 'settle keeps rebinding as before');
  await settleIo();
  assert.equal(harness.persistence.getState().hydrated, true);
  assert.equal(harness.ide.activeTabPath, 'now.js');
  assert.equal(harness.timers.size, 0, 'the pending backoff timer is cancelled by the successful retry');
});

test('dispose cancels a pending hydrate retry', async () => {
  const harness = createHarness({ states: [] });
  await harness.persistence.hydratePersistedState();
  assert.equal(harness.timers.size, 1);
  harness.persistence.dispose();
  assert.equal(harness.timers.size, 0);
});
