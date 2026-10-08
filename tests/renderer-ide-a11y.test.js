'use strict';

/* W6 a11y/keyboard pass: WAI-ARIA tree keyboard navigation (roving tabindex,
 * arrows, Enter/Space activation), tab-strip arrow navigation, and the
 * no-workspace-root empty states with their "Choose Folder" actions wired to
 * workspaceRoot.prepareChoose. Runs on the shared IDE harness (fallback editor). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createHarness,
  pressKey,
  settle,
} = require('./helpers/renderer-ide-harness');

function treeRows(harness) {
  return [...harness.viewHost('explorer').querySelectorAll('[data-ide-tree-path]')];
}

function activeElement(harness) {
  return harness.dom.window.document.activeElement;
}

test('tree keyboard nav: roving tabindex, arrows, expand/collapse, Enter opens', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'a.txt': 'x', 'src/app.js': 'y', 'src/lib.js': 'z' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  // Arrow keys also move the selection, which re-renders the rows: look the
  // row up by path each time instead of holding element references.
  const rowFor = (path) => treeRows(harness).find((row) => row.dataset.ideTreePath === path);
  const focusedPath = () => activeElement(harness)?.dataset?.ideTreePath;
  const tabStops = () => treeRows(harness).map((row) => row.tabIndex);

  // Directories list first: rows are [src, a.txt]; exactly one is tabbable.
  let rows = treeRows(harness);
  assert.deepEqual(rows.map((row) => row.dataset.ideTreePath), ['src', 'a.txt']);
  assert.deepEqual(tabStops(), [0, -1]);

  rowFor('src').focus();
  pressKey(harness, rowFor('src'), 'ArrowDown');
  assert.equal(focusedPath(), 'a.txt');
  assert.deepEqual(tabStops(), [-1, 0]);

  pressKey(harness, rowFor('a.txt'), 'ArrowUp');
  assert.equal(focusedPath(), 'src');

  // ArrowRight on a collapsed dir expands it; focus survives the re-render.
  pressKey(harness, rowFor('src'), 'ArrowRight');
  await settle();
  rows = treeRows(harness);
  assert.deepEqual(
    rows.map((row) => row.dataset.ideTreePath),
    ['src', 'src/app.js', 'src/lib.js', 'a.txt']
  );
  assert.equal(harness.state.ui.ide.expandedDirs.has('src'), true);
  assert.equal(focusedPath(), 'src');

  // ArrowRight on an expanded dir steps into the first child.
  pressKey(harness, rowFor('src'), 'ArrowRight');
  assert.equal(focusedPath(), 'src/app.js');

  // ArrowLeft from a child jumps back to the parent directory row.
  pressKey(harness, rowFor('src/app.js'), 'ArrowLeft');
  assert.equal(focusedPath(), 'src');

  // Home / End hit the boundaries.
  pressKey(harness, rowFor('src'), 'End');
  assert.equal(focusedPath(), 'a.txt');
  pressKey(harness, rowFor('a.txt'), 'Home');
  assert.equal(focusedPath(), 'src');

  // ArrowLeft on the expanded dir collapses it.
  pressKey(harness, rowFor('src'), 'ArrowLeft');
  await settle();
  rows = treeRows(harness);
  assert.deepEqual(rows.map((row) => row.dataset.ideTreePath), ['src', 'a.txt']);
  assert.equal(harness.state.ui.ide.expandedDirs.has('src'), false);
  assert.equal(focusedPath(), 'src');

  // Enter on a file row opens it in a tab and keeps tree focus usable.
  pressKey(harness, rowFor('src'), 'ArrowDown');
  pressKey(harness, rowFor('a.txt'), 'Enter');
  await settle();
  const strip = harness.getDom().ideTabStrip;
  assert.ok(strip.querySelector('[data-ide-tab-path="a.txt"]'));
  assert.equal(focusedPath(), 'a.txt');
});

test('tab strip keyboard nav: arrows rove focus across real tab buttons', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'a.txt': 'x', 'b.txt': 'y', 'c.txt': 'z' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  await harness.controller.openFile('a.txt');
  await harness.controller.openFile('b.txt');
  await harness.controller.openFile('c.txt');
  await settle();

  const strip = harness.getDom().ideTabStrip;
  const tabs = [...strip.querySelectorAll('[data-ide-tab-path]')];
  assert.equal(tabs.length, 3);

  tabs[0].focus();
  pressKey(harness, tabs[0], 'ArrowRight');
  assert.equal(activeElement(harness), tabs[1]);
  pressKey(harness, tabs[1], 'ArrowRight');
  assert.equal(activeElement(harness), tabs[2]);
  // Wrap-around in both directions.
  pressKey(harness, tabs[2], 'ArrowRight');
  assert.equal(activeElement(harness), tabs[0]);
  pressKey(harness, tabs[0], 'ArrowLeft');
  assert.equal(activeElement(harness), tabs[2]);
  pressKey(harness, tabs[2], 'Home');
  assert.equal(activeElement(harness), tabs[0]);
  pressKey(harness, tabs[0], 'End');
  assert.equal(activeElement(harness), tabs[2]);
});

test('no workspace root: empty state and tree both offer Choose Folder', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: '', files: { 'a.txt': 'hello' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const dom = harness.getDom();
  assert.equal(
    dom.ideEmptyStateCopy.textContent,
    'Pick a folder and Jenny makes it a project: file tools work inside it and new chats start there.'
  );
  const emptyAction = dom.ideEmptyStateAction.querySelector('[data-ide-choose-root]');
  assert.ok(emptyAction, 'expected the empty-state Choose Folder button');
  assert.equal(dom.ideEmptyStateAction.classList.contains('hidden'), false);

  const treeAction = harness.viewHost('explorer').querySelector('[data-ide-tree-choose-root]');
  assert.ok(treeAction, 'expected the tree Choose Folder button');
  assert.match(harness.viewHost('explorer').textContent, /No folder open/);

  // No root: the watcher never starts; the chooser arms it below.
  assert.equal(harness.bridge.calls.watchStart.length, 0);

  treeAction.click();
  await settle();
  const context = await harness.bridge.jennyShell.workspaceRoot.captureContext();
  harness.state.workspaceRoot = context;
  await harness.controller.handleWorkspaceRootCommitted({ context });
  await settle();

  assert.equal(harness.bridge.calls.chooseRoot.length, 1);
  // Tree re-listed from the new root and the explorer shows real rows now.
  const rows = treeRows(harness);
  assert.deepEqual(rows.map((row) => row.dataset.ideTreePath), ['a.txt']);
  // Empty state flipped to the configured-root copy and dropped its action.
  const refreshedCopy = harness.dom.window.document.getElementById('ideEmptyStateCopy');
  const refreshedAction = harness.dom.window.document.getElementById('ideEmptyStateAction');
  assert.match(refreshedCopy.textContent, /Open a file from the explorer/);
  assert.equal(refreshedAction.classList.contains('hidden'), true);
  // Watcher re-armed against the configured root.
  assert.equal(harness.bridge.calls.watchStart.length, 1);
});

test('cancelled Choose Folder dialog leaves the no-root state untouched', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: '', chooseRootResult: null, files: { 'a.txt': 'hello' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const dom = harness.getDom();
  const listCallsBefore = harness.bridge.calls.listDirectory.length;
  dom.ideEmptyStateAction.querySelector('[data-ide-choose-root]').click();
  await settle();

  assert.equal(harness.bridge.calls.chooseRoot.length, 1);
  // No refresh happened: same listing count, action still offered.
  assert.equal(harness.bridge.calls.listDirectory.length, listCallsBefore);
  assert.ok(dom.ideEmptyStateAction.querySelector('[data-ide-choose-root]'));
  assert.ok(harness.viewHost('explorer').querySelector('[data-ide-tree-choose-root]'));
});
