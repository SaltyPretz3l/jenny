// new-test-file: row 137 S2 gates for the Workspace-bound surfaces (explorer, git, run, preview, compare); split from renderer-ide-outside-gates.test.js to stay under the 600-line test cap.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const outside = require('../renderer/features/renderer-ide-outside-files');
const ideState = require('../renderer/features/renderer-ide-state');
const { escapeHtml } = require('../renderer/shared/string-utils');

const KEY = 'outside://o0123456789abcdef01234567/notes.md';
const KEY_B = 'outside://o89abcdef0123456789abcdef/notes.md';
const DIR = 'C:\\Users\\me\\Docs';
const FULL = 'C:\\Users\\me\\Docs\\notes.md';

function register(key = KEY, dirLabel = DIR, extra = {}) {
  outside.registerMeta(key, { dirLabel, encoding: 'utf-8', readOnly: false, ...extra });
}

test.afterEach(() => {
  outside.clearMeta();
  outside.bindActiveInstance(null);
});

/* ---- explorer reveal (item 8) ---- */

function lazyTreeHarness(files = { 'src/a.js': 'a' }) {
  const { buildIdeDom, createBridgeStub } = require('./helpers/ide-tree-harness');
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files });
  const ide = ideState.createIdeUiState();
  ide.expandedDirs = new Set();
  return { domHarness, bridge, ide };
}

test('explorer: revealPath skips an outside key (no expandedDirs change, no listing) and still reveals a Workspace path', async () => {
  const { settle } = require('./helpers/ide-tree-harness');
  const { createIdeTree } = require('../renderer/features/renderer-ide-tree');
  const { domHarness, bridge, ide } = lazyTreeHarness({ 'src/deep/a.js': 'a' });
  const tree = createIdeTree({
    getDom: domHarness.getDom,
    getIde: () => ide,
    getMountEl: () => domHarness.getDom().ideRailPanel,
    isActivePanel: () => true,
    getWorkspaceFsApi: () => bridge.jennyShell.workspaceFs,
    getMutationContext: async () => ({ rootId: 'root-test', generation: 1, phase: 'ready' }),
    preflightMutation: async () => ({ ready: true, paths: [] }),
    commitMutationPreflight: () => ({ committed: true }),
    cancelMutationPreflight: () => {},
  });
  tree.bindEvents();
  tree.refreshRoot();
  await settle(30);
  const listingsBefore = bridge.calls.listDirectory.length;
  await tree.revealPath(KEY, { expandSelf: true });
  await tree.revealPath(KEY, { focus: false });
  assert.equal(ide.expandedDirs.size, 0);
  assert.equal(bridge.calls.listDirectory.length, listingsBefore);
  await tree.revealPath('src/deep/a.js', { focus: false });
  assert.deepEqual([...ide.expandedDirs].sort(), ['src', 'src/deep']);
  tree.dispose();
  domHarness.dom.window.close();
});

test('explorer: auto-reveal ignores an outside active file and still follows a Workspace one', async () => {
  const { buildIdeDom, createBridgeStub, settle } = require('./helpers/ide-tree-harness');
  const { createIdeExplorerWiring } = require('../renderer/features/renderer-ide-explorer-wiring');
  const domHarness = buildIdeDom();
  const bridge = createBridgeStub({ files: { 'src/a.js': 'a' } });
  const ide = ideState.createIdeUiState();
  const previousWindow = globalThis.window;
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
    panelDeps: () => ({ getMountEl: () => domHarness.getDom().ideRailPanel, isActivePanel: () => true }),
  });
  try {
    wiring.bindAll();
    wiring.tree.refreshRoot();
    await settle(30);
    const revealed = [];
    wiring.tree.revealPath = (path) => { revealed.push(path); };
    const dispatch = (path) => domHarness.dom.window.dispatchEvent(new domHarness.dom.window.CustomEvent('ide:active-file-changed', { detail: { path } }));
    dispatch(KEY);
    await settle(140);
    assert.deepEqual(revealed, []);
    dispatch('src/a.js');
    await settle(140);
    assert.deepEqual(revealed, ['src/a.js']);
  } finally {
    wiring.disposeAll();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    domHarness.dom.window.close();
  }
});

/* ---- git (item 9) ---- */

function gitFeature(overrides = {}) {
  const { createIdeGitFeature } = require('../renderer/features/renderer-ide-git-feature');
  const calls = { fileAtHead: [], discard: [], confirm: 0, reads: [] };
  const store = {
    getFileAtHead: async (payload) => { calls.fileAtHead.push(payload); return { found: true, content: 'old\n' }; },
    discardFile: async (payload) => { calls.discard.push(payload); return { ok: true, discarded: true }; },
    getDecoration: (rel) => ({ 'a.js': 'modified', [KEY]: 'modified' })[rel] || null,
    getFolderRollup: () => null,
    getBranch: () => 'main',
    getDirtyCount: () => 0,
    isRepo: () => true,
    isAvailable: () => true,
    refresh() {},
    refreshNow: () => Promise.resolve(),
    beginRefreshHold: () => () => {},
    subscribe: () => () => {},
    dispose() {},
  };
  const ide = { openTabs: [], railPanel: 'explorer', dirtyByPath: {} };
  const feature = createIdeGitFeature({
    store,
    editorHost: { isDirty: () => false, openDiffDocument: async () => {}, activateDocument() {} },
    getIde: () => ide,
    getWorkspaceFsApi: () => ({ readFile: async (payload) => { calls.reads.push(payload.path); return { content: 'new\n' }; } }),
    renderTabs() {},
    schedulePersist() {},
    requestRender() {},
    onChange() {},
    appendClientLog() {},
    showShellErrorToast() {},
    confirmDialog: { confirm: async () => { calls.confirm += 1; return true; } },
    ...overrides,
  });
  return { feature, calls, ide };
}

test('git: compare, discard, decoration and the unsaved count skip an outside key and leave Workspace keys alone', async () => {
  const { feature, calls, ide } = gitFeature();
  assert.equal(await feature.openHeadCompare(KEY), false);
  assert.equal(await feature.confirmDiscard(KEY), false);
  assert.deepEqual(calls, { fileAtHead: [], discard: [], confirm: 0, reads: [] });
  assert.equal(feature.getDecoration(KEY), null);
  assert.equal(feature.getDecoration('a.js'), 'modified');
  ide.dirtyByPath = { [KEY]: true, 'a.js': true, 'b.js': false };
  assert.equal(feature.getUnsavedCount(), 1, 'the dirty outside document is not unsaved Workspace work');
  assert.equal(await feature.openHeadCompare('a.js'), true);
  assert.deepEqual(calls.fileAtHead, [{ path: 'a.js' }]);
});

test('git gutter: an outside active file never asks main for its HEAD copy; a Workspace file does', async () => {
  const { createIdeGutterDecorations } = require('../renderer/features/renderer-ide-gutter-decorations');
  const asked = [];
  const state = { active: KEY };
  const gutter = createIdeGutterDecorations({
    editorHost: {
      getActivePath: () => state.active,
      getDocumentKind: () => 'file',
      getValue: () => 'x\n',
      isLargeFile: () => false,
      setGutterDecorations: () => 0,
    },
    windowRef: { addEventListener() {}, removeEventListener() {} },
    gitClient: { getFileAtHead: async (payload) => { asked.push(payload.path); return { ok: true, found: true, content: 'x\n' }; } },
    clientUtils: {},
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });
  await gutter.recompute(KEY);
  assert.deepEqual(asked, []);
  state.active = 'a.js';
  await gutter.recompute('a.js');
  assert.deepEqual(asked, ['a.js']);
  gutter.dispose();
});

test('git inline blame: the cursor in an outside document asks for no blame; a Workspace cursor does', async () => {
  const { createIdeInlineBlame } = require('../renderer/features/renderer-ide-inline-blame');
  const { createFakeTimers } = require('./helpers/fake-timers');
  const timers = createFakeTimers();
  const asked = [];
  const model = { version: 1, getLineCount: () => 5, getLineMaxColumn: () => 5, deltaDecorations: () => [] };
  const state = { active: KEY };
  const blamer = createIdeInlineBlame({
    editorHost: { getActivePath: () => state.active, getModel: () => model, getAltVersionId: () => 1, getDocumentKind: () => 'file', isLargeFile: () => false },
    getIde: () => ({ inlineBlame: true }),
    headLineFor: (path, line) => line,
    headFor: () => ['line'],
    gitClient: { blameFile: async (payload) => { asked.push(payload.path); return { ok: true, found: true, lines: [] }; } },
    nowFn: () => Date.parse('2026-10-26T10:00:00.000Z'),
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });
  blamer.handleCursor(KEY, 2);
  timers.runPending();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, []);
  state.active = 'a.js';
  blamer.handleCursor('a.js', 2);
  timers.runPending();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(asked, ['a.js']);
});

/* ---- run and debug (item 10) ---- */

test('Run This File and Debug This File start nothing for an outside document', async () => {
  const { createIdeRunScripts } = require('../renderer/features/renderer-ide-run-scripts');
  const { createIdeDebugInspector } = require('../renderer/features/renderer-ide-debug-inspector');
  const editorHost = { getActivePath: () => KEY, getActiveLanguageId: () => 'javascript', isDirty: () => false };
  const started = [];
  const written = [];
  const toasts = [];
  const runner = createIdeRunScripts({
    editorHost,
    getWorkspaceRunTaskApi: () => ({ start: async (payload) => { started.push(payload); return { ok: true, taskId: 't' }; } }),
    showToastMessage: (message) => toasts.push(message),
    appendClientLog() {},
  });
  await runner.runActiveFile();
  const inspector = createIdeDebugInspector({
    editorHost,
    sendTerminalCommand: async (builder) => { written.push(builder); return true; },
    getWorkspacePtyApi: () => ({ onData: () => () => {} }),
    openTaskTerminal: async () => { written.push('terminal'); return null; },
    showToastMessage: (message) => toasts.push(message),
    appendClientLog() {},
  });
  await inspector.debugActiveFile();
  inspector.dispose();
  assert.deepEqual(started, []);
  assert.deepEqual(written, []);
  assert.equal(toasts.length, 2);
  assert.ok(toasts.every((message) => /outside the Workspace/.test(message)));
});

/* ---- quick open recent, welcome, chip (items 11, 12) ---- */

test('quick open recent: an outside document reads as its name over its folder; a Workspace file keeps its path', async () => {
  register();
  const { createIdeQuickOpen } = require('../renderer/features/renderer-ide-quick-open');
  const dom = new JSDOM('<!doctype html><body><div id="stage"></div></body>');
  const stage = dom.window.document.getElementById('stage');
  const opened = [];
  const quickOpen = createIdeQuickOpen({
    getDom: () => ({ ideEditorStage: stage }),
    escapeHtml,
    callbacks: {
      getWorkspaceFsApi: () => ({ async listAllFiles() { return { files: [], truncated: false }; } }),
      onOpenFile: (path) => opened.push(path),
      getRecentFiles: () => [KEY, 'src/b.js'],
      appendClientLog() {},
    },
  });
  quickOpen.toggleRecent();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const [outsideRow, workspaceRow] = [...stage.querySelectorAll('[data-ide-recent-files-path]')];
  assert.equal(outsideRow.dataset.ideRecentFilesPath, KEY, 'the row still opens the key');
  assert.equal(outsideRow.querySelector('.ide-recent-files-name').textContent, 'notes.md');
  assert.equal(outsideRow.querySelector('.ide-recent-files-path').textContent, DIR);
  assert.equal(outsideRow.title, FULL);
  assert.equal(workspaceRow.querySelector('.ide-recent-files-name').textContent, 'b.js');
  assert.equal(workspaceRow.querySelector('.ide-recent-files-path').textContent, 'src/b.js');
});

test('welcome recent files never record an outside key', async () => {
  const { createIdeWelcome } = require('../renderer/features/renderer-ide-welcome');
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const welcome = createIdeWelcome({
    getDom: () => ({ ideEmptyState: host }),
    actionButton: ({ dataset = {} }) => (dataset['ide-welcome-file'] ? `<button data-ide-welcome-file="${dataset['ide-welcome-file']}"></button>` : '<button></button>'),
  });
  welcome.noteOpened(KEY);
  welcome.seedRecent([KEY, 'src/a.js']);
  await welcome.render({ hasRoot: true });
  assert.deepEqual([...host.querySelectorAll('[data-ide-welcome-file]')].map((el) => el.dataset.ideWelcomeFile), ['src/a.js']);
  welcome.dispose();
});

test('active-file chip: an outside document offers no slice; a Workspace file still does', () => {
  const { computeActiveSlice } = require('../renderer/features/renderer-ide-active-file-context');
  const reader = (path) => ({
    getActivePath: () => path,
    getDocumentKind: () => 'file',
    isLargeFile: () => false,
    getCursorInfo: () => ({ lineNumber: 1, column: 1 }),
    getValue: () => 'one\ntwo\n',
  });
  assert.equal(computeActiveSlice(reader(KEY), 5), null);
  const slice = computeActiveSlice(reader('src/a.js'), 5);
  assert.equal(slice && slice.path, 'src/a.js');
});

/* ---- compare with saved (item 3) ---- */

function diffController(activePath, overrides = {}) {
  const { createIdeDiffController } = require('../renderer/features/renderer-ide-diff-controller');
  const opened = [];
  const toasts = [];
  const reads = [];
  const controller = createIdeDiffController({
    getIde: () => ({ openTabs: [], activeTabPath: activePath }),
    getDom: () => ({}),
    editorHost: {
      hasDocument: () => true,
      getValue: () => 'live buffer\n',
      openDiffDocument: async (payload) => { opened.push(payload); },
      activateDocument() {},
    },
    getWorkspaceFsApi: () => ({ readFile: async (payload) => { reads.push(payload.path); return { content: 'disk copy\n', mtimeMs: 1 }; } }),
    callbacks: { renderTabs() {}, showShellErrorToast: (message) => toasts.push(message), appendClientLog() {} },
    ...overrides,
  });
  return { controller, opened, toasts, reads };
}

test('compare with saved: an outside document reads its disk side from the registry and labels the tab with the file name', async () => {
  register();
  outside.bindActiveInstance({ readDisk: async () => ({ ok: true, content: 'disk copy\n' }) });
  const run = diffController(KEY);
  assert.equal(await run.controller.openUnsavedCompare(KEY), true);
  assert.deepEqual(run.reads, [], 'no Workspace read for an outside key');
  assert.equal(run.opened[0].original, 'disk copy\n');
  assert.equal(run.opened[0].modified, 'live buffer\n');
  assert.equal(run.opened[0].label, 'notes.md (unsaved vs saved)');
  run.controller.dispose();
});

test('compare with saved: a failed outside read shows the saved-copy failure and opens nothing; a Workspace key still reads by path', async () => {
  register();
  outside.bindActiveInstance({ readDisk: async () => ({ ok: false, code: 'outside_files_unavailable' }) });
  const failing = diffController(KEY);
  assert.equal(await failing.controller.openUnsavedCompare(KEY), false);
  assert.deepEqual(failing.opened, []);
  assert.deepEqual(failing.toasts, [`Could not read the saved copy of ${FULL}.`]);
  failing.controller.dispose();
  const workspace = diffController('src/app.js');
  assert.equal(await workspace.controller.openUnsavedCompare('src/app.js'), true);
  assert.deepEqual(workspace.reads, ['src/app.js']);
  assert.equal(workspace.opened[0].original, 'disk copy\n');
  workspace.controller.dispose();
});

/* ---- secondary group tab menu (item 4) ---- */

function groupMenuRig() {
  const { createIdeEditorGroupsWiring } = require('../renderer/features/renderer-ide-editor-groups-wiring');
  const dom = new JSDOM('<!doctype html><body><div id="ideMain"></div></body>');
  const doc = dom.window.document;
  const ide = ideState.createIdeUiState();
  for (const path of ['a.js', KEY, 'src/b.js']) ideState.openTab(ide, path);
  for (const tab of ide.openTabs) if (tab.path !== 'a.js') tab.group = 'editor-2';
  const viewDeps = {};
  const menus = [];
  const wiring = createIdeEditorGroupsWiring({
    getIde: () => ide,
    getDom: () => ({ ideMain: doc.getElementById('ideMain'), ideView: doc.body }),
    editorHost: { hasDocument: () => true },
    canHold: () => false,
    groupViewUtils: {
      createIdeEditorGroupView(deps) {
        viewDeps[deps.groupId] = deps;
        const el = doc.createElement('section');
        doc.body.appendChild(el);
        return { el, render() {}, dispose() { el.remove(); }, focus() {}, getViewState() { return null; }, forget() {} };
      },
    },
    contextMenu: { show: (options) => menus.push(options) },
    schedulePersist() {},
    getCloseOrchestrator: () => ({}),
  });
  wiring.bindEvents();
  wiring.reconcile();
  return { wiring, viewDeps, menus };
}

test('secondary group tab menu: an outside tab has no Reveal in Explorer View and the tab list shows its folder; a Workspace tab keeps both', () => {
  register();
  const rig = groupMenuRig();
  const labelsOf = (path) => {
    rig.viewDeps['editor-2'].onContextMenu(path, {});
    return rig.menus.at(-1).items.map((item) => item.label || '-');
  };
  assert.ok(!labelsOf(KEY).includes('Reveal in Explorer View'));
  assert.ok(labelsOf('src/b.js').includes('Reveal in Explorer View'));
  rig.viewDeps['editor-2'].onOverflow({});
  const listed = rig.menus.at(-1).items.map((item) => `${item.label || ''} ${item.description || item.detail || ''}`).join('|');
  assert.ok(listed.includes(DIR), 'the open-tabs list shows the real folder');
  assert.ok(!listed.includes('outside:'), 'never the key as a fake folder');
  rig.wiring.dispose();
});

/* ---- preview stage (item 14) ---- */

function previewRig(buffers) {
  const { createIdePreviewStage } = require('../renderer/features/renderer-ide-preview-stage');
  const dom = new JSDOM('<div id="idePreviewHost" class="hidden"></div>');
  const hostEl = dom.window.document.getElementById('idePreviewHost');
  const ide = ideState.createIdeUiState();
  const calls = { activations: [], persist: 0, markdown: [], frames: [] };
  globalThis.markdownUtils = {
    renderMarkdown: (source) => {
      calls.markdown.push(source);
      return '<p><img src="pic.png" alt="p"><img src="../up.png" alt="u"></p>';
    },
    renderInlineMermaidBlocks() {},
  };
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame: (host, source) => { calls.frames.push(String(source)); return { dispose() {}, requestId: 'f' }; },
  };
  const stage = createIdePreviewStage({
    getDom: () => ({ idePreviewHost: hostEl }),
    getIde: () => ide,
    ideStateUtils: ideState,
    escapeHtml,
    editorHost: { hasDocument: (path) => path in buffers, getValue: (path) => buffers[path] || '', getAltVersionId: () => 1 },
    getWorkspaceFsApi: () => ({}),
    getFileOperations: () => null,
    appendClientLog() {},
    activateStage: (surface) => calls.activations.push(surface),
    schedulePersist: () => { calls.persist += 1; },
    windowRef: dom.window,
  });
  const cleanup = () => {
    stage.dispose();
    delete globalThis.markdownUtils;
    delete globalThis.rendererHtmlArtifactFrameUtils;
  };
  return { stage, ide, hostEl, calls, cleanup };
}

const pngReply = async (key, relPath) => ({ ok: true, base64: 'AAAA', mime: 'image/png', size: 3, relPath });
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

test('preview: an outside Markdown document previews from its live buffer, loads relative images through the registry and is never persisted as previewPath', async () => {
  register();
  const asked = [];
  outside.bindActiveInstance({ readImage: async (key, relPath) => { asked.push([key, relPath]); return pngReply(key, relPath); } });
  const rig = previewRig({ [KEY]: '# Notes\n![p](pic.png)' });
  try {
    rig.ide.activeTabPath = KEY;
    const applied = rig.stage.open(KEY);
    assert.equal(applied, KEY);
    assert.equal(rig.ide.previewPath || '', '', 'the outside key is not stored as previewPath');
    assert.deepEqual(rig.calls.activations, ['preview']);
    ideState.setStageSurface(rig.ide, 'preview');
    rig.stage.sync(true);
    await flush();
    assert.match(rig.calls.markdown[0], /# Notes/);
    const images = [...rig.hostEl.querySelectorAll('.ide-preview-content img')];
    assert.equal(images[0].getAttribute('src'), 'data:image/png;base64,AAAA');
    assert.equal(images[1].getAttribute('src'), '../up.png', 'a path above the folder keeps the missing-image look');
    assert.deepEqual(asked, [[KEY, 'pic.png']]);
  } finally {
    rig.cleanup();
  }
});

test('preview: an outside HTML document inlines relative images through the registry', async () => {
  register(KEY_B, DIR);
  const html = '<h1>Hi</h1><img src="img/pic.png">';
  const key = 'outside://o89abcdef0123456789abcdef/page.html';
  outside.registerMeta(key, { dirLabel: DIR });
  const asked = [];
  outside.bindActiveInstance({ readImage: async (k, relPath) => { asked.push([k, relPath]); return pngReply(k, relPath); } });
  const rig = previewRig({ [key]: html });
  try {
    rig.ide.activeTabPath = key;
    rig.stage.open(key);
    ideState.setStageSurface(rig.ide, 'preview');
    rig.stage.sync(true);
    await flush();
    assert.deepEqual(asked, [[key, 'img/pic.png']]);
    assert.match(rig.calls.frames[0], /data:image\/png;base64,AAAA/);
  } finally {
    rig.cleanup();
  }
});

test('preview: a Workspace file still pins through previewPath, and an unrelated scheme is not previewable', async () => {
  const rig = previewRig({ 'docs/readme.md': '# R' });
  try {
    rig.ide.activeTabPath = 'docs/readme.md';
    assert.equal(rig.stage.open('docs/readme.md'), 'docs/readme.md');
    assert.equal(rig.ide.previewPath, 'docs/readme.md');
    assert.equal(rig.stage.open('http://example.com/readme.md'), '');
  } finally {
    rig.cleanup();
  }
});

/* ---- primary tab menu (item 4) ---- */

test('primary tab menu: an outside tab offers Compare with Saved when dirty but not Reveal in Explorer View; a Workspace tab keeps the latter', () => {
  register();
  const { createIdeTabsController } = require('../renderer/features/renderer-ide-tabs-controller');
  const dom = new JSDOM('<!doctype html><body><div id="view"><div class="ide-tabbar"><div class="ide-tabstrip">'
    + `<div class="ide-tab" data-ide-tab="${KEY}"><button class="ide-tab-label" data-ide-tab-path="${KEY}"></button></div>`
    + '<div class="ide-tab" data-ide-tab="src/a.js"><button class="ide-tab-label" data-ide-tab-path="src/a.js"></button></div>'
    + '</div></div></div></body>');
  const view = dom.window.document.getElementById('view');
  const menus = [];
  const previous = globalThis.inventoryContextMenu;
  globalThis.inventoryContextMenu = { show: (options) => menus.push(options) };
  const ide = { openTabs: [{ path: KEY, kind: 'file' }, { path: 'src/a.js', kind: 'file' }], activeTabPath: KEY };
  const controller = createIdeTabsController({
    getDom: () => ({ ideTabStrip: view.querySelector('.ide-tabstrip'), ideView: view }),
    getIde: () => ide,
    callbacks: { isDirty: () => true },
  });
  controller.bindEvents();
  try {
    const labelsAfterRightClick = (path) => {
      view.querySelector(`[data-ide-tab-path="${path}"]`).dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 4 }));
      return menus.at(-1).items.map((item) => item.label || '-');
    };
    const outsideLabels = labelsAfterRightClick(KEY);
    assert.ok(outsideLabels.includes('Compare with Saved'));
    assert.ok(!outsideLabels.includes('Reveal in Explorer View'));
    assert.ok(labelsAfterRightClick('src/a.js').includes('Reveal in Explorer View'));
  } finally {
    controller.dispose();
    if (previous === undefined) delete globalThis.inventoryContextMenu;
    else globalThis.inventoryContextMenu = previous;
  }
});
