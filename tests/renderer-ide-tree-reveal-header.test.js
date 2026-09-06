'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeExplorerWiring } = require('../renderer/features/renderer-ide-explorer-wiring');
const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
const ideStateUtils = require('../renderer/features/renderer-ide-state');
const { buildIdeDom, createBridgeStub, settle } = require('./helpers/ide-tree-harness');

async function createTreeHarness({ files = {}, dirs = [], expanded = [], qol = true } = {}) {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files, dirs });
  const ide = ideStateUtils.createIdeUiState();
  const scrollCalls = [];
  ide.expandedDirs = new Set(expanded);
  domHarness.dom.window.Element.prototype.scrollIntoView = function scrollIntoView(options) {
    scrollCalls.push({ path: this.dataset.ideTreePath, options });
  };
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
  });
  tree.bindEvents();
  tree.refreshRoot();
  await settle(30);
  return {
    ...domHarness,
    bridge,
    ide,
    tree,
    scrollCalls,
    panel: domHarness.getDom().ideRailPanel,
    dispose() {
      tree.dispose();
      domHarness.dom.window.close();
    },
  };
}

async function createWiringHarness({ files = {}, qol = true } = {}) {
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files });
  const ide = ideStateUtils.createIdeUiState();
  const previousWindow = globalThis.window;
  let active = true;
  globalThis.window = domHarness.dom.window;
  const wiring = createIdeExplorerWiring({
    getDom: domHarness.getDom,
    getIde: () => ide,
    getWorkspaceFsApi: () => bridge.jennyShell.workspaceFs,
    openFile: () => {},
    buildFileContextMenuItems: () => [],
    buildPathUtilityMenuItems: () => [],
    schedulePersist: () => {},
    showShellErrorToast: () => {},
    appendClientLog: () => {},
    getGitFeature: () => null,
    getFeatureFlags: () => ({ workspace_explorer_qol: qol }),
    panelDeps: () => ({
      getMountEl: () => domHarness.getDom().ideRailPanel,
      isActivePanel: () => active,
    }),
  });
  wiring.bindAll();
  wiring.tree.refreshRoot();
  await settle(30);
  return {
    ...domHarness,
    bridge,
    ide,
    wiring,
    tree: wiring.tree,
    panel: domHarness.getDom().ideRailPanel,
    setActive(value) { active = value; },
    dispatch(path) {
      domHarness.dom.window.dispatchEvent(new domHarness.dom.window.CustomEvent(
        'ide:active-file-changed',
        { detail: { path } }
      ));
    },
    dispose() {
      wiring.disposeAll();
      if (previousWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = previousWindow;
      }
      domHarness.dom.window.close();
    },
  };
}

function clickHeaderAction(harness, action) {
  const button = harness.panel.querySelector(`[data-ide-tree-action="${action}"]`);
  assert.ok(button, `missing ${action} header action`);
  button.click();
}

async function commitInlineEdit(harness, name) {
  const input = harness.panel.querySelector('[data-ide-tree-edit-control]');
  assert.ok(input, 'expected inline create control');
  input.value = name;
  input.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
  }));
  await settle(40);
}

test('revealPath focus:false updates roving focus and scrolls without moving DOM focus', async (t) => {
  const harness = await createTreeHarness({
    files: { 'src/deep/a.js': 'a', 'src/deep/b.js': 'b' },
  });
  t.after(() => harness.dispose());
  const editor = harness.getDom().ideEditorFallback;
  editor.focus();
  const activeBefore = harness.dom.window.document.activeElement;

  await harness.tree.revealPath('src/deep/a.js', { focus: false });

  assert.equal(harness.ide.expandedDirs.has('src'), true);
  assert.equal(harness.ide.expandedDirs.has('src/deep'), true);
  const revealed = harness.panel.querySelector('[data-ide-tree-path="src/deep/a.js"]');
  assert.ok(revealed);
  assert.equal(revealed.tabIndex, 0);
  assert.equal(harness.dom.window.document.activeElement, activeBefore);
  assert.deepEqual(harness.scrollCalls.at(-1), {
    path: 'src/deep/a.js',
    options: { block: 'nearest' },
  });

  await harness.tree.revealPath('src/deep/b.js');
  const defaultReveal = harness.panel.querySelector('[data-ide-tree-path="src/deep/b.js"]');
  assert.equal(harness.dom.window.document.activeElement, defaultReveal);
  assert.equal(defaultReveal.tabIndex, 0);
});

test('auto-reveal expands the active file without stealing editor focus and yields to tree focus', async (t) => {
  const harness = await createWiringHarness({
    files: { 'src/deep/a.js': 'a', 'other/b.js': 'b', 'inactive/c.js': 'c' },
  });
  t.after(() => harness.dispose());
  const editor = harness.getDom().ideEditorFallback;
  editor.focus();

  harness.dispatch('src/deep/a.js');
  await settle(140);

  const revealed = harness.panel.querySelector('[data-ide-tree-path="src/deep/a.js"]');
  assert.ok(revealed);
  assert.equal(revealed.tabIndex, 0);
  assert.equal(harness.dom.window.document.activeElement, editor);

  const treeRow = harness.panel.querySelector('[data-ide-tree-path="src"]');
  treeRow.focus();
  harness.dispatch('other/b.js');
  await settle(120);
  assert.equal(harness.ide.expandedDirs.has('other'), false);
  assert.equal(harness.panel.querySelector('[data-ide-tree-path="other/b.js"]'), null);
  assert.equal(harness.dom.window.document.activeElement, treeRow);

  editor.focus();
  harness.setActive(false);
  harness.dispatch('inactive/c.js');
  await settle(120);
  assert.equal(harness.ide.expandedDirs.has('inactive'), false);
});

test('auto-reveal is flag-gated and dispose removes the listener and pending timer', async (t) => {
  const flagOff = await createWiringHarness({ files: { 'src/a.js': 'a' }, qol: false });
  const enabled = await createWiringHarness({ files: { 'src/a.js': 'a' } });
  t.after(() => {
    enabled.dispose();
    flagOff.dispose();
  });
  let flagOffCalls = 0;
  let enabledCalls = 0;
  flagOff.tree.revealPath = () => { flagOffCalls += 1; };
  enabled.tree.revealPath = () => { enabledCalls += 1; };

  flagOff.dispatch('src/a.js');
  enabled.dispatch('src/a.js');
  enabled.wiring.disposeAll();
  await settle(120);
  enabled.dispatch('src/a.js');
  await settle(100);

  assert.equal(flagOffCalls, 0);
  assert.equal(enabledCalls, 0);
});

test('auto-reveal ignores diff, preview, map, and other synthetic tab ids', async (t) => {
  const harness = await createWiringHarness({ files: { 'src/a.js': 'a' } });
  t.after(() => harness.dispose());
  const calls = [];
  harness.tree.revealPath = (...args) => { calls.push(args); };

  harness.dispatch('src/a.js');
  harness.dispatch('diff://head/src/a.js');
  harness.dispatch('preview://src/a.md');
  harness.dispatch('map://workspace');
  harness.dispatch('custom://synthetic');
  await settle(120);

  assert.deepEqual(calls, []);
});

test('QoL header actions create in the focused directory or file parent', async (t) => {
  const harness = await createTreeHarness({
    files: { 'src/a.js': 'a' },
    expanded: ['src'],
  });
  t.after(() => harness.dispose());

  const newFile = harness.panel.querySelector('[data-ide-tree-action="new-file"]');
  const newFolder = harness.panel.querySelector('[data-ide-tree-action="new-folder"]');
  assert.equal(newFile.getAttribute('aria-label'), 'New File');
  assert.equal(newFolder.getAttribute('aria-label'), 'New Folder');

  harness.panel.querySelector('[data-ide-tree-path="src"]').click();
  clickHeaderAction(harness, 'new-file');
  await commitInlineEdit(harness, 'from-dir.txt');
  assert.equal(harness.bridge.calls.createFile.at(-1).path, 'src/from-dir.txt');

  harness.panel.querySelector('[data-ide-tree-path="src/a.js"]').click();
  clickHeaderAction(harness, 'new-folder');
  const folderInput = harness.panel.querySelector('[data-ide-tree-edit-control]');
  assert.equal(folderInput.getAttribute('placeholder'), 'folder name');
  await commitInlineEdit(harness, 'from-file');
  assert.equal(harness.bridge.calls.createDirectory.at(-1).path, 'src/from-file');
});

test('QoL header creates at root with no focused row and is absent when flag off', async (t) => {
  const rootHarness = await createTreeHarness();
  const flagOff = await createTreeHarness({ files: { 'a.js': 'a' }, qol: false });
  t.after(() => {
    flagOff.dispose();
    rootHarness.dispose();
  });

  clickHeaderAction(rootHarness, 'new-file');
  await commitInlineEdit(rootHarness, 'root.txt');
  assert.equal(rootHarness.bridge.calls.createFile.at(-1).path, 'root.txt');
  assert.equal(flagOff.panel.innerHTML.includes('data-ide-tree-action="new-file"'), false);
  assert.equal(flagOff.panel.innerHTML.includes('data-ide-tree-action="new-folder"'), false);
});
