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
  return [...harness.getDom().ideRailPanel.querySelectorAll('[data-ide-tree-path]')];
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

  // Directories list first: rows are [src, a.txt]; exactly one is tabbable.
  let rows = treeRows(harness);
  assert.deepEqual(rows.map((row) => row.dataset.ideTreePath), ['src', 'a.txt']);
  assert.deepEqual(rows.map((row) => row.tabIndex), [0, -1]);

  rows[0].focus();
  pressKey(harness, rows[0], 'ArrowDown');
  assert.equal(activeElement(harness), rows[1]);
  assert.deepEqual(rows.map((row) => row.tabIndex), [-1, 0]);

  pressKey(harness, rows[1], 'ArrowUp');
  assert.equal(activeElement(harness), rows[0]);

  // ArrowRight on a collapsed dir expands it; focus survives the re-render.
  pressKey(harness, rows[0], 'ArrowRight');
  await settle();
  rows = treeRows(harness);
  assert.deepEqual(
    rows.map((row) => row.dataset.ideTreePath),
    ['src', 'src/app.js', 'src/lib.js', 'a.txt']
  );
  assert.equal(harness.state.ui.ide.expandedDirs.has('src'), true);
  assert.equal(activeElement(harness)?.dataset?.ideTreePath, 'src');

  // ArrowRight on an expanded dir steps into the first child.
  pressKey(harness, rows[0], 'ArrowRight');
  assert.equal(activeElement(harness), rows[1]);

  // ArrowLeft from a child jumps back to the parent directory row.
  pressKey(harness, rows[1], 'ArrowLeft');
  assert.equal(activeElement(harness), rows[0]);

  // Home / End hit the boundaries.
  pressKey(harness, rows[0], 'End');
  assert.equal(activeElement(harness), rows[rows.length - 1]);
  pressKey(harness, rows[rows.length - 1], 'Home');
  assert.equal(activeElement(harness), rows[0]);

  // ArrowLeft on the expanded dir collapses it.
  pressKey(harness, rows[0], 'ArrowLeft');
  await settle();
  rows = treeRows(harness);
  assert.deepEqual(rows.map((row) => row.dataset.ideTreePath), ['src', 'a.txt']);
  assert.equal(harness.state.ui.ide.expandedDirs.has('src'), false);
  assert.equal(activeElement(harness)?.dataset?.ideTreePath, 'src');

  // Enter on a file row opens it in a tab and keeps tree focus usable.
  pressKey(harness, rows[1], 'ArrowDown');
  pressKey(harness, treeRows(harness)[1], 'Enter');
  await settle();
  const strip = harness.getDom().ideTabStrip;
  assert.ok(strip.querySelector('[data-ide-tab-path="a.txt"]'));
  assert.equal(activeElement(harness)?.dataset?.ideTreePath, 'a.txt');
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
    'Choose a workspace folder to start editing files.'
  );
  const emptyAction = dom.ideEmptyStateAction.querySelector('[data-ide-choose-root]');
  assert.ok(emptyAction, 'expected the empty-state Choose Folder button');
  assert.equal(dom.ideEmptyStateAction.classList.contains('hidden'), false);

  const treeAction = dom.ideRailPanel.querySelector('[data-ide-tree-choose-root]');
  assert.ok(treeAction, 'expected the tree Choose Folder button');
  assert.match(dom.ideRailPanel.textContent, /Choose a workspace folder to browse and edit files\./);

  // The first watcher start failed (no root); the chooser re-arms it below.
  assert.equal(harness.bridge.calls.watchStart.length, 1);

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
  assert.equal(harness.bridge.calls.watchStart.length, 2);
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
  assert.ok(dom.ideRailPanel.querySelector('[data-ide-tree-choose-root]'));
});
