'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeController } = require('../renderer/features/renderer-ide-controller');
const treeMarkupUtils = require('../renderer/features/renderer-ide-tree-markup');
const {
  buildIdeDom,
  createBridgeStub,
  settle,
} = require('./helpers/ide-tree-harness');

function createHarness({ qolEnabled = true } = {}) {
  const { dom, getDom } = buildIdeDom();
  const bridge = createBridgeStub({ files: { 'src/app.js': 'const app = true;' } });
  const previousWindow = globalThis.window;
  const previousMonacoUtils = globalThis.rendererMonacoEditorUtils;
  const previousSearchPanel = globalThis.rendererIdeSearchPanel;
  const previousTreeMarkup = globalThis.rendererIdeTreeMarkup;
  const searchCalls = [];
  let getPendingEdit = () => null;

  globalThis.window = dom.window;
  dom.window.jennyShell = bridge.jennyShell;
  globalThis.rendererMonacoEditorUtils = {
    ...require('../renderer/features/renderer-monaco-editor-utils'),
    async ensureMonacoEditorApi() {
      return null;
    },
    normalizeEditorLanguage: () => 'plaintext',
  };
  globalThis.rendererIdeSearchPanel = {
    createIdeSearchPanel: () => ({
      beginScopedSearch: (path) => searchCalls.push(path),
      bindEvents() {},
      dispose() {},
      isReplacing: () => false,
      renderSearchPanel() {},
      resetForRoot() {},
    }),
  };
  globalThis.rendererIdeTreeMarkup = {
    ...treeMarkupUtils,
    createIdeTreeMarkup(deps) {
      getPendingEdit = deps.getPendingEdit;
      return treeMarkupUtils.createIdeTreeMarkup(deps);
    },
  };

  const cleanups = [];
  const state = {
    ui: { activeView: 'ide', ide: null },
    features: { featureFlags: { workspace_explorer_qol: qolEnabled } },
  };
  const controller = createIdeController({
    state,
    getDom,
    registerCleanup: (cleanup) => cleanups.push(cleanup),
    workspaceRootService: {
      captureContext: async () => ({
        rootPath: 'G:/fake-root', rootId: 'root_fake', generation: 1, phase: 'ready',
      }),
    },
    callbacks: {
      appendClientLog() {},
      showShellErrorToast() {},
      toErrorMessage: (error, fallback) => String(error?.message || fallback || ''),
    },
  });

  return {
    bridge,
    controller,
    dom,
    getDom,
    getPendingEdit: () => getPendingEdit(),
    searchCalls,
    dispose() {
      for (const cleanup of cleanups.splice(0)) {
        try { cleanup(); } catch (_error) { /* noop */ }
      }
      globalThis.window = previousWindow;
      globalThis.rendererMonacoEditorUtils = previousMonacoUtils;
      globalThis.rendererIdeSearchPanel = previousSearchPanel;
      globalThis.rendererIdeTreeMarkup = previousTreeMarkup;
    },
  };
}

function menuLabels(doc) {
  return [...doc.body.querySelectorAll('.inv-context-menu-item')]
    .map((item) => item.querySelector('span')?.textContent || '');
}

function findMenuItem(doc, label) {
  return [...doc.body.querySelectorAll('.inv-context-menu-item')]
    .find((item) => item.querySelector('span')?.textContent === label) || null;
}

function openContextMenu(harness, element) {
  element.dispatchEvent(new harness.dom.window.MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 12,
    clientY: 24,
  }));
}

async function expandSourceFolder(harness) {
  await harness.controller.activateIde();
  await settle();
  const panel = harness.getDom().ideRailPanel;
  panel.querySelector('[data-ide-tree-path="src"]').click();
  await settle();
  return panel;
}

test('flag-on file menu creates files and folders in the file parent', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const panel = await expandSourceFolder(harness);
  const doc = harness.dom.window.document;

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="src/app.js"]'));
  assert.deepEqual(menuLabels(doc).slice(0, 4), ['New File', 'New Folder', 'Rename', 'Delete']);
  findMenuItem(doc, 'New File').click();
  await settle();

  assert.ok(panel.querySelector('[data-ide-tree-edit-control]'));
  assert.equal(harness.getPendingEdit()?.mode, 'create-file');
  assert.equal(harness.getPendingEdit()?.dirPath, 'src');
});

test('flag-on file menu scopes Find in Folder to the file parent', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const panel = await expandSourceFolder(harness);
  const doc = harness.dom.window.document;

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="src/app.js"]'));
  findMenuItem(doc, 'Find in Folder').click();
  await settle();

  assert.deepEqual(harness.searchCalls, ['src']);
});

test('flag-on file and directory Delete items use danger styling', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const panel = await expandSourceFolder(harness);
  const doc = harness.dom.window.document;

  for (const path of ['src/app.js', 'src']) {
    openContextMenu(harness, panel.querySelector(`[data-ide-tree-path="${path}"]`));
    assert.equal(findMenuItem(doc, 'Delete')?.classList.contains('inv-context-menu-item--danger'), true);
  }
});

test('flag-off file menu preserves its exact labels and ordinary Delete styling', async (t) => {
  const harness = createHarness({ qolEnabled: false });
  t.after(() => harness.dispose());
  const panel = await expandSourceFolder(harness);
  const doc = harness.dom.window.document;

  openContextMenu(harness, panel.querySelector('[data-ide-tree-path="src/app.js"]'));
  assert.deepEqual(menuLabels(doc), [
    'Rename',
    'Delete',
    'Open in New Tab',
    'Reveal in File Explorer',
    'Open in Default App',
    'Copy Path',
    'Copy Relative Path',
    'Copy Name',
    'Send to Jenny — current chat',
    'Send to Jenny — new chat',
  ]);
  assert.equal(findMenuItem(doc, 'Delete')?.classList.contains('inv-context-menu-item--danger'), false);
});
