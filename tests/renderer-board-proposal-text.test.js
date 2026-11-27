'use strict';
// new-test-file: the pure proposal-text module had no direct test, and the view test that covers it sits at the 600-line cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const text = require('../renderer/features/board/board-proposal-text.js');

const removal = (kind) => text.changeText({ n: 1, type: 'remove', class: 'removal', summary: { target: 'x1', kind, label: 'Old' } });

test('a removal names its kind through the catalog; a kind the board does not know reads "card", never the raw value', () => {
  assert.equal(removal('note'), 'Remove note x1: "Old"');
  assert.equal(removal('file'), 'Remove file card x1: "Old"');
  assert.equal(removal('chat'), 'Remove chat card x1: "Old"');
  assert.equal(removal('group'), 'Remove group x1: "Old"');
  assert.equal(removal('drop everything'), 'Remove card x1: "Old"');
  assert.equal(removal(undefined), 'Remove card x1: "Old"');
});
