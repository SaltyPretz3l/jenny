'use strict';

// new-test-file: a new surface (the Board tab, its lazy load and the Board page); the BoardSource objects it talks to are tested in renderer-board-source.test.js.
// Two layers over jsdom: the shell (real top rail, real top-nav shell controller, a stand-in script loader that "loads"
// a file by requiring it) and the page (the real page, list, canvas and workbench over a bridge that is an in-memory source).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const layoutModel = require('../renderer/shared/workbench-layout-model');
const manifest = require('../renderer/shell/renderer-board-script-manifest');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBoardPage } = require('../renderer/features/board/board-page');
const { LAYOUT_KEY, OPEN_KEY } = require('../renderer/features/board/board-layout-store');

const MANIFEST_SRC = 'renderer/shell/renderer-board-script-manifest.js';
const PROJECT = 'project_alpha';
const OTHER = 'project_beta';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// ------------------------------------------------------------------ the shell: tab, lazy load

const SHELL_GLOBALS = ['window', 'document', 'rendererTopRailUtils'];

function shellHarness(t, { flag = true, activeView = 'chat', resolved = true, failing = [] } = {}) {
  const dom = new JSDOM('<!doctype html><body><nav id="topRail" class="toprail hidden"><div id="topRailTabs" role="tablist"></div><span id="topRailIndicator"></span></nav>'
    + '<div id="titlebarSettingsSlot"></div><section class="main-view board-view view-offscreen" id="boardView" inert aria-hidden="true"></section></body>',
  { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const saved = Object.fromEntries(SHELL_GLOBALS.map((key) => [key, globalThis[key]]));
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.rendererTopRailUtils = require('../renderer/shell/renderer-toprail-utils');
  const names = new Map(manifest.map(([src, name]) => [src, name]));
  const requested = [];
  window.scriptLoaderUtils = {
    ensureScript({ src, isReady }) {
      requested.push(src);
      if (failing.includes(src)) return Promise.resolve(false);
      if (src === MANIFEST_SRC) window.rendererBoardScriptManifest = manifest;
      else if (names.has(src) && !window[names.get(src)]) window[names.get(src)] = require(`../${src}`);
      return Promise.resolve(typeof isReady === 'function' ? isReady() : true);
    },
  };
  const state = { ui: { activeView }, features: { featureFlags: flag === null ? {} : { project_boards: flag }, availabilityResolved: resolved } };
  const views = [];
  const toasts = [];
  const doc = window.document;
  const setActiveView = (id) => { views.push(id); state.ui.activeView = id; controller.applyViewChrome(); };
  const controller = require('../renderer/shell/renderer-top-nav-shell').createTopNavShellController({
    state, windowRef: window, documentRef: doc,
    dom: { topRail: doc.getElementById('topRail'), topRailTabs: doc.getElementById('topRailTabs'), topRailIndicator: doc.getElementById('topRailIndicator') },
    callbacks: { setActiveView, showToastMessage: (...args) => toasts.push(args), getProjectSwitcher: async () => null },
  });
  t.after(() => {
    controller.dispose();
    window.close();
    for (const key of SHELL_GLOBALS) { if (saved[key] === undefined) delete globalThis[key]; else globalThis[key] = saved[key]; }
  });
  controller.applyViewChrome();
  return {
    window, doc, state, controller, requested, views, toasts,
    tabs: () => [...doc.querySelectorAll('#topRailTabs .toprail-tab')].map((el) => el.dataset.tabId),
    view: () => doc.getElementById('boardView'),
    open: () => setActiveView('board'),
  };
}

test('the Board tab is absent with project_boards off and present, labelled Board, with it on', (t) => {
  const off = shellHarness(t, { flag: false });
  assert.deepEqual(off.tabs(), ['home', 'chat', 'ide']);
  assert.equal(off.doc.getElementById('boardTopRailTab'), null);
  assert.equal(off.view().childElementCount, 0, 'no #boardView content');
  assert.deepEqual(off.requested, [], 'no script load');
  const on = shellHarness(t, { flag: true });
  assert.deepEqual(on.tabs(), ['home', 'chat', 'ide', 'board']);
  const tab = on.doc.getElementById('boardTopRailTab');
  assert.equal(tab.getAttribute('role'), 'tab');
  assert.equal(tab.getAttribute('aria-controls'), 'boardView');
  assert.equal(tab.querySelector('.toprail-tab__label').textContent, 'Board');
  assert.equal(require('../renderer/shell/renderer-toprail-utils').VIEW_TAB_ORDER.includes('board'), false, 'no number shortcut');
  const boot = shellHarness(t, { flag: null, resolved: false });
  assert.deepEqual(boot.tabs(), ['home', 'chat', 'ide'], 'the boot seed has no flag: no tab until the real flags merge');
  boot.state.features = { featureFlags: { project_boards: true }, availabilityResolved: true };
  boot.controller.applyViewChrome();
  assert.deepEqual(boot.tabs(), ['home', 'chat', 'ide', 'board']);
});

test('nothing of the Board loads before the tab is opened: no manifest, no script, no stylesheet, no global', async (t) => {
  const s = shellHarness(t);
  s.controller.applyViewChrome();
  s.controller.syncBoardTab();
  await flush();
  assert.deepEqual(s.requested, []);
  assert.equal(s.window.rendererBoardScriptManifest, undefined);
  for (const [, name] of manifest) assert.equal(s.window[name], undefined, name);
  assert.equal(s.doc.querySelector('link[rel="stylesheet"]'), null);
  assert.equal(s.view().childElementCount, 0);
  assert.equal(typeof manifest.styles[0], 'string');
  assert.ok(manifest.every(([src]) => src !== MANIFEST_SRC), 'the manifest is not in its own list');
});

test('opening the tab loads the manifest, then the whole group once, the styles once, and shows the page', async (t) => {
  const s = shellHarness(t);
  s.open();
  s.open();
  s.controller.applyViewChrome();
  await flush();
  assert.deepEqual(s.requested, [MANIFEST_SRC, ...manifest.map(([src]) => src)], 'the manifest first, then the group in order, each once');
  assert.equal(s.doc.querySelectorAll('link[rel="stylesheet"][data-board-style]').length, manifest.styles.length);
  assert.ok(s.view().querySelector('[data-board-workbench]'), 'the page is in #boardView');
  assert.ok(s.view().querySelector('[data-board-chat-host]') && s.view().querySelector('[data-board-changes-host]'));
  s.controller.applyViewChrome();
  s.open();
  await flush();
  assert.equal(s.requested.length, manifest.length + 1, 'a second open loads nothing');
  assert.equal(s.doc.querySelectorAll('link[rel="stylesheet"][data-board-style]').length, manifest.styles.length);
});

test('a page that cannot load shows Chat, and the next open tries again', async (t) => {
  const failing = [manifest[3][0]];
  const s = shellHarness(t, { failing });
  s.open();
  await flush();
  assert.equal(s.state.ui.activeView, 'chat');
  assert.deepEqual(s.views, ['board', 'chat']);
  failing.length = 0;
  s.open();
  await flush();
  assert.equal(s.state.ui.activeView, 'board');
  assert.ok(s.view().querySelector('[data-board-workbench]'));
});

test('a saved Board view with the flag off shows Chat and loads nothing', async (t) => {
  const s = shellHarness(t, { flag: false, activeView: 'board' });
  await flush();
  assert.equal(s.state.ui.activeView, 'chat');
  assert.deepEqual(s.requested, []);
});

test('leaving the Board parks the page (kept built), and the tab going away mid-view disposes it and falls back to Chat', async (t) => {
  const s = shellHarness(t);
  s.open();
  await flush();
  const built = s.view().querySelector('[data-board-workbench]'); assert.ok(built);
  s.state.ui.activeView = 'chat';
  s.controller.applyViewChrome();
  assert.equal(s.view().querySelector('[data-board-workbench]'), built, 'hidden: the page is parked, its DOM kept');
  s.open();
  await flush();
  assert.equal(s.view().querySelector('[data-board-workbench]'), built, 'shown again as it was left, not rebuilt');
  s.state.features.featureFlags.project_boards = false;
  s.controller.applyViewChrome();
  assert.equal(s.state.ui.activeView, 'chat');
  assert.equal(s.view().childElementCount, 0, 'flag off: the parked or shown page is disposed and its DOM cleared');
  s.open();
  assert.equal(s.state.ui.activeView, 'chat', 'with the flag off a Board view is not kept');
});

test('the Board is remembered as the active view, is full-bleed, and the chrome pipeline shows #boardView only for it', async (t) => {
  const s = shellHarness(t);
  const persistence = require('../renderer/shell/renderer-active-view-persistence');
  persistence.persistActiveView('board');
  assert.equal(persistence.readPersistedActiveView(), 'board');
  persistence.persistActiveView('chat');
  assert.equal(require('../renderer/shell/renderer-view-panel-registry').createViewPanelRegistry({ dom: {}, constants: {}, callbacks: {} }).getPanelDescriptor('board').panel, null);
  const chromePath = require.resolve('../renderer/chat/renderer-render-pipeline-chrome');
  delete require.cache[chromePath]; // it binds `window` when it loads
  const pipeline = require(chromePath).createChromePipeline({ state: s.state, dom: {}, callbacks: {} });
  t.after(() => { pipeline.dispose?.(); delete require.cache[chromePath]; });
  const view = s.view();
  s.state.ui.activeView = 'board';
  pipeline.renderLayout();
  assert.equal(view.classList.contains('active-view'), true);
  assert.equal(view.inert, false);
  assert.equal(view.getAttribute('aria-hidden'), 'false');
  assert.equal(view.classList.contains('view-offscreen'), false);
  s.state.ui.activeView = 'chat';
  pipeline.renderLayout();
  assert.equal(view.inert, true);
  assert.equal(view.classList.contains('view-offscreen'), true);
});

// ------------------------------------------------------------------ the page

const batchOf = (boardId, ops, n) => ({ batch_id: `fixture${n}`, board_id: boardId, actor: 'owner', ops });
const card = (n, kind, data, extra = {}) => ({ op: 'card.add', card: { id: uid(100 + n), kind, data, x: n * 220, y: 40, w: 200, h: 90, ...extra } });

function pageHarness(t, { seed = [], projectsOf, project = { id: PROJECT, name: 'Alpha' }, storage: sharedStorage, toasts: sharedToasts, allowMemorySource = false } = {}) {
  const dom = new JSDOM('<!doctype html><body><section id="boardView"></section></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  let tick = Date.parse('2026-11-13T10:00:00.000Z');
  let seq = 0;
  const source = createMemoryBoardSource({ model, now: () => new Date((tick += 1000)).toISOString(), makeId: () => uid(++seq), seed });
  const calls = [];
  let subscribers = 0;
  const bridge = new Proxy({}, {
    get: (_target, name) => {
      if (name === 'onChanged') return (listener) => { subscribers += 1; const off = source.onChanged(listener); return () => { subscribers -= 1; off(); }; };
      return (request) => { calls.push(name); return source[name](request); };
    },
  });
  let workspaceTouched = false;
  window.jennyShell = new Proxy({ boards: bridge }, { get: (target, name) => { if (String(name).startsWith('workspace')) workspaceTouched = true; return target[name]; } });
  let current = project;
  const switcherListeners = new Set();
  const switcher = {
    currentProject: () => current, refresh: async () => [],
    onProjectsChanged: (fn) => { switcherListeners.add(fn); return () => switcherListeners.delete(fn); },
  };
  const toasts = sharedToasts || [];
  const storage = sharedStorage || window.localStorage;
  const open = () => {
    const page = createBoardPage({
      container: window.document.getElementById('boardView'), windowRef: window, storage, allowMemorySource,
      getProjectSwitcher: async () => switcher, showToast: (message, options) => toasts.push({ message, ...options }),
    });
    t.after(() => page.dispose());
    return page;
  };
  t.after(() => window.close());
  const doc = window.document;
  const h = {
    window, doc, source, calls, toasts, switcher, storage, open,
    get subscribers() { return subscribers; },
    get workspaceTouched() { return workspaceTouched; },
    moveTo(next) { current = next; switcherListeners.forEach((fn) => fn([])); },
    switcherListeners,
    names: () => [...doc.querySelectorAll('[data-board-id] .session-row__title-text')].map((el) => el.textContent),
    row: (name) => [...doc.querySelectorAll('[data-board-id]')].find((el) => el.getAttribute('data-board-name') === name),
    openName: () => doc.querySelector('[data-board-id].active')?.getAttribute('data-board-name') || '',
    act: (row, action) => row.querySelector(`[data-board-action="${action}"]`),
    button: (action) => doc.querySelector(`[data-board-list] > .board-list__new [data-board-action="${action}"]`),
    editor: () => doc.querySelector('.inv-inline-title-editor'),
    async type(value, key = 'Enter') {
      const input = h.editor();
      input.value = value;
      input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      await flush();
    },
    cards: () => [...doc.querySelectorAll('.inv-board-card')],
    async boardWith(name, ops, projectId = PROJECT) {
      const board = (await source.create({ projectId, name })).board;
      if (ops && ops.length) assert.equal((await source.apply({ boardId: board.id, batch: batchOf(board.id, ops, board.id) })).ok, true);
      return board;
    },
    async start() { const page = open(); await page.started; await flush(); return page; },
  };
  return h;
}

test('the page draws three workbench columns of the board profile: the list, the canvas, empty chat and changes hosts', async (t) => {
  const h = pageHarness(t);
  await h.boardWith('Plan');
  await h.start();
  assert.deepEqual([...h.doc.querySelectorAll('[data-wb-view]')].map((el) => el.dataset.wbView).sort(), ['boards', 'changes', 'chat']);
  assert.ok(h.doc.querySelector('[data-wb-view="boards"] [data-board-list]'));
  assert.ok(h.doc.querySelector('.wb-stack--editor [data-board-centre] .inv-board-canvas'), 'the canvas stands where the editor stands');
  assert.equal(h.doc.querySelector('[data-board-chat-host]').childElementCount, 0);
  assert.equal(h.doc.querySelector('[data-board-changes-host]').childElementCount, 0);
  assert.equal(h.doc.querySelector('[data-board-project]').textContent, 'Alpha');
  assert.equal(h.openName(), 'Plan');
  assert.equal(h.doc.querySelector('[data-board-count]').textContent, '1 of 20 boards');
});

test('an empty project shows the empty list, a New board button and a hint in the canvas column; an empty board shows the canvas hint', async (t) => {
  const h = pageHarness(t);
  await h.start();
  assert.equal(h.doc.querySelector('[data-board-list-empty]').hidden, false);
  assert.equal(h.button('new').disabled, false);
  assert.match(h.doc.querySelector('[data-board-note]').textContent, /Create a board/);
  await (async () => { h.button('new').click(); await flush(); })();
  assert.deepEqual(h.names(), ['New board']);
  assert.equal(h.openName(), 'New board', 'a new board opens');
  assert.equal(h.editor().value, 'New board', 'its name opens as a field, like a new file'); await h.type('New board', 'Escape');
  assert.equal(h.doc.querySelector('[data-board-empty]').hidden, false);
  assert.match(h.doc.querySelector('[data-board-empty]').textContent, /^Double-click to add a note, drop a file or picture here/);
  assert.equal(h.doc.querySelector('[data-board-note]').hidden, true);
  h.button('new').click(); await flush(); await h.type('Roadmap');
  assert.deepEqual(h.names(), ['New board', 'Roadmap'], 'the second new board takes the typed name');
});

test('create, open, rename in place, and a refused name shown inline with the field reopened', async (t) => {
  const h = pageHarness(t);
  await h.boardWith('First');
  await h.boardWith('Second');
  await h.start();
  assert.equal(h.openName(), 'First');
  h.act(h.row('Second'), 'open').click();
  await flush();
  assert.equal(h.openName(), 'Second');
  h.act(h.row('Second'), 'rename').click();
  assert.ok(h.editor(), 'the name becomes a field');
  assert.equal(h.editor().maxLength, 200);
  await h.type('Renamed');
  assert.deepEqual(h.names(), ['First', 'Renamed']);
  assert.equal(h.editor(), null);
  h.act(h.row('Renamed'), 'rename').click();
  await h.type('bad\u0007name');
  assert.ok(h.editor(), 'the field is back');
  assert.equal(h.editor().value, 'bad\u0007name', 'with what was typed');
  assert.equal(h.editor().getAttribute('aria-invalid'), 'true');
  const message = h.doc.querySelector('[data-board-rename-error]');
  assert.equal(message.getAttribute('role'), 'alert');
  assert.match(message.textContent, /1 to 200 characters on one line/);
  assert.equal(h.editor().getAttribute('aria-describedby'), message.id);
  assert.deepEqual(h.names(), ['First', 'Renamed'], 'nothing changed');
  await h.type('Fixed');
  assert.deepEqual(h.names(), ['First', 'Fixed']);
  assert.equal(h.doc.querySelector('[data-board-rename-error]'), null);
  h.act(h.row('Fixed'), 'rename').click();
  await h.type('Fixed', 'Escape');
  assert.equal(h.editor(), null, 'Escape cancels');
});

test('duplicate adds a copy and opens it; delete shows "Board deleted. Undo" and Undo restores through the source', async (t) => {
  const h = pageHarness(t);
  const plan = await h.boardWith('Plan', [card(1, 'note', { text: 'kept' })]);
  await h.boardWith('Other');
  await h.start();
  h.act(h.row('Plan'), 'duplicate').click();
  await flush();
  assert.deepEqual(h.names(), ['Plan', 'Other', 'Plan copy']);
  assert.equal(h.openName(), 'Plan copy');
  assert.equal(h.cards().length, 1, 'the copy has the card');
  h.act(h.row('Plan copy'), 'delete').click();
  await flush();
  assert.deepEqual(h.names(), ['Plan', 'Other']);
  assert.equal(h.openName(), 'Plan', 'the next board opens');
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].message, 'Board deleted.');
  assert.equal(h.toasts[0].actions[0].label, 'Undo');
  assert.equal(h.toasts[0].actions[0].kind, 'primary');
  h.toasts[0].actions[0].onClick();
  await flush();
  assert.deepEqual(h.names(), ['Plan', 'Other', 'Plan copy']);
  assert.equal(h.openName(), 'Plan copy', 'the board that was open is open again');
  assert.equal(plan.id.startsWith('board_'), true);
});

test('at 20 boards New board is disabled with the reason as its tooltip, not hidden, and deleting one enables it', async (t) => {
  const h = pageHarness(t);
  for (let i = 0; i < 20; i += 1) await h.boardWith(`Board ${i}`);
  await h.start();
  const button = h.button('new');
  assert.ok(button, 'still there');
  assert.equal(button.disabled, true);
  assert.match(button.title, /already has 20 boards/);
  assert.match(h.doc.querySelector('[data-board-count]').textContent, /already has 20 boards/);
  button.click();
  await flush();
  assert.equal(h.names().length, 20);
  h.act(h.row('Board 5'), 'delete').click();
  await flush();
  assert.equal(h.button('new').disabled, false);
  assert.equal(h.doc.querySelector('[data-board-count]').textContent, '19 of 20 boards');
});

test('switching project reloads the list, and General is the project when there is none', async (t) => {
  const h = pageHarness(t);
  await h.boardWith('Alpha board');
  await h.boardWith('Beta board', null, OTHER);
  await h.boardWith('General board', null, 'project_general');
  await h.start();
  assert.deepEqual(h.names(), ['Alpha board']);
  h.moveTo({ id: OTHER, name: 'Beta' });
  await flush();
  assert.equal(h.doc.querySelector('[data-board-project]').textContent, 'Beta');
  assert.deepEqual(h.names(), ['Beta board']);
  assert.equal(h.openName(), 'Beta board');
  h.moveTo(null);
  await flush();
  assert.equal(h.doc.querySelector('[data-board-project]').textContent, 'General');
  assert.deepEqual(h.names(), ['General board']);
  h.moveTo({ id: PROJECT, name: 'Alpha' });
  await flush();
  assert.deepEqual(h.names(), ['Alpha board']);
});

test('a change from outside updates the list and the open board; one for another project is ignored', async (t) => {
  const h = pageHarness(t);
  const board = await h.boardWith('Plan');
  await h.start();
  assert.equal(h.cards().length, 0);
  const listsBefore = h.calls.filter((name) => name === 'list').length;
  await h.source.create({ projectId: OTHER, name: 'Elsewhere' });
  await flush();
  assert.equal(h.calls.filter((name) => name === 'list').length, listsBefore, 'another project: no re-read');
  assert.deepEqual(h.names(), ['Plan']);
  await h.source.create({ projectId: PROJECT, name: 'From elsewhere' });
  await flush();
  assert.deepEqual(h.names(), ['Plan', 'From elsewhere']);
  assert.equal(h.openName(), 'Plan', 'the open board stays open');
  await h.source.apply({ boardId: board.id, batch: batchOf(board.id, [card(1, 'note', { text: 'Added outside' })], 'ext1') });
  await flush();
  assert.equal(h.cards().length, 1);
  assert.equal(h.cards()[0].querySelector('[data-card-text]').textContent, 'Added outside');
  const getsBefore = h.calls.filter((name) => name === 'get').length;
  const second = (await h.source.list({ projectId: PROJECT })).boards[1];
  await h.source.apply({ boardId: second.id, batch: batchOf(second.id, [card(1, 'note', { text: 'On a board that is not open' })], 'ext2') });
  await flush();
  assert.equal(h.calls.filter((name) => name === 'get').length, getsBefore, 'a change to another board does not re-read the open one');
  await h.source.rename({ boardId: board.id, name: 'Plan v2' });
  await flush();
  assert.deepEqual(h.names(), ['Plan v2', 'From elsewhere']);
  await h.source.delete({ boardId: board.id });
  await flush();
  assert.equal(h.openName(), 'From elsewhere', 'the open board was deleted elsewhere: the next one opens');
  assert.equal(h.cards().length, 1, 'and it is drawn');
});

test('the canvas draws every card kind, a group and a connector from a document, and repaints only what an outside change touched', async (t) => {
  const h = pageHarness(t);
  const ops = [
    { op: 'group.add', group: { id: uid(10), title: 'Checkout', x: 0, y: 0, w: 640, h: 300 } },
    card(1, 'note', { text: 'Hold stock\nfor ten minutes', tone: 'amber' }, { group_id: uid(10) }),
    card(2, 'file', { path: 'src/checkout/checkout.js', title: '' }),
    card(3, 'image', { asset: 'a'.repeat(64), width: 640, height: 480, alt: 'Login screen' }),
    card(4, 'link', { url: 'https://docs.example.com/api', title: 'Payment API' }),
    card(5, 'chat', { session_id: 's1', message_id: 'm1', title: 'Walkthrough', excerpt: 'I put the hold on the board.' }),
    card(6, 'diagram', { scene: 'a -> b', title: 'Flow' }),
    { op: 'connector.add', connector: { id: uid(20), from: uid(101), to: uid(104), label: 'blocks', style: 'dashed' } },
  ];
  const board = await h.boardWith('Kinds', ops);
  await h.start();
  const byKind = (kind) => h.doc.querySelector(`.inv-board-card[data-card-kind="${kind}"]`);
  assert.equal(h.cards().length, 7, 'six cards and one group');
  assert.equal(byKind('group').querySelector('[data-card-title]').textContent, 'Checkout');
  assert.equal(byKind('note').querySelector('[data-card-text]').textContent, 'Hold stock\nfor ten minutes');
  assert.equal(byKind('note').getAttribute('data-tone'), 'amber');
  assert.equal(byKind('file').querySelector('[data-card-title]').textContent, 'checkout.js');
  assert.equal(byKind('file').querySelector('[data-card-meta]').textContent, 'src/checkout/checkout.js');
  assert.equal(byKind('image').querySelector('[data-card-title]').textContent, 'Login screen');
  assert.equal(byKind('image').querySelector('[data-card-meta]').textContent, '640 × 480');
  assert.equal(byKind('link').querySelector('[data-card-title]').textContent, 'Payment API');
  assert.equal(byKind('link').querySelector('[data-card-meta]').textContent, 'https://docs.example.com/api');
  assert.equal(byKind('chat').querySelector('[data-card-text]').textContent, 'I put the hold on the board.');
  assert.equal(byKind('diagram').querySelector('[data-card-title]').textContent, 'Flow');
  const connector = h.doc.querySelector('.inv-board-connectors [data-connector-id]');
  assert.ok(connector, 'a connector is drawn beneath the cards');
  assert.equal(connector.querySelector('text').textContent, 'blocks');
  assert.equal(connector.getAttribute('data-style'), 'dashed');
  const noteEl = byKind('note');
  const fileEl = byKind('file');
  const edit = { op: 'card.edit', id: uid(101), content_rev: 0, data: { text: 'Hold stock for twenty minutes' } };
  await h.source.apply({ boardId: board.id, batch: batchOf(board.id, [edit], 'ext3') });
  await flush();
  assert.equal(byKind('note'), noteEl, 'the same element is updated in place');
  assert.equal(noteEl.querySelector('[data-card-text]').textContent, 'Hold stock for twenty minutes');
  assert.equal(byKind('file'), fileEl);
  await h.source.apply({ boardId: board.id, batch: batchOf(board.id, [{ op: 'card.remove', id: uid(104) }], 'ext4') });
  await flush();
  assert.equal(byKind('link'), null, 'a removed card is removed');
  assert.equal(h.doc.querySelector('.inv-board-connectors [data-connector-id]'), null, 'and its connector with it');
  assert.equal(h.doc.querySelector('[data-board-empty]').hidden, true);
});

test('Fit and 100% are at the bottom right of the canvas and change the view', async (t) => {
  const h = pageHarness(t);
  await h.boardWith('Zoomable', [card(1, 'note', { text: 'x' })]);
  await h.start();
  const bar = h.doc.querySelector('.board-zoombar');
  assert.equal(bar.getAttribute('aria-label'), 'Zoom');
  const [fit, actual] = ['fit', 'actual'].map((name) => bar.querySelector(`[data-board-zoom="${name}"]`));
  assert.equal(fit.textContent, 'Fit');
  assert.equal(actual.textContent, '100%');
  assert.ok(fit.title && actual.title, 'each has a tooltip');
  const layer = h.doc.querySelector('.inv-board-layer');
  layer.parentElement.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
  const wheel = new h.window.WheelEvent('wheel', { deltaY: -400, ctrlKey: true, clientX: 400, clientY: 300, bubbles: true, cancelable: true });
  layer.parentElement.dispatchEvent(wheel);
  assert.notEqual(layer.style.transform, 'translate(0px, 0px) scale(1)', 'Ctrl+wheel zooms');
  actual.click();
  assert.match(layer.style.transform, /scale\(1\)$/);
  fit.click();
  assert.match(layer.style.transform, /^translate\(/);
});

test('hostile board names and card text are text: no element, no script, nothing runs', async (t) => {
  const h = pageHarness(t);
  const evil = '<img src=x onerror="window.__pwned=1">';
  const script = '</script><script>window.__pwned = 2</script>';
  const board = await h.boardWith(evil, [
    { op: 'group.add', group: { id: uid(10), title: script, x: 0, y: 0, w: 300, h: 200 } },
    card(1, 'note', { text: `${evil}\n${script}` }),
    card(2, 'link', { url: 'https://example.com/a', title: evil }),
    { op: 'connector.add', connector: { id: uid(20), from: uid(101), to: uid(102), label: script } },
  ]);
  await h.start();
  const root = h.doc.getElementById('boardView');
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('script'), null);
  assert.equal(h.window.__pwned, undefined);
  assert.equal(h.row(evil).querySelector('.session-row__title-text').textContent, evil);
  assert.ok(h.act(h.row(evil), 'delete').getAttribute('aria-label').includes(evil));
  assert.equal(h.cards().find((el) => el.getAttribute('data-card-kind') === 'note').querySelector('[data-card-text]').textContent, `${evil}\n${script}`);
  assert.equal(h.doc.querySelector('.inv-board-connectors text').textContent, script);
  await h.source.rename({ boardId: board.id, name: script });
  await flush();
  assert.equal(root.querySelector('script'), null);
  assert.equal(h.row(script).querySelector('.session-row__title-text').textContent, script);
});

test('a board the service could not read shows why in the canvas column and offers nothing to change', async (t) => {
  const h = pageHarness(t, { seed: [{ unreadable: { id: 'board_bad', project_id: PROJECT, name: 'Damaged', reason: 'corrupt' } }] });
  await h.start();
  assert.equal(h.openName(), 'Damaged');
  assert.match(h.doc.querySelector('[data-board-note]').textContent, /damaged/);
  assert.equal(h.cards().length, 0);
  assert.equal(h.doc.querySelector('.board-zoombar').hidden, true);
  h.act(h.row('Damaged'), 'rename').click();
  await h.type('Renamed');
  assert.match(h.doc.querySelector('[data-board-rename-error]').textContent, /cannot be changed/);
});

test('the open board and the column layout survive a reload, and a stored Workspace layout never gives the Board a Workspace view', async (t) => {
  const first = pageHarness(t);
  await first.boardWith('One');
  await first.boardWith('Two', [card(1, 'note', { text: 'second' })]);
  const page = await first.start();
  first.act(first.row('Two'), 'open').click();
  await flush();
  assert.equal(first.openName(), 'Two');
  const collapse = first.doc.querySelector('[data-wb-stack][data-kind="views"] [data-wb-action="collapse"]:not([aria-hidden])');
  assert.ok(first.doc.querySelector('.wb-stack-header'), 'the column headers are the workbench\'s own');
  const chatStack = first.doc.querySelector('[data-wb-view="chat"]').closest('[data-wb-stack]');
  chatStack.querySelector('[data-wb-action="collapse"]').click();
  await flush();
  assert.equal(chatStack.getAttribute('data-state'), 'collapsed');
  assert.ok(collapse !== undefined);
  const savedLayout = JSON.parse(first.storage.getItem(LAYOUT_KEY));
  assert.equal(savedLayout.profile, 'board');
  assert.deepEqual(layoutModel.listViews(savedLayout), ['boards', 'chat', 'changes']);
  assert.equal(JSON.parse(first.storage.getItem(OPEN_KEY))[PROJECT].startsWith('board_'), true);
  page.dispose();
  assert.equal(first.doc.getElementById('boardView').childElementCount, 0);
  // The same window, the same storage, a new page.
  const again = first.open();
  await again.started;
  await flush();
  assert.equal(first.openName(), 'Two', 'the open board came back');
  assert.equal(first.cards().length, 1);
  assert.equal(first.doc.querySelector('[data-wb-view="chat"]').closest('[data-wb-stack]').getAttribute('data-state'), 'collapsed', 'and the layout');
  assert.equal(first.workspaceTouched, false, 'nothing of the Workspace was read');
  assert.deepEqual(Object.keys(first.window.localStorage).sort(), [LAYOUT_KEY, OPEN_KEY]);
});

test('a Workspace layout in the Board slot is read as a Board layout: no explorer, terminal or editor group', async (t) => {
  const workspaceDefault = layoutModel.createDefaultLayout();
  const before = JSON.stringify(workspaceDefault);
  const h = pageHarness(t);
  h.storage.setItem(LAYOUT_KEY, JSON.stringify(workspaceDefault));
  await h.boardWith('Plan');
  await h.start();
  const ids = [...h.doc.querySelectorAll('[data-wb-view]')].map((el) => el.dataset.wbView).sort();
  assert.deepEqual(ids, ['boards', 'changes', 'chat']);
  assert.equal(h.doc.querySelector('[data-wb-view="explorer"], [data-wb-view="terminal"]'), null);
  assert.equal(h.doc.querySelectorAll('.wb-stack--editor').length, 1);
  assert.equal(JSON.stringify(layoutModel.createDefaultLayout()), before, 'the Workspace default is what it was');
  h.storage.setItem(LAYOUT_KEY, '{"v":1,"root":');
  const damaged = pageHarness(t, { storage: h.storage });
  await damaged.start();
  assert.deepEqual([...damaged.doc.querySelectorAll('[data-wb-view]')].map((el) => el.dataset.wbView).sort(), ['boards', 'changes', 'chat'], 'damaged storage reads as the default');
});

test('with no bridge, or one that answers disabled, the page offers nothing; the in-memory source is opt-in', async (t) => {
  for (const bridge of [undefined, { list: async () => ({ ok: false, reason: 'disabled' }), onChanged: () => () => {} }]) {
    for (const allowMemorySource of [false, true]) {
      const h = pageHarness(t, { allowMemorySource });
      if (bridge === undefined) delete h.window.jennyShell.boards; else h.window.jennyShell = { boards: bridge };
      await h.start();
      assert.equal(h.button('new').disabled, !allowMemorySource, 'with no store New board is disabled, not hidden');
      h.button('new').click();
      await flush();
      assert.deepEqual(h.names(), allowMemorySource ? ['New board'] : []);
      assert.equal(h.doc.querySelector('[data-board-note]').hidden, allowMemorySource, 'the canvas column says why');
    }
  }
});

test('dispose stops everything the page started: its source listener, its project listener, and its DOM', async (t) => {
  const h = pageHarness(t);
  await h.boardWith('Plan');
  const page = await h.start();
  assert.equal(h.subscribers, 1);
  assert.equal(h.switcherListeners.size, 1);
  page.dispose();
  assert.equal(h.subscribers, 0);
  assert.equal(h.switcherListeners.size, 0);
  assert.equal(h.doc.getElementById('boardView').childElementCount, 0);
  const calls = h.calls.length;
  await h.source.create({ projectId: PROJECT, name: 'After dispose' });
  h.moveTo({ id: OTHER, name: 'Beta' });
  await flush();
  assert.equal(h.calls.length, calls, 'no call after dispose');
  page.dispose();
});
