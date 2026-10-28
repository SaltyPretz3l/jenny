'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { revealFirstChangeOnce } = require('../renderer/features/renderer-ide-editor-host-group-diff');

function fakeDiffEditor() {
  const reveals = [];
  const editor = {
    listener: null,
    disposed: 0,
    onDidUpdateDiff(cb) { this.listener = cb; return { dispose: () => { editor.disposed += 1; } }; },
    getLineChanges: () => [{ modifiedStartLineNumber: 4, charChanges: [{ modifiedStartLineNumber: 5, modifiedStartColumn: 30 }] }],
    getModifiedEditor: () => ({ revealPositionInCenter: (p) => reveals.push(p) }),
  };
  return { editor, reveals };
}

test('reveals the first changed character once, then unsubscribes', () => {
  const { editor, reveals } = fakeDiffEditor();
  const subscription = revealFirstChangeOnce(editor);
  assert.ok(subscription);
  editor.listener();
  editor.listener();
  assert.deepEqual(reveals, [{ lineNumber: 5, column: 30 }]);
  assert.equal(editor.disposed, 1);
});

test('no subscription without onDidUpdateDiff', () => {
  assert.equal(revealFirstChangeOnce({}), null);
  assert.equal(revealFirstChangeOnce(null), null);
});
