'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeClosedTabsStack } = require('../renderer/features/renderer-ide-closed-tabs');
const { createHarness, settle } = require('./helpers/renderer-ide-harness');

function ctrlKey(harness, key, init = {}) {
  harness.getDom().ideView.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  }));
}

// ── Pure stack ──────────────────────────────────────────────────────────────

test('closed-tabs stack pops most-recent first (LIFO)', () => {
  const stack = createIdeClosedTabsStack();
  stack.push({ path: 'a.js', viewState: { v: 1 } });
  stack.push({ path: 'b.js', viewState: { v: 2 } });
  assert.deepEqual(stack.pop(), { path: 'b.js', viewState: { v: 2 } });
  assert.deepEqual(stack.pop(), { path: 'a.js', viewState: { v: 1 } });
  assert.equal(stack.pop(), null);
});

test('closed-tabs stack is bounded and drops the oldest entry', () => {
  const stack = createIdeClosedTabsStack({ limit: 3 });
  for (const path of ['a', 'b', 'c', 'd']) {
    stack.push({ path });
  }
  assert.equal(stack.pop().path, 'd');
  assert.equal(stack.pop().path, 'c');
  assert.equal(stack.pop().path, 'b'); // 'a' was evicted
  assert.equal(stack.pop(), null);
});

test('closed-tabs stack de-dupes a re-closed path to the top with newest state', () => {
  const stack = createIdeClosedTabsStack();
  stack.push({ path: 'a.js', viewState: { v: 1 } });
  stack.push({ path: 'b.js' });
  stack.push({ path: 'a.js', viewState: { v: 2 } });
  assert.deepEqual(stack.pop(), { path: 'a.js', viewState: { v: 2 } });
  assert.deepEqual(stack.pop(), { path: 'b.js', viewState: null });
  assert.equal(stack.pop(), null);
});

test('closed-tabs stack dropUnder removes a path and its descendants', () => {
  const stack = createIdeClosedTabsStack();
  stack.push({ path: 'src/a.js' });
  stack.push({ path: 'src/nested/b.js' });
  stack.push({ path: 'other.js' });
  stack.dropUnder('src');
  assert.equal(stack.pop().path, 'other.js');
  assert.equal(stack.pop(), null);
});

test('closed-tabs stack ignores blank pushes', () => {
  const stack = createIdeClosedTabsStack();
  stack.push({ path: '' });
  stack.push({});
  stack.push(null);
  assert.equal(stack.pop(), null);
});

// ── Controller integration (jsdom; Monaco stubbed -> fallback path) ──────────

test('Ctrl+Shift+T reopens closed tabs most-recent first', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'one', 'b.js': 'two' } },
  });
  t.after(() => harness.dispose());

  await harness.controller.activateIde();
  await settle();
  await harness.controller.openFile('a.js');
  await harness.controller.openFile('b.js');
  await settle();

  // Close b (active) then a -> stack = [b, a].
  ctrlKey(harness, 'F4');
  await settle();
  ctrlKey(harness, 'F4');
  await settle();
  assert.equal(harness.state.ui.ide.openTabs.length, 0);

  // Reopen pops 'a' (last closed) first, then 'b'.
  ctrlKey(harness, 't', { shiftKey: true });
  await settle();
  assert.equal(harness.state.ui.ide.activeTabPath, 'a.js');

  ctrlKey(harness, 't', { shiftKey: true });
  await settle();
  assert.equal(harness.state.ui.ide.activeTabPath, 'b.js');

  // Stack exhausted -> no further reopen.
  const openCount = harness.state.ui.ide.openTabs.length;
  ctrlKey(harness, 't', { shiftKey: true });
  await settle();
  assert.equal(harness.state.ui.ide.openTabs.length, openCount);
});

test('a file deleted on disk is NOT recorded for reopen', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'one' } },
  });
  t.after(() => harness.dispose());

  await harness.controller.activateIde();
  await settle();
  await harness.controller.openFile('a.js');
  await settle();
  assert.equal(harness.state.ui.ide.activeTabPath, 'a.js');

  // External delete (clean buffer) closes the tab via the watcher reconcile.
  harness.bridge.emitChange({ changes: [{ kind: 'deleted', relPath: 'a.js' }] });
  await settle();
  assert.equal(harness.state.ui.ide.openTabs.length, 0);

  // Ctrl+Shift+T must not resurrect the deleted file.
  ctrlKey(harness, 't', { shiftKey: true });
  await settle();
  assert.equal(harness.state.ui.ide.openTabs.length, 0);
});
