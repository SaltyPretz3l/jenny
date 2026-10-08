'use strict';

/* Row 40 W7c: a chat or terminal view bound to an editor group, on the layout tree. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');

const { createDefaultLayout, normalizeLayout, isBindableView } = model;
const { setBinding, bindingOf, boundGroups, unbindGroup } = ops;

function twoGroups() {
  return ops.addEditorGroup(createDefaultLayout(), 'editor-1', 'right', undefined, 'editor-2');
}

test('only chats and terminals are bindable; Changes reads its chat binding', () => {
  for (const id of ['chat', 'chat-2', 'terminal', 'terminal-3']) assert.equal(isBindableView(id), true, id);
  for (const id of ['changes', 'explorer', 'run', 'terminal-5', '__proto__']) assert.equal(isBindableView(id), false, id);
  const layout = setBinding(twoGroups(), 'chat', 'editor-2');
  assert.equal(bindingOf(layout, 'chat'), 'editor-2');
  assert.equal(bindingOf(layout, 'changes'), 'editor-2');
  assert.equal(bindingOf(layout, 'terminal'), '');
  assert.equal(setBinding(layout, 'changes', 'editor-1'), layout, 'Changes is not bound on its own');
});

test('setBinding returns a new layout, refuses unknown groups and views, and unbinds with an empty id', () => {
  const base = twoGroups();
  const bound = setBinding(base, 'terminal', 'editor-2');
  assert.notEqual(bound, base);
  assert.equal(base.bind, undefined, 'the input is not modified');
  assert.deepEqual(bound.bind, { terminal: 'editor-2' });
  assert.equal(setBinding(bound, 'terminal', 'editor-2'), bound, 'no change returns the input');
  assert.equal(setBinding(base, 'terminal', 'editor-4'), base, 'no such group');
  assert.equal(setBinding(base, 'terminal-2', 'editor-2'), base, 'terminal-2 is not in the tree');
  const cleared = setBinding(bound, 'terminal', '');
  assert.equal(cleared.bind, undefined);
  assert.equal(ops.isLayoutEqual(bound, cleared), false, 'a binding change is a layout change');
  assert.equal(ops.isLayoutEqual(bound, model.cloneLayout(bound)), true);
});

test('normalize keeps valid bindings across persistence and drops dangling ones', () => {
  const bound = setBinding(setBinding(twoGroups(), 'chat', 'editor-2'), 'terminal', 'editor-1');
  const restored = normalizeLayout(JSON.parse(JSON.stringify(bound)));
  assert.deepEqual(restored.bind, { chat: 'editor-2', terminal: 'editor-1' });
  assert.deepEqual(boundGroups(restored).sort(), ['editor-1', 'editor-2']);
  const raw = JSON.parse(JSON.stringify(bound));
  raw.bind = { chat: 'editor-3', terminal: 'editor-2', explorer: 'editor-1', constructor: 'editor-1', 'chat-2': 7 };
  assert.deepEqual(normalizeLayout(raw).bind, { terminal: 'editor-2' });
  raw.bind = 'nope';
  assert.equal(normalizeLayout(raw).bind, undefined);
});

test('a binding follows its view through a move and goes with its group or view', () => {
  const bound = setBinding(twoGroups(), 'chat', 'editor-2');
  const moved = ops.moveView(bound, 'chat', { edge: 'bottom' });
  assert.notEqual(moved, bound);
  assert.equal(bindingOf(moved, 'chat'), 'editor-2', 'the binding belongs to the view, not its stack');
  const removed = ops.removeEditorGroup(bound, 'editor-2');
  assert.equal(bindingOf(removed, 'chat'), '', 'removing the group drops its bindings');
  const grown = ops.addEditorGroup(bound, 'editor-2', 'down', undefined, 'editor-3');
  assert.equal(bindingOf(grown, 'chat'), 'editor-2', 'adding a group keeps bindings');
  const withTerm = setBinding(ops.addView(bound, 'terminal-2', 'terminal'), 'terminal-2', 'editor-2');
  assert.equal(bindingOf(ops.removeView(withTerm, 'terminal-2'), 'terminal-2'), '', 'a closed terminal loses its binding');
  assert.deepEqual(ops.pruneUnavailable(bound, () => true).bind, { chat: 'editor-2' }, 'the render copy carries bindings');
  assert.equal(unbindGroup(withTerm, 'editor-2').bind, undefined);
});
