'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIdeAutoSave } = require('../renderer/features/renderer-ide-auto-save');

// Manual timer host so the debounce is deterministic: setTimeout records the
// callback, flush() fires every pending one, pending() counts armed timers.
function makeTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimeout(fn) { const id = nextId; nextId += 1; scheduled.set(id, fn); return id; },
    clearTimeout(id) { scheduled.delete(id); },
    pending: () => scheduled.size,
    flush() {
      const fns = [...scheduled.values()];
      scheduled.clear();
      for (const fn of fns) { fn(); }
    },
  };
}

// Fake editor host + ide slice. `tab` is mutable so a test can simulate a
// file switch (active path changes) between schedule and fire.
function setup(overrides = {}) {
  const tab = {
    path: 'src/app.js', kind: 'file', dirty: true,
    ...(overrides.tab || {}),
  };
  const ide = { staleByPath: {}, autoSaveEnabled: true, ...(overrides.ide || {}) };
  let enabled = overrides.enabled === undefined ? true : overrides.enabled;
  let saving = overrides.saving === true;
  const saves = [];
  const editorHost = {
    getActivePath: () => tab.path,
    getDocumentKind: (p) => (p && p === tab.path ? tab.kind : ''),
    isDirty: (p) => (p && p === tab.path ? tab.dirty === true : false),
  };
  const timers = makeTimers();
  const autoSave = createIdeAutoSave({
    editorHost,
    getIde: () => ide,
    saveActiveFile: () => { saves.push(tab.path); return Promise.resolve(true); },
    isEnabled: () => enabled === true,
    isSaving: () => saving === true,
    timers,
  });
  return {
    autoSave, timers, saves, ide, tab, editorHost,
    setEnabled: (value) => { enabled = value; },
    setSaving: (value) => { saving = value; },
  };
}

test('debounce: rapid edits to one file collapse to a single save after settling', () => {
  const { autoSave, timers, saves } = setup();
  autoSave.onChange('src/app.js');
  autoSave.onChange('src/app.js');
  autoSave.onChange('src/app.js');
  // Only one timer is ever armed (each edit re-arms the prior one).
  assert.equal(timers.pending(), 1);
  assert.deepEqual(saves, [], 'no write before the debounce fires');
  timers.flush();
  assert.deepEqual(saves, ['src/app.js'], 'exactly one write after edits settle');
});

test('skips non-file tabs (diff / preview / image)', () => {
  for (const kind of ['diff', 'preview', 'image']) {
    const { autoSave, timers, saves } = setup({ tab: { kind } });
    autoSave.onChange('diff://change/abc');
    timers.flush();
    assert.deepEqual(saves, [], `kind=${kind} is never auto-saved`);
  }
});

test('defers when the active file is stale (externally changed) — never overwrites a conflict', () => {
  const { autoSave, timers, saves } = setup({ ide: { staleByPath: { 'src/app.js': true } } });
  autoSave.onChange('src/app.js');
  timers.flush();
  assert.deepEqual(saves, [], 'a stale/conflicted file defers rather than auto-overwriting');
});

test('skips a clean (non-dirty) file — no pointless write', () => {
  const { autoSave, timers, saves } = setup({ tab: { dirty: false } });
  autoSave.onChange('src/app.js');
  timers.flush();
  assert.deepEqual(saves, [], 'a clean buffer is not written');
});

test('cancel() drops the pending save (tab switch / close)', () => {
  const { autoSave, timers, saves } = setup();
  autoSave.onChange('src/app.js');
  assert.equal(timers.pending(), 1);
  autoSave.cancel();
  assert.equal(timers.pending(), 0, 'the armed timer is cleared');
  timers.flush();
  assert.deepEqual(saves, [], 'no write after cancel');
});

test('a file switch before the debounce fires never writes the stale buffer to the new path', () => {
  const ctx = setup();
  ctx.autoSave.onChange('src/app.js');
  // User navigates to another file before the timer fires (no cancel reached).
  ctx.tab.path = 'src/other.js';
  ctx.timers.flush();
  // The scheduled path no longer matches the active path -> no cross-file write.
  assert.deepEqual(ctx.saves, [], 'the fire-time path guard prevents a misrouted write');
});

test('reschedules instead of dropping the save when another save is already in flight', () => {
  // A manual Ctrl+S / Save All / prior slow auto-save holds the lifecycle's
  // re-entrancy guard; firing now would be a silent no-op, so the round must be
  // re-armed (not consumed) and flush once the in-flight write releases.
  const ctx = setup({ saving: true });
  ctx.autoSave.onChange('src/app.js');
  ctx.timers.flush();
  assert.deepEqual(ctx.saves, [], 'no write attempted while a save is in flight');
  assert.equal(ctx.timers.pending(), 1, 'the round is re-armed, not dropped');
  ctx.setSaving(false);
  ctx.timers.flush();
  assert.deepEqual(ctx.saves, ['src/app.js'], 'the deferred edit flushes once the guard releases');
});

test('respects the gate: nothing is scheduled or written when disabled', () => {
  const { autoSave, timers, saves } = setup({ enabled: false });
  autoSave.onChange('src/app.js');
  assert.equal(timers.pending(), 0, 'no timer is armed when the feature is off');
  timers.flush();
  assert.deepEqual(saves, [], 'no write when the flag/pref gate is off');
});

test('re-checks the gate at fire time: disabling mid-debounce cancels the write', () => {
  const ctx = setup();
  ctx.autoSave.onChange('src/app.js');
  ctx.setEnabled(false); // flag/pref turned off while the timer is pending
  ctx.timers.flush();
  assert.deepEqual(ctx.saves, [], 'the queued save aborts once the gate closes');
});

test('dispose() clears any pending save', () => {
  const { autoSave, timers, saves } = setup();
  autoSave.onChange('src/app.js');
  autoSave.dispose();
  assert.equal(timers.pending(), 0);
  timers.flush();
  assert.deepEqual(saves, []);
});

test('falls back to the active path when onChange is called without one', () => {
  const { autoSave, timers, saves } = setup();
  autoSave.onChange(); // editorHost.getActivePath() supplies the path
  timers.flush();
  assert.deepEqual(saves, ['src/app.js']);
});
