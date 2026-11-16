// new-test-file: row 137 S2 cross-module gates for outside-Workspace documents; each case drives a different IDE feature module, so no single existing surface file owns them.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const outside = require('../renderer/features/renderer-ide-outside-files');
const keymap = require('../renderer/features/renderer-ide-keymap');
const { createIdeCommandRegistry } = require('../renderer/features/renderer-ide-command-registry');
const { registerIdePaletteCommands } = require('../renderer/features/renderer-ide-palette-commands');
const { createIdePathMenu } = require('../renderer/features/renderer-ide-path-menu');
const ideTabs = require('../renderer/features/renderer-ide-tabs');
const { createIdeTabStripEvents } = require('../renderer/features/renderer-ide-tab-strip-events');
const { createIdeSelectionIntents } = require('../renderer/features/renderer-ide-selection-intents');
const { createIdeStatusBar } = require('../renderer/features/renderer-ide-statusbar');
const { createIdeBreadcrumbs } = require('../renderer/features/renderer-ide-breadcrumbs');
const { escapeHtml } = require('../renderer/shared/string-utils');

const KEY = 'outside://o0123456789abcdef01234567/notes.md';
const KEY_B = 'outside://o89abcdef0123456789abcdef/notes.md';
const DIR = 'C:\\Users\\me\\Docs';
const FULL = 'C:\\Users\\me\\Docs\\notes.md';

function register(key = KEY, dirLabel = DIR, extra = {}) {
  outside.registerMeta(key, { dirLabel, encoding: 'utf-8', readOnly: false, ...extra });
}

function ctxFor(path, extra = {}) {
  return { ...keymap.buildCommandContext({ activeView: 'ide', ide: { activeTabPath: path }, isRepo: true }), ...extra };
}

test.afterEach(() => {
  outside.clearMeta();
  outside.bindActiveInstance(null);
});

test("activeKindOf returns 'outside' for an outside key", () => {
  register();
  const ctx = keymap.buildCommandContext({ activeView: 'ide', ide: { activeTabPath: KEY } });
  assert.equal(ctx.activeKind, 'outside');
  assert.equal(ctx.hasActiveFile, false);
  const ws = keymap.buildCommandContext({ activeView: 'ide', ide: { activeTabPath: 'src/a.js' } });
  assert.equal(ws.activeKind, 'file');
  assert.equal(ws.hasActiveFile, true);
  assert.equal(keymap.buildCommandContext({ activeView: 'ide', ide: { activeTabPath: 'diff://x/a.js' } }).activeKind, 'diff');
});

/* ---- palette (items 1, 2, 4, 12, 13) ---- */

function buildPalette(activePath, overrides = {}) {
  register();
  const registry = createIdeCommandRegistry();
  const lifecycleCalls = [];
  const copied = [];
  const toasts = [];
  const dispose = registerIdePaletteCommands(registry, {
    getIde: () => ({ activeTabPath: activePath, openTabs: [{ path: activePath }], dirtyByPath: {} }),
    state: { currentSessionId: 'sess-7' },
    getFileLifecycle: () => ({
      captureGitDiscard: (path) => { lifecycleCalls.push(['capture', path]); return { path }; },
      reloadAfterGitDiscard: async () => { lifecycleCalls.push(['reload']); },
      releaseGitDiscard: () => {},
    }),
    getClipboardApi: () => ({ writeText: async (text) => { copied.push(text); } }),
    getWorkspaceRoot: () => ({ rootPath: 'D:\\repo' }),
    showToastMessage: (message) => toasts.push(message),
    revealInExplorer: () => {},
    showPanel: () => {},
    runScripts: { runActiveFile: () => {} },
    gitFeature: { getActions: () => ({ stageAll() {}, openChanges() {}, openStagedChanges() {} }) },
    ...overrides,
  });
  return { registry, lifecycleCalls, copied, toasts, dispose };
}

test('palette: an outside document enables Revert/Copy Path/Attach and hides the Workspace-only and git rows', () => {
  const { registry } = buildPalette(KEY);
  const ids = registry.list({ ctx: ctxFor(KEY) }).map((row) => row.id);
  for (const id of ['ide:revert-file', 'ide:copy-path', 'ide:outside-attach']) assert.ok(ids.includes(id), id);
  for (const id of ['ide:copy-relative-path', 'ide:run-active-file', 'ide:reveal-active-file', 'ide:git-open-changes', 'ide:git-open-staged-changes', 'ide:git-next-change']) {
    assert.ok(!ids.includes(id), `${id} hidden for an outside key`);
  }
});

test('palette: a Workspace file keeps every hasActiveFile row and has no Attach row', () => {
  const { registry } = buildPalette('src/a.js');
  const ids = registry.list({ ctx: ctxFor('src/a.js') }).map((row) => row.id);
  for (const id of ['ide:revert-file', 'ide:copy-path', 'ide:copy-relative-path', 'ide:run-active-file', 'ide:reveal-active-file', 'ide:git-open-changes']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('ide:outside-attach'));
});

test('palette: Revert File on an outside key goes through the registry, never captureGitDiscard', async () => {
  const reverted = [];
  outside.bindActiveInstance({ revert: async (key) => { reverted.push(key); return { ok: true }; } });
  const { registry, lifecycleCalls } = buildPalette(KEY);
  await registry.get('ide:revert-file').run(ctxFor(KEY));
  assert.deepEqual(reverted, [KEY]);
  assert.deepEqual(lifecycleCalls, []);
});

test('palette: Revert File on a Workspace key still reloads through the lifecycle seam', async () => {
  const { registry, lifecycleCalls } = buildPalette('src/a.js');
  await registry.get('ide:revert-file').run(ctxFor('src/a.js'));
  assert.deepEqual(lifecycleCalls, [['capture', 'src/a.js'], ['reload']]);
});

test('palette: Copy Path copies the real path of an outside document, the root-joined path of a Workspace one', async () => {
  const outsideRun = buildPalette(KEY);
  await outsideRun.registry.get('ide:copy-path').run(ctxFor(KEY));
  assert.deepEqual(outsideRun.copied, [FULL]);
  const workspaceRun = buildPalette('src/a.js');
  await workspaceRun.registry.get('ide:copy-path').run(ctxFor('src/a.js'));
  assert.deepEqual(workspaceRun.copied, ['D:\\repo\\src\\a.js']);
});

test('palette: Attach File to Chat passes the current session and toasts a failure', async () => {
  const calls = [];
  outside.bindActiveInstance({ attachToChat: async (key, sessionId) => { calls.push([key, sessionId]); return { ok: false }; } });
  const { registry, toasts } = buildPalette(KEY);
  await registry.get('ide:outside-attach').run(ctxFor(KEY));
  assert.deepEqual(calls, [[KEY, 'sess-7']]);
  assert.deepEqual(toasts, ['Couldn’t attach notes.md.']);
  outside.bindActiveInstance({ attachToChat: async () => ({ ok: true }) });
  await registry.get('ide:outside-attach').run(ctxFor(KEY));
  assert.equal(toasts.length, 1, 'a success shows no failure toast');
});

test('palette: File: Open File... calls the picker bridge and is hidden without one', async () => {
  let picks = 0;
  const withBridge = buildPalette('src/a.js', { windowRef: { jennyShell: { outsideFiles: { pick: async () => { picks += 1; } } } } });
  const ctx = ctxFor('src/a.js');
  assert.ok(withBridge.registry.list({ ctx }).some((row) => row.id === 'ide:open-outside-file'));
  await withBridge.registry.get('ide:open-outside-file').run(ctx);
  assert.equal(picks, 1);
  const without = buildPalette('src/a.js', { windowRef: { jennyShell: {} } });
  assert.ok(!without.registry.list({ ctx }).some((row) => row.id === 'ide:open-outside-file'));
});

/* ---- path menu (item 4) ---- */

function pathMenu(extra = {}) {
  const copied = [];
  const toasts = [];
  const errors = [];
  const menu = createIdePathMenu({
    getWorkspaceFsApi: () => extra.api || { revealInFolder: async () => {}, openInDefaultApp: async () => {}, getRootState: async () => ({ workspaceRoot: 'D:\\repo' }) },
    windowRef: { jennyShell: { clipboard: { writeText: async (text) => { copied.push(text); } } } },
    showToastMessage: (message) => toasts.push(message),
    showShellErrorToast: (message) => errors.push(message),
  });
  return { menu, copied, toasts, errors };
}

test('path menu: an outside key offers Reveal and Copy Path with the real path, and hides Open in Default App and Copy Relative Path', async () => {
  register();
  const revealed = [];
  outside.bindActiveInstance({ reveal: async (key) => { revealed.push(key); return { ok: true }; } });
  const { menu, copied } = pathMenu();
  const items = menu.buildPathUtilityMenuItems(KEY, 'file').filter((item) => !item.separator);
  assert.deepEqual(items.map((item) => item.label), ['Reveal in File Explorer', 'Copy Path', 'Copy Name']);
  await items[0].action();
  assert.deepEqual(revealed, [KEY]);
  await items[1].action();
  assert.deepEqual(copied, [FULL]);
  await items[2].action();
  assert.deepEqual(copied, [FULL, 'notes.md']);
});

test('path menu: a failed outside reveal shows the existing failure toast', async () => {
  register();
  outside.bindActiveInstance({ reveal: async () => ({ ok: false }) });
  const { menu, errors } = pathMenu();
  await menu.buildPathUtilityMenuItems(KEY, 'file').find((item) => item.label === 'Reveal in File Explorer').action();
  assert.deepEqual(errors, ['Could not reveal the item.']);
});

test('path menu: a Workspace key keeps all five items and the root-relative Copy Path', async () => {
  const { menu, copied } = pathMenu();
  const items = menu.buildPathUtilityMenuItems('src/a.js', 'file').filter((item) => !item.separator);
  assert.deepEqual(items.map((item) => item.label), ['Reveal in File Explorer', 'Open in Default App', 'Copy Path', 'Copy Relative Path', 'Copy Name']);
  await items.find((item) => item.label === 'Copy Path').action();
  assert.deepEqual(copied, ['D:\\repo\\src\\a.js']);
});

/* ---- tabs (item 5) ---- */

function renderStrip(openTabs, extra = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="strip"></div></body>');
  const strip = dom.window.document.getElementById('strip');
  ideTabs.createIdeTabStrip({ getDom: () => ({ ideTabStrip: strip }), escapeHtml }).renderTabs({ openTabs, activeTabPath: openTabs[0].path, ...extra });
  return strip;
}

test('tabs: an outside tab tooltips the real path and two same-named outside tabs differ by their folder', () => {
  register(KEY, DIR);
  register(KEY_B, 'C:\\Users\\me\\Other');
  const strip = renderStrip([{ path: KEY, kind: 'file' }, { path: KEY_B, kind: 'file' }]);
  const labels = [...strip.querySelectorAll('.ide-tab-label')];
  assert.equal(labels[0].title, FULL);
  assert.equal(labels[1].title, 'C:\\Users\\me\\Other\\notes.md');
  assert.deepEqual([...strip.querySelectorAll('.ide-tab-dir')].map((el) => el.textContent), ['Docs', 'Other']);
  const stale = renderStrip([{ path: KEY, kind: 'file' }], { staleByPath: { [KEY]: true } });
  assert.equal(stale.querySelector('.ide-tab-label').title, `${FULL} - changed on disk`);
});

test('tabs: Workspace tabs keep the path tooltip and the folder suffix', () => {
  const strip = renderStrip([{ path: 'a/README.md', kind: 'file' }, { path: 'b/README.md', kind: 'file' }]);
  assert.deepEqual([...strip.querySelectorAll('.ide-tab-label')].map((el) => el.title), ['a/README.md', 'b/README.md']);
  assert.deepEqual([...strip.querySelectorAll('.ide-tab-dir')].map((el) => el.textContent), ['a', 'b']);
});

test('tab drag: text/plain carries the real path for an outside tab and the key for a Workspace tab', () => {
  register();
  const dom = new JSDOM('<!doctype html><body><div id="root"><div class="ide-tabbar"><div class="ide-tabstrip">'
    + `<div class="ide-tab" data-ide-tab="${KEY}" draggable="true"><button class="ide-tab-label" data-ide-tab-path="${KEY}"></button></div>`
    + '<div class="ide-tab" data-ide-tab="src/a.js" draggable="true"><button class="ide-tab-label" data-ide-tab-path="src/a.js"></button></div>'
    + '</div></div></div></body>');
  const root = dom.window.document.getElementById('root');
  const events = createIdeTabStripEvents({ root: root.querySelector('.ide-tabbar'), getStrip: () => root.querySelector('.ide-tabstrip'), groupId: '', callbacks: {} });
  const drag = (path) => {
    const event = new dom.window.Event('dragstart', { bubbles: true, cancelable: true });
    const store = {};
    event.dataTransfer = { types: [], setData: (mime, value) => { store[mime] = value; }, getData: (mime) => store[mime] || '' };
    root.querySelector(`[data-ide-tab="${path}"]`).dispatchEvent(event);
    return store;
  };
  const outsideDrag = drag(KEY);
  assert.equal(outsideDrag['text/plain'], FULL);
  assert.equal(JSON.parse(outsideDrag[ideTabs.TAB_MIME]).path, KEY, 'the group payload keeps the key');
  assert.equal(drag('src/a.js')['text/plain'], 'src/a.js');
  events.dispose();
});

/* ---- selection intents (item 6) ---- */

function intentsFor(path, sent, extra = {}) {
  const host = {
    getFocusedPath: () => path,
    getSelectedText: () => 'const x = 1;',
    getSelectionRange: () => ({ startLine: 2, endLine: 3 }),
    getFocusedLanguageId: () => 'markdown',
    addEditorAction() {},
  };
  return createIdeSelectionIntents({ editorHost: host, onSendToJenny: (payload) => sent.push(payload), ...extra });
}

test('selection intents: a code selection and a file send carry the real path of an outside document', () => {
  register();
  const sent = [];
  const intents = intentsFor(KEY, sent);
  intents.sendSelection('current');
  assert.equal(sent[0].path, FULL);
  intents.buildSendToJennyMenuItems(KEY).filter((item) => item.action).forEach((item) => item.action());
  assert.deepEqual(sent.slice(1).map((payload) => payload.path), [FULL, FULL]);
});

test('selection intents: Workspace paths are sent unchanged and an outside blame ask never reaches git', async () => {
  register();
  const sent = [];
  intentsFor('src/a.js', sent).sendSelection('current');
  assert.equal(sent[0].path, 'src/a.js');
  let blames = 0;
  const outsideIntents = intentsFor(KEY, sent, { gitClient: { blameRange: async () => { blames += 1; return { ok: false }; } } });
  assert.equal(await outsideIntents.sendBlameSummary('current'), false);
  assert.equal(blames, 0);
});

/* ---- breadcrumbs (item 7) ---- */

function renderCrumbs(activeTabPath, extra = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="sb"></div><nav id="bc"></nav></body>');
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  const doc = dom.window.document;
  const statusBar = createIdeStatusBar({
    getDom: () => ({ ideStatusBar: doc.getElementById('sb'), ideBreadcrumbs: doc.getElementById('bc') }),
    getIde: () => ({ activeTabPath, wordWrap: 'off' }),
    escapeHtml,
    callbacks: { getDocumentKind: () => 'file', ...extra },
  });
  statusBar.render();
  const restore = () => { globalThis.window = prevWindow; };
  return { dom, doc, host: doc.getElementById('bc'), restore };
}

test('breadcrumbs: folder crumbs of an outside document come from dirLabel and cannot be clicked', async () => {
  register();
  const { dom, host, restore } = renderCrumbs(KEY);
  try {
    const crumbs = [...host.querySelectorAll('.ide-crumb')];
    assert.deepEqual(crumbs.map((el) => el.textContent), ['C:', 'Users', 'me', 'Docs', 'notes.md']);
    assert.equal(host.querySelectorAll('[data-ide-crumb-path]').length, 0);
    assert.ok(crumbs.slice(0, 4).every((el) => el.disabled === true));
    assert.equal(host.querySelectorAll('[data-ide-crumb-leaf]').length, 1);
    // A click on a folder crumb lists nothing: it has no data-ide-crumb-path for the breadcrumbs handler.
    const listed = [];
    const crumbsModule = createIdeBreadcrumbs({
      getDom: () => ({ ideBreadcrumbs: host }),
      getIde: () => ({ activeTabPath: KEY }),
      getWorkspaceFsApi: () => ({ listDirectory: async (payload) => { listed.push(payload); return { entries: [] }; } }),
    });
    crumbsModule.bindEvents();
    crumbs[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(listed, []);
    crumbsModule.dispose();
  } finally {
    restore();
  }
});

test('breadcrumbs: a Workspace file keeps clickable folder crumbs', () => {
  const { host, restore } = renderCrumbs('src/deep/a.js');
  try {
    assert.deepEqual([...host.querySelectorAll('[data-ide-crumb-path]')].map((el) => el.dataset.ideCrumbPath), ['src', 'src/deep']);
  } finally {
    restore();
  }
});
