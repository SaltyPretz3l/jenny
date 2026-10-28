'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEditorDocuments } = require('../renderer/features/renderer-ide-editor-documents');
const monacoUtils = require('../renderer/features/renderer-monaco-editor-utils');

test('runApplying raises the single applying flag, returns the result and restores the previous value', () => {
  const store = createEditorDocuments({ monacoUtils });
  assert.equal(store.isApplyingValue(), false);
  const seen = [];
  const result = store.runApplying(() => {
    seen.push(store.isApplyingValue());
    store.runApplying(() => seen.push(store.isApplyingValue()));
    seen.push(store.isApplyingValue()); // a nested call never lowers the outer flag
    return 7;
  });
  assert.equal(result, 7);
  assert.deepEqual(seen, [true, true, true]);
  assert.equal(store.isApplyingValue(), false);
  assert.throws(() => store.runApplying(() => { throw new Error('x'); }));
  assert.equal(store.isApplyingValue(), false, 'restored after a throw');
});
