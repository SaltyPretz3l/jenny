'use strict';

// The real Board page in team scope over jsdom, for the two hardening files of row 151 (renderer-board-team-hostile.test.js and
// renderer-board-team-a11y.test.js): the scripted `team` bridge, the real team and project stores, and the parts of
// renderer/features/board/board-team*.js, built the way tests/renderer-board-team.test.js builds them (that file keeps its own copy).

const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const model = require('../../services/boards/board-model');
const { createMemoryBoardSource } = require('../../renderer/features/board/board-source-memory');
const { createBoardPage } = require('../../renderer/features/board/board-page');
const boardTeam = require('../../renderer/features/board/board-team');
const boardTeamMenu = require('../../renderer/features/board/board-team-menu');
const boardTeamChat = require('../../renderer/features/board/board-team-chat');
const boardTeamPresence = require('../../renderer/features/board/board-team-presence');
const boardTeamHistory = require('../../renderer/features/board/board-team-history');
require('../../renderer/features/board/board-card-kinds').register('chat', require('../../renderer/features/board/board-card-chat').createChatPart);
const host = require('./team-project-renderer-host');
const { inventory } = require('./team-settings-harness');

const { OTHER: TEAM, P1: PROJECT, P2, S1, S2, DOT, MAYA, flush } = host;
const NOW = '2026-11-15T10:00:00.000Z';
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const boardId = (n) => `board_${uid(n)}`;
const frame = () => new Promise((resolve) => setTimeout(resolve, 20));
const note = (n, text) => ({ op: 'card.add', card: { id: uid(100 + n), kind: 'note', data: { text }, x: n * 300, y: 0 } });

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
  return { bridge, calls, answers, of: (name) => calls.filter(([n]) => n === name).map(([, payload]) => payload),
    listeners: () => [...subs.values()].reduce((sum, set) => sum + set.size, 0), push: (name, payload) => [...(subs.get(name) || [])].forEach((fn) => fn(payload)) };
}

const members = (list) => ({ ok: true, members: list.map(([member_id, display_name]) => ({ member_id, display_name, role: 'member', state: 'active', devices: [] })) });
const ROSTER = members([[DOT, 'Dot'], [MAYA, 'Maya']]);

// Mounts the real page on a fresh window; `registry` is what the team gate's loader puts on the window, by global name.
async function mount(t, { boards = [], rows = [host.memberTeam()], answers = {}, projects = [{ id: 'project_alpha', name: 'Alpha' }], current = 'project_alpha', frames = null, ownBoard = false } = {}) {
  for (const file of Object.keys(require.cache)) if (/[\\/]renderer[\\/]team[\\/]/.test(file) || /board-source-team/.test(file)) delete require.cache[file];
  const dom = new JSDOM('<!doctype html><body><section id="boardView"></section></body>', { url: 'https://jenny.invalid/', pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  const saved = ['window', 'document', 'inventory', 'inventoryContextMenu', 'markdownUtils'].map((key) => [key, globalThis[key]]);
  Object.assign(globalThis, { window, document: doc, inventory: inventory(), inventoryContextMenu: require('../../renderer/inventory/context-menu'), markdownUtils: require('../../renderer/shared/markdown-utils') });
  window.inventoryContextMenu = globalThis.inventoryContextMenu;
  if (frames) { window.requestAnimationFrame = frames.request; window.cancelAnimationFrame = frames.cancel; }
  const own = createMemoryBoardSource({ model });
  const ownBridge = new Proxy({}, { get: (_target, name) => (name === 'onChanged' ? (listener) => own.onChanged(listener) : (request) => own[name](request)) });
  const bridge = scriptedTeam({ projectList: host.listAnswer(), members: ROSTER, projectUnjoined: { ok: true, projects: [], truncated: false }, projectRules: host.rulesAnswer(),
    conversationOpen: { ok: true, snapshot: host.snapshot() }, boardList: { ok: true, boards: boards.map(row) },
    boardOpen: (payload) => opened(boards.find((board) => board.id === payload.board_id) || boards[0]), ...answers });
  window.jennyShell = { boards: ownBridge, team: bridge.bridge };
  const loads = [];
  const captured = { ctx: null, part: null };
  const registry = {
    rendererSettingsTeamStrings: () => require('../../renderer/shell/renderer-settings-team-strings'),
    rendererTeamStore: () => require('../../renderer/team/renderer-team-store'),
    rendererBoardSourceTeam: () => require('../../renderer/features/board/board-source-team'),
    rendererBoardTeamMenu: () => boardTeamMenu, rendererBoardTeamChat: () => boardTeamChat, rendererBoardTeamPresence: () => boardTeamPresence, rendererBoardTeamHistory: () => boardTeamHistory,
    rendererBoardTeam: () => ({ attachBoardTeam: (ctx) => { captured.ctx = ctx; captured.part = boardTeam.attachBoardTeam(ctx); return captured.part; } }),
    rendererTeamProjectStore: () => require('../../renderer/team/renderer-team-project-store'),
    rendererTeamProjectColumn: () => require('../../renderer/team/renderer-team-project-column'),
    rendererTeamMessageRow: () => require('../../renderer/team/renderer-team-message-row'),
    rendererTeamProjectBox: () => require('../../renderer/team/renderer-team-project-box'),
    rendererTeamProjectConversation: () => require('../../renderer/team/renderer-team-project-conversation'),
  };
  const list = (...names) => names.map((name) => [`x/${name}.js`, name]);
  window.rendererSettingsScriptManifest = Object.assign([], {
    teamBoard: list('rendererSettingsTeamStrings', 'rendererTeamStore', 'rendererBoardSourceTeam', 'rendererBoardTeamMenu', 'rendererBoardTeamChat', 'rendererBoardTeamPresence', 'rendererBoardTeamHistory', 'rendererBoardTeam'),
    teamTab: list('rendererTeamProjectStore', 'rendererTeamProjectColumn', 'rendererTeamMessageRow', 'rendererTeamProjectBox', 'rendererTeamProjectConversation'),
  });
  window.rendererTeamTabGate = { VIEW_STYLES: ['styles/team-tab.css'], ensureTeamAssets: async (request) => {
    loads.push(request.scripts.map(([, name]) => name));
    for (const [, name] of request.scripts) if (!window[name] && registry[name]) window[name] = registry[name]();
    return true;
  } };
  window.rendererTeamStore = registry.rendererTeamStore();
  window.rendererTeamStore.getTeamStore().seed({ teams: rows });
  const switched = [];
  let currentId = current;
  const watchers = new Set();
  const switcher = { currentProject: () => projects.find((p) => p.id === currentId) || { id: currentId, name: 'General' }, refresh: async () => [], getProjects: () => projects,
    onProjectsChanged: (fn) => { watchers.add(fn); return () => watchers.delete(fn); },
    switchToProject: async (id) => { switched.push(id); currentId = id; watchers.forEach((fn) => fn()); } };
  const toasts = [];
  const page = createBoardPage({ container: doc.getElementById('boardView'), windowRef: window, storage: window.localStorage, getProjectSwitcher: async () => switcher,
    showToast: (message, options) => toasts.push({ message, ...options }) });
  t.after(() => {
    page.dispose();
    window.rendererTeamStore.getTeamStore().dispose();
    require('../../renderer/inventory/context-menu').hide({ restoreFocus: false });
    window.close();
    for (const [key, value] of saved) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  });
  await page.started;
  await flush();
  if (ownBoard) { await own.create({ projectId: 'project_alpha', name: 'Mine' }); await page.reload(); await flush(); }
  const q = (selector) => doc.querySelector(selector);
  return { window, doc, page, captured, own, bridge, toasts, loads, switched, q, qa: (selector) => [...doc.querySelectorAll(selector)], flush,
    heading: () => q('[data-board-project]'), button: () => q('[data-board-project] button'), menu: () => q('.inv-context-menu') };
}

const items = (m) => [...m.doc.querySelectorAll('.inv-context-menu .inv-context-menu-item')];
const heads = (m) => [...m.doc.querySelectorAll('.inv-context-menu .inv-context-menu-heading')].map((el) => el.textContent);
// The team harness's flush waits out the stores' timers (about 100 ms); a menu or a pick needs only the promises to settle, then one frame.
const tick = async () => { for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const settle = async () => { await tick(); await frame(); await tick(); };
const chooseAt = async (m, index) => { const item = items(m)[index]; assert.ok(item, `menu row ${index}`); item.click(); await settle(m); };
const choose = async (m, label) => { const item = items(m).find((el) => el.textContent.trim() === label); assert.ok(item, `menu row ${label}`); item.click(); await settle(m); };
const openMenu = async (m) => { m.button().click(); await tick(); };
const pickTeam = async (m, name = 'jenny-site') => { await openMenu(m); await choose(m, name); };
const picker = (m) => m.q('[data-board-team-conv="pick"]');
// A team project with the chat column open and the first conversation mounted.
async function teamChat(t, options = {}) {
  const m = await mount(t, options);
  await pickTeam(m);
  assert.equal(m.captured.part.openChat(), true);
  await m.flush();
  return m;
}
const pushPresence = (m, state, board = boardId(1)) => m.bridge.push('onBoard', { kind: 'presence', team_id: TEAM, project_id: PROJECT, board_id: board, ...state });
const PRESENCE = { viewers: [DOT, MAYA], cursors: [{ member_id: DOT, x: 5, y: 5, selected: [] }, { member_id: MAYA, x: 120, y: 80, selected: [] }], locks: [{ card_id: uid(101), member_id: MAYA }] };
const presenceMount = (t, extra = {}) => mount(t, { boards: [teamBoard(1, 'Plan', note(1, 'hello'))], answers: { boardOpen: opened(teamBoard(1, 'Plan', note(1, 'hello')), PRESENCE) }, ...extra });

module.exports = { TEAM, PROJECT, P2, S1, S2, DOT, MAYA, host, model, NOW, uid, boardId, frame, note, teamBoard, row, opened, scriptedTeam, members, ROSTER, mount, items, heads, settle, chooseAt, choose,
  openMenu, pickTeam, picker, teamChat, pushPresence, PRESENCE, presenceMount, flush, tick };
