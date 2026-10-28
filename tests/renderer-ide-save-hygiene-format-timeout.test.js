'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeSaveHygiene } = require('../renderer/features/renderer-ide-save-hygiene');

function fakeModel(lines) {
  const batches = [];
  return {
    getLineCount: () => lines.length,
    getLineContent: (n) => lines[n - 1],
    getEOL: () => '\n',
    pushEditOperations: (_s, edits) => { batches.push(edits); },
    _batches: batches,
  };
}

function manualTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimeout(fn, ms) { const id = nextId; nextId += 1; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    fireAll() { const all = [...pending.values()]; pending.clear(); all.forEach((t) => t.fn()); },
    pending,
  };
}

test('a hung formatter times out to formatStatus failed so the save is not held forever', async () => {
  const model = fakeModel(['x  ']);
  const timers = manualTimers();
  const logs = [];
  const hygiene = createIdeSaveHygiene({
    editorHost: {
      getModel: () => model,
      isLargeFile: () => false,
      showsPath: () => true,
      formatPath: () => new Promise(() => {}), // never settles
    },
    getIde: () => ({ formatOnSave: true, trimTrailingWhitespace: true }),
    appendClientLog: (level, event) => logs.push(`${level}:${event}`),
    timers,
  });
  const pending = hygiene.applySaveHygiene('a.js');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(timers.pending.size, 1, 'a format timeout is armed');
  assert.equal([...timers.pending.values()][0].ms, 5000);
  timers.fireAll();
  const outcome = await pending;
  assert.deepEqual(outcome, { formatStatus: 'failed', formatReason: 'formatter_timeout' });
  assert.equal(model._batches.length, 1, 'trim still runs after the timeout');
  assert.ok(logs.includes('WARN:ide.format_on_save_failed'));
});

test('a formatter that settles in time clears its timeout', async () => {
  const timers = manualTimers();
  const outcome = await createIdeSaveHygiene({
    editorHost: {
      getModel: () => fakeModel(['x']),
      isLargeFile: () => false,
      showsPath: () => true,
      formatPath: () => Promise.resolve({ supported: true }),
    },
    getIde: () => ({ formatOnSave: true }),
    timers,
  }).applySaveHygiene('a.js');
  assert.deepEqual(outcome, { formatStatus: 'formatted', formatReason: '' });
  assert.equal(timers.pending.size, 0, 'no dangling timer');
});
