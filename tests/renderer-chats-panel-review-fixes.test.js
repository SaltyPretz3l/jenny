'use strict';

// Chats sidebar lifecycle review (2026-10-21): "Show in Chats" and the active chat in project
// mode, strip expansion, paging resets, switcher retry, the global project-mode row cap, render
// work skipped for unchanged rows / hidden lists / unmoved lists, and the load-more click.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChatsPanelController } = require('../renderer/shell/renderer-chats-panel');
const modelUi = require('../renderer/shell/renderer-chats-panel-model');
const treeUi = require('../renderer/shell/renderer-chats-panel-tree');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');
const contextMenu = require('../renderer/inventory/context-menu');

const KEY = 'jenny.chats.projectGroups.v1';
const NOW = Date.now();
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();

function chat(id, minutesAgo, project, extra = {}) {
  const session = { id, title: `Chat ${id}`, updated_at: iso(minutesAgo), created_at: iso(minutesAgo + 500), pinned: false, archived_at: null, ...extra };
  if (project) session.project_id = project;
  return session;
}

/** b1 (newest) in Beta, then a1..a9 in Alpha. */
function alphaHeavy() {
  const sessions = [chat('b1', 1, 'project_beta')];
  for (let i = 1; i <= 9; i += 1) sessions.push(chat(`a${i}`, i + 1, 'project_alpha'));
  return sessions;
}

function makeSwitcher() {
  const projects = [
    { id: 'project_alpha', name: 'Alpha' },
    { id: 'project_beta', name: 'Beta' },
    { id: 'project_general', name: 'General' },
  ];
  return {
    async refresh() {},
    getProjects: () => projects,
    projectById: (id) => projects.find((project) => project.id === id) || null,
    currentProject: () => projects[0],
    async openFilterMenu() {},
  };
}

function makeHarness(t, { sessions = alphaHeavy(), prefs, getProjectSwitcher, resizeObserver = false, afterRenderSessions } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="chatsProjectRow"></div><div id="chatsScopeSlot"></div>'
    + '<input id="search"><div id="conversationGroups"></div><div id="chatsPanelStatus"></div><span id="conversationCount"></span></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  const doc = window.document;
  if (prefs) window.localStorage.setItem(KEY, JSON.stringify(prefs));
  let observerCallback = null;
  if (resizeObserver) {
    window.ResizeObserver = class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
      disconnect() {}
    };
  }
  const switcher = makeSwitcher();
  const state = { ui: {}, sessions: sessions.slice() };
  const controller = createChatsPanelController({
    state,
    documentRef: doc,
    windowRef: window,
    dom: {
      conversationGroups: doc.getElementById('conversationGroups'),
      conversationCount: doc.getElementById('conversationCount'),
      scopeSlot: doc.getElementById('chatsScopeSlot'),
      projectRow: doc.getElementById('chatsProjectRow'),
      status: doc.getElementById('chatsPanelStatus'),
      searchInput: doc.getElementById('search'),
    },
    inventory: { actionButton, segmentedControl, contextMenu },
    callbacks: { getProjectSwitcher: getProjectSwitcher || (async () => switcher), afterRenderSessions },
  });
  t.after(() => { controller.dispose(); window.close(); });
  const qa = (selector) => Array.from(doc.querySelectorAll(selector));
  const rowIds = () => qa('#conversationGroups .conversation-item[data-session-id]').map((row) => row.dataset.sessionId);
  const rowsIn = (key) => qa(`[data-chats-group="${key}"] .conversation-item[data-session-id]`).map((row) => row.dataset.sessionId);
  const stored = () => JSON.parse(window.localStorage.getItem(KEY) || '{}');
  const frame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  const resize = (width, height) => observerCallback([{ contentRect: { width, height } }]);
  return { window, doc, state, controller, qa, rowIds, rowsIn, stored, frame, resize };
}

async function ready(h) {
  h.controller.renderNow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.controller.renderNow();
}

const ALPHA = 'recent_project:project_alpha';

test('revealSession opens a collapsed project far enough for a chat past its first page', async (t) => {
  const h = makeHarness(t, { prefs: { v: 1, mode: 'project', collapsed: { project_alpha: true }, names: {} } });
  await ready(h);
  assert.deepEqual(h.rowsIn(ALPHA), [], 'precondition: Alpha is collapsed');
  h.doc.getElementById('search').value = 'nothing matches';
  h.state.ui.sidebarArchivedView = true;
  h.state.ui.chatsProjectFilter = 'project_beta';
  assert.equal(h.controller.revealSession('a8'), true);
  assert.ok(h.rowIds().includes('a8'));
  assert.equal(h.doc.getElementById('search').value, '');
  assert.equal(h.state.ui.sidebarArchivedView, false);
  assert.equal(h.state.ui.chatsProjectFilter, '');
  assert.equal(h.stored().collapsed.project_alpha, undefined, 'the project is expanded for good');
  assert.equal(h.rowsIn(ALPHA).length, 8, 'paged exactly far enough');
  assert.equal(h.controller.revealSession('missing'), false);
});

test('revealSession pages the date list and switches to an archived chat\'s scope', (t) => {
  const sessions = [];
  for (let i = 0; i < 260; i += 1) sessions.push(chat(`d${i}`, i + 1));
  sessions.push(chat('old', 9999, '', { archived_at: iso(5) }));
  const h = makeHarness(t, { sessions, prefs: { v: 1, mode: 'date', collapsed: {}, names: {} } });
  h.controller.renderNow();
  assert.equal(h.rowIds().length, 100);
  assert.equal(h.controller.revealSession('d230'), true);
  assert.ok(h.rowIds().length >= 231 && h.rowIds().length <= 300, 'only the pages it needs are mounted');
  assert.equal(h.controller.revealSession('old'), true);
  assert.equal(h.state.ui.sidebarArchivedView, true);
});

test('the active chat gets a row once: its collapsed project opens, a later collapse is respected', async (t) => {
  const h = makeHarness(t, { prefs: { v: 1, mode: 'project', collapsed: { project_alpha: true }, names: {} } });
  await ready(h);
  h.state.currentSessionId = 'a7';
  h.controller.renderNow();
  assert.ok(h.rowIds().includes('a7'));
  const row = h.doc.querySelector('[data-session-id="a7"] [data-session-open]');
  assert.equal(row.getAttribute('aria-current'), 'page');
  h.doc.querySelector('[data-project-toggle="project_alpha"]').click();
  h.controller.renderNow();
  assert.deepEqual(h.rowsIn(ALPHA), [], 'the user collapsed it again while on the same chat');
});

test('opening the 8th chat of an open project raises that project\'s page to show it', async (t) => {
  const h = makeHarness(t);
  await ready(h);
  assert.equal(h.rowsIn(ALPHA).length, 5);
  h.state.currentSessionId = 'a8';
  h.controller.renderNow();
  assert.equal(h.rowsIn(ALPHA).length, 8);
});

test('strip expansion clears the project filter with search and scope', (t) => {
  const h = makeHarness(t);
  h.state.ui.chatsProjectFilter = 'project_alpha';
  h.state.ui.sidebarArchivedView = true;
  h.doc.getElementById('search').value = 'x';
  h.controller.prepareForStripExpansion();
  assert.equal(h.state.ui.chatsProjectFilter, '');
  assert.equal(h.state.ui.sidebarArchivedView, false);
  assert.equal(h.doc.getElementById('search').value, '');
});

test('"Clear search" from the empty state also resets each project\'s Show more page', async (t) => {
  const h = makeHarness(t);
  await ready(h);
  h.doc.querySelector(`[data-chats-group="${ALPHA}"] [data-project-more]`).click();
  h.controller.renderNow();
  assert.equal(h.rowsIn(ALPHA).length, 9);
  h.doc.getElementById('search').value = 'zzz no match';
  h.controller.renderNow();
  h.doc.querySelector('[data-chats-empty-action="search"]').click();
  h.controller.renderNow();
  assert.equal(h.rowsIn(ALPHA).length, 5);
});

test('a project switcher that fails to load once is asked again on a later render', async (t) => {
  let calls = 0;
  const switcher = makeSwitcher();
  const h = makeHarness(t, { getProjectSwitcher: async () => { calls += 1; if (calls === 1) throw new Error('script failed'); return switcher; } });
  await ready(h);
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.controller.renderNow();
  assert.ok(calls >= 2, 'the failed load was retried');
  assert.ok(h.qa('.project-header__name').map((el) => el.textContent).includes('Alpha'), 'headers took the loaded names');
});

test('the filter button names a project with the same disambiguated label as its header', async (t) => {
  const h = makeHarness(t);
  h.window.rendererProjectMenu = { displayNames: () => ({ project_alpha: 'Alpha · work', project_beta: 'Beta', project_general: 'General' }) };
  await ready(h);
  h.controller.setProjectFilter('project_alpha');
  h.controller.renderNow();
  assert.equal(h.doc.querySelector('[data-chats-project-filter] .chats-project-filter-name').textContent, 'Alpha · work');
});

test('the load-more click is handled by the panel itself', (t) => {
  const sessions = [];
  for (let i = 0; i < 150; i += 1) sessions.push(chat(`d${i}`, i + 1));
  const h = makeHarness(t, { sessions, prefs: { v: 1, mode: 'date', collapsed: {}, names: {} } });
  h.controller.renderNow();
  assert.equal(h.rowIds().length, 100);
  h.doc.querySelector('[data-chats-load-more]').click();
  h.controller.renderNow();
  assert.equal(h.rowIds().length, 150);
});

test('an unchanged row takes no attribute writes and an unmoved list no scroll writes on a re-render', async (t) => {
  const h = makeHarness(t);
  await ready(h);
  const groups = h.doc.getElementById('conversationGroups');
  let scrollWrites = 0;
  let scrollTop = 40;
  Object.defineProperty(groups, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value) => { scrollWrites += 1; scrollTop = value; } });
  const observer = new h.window.MutationObserver(() => {});
  observer.observe(groups, { attributes: true, childList: true, subtree: true });
  h.controller.renderNow();
  const records = observer.takeRecords().filter((record) => record.target.closest && record.target.closest('.conversation-item'));
  observer.disconnect();
  assert.deepEqual(records.map((record) => `${record.type}:${record.attributeName}`), []);
  assert.equal(scrollWrites, 0);
  h.state.sessions[1] = { ...h.state.sessions[1], title: 'Renamed' };
  h.controller.renderNow();
  assert.equal(h.doc.querySelector('[data-session-id="a1"] .session-row__title-text').textContent, 'Renamed');
});

test('a scheduled render of a hidden list only marks it stale, then catches up when shown', async (t) => {
  const passes = [];
  const h = makeHarness(t, { resizeObserver: true, afterRenderSessions: (rows, sessions) => passes.push(sessions ? 'render' : 'stale') });
  await ready(h);
  h.resize(0, 0);
  h.state.sessions.push(chat('new1', 0, 'project_beta'));
  h.controller.renderSessions();
  await h.frame();
  assert.equal(h.rowIds().includes('new1'), false, 'no DOM work while hidden');
  assert.equal(passes[passes.length - 1], 'stale', 'badges, strip and inbox still get their pass');
  h.resize(240, 600);
  await h.frame();
  assert.equal(h.rowIds().includes('new1'), true);
  assert.equal(passes[passes.length - 1], 'render');
});

test('patchRuntimeState never runs the badge pass', async (t) => {
  let passes = 0;
  const h = makeHarness(t, { afterRenderSessions: () => { passes += 1; } });
  await ready(h);
  const before = passes;
  h.controller.patchRuntimeState();
  assert.equal(passes, before);
});

test('project mode caps pages past the first at one MAX_VISIBLE budget across projects', () => {
  const sessions = [];
  ['p_a', 'p_b', 'p_c'].forEach((project, p) => {
    for (let i = 0; i < 300; i += 1) sessions.push(chat(`${project}-${i}`, p * 1000 + i + 1, project));
  });
  const limits = new Map([['p_a', 300], ['p_b', 300], ['p_c', 300]]);
  const model = modelUi.buildChatsViewModel({ sessions, groupMode: 'project', projectLimits: limits, scope: 'recent' });
  const shown = model.groups.map((group) => group.shownRoots);
  assert.deepEqual(shown, [300, 210, 5], 'first pages always show; pages past them share 500');
  assert.equal(model.visibleCount, 515);
  assert.equal(model.capped, true);
  assert.deepEqual(model.groups.map((group) => group.remaining), [0, 0, 0], 'no Show more past the cap');
});

test('projectPlacement finds a chat\'s project and the root limit that shows it, through its parent', () => {
  const parent = chat('a4', 5, 'p_a');
  const child = chat('kid', 1, 'p_a', { spawned_from: { parent_session_id: 'a4' } });
  const sessions = [chat('a1', 2, 'p_a'), chat('a2', 3, 'p_a'), chat('a3', 4, 'p_a'), parent, child, chat('b1', 6, 'p_b')];
  const model = modelUi.buildChatsViewModel({ sessions, groupMode: 'project', scope: 'recent' });
  assert.deepEqual(modelUi.projectPlacement(model, 'kid'), { projectId: 'p_a', roots: 4 });
  assert.deepEqual(modelUi.projectPlacement(model, 'b1'), { projectId: 'p_b', roots: 1 });
  assert.equal(modelUi.projectPlacement(model, 'nope'), null);
});

test('sortSessions puts pinned first, then newest, then id, without mutating its input', () => {
  const sessions = [chat('b', 5), chat('a', 5), chat('old', 9), chat('pin', 0, '', { pinned: true }), chat('noTime', 0, '', { updated_at: '', created_at: '' })];
  const input = sessions.slice();
  assert.deepEqual(treeUi.sortSessions(sessions).map((s) => s.id), ['pin', 'a', 'b', 'old', 'noTime']);
  assert.deepEqual(sessions, input, 'the input array is left as it was');
});

test('a failed children-collapse write reverts the live summary even after the list was replaced', async () => {
  const state = { sessions: [chat('p', 1, '', { children_expanded: true, coordination_revision: 3 })] };
  let resolveWrite;
  const bridge = { setView: () => new Promise((resolve) => { resolveWrite = resolve; }) };
  const done = treeUi.writeChildrenExpanded({ state, bridge, chains: new Map(), onChange() {} }, 'p', false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  state.sessions = state.sessions.map((session) => ({ ...session }));
  resolveWrite({ ok: false, reason: 'denied' });
  assert.equal(await done, false);
  assert.equal(state.sessions[0].children_expanded, true);
  assert.equal(state.sessions[0].coordination_revision, 3);
});

// Final review of the fixes (2026-10-21).

test('a Tab stop moved by setRovingSession is restored when the focused row disappears', async (t) => {
  const h = makeHarness(t, { sessions: [chat('s1', 1), chat('s2', 2)], prefs: { v: 1, mode: 'date', collapsed: {}, names: {} } });
  await ready(h);
  const tabStops = () => h.qa('[data-session-open][tabindex="0"]').map((node) => node.closest('[data-session-id]').dataset.sessionId);
  assert.deepEqual(tabStops(), ['s1']);
  h.controller.setRovingSession('s2');
  h.doc.querySelector('[data-session-id="s2"] [data-session-open]').focus();
  h.state.sessions = h.state.sessions.filter((session) => session.id !== 's2');
  h.controller.renderNow();
  assert.deepEqual(tabStops(), ['s1'], 'the list stays reachable with Tab');
});

test('the active chat is revealed once the sessions it lives in arrive', async (t) => {
  const h = makeHarness(t, { sessions: [], prefs: { v: 1, mode: 'project', collapsed: { project_alpha: true }, names: {} } });
  h.state.currentSessionId = 'a7';
  await ready(h);
  h.state.sessions = alphaHeavy();
  h.controller.renderNow();
  assert.ok(h.rowIds().includes('a7'), 'the reveal was not spent on a model without the chat');
});

test('a render deferred while the list is hidden still announces sidebar-rendered', async (t) => {
  const h = makeHarness(t, { resizeObserver: true });
  await ready(h);
  let announced = 0;
  h.doc.getElementById('conversationGroups').addEventListener('sidebar-rendered', () => { announced += 1; });
  h.resize(0, 0);
  h.controller.renderSessions();
  await h.frame();
  assert.equal(announced, 1);
});

test('queued children-collapse writes revert to what the store last accepted', async () => {
  function rig() {
    const state = { sessions: [chat('p', 1, '', { children_expanded: true, coordination_revision: 3 })] };
    const pending = [];
    const bridge = { setView: () => new Promise((resolve) => pending.push(resolve)) };
    const ctx = { state, bridge, chains: new Map(), onChange() {} };
    const settle = async (response) => { await new Promise((resolve) => setTimeout(resolve, 0)); pending.shift()(response); };
    return { state, ctx, settle };
  }
  const both = rig();
  const first = treeUi.writeChildrenExpanded(both.ctx, 'p', false);
  const second = treeUi.writeChildrenExpanded(both.ctx, 'p', true);
  await both.settle({ ok: false, reason: 'denied' });
  assert.equal(await first, false);
  assert.equal(both.state.sessions[0].children_expanded, true, 'the queued toggle keeps its optimistic value');
  await both.settle({ ok: false, reason: 'denied' });
  assert.equal(await second, false);
  assert.equal(both.state.sessions[0].children_expanded, true, 'both failed: back to the persisted value');
  assert.equal(both.state.sessions[0].coordination_revision, 3);

  const later = rig();
  const a = treeUi.writeChildrenExpanded(later.ctx, 'p', false);
  const b = treeUi.writeChildrenExpanded(later.ctx, 'p', true);
  const c = treeUi.writeChildrenExpanded(later.ctx, 'p', false);
  await later.settle({ ok: false, reason: 'denied' });
  await a;
  assert.equal(later.state.sessions[0].children_expanded, false, 'an early failure does not undo the latest toggle');
  await later.settle({ ok: true, coordination_revision: 4 });
  await b;
  await later.settle({ ok: false, reason: 'denied' });
  await c;
  assert.equal(later.state.sessions[0].children_expanded, true, 'the last failure reverts to the accepted write');
  assert.equal(later.state.sessions[0].coordination_revision, 4);
});

test('a project offers only the budget left after every project, so Show more never shrinks another', () => {
  const sessions = [];
  ['p_a', 'p_b'].forEach((project, p) => {
    for (let i = 0; i < 400; i += 1) sessions.push(chat(`${project}-${i}`, p * 1000 + i + 1, project));
  });
  const build = (a, b) => modelUi.buildChatsViewModel({ sessions, groupMode: 'project', projectLimits: new Map([['p_a', a], ['p_b', b]]), scope: 'recent' });
  const before = build(305, 105);
  assert.deepEqual(before.groups.map((group) => [group.shownRoots, group.remaining]), [[305, 95], [105, 100]], '100 of the 500 extra rows are left');
  // The click adds what the button offered (min(step, remaining)) to what is shown.
  const after = build(305 + Math.min(modelUi.PROJECT_PAGE_STEP, before.groups[0].remaining), 105);
  assert.deepEqual(after.groups.map((group) => group.shownRoots), [355, 105], 'Beta keeps its rows');
  assert.deepEqual(after.groups.map((group) => group.remaining), [45, 50]);
});

test('a load-more control appearing under unchanged rows re-pins a list scrolled to the bottom', async (t) => {
  const sessions = [];
  for (let i = 0; i < modelUi.PAGE_SIZE; i += 1) sessions.push(chat(`d${i}`, i + 1));
  const h = makeHarness(t, { sessions, prefs: { v: 1, mode: 'date', collapsed: {}, names: {} } });
  await ready(h);
  const groups = h.doc.getElementById('conversationGroups');
  assert.equal(groups.querySelector('[data-chats-pagination]'), null);
  let scrollWrites = 0;
  Object.defineProperty(groups, 'scrollTop', { configurable: true, get: () => 40, set: () => { scrollWrites += 1; } });
  Object.defineProperty(groups, 'clientHeight', { configurable: true, get: () => 100 });
  Object.defineProperty(groups, 'scrollHeight', { configurable: true, get: () => 140 });
  h.state.sessions.push(chat('oldest', 99999));
  h.controller.renderNow();
  assert.ok(groups.querySelector('[data-chats-load-more]'));
  assert.equal(scrollWrites, 1);
});
