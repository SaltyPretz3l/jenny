'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeGutterDecorations,
  createIdeGutterDecorations,
  splitLines,
} = require('../renderer/features/renderer-ide-gutter-decorations');

test('computeGutterDecorations accepts the cached pre-split HEAD lines', () => {
  const head = 'one\r\ntwo\nthree\n';
  const buffer = 'one\nTWO\nthree\nfour\n';
  assert.deepEqual(computeGutterDecorations(splitLines(head), buffer), computeGutterDecorations(head, buffer));
});

test('large-file skip reads editorHost.isLargeFile(path), not the window reader', async () => {
  const calls = [];
  const gutter = createIdeGutterDecorations({
    editorHost: {
      getActivePath: () => 'big.js',
      getDocumentKind: () => 'file',
      getValue: () => 'x',
      isLargeFile: (path) => { calls.push(path); return true; },
      setGutterDecorations: (path, decs) => calls.push(decs.length),
    },
    windowRef: { rendererIdeActiveEditorReader: { isLargeFile: () => false }, addEventListener() {}, removeEventListener() {} },
    gitClient: { getFileAtHead: async () => { throw new Error('must not read HEAD'); } },
    clientUtils: {},
  });
  await gutter.recompute('big.js');
  assert.deepEqual(calls, ['big.js', 0]);
  gutter.dispose();
});
