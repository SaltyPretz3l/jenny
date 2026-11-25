'use strict';

/* Workspace layout instance views: terminal-2..4 are instances of the `terminal` view, added as
 * their own stack with addStackBeside or as a tab with addView. The second Workspace chat
 * (chat-2, changes-2; row 40 W6b) is retired (row 190): a stored layout that holds them loads
 * without them. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');
const { stk, editor, spl, ch, shape, stackOf } = require('./helpers/workbench-layout-fixtures');

const { createDefaultLayout, normalizeLayout, findView, findStack, listViews } = model;

function rootChildOf(layout, viewId) {
  const stackId = findView(layout, viewId).stackId;
  return layout.root.children.find((c) => c.node.id === stackId || (c.node.t === 'split' && c.node.children.some((k) => k.node.id === stackId)));
}

test('instanceBase and isInstanceView map the terminal instance ids and nothing else', () => {
  assert.deepEqual(['terminal-2', 'terminal-3', 'terminal-4'].map(model.instanceBase), ['terminal', 'terminal', 'terminal']);
  const negatives = ['chat-2', 'changes-2', 'chat-3', 'changes-1', 'chat', 'changes', 'terminal', 'terminal-1', 'terminal-5', 'run', '', null, 7];
  assert.deepEqual(negatives.map(model.instanceBase), negatives.map(() => null));
  assert.deepEqual(negatives.map(model.isInstanceView), negatives.map(() => false));
  assert.equal(model.isInstanceView('terminal-3'), true);
});

test('chat-2 and changes-2 are no longer view ids', () => {
  ['chat-2', 'changes-2', 'chat-3', 'changes-1', 'chat-02'].forEach((id) => assert.equal(model.isCatalogView(id), false, id));
  assert.equal(model.isBindableView('chat-2'), false);
  assert.equal(model.isCatalogView('terminal-2'), true);
  assert.equal(model.isCatalogView('chat'), true);
});

test('a stored Workspace layout holding chat-2 and changes-2 normalizes to the same tree without them', () => {
  const base = createDefaultLayout();
  const raw = JSON.parse(JSON.stringify(base));
  raw.bind = { chat: 'editor-1', 'chat-2': 'editor-1' };
  const chatStackId = findView(base, 'chat').stackId;
  (function walk(node) {
    if (node.t === 'split') return node.children.forEach((c) => walk(c.node));
    if (node.id === chatStackId) node.views.push('chat-2', 'changes-2');
  })(raw.root);
  // They also sit in a stack of their own, which empties and goes.
  raw.root.children.push(ch(stk('stack-chat-2', ['chat-2', 'changes-2']), 320));
  const out = normalizeLayout(raw);
  assert.equal(listViews(out).some((id) => id === 'chat-2' || id === 'changes-2'), false);
  assert.equal(findStack(out, 'stack-chat-2'), null, 'the stack they held is dropped');
  assert.equal(shape(out.root), shape(base.root), 'same tree as without them');
  assert.deepEqual(findStack(out, chatStackId).views, ['chat', 'changes']);
  assert.equal(out.bind && out.bind['chat-2'], undefined, 'their binding goes with them');
});

test('normalize keeps terminal-2 where it is, drops a duplicate, and never re-homes an absent instance', () => {
  const base = createDefaultLayout();
  const raw = JSON.parse(JSON.stringify(base));
  const chatStackId = findView(base, 'chat').stackId;
  (function walk(node) {
    if (node.t === 'split') return node.children.forEach((c) => walk(c.node));
    if (node.id === chatStackId) node.views.push('terminal-2', 'chat-3');
    if (node.views && node.views.includes('explorer')) node.views.push('terminal-2', 'terminal-3');
  })(raw.root);
  const out = normalizeLayout(raw);
  assert.equal(findView(out, 'terminal-2').stackId, findView(out, 'explorer').stackId, 'the first occurrence in tree order wins');
  assert.equal(findStack(out, chatStackId).views.includes('terminal-2'), false, 'the later duplicate is dropped');
  assert.equal(findView(out, 'terminal-3').stackId, findView(out, 'explorer').stackId, 'stays where the user put it');
  assert.equal(findView(out, 'chat-3'), null);
  assert.equal(listViews(out).filter((id) => id === 'terminal-2').length, 1);
  const fresh = listViews(normalizeLayout(createDefaultLayout()));
  assert.equal(fresh.includes('terminal-2') || fresh.includes('terminal-3'), false, 'absent instances are not re-homed');
});

test("addStackBeside 'col' below chat wraps its stack in a col split and keeps the dock width", () => {
  const base = createDefaultLayout();
  const before = rootChildOf(base, 'chat');
  const next = ops.addStackBeside(base, ['terminal-2'], 'chat', 'col', 300);
  assert.notEqual(next, base);
  const after = rootChildOf(next, 'chat');
  assert.equal(after.size, before.size, 'the wrapper takes the old stack size in the root row');
  assert.equal(after.size, 380);
  assert.equal(after.node.t, 'split');
  assert.equal(after.node.dir, 'col');
  assert.equal(after.node.children.length, 2);
  assert.deepEqual(after.node.children[0].node.views, ['chat', 'changes'], 'the old stack is first');
  const fresh = after.node.children[1].node;
  assert.equal(fresh.kind, 'views');
  assert.deepEqual(fresh.views, ['terminal-2']);
  assert.equal(fresh.active, 'terminal-2');
  assert.equal(fresh.collapsed, false);
  assert.equal(stackOf(next, 'terminal-2'), fresh);
  assert.equal(shape(next.root), 'row(explorer+search+source-control,col(E,terminal+problems+run+test-runner+test-output+activity!),col(chat+changes!,terminal-2))');
  assert.equal(shape(base.root).includes('terminal-2'), false, 'input untouched');
});

test('addStackBeside normalizes the wrapper: the last child flexes and the old stack takes the col default', () => {
  const next = ops.addStackBeside(createDefaultLayout(), ['terminal-2'], 'chat', 'col', 300);
  const wrapper = rootChildOf(next, 'chat').node;
  assert.equal(wrapper.children[1].size, null, 'no editor inside, so the last child is the flexible one');
  assert.equal(wrapper.children[0].size, 220, 'the old stack takes the default col size');
});

test('addStackBeside with the near extent keeps the rest for the near stack when the new one flexes', () => {
  const next = ops.addStackBeside(createDefaultLayout(), ['terminal-2', 'terminal-3'], 'chat', 'col', 320, 780);
  const wrapper = rootChildOf(next, 'chat').node;
  assert.equal(wrapper.children[1].size, null, 'the new last stack still flexes');
  assert.equal(wrapper.children[0].size, 460, 'Chat 1 keeps 780 - 320, not the 220 default');
  const tight = ops.addStackBeside(createDefaultLayout(), ['terminal-2'], 'chat', 'col', 320, 300);
  const floor = rootChildOf(tight, 'chat').node.children[0].size;
  assert.ok(floor >= 100 && floor < 300, `a short column falls back to the near stack's floor (${floor})`);
});

test("addStackBeside 'row' places the new stack after the near stack in reading order", () => {
  const base = createDefaultLayout();
  const next = ops.addStackBeside(base, ['terminal-3', 'terminal-2'], 'chat', 'row', 400);
  const kids = next.root.children;
  assert.equal(kids.length, base.root.children.length + 1, 'the root row already runs that way: a sibling, no wrapper');
  assert.deepEqual(kids[kids.length - 2].node.views, ['chat', 'changes']);
  assert.deepEqual(kids[kids.length - 1].node.views, ['terminal-3', 'terminal-2'], 'order kept, after the near stack');
  assert.equal(kids[kids.length - 1].node.active, 'terminal-3', 'active is the first view');
  assert.equal(kids[kids.length - 1].size, 400);
  const wrapped = ops.addStackBeside(base, ['terminal-2'], 'terminal', 'row', 400);
  const bottom = wrapped.root.children[1].node.children[1];
  assert.equal(bottom.node.dir, 'row', 'a col slot wraps in a row split');
  assert.equal(bottom.size, 220, 'the wrapper keeps the bottom height');
  assert.deepEqual(bottom.node.children.map((c) => c.node.views[0]), ['terminal', 'terminal-2']);
});

test('addStackBeside into a split that already runs that way adds a sibling', () => {
  const base = createDefaultLayout();
  const next = ops.addStackBeside(base, ['terminal-2'], 'terminal', 'col', 260);
  const column = base.root.children[1].node;
  const col = next.root.children[1].node;
  assert.equal(col.id, column.id, 'no new wrapper');
  assert.equal(col.children.length, 3);
  assert.deepEqual(col.children[2].node.views, ['terminal-2']);
  assert.equal(col.children[2].size, 260);
  assert.equal(col.children[1].node.id, column.children[1].node.id, 'inserted directly after the near stack');
  assert.equal(col.children[0].size, null, 'the editor stays flexible');
  assert.equal(next.root.children.length, base.root.children.length);
});

test('addStackBeside inserts directly after the near stack, not at the end', () => {
  const base = normalizeLayout({ v: 1, root: spl('r', 'row',
    ch(stk('L', ['explorer', 'search', 'source-control']), 300),
    ch(spl('c', 'col', ch(editor(), null), ch(stk('B', ['terminal', 'problems', 'run', 'test-runner', 'test-output', 'activity']), 220), ch(stk('X', ['changes']), 200)), null),
    ch(stk('R', ['chat']), 380)) });
  const next = ops.addStackBeside(base, ['terminal-2'], 'terminal', 'col', 250);
  const col = next.root.children[1].node;
  assert.deepEqual(col.children.map((c) => (c.node.t === 'stack' ? c.node.views[0] || 'E' : 'S')), ['E', 'terminal', 'terminal-2', 'changes']);
});

test('addStackBeside clamps the size to the view minimum and the size cap', () => {
  const small = ops.addStackBeside(createDefaultLayout(), ['terminal-2'], 'terminal', 'col', 10);
  assert.equal(small.root.children[1].node.children[2].size, model.VIEW_CATALOG.terminal.minHeight);
  const huge = ops.addStackBeside(createDefaultLayout(), ['terminal-2'], 'terminal', 'col', 99999);
  assert.equal(huge.root.children[1].node.children[2].size, model.SIZE_MAX);
  const dflt = ops.addStackBeside(createDefaultLayout(), ['terminal-2'], 'terminal', 'col');
  assert.equal(dflt.root.children[1].node.children[2].size, 280, 'default size');
});

test('addStackBeside refuses with the same reference on every invalid input', () => {
  const base = createDefaultLayout();
  const placed = ops.addStackBeside(base, ['terminal-2'], 'chat', 'col', 300);
  assert.equal(ops.addStackBeside(null, ['terminal-2'], 'chat', 'col', 300), null);
  const bad = { v: 2, root: {} };
  assert.equal(ops.addStackBeside(bad, ['terminal-2'], 'chat', 'col', 300), bad, 'invalid layout');
  assert.equal(ops.addStackBeside(base, [], 'chat', 'col', 300), base, 'no views');
  assert.equal(ops.addStackBeside(base, 'terminal-2', 'chat', 'col', 300), base, 'views not an array');
  assert.equal(ops.addStackBeside(base, ['chat-3'], 'chat', 'col', 300), base, 'not a catalog view');
  assert.equal(ops.addStackBeside(base, ['chat'], 'terminal', 'col', 300), base, 'already in the tree');
  assert.equal(ops.addStackBeside(placed, ['terminal-2'], 'terminal', 'col', 300), placed, 'already in the tree (instance)');
  assert.equal(ops.addStackBeside(base, ['terminal-2', 'terminal-2'], 'chat', 'col', 300), base, 'duplicate in the request');
  assert.equal(ops.addStackBeside(base, ['terminal-2', 'chat'], 'chat', 'col', 300), base, 'one of several already present');
  assert.equal(ops.addStackBeside(base, ['terminal-2'], 'nowhere', 'col', 300), base, 'near view missing');
  assert.equal(ops.addStackBeside(base, ['terminal-2'], 'terminal-2', 'col', 300), base, 'near view absent from the tree');
  assert.equal(ops.addStackBeside(base, ['terminal-2'], 'chat', 'diagonal', 300), base, 'bad dir');
  assert.equal(ops.addStackBeside(base, ['terminal-2'], 'chat', undefined, 300), base, 'no dir');
});

test('addStackBeside never mutates the input layout', () => {
  const base = createDefaultLayout();
  const snapshot = JSON.stringify(base);
  ops.addStackBeside(base, ['terminal-2'], 'chat', 'col', 300);
  ops.addStackBeside(base, ['terminal-3'], 'terminal', 'col', 300);
  assert.equal(JSON.stringify(base), snapshot);
});

test('removeView drops terminal-2 and the stack it was alone in, and refuses the base views', () => {
  const base = createDefaultLayout();
  const placed = ops.addStackBeside(base, ['terminal-2'], 'chat', 'col', 300);
  const removed = ops.removeView(placed, 'terminal-2');
  assert.equal(findView(removed, 'terminal-2'), null);
  assert.equal(ops.isLayoutEqual(removed, base), true, 'the wrapper dissolves back to the default tree');
  assert.equal(shape(removed.root), shape(base.root));
  assert.equal(ops.removeView(removed, 'chat'), removed, 'chat is a base view');
  assert.equal(ops.removeView(removed, 'changes'), removed);
  assert.equal(ops.removeView(removed, 'terminal-2'), removed, 'absent');
  assert.equal(ops.removeView(removed, 'chat-3'), removed, 'unknown');
});

test('removeView drops a terminal-2 tab and moves the active tab to its neighbour', () => {
  const tabbed = ops.addView(createDefaultLayout(), 'terminal-2', 'chat');
  assert.equal(stackOf(tabbed, 'chat').active, 'terminal-2');
  const removed = ops.removeView(tabbed, 'terminal-2');
  assert.deepEqual(stackOf(removed, 'chat').views, ['chat', 'changes']);
  assert.equal(stackOf(removed, 'chat').active, 'chat');
});

test('addView adds terminal-3 as a tab beside terminal-2', () => {
  const base = ops.addView(createDefaultLayout(), 'terminal-2', 'terminal');
  const next = ops.addView(base, 'terminal-3', 'terminal-2');
  const stack = stackOf(next, 'terminal');
  assert.deepEqual(stack.views.slice(0, 3), ['terminal', 'terminal-2', 'terminal-3']);
  assert.equal(stack.active, 'terminal-3');
  assert.equal(stack.collapsed, false);
  assert.equal(ops.addView(next, 'terminal-3', 'terminal'), next, 'already present');
  assert.equal(ops.addView(base, 'terminal-5', 'terminal'), base, 'unknown instance');
  assert.equal(ops.addView(base, 'chat-2', 'chat'), base, 'chat-2 is not a view');
  assert.equal(ops.addView(base, 'changes-2', 'changes'), base, 'changes-2 is not a view');
});

test('moving an instance to the right edge keeps the plain right edge size', () => {
  // The instance sits alone on the right edge, so the edge stack is its own source and a fresh stack is made.
  const base = createDefaultLayout();
  const lastOf = (layout) => layout.root.children[layout.root.children.length - 1];
  const placed = ops.addStackBeside(base, ['terminal-2'], 'chat', 'row', 400);
  assert.deepEqual(lastOf(placed).node.views, ['terminal-2'], 'precondition: alone on the right edge');
  assert.equal(lastOf(placed).size, 400);
  const moved = ops.moveView(placed, 'terminal-2', { edge: 'right' });
  assert.deepEqual(lastOf(moved).node.views, ['terminal-2']);
  assert.equal(lastOf(moved).size, 300, 'a terminal keeps the plain right edge size');
  assert.equal(lastOf(moved).node.collapsed, false);
});

test('terminal instances behave as before', () => {
  const base = createDefaultLayout();
  const next = ops.addView(base, 'terminal-2', 'terminal');
  assert.equal(ops.removeView(next, 'terminal-2') !== next, true);
  assert.equal(ops.removeView(next, 'terminal'), next);
  assert.equal(model.isInstanceView('terminal-2'), true);
});
