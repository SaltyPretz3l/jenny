'use strict';

// new-test-file: the same surface as renderer-board-team.test.js (row 151 slice T7), its second lane: the conversation in the chat
// column, who else is on the board, the note lock, who added a card and the proposal bar. It repeats that file's harness (the real
// page, the scripted `team` bridge, the real stores) because the first file would pass the 600-line cap with these cases in it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../services/boards/board-model');
const { createMemoryBoardSource } = require('../renderer/features/board/board-source-memory');
const { createBoardPage } = require('../renderer/features/board/board-page');
const boardTeam = require('../renderer/features/board/board-team');
const boardTeamMenu = require('../renderer/features/board/board-team-menu');
const boardTeamChat = require('../renderer/features/board/board-team-chat');
const boardTeamPresence = require('../renderer/features/board/board-team-presence');
// The chat card kind, registered as its script registers it in the app.
require('../renderer/features/board/board-card-kinds').register('chat', require('../renderer/features/board/board-card-chat').createChatPart);
const host = require('./helpers/team-project-renderer-host');
const { inventory } = require('./helpers/team-settings-harness');

const { OTHER: TEAM, P1: PROJECT, P2, S1, S2, DOT, MAYA, flush } = host;
const NOW = '2026-11-15T10:00:00.000Z';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const boardId = (n) => `board_${uid(n)}`;
const frame = () => new Promise((resolve) => setTimeout(resolve, 20));
const iso = (name) => `⁨${name}⁩`; // a name inside a sentence of the team half stands between isolates
const note = (n, text) => ({ op: 'card.add', card: { id: uid(100 + n), kind: 'note', data: { text }, x: n * 300, y: 0 } });
const TEAM_MODULES = ['team', 'message-row'];

function teamBoard(n, name, ...ops) {
  const empty = model.createBoard({ id: boardId(n), project_id: PROJECT, name, now: NOW }).board;
  if (!ops.length) return empty;
  const made = model.applyBatch(empty, { batch_id: `seed${n}`, board_id: empty.id, actor: DOT, ops }, { now: NOW });
  assert.equal(made.ok, true, JSON.stringify(made));
  return made.board;
}
const row = (board) => ({ id: board.id, name: board.name, rev: board.rev, created_at: NOW, updated_at: NOW, created_by: DOT });
const opened = (board, presence) => ({ ok: true, board, rev: board.rev, read_only: false, pending: 0, presence: presence || { viewers: [DOT], cursors: [], locks: [] } });

// The `team` bridge, scripted: every call is recorded; `on...` registers a listener (counted, so a leak shows).
function scriptedTeam(answers) {
  const calls = [];
  const subs = new Map();
  const bridge = new Proxy({}, { get: (_target, name) => {
    if (typeof name !== 'string') return undefined;
    if (/^on[A-Z]/.test(name)) return (fn) => { const set = subs.get(name) || subs.set(name, new Set()).get(name); set.add(fn); return () => set.delete(fn); };
    return async (payload) => {
      calls.push([name, payload]);
      const answer = answers[name];
      return typeof answer === 'function' ? answer(payload) : (answer === undefined ? { ok: true } : answer);
    };
  } });
  return { bridge, calls, answers, names: () => calls.map(([name]) => name), of: (name) => calls.filter(([n]) => n === name).map(([, payload]) => payload),
    listeners: () => [...subs.values()].reduce((sum, set) => sum + set.size, 0), push: (name, payload) => [...(subs.get(name) || [])].forEach((fn) => fn(payload)) };
}

const ROSTER = { ok: true, members: [{ member_id: DOT, display_name: 'Dot', role: 'member', state: 'active', devices: [] }, { member_id: MAYA, display_name: 'Maya', role: 'member', state: 'active', devices: [] }] };

// Mounts the real page on a fresh window. `registry` is what the team gate's loader puts on the window, by global name, the way
// the script loader would; `loads` records each list asked for.
async function mount(t, { boards = [], team = true, gate = true, rows = [host.memberTeam()], answers = {}, projects = [{ id: 'project_alpha', name: 'Alpha' }], current = 'project_alpha', frames = null } = {}) {
  for (const file of Object.keys(require.cache)) if (/[\\/]renderer[\\/]team[\\/]/.test(file) || /board-source-team/.test(file)) delete require.cache[file];
  const dom = new JSDOM('<!doctype html><body><section id="boardView"></section></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const saved = ['window', 'document', 'inventory', 'inventoryContextMenu', 'markdownUtils'].map((key) => [key, globalThis[key]]);
  Object.assign(globalThis, { window, document: doc, inventory: inventory(), inventoryContextMenu: require('../renderer/inventory/context-menu'), markdownUtils: require('../renderer/shared/markdown-utils') });
  window.inventoryContextMenu = globalThis.inventoryContextMenu;
  if (frames) { window.requestAnimationFrame = frames.request; window.cancelAnimationFrame = frames.cancel; }
  const own = createMemoryBoardSource({ model });
  const ownCalls = [];
  const ownBridge = new Proxy({}, { get: (_target, name) => (name === 'onChanged' ? (listener) => own.onChanged(listener) : (request) => { ownCalls.push(name); return own[name](request); }) });
  const bridge = scriptedTeam({ projectList: host.listAnswer(), members: ROSTER, projectUnjoined: { ok: true, projects: [], truncated: false }, projectRules: host.rulesAnswer(),
    conversationOpen: { ok: true, snapshot: host.snapshot() }, boardList: { ok: true, boards: boards.map(row) },
    boardOpen: (payload) => opened(boards.find((board) => board.id === payload.board_id) || boards[0]), ...answers });
  window.jennyShell = { boards: ownBridge, ...(team ? { team: bridge.bridge } : {}) };
  const loads = [];
  const captured = { ctx: null, part: null };
  const registry = {
    rendererSettingsTeamStrings: () => require('../renderer/shell/renderer-settings-team-strings'),
    rendererTeamStore: () => require('../renderer/team/renderer-team-store'),
    rendererBoardSourceTeam: () => require('../renderer/features/board/board-source-team'),
    rendererBoardTeamMenu: () => boardTeamMenu, rendererBoardTeamChat: () => boardTeamChat, rendererBoardTeamPresence: () => boardTeamPresence,
    rendererBoardTeam: () => ({ attachBoardTeam: (ctx) => { captured.ctx = ctx; captured.part = boardTeam.attachBoardTeam(ctx); return captured.part; } }),
    rendererTeamProjectStore: () => require('../renderer/team/renderer-team-project-store'),
    rendererTeamProjectColumn: () => require('../renderer/team/renderer-team-project-column'),
    rendererTeamMessageRow: () => require('../renderer/team/renderer-team-message-row'),
    rendererTeamProjectBox: () => require('../renderer/team/renderer-team-project-box'),
    rendererTeamProjectConversation: () => require('../renderer/team/renderer-team-project-conversation'),
  };
  const list = (...names) => Object.assign(names.map((name) => [`x/${name}.js`, name]), {});
  const gateful = {
    VIEW_STYLES: ['styles/team-tab.css'],
    ensureTeamAssets: async (request) => {
      loads.push({ scripts: request.scripts.map(([, name]) => name), styles: request.styles || [] });
      for (const [, name] of request.scripts) if (!window[name] && registry[name]) window[name] = registry[name]();
      return true;
    },
  };
  if (gate) {
    window.rendererSettingsScriptManifest = Object.assign([], {
      teamBoard: list('rendererSettingsTeamStrings', 'rendererTeamStore', 'rendererBoardSourceTeam', 'rendererBoardTeamMenu', 'rendererBoardTeamChat', 'rendererBoardTeamPresence', 'rendererBoardTeam'),
      teamTab: list('rendererTeamProjectStore', 'rendererTeamProjectColumn', 'rendererTeamMessageRow', 'rendererTeamProjectBox', 'rendererTeamProjectConversation'),
    });
    window.rendererTeamTabGate = gateful;
  }
  window.rendererTeamStore = registry.rendererTeamStore();
  window.rendererTeamStore.getTeamStore().seed({ teams: rows });
  const switched = [];
  let currentId = current;
  const watchers = new Set();
  const switcher = { currentProject: () => projects.find((p) => p.id === currentId) || { id: currentId, name: 'General' }, refresh: async () => [], getProjects: () => projects,
    onProjectsChanged: (fn) => { watchers.add(fn); return () => watchers.delete(fn); },
    switchToProject: async (id) => { switched.push(id); currentId = id; watchers.forEach((fn) => fn()); } };
  const toasts = [];
  const makePage = () => createBoardPage({ container: doc.getElementById('boardView'), windowRef: window, storage: window.localStorage, getProjectSwitcher: async () => switcher,
    showToast: (message, options) => toasts.push({ message, ...options }) });
  let page = makePage();
  t.after(() => {
    page.dispose();
    window.rendererTeamStore.getTeamStore().dispose();
    window.close();
    for (const [key, value] of saved) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  });
  await page.started;
  await flush();
  const q = (selector) => doc.querySelector(selector);
  // A new Board page on the same window, the old one gone (the Board tab shown again).
  const again = async () => { page.dispose(); page = makePage(); out.page = page; await page.started; await flush(); };
  const out = { window, doc, page, again, captured, own, ownCalls, bridge, toasts, loads, switched, q, qa: (selector) => [...doc.querySelectorAll(selector)], flush,
    heading: () => q('[data-board-project]'), button: () => q('[data-board-project] button'),
    menu: () => q('.inv-context-menu'), menuItems: () => [...doc.querySelectorAll('.inv-context-menu .inv-context-menu-item')].map((el) => el.textContent.trim()),
    names: () => [...doc.querySelectorAll('[data-board-id] .session-row__title-text')].map((el) => el.textContent) };
  return out;
}

const items = (m) => [...m.doc.querySelectorAll('.inv-context-menu .inv-context-menu-item')];
const heads = (m) => [...m.doc.querySelectorAll('.inv-context-menu .inv-context-menu-heading')].map((el) => el.textContent);
const choose = async (m, label) => { const item = items(m).find((el) => el.textContent.trim() === label); assert.ok(item, `menu row ${label}`); item.click(); await m.flush(); await frame(); await m.flush(); };
const openMenu = async (m) => { m.button().click(); await m.flush(); };
// Shows a team project of the scripted team through the project menu.
const pickTeam = async (m, name = 'jenny-site') => { await openMenu(m); await choose(m, name); };


const inputs = (m) => m.qa('#teamConversationInput').length;
const picker = (m) => m.q('[data-board-team-conv="pick"]');
const order = (m) => m.bridge.calls.map(([name, payload]) => `${name}:${payload && payload.session_id ? payload.session_id : ''}`).filter((x) => /^conversation(Open|Close):/.test(x));
// A team project with the chat column open and the first conversation mounted.
async function teamChat(t, options = {}) {
  const m = await mount(t, options);
  await pickTeam(m);
  assert.equal(m.captured.part.openChat(), true);
  await m.flush();
  return m;
}

test('chat column: the conversation of the team project, its picker, collapse, and leaving the project', async (t) => {
  const m = await teamChat(t);
  const aside = m.q('[data-board-chat-host] > aside.ide-chat-dock');
  assert.equal(aside.getAttribute('aria-label'), 'Conversation with Jenny');
  assert.deepEqual([inputs(m), picker(m).getAttribute('aria-haspopup'), picker(m).textContent.trim(), m.q('[data-board-team-conv="collapse"]').title], [1, 'menu', 'Palette loader cleanup', 'Collapse chat']);
  assert.equal(order(m).filter((x) => x.startsWith('conversationOpen')).length, 1);
  picker(m).click();
  await m.flush();
  assert.deepEqual([heads(m), items(m).map((el) => [el.textContent.trim(), el.getAttribute('aria-checked')])],
    [[`Conversations in ${iso('jenny-site')}`], [['Palette loader cleanup', 'true'], ['Blog post draft', 'false'], ['New conversation', null]]]);
  await choose(m, 'Blog post draft');
  assert.deepEqual([inputs(m), picker(m).textContent.trim(), order(m)], [1, 'Blog post draft', [`conversationOpen:${S1}`, `conversationClose:${S1}`, `conversationOpen:${S2}`]]);
  m.q('[data-board-team-conv="collapse"]').click();
  await m.flush();
  assert.deepEqual([m.q('[data-board-chat-host]').children.length, inputs(m), m.captured.ctx.chat.isOpen(), order(m).at(-1)], [0, 0, false, `conversationClose:${S2}`]);
  assert.equal(m.captured.part.openChat(), true);
  await m.flush();
  assert.deepEqual([inputs(m), picker(m).textContent.trim()], [1, 'Blog post draft'], 'the conversation chosen last is the one shown again');
  await openMenu(m);
  await choose(m, 'General');
  assert.deepEqual([m.q('[data-board-chat-host] .board-team-conv'), inputs(m), m.captured.part.openChat()], [null, 0, false]);
});

test('chat column: Open in Team asks the Team notifier for the conversation shown; it is greyed with a reason while the team is offline or no conversation is shown', async (t) => {
  const m = await teamChat(t);
  const asked = [];
  m.window.rendererTeamNotify = { request: (intent) => { asked.push(intent); return true; } };
  const button = () => m.q('[data-board-team-conv="open-team"]');
  assert.deepEqual([button().disabled, button().title, button().getAttribute('aria-label')], [false, 'Open in Team', 'Open in Team']);
  button().click();
  assert.deepEqual(asked, [{ kind: 'conversation', teamId: TEAM, projectId: PROJECT, sessionId: S1 }]);
  m.window.rendererTeamStore.getTeamStore().seed({ teams: [host.memberTeam({ state: 'connecting' })] });
  await m.flush();
  assert.deepEqual([button().disabled, button().title], [true, 'The team is offline. Open it in the Team tab when it is back.']);
  button().click();
  assert.equal(asked.length, 1, 'a greyed button asks for nothing');
  const empty = await teamChat(t, { answers: { projectList: host.listAnswer({ conversations: [] }) } });
  assert.deepEqual([empty.q('[data-board-team-conv="open-team"]').disabled, empty.q('[data-board-team-conv="open-team"]').title], [true, 'There is no conversation to open.']);
});

test('chat column: New conversation makes one as the Team tab does and shows it; a reader gets the button disabled with the sentence', async (t) => {
  const created = { ok: true, session: { session_id: host.S3 } };
  const m = await teamChat(t, { answers: { conversationCreate: created } });
  picker(m).click();
  await m.flush();
  await choose(m, 'New conversation');
  assert.deepEqual([m.bridge.of('conversationCreate'), inputs(m), order(m).at(-1)], [[{ team_id: TEAM, project_id: PROJECT }], 1, `conversationOpen:${host.S3}`]);
  const list = host.listAnswer({ projects: [host.project(PROJECT, 'jenny-site', 'reader')], conversations: [] });
  const r = await teamChat(t, { answers: { projectList: list } });
  const why = r.page.getTeamSource().whyNot('create');
  assert.deepEqual([r.q('.board-team-conv__empty').textContent, r.q('[data-board-team-conv="new"]').disabled, r.q('[data-board-team-conv="new"]').title, why !== ''], ['No conversation in this project yet.', true, why, true]);
  const w = await teamChat(t, { answers: { projectList: host.listAnswer({ conversations: [] }), conversationCreate: created } });
  assert.equal(w.q('[data-board-team-conv="new"]').disabled, false);
  w.q('[data-board-team-conv="new"]').click();
  await w.flush();
  assert.deepEqual([w.q('.board-team-conv__empty'), inputs(w)], [null, 1]);
});

test('chat column: a conversation made here and deleted later is not kept as the one shown (wave 10 review)', async (t) => {
  const list = { rows: host.listAnswer().conversations };
  const m = await teamChat(t, { answers: { conversationCreate: { ok: true, session: { session_id: host.S3 } },
    projectList: () => host.listAnswer({ conversations: list.rows }) } });
  list.rows = [...list.rows.filter((row) => row.session_id !== host.S3), host.conversation(host.S3, PROJECT, 'Made here')];
  picker(m).click();
  await m.flush();
  await choose(m, 'New conversation');
  assert.deepEqual([picker(m).textContent.trim(), order(m).at(-1)], ['Made here', `conversationOpen:${host.S3}`]);
  // Someone deletes it: the list no longer names it, and the column shows a conversation that exists.
  list.rows = list.rows.filter((row) => row.session_id !== host.S3);
  m.window.rendererTeamProjectStore.getProjectStore().reread(TEAM);
  await m.flush();
  await frame();
  await m.flush();
  assert.deepEqual([picker(m).textContent.trim(), order(m).at(-1)], ['Palette loader cleanup', `conversationOpen:${S1}`]);
});

// A team board with a chat card of the project's second conversation and one of a conversation that is gone.
const chatCard = (n, sessionId, title) => ({ op: 'card.add', card: { id: uid(100 + n), kind: 'chat', data: { session_id: sessionId, message_id: null, title, excerpt: '' }, x: n * 300, y: 0 } });

test('chat cards on a team board: the Chat tool offers the project conversations, and a card opens its one in the chat column (wave 10 review)', async (t) => {
  const gone = 'sess_' + 'f'.repeat(32);
  const m = await mount(t, { boards: [teamBoard(1, 'Plan', chatCard(1, S2, 'Blog post draft'), chatCard(2, gone, 'Gone'))] });
  await pickTeam(m);
  await m.flush();
  m.q('[data-board-tool="kind-chat"]').click();
  await m.flush();
  assert.deepEqual([heads(m), items(m).map((el) => el.textContent.trim())], [['Add a chat from this project'], ['Palette loader cleanup', 'Blog post draft']],
    'the conversations of this team project, none of this Jenny own chats');
  await choose(m, 'Palette loader cleanup');
  const sent = m.bridge.of('boardApply').at(-1);
  assert.deepEqual(sent.batch.ops.map((op) => [op.op, op.card.kind, op.card.data.session_id, op.card.data.title]), [['card.add', 'chat', S1, 'Palette loader cleanup']]);
  // Enter on a chat card: the chat column opens on that conversation.
  m.captured.ctx.chat.setOpen(false);
  m.captured.part.sync();
  await m.flush();
  assert.deepEqual([m.captured.ctx.chat.isOpen(), picker(m)], [false, null]);
  assert.equal(m.captured.ctx.canvas.activate(uid(101), 'canvas'), true);
  await m.flush();
  await frame();
  await m.flush();
  assert.deepEqual([m.captured.ctx.chat.isOpen(), picker(m).textContent.trim(), order(m).at(-1), m.toasts.length], [true, 'Blog post draft', `conversationOpen:${S2}`, 0]);
  // A card whose conversation is gone says so and changes nothing.
  assert.equal(m.captured.ctx.canvas.activate(uid(102), 'canvas'), true);
  await m.flush();
  assert.deepEqual([m.toasts.at(-1).message, picker(m).textContent.trim()], ['That chat is no longer here.', 'Blog post draft']);
});

test('chat column: who else has the board open, by name', async (t) => {
  const board = teamBoard(1, 'Plan', note(1, 'hello'));
  const m = await teamChat(t, { boards: [board] });
  // With a conversation mounted its head says it (one line, with who is driving); the column's own line stays hidden.
  const line = () => { const sub = m.q('.board-team-conv .team-head__sub:not([data-standing])'); return sub ? sub.textContent : ''; };
  const push = (viewers) => m.bridge.push('onBoard', { kind: 'presence', team_id: TEAM, project_id: PROJECT, board_id: board.id, viewers, cursors: [], locks: [] });
  const head = () => m.q('.board-team-conv .team-head');
  assert.deepEqual([line(), head().querySelector('h2, .team-back'), head().querySelector('[data-standing]') !== null], ['', null, true], 'nobody else: no title of its own, the readers line stays');
  const thread = m.q('.board-team-conv [data-conv-region="log"]').firstChild;
  push([DOT, MAYA]);
  assert.deepEqual([line(), m.q('.board-team-conv__viewers').hidden], [`${iso('Maya')} and you are viewing`, true]);
  push([DOT, MAYA, 'member_zed']);
  assert.equal(line(), `${iso('Maya')}, ${iso('a former member')} and you are viewing`);
  push([DOT, MAYA, 'member_a', 'member_b', 'member_c']);
  assert.equal(line(), `${iso('Maya')}, ${iso('a former member')} and 2 more are viewing`);
  push([DOT]);
  assert.equal(line(), '');
  assert.equal(m.q('.board-team-conv [data-conv-region="log"]').firstChild, thread, 'a change of who is viewing never redraws the thread');
});

test('a message sent from the Board names the open board; with no board open it names none', async (t) => {
  const board = teamBoard(1, 'Plan');
  const m = await teamChat(t, { boards: [board] });
  const send = async (text) => { const field = m.q('#teamConversationInput'); field.value = text; m.q('[data-project-action="send"]').click(); await m.flush(); };
  await send('look at this');
  assert.deepEqual(m.bridge.of('conversationSend').at(-1), { team_id: TEAM, session_id: S1, prompt: 'look at this', board_id: board.id });
  assert.equal(m.q('.team-composer__hint').textContent, 'Jenny can see this board from here. The host and the computer that runs the model can read it.');
  const none = await teamChat(t);
  await (async () => { none.q('#teamConversationInput').value = 'hello'; none.q('[data-project-action="send"]').click(); await none.flush(); })();
  assert.deepEqual(none.bridge.of('conversationSend').at(-1), { team_id: TEAM, session_id: S1, prompt: 'hello' });
  assert.equal(none.q('.team-composer__hint').textContent.includes('Jenny can see this board'), false, 'the hint is for an open board');
});

test('a hostile conversation title is text, in the picker and in its menu', async (t) => {
  const evil = '<img src=x onerror=1>';
  const list = host.listAnswer({ conversations: [{ session_id: S1, title: evil, project_id: PROJECT }, { session_id: S2, title: 'Two', project_id: PROJECT }] });
  const m = await teamChat(t, { answers: { projectList: list } });
  picker(m).click();
  await m.flush();
  assert.deepEqual([picker(m).textContent.trim(), items(m).map((el) => el.textContent.trim()), m.qa('[data-board-chat-host] img').length], [evil, [evil, 'Two', 'New conversation'], 0]);
});

const PRESENCE = { viewers: [DOT, MAYA], cursors: [{ member_id: DOT, x: 5, y: 5, selected: [] }, { member_id: MAYA, x: 120, y: 80, selected: [] }, { member_id: 'member_gone', x: 10, y: 10, selected: [] }], locks: [{ card_id: uid(101), member_id: MAYA }] };
const presenceMount = (t, extra = {}) => mount(t, { boards: [teamBoard(1, 'Plan', note(1, 'hello'))], answers: { boardOpen: opened(teamBoard(1, 'Plan', note(1, 'hello')), PRESENCE) }, ...extra });
const pushPresence = (m, state) => m.bridge.push('onBoard', { kind: 'presence', team_id: TEAM, project_id: PROJECT, board_id: boardId(1), ...state });
const cursors = (m) => m.qa('.inv-board-layer .board-team-cursor');

test('presence: another member pointer is drawn with their name, moves on a push, and is not drawn for this member', async (t) => {
  const m = await presenceMount(t);
  await pickTeam(m);
  await m.flush();
  assert.deepEqual(cursors(m).map((el) => [el.textContent, el.getAttribute('aria-hidden'), el.style.left, el.style.top]), [['Maya', 'true', '120px', '80px'], ['Former member', 'true', '10px', '10px']]);
  const node = cursors(m)[0];
  pushPresence(m, { viewers: [DOT, MAYA], cursors: [{ member_id: MAYA, x: 200, y: 90, selected: [] }], locks: [] });
  assert.deepEqual([cursors(m).length, cursors(m)[0] === node, node.style.left, node.style.top], [1, true, '200px', '90px'], 'the same node moved');
  assert.equal(m.q('.board-team-hold'), null, 'the hold went with the lock');
});

test('presence: a note another member holds says who is typing; both go when the board closes', async (t) => {
  const m = await presenceMount(t);
  await pickTeam(m);
  await m.flush();
  const hold = m.q('.inv-board-layer .board-team-hold');
  assert.deepEqual([hold.textContent, hold.style.left, hold.style.top], [`${iso('Maya')} is typing`, '300px', '0px']);
  await openMenu(m);
  await choose(m, 'General');
  assert.deepEqual([m.qa('.board-team-cursor, .board-team-hold, [data-board-team-presence]').length], [0]);
});

test('presence: this member pointer is sent in board coordinates, the newest one at most every 100 ms, readers included', async (t) => {
  const reader = host.listAnswer({ projects: [host.project(PROJECT, 'jenny-site', 'reader')] });
  const m = await presenceMount(t, { answers: { projectList: reader, boardOpen: opened(teamBoard(1, 'Plan', note(1, 'hello')), PRESENCE) } });
  await pickTeam(m);
  await m.flush();
  const queue = [];
  m.window.requestAnimationFrame = (fn) => queue.push(fn);
  m.window.cancelAnimationFrame = () => {};
  const surface = m.captured.ctx.canvas.surface;
  const move = (x, y) => surface.element.dispatchEvent(new m.window.MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
  const sent = () => m.bridge.of('boardCursor');
  // The clock and the timers are this test's own.
  const timers = [];
  const realSet = m.window.setTimeout;
  let clock = 5000;
  m.window.performance.now = () => clock;
  m.window.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  t.after(() => { m.window.setTimeout = realSet; });
  move(10, 20); move(30, 40); move(50, 60);
  assert.deepEqual([sent().length, queue.length], [0, 1], 'one frame is asked for, nothing is sent yet');
  queue.splice(0).forEach((fn) => fn(0));
  const at = surface.toBoard(50, 60);
  assert.deepEqual([sent().length, sent()[0].x, sent()[0].y, sent()[0].selected, sent()[0].board_id], [1, at.x, at.y, [], boardId(1)]);
  // Inside the next 100 ms nothing more goes, however many frames pass: one timer waits, then the newest position goes.
  assert.equal(timers.length, 0, 'the first move waits for a frame only');
  clock += 40;
  move(70, 80); move(90, 100);
  assert.deepEqual([sent().length, queue.length, timers.map((timer) => timer.ms)], [1, 0, [60]], 'no frame is asked for; one timer for what is left of the 100 ms');
  clock += 60;
  timers.splice(0).forEach((timer) => timer.fn());
  queue.splice(0).forEach((fn) => fn(0));
  const last = surface.toBoard(90, 100);
  assert.deepEqual([sent().length, sent()[1].x, sent()[1].y], [2, last.x, last.y]);
  clock += 250;
  move(1, 2);
  assert.deepEqual([queue.length, timers.length], [1, 0], 'after a pause the next move goes in the next frame');
});

test('presence: a hostile member name is text on the pointer, the typing label and the viewers line', async (t) => {
  const evil = '<img src=x onerror=1>';
  const members = { ok: true, members: [{ member_id: DOT, display_name: 'Dot', role: 'member', state: 'active', devices: [] }, { member_id: MAYA, display_name: evil, role: 'member', state: 'active', devices: [] }] };
  const m = await presenceMount(t, { answers: { members, boardOpen: opened(teamBoard(1, 'Plan', note(1, 'hello')), PRESENCE) } });
  await pickTeam(m);
  assert.equal(m.captured.part.openChat(), true);
  await m.flush();
  assert.deepEqual([m.q('.board-team-cursor').textContent, m.q('.board-team-hold').textContent, m.q('.board-team-conv .team-head__sub:not([data-standing])').textContent.includes(evil), m.qa('.board-team-conv img, .inv-board-layer img').length],
    [evil, `${iso(evil)} is typing`, true, 0]);
});

// A board whose cards were made by different members, with a later change by another.
function authored() {
  let board = model.createBoard({ id: boardId(2), project_id: PROJECT, name: 'Made', now: NOW }).board;
  const batch = (n, actor, ops) => {
    const made = model.applyBatch(board, { batch_id: `a${n}`, board_id: board.id, actor, ops }, { now: NOW });
    assert.equal(made.ok, true, JSON.stringify(made));
    board = made.board;
  };
  batch(1, MAYA, [note(1, 'by Maya')]);
  batch(2, DOT, [note(2, 'by me')]);
  batch(3, 'owner', [note(3, 'by owner')]);
  batch(4, 'member_gone', [note(4, 'by gone')]);
  batch(5, DOT, [{ op: 'card.edit', id: uid(101), content_rev: 0, data: { text: 'by Maya, edited' } }]);
  batch(6, MAYA, [{ op: 'card.edit', id: uid(102), content_rev: 0, data: { text: 'by me, edited' } }]);
  return board;
}

test('who added a card: the four wordings, with and without who changed it last, and none on a board of the member own', async (t) => {
  const board = authored();
  const m = await mount(t, { boards: [board], answers: { boardOpen: opened(board) } });
  await pickTeam(m);
  await m.flush();
  const tip = (n) => m.q(`[data-card-id="${uid(100 + n)}"]`).getAttribute('title');
  assert.deepEqual([1, 2, 3, 4].map(tip), [`Added by ${iso('Maya')}. Last changed by you.`, `Added by you. Last changed by ${iso('Maya')}.`, 'Added by you', 'Added by a former member']);
  // A member whose name is the word this page uses for the reader is still someone else (decided by id, wave 10 review).
  const named = { ok: true, members: ROSTER.members.map((member) => (member.member_id === MAYA ? { ...member, display_name: 'you' } : member)) };
  const y = await mount(t, { boards: [board], answers: { boardOpen: opened(board), members: named } });
  await pickTeam(y);
  await y.flush();
  assert.equal(y.q(`[data-card-id="${uid(101)}"]`).getAttribute('title'), `Added by ${iso('you')}. Last changed by you.`, 'two people: the member named "you" and the reader');
  const own = await mount(t);
  await own.own.create({ projectId: 'project_alpha', name: 'Mine' });
  await own.page.reload();
  await own.flush();
  assert.equal(own.qa('[data-card-id][title]').length, 0, 'no tooltip on a board of the member own');
});

test('note lock: the hold is asked for before the editor opens, a refusal opens none and says why, and ending the edit gives it up', async (t) => {
  const m = await mount(t, { boards: [teamBoard(1, 'Plan', note(1, 'hello'))] });
  await pickTeam(m);
  await m.flush();
  const field = () => m.q('[data-board-editor] textarea');
  let grant = null;
  m.bridge.answers.boardLock = () => new Promise((resolve) => { grant = () => resolve({ ok: true }); });
  assert.equal(m.captured.ctx.canvas.startEdit(uid(101)), true);
  await frame();
  assert.deepEqual([field(), m.bridge.of('boardLock').map((p) => p.card_id)], [null, [uid(101)]], 'asked for first, no editor while it is not answered');
  grant();
  await m.flush();
  assert.equal(field() !== null, true);
  field().dispatchEvent(new m.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await m.flush();
  assert.equal(m.bridge.of('boardUnlock').length, 1);
  m.bridge.answers.boardLock = { ok: false, error: { reason: 'team_board_note_locked' }, held_by: MAYA };
  m.captured.ctx.canvas.startEdit(uid(101));
  await m.flush();
  assert.deepEqual([field(), m.toasts.at(-1).message], [null, 'Someone else is editing that note.']);
});

test('note lock: a hold the host gave is given back when the editor fails to open, and the note can be asked for again', async (t) => {
  const m = await mount(t, { boards: [teamBoard(1, 'Plan', note(1, 'hello'))] });
  await pickTeam(m);
  await m.flush();
  const create = m.doc.createElement.bind(m.doc);
  m.bridge.answers.boardLock = () => { m.doc.createElement = (tag) => { if (tag === 'textarea') throw new Error('no editor'); return create(tag); }; return { ok: true }; };
  assert.equal(m.captured.ctx.canvas.startEdit(uid(101)), true);
  await m.flush();
  assert.deepEqual([m.bridge.of('boardLock').length, m.bridge.of('boardUnlock').length, m.q('[data-board-editor] textarea')], [1, 1, null]);
  m.doc.createElement = create;
  m.bridge.answers.boardLock = { ok: true };
  m.captured.ctx.canvas.startEdit(uid(101));
  await m.flush();
  assert.deepEqual([m.bridge.of('boardLock').length, m.q('[data-board-editor] textarea') !== null], [2, true]);
});

test('note lock: a note another member holds is not asked for, and says who; on a board of the member own none of it runs', async (t) => {
  const m = await presenceMount(t);
  await pickTeam(m);
  await m.flush();
  m.captured.ctx.canvas.startEdit(uid(101));
  await m.flush();
  assert.deepEqual([m.bridge.of('boardLock').length, m.qa('[data-board-editor] textarea').length, m.toasts.at(-1).message], [0, 0, `${iso('Maya')} is editing this note.`]);
  const own = await mount(t);
  await own.own.create({ projectId: 'project_alpha', name: 'Mine' });
  await own.page.reload();
  await own.flush();
  assert.deepEqual([own.bridge.of('boardLock').length, own.bridge.of('boardUnlock').length], [0, 0]);
});

// ---- proposals (the page does not mount the proposals view yet: it is driven here the way renderer-board-proposals-view.test.js does)

const actionButton = require('../renderer/inventory/action-button');
const { createProposalsView } = require('../renderer/features/board/board-proposals-view');

const change = (n, type, cls, summary) => ({ n, line: `${type} line ${n}`, type, class: cls, state: 'pending', reason: '', summary });
function proposal(by) {
  const changes = [change(1, 'note', 'addition', { text: 'A', group: '' }), change(2, 'edit', 'edit', { target: 'n3', before: 'hello', after: 'hi' }), change(3, 'remove', 'removal', { target: 'n4', kind: 'note', label: 'Gone' })];
  return { id: 'p1', sessionId: S1, messageId: 'm1', state: 'pending', open: true, createdAt: NOW, madeAgainstRev: 1, overflow: 0, prompterMemberId: by,
    counts: { total: 3, pending: 3, additions: 1, edits: 1, removals: 1, applied: 0, refused: 0, skipped: 0, rejected: 0 }, changes, preview: null };
}
async function proposals(t, { by = MAYA, team = { whyNot: () => '' } } = {}) {
  const { window } = new JSDOM('<!doctype html><body><div class="centre"><div class="canvas"><div class="layer"></div></div></div><div id="host"></div></body>', { url: 'https://jenny.invalid/' });
  const doc = window.document;
  const host = doc.getElementById('host');
  const decided = [];
  const names = { [MAYA]: 'Maya', [DOT]: 'Dot', member_named_you: 'You' }; // "is this me" is asked by id: a member may be named You
  const part = createProposalsView({ document: doc, windowRef: window, actionButton, notify() {}, log() {},
    editor: { getBoard: () => ({ id: boardId(1) }), onChange: () => () => {} },
    source: { listProposals: async () => ({ ok: true, proposals: [proposal(by)] }), decideProposal: async (request) => { decided.push(request); return { ok: true }; }, onChanged: () => () => {} },
    surface: { element: doc.querySelector('.canvas'), layer: doc.querySelector('.layer') },
    context: { getChangesHost: () => host, revealChanges: () => true, getTeamSource: () => team, nameOfMember: (id) => names[id] || '', isSelfMember: (id) => id === DOT } });
  t.after(() => { part.dispose(); window.close(); });
  await flush();
  return { doc, host, decided, bar: () => doc.querySelector('[data-board-proposal-bar]'), flush };
}

test('proposals on a team board: who asked, in the bar and the Review list; nothing of it on a board of the member own', async (t) => {
  for (const [by, bar, line] of [[MAYA, 'asked by Maya', 'Maya asked. Anyone who can write in this project and is viewing this board can answer.'],
    [DOT, 'asked by you', 'You asked. Anyone who can write in this project and is viewing this board can answer.'],
    ['member_named_you', 'asked by You', 'You asked. Anyone who can write in this project and is viewing this board can answer.']]) {
    const h = await proposals(t, { by });
    assert.deepEqual([h.bar().querySelector('.board-proposal-bar__by').textContent, h.host.querySelector('.board-changes__asked').textContent], [bar, line]);
  }
  const unknown = await proposals(t, { by: 'member_gone' });
  assert.deepEqual([unknown.bar() !== null, unknown.doc.querySelector('.board-proposal-bar__by'), unknown.host.querySelector('.board-changes__asked')], [true, null, null]);
  const own = await proposals(t, { team: null });
  assert.deepEqual([own.bar() !== null, own.doc.querySelector('.board-proposal-bar__by'), own.host.querySelector('.board-changes__asked')], [true, null, null]);
});

test('proposals on a team board: a reader has every answer control off with the source sentence; a writer accepts additions and no edit or removal goes with it', async (t) => {
  const why = 'You can look at this board. Writers and admins of this project can change it.';
  const reader = await proposals(t, { team: { whyNot: (name) => (name === 'decideProposal' ? why : '') } });
  const controls = [...reader.doc.querySelectorAll('button[data-board-act]')].filter((el) => /^(accept-additions|accept|reject|reject-all|dismiss)$/.test(el.getAttribute('data-board-act')));
  assert.equal(controls.length >= 4, true, 'the bar and the list have answer controls');
  assert.deepEqual(controls.filter((el) => !el.disabled || el.title !== why).map((el) => el.getAttribute('data-board-act')), []);
  const review = reader.doc.querySelector('[data-board-act="review"]');
  assert.equal(review.disabled, false, 'looking at the list is not answering');
  const writer = await proposals(t);
  writer.bar().querySelector('[data-board-act="accept-additions"]').click();
  await writer.flush();
  assert.deepEqual(writer.decided, [{ boardId: boardId(1), proposalId: 'p1', action: 'accept_additions' }]);
});
