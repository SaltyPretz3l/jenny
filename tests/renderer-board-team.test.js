'use strict';

// new-test-file: a new surface (row 151 slice T7: the team half of the Board page). The real Board page in team scope, with the
// scripted `team` bridge, the real team and project stores, and the four parts of renderer/features/board/board-team*.js. The
// conversation in the chat column is renderer-board-team-chat.test.js (this file would pass the 600-line cap); the data layer
// under the page is renderer-board-team-source.test.js.

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

test('the page with Team on and a team joined: the list heading is the project button, with the team page attached once', async (t) => {
  const m = await mount(t);
  assert.equal(m.button() !== null, true, 'the heading holds a button');
  assert.equal(m.button().getAttribute('aria-haspopup'), 'menu');
  assert.equal(m.button().textContent.includes('Alpha'), true, 'it names the project shown');
});

test('Team off, or no team joined: the heading is the plain heading and none of the team part is on the page', async (t) => {
  for (const options of [{ gate: false }, { rows: [] }, { team: false, rows: [] }]) {
    const m = await mount(t, options);
    assert.deepEqual([m.button(), m.heading().textContent, m.heading().tagName], [null, 'Alpha', 'H2'], JSON.stringify(Object.keys(options)));
    assert.equal(m.captured.part === null || m.captured.part.listState().menu === false, true);
    assert.deepEqual([m.qa('[data-board-team-presence], .board-team-conv, [data-board-team-foot]').length, m.loads.some((l) => l.scripts.includes('rendererTeamProjectStore'))], [0, false]);
  }
});

test('the project menu: my projects, then each team with its projects; the one shown is marked; choosing goes through the page', async (t) => {
  const m = await mount(t);
  await openMenu(m);
  assert.deepEqual([m.button().getAttribute('aria-expanded'), heads(m), items(m).map((el) => el.textContent.trim())], ['true', ['My projects', `${iso('Dot lab')} team`], ['Alpha', 'General', 'jenny-site', 'palette-tools']]);
  assert.deepEqual(items(m).filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.textContent.trim()), ['Alpha']);
  assert.equal(items(m).every((el) => el.getAttribute('role') === 'menuitemradio'), true, 'one closed set');
  await choose(m, 'jenny-site');
  assert.deepEqual([m.page.getTeamSource() !== null, m.page.getProject().team.id, m.heading().textContent, m.bridge.of('boardList').map((p) => p.project_id)], [true, TEAM, 'jenny-siteDot lab team', [PROJECT]]);
  assert.equal(m.button().getAttribute('aria-expanded'), 'false');
  await openMenu(m);
  assert.deepEqual(items(m).filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.textContent.trim()), ['jenny-site']);
  await choose(m, 'General');
  assert.deepEqual([m.page.getTeamSource(), m.switched, m.heading().textContent], [null, ['project_general'], 'General'], 'back to this Jenny, and the app project switched');
  await openMenu(m);
  await choose(m, 'General');
  assert.deepEqual([m.page.getTeamSource(), m.switched.length], [null, 1], 'the project that is already current is not switched to');
});

test('the Team tab scripts are asked for on the first menu open, not at attach', async (t) => {
  const m = await mount(t);
  const asked = () => m.loads.map((l) => l.scripts.join(','));
  assert.equal(asked().length > 0 && asked().every((s) => !s.includes('rendererTeamProjectStore')), true);
  assert.deepEqual(m.loads.find((l) => l.styles.length).styles, ['styles/board-team.css']);
  await openMenu(m);
  const tab = m.loads.filter((l) => l.scripts.includes('rendererTeamProjectStore'));
  assert.deepEqual([tab.length, tab[0].styles], [1, ['styles/team-tab.css']]);
  await choose(m, 'Alpha');
  await openMenu(m);
  assert.equal(m.loads.filter((l) => l.scripts.includes('rendererTeamProjectStore')).length, 1, 'loaded once');
  const failing = await mount(t);
  failing.window.rendererTeamTabGate.ensureTeamAssets = async (request) => !request.scripts.some(([, name]) => name === 'rendererTeamProjectStore');
  await openMenu(failing);
  assert.deepEqual([failing.menu(), failing.toasts.map((x) => [x.message, x.tone])], [null, [['Team projects could not be loaded. Try again.', 'warning']]]);
});

test('a reader sees New board, rename and Delete disabled with the source sentence; a writer, only Delete', async (t) => {
  const list = host.listAnswer({ projects: [host.project(PROJECT, 'jenny-site', 'reader'), host.project(P2, 'palette-tools', 'writer')] });
  const m = await mount(t, { boards: [teamBoard(1, 'Plan')], answers: { projectList: list } });
  await pickTeam(m, 'jenny-site');
  const source = m.page.getTeamSource();
  const state = () => ['new', 'rename', 'delete'].map((name) => m.q(name === 'new' ? '[data-board-action="new"]' : `[data-board-id] [data-board-action="${name}"]`)).map((el) => [el.disabled, el.title]);
  assert.deepEqual(state(), [[true, source.whyNot('create')], [true, source.whyNot('rename')], [true, source.whyNot('delete')]]);
  assert.equal(source.whyNot('create') !== '', true);
  await openMenu(m);
  await choose(m, 'palette-tools');
  const writer = m.page.getTeamSource();
  assert.deepEqual(state().map(([disabled]) => disabled), [false, false, true]);
  assert.equal(state()[2][1], writer.whyNot('delete'));
});

test('a team project shows the host-can-read line; the member own project does not', async (t) => {
  const m = await mount(t);
  assert.equal(m.q('[data-board-team-foot]'), null);
  await pickTeam(m);
  assert.equal(m.q('[data-board-team-foot]').textContent, `Shared with the members of ${iso('jenny-site')}. The host can read it.`);
  assert.equal(m.q('.board-list__foot:not([data-board-team-foot])').textContent.includes('boards'), true, 'the count line stays');
  await openMenu(m);
  await choose(m, 'General');
  assert.equal(m.q('[data-board-team-foot]'), null);
});

test('the project shown leaves the project store: back to the member own project with a toast; a role change reads the board again', async (t) => {
  const m = await mount(t);
  await pickTeam(m);
  const reads = () => m.bridge.of('boardList').length;
  const before = reads();
  m.bridge.push('onProject', { team_id: TEAM, kind: 'projects', ...host.listAnswer({ projects: [host.project(PROJECT, 'jenny-site', 'reader'), host.project(P2, 'palette-tools', 'admin')] }) });
  await m.flush();
  assert.equal(reads() > before, true, 'the board list is read again');
  m.bridge.push('onProject', { team_id: TEAM, kind: 'projects', ...host.listAnswer({ projects: [host.project(P2, 'palette-tools', 'admin')] }) });
  await m.flush();
  assert.deepEqual([m.page.getTeamSource(), m.heading().textContent, m.toasts.map((x) => [x.message, x.tone])], [null, 'Alpha', [[`You no longer have access to ${iso('jenny-site')}.`, 'warning']]]);
  await pickTeam(m, 'palette-tools');
  m.window.rendererTeamStore.getTeamStore().seed({ teams: [] });
  await m.flush();
  assert.deepEqual([m.page.getTeamSource(), m.toasts.length], [null, 2], 'a team left is the same');
});

test('the last team project shown is shown again by a new page on the window; a new window starts on the own project', async (t) => {
  const m = await mount(t);
  await pickTeam(m);
  await m.again();
  await m.flush();
  assert.deepEqual([m.page.getProject().team && m.page.getProject().team.id, m.page.getProject().id, m.heading().textContent], [TEAM, PROJECT, 'jenny-siteDot lab team']);
  const stored = JSON.stringify(Object.entries(m.window.localStorage));
  assert.equal([TEAM, PROJECT, 'Dot lab', 'jenny-site'].some((word) => stored.includes(word)), false, 'nothing of the pick is stored');
  await openMenu(m);
  await choose(m, 'General');
  await m.again();
  assert.equal(m.page.getProject().team, undefined, 'choosing an own project forgets it');
  const fresh = await mount(t);
  assert.equal(fresh.page.getProject().team, undefined);
});

test('dispose removes the holds and subscriptions; a second dispose does nothing', async (t) => {
  const m = await mount(t);
  const baseline = m.bridge.listeners();
  await pickTeam(m);
  assert.equal(m.bridge.listeners() > baseline, true);
  const { part } = m.captured;
  m.page.dispose();
  part.dispose();
  assert.deepEqual([m.bridge.listeners(), m.qa('.board-team-conv, [data-board-team-presence]').length, m.doc.querySelector('.inv-context-menu')], [baseline, 0, null]);
});

test('Undo and Redo on a team board are disabled with the source sentence as their tooltip', async (t) => {
  const m = await mount(t, { boards: [teamBoard(1, 'Plan', note(1, 'hello'))] });
  await pickTeam(m);
  await m.flush();
  const why = m.page.getTeamSource().whyNot('undo');
  assert.equal(why !== '', true);
  assert.deepEqual(['undo', 'redo'].map((tool) => [m.q(`[data-board-tool="${tool}"]`).disabled, m.q(`[data-board-tool="${tool}"]`).title]), [[true, why], [true, why]]);
});

// A board of the member's own in project Alpha, listed; the team answers for an import.
async function withOwnBoard(t, { answers = {}, list = null } = {}) {
  const copy = teamBoard(7, 'Mine');
  const m = await mount(t, { boards: [copy], answers: { boardImport: { ok: true, board: row(copy), pictures: [] }, ...(list ? { projectList: list } : {}), ...answers } });
  await m.own.create({ projectId: 'project_alpha', name: 'Mine' });
  await m.page.reload();
  await m.flush();
  return { m, copy };
}
const openExport = async (m) => { m.q('[data-board-id] [data-board-action="export"]').click(); await m.flush(); };
const copyItem = (m) => items(m).find((el) => el.textContent.trim() === 'Copy to a team project…');

test('the Export menu ends with Copy to a team project only on a board of the member own, with a team joined', async (t) => {
  const { m } = await withOwnBoard(t);
  await openExport(m);
  assert.equal(items(m).at(-1), copyItem(m), 'it is the last item');
  m.doc.body.click();
  const off = await mount(t, { rows: [] });
  await off.own.create({ projectId: 'project_alpha', name: 'Mine' });
  await off.page.reload();
  await off.flush();
  await openExport(off);
  assert.equal(copyItem(off), undefined);
  const inTeam = await withOwnBoard(t);
  await pickTeam(inTeam.m);
  await inTeam.m.flush();
  assert.equal(inTeam.m.captured.part.listState().copy, false, 'a team project does not offer a copy');
});

test('Copy to a team project: with no team project of this member to copy to, it says so and opens nothing', async (t) => {
  const { m } = await withOwnBoard(t, { list: host.listAnswer({ projects: [] }) });
  await openExport(m);
  copyItem(m).click();
  await m.flush();
  assert.deepEqual([m.toasts.map((toast) => [toast.message, toast.tone]), m.menu()], [[['You are not in a team project yet.', 'warning']], null]);
});

test('Copy to a team project: a project the member cannot write in is disabled with its sentence, and the menu ends with the note', async (t) => {
  const list = host.listAnswer({ projects: [host.project(PROJECT, 'jenny-site', 'reader'), host.project(P2, 'palette-tools', 'writer')] });
  const { m } = await withOwnBoard(t, { list });
  await openExport(m);
  copyItem(m).click();
  await m.flush();
  const rows = items(m);
  const why = (el) => { const said = el.querySelector('.inv-context-menu-description'); return said ? said.textContent : ''; };
  assert.deepEqual([heads(m), rows.map((el) => [el.querySelector('span:not(.inv-context-menu-text)').textContent, el.disabled, why(el)])],
    [[`${iso('Dot lab')} team`], [['jenny-site', true, 'You can look at this project. Its writers and admins can add boards.'], ['palette-tools', false, '']]]);
  assert.equal(m.q('.inv-context-menu-footer').textContent, 'Chat cards are copied as their titles only.');
});

test('Copy to a team project: success says so with Open, which shows the team project with the new board open; the temporary source is gone', async (t) => {
  const { m, copy } = await withOwnBoard(t);
  await openExport(m);
  copyItem(m).click();
  await m.flush();
  const baseline = m.bridge.listeners(); // the project store is held from the first menu on
  await choose(m, 'jenny-site');
  assert.deepEqual([m.toasts.map((x) => x.message), m.toasts.at(-1).actions.map((a) => [a.label, a.kind]), m.bridge.listeners()], [[`Copying to ${iso('jenny-site')}…`, `Copied to ${iso('jenny-site')}.`], [['Open', 'primary']], baseline]);
  assert.equal(m.bridge.of('boardImport').length, 1);
  m.toasts.at(-1).actions[0].onClick();
  await m.flush();
  await frame();
  await m.flush();
  assert.deepEqual([m.page.getProject().team.id, m.page.getOpenBoardId()], [TEAM, copy.id]);
});

test('Copy to a team project: pictures that could not be sent are counted; a refusal says the source sentence; the source is disposed either way', async (t) => {
  const { m, copy } = await withOwnBoard(t, { answers: { boardImport: { ok: true, board: row(teamBoard(7, 'Mine')), pictures: [uid(900)] } } });
  await openExport(m);
  copyItem(m).click();
  await m.flush();
  const baseline = m.bridge.listeners();
  await choose(m, 'jenny-site');
  assert.deepEqual([m.toasts.map((x) => x.message).at(-1), m.bridge.listeners()], [`Copied to ${iso('jenny-site')}. 1 picture could not be sent.`, baseline]);
  assert.equal(copy.id, boardId(7));
  m.bridge.answers.boardImport = { ok: false, error: { reason: 'team_board_storage_limit' } };
  await openExport(m);
  copyItem(m).click();
  await m.flush();
  await choose(m, 'jenny-site');
  const last = m.toasts.at(-1);
  assert.deepEqual([last.message, last.tone, m.bridge.listeners()], ["This project's boards have used the space the team server gives them.", 'warning', baseline]);
});

test('the six board sentences of a project Activity, singular and plural', async () => {
  const { createActivity } = require('../renderer/team/renderer-team-project-activity');
  const entry = (seq, kind, detail) => ({ seq, at: seq, kind, project_id: PROJECT, session_id: null, actor_member_id: DOT, prompter_member_id: MAYA, tool_name: null, decision: null, detail });
  const names = { [DOT]: 'Dot', [MAYA]: 'Maya' };
  const lines = async (...entries) => {
    const view = createActivity({ teamId: TEAM, projectId: PROJECT, call: async () => ({ ok: true, entries, next_cursor: null }), nameOf: (id) => names[id] || '', conversationTitle: () => '',
      timeText: () => '', errorText: () => '', onChange() {} });
    await flush();
    return [...view.html().matchAll(/<span dir="auto">([^<]*)<\/span>/g)].map((x) => x[1]).reverse();
  };
  assert.deepEqual(await lines(entry(1, 'board_deleted', {}), entry(2, 'board_restored', {}), entry(3, 'board_batch_reverted', {}), entry(4, 'board_bulk_removed', { items: 1 }), entry(5, 'board_bulk_removed', { items: 3 })), [
    'Dot deleted a board', 'Dot restored a board', 'Dot took back a change on a board', 'Dot removed 1 item from a board', 'Dot removed 3 items from a board']);
  assert.deepEqual(await lines(entry(1, 'board_proposal_accepted', { change: 0, count: 1 }), entry(2, 'board_proposal_accepted', { change: 0, count: 4 }), entry(3, 'board_proposal_accepted', { change: 2 }),
    entry(4, 'board_proposal_rejected', { change: 0, count: 1 }), entry(5, 'board_proposal_rejected', { change: 0, count: 4 }), entry(6, 'board_proposal_rejected', { change: 2 })), [
    'Dot accepted 1 board change that Maya asked Jenny for', 'Dot accepted 4 board changes that Maya asked Jenny for', 'Dot accepted a board change that Maya asked Jenny for',
    'Dot rejected 1 board change that Maya asked Jenny for', 'Dot rejected 4 board changes that Maya asked Jenny for', 'Dot rejected a board change that Maya asked Jenny for']);
});

test('hostile team, project, member and board names appear as text and make no element', async (t) => {
  const evil = '<img src=x onerror=1>';
  const boards = [teamBoard(1, evil)];
  const list = host.listAnswer({ projects: [host.project(PROJECT, evil, 'writer')] });
  const m = await mount(t, { boards, rows: [host.memberTeam({ team_name: evil })], answers: { projectList: list } });
  await openMenu(m);
  assert.deepEqual([heads(m), items(m).at(-1).textContent.trim()], [['My projects', `${iso(evil)} team`], evil]);
  await choose(m, evil);
  assert.deepEqual([m.heading().textContent, m.names()], [`${evil}${evil} team`, [evil]]);
  assert.equal(m.q('[data-board-team-foot]').textContent, `Shared with the members of ${iso(evil)}. The host can read it.`);
  assert.equal(m.qa('img').length, 0, 'no element was made from a name');
});

// Row 175 F11 (Team side): rendererBoardTeam.requestOpen asks the Board page to show a team board.
const until = async (m, check) => { for (let i = 0; i < 40 && !check(); i += 1) { await m.flush(); await frame(); } return check(); };

test('requestOpen: a request that names no team, project or board is refused', () => {
  assert.deepEqual([{}, null, { teamId: TEAM, projectId: PROJECT }, { teamId: TEAM, boardId: 'b' }, { teamId: 5, projectId: PROJECT, boardId: 'b' }].map((r) => boardTeam.requestOpen(r)), [false, false, false, false, false]);
});

test('requestOpen on a live page: its team project is shown and the named board opens', async (t) => {
  const m = await mount(t, { boards: [teamBoard(1, 'Plan'), teamBoard(2, 'Ideas')] });
  assert.equal(m.page.getProject().team, undefined, 'the member\'s own project first');
  assert.equal(boardTeam.requestOpen({ teamId: TEAM, projectId: PROJECT, boardId: boardId(2) }), true);
  assert.equal(await until(m, () => m.page.getOpenBoardId() === boardId(2)), true);
  assert.deepEqual([m.page.getProject().team.id, m.page.getProject().id], [TEAM, PROJECT]);
  // Already on that project: another board of it opens without a second pick.
  boardTeam.requestOpen({ teamId: TEAM, projectId: PROJECT, boardId: boardId(1) });
  assert.equal(await until(m, () => m.page.getOpenBoardId() === boardId(1)), true);
});

test('requestOpen with no page up waits for the next Board page that attaches the team', async (t) => {
  const m = await mount(t, { boards: [teamBoard(1, 'Plan'), teamBoard(2, 'Ideas')] });
  m.page.dispose();
  assert.equal(boardTeam.requestOpen({ teamId: TEAM, projectId: PROJECT, boardId: boardId(2) }), true);
  await m.again();
  assert.equal(await until(m, () => m.page.getProject().team && m.page.getOpenBoardId() === boardId(2)), true);
  assert.equal(m.page.getProject().team.id, TEAM);
});

// A promise the test settles by hand: a team that answers late, or a copy that is still on its way.
const held = () => { const out = {}; out.promise = new Promise((resolve) => { out.release = resolve; }); return out; };

test('the project menu with one team that never answers: the others show at once, the stalled one shows a pending row, and its projects arrive in place (H24)', async (t) => {
  const SLOW = 'team_SSSSSSSSSSSSSSSSSSSSSS';
  const late = held();
  const m = await mount(t, { rows: [host.memberTeam(), host.memberTeam({ team_id: SLOW, team_name: 'Slow lab' })],
    answers: { projectList: (payload) => (payload.team_id === SLOW ? late.promise : host.listAnswer()) } });
  await openMenu(m);
  assert.deepEqual([m.button().getAttribute('aria-expanded'), heads(m), items(m).map((el) => [el.textContent.trim(), el.disabled])],
    ['true', ['My projects', `${iso('Dot lab')} team`, `${iso('Slow lab')} team`], [['Alpha', false], ['General', false], ['jenny-site', false], ['palette-tools', false], ['Loading projects…', true]]],
    'the menu is up without waiting for the stalled team');
  const checked = items(m).find((el) => el.getAttribute('aria-checked') === 'true');
  assert.equal(m.doc.activeElement, checked, 'the focus is on the project shown');
  items(m)[2].focus();
  late.release(host.listAnswer());
  await m.flush();
  assert.deepEqual(items(m).map((el) => [el.textContent.trim(), el.disabled]), [['Alpha', false], ['General', false], ['jenny-site', false], ['palette-tools', false], ['jenny-site', false], ['palette-tools', false]],
    'the answer fills the row in place');
  assert.equal(m.doc.activeElement, items(m)[2], 'the row the keyboard was on keeps the focus through the redraw');
  assert.equal(m.button().getAttribute('aria-expanded'), 'true');
  m.doc.body.click();
  m.doc.dispatchEvent(new m.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(m.menu(), null);
  assert.equal(m.button().getAttribute('aria-expanded'), 'false');
});

test('Copy to a team project: a choice made again while the first copy is on its way is ignored, and the copy says it is in progress (H24)', async (t) => {
  const slow = held();
  const { m, copy } = await withOwnBoard(t, { answers: { boardImport: () => slow.promise } });
  await openExport(m);
  copyItem(m).click();
  await m.flush();
  await choose(m, 'jenny-site');
  await openExport(m);
  copyItem(m).click();
  await m.flush();
  await choose(m, 'jenny-site');
  assert.deepEqual([m.bridge.of('boardImport').length, m.toasts.map((x) => x.message)], [1, [`Copying to ${iso('jenny-site')}…`]]);
  slow.release({ ok: true, board: row(copy), pictures: [] });
  await m.flush();
  assert.deepEqual(m.toasts.map((x) => x.message), [`Copying to ${iso('jenny-site')}…`, `Copied to ${iso('jenny-site')}.`]);
  await openExport(m);
  copyItem(m).click();
  await m.flush();
  await choose(m, 'jenny-site');
  assert.equal(m.bridge.of('boardImport').length, 2, 'once the first one is done a new copy goes');
});
