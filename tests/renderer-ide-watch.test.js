'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, dispatchInput, settle } = require('./helpers/renderer-ide-harness');

function emitChanges(harness, changes, { truncated = false } = {}) {
  harness.bridge.emitChange({ changes, truncated });
}

test('ide controller starts the watcher on activation and stops it on dispose', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  assert.equal(harness.bridge.calls.watchStart.length, 1);
  // Two fs-change consumers: the watch-controller (buffer reconciliation) and
  // the Tier-2 git feature (status refresh). Both unsubscribe on dispose.
  assert.equal(harness.bridge.changeListenerCount, 2);

  harness.dispose();
  assert.equal(harness.bridge.calls.watchStop.length, 1);
  assert.equal(harness.bridge.changeListenerCount, 0);
});

test('ide external change reloads a clean open buffer from disk', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'notes.md': 'v1' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  await harness.controller.openFile('notes.md');
  await settle();
  assert.equal(harness.getDom().ideEditorFallback.value, 'v1');

  harness.bridge.state.files['notes.md'] = 'v2-external';
  emitChanges(harness, [{ relPath: 'notes.md', kind: 'changed' }]);
  await settle();

  assert.deepEqual(harness.bridge.calls.readFile.map((call) => call.path), ['notes.md', 'notes.md']);
  assert.equal(harness.getDom().ideEditorFallback.value, 'v2-external');
  const tab = harness.getDom().ideTabStrip.querySelector('[data-ide-tab="notes.md"]');
  assert.equal(tab.classList.contains('ide-tab--stale'), false);
});

test('ide external change marks a dirty buffer stale instead of clobbering it', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'notes.md': 'v1' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  await harness.controller.openFile('notes.md');
  await settle();

  // Local unsaved edit through the fallback editor binding.
  dispatchInput(harness, harness.getDom().ideEditorFallback, 'v1-local-edit');
  await settle();

  harness.bridge.state.files['notes.md'] = 'v2-external';
  emitChanges(harness, [{ relPath: 'notes.md', kind: 'changed' }]);
  await settle();

  // No reload: the buffer keeps the local edit and the tab goes stale.
  assert.deepEqual(harness.bridge.calls.readFile.map((call) => call.path), ['notes.md']);
  assert.equal(harness.getDom().ideEditorFallback.value, 'v1-local-edit');
  const tab = harness.getDom().ideTabStrip.querySelector('[data-ide-tab="notes.md"]');
  assert.equal(tab.classList.contains('ide-tab--stale'), true);
  assert.equal(harness.infoToasts.length, 1);
  assert.ok(harness.infoToasts[0].message.includes('changed on disk'));

  // A successful save clears the stale marker.
  await harness.controller.saveActiveFile();
  await settle();
  assert.equal(
    harness.getDom().ideTabStrip.querySelector('[data-ide-tab="notes.md"]')
      .classList.contains('ide-tab--stale'),
    false
  );
});

test('ide external delete closes a clean tab but keeps a dirty one stale', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'clean.md': 'c', 'dirty.md': 'd' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  await harness.controller.openFile('clean.md');
  await harness.controller.openFile('dirty.md');
  await settle();
  // dirty.md is active; give it an unsaved edit.
  dispatchInput(harness, harness.getDom().ideEditorFallback, 'd-edited');
  await settle();

  delete harness.bridge.state.files['clean.md'];
  delete harness.bridge.state.files['dirty.md'];
  emitChanges(harness, [
    { relPath: 'clean.md', kind: 'deleted' },
    { relPath: 'dirty.md', kind: 'deleted' },
  ]);
  await settle();

  const strip = harness.getDom().ideTabStrip;
  assert.equal(strip.querySelector('[data-ide-tab="clean.md"]'), null);
  const dirtyTab = strip.querySelector('[data-ide-tab="dirty.md"]');
  assert.ok(dirtyTab);
  assert.equal(dirtyTab.classList.contains('ide-tab--stale'), true);
  assert.equal(harness.getDom().ideEditorFallback.value, 'd-edited');
});

test('ide external changes refresh the cached explorer listings', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/app.js': 'a' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const panel = harness.getDom().ideRailPanel;
  panel.querySelector('[data-ide-tree-path="src"]').click();
  await settle();
  assert.equal(panel.querySelector('[data-ide-tree-path="src/new.js"]'), null);

  harness.bridge.state.files['src/new.js'] = 'n';
  emitChanges(harness, [{ relPath: 'src/new.js', kind: 'changed' }]);
  await settle();

  assert.ok(panel.querySelector('[data-ide-tree-path="src/new.js"]'));

  // External directory delete prunes the cached subtree and its expansion.
  delete harness.bridge.state.files['src/app.js'];
  delete harness.bridge.state.files['src/new.js'];
  emitChanges(harness, [{ relPath: 'src', kind: 'deleted' }]);
  await settle();
  assert.equal(panel.querySelector('[data-ide-tree-path="src"]'), null);
  assert.equal(harness.state.ui.ide.expandedDirs.has('src'), false);
});

test('ide truncated change batch drops every cached listing and relists', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'one.md': '1' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const panel = harness.getDom().ideRailPanel;
  assert.ok(panel.querySelector('[data-ide-tree-path="one.md"]'));

  harness.bridge.state.files['two.md'] = '2';
  emitChanges(harness, [], { truncated: true });
  await settle();

  assert.ok(panel.querySelector('[data-ide-tree-path="two.md"]'));
});

// ---------------------------------------------------------------------------
// WIDE-028 (a): watcher lifecycle → renderer latch reset → bounded retry →
// explicit degraded state. Direct-module tests with fake timers (deterministic;
// no sleeps) plus one harness integration pass over the real bridge shape.
// ---------------------------------------------------------------------------

const { createIdeWatchController } = require('../renderer/features/renderer-ide-watch-controller');

function buildLifecycleHarness({ watchStartImpl } = {}) {
  const calls = { watchStart: 0, watchStop: 0 };
  const toasts = [];
  const logs = [];
  const timers = []; // { fn, delay, cleared }
  let lifecycleListener = null;
  const api = {
    watchStart() {
      calls.watchStart += 1;
      return watchStartImpl ? watchStartImpl(calls.watchStart) : Promise.resolve({ watching: true });
    },
    watchStop() {
      calls.watchStop += 1;
      return Promise.resolve({ watching: false });
    },
    onChange: () => () => {},
    onWatchLifecycle(listener) {
      lifecycleListener = listener;
      return () => { lifecycleListener = null; };
    },
  };
  const controller = createIdeWatchController({
    getWorkspaceFsApi: () => api,
    showToastMessage: (message, meta) => toasts.push({ message, meta }),
    appendClientLog: (level, code, meta) => logs.push({ level, code, meta }),
    retryBaseMs: 10,
    retryMaxAttempts: 3,
    setTimeoutImpl: (fn, delay) => {
      const record = { fn, delay, cleared: false };
      timers.push(record);
      return record;
    },
    clearTimeoutImpl: (record) => { if (record) record.cleared = true; },
  });
  const firePendingTimer = () => {
    const pending = timers.find((record) => !record.cleared && !record.fired);
    if (!pending) return false;
    pending.fired = true;
    pending.fn();
    return true;
  };
  return {
    api,
    calls,
    toasts,
    logs,
    timers,
    controller,
    firePendingTimer,
    pushLifecycle: (payload) => { if (lifecycleListener) lifecycleListener(payload); },
    hasLifecycleListener: () => lifecycleListener != null,
  };
}

test('wide-028: a degraded push resets the latch, retries with backoff, and a watching push restores live', async () => {
  const ctx = buildLifecycleHarness();
  ctx.controller.start();
  await settle();
  assert.equal(ctx.calls.watchStart, 1);

  // Main's native watcher dies: degraded push arrives.
  ctx.pushLifecycle({ phase: 'degraded', reason: 'ENOSPC', context: null });

  // The backoff timer fires -> watchStart is re-invoked (the latch no longer blocks it).
  assert.equal(ctx.firePendingTimer(), true);
  await settle();
  assert.equal(ctx.calls.watchStart, 2, 'the retry restarted the watch');

  // Main confirms: 'watching' clears the retry budget and the freshness state.
  ctx.pushLifecycle({ phase: 'watching', reason: '', context: null });
  assert.deepEqual(ctx.toasts, [], 'a successful recovery never toasts');
});

test('wide-028: retry exhaustion degrades explicitly (state + one toast + log), and a manual start re-arms', async () => {
  // Every watchStart rejects, so each bounded retry consumes budget and fails.
  const ctx = buildLifecycleHarness({
    watchStartImpl: () => Promise.reject(new Error('EPERM-ish')),
  });
  ctx.controller.start();
  await settle();

  ctx.pushLifecycle({ phase: 'degraded', reason: 'ENOSPC', context: null });
  // Drain the bounded retries: each timer fire -> watchStart -> rejection -> next retry.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(ctx.firePendingTimer(), true, `retry ${i + 1} was scheduled`);
    await settle();
  }
  assert.equal(ctx.firePendingTimer(), false, 'no retry beyond the bounded budget');
  assert.equal(ctx.toasts.length, 1, 'the user is told exactly once');
  assert.match(ctx.toasts[0].message, /file watching is unavailable/i);
  assert.ok(ctx.logs.some((e) => e.code === 'ide.watch_degraded'), 'exhaustion is logged');
  const startsBefore = ctx.calls.watchStart;

  // A manual start() (IDE re-activation / root switch) resets the budget.
  ctx.controller.start();
  await settle();
  assert.equal(ctx.calls.watchStart, startsBefore + 1, 'a manual start after degradation tries again');
  ctx.controller.stop();
});

test('wide-028: backoff delays grow and are capped; stop() clears a pending retry', async () => {
  const ctx = buildLifecycleHarness();
  ctx.controller.start();
  await settle();
  ctx.pushLifecycle({ phase: 'degraded', reason: 'EIO', context: null });
  assert.equal(ctx.timers.at(-1).delay, 10, 'first retry at the base delay');
  ctx.firePendingTimer();
  await settle();
  ctx.pushLifecycle({ phase: 'degraded', reason: 'EIO', context: null });
  assert.equal(ctx.timers.at(-1).delay, 20, 'second retry doubles');

  ctx.controller.stop();
  assert.equal(ctx.timers.at(-1).cleared, true, 'stop() cancels the pending retry');
  assert.equal(ctx.hasLifecycleListener(), false, 'stop() unsubscribes the lifecycle listener');
});

test('wide-028: a plain stopped push resets the latch (restart unblocked); restarting is ignored', async () => {
  const ctx = buildLifecycleHarness();
  ctx.controller.start();
  await settle();
  assert.equal(ctx.calls.watchStart, 1);

  // An orderly main-side stop: no auto-retry, but the latch resets so the next
  // activation can re-arm (the old code stayed latched forever).
  ctx.pushLifecycle({ phase: 'stopped', reason: 'stopped', context: null });
  ctx.controller.start();
  await settle();
  assert.equal(ctx.calls.watchStart, 2, 'the reset latch no longer blocks a restart');

  // A root-switch teardown ('restarting') keeps the latch: its 'watching'
  // push follows immediately and a re-entrant start() must stay idempotent.
  ctx.pushLifecycle({ phase: 'stopped', reason: 'restarting', context: null });
  ctx.controller.start();
  await settle();
  assert.equal(ctx.calls.watchStart, 2, 'restarting does not unlatch (no duplicate watchStart)');
  ctx.pushLifecycle({ phase: 'watching', reason: '', context: null });
  ctx.controller.stop();
});

test('wide-028 (integration): the IDE controller subscribes to the lifecycle push and re-activation restarts after degraded', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  assert.equal(harness.bridge.calls.watchStart.length, 1);
  assert.equal(harness.bridge.watchLifecycleListenerCount, 1, 'the watch-controller subscribed to the lifecycle push');

  // The main watcher dies; before this fix the renderer latch stayed true and
  // every later activation was a silent no-op.
  harness.bridge.emitWatchLifecycle({ phase: 'degraded', reason: 'ENOSPC', context: null });
  await harness.controller.activateIde(); // user returns to the IDE view
  await settle();
  assert.equal(harness.bridge.calls.watchStart.length, 2, 'the reset latch lets re-activation restart the watch');

  harness.dispose();
  assert.equal(harness.bridge.watchLifecycleListenerCount, 0, 'dispose unsubscribes the lifecycle listener');
});
