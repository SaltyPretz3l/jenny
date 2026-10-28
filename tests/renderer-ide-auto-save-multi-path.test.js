'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createIdeAutoSave } = require('../renderer/features/renderer-ide-auto-save');

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

function setup() {
  const ide = { staleByPath: {}, openTabs: [{ path: 'a.js' }, { path: 'b.js' }] };
  const saves = [];
  let saving = false;
  const timers = makeTimers();
  const autoSave = createIdeAutoSave({
    editorHost: { getActivePath: () => 'b.js', getDocumentKind: () => 'file', isDirty: () => true },
    getIde: () => ide,
    saveFile: (path) => { saves.push(path); saving = true; return Promise.resolve(true); },
    isEnabled: () => true,
    isSaving: () => saving,
    timers,
  });
  return { autoSave, timers, saves, ide, setSaving: (v) => { saving = v; } };
}

test('editing file B inside A\'s debounce window does not drop A\'s pending save', () => {
  const ctx = setup();
  ctx.autoSave.onChange('a.js');
  ctx.autoSave.onChange('b.js');
  assert.equal(ctx.timers.pending(), 2, 'each dirty path keeps its own debounce timer');
  ctx.timers.flush();
  // a.js saves first; b.js sees the in-flight save and re-arms.
  assert.deepEqual(ctx.saves, ['a.js']);
  ctx.setSaving(false);
  ctx.timers.flush();
  assert.deepEqual(ctx.saves, ['a.js', 'b.js'], 'both files are eventually saved');
});

test('re-editing one path re-arms only that path; cancel() clears every pending path', () => {
  const ctx = setup();
  ctx.autoSave.onChange('a.js');
  ctx.autoSave.onChange('b.js');
  ctx.autoSave.onChange('a.js');
  assert.equal(ctx.timers.pending(), 2);
  ctx.autoSave.cancel();
  assert.equal(ctx.timers.pending(), 0);
  ctx.timers.flush();
  assert.deepEqual(ctx.saves, []);
});

test('a path closed before its timer fires is skipped while the other path still saves', () => {
  const ctx = setup();
  ctx.autoSave.onChange('a.js');
  ctx.autoSave.onChange('b.js');
  ctx.ide.openTabs = [{ path: 'b.js' }];
  ctx.timers.flush();
  assert.deepEqual(ctx.saves, ['b.js']);
});
