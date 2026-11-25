'use strict';

// new-test-file: a new surface (what the shell and the cards call on the Board page: openSession, toggleBoardsList, toggleChat); renderer-board-page.test.js is at its line cap.
// The real Board page over jsdom with the in-memory source and the real chat dock, as renderer-board-chat-dock.test.js builds it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const boardPage = require('../renderer/features/board/board-page');
const { getSharedChatDock } = require('../renderer/features/renderer-ide-chat-dock');

const ALPHA = { id: 'project_alpha', name: 'Alpha' };
const flush = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function harness(t, { flag = true } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <button id="newChatButton"></button>
    <section id="chatView">
      <div id="chatThreadStage"><div id="chatThreadScroll"><div id="chatTimeline"></div></div></div>
      <div id="composerWrap"><textarea id="chatInput"></textarea></div>
      <aside id="artifactReviewPanel"></aside>
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
  const source = createMemoryBoardSource({ model, now: () => new Date('2026-11-23T10:00:00.000Z').toISOString(), makeId: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })() });
  window.jennyShell = { boards: source };
  const calls = [];
  const state = {
    ui: { activeView: 'board' },
    features: { featureFlags: { project_boards: flag, ide_chat_dock: true } },
    sessions: [{ id: 's1', title: 'Alpha chat', session_type: 'chat', project_id: ALPHA.id, updated_at: '2026-11-23T09:00:00Z' }],
    currentSessionId: 's1',
    harness: { agentActions: { setActiveView: (view) => calls.push(`view:${view}`), openSession: async (id) => { calls.push(`open:${id}`); } } },
  };
  const switcher = { currentProject: () => ALPHA, refresh: async () => [], projectById: () => ALPHA, onProjectsChanged: () => () => {} };
  window.rendererAppPaneComposition = { getPaneComposition: () => ({ handleChatDocked: () => {} }) };
  const captured = [];
  require('../renderer/features/board/board-card-kinds').register('shell-hooks-spy', (ctx) => { captured.push(ctx); return null; });
  t.after(() => {
    boardPage.hideBoardPage();
    getSharedChatDock(state)?.dispose?.();
    window.close();
  });
  return {
    doc, state, calls, source, captured,
    async show() {
      const page = boardPage.showBoardPage({
        container: doc.getElementById('boardView'), windowRef: window, state, storage: window.localStorage,
        getProjectSwitcher: async () => switcher, chat: { openSession: () => {} },
      });
      await page.started;
      await flush();
      return page;
    },
    hooks: () => captured[captured.length - 1].context,
    // Whether the stack that holds a view of the Board workbench is open.
    isOpen: (view) => doc.querySelector(`[data-board-workbench] [data-wb-view="${view}"]`).closest('[data-wb-stack]').getAttribute('data-state') !== 'collapsed',
  };
}

test('a chat card on a personal board opens its conversation in the Board chat column and the view stays the Board', async (t) => {
  const h = harness(t);
  await h.source.create({ projectId: ALPHA.id, name: 'Auth redesign' });
  await h.show();
  await h.hooks().openSession({ sessionId: 's1', messageId: null });
  assert.deepEqual(h.calls, ['open:s1'], 'no setActiveView: the person is not thrown off the Board');
  assert.equal(h.state.ui.boardChatDockOpen, true);
  assert.equal(h.isOpen('chat'), true);
});

test('a chat card opens a collapsed Board chat column before it opens the conversation', async (t) => {
  const h = harness(t);
  await h.source.create({ projectId: ALPHA.id, name: 'Auth redesign' });
  await h.show();
  assert.equal(boardPage.toggleChat(), true);
  await flush();
  assert.equal(h.isOpen('chat'), false);
  await h.hooks().openSession({ sessionId: 's1', messageId: null });
  await flush();
  assert.deepEqual(h.calls, ['open:s1']);
  assert.equal(h.isOpen('chat'), true);
  assert.equal(h.state.ui.boardChatDockOpen, true);
});

test('with the Board chat unavailable a chat card goes to the Chat page as before, and without an app opener it throws', async (t) => {
  const h = harness(t);
  await h.source.create({ projectId: ALPHA.id, name: 'Auth redesign' });
  await h.show();
  h.state.features.featureFlags.project_boards = false;
  await h.hooks().openSession({ sessionId: 's1', messageId: null });
  assert.deepEqual(h.calls, ['view:chat', 'open:s1']);
  h.state.harness = {};
  await assert.rejects(() => h.hooks().openSession({ sessionId: 's1', messageId: null }));
});

test('toggleBoardsList flips the Boards list and says true with a page up, false with none', async (t) => {
  const h = harness(t);
  assert.equal(boardPage.toggleBoardsList(), false, 'no page yet');
  await h.source.create({ projectId: ALPHA.id, name: 'Auth redesign' });
  await h.show();
  const before = h.isOpen('boards');
  assert.equal(boardPage.toggleBoardsList(), true);
  assert.equal(h.isOpen('boards'), !before);
  assert.equal(boardPage.toggleBoardsList(), true);
  assert.equal(h.isOpen('boards'), before);
  boardPage.hideBoardPage();
  assert.equal(boardPage.toggleBoardsList(), false, 'the page is gone');
});

test('toggleChat flips the chat column and says true with a page up, false when the page is parked or gone', async (t) => {
  const h = harness(t);
  assert.equal(boardPage.toggleChat(), false, 'no page yet');
  await h.source.create({ projectId: ALPHA.id, name: 'Auth redesign' });
  const page = await h.show();
  assert.equal(h.isOpen('chat'), true);
  assert.equal(boardPage.toggleChat(), true);
  assert.equal(h.isOpen('chat'), false);
  assert.equal(boardPage.toggleChat(), true);
  assert.equal(h.isOpen('chat'), true);
  boardPage.parkBoardPage();
  assert.equal(page.toggleChat(), false, 'the page member says false while parked');
  assert.equal(page.toggleBoardsList(), false);
  assert.equal(boardPage.toggleChat(), false, 'and so does the module function');
  assert.equal(boardPage.toggleBoardsList(), false);
  assert.equal(h.isOpen('chat'), true, 'a parked page was not touched');
});
