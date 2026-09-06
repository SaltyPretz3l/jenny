'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeController } = require('../renderer/features/renderer-ide-controller');
const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const {
  buildIdeDom,
  createBridgeStub,
  settle,
  deferred,
} = require('./helpers/ide-tree-harness');

test('Generated toggle persists and reloads Explorer listings with explicit visibility', async () => {
  const { getDom } = buildIdeDom();
  const ide = ideStateUtils.createIdeUiState();
  const payloads = [];
  let persistCalls = 0;
  const tree = createIdeTree({
    getDom,
    getIde: () => ide,
    getMountEl: () => getDom().ideRailPanel,
    isActivePanel: () => true,
    schedulePersist: () => { persistCalls += 1; },
    getWorkspaceFsApi: () => ({
      async listDirectory(payload) {
        payloads.push(payload);
        return { entries: [] };
      },
    }),
  });
  tree.bindEvents();
  tree.refreshRoot();
  await settle();
  const panel = getDom().ideRailPanel;
  let toggle = panel.querySelector('[data-ide-tree-action="toggle-generated"]');
  assert.equal(toggle.textContent, 'Generated');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'Show generated directories');
  assert.equal(payloads.at(-1).showGenerated, false);

  toggle.click();
  await settle();
  toggle = panel.querySelector('[data-ide-tree-action="toggle-generated"]');
  assert.equal(ide.showGenerated, true);
  assert.equal(persistCalls, 1);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Hide generated directories');
  assert.equal(payloads.at(-1).showGenerated, true);
});

test('a late old-root listing cannot repopulate the tree after reset', async () => {
  const { getDom } = buildIdeDom();
  const ide = ideStateUtils.createIdeUiState();
  const oldListing = deferred();
  const newListing = deferred();
  let root = 'old';
  const tree = createIdeTree({
    getIde: () => ide,
    getMountEl: () => getDom().ideRailPanel,
    isActivePanel: () => true,
    getWorkspaceFsApi: () => ({
      listDirectory: () => (root === 'old' ? oldListing.promise : newListing.promise),
    }),
  });

  tree.refreshRoot();
  root = 'new';
  tree.resetForRoot();
  newListing.resolve({ entries: [{ name: 'new.js', relPath: 'new.js', kind: 'file' }] });
  await new Promise(setImmediate);
  assert.ok(getDom().ideRailPanel.querySelector('[data-ide-tree-path="new.js"]'));

  oldListing.resolve({ entries: [{ name: 'old.js', relPath: 'old.js', kind: 'file' }] });
  await new Promise(setImmediate);
  assert.equal(getDom().ideRailPanel.querySelector('[data-ide-tree-path="old.js"]'), null);
  assert.ok(getDom().ideRailPanel.querySelector('[data-ide-tree-path="new.js"]'));
});

// UIUX-012: loadDirectory() early-returns a no-op whenever loadingDirs already
// has the path — used both for "don't double-fire a duplicate expand click"
// AND, via refreshDirectory(), for "an external-change batch wants a refresh".
// The two must not share the same fate: a refresh requested while a load for
// that exact directory is already in flight must not be silently dropped.
test('an external-change refresh for a directory already loading is queued, not dropped', async () => {
  const { getDom } = buildIdeDom();
  const ide = ideStateUtils.createIdeUiState();
  const srcCalls = [];
  let srcGate = deferred();
  const tree = createIdeTree({
    getIde: () => ide,
    getMountEl: () => getDom().ideRailPanel,
    isActivePanel: () => true,
    getWorkspaceFsApi: () => ({
      listDirectory: ({ path }) => {
        if (path !== 'src') return Promise.resolve({ entries: [{ name: 'src', relPath: 'src', kind: 'directory' }] });
        srcCalls.push(srcGate);
        return srcGate.promise;
      },
    }),
  });

  // Root load, then expand src (call #1) and let it resolve so it's cached.
  tree.refreshRoot();
  await new Promise(setImmediate);
  srcGate.resolve({ entries: [{ name: 'a.js', relPath: 'src/a.js', kind: 'file' }] });
  await tree.revealPath('src/a.js'); // expands + loads src (awaits the pending load itself)
  assert.equal(srcCalls.length, 1, 'src loaded once and is now cached');

  // An external change under src arrives: refreshDirectory('src') starts
  // call #2, deliberately left in flight.
  srcGate = deferred();
  tree.handleExternalChanges([{ relPath: 'src/a.js', kind: 'changed' }]);
  await new Promise(setImmediate);
  assert.equal(srcCalls.length, 2, 'the first refresh call is in flight');

  // A SECOND external change under src arrives WHILE call #2 is still
  // in flight — this refresh must be queued, not dropped.
  tree.handleExternalChanges([{ relPath: 'src/b.js', kind: 'changed' }]);
  await new Promise(setImmediate);

  // Settle call #2.
  const secondGate = srcGate;
  srcGate = deferred();
  secondGate.resolve({ entries: [{ name: 'a.js', relPath: 'src/a.js', kind: 'file' }] });
  await new Promise(setImmediate);
  await new Promise(setImmediate);

  assert.equal(
    srcCalls.length, 3,
    'the refresh requested while src was already loading fired a THIRD listDirectory call once the in-flight one settled'
  );
  srcGate.resolve({ entries: [] });
  await new Promise(setImmediate);
});

function createHarness({ bridgeOptions } = {}) {
  const { dom, getDom } = buildIdeDom();
  const bridge = createBridgeStub(bridgeOptions);
  const previousWindow = globalThis.window;
  const previousMonacoUtils = globalThis.rendererMonacoEditorUtils;
  globalThis.window = dom.window;
  dom.window.jennyShell = bridge.jennyShell;
  // No Monaco in jsdom: the editor host runs its fallback-textarea path.
  globalThis.rendererMonacoEditorUtils = {
    ...require('../renderer/features/renderer-monaco-editor-utils'),
    async ensureMonacoEditorApi() {
      return null;
    },
    normalizeEditorLanguage: () => 'plaintext',
  };
  const cleanups = [];
  const toasts = [];
  const state = { ui: { activeView: 'ide', ide: null } };
  const controller = createIdeController({
    state,
    getDom,
    registerCleanup: (fn) => cleanups.push(fn),
    workspaceRootService: {
      captureContext: async () => ({
        rootPath: 'G:/fake-root', rootId: 'root_fake', generation: 1, phase: 'ready',
      }),
    },
    callbacks: {
      appendClientLog: (level, event, meta) => { bridge.calls.clientLog = { level, event, meta }; },
      showShellErrorToast: (message, meta) => toasts.push({ message, meta }),
      toErrorMessage: (error, fallback) => String(error?.message || fallback || ''),
    },
  });
  return {
    dom,
    getDom,
    bridge,
    controller,
    state,
    toasts,
    dispose() {
      for (const cleanup of cleanups.splice(0)) {
        try { cleanup(); } catch (_error) { /* noop */ }
      }
      globalThis.window = previousWindow;
      globalThis.rendererMonacoEditorUtils = previousMonacoUtils;
    },
  };
}

function findMenuItem(doc, label) {
  return [...doc.body.querySelectorAll('.inv-context-menu-item')]
    .find((item) => item.textContent.includes(label)) || null;
}

function openContextMenu(harness, element) {
  element.dispatchEvent(new harness.dom.window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 12,
    clientY: 24,
  }));
}

function pressKey(harness, element, key) {
  element.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
}

test('ide tree renders the root listing and opens files on click', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'const a = 1;', 'README.md': 'hello' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const panel = harness.getDom().ideRailPanel;
  const rows = [...panel.querySelectorAll('[data-ide-tree-path]')];
  assert.deepEqual(rows.map((row) => row.dataset.ideTreePath), ['src', 'README.md']);
  assert.equal(rows[0].dataset.ideTreeKind, 'directory');
  assert.equal(rows[1].dataset.ideTreeKind, 'file');

  panel.querySelector('[data-ide-tree-path="README.md"]').click();
  await settle();
  assert.deepEqual(harness.bridge.calls.readFile.map((call) => call.path), ['README.md']);
  assert.ok(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="README.md"]'));
  // Re-render marked the opened file selected.
  assert.ok(
    panel.querySelector('[data-ide-tree-path="README.md"]').classList.contains('ide-tree-row--selected')
  );
});

test('ide tree lazily expands directories and persists expandedDirs', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a', 'src/deep/util.js': 'b' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();

  const panel = harness.getDom().ideRailPanel;
  panel.querySelector('[data-ide-tree-path="src"]').click();
  await settle();
  assert.deepEqual(harness.bridge.calls.listDirectory.map((call) => call.path || ''), ['', 'src']);
  assert.equal(panel.querySelector('[data-ide-tree-path="src"]').getAttribute('aria-expanded'), 'true');
  assert.ok(panel.querySelector('[data-ide-tree-path="src/deep"]'));
  assert.ok(panel.querySelector('[data-ide-tree-path="src/app.js"]'));
  assert.ok(harness.state.ui.ide.expandedDirs.has('src'));

  await settle(600);
  assert.ok(harness.bridge.calls.updateState.length >= 1);
  assert.deepEqual(harness.bridge.calls.updateState.at(-1).rootState.expandedDirs, ['src']);

  // Collapse hides children without a new listing call.
  const listCallsBefore = harness.bridge.calls.listDirectory.length;
  panel.querySelector('[data-ide-tree-path="src"]').click();
  await settle();
  assert.equal(panel.querySelector('[data-ide-tree-path="src/app.js"]'), null);
  assert.equal(panel.querySelector('[data-ide-tree-path="src"]').getAttribute('aria-expanded'), 'false');
  assert.equal(harness.bridge.calls.listDirectory.length, listCallsBefore);
});

test('ide tree context menu creates a file inline and opens it', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/app.js': 'a' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="src"]'));
  for (const label of ['New File', 'New Folder', 'Rename', 'Delete']) {
    assert.ok(findMenuItem(doc, label), `missing menu item ${label}`);
  }
  findMenuItem(doc, 'New File').click();
  await settle();
  assert.equal(doc.body.querySelector('.inv-context-menu'), null);

  const input = panel.querySelector('[data-ide-tree-edit-control]');
  assert.ok(input);
  input.value = 'fresh.js';
  pressKey(harness, input, 'Enter');
  await settle(100);

  assert.deepEqual(harness.bridge.calls.createFile, [{ path: 'src/fresh.js', expectedGeneration: 1 }]);
  assert.equal(panel.querySelector('[data-ide-tree-edit-control]'), null);
  assert.ok(panel.querySelector('[data-ide-tree-path="src/fresh.js"]'));
  // The new file opened in a tab through the normal read path.
  assert.ok(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="src/fresh.js"]'));
});

test('ide tree context menu carries path/OS utilities on file and directory rows', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/app.js': 'a' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;

  // Directory rows: reveal + copy items, but no Open in Default App.
  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="src"]'));
  assert.ok(findMenuItem(doc, 'Reveal in File Explorer'));
  assert.equal(findMenuItem(doc, 'Open in Default App'), null);
  findMenuItem(doc, 'Copy Relative Path').click();
  await settle();
  assert.deepEqual(harness.bridge.calls.clipboardWriteText, ['src']);

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="src"]'));
  findMenuItem(doc, 'Copy Path').click();
  await settle();
  assert.equal(harness.bridge.calls.clipboardWriteText.at(-1), 'G:/fake-root/src');

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="src"]'));
  findMenuItem(doc, 'Reveal in File Explorer').click();
  await settle();
  assert.deepEqual(harness.bridge.calls.revealInFolder, [{ path: 'src' }]);

  // File rows additionally get Open in Default App + Copy Name.
  panel.querySelector('[data-ide-tree-path="src"]').click();
  await settle();
  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="src/app.js"]'));
  assert.ok(findMenuItem(doc, 'Copy Name'));
  findMenuItem(doc, 'Open in Default App').click();
  await settle();
  assert.deepEqual(harness.bridge.calls.openInDefaultApp, [{ path: 'src/app.js' }]);
});

test('ide tree context menu creates a folder at the workspace root', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;

  // Empty-area context menu offers creation at the root.
  openContextMenu(harness, panel.querySelector('.ide-tree'));
  assert.equal(findMenuItem(doc, 'Rename'), null);
  findMenuItem(doc, 'New Folder').click();
  await settle();

  const input = panel.querySelector('[data-ide-tree-edit-control]');
  input.value = 'assets';
  pressKey(harness, input, 'Enter');
  await settle();

  assert.deepEqual(harness.bridge.calls.createDirectory, [{ path: 'assets', expectedGeneration: 1 }]);
  const row = panel.querySelector('[data-ide-tree-path="assets"]');
  assert.ok(row);
  assert.equal(row.dataset.ideTreeKind, 'directory');
});

test('ide tree rejects invalid names and escape cancels the inline editor', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'README.md': 'r' } } });
  harness.state.features = { featureFlags: { workspace_explorer_qol: true } };
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="README.md"]'));
  findMenuItem(doc, 'Rename').click();
  await settle();

  const input = panel.querySelector('[data-ide-tree-edit-control]');
  assert.equal(input.value, 'README.md');
  input.value = 'nested/escape.md';
  pressKey(harness, input, 'Enter');
  await settle();
  // Separator names never reach the bridge; the editor stays open for retry.
  assert.equal(harness.bridge.calls.rename.length, 0);
  assert.equal(harness.toasts.length, 0);
  assert.equal(panel.querySelector('.ide-tree-edit-error')?.textContent,
    'A name can\'t contain any of: \\ / : * ? " < > |');
  assert.equal(panel.querySelector('[data-ide-tree-edit-control]')?.value, 'nested/escape.md');

  pressKey(harness, panel.querySelector('[data-ide-tree-edit-control]'), 'Escape');
  await settle();
  assert.equal(panel.querySelector('[data-ide-tree-edit-control]'), null);
  assert.equal(harness.bridge.calls.rename.length, 0);
});

test('ide tree rename of an open file closes and reopens its tab', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'src/app.js': 'content-a' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;

  panel.querySelector('[data-ide-tree-path="src"]').click();
  await settle();
  panel.querySelector('[data-ide-tree-path="src/app.js"]').click();
  await settle();
  assert.ok(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="src/app.js"]'));

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="src/app.js"]'));
  findMenuItem(doc, 'Rename').click();
  await settle();
  const input = panel.querySelector('[data-ide-tree-edit-control]');
  assert.equal(input.value, 'app.js');
  input.value = 'main.js';
  pressKey(harness, input, 'Enter');
  await settle(100);

  assert.deepEqual(harness.bridge.calls.rename, [{ from: 'src/app.js', to: 'src/main.js', expectedGeneration: 1 }]);
  const strip = harness.getDom().ideTabStrip;
  assert.equal(strip.querySelector('[data-ide-tab-path="src/app.js"]'), null);
  assert.ok(strip.querySelector('[data-ide-tab-path="src/main.js"]'));
  assert.ok(panel.querySelector('[data-ide-tree-path="src/main.js"]'));
  // The renamed file re-opened from disk.
  assert.deepEqual(
    harness.bridge.calls.readFile.map((call) => call.path),
    ['src/app.js', 'src/main.js']
  );
});

test('ide tree delete closes the open tab and refreshes the listing', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a', 'src/other.js': 'b' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;

  panel.querySelector('[data-ide-tree-path="src"]').click();
  await settle();
  panel.querySelector('[data-ide-tree-path="src/app.js"]').click();
  await settle();

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="src/app.js"]'));
  findMenuItem(doc, 'Delete').click();
  await settle();
  doc.querySelector('[data-ide-confirm-action="confirm"]').click();
  await settle();

  assert.deepEqual(harness.bridge.calls.delete, [{ path: 'src/app.js', expectedGeneration: 1 }]);
  assert.equal(panel.querySelector('[data-ide-tree-path="src/app.js"]'), null);
  assert.ok(panel.querySelector('[data-ide-tree-path="src/other.js"]'));
  assert.equal(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="src/app.js"]'), null);
  assert.equal(harness.getDom().ideEmptyState.classList.contains('hidden'), false);
});

test('ide tree directory delete closes every tab underneath and prunes expansion', async (t) => {
  const harness = createHarness({
    bridgeOptions: {
      files: { 'src/app.js': 'a', 'src/deep/util.js': 'b', 'README.md': 'r' },
    },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;

  panel.querySelector('[data-ide-tree-path="src"]').click();
  await settle();
  panel.querySelector('[data-ide-tree-path="src/deep"]').click();
  await settle();
  await harness.controller.openFile('src/app.js');
  await harness.controller.openFile('src/deep/util.js');
  await harness.controller.openFile('README.md');
  await settle();
  assert.equal(harness.getDom().ideTabStrip.querySelectorAll('[data-ide-tab]').length, 3);

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="src"]'));
  findMenuItem(doc, 'Delete').click();
  await settle();
  doc.querySelector('[data-ide-confirm-action="confirm"]').click();
  await settle();

  assert.deepEqual(harness.bridge.calls.delete, [{ path: 'src', expectedGeneration: 1 }]);
  const strip = harness.getDom().ideTabStrip;
  assert.equal(strip.querySelector('[data-ide-tab-path="src/app.js"]'), null);
  assert.equal(strip.querySelector('[data-ide-tab-path="src/deep/util.js"]'), null);
  assert.ok(strip.querySelector('[data-ide-tab-path="README.md"]'));
  assert.equal(panel.querySelector('[data-ide-tree-path="src"]'), null);
  assert.equal(harness.state.ui.ide.expandedDirs.has('src'), false);
  assert.equal(harness.state.ui.ide.expandedDirs.has('src/deep'), false);
});

test('ide tree rename save failure blocks the mutation and preserves the dirty tab', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'app.js': 'original' }, failWriteText: true },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('app.js');
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;
  const editor = harness.getDom().ideEditorFallback;
  editor.value = 'unsaved';
  editor.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="app.js"]'));
  findMenuItem(doc, 'Rename').click();
  await settle();
  const input = panel.querySelector('[data-ide-tree-edit-control]');
  input.value = 'renamed.js';
  pressKey(harness, input, 'Enter');
  await settle();
  doc.querySelector('[data-ide-confirm-action="save"]').click();
  await settle();

  assert.deepEqual(harness.bridge.calls.rename, []);
  assert.ok(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="app.js"]'));
  assert.equal(harness.state.ui.ide.dirtyByPath['app.js'], true);
  assert.equal(harness.bridge.state.files['app.js'], 'original');
});

test('ide tree discard preflight is canceled when rename fails', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'app.js': 'original' }, failRename: true },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('app.js');
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;
  const editor = harness.getDom().ideEditorFallback;
  editor.value = 'unsaved';
  editor.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="app.js"]'));
  findMenuItem(doc, 'Rename').click();
  await settle();
  const input = panel.querySelector('[data-ide-tree-edit-control]');
  input.value = 'renamed.js';
  pressKey(harness, input, 'Enter');
  await settle();
  doc.querySelector('[data-ide-confirm-action="discard"]').click();
  await settle();

  assert.deepEqual(harness.bridge.calls.rename, [
    { from: 'app.js', to: 'renamed.js', expectedGeneration: 1 },
  ]);
  assert.ok(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="app.js"]'));
  assert.equal(harness.state.ui.ide.dirtyByPath['app.js'], true);
  assert.equal(harness.bridge.state.files['app.js'], 'original');
  assert.equal('renamed.js' in harness.bridge.state.files, false);
});

test('ide tree delete confirmation cancel leaves the backend and tab untouched', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'app.js': 'original' } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('app.js');
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="app.js"]'));
  findMenuItem(doc, 'Delete').click();
  await settle();
  doc.querySelector('[data-ide-confirm-action="cancel"]').click();
  await settle();

  assert.deepEqual(harness.bridge.calls.delete, []);
  assert.ok(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="app.js"]'));
  assert.equal(harness.bridge.state.files['app.js'], 'original');
});

test('ide tree discard preflight is canceled when recycle-bin delete fails', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'app.js': 'original' }, failDelete: true },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('app.js');
  await settle();
  const doc = harness.dom.window.document;
  const panel = harness.getDom().ideRailPanel;
  const editor = harness.getDom().ideEditorFallback;
  editor.value = 'unsaved';
  editor.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="app.js"]'));
  findMenuItem(doc, 'Delete').click();
  await settle();
  doc.querySelector('[data-ide-confirm-action="confirm"]').click();
  await settle();
  doc.querySelector('[data-ide-confirm-action="discard"]').click();
  await settle();

  assert.deepEqual(harness.bridge.calls.delete, [{ path: 'app.js', expectedGeneration: 1 }]);
  assert.ok(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="app.js"]'));
  assert.equal(harness.state.ui.ide.dirtyByPath['app.js'], true);
  assert.equal(harness.bridge.state.files['app.js'], 'original');
  assert.equal(harness.toasts.at(-1).message, 'delete refused', 'ordinary messages are unchanged');
});

for (const [errorName, detail] of [['WorkspaceFsError', 'recycle bin offline'], ['Error', 'plain bridge failure']]) {
  test(`ide tree strips the Electron invoke wrapper and ${errorName} prefix from mutation toasts`, async (t) => {
    const wrapped = `Error invoking remote method 'workspace-fs:delete': ${errorName}: ${detail}`;
    const harness = createHarness({ bridgeOptions: { files: { 'app.js': 'original' }, failDelete: wrapped } }); t.after(() => harness.dispose());
    await harness.controller.activateIde(); await settle();
    const doc = harness.dom.window.document, panel = harness.getDom().ideRailPanel;
    openContextMenu(harness, panel.querySelector('[data-ide-tree-path="app.js"]')); findMenuItem(doc, 'Delete').click();
    await settle(); doc.querySelector('[data-ide-confirm-action="confirm"]').click(); await settle();
    assert.equal(harness.toasts.at(-1).message, detail); assert.equal(harness.bridge.calls.clientLog.meta.message, wrapped);
  });
}

test('ide tree rows carry file-type icons (W3)', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a', 'README.md': 'r' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const panel = harness.getDom().ideRailPanel;
  const dirRow = panel.querySelector('[data-ide-tree-path="src"]');
  assert.ok(dirRow.querySelector('.ide-tree-icon--folder'), 'directory rows get folder icons');
  const mdRow = panel.querySelector('[data-ide-tree-path="README.md"]');
  assert.ok(mdRow.querySelector('.ide-tree-icon--md'), 'files get extension-category icons');
  // Expansion swaps the folder glyph (open variant) while keeping the class.
  const closedSvg = dirRow.querySelector('.ide-tree-icon svg').innerHTML;
  dirRow.click();
  await settle();
  const openSvg = panel.querySelector('[data-ide-tree-path="src"] .ide-tree-icon svg').innerHTML;
  assert.notEqual(openSvg, closedSvg);
});

test('ide tree header collapse-all clears expansion and persists (W3)', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a', 'src/deep/util.js': 'b' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const panel = harness.getDom().ideRailPanel;
  panel.querySelector('[data-ide-tree-path="src"]').click();
  await settle();
  panel.querySelector('[data-ide-tree-path="src/deep"]').click();
  await settle();
  assert.equal(harness.state.ui.ide.expandedDirs.size, 2);

  panel.querySelector('[data-ide-tree-action="collapse-all"]').click();
  await settle();
  assert.equal(harness.state.ui.ide.expandedDirs.size, 0);
  assert.equal(panel.querySelector('[data-ide-tree-path="src/app.js"]'), null);
  await settle(600);
  assert.deepEqual(harness.bridge.calls.updateState.at(-1).rootState.expandedDirs, []);
});

test('ide tree header refresh re-lists only cached directories (W3)', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a', 'src/deep/util.js': 'b', 'README.md': 'r' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const panel = harness.getDom().ideRailPanel;
  panel.querySelector('[data-ide-tree-path="src"]').click();
  await settle();
  // Cached listings: '' and 'src' ('src/deep' was never expanded).
  harness.bridge.calls.listDirectory.length = 0;

  // A file created behind the tree's back appears after refresh.
  harness.bridge.state.files['NEW.txt'] = 'new';
  panel.querySelector('[data-ide-tree-action="refresh"]').click();
  await settle();
  const relisted = harness.bridge.calls.listDirectory.map((call) => call.path || '').sort();
  assert.deepEqual(relisted, ['', 'src']);
  assert.ok(panel.querySelector('[data-ide-tree-path="NEW.txt"]'));

  // The blank-area context menu carries the same actions.
  openContextMenu(harness, panel.querySelector('.ide-tree'));
  const doc = harness.dom.window.document;
  assert.ok(findMenuItem(doc, 'Refresh'));
  assert.ok(findMenuItem(doc, 'Collapse All'));
});

// Drop-to-open source side: only file/symlink rows are draggable, and the
// dragstart handler writes the file's path into the internal drag payload so
// the editor stage can open it. Directory rows are inert for both.
test('ide tree marks file rows draggable but not directory rows', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a', 'README.md': 'r' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const panel = harness.getDom().ideRailPanel;
  assert.equal(panel.querySelector('[data-ide-tree-path="README.md"]').getAttribute('draggable'), 'true');
  assert.equal(panel.querySelector('[data-ide-tree-path="src"]').getAttribute('draggable'), null);
});

// Dispatch a synthetic dragstart with a hand-rolled dataTransfer (jsdom's
// DragEvent/dataTransfer is unreliable) and observe what the delegated handler
// writes onto it.
function dispatchDragStart(harness, row) {
  const writes = {};
  const event = new harness.dom.window.Event('dragstart', { bubbles: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      effectAllowed: '',
      setData(type, value) { writes[type] = value; },
    },
  });
  row.dispatchEvent(event);
  return { writes, effectAllowed: event.dataTransfer.effectAllowed };
}

test('ide tree dragstart writes the internal payload for a file row', async (t) => {
  const harness = createHarness({
    bridgeOptions: { files: { 'src/app.js': 'a', 'README.md': 'r' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await settle();
  const panel = harness.getDom().ideRailPanel;

  const { writes, effectAllowed } = dispatchDragStart(
    harness,
    panel.querySelector('[data-ide-tree-path="README.md"]')
  );
  assert.equal(writes['application/x-jenny-tree-path'], 'README.md');
  assert.equal(writes['text/plain'], 'README.md');
  assert.equal(effectAllowed, 'copy');

  // Mutation check: a directory drag is inert - setData is never called.
  const dirResult = dispatchDragStart(harness, panel.querySelector('[data-ide-tree-path="src"]'));
  assert.deepEqual(dirResult.writes, {}, 'directory dragstart writes no payload');
});
