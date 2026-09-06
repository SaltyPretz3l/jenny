'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const { createIdeTreeClipboard } = require('../renderer/features/renderer-ide-tree-clipboard');
const { createIdeExplorerWiring } = require('../renderer/features/renderer-ide-explorer-wiring');
const treeMarkup = require('../renderer/features/renderer-ide-tree-markup');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { buildIdeDom, createBridgeStub, settle } = require('./helpers/ide-tree-harness');

function row(harness, path) {
  const result = harness.panel.querySelector(`[data-ide-tree-path="${path}"]`);
  assert.ok(result, `missing tree row ${path}`);
  return result;
}

function beginRename(harness, path) {
  row(harness, path).dispatchEvent(new harness.dom.window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 10, clientY: 10,
  }));
  const rename = [...harness.dom.window.document.querySelectorAll('.inv-context-menu-item')]
    .find((item) => item.textContent.includes('Rename'));
  assert.ok(rename, 'missing Rename menu item');
  rename.click();
  const input = harness.panel.querySelector('[data-ide-tree-edit-control]');
  assert.ok(input, 'rename input did not open');
  return input;
}

function pressKey(harness, target, key, options = {}) {
  target.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true, ...options,
  }));
}

async function createWiringHarness({ files = {}, qol = true } = {}) {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files });
  const ide = ideStateUtils.createIdeUiState();
  const toasts = [];
  const previousToastUtils = global.rendererToastUtils;
  global.rendererToastUtils = {
    showToastMessage(message, options) {
      const toast = { message, options, onUndo: options.actions?.[0]?.onClick };
      toasts.push(toast);
      return toast;
    },
  };
  const wiring = createIdeExplorerWiring({
    getDom: domHarness.getDom,
    escapeHtml: (value) => String(value),
    getIde: () => ide,
    getWorkspaceFsApi: () => bridge.jennyShell.workspaceFs,
    openFile() {},
    getFileLifecycle: () => ({
      handleTreeEntryDeleted() {}, handleTreeEntryRenamed() {},
    }),
    getChooseWorkspaceRoot: () => null,
    buildFileContextMenuItems: () => [],
    getSearchPanel: () => null,
    buildPathUtilityMenuItems: () => [],
    schedulePersist() {},
    getCloseOrchestrator: () => ({
      preflight: async () => ({ ready: true, paths: [] }), commit() {}, cancel() {},
    }),
    getConfirmDialog: () => ({ confirm: async () => true }),
    getWorkspaceRootApi: () => ({
      captureContext: async () => ({ rootId: 'root-test', generation: 1, phase: 'ready' }),
    }),
    showShellErrorToast() {},
    appendClientLog() {},
    getGitFeature: () => null,
    getFeatureFlags: () => ({ workspace_explorer_qol: qol }),
    panelDeps: () => ({
      getMountEl: () => domHarness.getDom().ideRailPanel,
      isActivePanel: () => true,
    }),
  });
  wiring.bindAll();
  wiring.tree.refreshRoot();
  await settle(30);
  return {
    ...domHarness,
    bridge,
    toasts,
    wiring,
    tree: wiring.tree,
    panel: domHarness.getDom().ideRailPanel,
    dispose() {
      wiring.disposeAll();
      domHarness.dom.window.close();
      if (previousToastUtils === undefined) delete global.rendererToastUtils;
      else global.rendererToastUtils = previousToastUtils;
    },
  };
}

function createClipboardHarness({
  mode = 'cut', paths = ['a.js'], kinds = {}, copyEntry, moveEntry, deleteEntry,
} = {}) {
  let rootEpoch = 1;
  const toasts = [];
  const errors = [];
  const moves = [];
  const deletes = [];
  const copies = [];
  const clipboard = createIdeTreeClipboard({
    selection: { resolveTargets: () => paths },
    getFocusedPath: () => '',
    getRootEpoch: () => rootEpoch,
    getRenderedRows: () => paths.map((path) => ({ path, kind: kinds[path] || 'file' })),
    moveEntry: moveEntry || (async (from, to, kind) => {
      moves.push({ from, to, kind });
      return true;
    }),
    deleteEntry: deleteEntry || (async (path, kind, options) => {
      deletes.push({ path, kind, options });
      return true;
    }),
    getApi: () => ({
      copyEntry: async (payload) => {
        copies.push(payload);
        if (copyEntry) return copyEntry(payload);
        return { ...payload, kind: kinds[payload.from] || 'file' };
      },
    }),
    getMutationContext: async () => ({ generation: 1 }),
    refreshDirectory: async () => {},
    render() {},
    showError: (message, meta) => errors.push({ message, meta }),
    showUndoToast: (message, onUndo) => toasts.push({ message, onUndo }),
    parentDirOf: treeMarkup.parentDirOf,
    nameOf: treeMarkup.nameOf,
    isQolEnabled: () => true,
  });
  clipboard[mode]();
  return {
    clipboard, copies, deletes, errors, moves, toasts,
    bumpEpoch() { rootEpoch += 1; },
  };
}

test('rename undo issues the exact inverse rename through the workspace bridge', async (t) => {
  const harness = await createWiringHarness({ files: { 'alpha.js': 'a' } });
  t.after(() => harness.dispose());
  const input = beginRename(harness, 'alpha.js');
  input.value = 'beta.js';
  pressKey(harness, input, 'Enter');
  await settle(60);

  assert.equal(harness.toasts[0].message, 'Renamed to beta.js');
  await harness.toasts[0].onUndo();

  assert.deepEqual(harness.bridge.calls.rename, [
    { from: 'alpha.js', to: 'beta.js', expectedGeneration: 1 },
    { from: 'beta.js', to: 'alpha.js', expectedGeneration: 1 },
  ]);
});

test('duplicate undo trashes the auto-renamed landed path and makes no other mutation', async (t) => {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files: { 'a.js': 'a' } });
  bridge.calls.copyEntry = [];
  bridge.jennyShell.workspaceFs.copyEntry = async (payload) => {
    bridge.calls.copyEntry.push(payload);
    bridge.state.files['a (2).js'] = bridge.state.files['a.js'];
    return { ...payload, to: 'a (2).js', kind: 'file', renamed: true };
  };
  const toasts = [];
  const tree = createIdeTree({
    getDom: domHarness.getDom,
    getIde: () => ideStateUtils.createIdeUiState(),
    getMountEl: () => domHarness.getDom().ideRailPanel,
    isActivePanel: () => true,
    isQolEnabled: () => true,
    getWorkspaceFsApi: () => bridge.jennyShell.workspaceFs,
    getMutationContext: async () => ({ rootId: 'root-test', generation: 1, phase: 'ready' }),
    preflightMutation: async () => ({ ready: true, paths: [] }),
    commitMutationPreflight() {}, cancelMutationPreflight() {},
    showError() {},
    showUndoToast: (message, onUndo) => toasts.push({ message, onUndo }),
  });
  t.after(() => { tree.dispose(); domHarness.dom.window.close(); });
  tree.bindEvents();
  tree.refreshRoot();
  await settle(30);
  const harness = { ...domHarness, panel: domHarness.getDom().ideRailPanel };
  row(harness, 'a.js').click();
  pressKey(harness, row(harness, 'a.js'), 'd', { ctrlKey: true });
  await settle(50);

  assert.equal(toasts[0].message, 'Duplicated a.js');
  await toasts[0].onUndo();

  assert.deepEqual(bridge.calls.delete, [{ path: 'a (2).js', expectedGeneration: 1 }]);
  assert.deepEqual(bridge.calls.rename, []);
  assert.deepEqual(bridge.calls.createFile, []);
  assert.deepEqual(bridge.calls.createDirectory, []);
});

test('cut-paste undo restores successful moves in reverse order', async () => {
  const harness = createClipboardHarness({ paths: ['a.js', 'b.js'] });
  await harness.clipboard.paste('dst');
  assert.equal(harness.toasts[0].message, 'Moved 2 items to dst/');

  await harness.toasts[0].onUndo();

  assert.deepEqual(harness.moves.map(({ from, to }) => ({ from, to })), [
    { from: 'a.js', to: 'dst/a.js' },
    { from: 'b.js', to: 'dst/b.js' },
    { from: 'dst/b.js', to: 'b.js' },
    { from: 'dst/a.js', to: 'a.js' },
  ]);
});

test('workspace epoch bump between rename toast and click makes undo a no-op', async (t) => {
  const harness = await createWiringHarness({ files: { 'alpha.js': 'a' } });
  t.after(() => harness.dispose());
  const input = beginRename(harness, 'alpha.js');
  input.value = 'beta.js';
  pressKey(harness, input, 'Enter');
  await settle(60);

  harness.tree.refreshRoot();
  harness.bridge.calls.rename.length = 0;
  await harness.toasts[0].onUndo();

  assert.deepEqual(harness.bridge.calls.rename, []);
});

test('partial undo failure reports Restored n of m', async () => {
  const moves = [];
  const harness = createClipboardHarness({
    paths: ['a.js', 'b.js'],
    moveEntry: async (from, to, kind) => {
      moves.push({ from, to, kind });
      return from !== 'dst/b.js';
    },
  });
  await harness.clipboard.paste('dst');
  await harness.toasts[0].onUndo();

  assert.equal(harness.toasts.at(-1).message, 'Restored 1 of 2');
});

test('zero-success copy shows no undo toast', async () => {
  const harness = createClipboardHarness({
    mode: 'copy',
    copyEntry: async () => { throw new Error('copy refused'); },
  });

  await harness.clipboard.paste('dst');

  assert.deepEqual(harness.toasts, []);
});

test('flag-off rename preserves current behavior with no toast', async (t) => {
  const harness = await createWiringHarness({ files: { 'alpha.js': 'a' }, qol: false });
  t.after(() => harness.dispose());
  const input = beginRename(harness, 'alpha.js');
  input.value = 'beta.js';
  pressKey(harness, input, 'Enter');
  await settle(60);

  assert.equal(harness.bridge.calls.rename.length, 1);
  assert.deepEqual(harness.toasts, []);
});
