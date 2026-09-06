'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { buildIdeDom, createBridgeStub, settle } = require('./helpers/ide-tree-harness');

async function createHarness({
  files = {}, dirs = [], expanded = [], qol = true, activeTabPath = '', confirmDeleteMany,
} = {}) {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files, dirs });
  const ide = ideStateUtils.createIdeUiState();
  const confirmations = [];
  const notifications = [];
  const renamed = [];
  const deleted = [];
  ide.expandedDirs = new Set(expanded);
  ide.activeTabPath = activeTabPath;
  const tree = createIdeTree({
    getDom: domHarness.getDom,
    getIde: () => ide,
    getMountEl: () => domHarness.getDom().ideRailPanel,
    isActivePanel: () => true,
    isQolEnabled: () => qol,
    getWorkspaceFsApi: () => bridge.jennyShell.workspaceFs,
    getMutationContext: async () => ({ rootId: 'root-test', generation: 1, phase: 'ready' }),
    preflightMutation: async () => ({ ready: true, paths: [] }),
    commitMutationPreflight: () => ({ committed: true }),
    cancelMutationPreflight: () => {},
    confirmDelete: async (path, kind) => {
      confirmations.push({ path, kind });
      return true;
    },
    ...(confirmDeleteMany ? { confirmDeleteMany } : {}),
    showError: (message, meta) => notifications.push({ message, meta }),
    onEntryRenamed: (...args) => renamed.push(args),
    onEntryDeleted: (...args) => deleted.push(args),
  });
  tree.bindEvents();
  tree.refreshRoot();
  await settle(30);
  return {
    ...domHarness,
    bridge,
    ide,
    tree,
    confirmations,
    notifications,
    renamed,
    deleted,
    panel: domHarness.getDom().ideRailPanel,
    dispose() {
      tree.dispose();
      domHarness.dom.window.close();
    },
  };
}

function getRow(harness, path) {
  const row = harness.panel.querySelector(`[data-ide-tree-path="${path}"]`);
  assert.ok(row, `missing tree row ${path}`);
  return row;
}

function pressKey(harness, target, key, options = {}) {
  const event = new harness.dom.window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  return event;
}

function selectRow(harness, path) {
  getRow(harness, path).dispatchEvent(new harness.dom.window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
  }));
}

test('flag off ignores new keys while preserving legacy ArrowDown focus movement', async (t) => {
  const harness = await createHarness({ files: { 'alpha.js': 'a', 'beta.js': 'b' }, qol: false });
  t.after(() => harness.dispose());
  const alpha = getRow(harness, 'alpha.js');
  alpha.focus();

  pressKey(harness, alpha, 'F2');
  pressKey(harness, alpha, 'Delete');
  pressKey(harness, alpha, 'b');

  assert.equal(harness.panel.querySelector('[data-ide-tree-edit-control]'), null);
  assert.deepEqual(harness.confirmations, []);
  assert.deepEqual(harness.bridge.calls.delete, []);
  assert.equal(harness.dom.window.document.activeElement.dataset.ideTreePath, 'alpha.js');

  pressKey(harness, alpha, 'ArrowDown');
  assert.equal(harness.dom.window.document.activeElement.dataset.ideTreePath, 'beta.js');
});

test('F2 preselects file stems while dotfiles and directories select their whole names', async (t) => {
  const cases = [
    { files: { 'budget_2026.xlsx': 'x' }, path: 'budget_2026.xlsx', end: 'budget_2026'.length },
    { files: { '.env': 'x' }, path: '.env', end: '.env'.length },
    { dirs: ['reports.2026'], path: 'reports.2026', end: 'reports.2026'.length },
  ];
  for (const entry of cases) {
    const harness = await createHarness(entry);
    t.after(() => harness.dispose());
    selectRow(harness, entry.path);
    pressKey(harness, getRow(harness, entry.path), 'F2');
    const input = harness.panel.querySelector('[data-ide-tree-edit-control]');
    assert.ok(input);
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, entry.end);
  }
});

test('F2 refuses a multi-selection with the keyboard toast', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a', 'b.js': 'b' } });
  t.after(() => harness.dispose());
  selectRow(harness, 'a.js');
  selectRow(harness, 'b.js');

  pressKey(harness, getRow(harness, 'b.js'), 'F2');

  assert.equal(harness.panel.querySelector('[data-ide-tree-edit-control]'), null);
  assert.deepEqual(harness.notifications, [{
    message: 'Rename one item at a time.',
    meta: { title: 'Workspace', dedupeKey: 'ide:tree:kbd' },
  }]);
});

test('Delete handles one focused row and fallback multi-delete confirms each target', async (t) => {
  const single = await createHarness({ files: { 'only.js': 'x' } });
  t.after(() => single.dispose());
  const only = getRow(single, 'only.js');
  only.focus();
  pressKey(single, only, 'Delete');
  await settle(60);

  assert.equal(single.confirmations.length, 1);
  assert.deepEqual(single.bridge.calls.delete, [{ path: 'only.js', expectedGeneration: 1 }]);
  assert.equal(single.panel.querySelector('[data-ide-tree-path="only.js"]'), null);

  const multi = await createHarness({ files: { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' } });
  t.after(() => multi.dispose());
  for (const path of ['a.js', 'b.js', 'c.js']) selectRow(multi, path);
  pressKey(multi, getRow(multi, 'c.js'), 'Delete');
  await settle(100);

  assert.equal(multi.confirmations.length, 3);
  assert.equal(multi.bridge.calls.delete.length, 3);
  assert.equal(multi.panel.querySelectorAll('[data-ide-tree-path]').length, 0);
});

test('type-ahead accumulates, wraps after idle reset, and ignores inline editing', async (t) => {
  const harness = await createHarness({
    files: { 'alpha.js': 'a', 'beta.js': 'b', 'bravo.md': 'c' },
  });
  t.after(() => harness.dispose());
  const alpha = getRow(harness, 'alpha.js');
  alpha.focus();

  pressKey(harness, alpha, 'b');
  pressKey(harness, harness.dom.window.document.activeElement, 'r');
  assert.equal(harness.dom.window.document.activeElement.dataset.ideTreePath, 'bravo.md');

  await settle(720);
  pressKey(harness, harness.dom.window.document.activeElement, 'a');
  assert.equal(harness.dom.window.document.activeElement.dataset.ideTreePath, 'alpha.js');

  harness.tree.selection.replace(['bravo.md'], 'bravo.md');
  pressKey(harness, getRow(harness, 'bravo.md'), 'F2');
  const input = harness.panel.querySelector('[data-ide-tree-edit-control]');
  pressKey(harness, input, 'a');
  assert.equal(harness.dom.window.document.activeElement, input);
});

test('plain ArrowRight selects its expanded directory child before Delete', async (t) => {
  const harness = await createHarness({
    files: { 'src/child.js': 'child', 'stale.js': 'stale' }, dirs: ['src'], expanded: ['src'],
  });
  t.after(() => harness.dispose());
  harness.tree.selection.replace(['src', 'stale.js'], 'src');
  const directory = getRow(harness, 'src');
  directory.focus();

  pressKey(harness, directory, 'ArrowRight');
  const child = harness.dom.window.document.activeElement;
  assert.equal(child.dataset.ideTreePath, 'src/child.js');
  assert.deepEqual(harness.tree.selection.getPaths(), ['src/child.js']);
  pressKey(harness, child, 'Delete');
  await settle(60);
  assert.deepEqual(harness.bridge.calls.delete, [{ path: 'src/child.js', expectedGeneration: 1 }]);
});

test('plain ArrowLeft selects the parent before Delete', async (t) => {
  const harness = await createHarness({
    files: { 'src/child.js': 'child', 'stale.js': 'stale' }, dirs: ['src'], expanded: ['src'],
  });
  t.after(() => harness.dispose());
  harness.tree.selection.replace(['src/child.js', 'stale.js'], 'src/child.js');
  const child = getRow(harness, 'src/child.js');
  child.focus();

  pressKey(harness, child, 'ArrowLeft');
  const parent = harness.dom.window.document.activeElement;
  assert.equal(parent.dataset.ideTreePath, 'src');
  assert.deepEqual(harness.tree.selection.getPaths(), ['src']);
  pressKey(harness, parent, 'Delete');
  await settle(60);
  assert.deepEqual(harness.bridge.calls.delete, [{ path: 'src', expectedGeneration: 1 }]);
});

test('type-ahead selects its focus match before Delete', async (t) => {
  const harness = await createHarness({
    files: { 'alpha.js': 'a', 'beta.js': 'b', 'stale.js': 'stale' },
  });
  t.after(() => harness.dispose());
  harness.tree.selection.replace(['alpha.js', 'stale.js'], 'alpha.js');
  const alpha = getRow(harness, 'alpha.js');
  alpha.focus();

  pressKey(harness, alpha, 'b');
  const beta = harness.dom.window.document.activeElement;
  assert.equal(beta.dataset.ideTreePath, 'beta.js');
  assert.deepEqual(harness.tree.selection.getPaths(), ['beta.js']);
  pressKey(harness, beta, 'Delete');
  await settle(60);
  assert.deepEqual(harness.bridge.calls.delete, [{ path: 'beta.js', expectedGeneration: 1 }]);
});

test('multi-delete confirmation bails when the root epoch changes', async (t) => {
  let harness;
  harness = await createHarness({
    files: { 'a.js': 'a', 'b.js': 'b' },
    confirmDeleteMany: async () => {
      harness.tree.refreshRoot();
      return true;
    },
  });
  t.after(() => harness.dispose());
  harness.tree.selection.replace(['a.js', 'b.js'], 'a.js');

  pressKey(harness, getRow(harness, 'a.js'), 'Delete');
  await settle(60);

  assert.deepEqual(harness.bridge.calls.delete, []);
});

test('Ctrl+A selects all rendered rows and Escape collapses to the focused row', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' } });
  t.after(() => harness.dispose());
  const first = getRow(harness, 'a.js');
  first.focus();

  pressKey(harness, first, 'a', { ctrlKey: true });
  assert.deepEqual(harness.tree.selection.getPaths(), ['a.js', 'b.js', 'c.js']);

  pressKey(harness, harness.dom.window.document.activeElement, 'Escape');
  assert.deepEqual(harness.tree.selection.getPaths(), ['a.js']);
});

test('Shift+ArrowDown extends selection through the adjacent rendered row', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' } });
  t.after(() => harness.dispose());
  selectRow(harness, 'a.js');
  const first = getRow(harness, 'a.js');
  first.focus();

  pressKey(harness, first, 'ArrowDown', { shiftKey: true });

  assert.deepEqual(harness.tree.selection.getPaths(), ['a.js', 'b.js']);
  assert.equal(harness.dom.window.document.activeElement.dataset.ideTreePath, 'b.js');
});

test('plain ArrowDown moves focus and replaces a disjoint selection', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' } });
  t.after(() => harness.dispose());
  selectRow(harness, 'a.js');
  selectRow(harness, 'c.js');
  const first = getRow(harness, 'a.js');
  first.focus();

  pressKey(harness, first, 'ArrowDown');

  assert.equal(harness.dom.window.document.activeElement.dataset.ideTreePath, 'b.js');
  assert.deepEqual(harness.tree.selection.getPaths(), ['b.js']);
});

test('Ctrl+ArrowDown moves focus without changing selection', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' } });
  t.after(() => harness.dispose());
  selectRow(harness, 'a.js');
  selectRow(harness, 'c.js');
  const first = getRow(harness, 'a.js');
  first.focus();

  pressKey(harness, first, 'ArrowDown', { ctrlKey: true });

  assert.equal(harness.dom.window.document.activeElement.dataset.ideTreePath, 'b.js');
  assert.deepEqual(harness.tree.selection.getPaths(), ['a.js', 'c.js']);
});

test('Shift+ArrowDown seeds a focused but unselected origin row', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' } });
  t.after(() => harness.dispose());
  selectRow(harness, 'a.js');
  selectRow(harness, 'c.js');
  const middle = getRow(harness, 'b.js');
  middle.focus();

  pressKey(harness, middle, 'ArrowDown', { shiftKey: true });

  assert.equal(harness.dom.window.document.activeElement.dataset.ideTreePath, 'c.js');
  assert.deepEqual(harness.tree.selection.getPaths(), ['b.js', 'c.js']);
});

test('Delete rejects a fully unrendered selection and collapses it to focus', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a', 'b.js': 'b' } });
  t.after(() => harness.dispose());
  const first = getRow(harness, 'a.js');
  first.focus();
  harness.tree.selection.replace(['hidden/missing.js'], 'hidden/missing.js');

  pressKey(harness, first, 'Delete');

  assert.deepEqual(harness.bridge.calls.delete, []);
  assert.deepEqual(harness.notifications, [{
    message: 'The selected items are no longer visible in the tree.',
    meta: { title: 'Workspace', dedupeKey: 'ide:tree:kbd' },
  }]);
  assert.deepEqual(harness.tree.selection.getPaths(), ['a.js']);
});

test('flag off leaves selection untouched when plain ArrowDown moves focus', async (t) => {
  const harness = await createHarness({
    files: { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' }, qol: false,
  });
  t.after(() => harness.dispose());
  harness.tree.selection.replace(['c.js'], 'c.js');
  const first = getRow(harness, 'a.js');
  first.focus();

  pressKey(harness, first, 'ArrowDown');

  assert.equal(harness.dom.window.document.activeElement.dataset.ideTreePath, 'b.js');
  assert.deepEqual(harness.tree.selection.getPaths(), ['c.js']);
});

test('roving focus falls back to the active row before a selected row', async (t) => {
  const harness = await createHarness({
    files: { 'a.js': 'a', 'b.js': 'b' }, activeTabPath: 'b.js',
  });
  t.after(() => harness.dispose());

  assert.equal(getRow(harness, 'a.js').tabIndex, -1);
  assert.equal(getRow(harness, 'b.js').tabIndex, 0);
});

test('truncated external changes clear QoL selection membership', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a', 'b.js': 'b' } });
  t.after(() => harness.dispose());
  harness.tree.selection.replace(['a.js', 'b.js'], 'a.js');

  await harness.tree.handleExternalChanges([], { truncated: true });

  assert.deepEqual(harness.tree.selection.getPaths(), []);
});
