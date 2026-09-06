'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const { createIdeTreeClipboard } = require('../renderer/features/renderer-ide-tree-clipboard');
const treeMarkup = require('../renderer/features/renderer-ide-tree-markup');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { buildIdeDom, createBridgeStub, settle } = require('./helpers/ide-tree-harness');

function row(harness, path) {
  const result = harness.panel.querySelector(`[data-ide-tree-path="${path}"]`);
  assert.ok(result, `missing tree row ${path}`);
  return result;
}

function pressShortcut(harness, target, key) {
  const event = new harness.dom.window.KeyboardEvent('keydown', {
    key,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function openContextMenu(harness, target) {
  const event = new harness.dom.window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 10,
    clientY: 10,
  });
  target.dispatchEvent(event);
  return event;
}

function menuItems(harness) {
  return [...harness.dom.window.document.querySelectorAll('.inv-context-menu-item')]
    .map((item) => ({
      label: item.firstElementChild?.textContent || '',
      hint: item.querySelector('.inv-context-menu-shortcut')?.textContent || '',
    }));
}

async function createHarness({
  files = {}, dirs = [], expanded = [], qol = true,
  preflightMutation = async () => ({ ready: true, paths: [] }),
} = {}) {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files, dirs });
  bridge.calls.copyEntry = [];
  bridge.jennyShell.workspaceFs.copyEntry = async (payload) => {
    bridge.calls.copyEntry.push(payload);
    return { ...payload, kind: 'file', renamed: false };
  };
  const ide = ideStateUtils.createIdeUiState();
  ide.expandedDirs = new Set(expanded);
  const errors = [];
  const tree = createIdeTree({
    getDom: domHarness.getDom,
    getIde: () => ide,
    getMountEl: () => domHarness.getDom().ideRailPanel,
    isActivePanel: () => true,
    isQolEnabled: () => qol,
    getWorkspaceFsApi: () => bridge.jennyShell.workspaceFs,
    getMutationContext: async () => ({ rootId: 'root-test', generation: 1, phase: 'ready' }),
    preflightMutation,
    commitMutationPreflight: () => ({ committed: true }),
    cancelMutationPreflight: () => {},
    showError: (message, meta) => errors.push({ message, meta }),
  });
  tree.bindEvents();
  tree.refreshRoot();
  await settle(40);
  return {
    ...domHarness,
    bridge,
    errors,
    ide,
    tree,
    panel: domHarness.getDom().ideRailPanel,
    dispose() {
      tree.dispose();
      domHarness.dom.window.close();
    },
  };
}

test('flag off leaves clipboard shortcuts, state, calls, and markup inert', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' }, qol: false });
  t.after(() => harness.dispose());

  for (const key of ['c', 'x', 'v', 'd']) {
    const event = pressShortcut(harness, row(harness, 'a.js'), key);
    assert.equal(event.defaultPrevented, false);
  }

  assert.equal(harness.tree.clipboard.hasContent(), false);
  assert.deepEqual(harness.bridge.calls.copyEntry, []);
  assert.deepEqual(harness.bridge.calls.rename, []);
  assert.equal(harness.panel.querySelector('.ide-tree-row--cut'), null);
});

test('copy pastes two selected files into the focused directory and survives reuse', async (t) => {
  const harness = await createHarness({
    files: { 'a.js': 'a', 'b.js': 'b' },
    dirs: ['dst'],
  });
  t.after(() => harness.dispose());
  row(harness, 'dst').click();
  await settle(30);
  harness.tree.selection.replace(['a.js', 'b.js'], 'a.js');
  harness.tree.syncSelection();

  pressShortcut(harness, row(harness, 'dst'), 'C');
  pressShortcut(harness, row(harness, 'dst'), 'v');
  await settle(80);

  const expected = [
    { from: 'a.js', to: 'dst/a.js', onCollision: 'auto-rename', expectedGeneration: 1 },
    { from: 'b.js', to: 'dst/b.js', onCollision: 'auto-rename', expectedGeneration: 1 },
  ];
  assert.deepEqual(harness.bridge.calls.copyEntry, expected);
  assert.equal(harness.tree.clipboard.hasContent(), true);

  pressShortcut(harness, row(harness, 'dst'), 'v');
  await settle(80);
  assert.deepEqual(harness.bridge.calls.copyEntry, [...expected, ...expected]);
  assert.equal(harness.tree.clipboard.hasContent(), true);
});

test('cut dims a row, moves it once, then clears state and dimming', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' }, dirs: ['dst'] });
  t.after(() => harness.dispose());
  row(harness, 'a.js').click();
  pressShortcut(harness, row(harness, 'a.js'), 'x');

  assert.equal(row(harness, 'a.js').classList.contains('ide-tree-row--cut'), true);
  row(harness, 'dst').click();
  pressShortcut(harness, row(harness, 'dst'), 'v');
  await settle(120);

  assert.deepEqual(harness.bridge.calls.rename, [
    { from: 'a.js', to: 'dst/a.js', expectedGeneration: 1 },
  ]);
  assert.equal(harness.tree.clipboard.hasContent(), false);
  assert.equal(harness.panel.querySelector('.ide-tree-row--cut'), null);
});

test('cut paste into the existing parent notifies without moving and retains state', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' } });
  t.after(() => harness.dispose());
  row(harness, 'a.js').click();
  pressShortcut(harness, row(harness, 'a.js'), 'x');
  pressShortcut(harness, row(harness, 'a.js'), 'v');
  await settle(30);

  assert.deepEqual(harness.bridge.calls.rename, []);
  assert.equal(harness.errors.at(-1).message, 'Items are already here.');
  assert.equal(harness.tree.clipboard.hasContent(), true);
  assert.equal(row(harness, 'a.js').classList.contains('ide-tree-row--cut'), true);
});

test('zero-success cut paste retains clipboard content and cut dimming', async (t) => {
  const harness = await createHarness({
    files: { 'a.js': 'a' },
    dirs: ['dst'],
    preflightMutation: async () => ({ ready: false, reason: 'cancelled', paths: [] }),
  });
  t.after(() => harness.dispose());
  row(harness, 'a.js').click();
  pressShortcut(harness, row(harness, 'a.js'), 'x');
  row(harness, 'dst').click();
  pressShortcut(harness, row(harness, 'dst'), 'v');
  await settle(80);

  assert.deepEqual(harness.bridge.calls.rename, []);
  assert.equal(harness.tree.clipboard.hasContent(), true);
  assert.equal(row(harness, 'a.js').classList.contains('ide-tree-row--cut'), true);
});

test('an unrendered focused path pastes into its parent instead of the workspace root', async () => {
  const copies = [];
  const refreshes = [];
  const clipboard = createIdeTreeClipboard({
    selection: { resolveTargets: () => ['source.txt'] },
    getFocusedPath: () => 'collapsed/hidden.txt',
    getRootEpoch: () => 1,
    getRenderedRows: () => [],
    getApi: () => ({ copyEntry: async (payload) => { copies.push(payload); } }),
    getMutationContext: async () => ({ generation: 4 }),
    refreshDirectory: async (path) => { refreshes.push(path); },
    parentDirOf: treeMarkup.parentDirOf,
    nameOf: treeMarkup.nameOf,
    isQolEnabled: () => true,
  });
  clipboard.copy();

  await clipboard.paste();

  assert.deepEqual(copies, [{
    from: 'source.txt', to: 'collapsed/source.txt',
    onCollision: 'auto-rename', expectedGeneration: 4,
  }]);
  assert.deepEqual(refreshes, ['collapsed']);
});

test('duplicate copies a selected file in place without changing clipboard state', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a', 'held.js': 'held' } });
  t.after(() => harness.dispose());
  row(harness, 'held.js').click();
  pressShortcut(harness, row(harness, 'held.js'), 'c');
  row(harness, 'a.js').click();
  pressShortcut(harness, row(harness, 'a.js'), 'd');
  await settle(60);

  assert.deepEqual(harness.bridge.calls.copyEntry, [{
    from: 'a.js', to: 'a.js', onCollision: 'auto-rename', expectedGeneration: 1,
  }]);
  assert.equal(harness.tree.clipboard.hasContent(), true);
});

test('refreshRoot clears cut state so a later paste is a no-op', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' }, dirs: ['dst'] });
  t.after(() => harness.dispose());
  row(harness, 'a.js').click();
  pressShortcut(harness, row(harness, 'a.js'), 'x');
  harness.tree.refreshRoot();
  await settle(50);
  pressShortcut(harness, row(harness, 'dst'), 'v');
  await settle(30);

  assert.deepEqual(harness.bridge.calls.rename, []);
  assert.deepEqual(harness.bridge.calls.copyEntry, []);
  assert.equal(harness.tree.clipboard.hasContent(), false);
  assert.equal(harness.panel.querySelector('.ide-tree-row--cut'), null);
});

test('flag-on directory menu adds clipboard items and hints while flag-off stays legacy', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' }, dirs: ['dst'] });
  t.after(() => harness.dispose());

  openContextMenu(harness, row(harness, 'dst'));
  assert.deepEqual(menuItems(harness).filter((item) => ['Cut', 'Copy', 'Duplicate', 'Paste'].includes(item.label)), [
    { label: 'Cut', hint: 'Ctrl+X' },
    { label: 'Copy', hint: 'Ctrl+C' },
    { label: 'Duplicate', hint: 'Ctrl+D' },
  ]);

  row(harness, 'a.js').click();
  pressShortcut(harness, row(harness, 'a.js'), 'c');
  openContextMenu(harness, row(harness, 'dst'));
  assert.deepEqual(menuItems(harness).filter((item) => ['Cut', 'Copy', 'Duplicate', 'Paste'].includes(item.label)), [
    { label: 'Cut', hint: 'Ctrl+X' },
    { label: 'Copy', hint: 'Ctrl+C' },
    { label: 'Duplicate', hint: 'Ctrl+D' },
    { label: 'Paste', hint: 'Ctrl+V' },
  ]);
  openContextMenu(harness, harness.panel.querySelector('.ide-tree'));
  assert.ok(menuItems(harness).some((item) => item.label === 'Paste' && item.hint === 'Ctrl+V'));

  const legacy = await createHarness({ files: { 'a.js': 'a' }, dirs: ['dst'], qol: false });
  t.after(() => legacy.dispose());
  openContextMenu(legacy, row(legacy, 'dst'));
  assert.deepEqual(
    menuItems(legacy).filter((item) => ['Cut', 'Copy', 'Duplicate', 'Paste'].includes(item.label)),
    []
  );
});

test('copy filters a selected descendant when its ancestor is also selected', async (t) => {
  const harness = await createHarness({
    files: { 'src/child.js': 'child' },
    dirs: ['src', 'dst'],
    expanded: ['src'],
  });
  t.after(() => harness.dispose());
  await settle(40);
  row(harness, 'dst').click();
  harness.tree.selection.replace(['src', 'src/child.js'], 'src');
  harness.tree.syncSelection();
  pressShortcut(harness, row(harness, 'dst'), 'c');
  pressShortcut(harness, row(harness, 'dst'), 'v');
  await settle(80);

  assert.deepEqual(harness.bridge.calls.copyEntry, [{
    from: 'src', to: 'dst/src', onCollision: 'auto-rename', expectedGeneration: 1,
  }]);
});
