'use strict';

// new-test-file: renderer-board-page.test.js is at its 600-line cap
// The Board page parked while another view is shown: kept built and idle, not disposed and rebuilt on every return.
// Two layers over jsdom: the shell (real top rail and top-nav shell controller, a script loader that "loads" a file by requiring it)
// and the page (the real page over an in-memory source, with the frame and size callbacks the test drives itself).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const manifest = require('../renderer/shell/renderer-board-script-manifest');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const boardPage = require('../renderer/features/board/board-page');
const { createBoardPage } = boardPage;
const { getSharedChatDock } = require('../renderer/features/renderer-ide-chat-dock');

const MANIFEST_SRC = 'renderer/shell/renderer-board-script-manifest.js';
const GENERAL = 'project_general';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function makeSource() {
  let seq = 0;
  let tick = Date.parse('2026-11-17T10:00:00.000Z');
  const source = createMemoryBoardSource({ model, now: () => new Date((tick += 1000)).toISOString(), makeId: () => uid(++seq) });
  const calls = [];
  let subscribers = 0;
  const bridge = new Proxy({}, {
    get: (_target, name) => {
      if (name === 'onChanged') return (listener) => { subscribers += 1; const off = source.onChanged(listener); return () => { subscribers -= 1; off(); }; };
      return (request) => { calls.push(name); return source[name](request); };
    },
  });
  return { source, calls, bridge, subscribers: () => subscribers };
}

// ------------------------------------------------------------------ the shell

const SHELL_GLOBALS = ['window', 'document', 'rendererTopRailUtils'];

function shellHarness(t, { flag = true } = {}) {
  const dom = new JSDOM('<!doctype html><body><nav id="topRail" class="toprail hidden"><div id="topRailTabs" role="tablist"></div><span id="topRailIndicator"></span></nav>'
    + '<div id="titlebarSettingsSlot"></div><section class="main-view board-view view-offscreen" id="boardView" inert aria-hidden="true"></section></body>',
  { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const saved = Object.fromEntries(SHELL_GLOBALS.map((key) => [key, globalThis[key]]));
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.rendererTopRailUtils = require('../renderer/shell/renderer-toprail-utils');
  const names = new Map(manifest.map(([src, name]) => [src, name]));
  window.scriptLoaderUtils = {
    ensureScript({ src, isReady }) {
      if (src === MANIFEST_SRC) window.rendererBoardScriptManifest = manifest;
      else if (names.has(src) && !window[names.get(src)]) window[names.get(src)] = require(`../${src}`);
      return Promise.resolve(typeof isReady === 'function' ? isReady() : true);
    },
  };
  const boards = makeSource();
  window.jennyShell = { boards: boards.bridge };
  const state = { ui: { activeView: 'chat' }, features: { featureFlags: { project_boards: flag }, availabilityResolved: true } };
  const doc = window.document;
  const setActiveView = (id) => { state.ui.activeView = id; controller.applyViewChrome(); };
  const controller = require('../renderer/shell/renderer-top-nav-shell').createTopNavShellController({
    state, windowRef: window, documentRef: doc,
    dom: { topRail: doc.getElementById('topRail'), topRailTabs: doc.getElementById('topRailTabs'), topRailIndicator: doc.getElementById('topRailIndicator') },
    callbacks: { setActiveView, showToastMessage: () => {}, getProjectSwitcher: async () => null },
  });
  t.after(() => {
    controller.dispose();
    window.close();
    for (const key of SHELL_GLOBALS) { if (saved[key] === undefined) delete globalThis[key]; else globalThis[key] = saved[key]; }
  });
  controller.applyViewChrome();
  return {
    window, state, controller, boards,
    view: () => doc.getElementById('boardView'),
    workbench: () => doc.getElementById('boardView').querySelector('[data-board-workbench]'),
    lists: () => boards.calls.filter((name) => name === 'list').length,
    open: () => setActiveView('board'),
    leave: () => setActiveView('chat'),
  };
}

test('leave and return keeps the same workbench element, and the source is not read again', async (t) => {
  const s = shellHarness(t);
  await s.boards.source.create({ projectId: GENERAL, name: 'Plan' });
  s.open();
  await flush();
  const workbench = s.workbench();
  assert.ok(workbench, 'the page is built on the first visit');
  const listsAtFirstVisit = s.lists();
  assert.ok(listsAtFirstVisit >= 1);

  s.leave();
  assert.equal(s.workbench(), workbench, 'the same element is still in #boardView while another view is active');
  assert.equal(workbench.isConnected, true);
  assert.equal(s.boards.subscribers(), 1, 'a parked page keeps its source listener');
  s.leave();
  s.controller.syncBoardTab();
  assert.equal(s.workbench(), workbench, 'more redraws while away change nothing');

  s.open();
  await flush();
  assert.equal(s.workbench(), workbench, 'no rebuild on return');
  assert.equal(s.lists(), listsAtFirstVisit, 'the list is not read again on return');
  assert.equal(s.view().querySelector('[data-board-id].active')?.getAttribute('data-board-name'), 'Plan');
  s.open();
  s.controller.syncBoardTab();
  assert.equal(s.workbench(), workbench, 'repeated shows while on the Board keep the page');
  assert.equal(s.lists(), listsAtFirstVisit);
});

test('with the flag off the page is disposed and #boardView is cleared, parked or not', async (t) => {
  const s = shellHarness(t);
  s.open();
  await flush();
  s.leave();
  assert.ok(s.workbench(), 'parked');
  s.state.features.featureFlags.project_boards = false;
  s.controller.applyViewChrome();
  assert.equal(s.view().childElementCount, 0);
  assert.equal(s.boards.subscribers(), 0, 'the source listener is gone with the page');
});

// ------------------------------------------------------------------ the page

function pageHarness(t, { team = false, state = null, extra = '' } = {}) {
  const dom = new JSDOM(`<!doctype html><body><section id="boardView"></section>${extra}</body>`, { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  // The test owns frames and size callbacks: a frame is "rendered" only when runFrames() is called.
  const frames = new Map();
  let nextFrame = 0;
  window.requestAnimationFrame = (fn) => { frames.set(++nextFrame, fn); return nextFrame; };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  const observers = [];
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.live = false; observers.push(this); }
    observe() { this.live = true; }
    disconnect() { this.live = false; }
  };
  const boards = makeSource();
  window.jennyShell = { boards: boards.bridge };
  if (team) {
    window.jennyShell.team = {
      onBoard: () => () => {},
      boardList: async () => ({ ok: true, boards: [] }),
      boardOpen: async () => ({ ok: false, reason: 'not_found' }),
      boardClose: async () => ({ ok: true }),
    };
  }
  const switcher = { currentProject: () => ({ id: GENERAL, name: 'General' }), refresh: async () => [], onProjectsChanged: () => () => {} };
  const page = createBoardPage({ container: doc.getElementById('boardView'), windowRef: window, storage: window.localStorage, state: state || undefined, getProjectSwitcher: async () => switcher });
  t.after(() => { page.dispose(); window.close(); });
  return {
    window, doc, page, frames, observers, boards,
    runFrames: () => { const todo = [...frames.values()]; frames.clear(); todo.forEach((fn) => fn()); return todo.length; },
    names: () => [...doc.querySelectorAll('[data-board-id] .session-row__title-text')].map((el) => el.textContent),
    async start() { await page.started; await flush(); return page; },
  };
}

test('while parked a size callback or a source change reads and renders nothing; resume catches up once and keeps what was open', async (t) => {
  const h = pageHarness(t);
  await h.boards.source.create({ projectId: GENERAL, name: 'One' });
  const { board: two } = await h.boards.source.create({ projectId: GENERAL, name: 'Two' });
  await h.start();
  h.runFrames();
  await h.page.openBoard(two.id);
  h.runFrames();
  const workbench = h.doc.querySelector('[data-board-workbench]');
  const [observer] = h.observers;
  assert.equal(observer.live, true);

  h.page.park();
  assert.equal(h.page.isParked(), true);
  assert.equal(observer.live, false, 'the size observer is disconnected');
  assert.equal(h.doc.querySelector('[data-board-workbench]'), workbench, 'the DOM is kept');
  observer.callback([]); // a view-offscreen container measures 0x0: it must never be fitted to that
  await h.boards.source.create({ projectId: GENERAL, name: 'Three' });
  await flush();
  assert.equal(h.frames.size, 0, 'no frame is asked for while parked');
  assert.deepEqual(h.names(), ['One', 'Two'], 'a hidden page does not read the list again');

  h.page.resume();
  assert.equal(h.page.isParked(), false);
  assert.equal(observer.live, true, 'the observer is connected again');
  assert.equal(h.frames.size, 1, 'one render is asked for');
  assert.equal(h.runFrames(), 1);
  await flush();
  assert.deepEqual(h.names(), ['One', 'Two', 'Three'], 'the change made while away is read once on return');
  h.runFrames();
  h.page.resume();
  assert.equal(h.frames.size, 0, 'resume while live does nothing');
  assert.equal(h.doc.querySelector('[data-board-workbench]'), workbench);
  assert.equal(h.page.getOpenBoardId(), two.id, 'the open board is as it was');
  assert.equal(h.doc.querySelector('[data-board-id].active').getAttribute('data-board-name'), 'Two');
});

test('a board picked from the palette or the pin menu while parked is the one shown on return', async (t) => {
  // Both call the module's openBoard before they move to the Board tab.
  const h = pageHarness(t);
  const { board: one } = await h.boards.source.create({ projectId: GENERAL, name: 'One' });
  const { board: two } = await h.boards.source.create({ projectId: GENERAL, name: 'Two' });
  h.page.dispose();
  const options = { container: h.doc.getElementById('boardView'), windowRef: h.window, storage: h.window.localStorage, getProjectSwitcher: async () => null };
  t.after(() => boardPage.hideBoardPage());
  const page = boardPage.showBoardPage(options);
  await page.started;
  await flush();
  await page.openBoard(one.id);
  boardPage.parkBoardPage();
  await boardPage.openBoard(two.id);
  await flush();
  assert.equal(boardPage.showBoardPage(options), page, 'resumed, not rebuilt');
  assert.equal(page.getOpenBoardId(), two.id, 'the picked board is open on return');
});

test('resume always draws once, even with nothing changed (a load that landed hidden may owe its fit)', async (t) => {
  const h = pageHarness(t);
  await h.start();
  h.runFrames();
  h.page.park();
  h.page.resume();
  assert.equal(h.runFrames(), 1);
  assert.equal(h.frames.size, 0, 'and only once');
});

test('on a project of this Jenny the team half is let go on park and attached again on resume', async (t) => {
  const h = pageHarness(t);
  const made = [];
  h.window.rendererTeamTabGate = { ensureTeamAssets: async () => true };
  h.window.rendererSettingsScriptManifest = { teamBoard: [] };
  h.window.rendererBoardTeam = { attachBoardTeam: () => { const part = { disposed: 0, sync() {}, dispose() { part.disposed += 1; } }; made.push(part); return part; } };
  await h.start();
  await flush();
  assert.equal(made.length, 1, 'the team half is attached while the Board is shown');
  h.page.park();
  assert.equal(made[0].disposed, 1, 'parking lets it go (it holds team stores)');
  h.page.resume();
  await flush();
  assert.equal(made.length, 2, 'resume attaches a fresh one');
  assert.equal(made[1].disposed, 0);
});

test('a team half still loading when the page parks is not attached to the hidden page; resume attaches it', async (t) => {
  const h = pageHarness(t);
  const made = [];
  let release = null;
  h.window.rendererTeamTabGate = { ensureTeamAssets: () => new Promise((resolve) => { release = () => resolve(true); }) };
  h.window.rendererSettingsScriptManifest = { teamBoard: [] };
  h.window.rendererBoardTeam = { attachBoardTeam: () => { const part = { sync() {}, dispose() {} }; made.push(part); return part; } };
  await h.start();
  await flush();
  h.page.park();
  release();
  await flush();
  assert.equal(made.length, 0, 'parked meanwhile: nothing attached');
  h.window.rendererTeamTabGate = { ensureTeamAssets: async () => true };
  h.page.resume();
  await flush();
  assert.equal(made.length, 1, 'resume attaches it');
});

test('a team-project page is disposed on park, so no team presence outlives a hidden Board', async (t) => {
  const h = pageHarness(t, { team: true });
  await h.start();
  h.page.pickProject({ id: 'project_shared', name: 'Shared', team: { id: 'team_one', name: 'One' }, role: () => 'writer' });
  await flush();
  assert.ok(h.page.getTeamSource(), 'a team project is shown');
  h.page.park();
  assert.equal(h.page.isDisposed(), true);
  assert.equal(h.doc.getElementById('boardView').childElementCount, 0);
  assert.equal(h.boards.subscribers(), 0);
});

test('the module: parkBoardPage keeps the page for the next show, and a team page is dropped', async (t) => {
  const h = pageHarness(t);
  h.page.dispose();
  const options = { container: h.doc.getElementById('boardView'), windowRef: h.window, storage: h.window.localStorage, getProjectSwitcher: async () => null };
  t.after(() => boardPage.hideBoardPage());
  const first = boardPage.showBoardPage(options);
  await first.started;
  boardPage.parkBoardPage();
  assert.equal(first.isParked(), true);
  boardPage.parkBoardPage();
  assert.equal(boardPage.showBoardPage(options), first, 'the parked page is resumed, not rebuilt');
  assert.equal(first.isParked(), false);
  assert.equal(boardPage.openBoard('x') instanceof Promise, true);
  boardPage.parkBoardPage();
  assert.equal(boardPage.revealChanges(), false, 'the Changes view of a parked page is not revealed from outside');
  boardPage.hideBoardPage();
  assert.equal(first.isDisposed(), true, 'hideBoardPage is still the full dispose');
  boardPage.parkBoardPage(); // nothing up: nothing happens
});

test('park gives the dock element back to where it was; resume docks the chat again', async (t) => {
  const extra = `<section id="chatView"><div id="chatThreadStage"><div id="chatThreadScroll"><div id="chatTimeline"></div></div></div>
    <div id="composerWrap"><textarea id="chatInput"></textarea></div><div id="artifactReviewResizer"></div></section>
    <section id="ideView"><div id="ideShell"><div id="ideWorkspaceChatHost"></div><div id="ideStatusBar"></div>
    <aside id="ideChatDock" class="hidden"><header id="ideChatDockHeader"></header><div id="ideChatDockBody"></div></aside></div></section>`;
  const state = { ui: { activeView: 'board' }, features: { featureFlags: { project_boards: true, ide_chat_dock: true } }, sessions: [], currentSessionId: '' };
  const h = pageHarness(t, { state, extra });
  t.after(() => getSharedChatDock(state)?.dispose?.());
  await h.start();
  const aside = () => h.doc.getElementById('ideChatDock');
  const host = h.doc.querySelector('[data-board-chat-host]');
  assert.equal(aside().parentNode, host, 'on screen the dock element is in the Board column');

  state.ui.activeView = 'chat';
  h.page.park();
  assert.equal(aside().parentNode, h.doc.getElementById('ideShell'), 'parked: the dock element is back in the Workspace');
  assert.equal(state.ui.boardChatDockOpen, false);
  assert.equal(state.ui.boardChat || null, null);
  assert.ok(h.doc.querySelector('[data-board-workbench]'), 'the page itself is kept');

  state.ui.activeView = 'board';
  h.page.resume();
  await flush();
  assert.equal(aside().parentNode, host, 'resumed: the chat is docked in the Board column again');
  assert.equal(state.ui.boardChatDockOpen, true);
});
