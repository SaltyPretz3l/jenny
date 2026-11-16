'use strict';

// new-test-file: a new surface (the chat docked beside the board, row 150 slice C1); renderer-board-page.test.js is at its line cap.
// The real Board page, its real workbench and the real chat dock controller over jsdom, with the Workspace as a second page of the
// same controller where a test needs both.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBoardPage } = require('../renderer/features/board/board-page');
const { createIdeChatDock, getSharedChatDock } = require('../renderer/features/renderer-ide-chat-dock');
const { createIdeChatSessionPicker } = require('../renderer/features/renderer-ide-chat-session-picker');
const { isChatSurfaceLive, isDockedChatLive } = require('../renderer/chat/renderer-chat-surface-live-utils');
const { chatProjectOf } = require('../renderer/features/board/board-chat-dock');

const ALPHA = { id: 'project_alpha', name: 'Alpha' };
const BETA = { id: 'project_beta', name: 'Beta <img src=x onerror=boom()>' };
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function harness(t, { activeView = 'board', flag = true, sessions, currentSessionId = 's1', project = ALPHA } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <button id="newChatButton"></button>
    <section id="chatView">
      <div id="chatThreadStage"><div id="chatThreadScroll"><div id="chatTimeline"></div></div></div>
      <div id="composerWrap"><textarea id="chatInput"></textarea></div>
      <div id="artifactReviewResizer"></div>
    </section>
    <section id="ideView"><div id="ideShell">
      <div id="ideWorkspaceChatHost"></div>
      <div id="ideStatusBar"></div>
      <aside id="ideChatDock" class="hidden"><header id="ideChatDockHeader"></header><div id="ideChatDockBody"></div></aside>
    </div></section>
    <section id="boardView"></section>
  </body>`, { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const byId = (id) => doc.getElementById(id);
  let seq = 0;
  let tick = Date.parse('2026-11-13T10:00:00.000Z');
  const source = createMemoryBoardSource({ model, now: () => new Date((tick += 1000)).toISOString(), makeId: () => uid(++seq) });
  window.jennyShell = { boards: source };
  const state = {
    ui: { activeView },
    features: { featureFlags: { project_boards: flag, ide_chat_dock: true } },
    sessions: sessions || [
      { id: 's1', title: 'Alpha chat', session_type: 'chat', project_id: ALPHA.id, updated_at: '2026-11-13T09:00:00Z' },
      { id: 's2', title: 'Beta chat', session_type: 'chat', project_id: BETA.id, updated_at: '2026-11-13T11:00:00Z' },
      { id: 's3', title: 'General chat', session_type: 'chat', updated_at: '2026-11-13T10:00:00Z' },
    ],
    currentSessionId,
  };
  let current = project;
  const switcherListeners = new Set();
  const switcher = {
    currentProject: () => current, refresh: async () => [],
    projectById: (id) => [ALPHA, BETA].find((entry) => entry.id === id) || null,
    onProjectsChanged: (fn) => { switcherListeners.add(fn); return () => switcherListeners.delete(fn); },
  };
  const opened = [];
  const hostChanges = [];
  window.rendererAppPaneComposition = { getPaneComposition: () => ({ handleChatDocked: (docked) => hostChanges.push(docked) }) };
  const pages = [];
  const open = () => {
    const page = createBoardPage({
      container: byId('boardView'), windowRef: window, state, storage: window.localStorage,
      getProjectSwitcher: async () => switcher,
      chat: { openSession: (id) => opened.push(id) },
    });
    pages.push(page);
    return page;
  };
  t.after(() => {
    pages.forEach((page) => page.dispose());
    getSharedChatDock(state)?.dispose?.();
    window.close();
  });
  const h = {
    window, doc, byId, state, source, switcher, opened, hostChanges, open,
    dock: () => getSharedChatDock(state),
    reconcile: () => getSharedChatDock(state).reconcile(),
    aside: () => byId('ideChatDock'),
    chatHost: () => doc.querySelector('[data-board-chat-host]'),
    notice: () => doc.querySelector('[data-board-chat-notice]'),
    transcriptIn: (el) => byId('chatThreadStage').parentNode === el && byId('composerWrap').parentNode === el,
    moveTo(next) { current = next; switcherListeners.forEach((fn) => fn([])); },
    async start() { const page = open(); await page.started; await flush(); return page; },
    async board(name, projectId = ALPHA.id) { return (await source.create({ projectId, name })).board; },
  };
  return h;
}

test('on the Board with its chat column open, the one dock element sits in the Board column and holds the transcript', async (t) => {
  const h = harness(t);
  await h.board('Auth redesign');
  await h.start();
  assert.equal(h.aside().parentNode, h.chatHost(), 'the dock element is in the Board chat column');
  assert.equal(h.doc.querySelectorAll('#ideChatDock').length, 1, 'one dock element, not a copy');
  assert.equal(h.transcriptIn(h.byId('ideChatDockBody')), true, 'the transcript and composer moved, not copied');
  assert.equal(h.aside().classList.contains('hidden'), false);
  assert.equal(h.state.ui.boardChatDockOpen, true);
  assert.equal(isChatSurfaceLive(h.state), true, 'a send typed here stays on the Board');
  assert.equal(isDockedChatLive(h.state), true);
  assert.deepEqual(h.hostChanges, [true]);
  assert.equal(h.aside().querySelector('[data-ide-chatdock-new-chat]') !== null, true, 'the session row is drawn');
});

test('the Board workbench prefixes its element ids, so the Workspace ids are not repeated', async (t) => {
  const h = harness(t);
  await h.start();
  const host = h.chatHost().closest('[data-wb-view="chat"]');
  assert.equal(host.id, 'board-wbView-chat');
  assert.equal(host.getAttribute('aria-labelledby'), 'board-wbTab-chat');
  const tab = h.doc.querySelector('[data-board-workbench] [data-wb-tab="chat"]');
  assert.equal(tab.id, 'board-wbTab-chat');
  assert.equal(tab.getAttribute('aria-controls'), 'board-wbView-chat');
  assert.equal(h.doc.getElementById('wbView-chat'), null);
});

test('collapsing the Board chat column takes the transcript back to the Chat view, and opening it docks it again', async (t) => {
  const h = harness(t);
  await h.start();
  h.doc.querySelector('[data-board-workbench] [data-wb-tab="chat"]').closest('[data-wb-stack]').querySelector('[data-wb-action="collapse"]').click();
  await flush();
  assert.equal(h.transcriptIn(h.byId('chatView')), true);
  assert.equal(h.state.ui.boardChatDockOpen, false);
  assert.equal(isChatSurfaceLive(h.state), false);
  assert.equal(h.state.ui.boardChat || null, null, 'no stamp while the chat is not docked');
  h.doc.querySelector('[data-board-workbench] [data-wb-strip="chat"]').click();
  await flush();
  assert.equal(h.transcriptIn(h.byId('ideChatDockBody')), true);
  assert.equal(h.state.ui.boardChatDockOpen, true);
});

test('leaving the Board: the page gives the dock element back before it clears itself, and the next chat render takes the transcript home', async (t) => {
  const h = harness(t);
  const page = await h.start();
  assert.equal(h.transcriptIn(h.byId('ideChatDockBody')), true);
  h.state.ui.activeView = 'chat';
  page.dispose(); // what hideBoardPage() does, before the chat render pipeline reconciles
  assert.equal(h.byId('boardView').childElementCount, 0);
  assert.equal(h.aside().isConnected, true, 'the dock element survived the page');
  assert.equal(h.aside().parentNode, h.byId('ideShell'), 'back where it was');
  assert.equal(h.aside().nextElementSibling, null, 'in its old place');
  assert.equal(h.byId('chatInput').isConnected, true, 'the composer survived the page');
  assert.equal(h.state.ui.boardChatDockOpen, false);
  assert.equal(h.state.ui.boardChat || null, null);
  assert.equal(h.reconcile(), true, 'the pipeline reconcile moves the transcript, so it rebuilds the virtualizer');
  assert.equal(h.transcriptIn(h.byId('chatView')), true);
  assert.equal(h.byId('chatThreadStage').nextSibling, h.byId('composerWrap'));
  assert.equal(h.byId('composerWrap').nextSibling, h.byId('artifactReviewResizer'));
  assert.equal(h.reconcile(), false, 'and is then idle');
});

test('the Board host outlives its page: showing the Board again docks the chat again with no second host', async (t) => {
  const h = harness(t);
  const first = await h.start();
  h.state.ui.activeView = 'chat';
  first.dispose();
  h.reconcile();
  h.state.ui.activeView = 'board';
  await h.start();
  h.reconcile();
  assert.equal(h.aside().parentNode, h.chatHost());
  assert.equal(h.transcriptIn(h.byId('ideChatDockBody')), true);
  assert.equal(h.doc.querySelectorAll('[data-board-chat-notice]').length, 0);
});

test('with project_boards off the Board host never takes the dock element or the transcript', async (t) => {
  const h = harness(t, { flag: false });
  await h.start();
  h.reconcile();
  assert.equal(h.transcriptIn(h.byId('chatView')), true);
  assert.notEqual(h.state.ui.boardChatDockOpen, true);
  assert.equal(isChatSurfaceLive(h.state), false);
  assert.equal(h.state.ui.boardChat || null, null);
});

test('the Workspace is a second page of the same controller and is unchanged: its flag off leaves the chat alone, and it never takes the dock while the Board shows', async (t) => {
  const h = harness(t);
  await h.start();
  const ide = { chatDockOpen: true };
  const wsHost = h.byId('ideWorkspaceChatHost');
  const workspace = createIdeChatDock({
    shared: true, state: h.state, getIde: () => ide, windowRef: h.window,
    getDom: () => ({ ideChatDock: h.byId('ideChatDock'), ideChatDockHeader: h.byId('ideChatDockHeader'), ideChatDockBody: h.byId('ideChatDockBody') }),
    workbench: { setOpen: (open) => { ide.chatDockOpen = open; }, reveal: () => true, isVisible: () => ide.chatDockOpen },
  });
  t.after(() => workspace.dispose());
  assert.equal(workspace.reconcile, h.dock().reconcile, 'one controller for both pages');
  h.reconcile();
  assert.equal(h.aside().parentNode, h.chatHost(), 'the Board keeps the dock while it is the view on screen');
  // The Workspace becomes the view: its own wiring adopts the element (stood in for here), and the controller docks there.
  h.state.ui.activeView = 'ide';
  wsHost.appendChild(h.aside());
  assert.equal(h.reconcile(), true, 'the same element in another page: that page lays out');
  assert.equal(h.transcriptIn(h.byId('ideChatDockBody')), true);
  assert.equal(h.state.ui.ideChatDockOpen, true);
  assert.equal(h.notice(), null);
  // ide_chat_dock off: the Workspace is as it was before any of this.
  h.state.features.featureFlags.ide_chat_dock = false;
  assert.equal(h.reconcile(), true);
  assert.equal(h.transcriptIn(h.byId('chatView')), true);
  assert.equal(isChatSurfaceLive(h.state), false);
  assert.equal(h.state.ui.ideChatDockOpen, false);
});

test('a turn typed here may be stamped only while the Board shows, its chat is docked, a board is open and the chat is in the board\'s project', async (t) => {
  const h = harness(t);
  const board = await h.board('Auth redesign');
  await h.start();
  assert.deepEqual(h.state.ui.boardChat, { boardId: board.id, projectId: ALPHA.id });
  assert.equal(h.notice(), null);
  // A chat of another project: no stamp, and the line above the chat says why, naming both projects as text.
  h.state.currentSessionId = 's2';
  h.reconcile();
  assert.equal(h.state.ui.boardChat, null);
  const notice = h.notice();
  assert.equal(notice.getAttribute('role'), 'status');
  assert.equal(notice.textContent, `This chat is in ${BETA.name}, so Jenny cannot see this board from it. Pick or start a chat in Alpha.`);
  assert.equal(notice.querySelector('img'), null, 'a project name is text');
  assert.equal(notice.parentNode, h.aside());
  assert.equal(notice.nextSibling, h.byId('ideChatDockBody'), 'between the session row and the chat');
  // A chat with no project is in General, which is another project than Alpha.
  h.state.currentSessionId = 's3';
  h.reconcile();
  assert.equal(h.state.ui.boardChat, null);
  assert.match(h.notice().textContent, /^This chat is in General,/);
  // Back in the board's project: stamped again and the line is gone.
  h.state.currentSessionId = 's1';
  h.reconcile();
  assert.deepEqual(h.state.ui.boardChat, { boardId: board.id, projectId: ALPHA.id });
  assert.equal(h.notice(), null);
  // A new chat with no row yet is made in the current project.
  h.state.currentSessionId = 'draft-1';
  h.reconcile();
  assert.deepEqual(h.state.ui.boardChat, { boardId: board.id, projectId: ALPHA.id });
  assert.equal(chatProjectOf(h.state), '');
  // Seen live: New chat while another chat is answering makes a draft row with no project. It is made in the
  // current project on its first send, so it is not "in General" and its first message is stamped too.
  for (const row of [{ id: 'session_local_1', local_draft: true, optimistic_local: true }, { id: 'optimistic_2', optimistic_local: true }]) {
    h.state.sessions.unshift({ title: 'New Chat', session_type: 'chat', ...row });
    h.state.currentSessionId = row.id;
    h.reconcile();
    assert.equal(chatProjectOf(h.state), '', row.id);
    assert.deepEqual(h.state.ui.boardChat, { boardId: board.id, projectId: ALPHA.id }, row.id);
    assert.equal(h.notice(), null, row.id);
  }
  // A draft that names a project is in that project.
  h.state.sessions.unshift({ id: 'session_local_3', session_type: 'chat', local_draft: true, project_id: BETA.id });
  h.state.currentSessionId = 'session_local_3';
  h.reconcile();
  assert.equal(h.state.ui.boardChat, null);
});

test('the stamp follows the open board and the project, and a project with no board has none', async (t) => {
  const h = harness(t);
  const first = await h.board('One');
  const second = await h.board('Two');
  await h.start();
  const openId = h.state.ui.boardChat.boardId;
  assert.ok([first.id, second.id].includes(openId));
  const other = openId === first.id ? second : first;
  h.doc.querySelector(`[data-board-id="${other.id}"] [data-board-action="open"]`).click();
  await flush();
  assert.equal(h.state.ui.boardChat.boardId, other.id);
  h.moveTo({ id: BETA.id, name: 'Beta' });
  await flush();
  assert.equal(h.state.ui.boardChat, null, 'Beta has no board, and the chat is Alpha\'s');
  assert.match(h.notice().textContent, /^This chat is in Alpha, .* in Beta\.$/);
});

test('the session picker lists the board\'s project first, each part newest first; without a preferred project the order is by time', () => {
  const dom = new JSDOM('<!doctype html><body><header id="h"></header></body>');
  const state = {
    currentSessionId: '',
    sessions: [
      { id: 'a-old', title: 'A old', session_type: 'chat', project_id: ALPHA.id, updated_at: '2026-11-01T00:00:00Z' },
      { id: 'b-new', title: 'B new', session_type: 'chat', project_id: BETA.id, updated_at: '2026-11-12T00:00:00Z' },
      { id: 'a-new', title: 'A new', session_type: 'chat', project_id: ALPHA.id, updated_at: '2026-11-10T00:00:00Z' },
      { id: 'g-mid', title: 'G mid', session_type: 'chat', updated_at: '2026-11-11T00:00:00Z' },
    ],
  };
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  try {
    let preferred = ALPHA.id;
    const header = dom.window.document.getElementById('h');
    const picker = createIdeChatSessionPicker({ state, getHeader: () => header, getPreferredProjectId: () => preferred });
    header.innerHTML = picker.buildMarkup();
    picker.bindEvents(header);
    const titles = () => {
      picker.render();
      header.querySelector('[data-ide-chatdock-session-trigger]').click();
      const rows = [...dom.window.document.querySelectorAll('[data-ide-chatdock-session-id]')].map((el) => el.getAttribute('data-ide-chatdock-session-id'));
      picker.close(false);
      return rows;
    };
    assert.deepEqual(titles(), ['a-new', 'a-old', 'b-new', 'g-mid']);
    preferred = 'project_general';
    assert.deepEqual(titles(), ['g-mid', 'b-new', 'a-new', 'a-old']);
    preferred = '';
    assert.deepEqual(titles(), ['b-new', 'g-mid', 'a-new', 'a-old']);
    picker.dispose();
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
    dom.window.close();
  }
});

test('choosing a chat in the picker opens it through the app, and focus leaving the dock looks for the chat tab inside the Board only', async (t) => {
  const h = harness(t);
  await h.start();
  // A Workspace chat tab elsewhere in the document must not take the focus fallback.
  const decoy = h.doc.createElement('button');
  decoy.setAttribute('data-wb-tab', 'chat');
  h.byId('ideShell').appendChild(decoy);
  h.byId('chatInput').blur();
  h.aside().querySelector('[data-ide-chatdock-new-chat]').focus();
  assert.equal(h.aside().contains(h.doc.activeElement), true);
  h.doc.querySelector('[data-board-workbench] [data-wb-tab="chat"]').closest('[data-wb-stack]').querySelector('[data-wb-action="collapse"]').click();
  await flush();
  assert.notEqual(h.doc.activeElement, decoy);
  assert.equal(h.doc.querySelector('[data-board-workbench]').contains(h.doc.activeElement) || h.doc.activeElement === h.doc.body, true);
});

/* Row 150 slice C5: what the page hands the cards and the toolbar (context.openChat, context.openSession). */
function captureContext() {
  const captured = [];
  require('../renderer/features/board/board-card-kinds').register('c5-spy', (ctx) => { captured.push(ctx); return null; });
  return captured;
}

test('context.openChat opens a collapsed chat column and docks the transcript, and says false when the Board chat is off', async (t) => {
  const captured = captureContext();
  const h = harness(t);
  await h.board('Auth redesign');
  await h.start();
  const hooks = captured[captured.length - 1].context;
  h.doc.querySelector('[data-board-workbench] [data-wb-tab="chat"]').closest('[data-wb-stack]').querySelector('[data-wb-action="collapse"]').click();
  await flush();
  assert.equal(h.transcriptIn(h.byId('chatView')), true);
  assert.equal(hooks.openChat(), true);
  await flush();
  assert.equal(h.transcriptIn(h.byId('ideChatDockBody')), true);
  assert.equal(h.state.ui.boardChatDockOpen, true);
  assert.equal(h.doc.activeElement, h.byId('chatInput'), 'the caret is in the composer');
  assert.equal(hooks.openChat(), true, 'already open stays true');
  h.state.features.featureFlags.project_boards = false;
  assert.equal(hooks.openChat(), false);
});

test('context.openSession switches to the Chat page and opens the chat; with no app opener it throws so the card can say so', async (t) => {
  const captured = captureContext();
  const h = harness(t);
  await h.board('Auth redesign');
  const calls = [];
  h.state.harness = { agentActions: { setActiveView: (view) => calls.push(`view:${view}`), openSession: async (id) => { calls.push(`open:${id}`); } } };
  const page = await h.start();
  const hooks = captured[captured.length - 1].context;
  await hooks.openSession({ sessionId: 's1', messageId: 'm1' });
  assert.deepEqual(calls, ['view:chat', 'open:s1']);
  h.state.harness = {};
  await assert.rejects(() => hooks.openSession({ sessionId: 's1', messageId: null }));
  page.dispose();
  assert.equal(h.aside().isConnected, true);
});

test('beside a team board the column is not this Jenny\'s chat: the transcript stays in the Chat view, no turn is stamped and no line is said', async (t) => {
  const h = harness(t);
  const board = await h.board('Auth redesign');
  // The team bridge, as little of it as a team board needs to open.
  const shared = model.createBoard({ id: `board_${uid(900)}`, project_id: 'project_shared', name: 'Shared plan', now: '2026-11-15T10:00:00.000Z' }).board;
  h.window.jennyShell.team = {
    onBoard: () => () => {},
    boardList: async () => ({ ok: true, boards: [{ id: shared.id, name: shared.name, rev: 0 }] }),
    boardOpen: async () => ({ ok: true, board: shared, rev: 0, read_only: false, pending: 0, presence: null }),
    boardClose: async () => ({ ok: true }),
  };
  const page = await h.start();
  assert.deepEqual(h.state.ui.boardChat, { boardId: board.id, projectId: ALPHA.id });
  assert.equal(h.transcriptIn(h.byId('ideChatDockBody')), true);

  page.pickProject({ id: 'project_shared', name: 'Shared', team: { id: 'team_one', name: 'One' }, role: () => 'writer' });
  await flush();
  h.reconcile();
  assert.equal(page.getOpenBoardId(), shared.id);
  assert.deepEqual([h.state.ui.boardChat || null, h.state.ui.boardChatDockOpen, h.notice()], [null, false, null]);
  assert.equal(h.transcriptIn(h.byId('ideChatDockBody')), false, 'the transcript went back to the Chat view');
  assert.equal(h.aside().classList.contains('hidden'), true);
  assert.equal(isDockedChatLive(h.state), false);
  // A chat of this Jenny's own project showing changes nothing: there is nothing to stamp a team board with.
  h.state.currentSessionId = 's2';
  h.reconcile();
  assert.deepEqual([h.state.ui.boardChat || null, h.notice()], [null, null]);

  // Back on this Jenny's project the chat docks and is stamped again.
  h.state.currentSessionId = 's1';
  page.pickProject(null);
  await flush();
  h.reconcile();
  assert.deepEqual(h.state.ui.boardChat, { boardId: board.id, projectId: ALPHA.id });
  assert.equal(h.transcriptIn(h.byId('ideChatDockBody')), true);
});
