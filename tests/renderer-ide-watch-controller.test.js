'use strict';

/* Direct unit tests for renderer-ide-watch-controller: exercised in isolation
 * with injected fakes (real ideStateUtils, faked editorHost + callbacks). The
 * dirty/clean external-delete split is asserted via SIDE-EFFECT COUNTERS on the
 * guarded branches (onExternalDelete vs setTabStale+toast) rather than converged
 * DOM, and each guard was mutation-checked while authoring (flip `isDirty`,
 * confirm the matching assertion goes RED).
 *
 * The batch handler is internal — start() wires it to api.onChange — so the
 * fake api captures that listener and `emit()` invokes it exactly as the
 * main-process watcher would. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ideState = require('../renderer/features/renderer-ide-state');
const { createIdeWatchController } = require('../renderer/features/renderer-ide-watch-controller');

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function makeWatch({ dirty = false } = {}) {
  const ide = ideState.createIdeUiState();
  let listener = null;
  const api = {
    watchStart: async () => {},
    watchStop: async () => {},
    onChange: (fn) => { listener = fn; return () => {}; },
    readText: async () => ({ content: '' }),
    readFileBase64: async () => ({ data: '' }),
  };
  const editorHost = {
    hasDocument: () => true,
    isDirty: () => dirty,
    getDocumentKind: () => 'file',
    openDocument: async (payload) => (payload.shouldApply?.() === false ? null : (payload.onApplied?.(), {})),
    openImageDocument: () => {},
    activateDocument: () => {},
  };
  const toasts = [];
  const deletes = [];
  const watch = createIdeWatchController({
    getIde: () => ide,
    getWorkspaceFsApi: () => api,
    editorHost,
    fileOperations: {
      acceptsWatcherPayload: () => true,
      resolvePath: (path) => path,
      captureReload: (path) => ({ path, pathKey: path, rootId: 'root-a', generation: 1, editVersion: 0 }),
      readForReload: async (snapshot) => ({ stale: false, payload: { path: snapshot.path, pathKey: snapshot.pathKey, rootId: 'root-a', generation: 1, content: '' } }),
      canCommitReload: () => true,
      commitReload: () => true,
    },
    ideStateUtils: ideState,
    showToastMessage: (message, opts) => toasts.push({ message, opts: opts || {} }),
    renderTabs: () => {},
    appendClientLog: () => {},
    onTreeExternalChanges: () => {},
    refreshChangesPanelIfOpen: () => {},
    onExternalDelete: (path) => deletes.push(path),
  });
  watch.start(); // wires the internal batch handler onto api.onChange
  const emit = (changes) => listener && listener({ changes });
  return { ide, watch, toasts, deletes, emit };
}

test('external delete of a DIRTY buffer marks it stale and never closes it', async () => {
  const ctx = makeWatch({ dirty: true });
  ctx.emit([{ relPath: 'notes.md', kind: 'deleted' }]);
  await tick();

  assert.equal(ctx.deletes.length, 0, 'guarded branch: a dirty buffer is NOT closed on external delete');
  assert.equal(ctx.ide.staleByPath['notes.md'], true, 'it is marked stale instead');
  assert.equal(ctx.toasts.length, 1);
  assert.ok(ctx.toasts[0].message.includes('deleted on disk'));
  assert.equal(ctx.toasts[0].opts.dedupeKey, 'ide:stale:notes.md');
});

test('external delete of a CLEAN buffer closes it via onExternalDelete', async () => {
  const ctx = makeWatch({ dirty: false });
  ctx.emit([{ relPath: 'notes.md', kind: 'deleted' }]);
  await tick();

  assert.equal(ctx.deletes.length, 1, 'mutation pair: a clean buffer routes to the close callback');
  assert.equal(ctx.deletes[0], 'notes.md');
  assert.equal(ctx.toasts.length, 0, 'and no stale toast fires');
  assert.equal(ctx.ide.staleByPath['notes.md'], undefined, 'no stale flag for a clean close');
});

test('an edit landing during an awaited watcher read prevents buffer replacement', async () => {
  const ide = ideState.createIdeUiState();
  const readStarted = deferred();
  const readResult = deferred();
  let listener = null;
  let dirty = false;
  let applied = 0;
  const fileOperations = {
    acceptsWatcherPayload: () => true,
    resolvePath: (path) => path,
    captureReload: (path) => ({ path, pathKey: path, rootId: 'root-a', generation: 1, editVersion: 0 }),
    readForReload: async () => { readStarted.resolve(); return readResult.promise; },
    canCommitReload: () => !dirty,
    commitReload: () => { throw new Error('stale reload must not commit'); },
  };
  const editorHost = {
    hasDocument: () => true,
    isDirty: () => dirty,
    getDocumentKind: () => 'file',
    async openDocument(payload) {
      if (payload.shouldApply() !== true) return null;
      applied += 1;
      payload.onApplied();
      return {};
    },
  };
  const api = {
    watchStart: async () => {},
    watchStop: async () => {},
    onChange: (fn) => { listener = fn; return () => {}; },
  };
  const watch = createIdeWatchController({
    getIde: () => ide,
    getWorkspaceFsApi: () => api,
    editorHost,
    fileOperations,
    ideStateUtils: ideState,
    renderTabs: () => {},
  });
  watch.start();
  listener({ context: { rootId: 'root-a', generation: 1 }, changes: [{ relPath: 'note.txt', kind: 'changed' }] });
  await readStarted.promise;
  dirty = true;
  readResult.resolve({
    stale: false,
    payload: { path: 'note.txt', pathKey: 'note.txt', rootId: 'root-a', generation: 1, content: 'external' },
  });
  await tick();

  assert.equal(applied, 0);
  assert.equal(ide.staleByPath['note.txt'], true);
  watch.stop();
});

test('a stale root-generation watcher batch cannot refresh the tree or editor', () => {
  let listener = null;
  let treeCalls = 0;
  let readCalls = 0;
  const api = {
    watchStart: async () => {}, watchStop: async () => {},
    onChange: (fn) => { listener = fn; return () => {}; },
  };
  const watch = createIdeWatchController({
    getWorkspaceFsApi: () => api,
    editorHost: { hasDocument: () => true },
    fileOperations: {
      acceptsWatcherPayload: (payload) => payload?.context?.generation === 2,
    },
    onTreeExternalChanges: () => { treeCalls += 1; },
    appendClientLog: () => { readCalls += 1; },
  });
  watch.start();
  listener({ context: { rootId: 'root-a', generation: 1 }, changes: [{ relPath: 'note.txt', kind: 'changed' }] });
  assert.equal(treeCalls, 0);
  assert.equal(readCalls, 1, 'the refusal emits one bounded debug diagnostic');
  watch.stop();
});

test('stop invalidates a pending retry rejection so it cannot re-arm watching', async () => {
  let lifecycleListener = null;
  let rejectRetry;
  let startCalls = 0;
  let timers = [];
  const api = {
    watchStart() {
      startCalls += 1;
      if (startCalls === 1) return Promise.resolve();
      return new Promise((_resolve, reject) => { rejectRetry = reject; });
    },
    watchStop: async () => {},
    onChange: () => () => {},
    onWatchLifecycle(fn) { lifecycleListener = fn; return () => {}; },
  };
  const watch = createIdeWatchController({
    getIde: () => ({ openTabs: [] }),
    getWorkspaceFsApi: () => api,
    setTimeoutImpl(fn) { timers.push(fn); return fn; },
    clearTimeoutImpl(handle) { timers = timers.filter((fn) => fn !== handle); },
    retryBaseMs: 1,
  });

  watch.start();
  lifecycleListener({ phase: 'degraded', reason: 'native watcher ended' });
  assert.equal(timers.length, 1, 'degradation schedules one retry');
  timers.shift()();
  assert.equal(startCalls, 2, 'the retry starts and remains pending');
  watch.stop();
  rejectRetry(new Error('late retry failure'));
  await tick();

  assert.equal(timers.length, 0, 'the late rejection cannot schedule after stop');
  assert.equal(startCalls, 2, 'watching does not restart after teardown');
});

test('watcher invalidates and refreshes an unopened preview source before the editor early-return', async () => {
  let listener = null;
  const invalidated = [];
  const previewChanges = [];
  const api = {
    watchStart: async () => {}, watchStop: async () => {},
    onChange: (fn) => { listener = fn; return () => {}; },
  };
  const watch = createIdeWatchController({
    getWorkspaceFsApi: () => api,
    editorHost: { hasDocument: () => false },
    fileOperations: {
      acceptsWatcherPayload: () => true,
      noteExternalChange: (path) => invalidated.push(path),
      resolvePath: (path) => path,
    },
    onExternalPreviewChange: (change) => previewChanges.push(change),
  });
  watch.start();

  listener({
    context: { rootId: 'root-a', generation: 1 },
    changes: [{ relPath: 'docs/readme.md', kind: 'changed' }],
  });
  await tick();

  assert.deepEqual(invalidated, ['docs/readme.md']);
  assert.deepEqual(previewChanges, [{ relPath: 'docs/readme.md', kind: 'changed' }]);
  watch.stop();
});

// UIUX-012: the main-process watcher caps a batch at 500 paths and flags the
// rest `truncated: true` (services/workspace-ide-watcher.js WATCH_MAX_BATCH) —
// any change past the cap never appears in `changes` at all. The fix contract
// requires overflow to "revalidate the bounded open-tab set", not just the
// handful of paths that happened to fit in the batch.
test('a truncated batch revalidates every open FILE tab, not just the paths that fit in the batch', async () => {
  const ide = ideState.createIdeUiState();
  ide.openTabs = [
    { path: 'a.js', kind: 'file' },   // named in the batch
    { path: 'b.js', kind: 'file' },   // open, but its change was DROPPED past the 500 cap
    { path: 'map://x', kind: 'preview' }, // synthetic tab: must never be treated as a real path
  ];
  let listener = null;
  const reloaded = [];
  const api = { watchStart: async () => {}, watchStop: async () => {}, onChange: (fn) => { listener = fn; return () => {}; } };
  const watch = createIdeWatchController({
    getIde: () => ide,
    getWorkspaceFsApi: () => api,
    editorHost: { hasDocument: () => true, isDirty: () => false, getDocumentKind: () => 'file', openDocument: async () => ({}), activateDocument: () => {} },
    fileOperations: {
      acceptsWatcherPayload: () => true,
      resolvePath: (path) => path,
      noteExternalChange: () => {},
      captureReload: (path) => { reloaded.push(path); return { path, pathKey: path, rootId: 'root-a', generation: 1, editVersion: 0 }; },
      readForReload: async (snapshot) => ({ stale: false, payload: { path: snapshot.path, pathKey: snapshot.pathKey, rootId: 'root-a', generation: 1, content: '' } }),
      canCommitReload: () => true,
      commitReload: () => true,
    },
    ideStateUtils: ideState,
    onTreeExternalChanges: () => {},
    refreshChangesPanelIfOpen: () => {},
  });
  watch.start();

  listener({
    context: { rootId: 'root-a', generation: 1 },
    changes: [{ relPath: 'a.js', kind: 'changed' }],
    truncated: true,
  });
  await tick();

  assert.ok(reloaded.includes('a.js'), 'the batched path reconciled as usual');
  assert.ok(
    reloaded.includes('b.js'),
    'an open tab whose change was dropped past the 500-path cap must still be revalidated on overflow'
  );
  assert.ok(!reloaded.includes('map://x'), 'synthetic (non-file) tabs are never revalidated as real paths');
  watch.stop();
});
