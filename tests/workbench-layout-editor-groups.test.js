'use strict';

/* Row 40 W5-S1: adding and removing secondary editor stacks on the layout tree. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');
const fx = require('./helpers/workbench-layout-fixtures');

const { createDefaultLayout, normalizeLayout, findStack, EDITOR_MIN_WIDTH, EDITOR_MIN_HEIGHT, SIZE_MAX } = model;
const { listEditorGroups, addEditorGroup, removeEditorGroup, isLayoutEqual } = ops;
const { LEFT, BOTTOM, CHAT, shape, collectNodes, sizeEntry, stk, editor, spl, ch, assertValid } = fx;

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function parentOf(layout, nodeId) {
  return collectNodes(layout.root).find(
    (n) => n.t === 'split' && n.children.some((c) => c.node.id === nodeId)
  );
}

// row[ explorer-stack | editor | bottom-stack | chat-stack ]: the editor sits directly in the root row.
function rowLayout() {
  return normalizeLayout({
    v: 1,
    root: spl(
      null,
      'row',
      ch(stk(null, LEFT), 300),
      ch(editor('editor-1')),
      ch(stk(null, BOTTOM, { collapsed: true }), 240),
      ch(stk(null, CHAT), 380)
    ),
  });
}

function withGroups(...steps) {
  return steps.reduce(
    (layout, [beside, dir, newId]) => addEditorGroup(layout, beside, dir, undefined, newId),
    createDefaultLayout()
  );
}

test('listEditorGroups returns editor stack ids in tree order', () => {
  assert.deepEqual(listEditorGroups(createDefaultLayout()), ['editor-1']);
  const two = withGroups(['editor-1', 'right', 'editor-2']);
  assert.deepEqual(listEditorGroups(two), ['editor-1', 'editor-2']);
  const ordered = withGroups(['editor-1', 'right', 'editor-3'], ['editor-1', 'right', 'editor-2']);
  assert.deepEqual(listEditorGroups(ordered), ['editor-1', 'editor-2', 'editor-3']);
  assert.deepEqual(listEditorGroups(null), []);
  assert.deepEqual(listEditorGroups({ v: 2, root: {} }), []);
});

test('add right wraps the beside stack in a row split with a flexible beside and a px new stack', () => {
  const base = createDefaultLayout();
  const next = addEditorGroup(base, 'editor-1', 'right', 500, 'editor-2');
  assert.notEqual(next, base);
  assertValid(next);
  assert.deepEqual(listEditorGroups(next), ['editor-1', 'editor-2']);
  const wrap = parentOf(next, 'editor-1');
  assert.equal(wrap.dir, 'row');
  assert.deepEqual(wrap.children.map((c) => c.node.id), ['editor-1', 'editor-2']);
  assert.equal(wrap.children[0].size, null, 'the beside stack stays the flexible child');
  assert.equal(wrap.children[1].size, 500);
  assert.equal(findStack(next, 'editor-2').kind, 'editor');
  // The wrap took the beside stack's place in its old parent (the editor/bottom column).
  assert.equal(parentOf(next, wrap.id).dir, 'col');
});

test('add down wraps in a col split when the parent runs the other way', () => {
  const next = addEditorGroup(rowLayout(), 'editor-1', 'down', 260, 'editor-2');
  assertValid(next);
  const wrap = parentOf(next, 'editor-1');
  assert.equal(wrap.dir, 'col');
  assert.deepEqual(wrap.children.map((c) => c.node.id), ['editor-1', 'editor-2']);
  assert.deepEqual(wrap.children.map((c) => c.size), [null, 260]);
  assert.equal(parentOf(next, wrap.id).dir, 'row', 'the wrap sits in the root row');
});

test('default sizes are 480 to the right and 300 down', () => {
  const right = addEditorGroup(createDefaultLayout(), 'editor-1', 'right', undefined, 'editor-2');
  assert.equal(sizeEntry(right, 'editor-2').size, 480);
  const down = addEditorGroup(rowLayout(), 'editor-1', 'down', undefined, 'editor-2');
  assert.equal(sizeEntry(down, 'editor-2').size, 300);
  const nan = addEditorGroup(createDefaultLayout(), 'editor-1', 'right', Number.NaN, 'editor-2');
  assert.equal(sizeEntry(nan, 'editor-2').size, 480);
});

test('size is clamped to the editor minimum for the axis and to SIZE_MAX', () => {
  const narrow = addEditorGroup(createDefaultLayout(), 'editor-1', 'right', 10, 'editor-2');
  assert.equal(sizeEntry(narrow, 'editor-2').size, EDITOR_MIN_WIDTH);
  const short = addEditorGroup(rowLayout(), 'editor-1', 'down', 10, 'editor-2');
  assert.equal(sizeEntry(short, 'editor-2').size, EDITOR_MIN_HEIGHT);
  const huge = addEditorGroup(createDefaultLayout(), 'editor-1', 'right', 99999, 'editor-2');
  assert.equal(sizeEntry(huge, 'editor-2').size, SIZE_MAX);
});

test('add in the parent split\'s own direction inserts after the beside stack instead of nesting', () => {
  const base = rowLayout();
  const next = addEditorGroup(base, 'editor-1', 'right', 400, 'editor-2');
  assertValid(next);
  const row = parentOf(next, 'editor-1');
  assert.equal(row.id, base.root.id, 'no new split: the root row is reused');
  assert.deepEqual(row.children.map((c) => c.node.id).filter((id) => id.startsWith('editor-')), ['editor-1', 'editor-2']);
  const at = row.children.findIndex((c) => c.node.id === 'editor-1');
  assert.equal(row.children[at + 1].node.id, 'editor-2', 'right after the beside stack');
  assert.equal(row.children[at].size, null);
  assert.equal(row.children[at + 1].size, 400);
  assert.equal(row.children.length, 5, 'explorer, editor, new editor, bottom, chat');
});

test('same-direction insert beside a non-last editor keeps the order beside-new-rest', () => {
  const two = addEditorGroup(rowLayout(), 'editor-1', 'right', 400, 'editor-2');
  const three = addEditorGroup(two, 'editor-1', 'right', 350, 'editor-3');
  assertValid(three);
  assert.deepEqual(listEditorGroups(three), ['editor-1', 'editor-3', 'editor-2']);
  const row = parentOf(three, 'editor-3');
  assert.equal(row.children.filter((c) => c.node.kind === 'editor').length, 3);
});

test('add down in a col parent inserts into the editor/bottom column', () => {
  const base = createDefaultLayout();
  const next = addEditorGroup(base, 'editor-1', 'down', 280, 'editor-2');
  assertValid(next);
  const col = parentOf(next, 'editor-1');
  assert.equal(col.dir, 'col');
  assert.deepEqual(col.children.map((c) => c.node.id).slice(0, 2), ['editor-1', 'editor-2']);
  assert.equal(col.children[1].size, 280);
  assert.equal(col.children.length, 3, 'the bottom panel is still in the column');
  assert.equal(col.children[0].size, null);
});

test('add refuses when the cap is reached and returns the input reference', () => {
  const four = withGroups(
    ['editor-1', 'right', 'editor-2'],
    ['editor-2', 'right', 'editor-3'],
    ['editor-3', 'right', 'editor-4']
  );
  assert.equal(listEditorGroups(four).length, model.MAX_EDITOR_GROUPS);
  assertValid(four);
  assert.equal(addEditorGroup(four, 'editor-1', 'right', 400, 'editor-2'), four);
  assert.equal(addEditorGroup(four, 'editor-1', 'down', 300, 'editor-3'), four);
});

test('add refuses invalid or taken ids', () => {
  const two = withGroups(['editor-1', 'right', 'editor-2']);
  for (const id of ['editor-1', 'editor-5', 'editor-0', 'editor-22', 'editor-', 'editor-x', 'split-2', 'stack-1', '', null, undefined, 3]) {
    assert.equal(addEditorGroup(two, 'editor-1', 'right', 400, id), two, String(id));
  }
  assert.equal(addEditorGroup(two, 'editor-1', 'right', 400, 'editor-2'), two, 'already in the tree');
  const base = createDefaultLayout();
  assert.equal(addEditorGroup(base, 'editor-1', 'right', 400, base.root.id), base, 'an existing split id is not an editor id');
});

test('add refuses a missing, non-editor or non-stack beside target', () => {
  const base = createDefaultLayout();
  const explorerStack = fx.stackOf(base, 'explorer');
  assert.equal(addEditorGroup(base, 'editor-9', 'right', 400, 'editor-2'), base);
  assert.equal(addEditorGroup(base, explorerStack.id, 'right', 400, 'editor-2'), base);
  assert.equal(addEditorGroup(base, base.root.id, 'right', 400, 'editor-2'), base, 'a split is not an editor stack');
  assert.equal(addEditorGroup(base, undefined, 'right', 400, 'editor-2'), base);
});

test('add refuses an unknown direction and a malformed layout', () => {
  const base = createDefaultLayout();
  assert.equal(addEditorGroup(base, 'editor-1', 'left', 400, 'editor-2'), base);
  assert.equal(addEditorGroup(base, 'editor-1', 'up', 400, 'editor-2'), base);
  assert.equal(addEditorGroup(base, 'editor-1', undefined, 400, 'editor-2'), base);
  assert.equal(addEditorGroup(null, 'editor-1', 'right', 400, 'editor-2'), null);
  const junk = { v: 1 };
  assert.equal(addEditorGroup(junk, 'editor-1', 'right', 400, 'editor-2'), junk);
});

test('add never mutates the input and keeps the requested id through normalize', () => {
  const base = createDefaultLayout();
  const before = snapshot(base);
  const next = addEditorGroup(base, 'editor-1', 'right', 450, 'editor-3');
  assert.deepEqual(snapshot(base), before);
  assert.deepEqual(listEditorGroups(next), ['editor-1', 'editor-3']);
  const again = normalizeLayout(next);
  assert.deepEqual(listEditorGroups(again), ['editor-1', 'editor-3'], 'the id survives a second normalize');
  assert.ok(isLayoutEqual(again, next), 'the result is already normalized');
});

test('every result keeps exactly one flexible child per split and every catalog view once', () => {
  const layouts = [
    addEditorGroup(createDefaultLayout(), 'editor-1', 'right', 400, 'editor-2'),
    addEditorGroup(createDefaultLayout(), 'editor-1', 'down', 200, 'editor-2'),
    addEditorGroup(rowLayout(), 'editor-1', 'down', 200, 'editor-2'),
    withGroups(['editor-1', 'right', 'editor-2'], ['editor-2', 'down', 'editor-3'], ['editor-1', 'down', 'editor-4']),
  ];
  for (const layout of layouts) {
    assertValid(layout);
    for (const node of collectNodes(layout.root)) {
      if (node.t !== 'split') continue;
      const flexible = node.children.filter((c) => c.size === null);
      assert.equal(flexible.length, 1);
      const firstEditorChild = node.children.findIndex((c) => collectNodes(c.node).some((n) => n.kind === 'editor'));
      if (firstEditorChild >= 0) assert.equal(node.children[firstEditorChild].size, null, 'the editor-bearing child flexes');
    }
  }
});

test('remove drops the stack and the split it leaves with one child collapses', () => {
  const base = createDefaultLayout();
  const two = addEditorGroup(base, 'editor-1', 'right', 450, 'editor-2');
  const back = removeEditorGroup(two, 'editor-2');
  assertValid(back);
  assert.deepEqual(listEditorGroups(back), ['editor-1']);
  assert.equal(shape(back.root), shape(base.root));
  assert.ok(isLayoutEqual(back, base), 'adding then removing restores the layout');
});

test('remove works for a stack inserted in the same direction and for a down group', () => {
  const three = withGroups(['editor-1', 'right', 'editor-2'], ['editor-1', 'down', 'editor-3']);
  assertValid(three);
  const noTwo = removeEditorGroup(three, 'editor-2');
  assertValid(noTwo);
  assert.deepEqual(listEditorGroups(noTwo), ['editor-1', 'editor-3']);
  const noThree = removeEditorGroup(noTwo, 'editor-3');
  assert.deepEqual(listEditorGroups(noThree), ['editor-1']);
  assert.equal(shape(noThree.root), shape(createDefaultLayout().root));
});

test('remove never removes the first editor stack in tree order', () => {
  const layout = normalizeLayout({
    v: 1,
    root: spl(null, 'row', ch(stk(null, LEFT), 300), ch(editor('editor-3')), ch(editor('editor-2'), 400), ch(stk(null, CHAT), 380)),
  });
  assert.deepEqual(listEditorGroups(layout), ['editor-3', 'editor-2']);
  assert.equal(removeEditorGroup(layout, 'editor-3'), layout, 'the primary stays');
  const removed = removeEditorGroup(layout, 'editor-2');
  assert.deepEqual(listEditorGroups(removed), ['editor-3']);
  assertValid(removed);
  const lone = createDefaultLayout();
  assert.equal(removeEditorGroup(lone, 'editor-1'), lone);
});

test('remove of an unknown id, a views stack or a split returns the input', () => {
  const two = withGroups(['editor-1', 'right', 'editor-2']);
  assert.equal(removeEditorGroup(two, 'editor-9'), two);
  assert.equal(removeEditorGroup(two, fx.stackOf(two, 'terminal').id), two);
  assert.equal(removeEditorGroup(two, two.root.id), two);
  assert.equal(removeEditorGroup(two, undefined), two);
  assert.equal(removeEditorGroup(null, 'editor-2'), null);
});

test('remove never mutates the input', () => {
  const two = withGroups(['editor-1', 'down', 'editor-2']);
  const before = snapshot(two);
  const next = removeEditorGroup(two, 'editor-2');
  assert.deepEqual(snapshot(two), before);
  assert.notEqual(next, two);
  assert.deepEqual(listEditorGroups(two), ['editor-1', 'editor-2']);
});
