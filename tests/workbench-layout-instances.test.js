'use strict';

/* Workspace layout instance views (row 40 W4): terminal-2..4 are instances of the
 * `terminal` view (F3: four terminals), and test-output is the F6 task view. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');

const { createDefaultLayout, normalizeLayout, findView, findStack, listViews, terminalSlot, terminalViewId } = model;

test('terminal slots map to view ids and back, capped at four', () => {
  assert.equal(model.MAX_TERMINALS, 4);
  assert.deepEqual([1, 2, 3, 4].map(terminalViewId), ['terminal', 'terminal-2', 'terminal-3', 'terminal-4']);
  assert.deepEqual([0, 5, -1, 1.5, 'x', null].map(terminalViewId), [null, null, null, 'terminal', null, null]);
  assert.deepEqual(['terminal', 'terminal-2', 'terminal-4', 'terminal-5', 'terminal-1', 'run', 7].map(terminalSlot), [1, 2, 4, 0, 0, 0, 0]);
  assert.equal(model.isCatalogView('terminal-3'), true);
  assert.equal(model.isCatalogView('terminal-5'), false);
  assert.equal(model.isCatalogView('test-output'), true);
});

test('the default layout homes test-output in the bottom stack and has one terminal', () => {
  const layout = createDefaultLayout();
  assert.deepEqual(findStack(layout, findView(layout, 'terminal').stackId).views, ['terminal', 'problems', 'run', 'test-runner', 'test-output']);
  assert.equal(listViews(layout).filter((id) => terminalSlot(id) > 0).length, 1);
});

test('normalize keeps instance terminals where they are, drops unknown and duplicate ones, and never re-homes them', () => {
  const base = createDefaultLayout();
  const bottomId = findView(base, 'terminal').stackId;
  const raw = JSON.parse(JSON.stringify(base));
  (function walk(node) {
    if (node.t === 'split') return node.children.forEach((c) => walk(c.node));
    if (node.id === bottomId) node.views.push('terminal-3', 'terminal-5', 'terminal-3', '__proto__');
    if (node.views && node.views.includes('explorer')) node.views.push('terminal-2');
  })(raw.root);
  const out = normalizeLayout(raw);
  assert.deepEqual(findStack(out, bottomId).views.slice(-1), ['terminal-3']);
  assert.equal(findView(out, 'terminal-2').stackId, findView(out, 'explorer').stackId, 'an instance stays where the user put it');
  assert.equal(findView(out, 'terminal-5'), null);
  assert.equal(listViews(normalizeLayout(createDefaultLayout())).includes('terminal-2'), false, 'absent instances are not re-homed');
});

test('an instance terminal takes the terminal floor in the solver', () => {
  const { stk, editor, spl, ch } = require('./helpers/workbench-layout-fixtures');
  const layout = normalizeLayout({ v: 1, root: spl('r', 'row', ch(editor(), null), ch(stk('T', ['terminal-2']), 50)) });
  assert.equal(model.minExtent(findStack(layout, findView(layout, 'terminal-2').stackId), 'row', 1), model.VIEW_CATALOG.terminal.minWidth);
});

test('addView opens an instance next to its neighbour, active, and is a no-op when present or unknown', () => {
  const base = createDefaultLayout();
  const next = ops.addView(base, 'terminal-2', 'terminal');
  const stack = findStack(next, findView(next, 'terminal').stackId);
  assert.deepEqual(stack.views.slice(0, 2), ['terminal', 'terminal-2']);
  assert.equal(stack.active, 'terminal-2');
  assert.equal(stack.collapsed, false, 'the stack opens');
  assert.equal(ops.addView(next, 'terminal-2', 'terminal'), next, 'already present');
  assert.equal(ops.addView(base, 'terminal-9', 'terminal'), base, 'unknown view');
  assert.equal(ops.addView(base, 'terminal-2', 'nowhere'), base, 'unknown neighbour');
  assert.equal(base.root.children[1].node.children[1].node.views.includes('terminal-2'), false, 'input untouched');
});

test('removeView drops an instance, moves the active tab to its neighbour, and refuses catalog views', () => {
  let layout = ops.addView(createDefaultLayout(), 'terminal-2', 'terminal');
  layout = ops.addView(layout, 'terminal-3', 'terminal-2');
  const removed = ops.removeView(layout, 'terminal-3');
  const stack = findStack(removed, findView(removed, 'terminal').stackId);
  assert.equal(findView(removed, 'terminal-3'), null);
  assert.equal(stack.active, 'terminal-2', 'the neighbour becomes active');
  assert.equal(ops.removeView(removed, 'terminal'), removed, 'the first terminal is a catalog view');
  assert.equal(ops.removeView(removed, 'explorer'), removed);
  assert.equal(ops.removeView(removed, 'terminal-4'), removed, 'absent');
});

test('removeView drops a stack the instance was alone in', () => {
  const { stk, editor, spl, ch, LEFT, BOTTOM, CHAT } = require('./helpers/workbench-layout-fixtures');
  const solo = normalizeLayout({ v: 1, root: spl('r', 'row',
    ch(stk('L', LEFT), 300),
    ch(spl('c', 'col', ch(editor(), null), ch(stk('B', BOTTOM), 220)), null),
    ch(stk('X', ['terminal-2']), 280),
    ch(stk('R', CHAT), 380)) });
  assert.ok(findStack(solo, 'X'), 'precondition: terminal-2 has its own stack');
  const out = ops.removeView(solo, 'terminal-2');
  assert.equal(findStack(out, 'X'), null, 'the emptied stack is gone');
  assert.equal(findView(out, 'terminal-2'), null);
  assert.equal(out.root.children.length, 3);
});
