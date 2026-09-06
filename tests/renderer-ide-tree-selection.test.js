'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const { createIdeTreeSelection } = require('../renderer/features/renderer-ide-tree-selection');
const { INTERNAL_FEATURE_FLAG_KEYS, buildFeatureFlags } = require('../services/feature-flags');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { buildIdeDom, createBridgeStub, settle } = require('./helpers/ide-tree-harness');

async function createHarness({ files = {}, dirs = [], expanded = [], activeTabPath = '', qol = true } = {}) {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files, dirs });
  const ide = ideStateUtils.createIdeUiState();
  const opened = [];
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
    confirmDelete: async () => true,
    onOpenFile: (path, options) => { opened.push({ path, options }); },
    onEntryRenamed: (...args) => { renamed.push(args); },
    onEntryDeleted: (...args) => { deleted.push(args); },
  });
  tree.bindEvents();
  tree.refreshRoot();
  await settle(30);
  return {
    ...domHarness,
    bridge,
    ide,
    tree,
    opened,
    renamed,
    deleted,
    panel: domHarness.getDom().ideRailPanel,
    dispose() {
      tree.dispose();
      domHarness.dom.window.close();
    },
  };
}

function clickRow(harness, path, options = {}) {
  const row = harness.panel.querySelector(`[data-ide-tree-path="${path}"]`);
  assert.ok(row, `missing tree row ${path}`);
  row.dispatchEvent(new harness.dom.window.MouseEvent('click', {
    bubbles: true,
    detail: 1,
    ...options,
  }));
}

function openContextMenu(harness, path) {
  const row = harness.panel.querySelector(`[data-ide-tree-path="${path}"]`);
  assert.ok(row, `missing tree row ${path}`);
  row.dispatchEvent(new harness.dom.window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 12,
    clientY: 24,
  }));
}

function findMenuItem(harness, label) {
  return [...harness.dom.window.document.querySelectorAll('.inv-context-menu-item')]
    .find((item) => item.textContent.includes(label)) || null;
}

test('flag off preserves legacy active-tab markup and ctrl-click behavior', async (t) => {
  assert.equal(buildFeatureFlags({}).workspace_explorer_qol, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_WORKSPACE_EXPLORER_QOL: '0' }).workspace_explorer_qol, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('workspace_explorer_qol'));
  const harness = await createHarness({ files: { 'active.js': 'a' }, activeTabPath: 'active.js', qol: false });
  t.after(() => harness.dispose());

  assert.equal(harness.panel.innerHTML.includes('ide-tree--qol'), false);
  assert.equal(harness.panel.innerHTML.includes('ide-tree-row--active'), false);
  assert.equal(harness.panel.innerHTML.includes('aria-multiselectable'), false);
  const activeRow = harness.panel.querySelector('[data-ide-tree-path="active.js"]');
  assert.ok(activeRow.classList.contains('ide-tree-row--selected'));
  assert.equal(activeRow.getAttribute('aria-selected'), 'true');
  assert.equal(activeRow.hasAttribute('aria-current'), false);

  clickRow(harness, 'active.js', { ctrlKey: true });
  assert.deepEqual(harness.opened, [{ path: 'active.js', options: { preview: true } }]);
  assert.equal(harness.tree.selection.size(), 0);
});

test('flag on ctrl-click toggles selection markup without opening files', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' } });
  t.after(() => harness.dispose());

  clickRow(harness, 'a.js', { ctrlKey: true });
  let row = harness.panel.querySelector('[data-ide-tree-path="a.js"]');
  assert.ok(row.classList.contains('ide-tree-row--selected'));
  assert.equal(row.getAttribute('aria-selected'), 'true');
  assert.deepEqual(harness.tree.selection.getPaths(), ['a.js']);

  clickRow(harness, 'a.js', { ctrlKey: true });
  row = harness.panel.querySelector('[data-ide-tree-path="a.js"]');
  assert.equal(row.classList.contains('ide-tree-row--selected'), false);
  assert.equal(row.hasAttribute('aria-selected'), false);
  assert.deepEqual(harness.opened, []);
});

test('flag on shift-click selects the inclusive rendered range without collapsed children', async (t) => {
  const harness = await createHarness({
    files: {
      'src/a.js': 'a',
      'src/collapsed/hidden.js': 'hidden',
      'src/z.js': 'z',
    },
    expanded: ['src'],
  });
  t.after(() => harness.dispose());

  assert.equal(harness.panel.querySelector('[data-ide-tree-path="src/collapsed/hidden.js"]'), null);
  clickRow(harness, 'src/collapsed', { ctrlKey: true });
  clickRow(harness, 'src/z.js', { shiftKey: true });

  assert.deepEqual(harness.tree.selection.getPaths(), [
    'src/collapsed',
    'src/a.js',
    'src/z.js',
  ]);
  assert.equal(harness.tree.selection.has('src/collapsed/hidden.js'), false);
  assert.deepEqual(harness.opened, []);
});

test('flag on plain file click replaces selection, opens preview, and keeps active state distinct', async (t) => {
  const harness = await createHarness({
    files: { 'active.js': 'a', 'other.js': 'b' },
    activeTabPath: 'active.js',
  });
  t.after(() => harness.dispose());

  clickRow(harness, 'other.js', { ctrlKey: true });
  clickRow(harness, 'active.js');

  assert.deepEqual(harness.tree.selection.getPaths(), ['active.js']);
  assert.deepEqual(harness.opened, [{ path: 'active.js', options: { preview: true } }]);
  const activeRow = harness.panel.querySelector('[data-ide-tree-path="active.js"]');
  assert.ok(activeRow.classList.contains('ide-tree-row--active'));
  assert.ok(activeRow.classList.contains('ide-tree-row--selected'));
  assert.equal(activeRow.getAttribute('aria-current'), 'true');
  assert.equal(activeRow.getAttribute('aria-selected'), 'true');
  assert.equal(harness.panel.querySelector('.ide-tree').getAttribute('aria-multiselectable'), 'true');
});

test('flag on directory ctrl-click selects without expanding while plain click selects and toggles', async (t) => {
  const harness = await createHarness({ files: { 'src/a.js': 'a' } });
  t.after(() => harness.dispose());

  clickRow(harness, 'src', { ctrlKey: true });
  assert.deepEqual(harness.tree.selection.getPaths(), ['src']);
  assert.equal(harness.ide.expandedDirs.has('src'), false);
  assert.equal(harness.panel.querySelector('[data-ide-tree-path="src/a.js"]'), null);

  clickRow(harness, 'src');
  await settle(20);
  assert.deepEqual(harness.tree.selection.getPaths(), ['src']);
  assert.equal(harness.ide.expandedDirs.has('src'), true);
  assert.ok(harness.panel.querySelector('[data-ide-tree-path="src/a.js"]'));
  assert.deepEqual(harness.opened, []);
});

test('resolveTargets falls back to focus only when selection is empty', () => {
  const selection = createIdeTreeSelection();
  assert.deepEqual(selection.resolveTargets('focused.js'), ['focused.js']);
  assert.deepEqual(selection.resolveTargets(''), []);
  selection.replace(['a.js', 'b.js'], 'a.js');
  assert.deepEqual(selection.resolveTargets('focused.js'), ['a.js', 'b.js']);
});

test('tree mutation wrappers remap renamed selections and drop deleted subtrees', async (t) => {
  const harness = await createHarness({
    files: { 'src/deep/a.js': 'a', 'src/b.js': 'b' },
    dirs: ['src', 'src/deep'],
  });
  t.after(() => harness.dispose());
  harness.tree.selection.replace(['src', 'src/deep/a.js'], 'src');

  openContextMenu(harness, 'src');
  const renameItem = findMenuItem(harness, 'Rename');
  assert.ok(renameItem);
  renameItem.click();
  const input = harness.panel.querySelector('[data-ide-tree-edit-control]');
  assert.ok(input);
  input.value = 'lib';
  input.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle(60);

  assert.deepEqual(harness.tree.selection.getPaths(), ['lib', 'lib/deep/a.js']);
  assert.equal(harness.renamed.length, 1);

  await harness.tree.deleteEntry('lib', 'directory');
  assert.deepEqual(harness.tree.selection.getPaths(), []);
  assert.equal(harness.deleted.length, 1);
});

test('refreshRoot and resetForRoot clear transient selection', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' } });
  t.after(() => harness.dispose());

  harness.tree.selection.replace(['a.js'], 'a.js');
  delete harness.bridge.state.files['a.js'];
  await harness.tree.handleExternalChanges([{ relPath: 'a.js', kind: 'deleted' }]);
  assert.equal(harness.tree.selection.size(), 0);

  harness.tree.selection.replace(['a.js'], 'a.js');
  harness.tree.refreshRoot();
  assert.equal(harness.tree.selection.size(), 0);
  await settle(20);

  harness.tree.selection.replace(['a.js'], 'a.js');
  harness.tree.resetForRoot();
  assert.equal(harness.tree.selection.size(), 0);
});
