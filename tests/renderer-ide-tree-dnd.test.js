'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const { createIdeTreeDnd } = require('../renderer/features/renderer-ide-tree-dnd');
const { createIdeExplorerWiring } = require('../renderer/features/renderer-ide-explorer-wiring');
const treeMarkup = require('../renderer/features/renderer-ide-tree-markup');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { buildIdeDom, createBridgeStub, settle } = require('./helpers/ide-tree-harness');

const SINGLE_MIME = 'application/x-jenny-tree-path';
const PATHS_MIME = 'application/x-jenny-tree-paths';

function createTransfer(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    effectAllowed: '',
    dropEffect: '',
    dragImage: null,
    get types() { return [...data.keys()]; },
    setData(type, value) { data.set(type, String(value)); },
    getData(type) { return data.get(type) || ''; },
    setDragImage(node, x, y) { this.dragImage = { node, x, y }; },
  };
}

function dispatchDrag(harness, target, type, transfer, options = {}) {
  const event = new harness.dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  Object.defineProperty(event, 'clientY', { value: options.clientY ?? 50 });
  Object.defineProperty(event, 'relatedTarget', { value: options.relatedTarget || null });
  Object.defineProperty(event, 'ctrlKey', { value: options.ctrlKey === true });
  target.dispatchEvent(event);
  return event;
}

function row(harness, path) {
  const result = harness.panel.querySelector(`[data-ide-tree-path="${path}"]`);
  assert.ok(result, `missing tree row ${path}`);
  return result;
}

async function createHarness({
  files = {}, dirs = [], expanded = [], qol = true, showError, showUndoToast,
  preflightMutation = async () => ({ ready: true, paths: [] }),
} = {}) {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files, dirs });
  bridge.calls.copyEntry = [];
  bridge.jennyShell.workspaceFs.copyEntry = async (payload) => {
    bridge.calls.copyEntry.push(payload);
    return { from: payload.from, to: payload.to, kind: 'file', renamed: false, skipped: [] };
  };
  const ide = ideStateUtils.createIdeUiState();
  ide.expandedDirs = new Set(expanded);
  const renamed = [];
  const errors = [];
  const toasts = [];
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
    showError: showError || ((message, meta) => errors.push({ message, meta })),
    onEntryRenamed: (...args) => renamed.push(args),
  });
  tree.bindEvents();
  tree.refreshRoot();
  await settle(30);
  const dnd = createIdeTreeDnd({
    getDom: domHarness.getDom,
    getMountEl: () => domHarness.getDom().ideRailPanel,
    isActivePanel: () => true,
    getIde: () => ide,
    getRootEpoch: tree.getRootEpoch,
    selection: tree.selection,
    isQolEnabled: () => qol,
    moveEntry: tree.moveEntry,
    getApi: () => bridge.jennyShell.workspaceFs,
    getMutationContext: async () => ({ rootId: 'root-test', generation: 1, phase: 'ready' }),
    refreshDirectory: tree.refreshDirectory,
    showError: showError || ((message, meta) => errors.push({ message, meta })),
    showToast: (message, options) => toasts.push({ message, options }),
    showUndoToast: showUndoToast || ((message, onUndo) => toasts.push({ message, onUndo })),
    expandDirForDrag: tree.expandDirForDrag,
    schedulePersistExpansion: tree.schedulePersistExpansion,
    cancelPendingEdit: tree.cancelPendingEdit,
    parentDirOf: treeMarkup.parentDirOf,
    nameOf: treeMarkup.nameOf,
  });
  dnd.bindEvents();
  return {
    ...domHarness,
    bridge,
    ide,
    tree,
    dnd,
    renamed,
    errors,
    toasts,
    panel: domHarness.getDom().ideRailPanel,
    dispose() {
      dnd.dispose();
      tree.dispose();
      domHarness.dom.window.close();
    },
  };
}

test('flag off keeps directory markup legacy and binds no internal drop behavior', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' }, dirs: ['dst'], qol: false });
  t.after(() => harness.dispose());
  const directory = row(harness, 'dst');
  assert.equal(directory.hasAttribute('draggable'), false);

  const transfer = createTransfer({ [SINGLE_MIME]: 'a.js' });
  dispatchDrag(harness, directory, 'drop', transfer);
  await settle(20);
  assert.deepEqual(harness.bridge.calls.rename, []);
});

test('single selected file moves into a directory through the rename handshake', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' }, dirs: ['dst'] });
  t.after(() => harness.dispose());
  harness.tree.selection.replace(['a.js'], 'a.js');
  const transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'a.js'), 'dragstart', transfer);
  dispatchDrag(harness, row(harness, 'dst'), 'dragover', transfer);
  dispatchDrag(harness, row(harness, 'dst'), 'drop', transfer);
  await settle(80);

  assert.deepEqual(harness.bridge.calls.rename, [{
    from: 'a.js', to: 'dst/a.js', expectedGeneration: 1,
  }]);
  assert.deepEqual(harness.tree.selection.getPaths(), ['dst/a.js']);
  assert.ok(harness.bridge.calls.listDirectory.some((call) => call.path === ''));
  assert.ok(harness.bridge.calls.listDirectory.some((call) => call.path === 'dst'));
  assert.deepEqual(harness.renamed[0].slice(0, 3), ['a.js', 'dst/a.js', 'file']);
});

test('dragover refuses self, descendants, and an unchanged parent', async (t) => {
  const harness = await createHarness({
    files: { 'a.js': 'a', 'b.js': 'b', 'src/child.js': 'c' },
    dirs: ['src', 'src/nested'],
    expanded: ['src'],
  });
  t.after(() => harness.dispose());

  let transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'src'), 'dragstart', transfer);
  assert.equal(dispatchDrag(harness, row(harness, 'src'), 'dragover', transfer).defaultPrevented, false);
  assert.equal(dispatchDrag(harness, row(harness, 'src/nested'), 'dragover', transfer).defaultPrevented, false);
  dispatchDrag(harness, row(harness, 'src'), 'dragend', transfer);

  transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'a.js'), 'dragstart', transfer);
  assert.equal(dispatchDrag(harness, row(harness, 'b.js'), 'dragover', transfer).defaultPrevented, false);
});

test('multi-drag filters selected descendants and builds a counted ghost for multiple roots', async (t) => {
  const harness = await createHarness({
    files: { 'src/a.js': 'a', 'src/b.js': 'b', 'loose.js': 'c' },
    dirs: ['src'],
    expanded: ['src'],
  });
  t.after(() => harness.dispose());
  harness.tree.selection.replace(['src', 'src/a.js', 'src/b.js'], 'src');
  let transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'src/a.js'), 'dragstart', transfer);
  assert.deepEqual(JSON.parse(transfer.getData(PATHS_MIME)), ['src']);
  assert.equal(transfer.getData(SINGLE_MIME), '');
  dispatchDrag(harness, row(harness, 'src/a.js'), 'dragend', transfer);

  harness.tree.selection.replace(['src/a.js', 'loose.js'], 'src/a.js');
  transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'src/a.js'), 'dragstart', transfer);
  assert.deepEqual(JSON.parse(transfer.getData(PATHS_MIME)), ['src/a.js', 'loose.js']);
  assert.equal(transfer.dragImage.node.querySelector('.ide-tree-drag-ghost-count').textContent, '2');
  assert.ok(row(harness, 'src/a.js').classList.contains('ide-tree-row--dragging'));
  assert.ok(row(harness, 'loose.js').classList.contains('ide-tree-row--dragging'));
});

test('spring-load expands after 600ms and is canceled by dragleave and dispose', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' }, dirs: ['dst', 'later', 'never'] });
  t.after(() => harness.dispose());
  const transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'a.js'), 'dragstart', transfer);
  dispatchDrag(harness, row(harness, 'dst'), 'dragover', transfer);
  await settle(640);
  assert.equal(harness.ide.expandedDirs.has('dst'), true);

  dispatchDrag(harness, row(harness, 'later'), 'dragover', transfer);
  dispatchDrag(harness, row(harness, 'later'), 'dragleave', transfer);
  await settle(640);
  assert.equal(harness.ide.expandedDirs.has('later'), false);

  dispatchDrag(harness, row(harness, 'never'), 'dragover', transfer);
  harness.dnd.dispose();
  await settle(640);
  assert.equal(harness.ide.expandedDirs.has('never'), false);
});

test('an EXISTS failure does not block later moves and undo reverses successes', async (t) => {
  const harness = await createHarness({
    files: { 'a.js': 'a', 'b.js': 'b', 'dst/a.js': 'occupied' },
    dirs: ['dst'],
  });
  t.after(() => harness.dispose());
  harness.tree.selection.replace(['a.js', 'b.js'], 'a.js');
  const transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'a.js'), 'dragstart', transfer);
  dispatchDrag(harness, row(harness, 'dst'), 'drop', transfer);
  await settle(100);

  assert.equal(harness.errors.length, 1);
  assert.equal(harness.errors[0].message, 'A file named a.js already exists in dst.');
  assert.equal(harness.toasts.length, 1);
  assert.match(harness.toasts[0].message, /^Moved 1 item to dst\/$/);
  await harness.toasts[0].onUndo();
  assert.deepEqual(harness.bridge.calls.rename.map(({ from, to }) => ({ from, to })), [
    { from: 'a.js', to: 'dst/a.js' },
    { from: 'b.js', to: 'dst/b.js' },
    { from: 'dst/b.js', to: 'b.js' },
  ]);
  assert.equal(harness.toasts.at(-1).message, 'Restored 1 items');
});

test('undo after a workspace-root epoch change silently performs no inverse moves', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' }, dirs: ['dst'] });
  t.after(() => harness.dispose());
  const transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'a.js'), 'dragstart', transfer);
  dispatchDrag(harness, row(harness, 'dst'), 'drop', transfer);
  await settle(80);
  assert.equal(harness.toasts.length, 1);

  harness.tree.refreshRoot();
  harness.bridge.calls.rename.length = 0;
  await harness.toasts[0].onUndo();

  assert.deepEqual(harness.bridge.calls.rename, []);
  assert.equal(harness.toasts.length, 1);
  assert.deepEqual(harness.errors, []);
});

test('a workspace-root epoch change stops the move batch and suppresses undo', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a', 'b.js': 'b' }, dirs: ['dst'] });
  t.after(() => harness.dispose());
  const rename = harness.bridge.jennyShell.workspaceFs.rename;
  harness.bridge.jennyShell.workspaceFs.rename = async (payload) => {
    const result = await rename(payload);
    harness.tree.refreshRoot();
    return result;
  };
  harness.tree.selection.replace(['a.js', 'b.js'], 'a.js');
  const transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'a.js'), 'dragstart', transfer);
  dispatchDrag(harness, row(harness, 'dst'), 'drop', transfer);
  await settle(80);

  assert.equal(harness.bridge.calls.rename.length, 1);
  assert.deepEqual(harness.toasts, []);
});

test('Ctrl-drop copies into a directory without rename or undo', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' }, dirs: ['dst'] });
  t.after(() => harness.dispose());
  const transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'a.js'), 'dragstart', transfer);
  dispatchDrag(harness, row(harness, 'dst'), 'dragover', transfer, { ctrlKey: true });
  assert.equal(transfer.dropEffect, 'copy');
  dispatchDrag(harness, row(harness, 'dst'), 'drop', transfer, { ctrlKey: true });
  await settle(80);

  assert.deepEqual(harness.bridge.calls.copyEntry, [{
    from: 'a.js', to: 'dst/a.js', onCollision: 'auto-rename', expectedGeneration: 1,
  }]);
  assert.deepEqual(harness.bridge.calls.rename, []);
  assert.equal(harness.toasts[0].message, 'Copied 1 item to dst/');
  assert.equal(harness.toasts[0].onUndo, undefined);
});

test('Ctrl-drop into the same parent duplicates through copyEntry', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a', 'b.js': 'b' } });
  t.after(() => harness.dispose());
  const transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'a.js'), 'dragstart', transfer);
  const dragover = dispatchDrag(harness, row(harness, 'b.js'), 'dragover', transfer, { ctrlKey: true });
  assert.equal(dragover.defaultPrevented, true);
  dispatchDrag(harness, row(harness, 'b.js'), 'drop', transfer, { ctrlKey: true });
  await settle(80);

  assert.equal(harness.bridge.calls.copyEntry.length, 1);
  assert.equal(harness.bridge.calls.copyEntry[0].to, 'a.js');
  assert.deepEqual(harness.bridge.calls.rename, []);
});

test('undo reports a restore only when the inverse move succeeds', async (t) => {
  let preflights = 0;
  const harness = await createHarness({
    files: { 'a.js': 'a' },
    dirs: ['dst'],
    preflightMutation: async () => ({ ready: ++preflights === 1, paths: [] }),
  });
  t.after(() => harness.dispose());
  const transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'a.js'), 'dragstart', transfer);
  dispatchDrag(harness, row(harness, 'dst'), 'drop', transfer);
  await settle(80);

  await harness.toasts[0].onUndo();

  assert.equal(harness.toasts.at(-1).message, 'Restored 0 of 1');
  assert.equal(harness.bridge.calls.rename.length, 1);
});

test('dispose cancels auto-scroll and removes the drop listeners', async (t) => {
  const harness = await createHarness({ files: { 'a.js': 'a' }, dirs: ['dst'] });
  t.after(() => harness.dispose());
  const callbacks = new Map();
  const canceled = [];
  let nextFrame = 1;
  harness.dom.window.requestAnimationFrame = (callback) => {
    const id = nextFrame++;
    callbacks.set(id, callback);
    return id;
  };
  harness.dom.window.cancelAnimationFrame = (id) => canceled.push(id);
  harness.panel.getBoundingClientRect = () => ({ top: 0, bottom: 100 });
  const transfer = createTransfer();
  dispatchDrag(harness, row(harness, 'a.js'), 'dragstart', transfer);
  dispatchDrag(harness, row(harness, 'dst'), 'dragover', transfer, { clientY: 99 });
  harness.dnd.dispose();
  assert.deepEqual(canceled, [1]);

  dispatchDrag(harness, row(harness, 'dst'), 'drop', transfer);
  await settle(30);
  assert.deepEqual(harness.bridge.calls.rename, []);
});

test('wiring supplies one multi-delete confirmation for three selected rows', async (t) => {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files: { 'a.js': 'a', 'b.js': 'b', 'c.js': 'c' } });
  const ide = ideStateUtils.createIdeUiState();
  const confirmations = [];
  const wiring = createIdeExplorerWiring({
    getDom: domHarness.getDom,
    escapeHtml: (value) => String(value),
    getIde: () => ide,
    getWorkspaceFsApi: () => bridge.jennyShell.workspaceFs,
    openFile() {},
    getFileLifecycle: () => ({ handleTreeEntryDeleted() {}, handleTreeEntryRenamed() {} }),
    getChooseWorkspaceRoot: () => null,
    buildFileContextMenuItems: () => [],
    getSearchPanel: () => null,
    buildPathUtilityMenuItems: () => [],
    schedulePersist() {},
    getCloseOrchestrator: () => ({
      preflight: async () => ({ ready: true, paths: [] }), commit() {}, cancel() {},
    }),
    getConfirmDialog: () => ({
      confirm: async (options) => { confirmations.push(options); return true; },
    }),
    getWorkspaceRootApi: () => ({
      captureContext: async () => ({ rootId: 'root-test', generation: 1, phase: 'ready' }),
    }),
    showShellErrorToast() {},
    appendClientLog() {},
    getGitFeature: () => null,
    getFeatureFlags: () => ({ workspace_explorer_qol: true }),
    panelDeps: () => ({
      getMountEl: () => domHarness.getDom().ideRailPanel,
      isActivePanel: () => true,
    }),
  });
  t.after(() => {
    wiring.disposeAll();
    domHarness.dom.window.close();
  });
  wiring.bindAll();
  wiring.tree.refreshRoot();
  await settle(30);
  wiring.tree.selection.replace(['a.js', 'b.js', 'c.js'], 'a.js');
  const first = domHarness.getDom().ideRailPanel.querySelector('[data-ide-tree-path="a.js"]');
  first.dispatchEvent(new domHarness.dom.window.KeyboardEvent('keydown', {
    key: 'Delete', bubbles: true, cancelable: true,
  }));
  await settle(100);

  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].title, 'Delete 3 items?');
  assert.equal(bridge.calls.delete.length, 3);
});
