'use strict';
// Row 82 G2: the gutter module's hunk API (renderer-ide-gutter-decorations.js): change
// blocks against the live buffer, a click on a change bar opening the peek, the caret
// feeding inline blame through the buffer-to-HEAD line map, Go to Next / Previous Change,
// and a git refresh invalidating both.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeGutterDecorations } = require('../renderer/features/renderer-ide-gutter-decorations');

const LANE = 4; // stands in for monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
const headFound = (content) => ({ ok: true, available: true, isRepo: true, found: true, content });

function fakeEditor() {
  const handlers = {};
  const on = (name) => (fn) => { (handlers[name] = handlers[name] || []).push(fn); return { dispose() {} }; };
  return {
    handlers,
    fire: (name, event) => (handlers[name] || []).forEach((fn) => fn(event)),
    onMouseDown: on('mouseDown'),
    onDidChangeCursorSelection: on('cursor'),
    onDidChangeModelContent: on('content'),
    onDidScrollChange: on('scroll'),
  };
}

function setup({ head = 'a\nb\nc\nd\ne\n', value = 'a\nB\nc\nd\nE\n', cursor = 1 } = {}) {
  const editor = fakeEditor();
  const state = { value, cursor, reveal: [] };
  const peekCalls = [];
  const blameCalls = { cursor: [], clear: 0, invalidate: 0 };
  const editorHost = {
    getActivePath: () => 'a.js',
    getDocumentKind: () => 'file',
    getValue: () => state.value,
    isLargeFile: () => false,
    setGutterDecorations: () => 0,
    editorFor: () => editor,
    getMonaco: () => ({ editor: { MouseTargetType: { GUTTER_LINE_DECORATIONS: LANE } } }),
    getCursorInfo: () => ({ lineNumber: state.cursor }),
    revealPosition: (path, line) => state.reveal.push(line),
  };
  const gutter = createIdeGutterDecorations({
    editorHost,
    windowRef: { addEventListener() {}, removeEventListener() {} },
    gitClient: { getFileAtHead: async () => headFound(head) },
    clientUtils: {},
    setTimeoutFn: () => 0,
    clearTimeoutFn: () => {},
    rendererIdeHunkPeek: { createIdeHunkPeek: () => ({ openAt: (path, line) => peekCalls.push([path, line]), close() {}, dispose() {} }) },
    rendererIdeInlineBlame: {
      createIdeInlineBlame: (deps) => {
        blameCalls.headLineFor = deps.headLineFor;
        return {
          handleCursor: (path, line) => blameCalls.cursor.push([path, line]),
          clear: () => { blameCalls.clear += 1; },
          invalidate: () => { blameCalls.invalidate += 1; },
          dispose() {},
        };
      },
    },
  });
  return { gutter, editor, state, peekCalls, blameCalls };
}

test('the change blocks follow the live buffer and map lines to HEAD for blame', async () => {
  const { gutter, state, blameCalls } = setup();
  assert.equal(gutter.getChangeBlocks('a.js'), null, 'no HEAD baseline yet');
  await gutter.recompute('a.js');
  assert.deepEqual(gutter.getChangeBlocks('a.js').blocks.map((block) => block.anchorLine), [2, 5]);
  assert.equal(gutter.getChangeBlocks('a.js'), gutter.getChangeBlocks('a.js'), 'memoized per buffer state');
  assert.deepEqual([1, 2, 3].map((line) => blameCalls.headLineFor('a.js', line)), [1, null, 3]);
  state.value = 'new\na\nB\nc\nd\nE\n';
  assert.equal(blameCalls.headLineFor('a.js', 4), 3, 'an inserted line above shifts the HEAD line');
  assert.deepEqual(blameCalls.cursor, [['a.js', 1]], 'a recompute re-evaluates blame at the caret');
});

// The peek finds the block under the line itself (cleanup G8: no prefilter here; a line
// without a change opens nothing, pinned in renderer-ide-hunk-peek.test.js).
test('a click in the change-bar lane asks the peek; other gutter clicks do not', async () => {
  const { gutter, editor, peekCalls } = setup();
  await gutter.recompute('a.js');
  editor.fire('mouseDown', { target: { type: LANE, position: { lineNumber: 2 } } });
  editor.fire('mouseDown', { target: { type: 2, position: { lineNumber: 5 } } });
  assert.deepEqual(peekCalls, [['a.js', 2]]);
  await gutter.recompute('a.js');
  editor.fire('mouseDown', { target: { type: LANE, position: { lineNumber: 5 } } });
  assert.deepEqual(peekCalls, [['a.js', 2], ['a.js', 5]], 'the editor is hooked once');
});

test('caret moves feed inline blame and an edit clears it at once', async () => {
  const { gutter, editor, blameCalls } = setup();
  await gutter.recompute('a.js');
  editor.fire('cursor', { selection: { positionLineNumber: 3 } });
  editor.fire('content', {});
  assert.deepEqual(blameCalls.cursor.slice(1), [['a.js', 3]]);
  assert.equal(blameCalls.clear, 1);
});

test('Go to Next / Previous Change wraps around the file', async () => {
  const { gutter, state } = setup({ cursor: 3 });
  await gutter.recompute('a.js');
  assert.equal(gutter.goToChange(1), true);
  state.cursor = 5;
  gutter.goToChange(1);
  gutter.goToChange(-1);
  state.cursor = 1;
  gutter.goToChange(-1);
  assert.deepEqual(state.reveal, [5, 2, 2, 5]);
});

test('a git refresh drops the baseline and invalidates blame', async () => {
  const { gutter, blameCalls } = setup();
  await gutter.recompute('a.js');
  gutter.refreshActive();
  assert.equal(gutter.getChangeBlocks('a.js'), null);
  assert.equal(blameCalls.invalidate, 1);
});
