'use strict';

// The scratchpad echo drives a full-app renderAll only when the pinned overlay's
// content changed; this key is that gate.
const assert = require('node:assert/strict');
const test = require('node:test');

const { pinnedNotesKey } = require('../renderer/features/renderer-dashboard-manager');

const pad = (pins, notes) => ({ pins, notes });
const note = (id, text, title = id) => ({ id, title, text });

test('no pins means an empty key, whatever the notes hold', () => {
  assert.equal(pinnedNotesKey(pad([], [note('a', 'x')])), '');
  assert.equal(pinnedNotesKey(undefined), '');
});

test('editing an unpinned note leaves the key unchanged', () => {
  const before = pinnedNotesKey(pad(['a'], [note('a', 'pinned'), note('b', 'one')]));
  const after = pinnedNotesKey(pad(['a'], [note('a', 'pinned'), note('b', 'two')]));
  assert.equal(after, before);
});

test('a pinned note text or title edit, or a pin-set change, changes the key', () => {
  const base = pinnedNotesKey(pad(['a'], [note('a', 'x'), note('b', 'y')]));
  assert.notEqual(pinnedNotesKey(pad(['a'], [note('a', 'x2'), note('b', 'y')])), base);
  assert.notEqual(pinnedNotesKey(pad(['a'], [note('a', 'x', 'Renamed'), note('b', 'y')])), base);
  assert.notEqual(pinnedNotesKey(pad(['a', 'b'], [note('a', 'x'), note('b', 'y')])), base);
  assert.notEqual(pinnedNotesKey(pad([], [note('a', 'x'), note('b', 'y')])), base);
});
