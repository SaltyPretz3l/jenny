'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readCursorInfo } = require('../renderer/features/renderer-ide-editor-reads');

const selection = { isEmpty: () => false, startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 2 };

test('selectedChars uses getValueLengthInRange (no selection-text copy)', () => {
  let lengthCalls = 0;
  const model = {
    getValueLengthInRange: () => { lengthCalls += 1; return 42; },
    getValueInRange: () => { throw new Error('must not copy the selection'); },
  };
  const info = readCursorInfo({
    doc: { kind: 'file', model },
    monacoEditor: { getPosition: () => ({ lineNumber: 3, column: 2 }), getSelection: () => selection },
  });
  assert.deepEqual(info, { lineNumber: 3, column: 2, selectedChars: 42 });
  assert.equal(lengthCalls, 1);
});

test('selectedChars falls back to getValueInRange when the length API is missing', () => {
  const info = readCursorInfo({
    doc: { kind: 'file', model: { getValueInRange: () => 'abcde' } },
    monacoEditor: { getPosition: () => ({ lineNumber: 1, column: 1 }), getSelection: () => selection },
  });
  assert.equal(info.selectedChars, 5);
});
