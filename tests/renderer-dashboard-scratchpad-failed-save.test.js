const test = require('node:test');
const assert = require('node:assert/strict');

// HOM-04: a failed Scratchpad autosave keeps the draft and blocks note switches.

const { createScratchpadActions } = require('../renderer/features/renderer-dashboard-scratchpad-actions.js');
const { twoNotesActive, createTimerStub, createShellStub } = require('./helpers/scratchpad-fixtures.js');

const FIXED_NOW = new Date(2026, 5, 11, 10, 0);

test('HOM-04 failed autosave retains the draft and refuses note transitions until retry succeeds', async () => {
  let current = twoNotesActive('note-1');
  const { shell, calls } = createShellStub(() => current);
  const update = shell.home.updateConfig;
  let failing = true;
  shell.home.updateConfig = async (patch) => {
    if (failing) throw new Error('disk full');
    return update(patch);
  };
  const timers = createTimerStub();
  const actions = createScratchpadActions({ shell, getScratchpad: () => current, onHomeConfig: (config) => { current = config.scratchpad; }, ...timers });
  actions.queueSave('Unsaved draft', 'note-1');
  await timers.fire();
  assert.ok((await actions.setActiveNote('note-2')).error, 'failed save must block switching');
  assert.equal(current.activeNoteId, 'note-1');
  assert.equal(calls.updates.length, 0);
  assert.ok((await actions.deleteNote('note-1')).error);
  failing = false;
  assert.equal((await actions.setActiveNote('note-2')).ok, true);
  assert.equal(current.notes.find((note) => note.id === 'note-1').text, 'Unsaved draft');
  assert.equal(current.activeNoteId, 'note-2');
});

test('HOM-04 overlapping flushes save newer typing after the acknowledged draft', async () => {
  let current = twoNotesActive('note-1');
  const { shell } = createShellStub(() => current);
  const update = shell.home.updateConfig;
  const writes = [];
  let acknowledge;
  shell.home.updateConfig = async (patch) => {
    writes.push(patch.scratchpad.notes[0].text);
    if (writes.length === 1) await new Promise((resolve) => { acknowledge = resolve; });
    return update(patch);
  };
  const timers = createTimerStub();
  const actions = createScratchpadActions({ shell, getScratchpad: () => current, onHomeConfig: (config) => { current = config.scratchpad; }, ...timers });
  actions.queueSave('First draft', 'note-1');
  const first = actions.flushSave();
  actions.queueSave('Newer draft', 'note-1');
  const second = actions.flushSave();
  const third = actions.flushSave();
  acknowledge();
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.deepEqual(writes, ['First draft', 'Newer draft']);
  assert.equal(current.notes[0].text, 'Newer draft');
});
