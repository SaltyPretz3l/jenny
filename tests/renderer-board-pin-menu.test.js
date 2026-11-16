'use strict';

// new-test-file: a new surface (row 150 slice C5): the board picker the chat's "Pin to board" entries open
// (renderer/features/board/board-pin-menu.js), over jsdom with the real context menu primitive and a fake boards bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const contextMenu = require('../renderer/inventory/context-menu');
const layoutStore = require('../renderer/features/board/board-layout-store');
const pinMenu = require('../renderer/features/board/board-pin-menu');

const PROJECT = 'project_alpha';
const NOTE = { kind: 'note', text: 'Move the token check.' };
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function harness(t, { boards = [{ id: 'board_a', name: 'Plan' }, { id: 'board_b', name: 'Ideas' }], refs = [], flag = true, listAnswer, pinAnswer, createAnswer } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="anchor">Pin</button><div id="root"></div></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const calls = [];
  const toasts = [];
  const opened = [];
  const views = [];
  const boardsBridge = {
    list: async (request) => { calls.push(['list', request]); return listAnswer || { ok: true, boards }; },
    chatRefs: async (request) => { calls.push(['chatRefs', request]); return { ok: true, refs }; },
    pin: async (request) => { calls.push(['pin', request]); return pinAnswer || { ok: true, boardId: request.boardId, boardName: 'Plan', cardId: 'card_1' }; },
    create: async (request) => { calls.push(['create', request]); return createAnswer || { ok: true, board: { id: 'board_new', name: request.name } }; },
  };
  const state = { features: { featureFlags: { project_boards: flag } }, harness: { agentActions: { setActiveView: (view) => views.push(view) } } };
  window.rendererBoardPage = { openBoard: (id) => { opened.push(id); return Promise.resolve(); } };
  window.rendererBoardLayoutStore = layoutStore;
  t.after(() => { contextMenu.hide({ restoreFocus: false }); window.close(); });
  const deps = { state, windowRef: window, boards: boardsBridge, menu: contextMenu, toast: (...args) => toasts.push(args) };
  const run = async (extra = {}) => {
    const shown = await pinMenu.open({ anchorEl: doc.getElementById('anchor'), rootEl: doc.getElementById('root'), projectId: PROJECT, item: NOTE, deps, ...extra });
    return shown;
  };
  const rows = () => [...doc.querySelectorAll('.inv-context-menu .inv-context-menu-item')];
  return { window, doc, calls, toasts, opened, views, state, deps, run, rows,
    heading: () => (doc.querySelector('.inv-context-menu-heading') || {}).textContent,
    choose: async (label) => { rows().find((row) => row.textContent === label).click(); await flush(); } };
}

test('the menu lists the project\'s boards by name, as text, under the heading', async (t) => {
  const h = harness(t, { boards: [{ id: 'board_a', name: '<img src=x onerror=1>' }, { id: 'board_b', name: 'Ideas' }] });
  assert.equal(await h.run(), true);
  assert.deepEqual(h.calls, [['list', { projectId: PROJECT }]], 'no chat refs are asked for without a message');
  assert.deepEqual(h.rows().map((row) => row.textContent), ['<img src=x onerror=1>', 'Ideas']);
  assert.equal(h.doc.querySelector('.inv-context-menu img'), null, 'a board name never becomes an element');
  assert.equal(h.heading(), 'Pin to board');
  await h.run({ heading: 'Pin selection to board' });
  assert.equal(h.heading(), 'Pin selection to board');
});

test('boards that already hold this message come first as "On board" lines and open the Board', async (t) => {
  const refs = [{ messageId: 'm1', boardId: 'board_b', boardName: 'Ideas', cardId: 'c1' }, { messageId: 'm2', boardId: 'board_a', boardName: 'Plan', cardId: 'c2' }];
  const h = harness(t, { refs });
  const opened = [];
  h.deps.openBoard = (boardId) => opened.push(boardId);
  assert.equal(await h.run({ sessionId: 's1', messageId: 'm1' }), true);
  assert.deepEqual(h.calls.map(([name, request]) => [name, request]), [['list', { projectId: PROJECT }], ['chatRefs', { projectId: PROJECT, sessionId: 's1' }]]);
  assert.deepEqual(h.rows().map((row) => row.textContent), ['On board: Ideas', 'Plan', 'Ideas']);
  await h.choose('On board: Ideas');
  assert.deepEqual(opened, ['board_b']);
  assert.equal(h.calls.some(([name]) => name === 'pin'), false, 'choosing the line pins nothing');
});

test('choosing a board pins the item unchanged once and says so, with an Open board action', async (t) => {
  const h = harness(t);
  await h.run({ item: { kind: 'chat', sessionId: 's1', messageId: 'm1', title: 'T', excerpt: 'E' } });
  await h.choose('Ideas');
  const pins = h.calls.filter(([name]) => name === 'pin');
  assert.deepEqual(pins, [['pin', { boardId: 'board_b', item: { kind: 'chat', sessionId: 's1', messageId: 'm1', title: 'T', excerpt: 'E' } }]]);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0][0], 'Pinned to Plan');
  const action = h.toasts[0][1].actions[0];
  assert.equal(action.label, 'Open board');
  assert.deepEqual(h.opened, [], 'the board is not opened by pinning');
  h.deps.openBoard = (boardId) => h.opened.push(boardId);
  action.onClick();
  assert.deepEqual(h.opened, ['board_b']);
});

test('with no board in the project, "New board" makes one and pins to it', async (t) => {
  const h = harness(t, { boards: [] });
  await h.run();
  assert.deepEqual(h.rows().map((row) => row.textContent), ['New board']);
  await h.choose('New board');
  assert.deepEqual(h.calls.filter(([name]) => name !== 'list'), [['create', { projectId: PROJECT, name: 'New board' }], ['pin', { boardId: 'board_new', item: NOTE }]]);
  assert.equal(h.toasts[0][0], 'Pinned to Plan');
  const refused = harness(t, { boards: [], createAnswer: { ok: false, reason: 'limit' } });
  await refused.run();
  await refused.choose('New board');
  assert.equal(refused.calls.some(([name]) => name === 'pin'), false);
  assert.equal(refused.toasts[0][0], 'This project already has the most boards it can hold.');
});

test('each known refusal shows its sentence, never a reason code or a path', async (t) => {
  const cases = [
    [{ reason: 'limit', limit: 'cards' }, 'That board is full'],
    [{ reason: 'outside', path: 'C:\\Users\\me\\secret.txt' }, 'Only files in this project\'s folder can be pinned'],
    [{ reason: 'link' }, 'Only files in this project\'s folder can be pinned'],
    [{ reason: 'no_root' }, 'Only files in this project\'s folder can be pinned'],
    [{ reason: 'read_only' }, 'That board cannot be changed'],
    [{ reason: 'disabled' }, 'Boards are turned off'],
    [{ reason: 'too_large' }, 'That picture is too big to pin'],
    [{ reason: 'not_found' }, 'That board no longer exists'],
    [{ reason: 'io' }, 'Could not pin that'],
    [{ reason: 'unsupported' }, 'Could not pin that'],
    [{}, 'Could not pin that'],
  ];
  for (const [answer, sentence] of cases) {
    const h = harness(t, { pinAnswer: { ok: false, ...answer } });
    await h.run();
    await h.choose('Plan');
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0][0], sentence, JSON.stringify(answer));
    assert.doesNotMatch(h.toasts[0][0], /outside|read_only|no_root|Users|secret|too_large|not_found/);
  }
  const file = harness(t, { pinAnswer: { ok: false, reason: 'not_found' } });
  await file.run({ item: { kind: 'file', path: 'src/app.js' } });
  await file.choose('Plan');
  assert.equal(file.toasts[0][0], 'That file is not there any more');
  const unlisted = harness(t, { listAnswer: { ok: false, reason: 'disabled' } });
  assert.equal(await unlisted.run(), false);
  assert.equal(unlisted.toasts[0][0], 'Boards are turned off');
  assert.equal(unlisted.rows().length, 0);
});

test('with the flag off nothing is asked and nothing is shown', async (t) => {
  const h = harness(t, { flag: false });
  assert.equal(await h.run(), false);
  assert.deepEqual(h.calls, []);
  assert.equal(h.rows().length, 0);
  assert.deepEqual(h.toasts, []);
  const noBridge = harness(t);
  noBridge.deps.boards = null;
  noBridge.window.jennyShell = {};
  assert.equal(await noBridge.run(), false);
});

test('openBoard saves the board as the project\'s open one, tells a page that is up, and moves to the Board view', async (t) => {
  const h = harness(t);
  assert.equal(await pinMenu.openBoard('board_b', { ...h.deps, projectId: PROJECT }), true);
  assert.equal(layoutStore.createLayoutStore({ storage: h.window.localStorage, model: null }).openBoardOf(PROJECT), 'board_b');
  assert.deepEqual(h.opened, ['board_b']);
  assert.deepEqual(h.views, ['board']);
  const none = harness(t);
  none.state.harness = {};
  assert.equal(await pinMenu.openBoard('board_b', { ...none.deps, projectId: PROJECT }), false, 'with no way to change the view nothing claims to have opened');
});
