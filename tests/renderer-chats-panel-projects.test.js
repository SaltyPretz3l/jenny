'use strict';

// Chats grouped by project (row 74, S2): the persisted view preference, the project sections the
// panel renders in project mode (header, rows, paging, collapse, roll-up dot), the project menu,
// the group-by control, and date mode staying exactly as it was.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const projectsUi = require('../renderer/shell/renderer-chats-panel-projects');
const { createChatsPanelController } = require('../renderer/shell/renderer-chats-panel');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');
const contextMenu = require('../renderer/inventory/context-menu');

const KEY = 'jenny.chats.projectGroups.v1';

function memoryStorage(initial) {
  const map = new Map(initial === undefined ? [] : [[KEY, initial]]);
  return {
    sets: 0,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem(key, value) { this.sets += 1; map.set(key, String(value)); },
  };
}

// ---- prefs ----

test('readPrefs normalizes: missing, corrupt, wrong types and a bad mode all fall back to defaults', () => {
  const defaults = { v: 1, mode: 'project', collapsed: {}, names: {} };
  assert.deepEqual(projectsUi.readPrefs(memoryStorage()), defaults);
  assert.deepEqual(projectsUi.readPrefs(null), defaults);
  assert.deepEqual(projectsUi.readPrefs(memoryStorage('{not json')), defaults);
  assert.deepEqual(projectsUi.readPrefs(memoryStorage('[1,2]')), defaults);
  assert.deepEqual(projectsUi.readPrefs(memoryStorage(JSON.stringify({ v: 1, mode: 'grid', collapsed: [1], names: 'x' }))), defaults);
  const mixed = projectsUi.readPrefs(memoryStorage(JSON.stringify({
    v: 1, mode: 'date', collapsed: { a: true, b: false, c: 'yes', '': true }, names: { a: ' Alpha ', b: 7, c: '' },
  })));
  assert.deepEqual(mixed, { v: 1, mode: 'date', collapsed: { a: true }, names: { a: 'Alpha' } });
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(projectsUi.readPrefs(throwing), defaults);
  assert.doesNotThrow(() => projectsUi.writePrefs(throwing, { mode: 'date' }));
});

test('writePrefs bounds collapsed and names to 200 ids and keeps the newest', () => {
  const storage = memoryStorage();
  const collapsed = {};
  const names = {};
  for (let i = 0; i < 260; i += 1) { collapsed[`p${i}`] = true; names[`p${i}`] = `Project ${i}`; }
  const written = projectsUi.writePrefs(storage, { v: 1, mode: 'project', collapsed, names });
  assert.equal(Object.keys(written.collapsed).length, 200);
  assert.equal(Object.keys(written.names).length, 200);
  assert.equal(written.collapsed.p259, true);
  assert.equal(written.collapsed.p0, undefined);
  const stored = JSON.parse(storage.getItem(KEY));
  assert.equal(Object.keys(stored.collapsed).length, 200);
  assert.equal(stored.v, 1);
});

test('reads after writes are consistent and cached; an external change to the stored value is seen', () => {
  const storage = memoryStorage();
  projectsUi.setGroupMode(storage, 'date');
  assert.equal(projectsUi.readPrefs(storage).mode, 'date');
  assert.equal(projectsUi.readPrefs(storage), projectsUi.readPrefs(storage), 'unchanged storage returns the cached object');
  storage.setItem(KEY, JSON.stringify({ v: 1, mode: 'project', collapsed: { z: true } }));
  assert.deepEqual(projectsUi.readPrefs(storage).collapsed, { z: true });
  const failing = { value: null, getItem() { return this.value; }, setItem() { throw new Error('quota'); } };
  projectsUi.setProjectCollapsed(failing, 'a', true);
  assert.equal(projectsUi.readPrefs(failing).collapsed.a, true, 'a failed write still holds for this session');
});

test('the mutators write only when something changed', () => {
  const storage = memoryStorage();
  projectsUi.setProjectCollapsed(storage, 'a', false);
  projectsUi.setGroupMode(storage, 'project');
  projectsUi.rememberNames(storage, {});
  projectsUi.pruneProjects(storage, ['a']);
  assert.equal(storage.sets, 0);
  projectsUi.setProjectCollapsed(storage, 'a', true);
  projectsUi.setProjectCollapsed(storage, 'a', true);
  assert.equal(storage.sets, 1);
  projectsUi.rememberNames(storage, { a: 'Alpha', project_general: 'General' });
  projectsUi.rememberNames(storage, { a: 'Alpha' });
  assert.equal(storage.sets, 2);
  projectsUi.setProjectsCollapsed(storage, ['a', 'b'], true);
  assert.deepEqual(projectsUi.readPrefs(storage).collapsed, { a: true, b: true });
  projectsUi.setProjectsCollapsed(storage, ['a', 'b'], false);
  assert.deepEqual(projectsUi.readPrefs(storage).collapsed, {});
});

test('pruneProjects drops unknown ids but keeps project_general', () => {
  const storage = memoryStorage(JSON.stringify({
    v: 1, mode: 'project', collapsed: { a: true, gone: true, project_general: true }, names: { a: 'A', gone: 'G', project_general: 'General' },
  }));
  projectsUi.pruneProjects(storage, new Set(['a']));
  const prefs = projectsUi.readPrefs(storage);
  assert.deepEqual(prefs.collapsed, { a: true, project_general: true });
  assert.deepEqual(prefs.names, { a: 'A', project_general: 'General' });
});

test('prefersProjectGroups is true unless the mode is date; expandProject removes the id', () => {
  const windowRef = { localStorage: memoryStorage() };
  assert.equal(projectsUi.prefersProjectGroups(windowRef), true);
  assert.equal(projectsUi.prefersProjectGroups({}), true);
  projectsUi.setProjectCollapsed(windowRef.localStorage, 'a', true);
  projectsUi.expandProject(windowRef, 'a');
  assert.deepEqual(projectsUi.readPrefs(windowRef.localStorage).collapsed, {});
  projectsUi.setGroupMode(windowRef.localStorage, 'date');
  assert.equal(projectsUi.prefersProjectGroups(windowRef), false);
  const hostile = { get localStorage() { throw new Error('blocked'); } };
  assert.equal(projectsUi.prefersProjectGroups(hostile), true);
  assert.doesNotThrow(() => projectsUi.expandProject(hostile, 'a'));
});

// ---- the panel in project mode ----

// Fixtures sit minutes before NOW; keep them inside today when the run starts just after midnight.
const NOW = Math.max(Date.now(), new Date().setHours(0, 30, 0, 0));
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();

function chat(id, minutesAgo, project, extra = {}) {
  const session = { id, title: `Chat ${id}`, updated_at: iso(minutesAgo), created_at: iso(minutesAgo + 500), pinned: false, archived_at: null, ...extra };
  if (project) session.project_id = project;
  return session;
}

const SESSIONS = [
  chat('pin1', 1, 'project_beta', { pinned: true }),
  chat('a1', 2, 'project_alpha'),
  chat('a2', 3, 'project_alpha'),
  chat('a3', 4, 'project_alpha'),
  chat('b1', 5, 'project_beta'),
  chat('b2', 6, 'project_beta'),
  chat('g1', 7),
];

function makeSwitcher(currentId = 'project_alpha') {
  const projects = [
    { id: 'project_alpha', name: 'Alpha', rootPath: 'D:\\Alpha' },
    { id: 'project_beta', name: 'Beta', rootPath: 'D:\\Beta' },
    { id: 'project_general', name: 'General', rootPath: '' },
  ];
  const calls = { newChat: [], workspace: [], filter: [] };
  return {
    calls,
    async refresh() {},
    getProjects: () => projects,
    projectById: (id) => projects.find((project) => project.id === id) || null,
    currentProject: () => projects.find((project) => project.id === currentId && project.id !== 'project_general') || null,
    async newChatInProject(id) { calls.newChat.push(id); },
    async openProjectAsWorkspace(id) { calls.workspace.push(id); },
    async openFilterMenu() {},
    setChatsFilter(id) { calls.filter.push(id); },
  };
}

function makeHarness(t, { sessions = SESSIONS, switcher = makeSwitcher(), prefs, withSearch = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div class="chats-project-row" id="chatsProjectRow"></div><div class="chats-scope-row"><div class="chats-scope-slot" id="chatsScopeSlot"></div></div>'
    + '<input id="search"><div id="conversationGroups"></div><div id="chatsPanelStatus"></div><span id="conversationCount"></span></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  const doc = window.document;
  if (prefs) window.localStorage.setItem(KEY, JSON.stringify(prefs));
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
      searchInput: withSearch ? doc.getElementById('search') : null,
    },
    inventory: { actionButton, segmentedControl, contextMenu },
    callbacks: switcher ? { getProjectSwitcher: async () => switcher } : {},
  });
  t.after(() => { controller.dispose(); window.close(); });
  const q = (selector) => doc.querySelector(selector);
  const qa = (selector) => Array.from(doc.querySelectorAll(selector));
  const rowsIn = (key) => qa(`[data-chats-group="${key}"] .conversation-item[data-session-id]`).map((row) => row.dataset.sessionId);
  const stored = () => JSON.parse(window.localStorage.getItem(KEY) || '{}');
  const menuLabels = () => qa('.inv-context-menu-item').map((item) => item.textContent.trim());
  const pickMenu = (label) => {
    const item = qa('.inv-context-menu-item').find((button) => button.textContent.trim() === label);
    assert.ok(item, `expected a "${label}" menu item in [${menuLabels().join(' | ')}]`);
    item.click();
  };
  return { window, doc, state, controller, switcher, q, qa, rowsIn, stored, menuLabels, pickMenu };
}

async function ready(h) {
  h.controller.renderNow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.controller.renderNow();
}

const headerNames = (h) => h.qa('.project-header__name').map((el) => el.textContent);

test('two projects render a Pinned group then project sections with headers in switcher order', async (t) => {
  const h = await makeHarness(t);
  await ready(h);
  const sections = h.qa('#conversationGroups > .conversation-group');
  assert.deepEqual(sections.map((el) => el.dataset.chatsGroup), ['recent_pinned', 'recent_project:project_alpha', 'recent_project:project_beta', 'recent_project:project_general']);
  assert.equal(sections[0].querySelector('.group-label').textContent, 'Pinned');
  assert.equal(sections[0].classList.contains('project-group'), false, 'Pinned is not a project section');
  assert.deepEqual(headerNames(h), ['Alpha', 'Beta', 'General']);
  assert.equal(h.q('.project-group h3'), null, 'a project section has no date heading');
  assert.deepEqual(h.rowsIn('recent_pinned'), ['pin1']);
  assert.deepEqual(h.rowsIn('recent_project:project_alpha'), ['a1', 'a2', 'a3']);
  assert.deepEqual(h.rowsIn('recent_project:project_beta'), ['b1', 'b2']);
  assert.deepEqual(h.rowsIn('recent_project:project_general'), ['g1']);
  assert.deepEqual(h.qa('.project-header__count').map((el) => el.textContent), ['3', '2', '1']);
  const first = sections[1];
  assert.equal(first.dataset.projectId, 'project_alpha');
  assert.equal(first.dataset.collapsed, 'false');
  assert.equal(first.firstElementChild.className, 'project-header');
  assert.equal(first.firstElementChild.nextElementSibling.tagName, 'UL');
  assert.equal(first.querySelector('[data-project-toggle]').getAttribute('aria-expanded'), 'true');
});

test('the first paint without the switcher uses cached names and falls back to General / Project', async (t) => {
  const h = makeHarness(t, { switcher: null, prefs: { v: 1, mode: 'project', collapsed: {}, names: { project_alpha: 'Alpha cached' } } });
  h.controller.renderNow();
  // Unlisted projects order by newest chat (Beta holds the newest, pinned one), General last.
  assert.deepEqual(headerNames(h), ['Project', 'Alpha cached', 'General']);
});

test('headers take the switcher labels, and the project list resolving re-renders', async (t) => {
  const switcher = makeSwitcher();
  const h = makeHarness(t, { switcher });
  h.window.rendererProjectMenu = { displayNames: () => ({ project_alpha: 'Alpha · work', project_beta: 'Beta', project_general: 'General' }) };
  await ready(h);
  assert.deepEqual(headerNames(h), ['Alpha · work', 'Beta', 'General']);
  assert.equal(h.stored().names.project_alpha, 'Alpha · work', 'the label is remembered for the next boot');
});

test('clicking a header toggle collapses it: rows unmounted, state persisted, survives a re-render, focus stays', async (t) => {
  const h = makeHarness(t);
  await ready(h);
  const toggle = h.q('[data-project-toggle="project_alpha"]');
  toggle.focus();
  toggle.click();
  h.controller.renderNow();
  const section = h.q('[data-chats-group="recent_project:project_alpha"]');
  assert.equal(section.dataset.collapsed, 'true');
  assert.deepEqual(h.rowsIn('recent_project:project_alpha'), []);
  assert.equal(h.q('[data-session-id="a1"]'), null, 'collapsed rows are not mounted');
  const next = section.querySelector('[data-project-toggle]');
  assert.equal(next.getAttribute('aria-expanded'), 'false');
  assert.equal(h.doc.activeElement, next, 'focus returns to the rebuilt toggle');
  assert.deepEqual(h.stored().collapsed, { project_alpha: true });
  h.controller.renderNow();
  assert.equal(h.q('[data-chats-group="recent_project:project_alpha"]').dataset.collapsed, 'true');
  assert.equal(h.q('[data-project-toggle="project_alpha"]').getAttribute('aria-label'), 'Alpha, 3 chats');
  h.q('[data-project-toggle="project_alpha"]').click();
  h.controller.renderNow();
  assert.deepEqual(h.rowsIn('recent_project:project_alpha'), ['a1', 'a2', 'a3']);
  assert.deepEqual(h.stored().collapsed, {});
});

test('search forces every section open without touching the stored preference', async (t) => {
  const h = makeHarness(t, { withSearch: true, prefs: { v: 1, mode: 'project', collapsed: { project_alpha: true }, names: {} } });
  await ready(h);
  assert.deepEqual(h.rowsIn('recent_project:project_alpha'), []);
  h.doc.getElementById('search').value = 'chat'; // matches every chat, so the list keeps spanning projects
  h.controller.renderNow();
  assert.deepEqual(h.rowsIn('recent_project:project_alpha'), ['a1', 'a2', 'a3']);
  assert.deepEqual(h.stored().collapsed, { project_alpha: true });
});

test('a collapsed project shows a roll-up dot that follows runtime state without a structural render', async (t) => {
  const sessions = [...SESSIONS.slice(0, 5), chat('b2', 6, 'project_beta', { unread_message_count: 2 }), SESSIONS[6]];
  const h = makeHarness(t, { sessions, prefs: { v: 1, mode: 'project', collapsed: { project_beta: true }, names: {} } });
  await ready(h);
  const dot = () => h.q('[data-chats-group="recent_project:project_beta"] .project-header__dot');
  const toggle = () => h.q('[data-project-toggle="project_beta"]');
  assert.equal(dot().dataset.tone, 'unread');
  assert.equal(h.q('[data-chats-group="recent_project:project_alpha"] .project-header__dot'), null, 'an open project has no dot');
  const header = h.q('[data-chats-group="recent_project:project_beta"] .project-header');
  h.window.rendererMultiStreamController = { getStreamingSessionIds: () => ['b1'], getApprovalPendingSessionIds: () => [] };
  h.controller.patchRuntimeState();
  assert.equal(dot().dataset.tone, 'streaming');
  assert.match(toggle().getAttribute('aria-label'), /working$/);
  h.window.rendererMultiStreamController = { getStreamingSessionIds: () => ['b1'], getApprovalPendingSessionIds: () => ['b2'] };
  h.controller.patchRuntimeState();
  assert.equal(dot().dataset.tone, 'approval');
  assert.match(toggle().getAttribute('aria-label'), /needs you$/);
  h.window.rendererMultiStreamController = { getStreamingSessionIds: () => [], getApprovalPendingSessionIds: () => [] };
  h.controller.patchRuntimeState();
  assert.equal(dot().dataset.tone, 'unread');
  assert.equal(h.q('[data-chats-group="recent_project:project_beta"] .project-header'), header, 'the header node is patched in place');
  h.controller.renderNow();
  assert.equal(dot().dataset.tone, 'unread');
});

test('Show N more and Show less page one project at five roots', async (t) => {
  const many = [chat('a1', 1, 'project_alpha'), chat('b1', 2, 'project_beta')];
  for (let i = 2; i <= 9; i += 1) many.push(chat(`a${i}`, i + 1, 'project_alpha'));
  const h = makeHarness(t, { sessions: many });
  await ready(h);
  const key = 'recent_project:project_alpha';
  assert.equal(h.rowsIn(key).length, 5);
  const more = h.q(`[data-chats-group="${key}"] [data-project-more]`);
  assert.equal(more.textContent.trim(), 'Show 4 more');
  more.focus();
  more.click();
  h.controller.renderNow();
  assert.equal(h.rowsIn(key).length, 9);
  assert.equal(h.q(`[data-chats-group="${key}"] [data-project-more]`), null);
  const less = h.q(`[data-chats-group="${key}"] [data-project-less]`);
  assert.equal(less.textContent.trim(), 'Show less');
  assert.equal(h.doc.activeElement, less, 'focus follows the replaced control');
  less.click();
  h.controller.renderNow();
  assert.equal(h.rowsIn(key).length, 5);
  assert.ok(h.q(`[data-chats-group="${key}"] [data-project-more]`));
  assert.equal(h.q('[data-chats-group="recent_project:project_beta"] [data-project-more]'), null, 'a short project has no control');
});

test('the + button starts a chat in that project through the switcher', async (t) => {
  const h = makeHarness(t);
  await ready(h);
  h.q('[data-project-new="project_beta"]').click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(h.switcher.calls.newChat, ['project_beta']);
});

test('the project menu: items per project, Open as Workspace folder, Show only, Collapse/Expand all', async (t) => {
  const h = makeHarness(t);
  await ready(h);
  h.q('[data-project-menu="project_alpha"]').click();
  assert.deepEqual(h.menuLabels(), ['New chat in Alpha', 'Show only this project', 'Collapse all projects'], 'the current Workspace project is not offered as a Workspace');
  h.pickMenu('New chat in Alpha');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(h.switcher.calls.newChat, ['project_alpha']);

  h.q('[data-project-menu="project_general"]').click();
  assert.equal(h.menuLabels().includes('Open as Workspace folder'), false, 'General is not a folder');
  contextMenu.hide();

  h.q('[data-project-menu="project_beta"]').click();
  assert.deepEqual(h.menuLabels(), ['New chat in Beta', 'Open as Workspace folder', 'Show only this project', 'Collapse all projects']);
  h.pickMenu('Open as Workspace folder');
  assert.deepEqual(h.switcher.calls.workspace, ['project_beta']);

  h.q('[data-project-menu="project_beta"]').click();
  h.pickMenu('Collapse all projects');
  h.controller.renderNow();
  assert.deepEqual(h.stored().collapsed, { project_alpha: true, project_beta: true, project_general: true });
  assert.equal(h.qa('.project-group[data-collapsed="true"]').length, 3);
  h.q('[data-project-menu="project_beta"]').click();
  assert.equal(h.menuLabels().at(-1), 'Expand all projects');
  h.pickMenu('Expand all projects');
  h.controller.renderNow();
  assert.deepEqual(h.stored().collapsed, {});
});

test('Show only this project sets the filter and the list falls back to date groups', async (t) => {
  const h = makeHarness(t);
  await ready(h);
  h.q('[data-project-menu="project_beta"]').click();
  h.pickMenu('Show only this project');
  assert.equal(h.state.ui.chatsProjectFilter, 'project_beta');
  h.controller.renderNow();
  assert.equal(h.q('.project-group'), null);
  assert.deepEqual(h.qa('.conversation-item[data-session-id]').map((row) => row.dataset.sessionId).sort(), ['b1', 'b2', 'pin1']);
  assert.ok(h.q('section.conversation-group[data-chats-group^="recent_"] > .group-label'), 'date groups render with their labels');
  assert.equal(h.switcher.calls.filter && h.switcher.calls.filter.at(-1), 'project_beta', 'the pick is the user\'s own, so a Workspace switch keeps it');
  assert.equal(h.q('[data-chats-group-by]'), null, 'the group-by control hides under a project filter');
});

test('the group-by button shows only with two projects; switching to By date re-renders date groups and persists', async (t) => {
  const h = makeHarness(t);
  await ready(h);
  const button = h.q('#chatsProjectRow [data-chats-group-by]');
  assert.ok(button);
  assert.equal(button.dataset.chatsGroupBy, 'project');
  assert.equal(button.querySelector('.chats-project-filter-name').textContent, 'By project');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.ok(button.getAttribute('title') && button.getAttribute('aria-label'));
  button.focus();
  button.click();
  assert.deepEqual(h.qa('.inv-context-menu-item').map((item) => [item.textContent.trim(), item.getAttribute('aria-checked')]), [['Group by project', 'true'], ['Group by date', 'false']]);
  h.pickMenu('Group by date');
  h.controller.renderNow();
  assert.equal(h.stored().mode, 'date');
  assert.equal(h.q('.project-group'), null);
  assert.ok(h.qa('.group-label').length >= 1);
  const next = h.q('[data-chats-group-by]');
  assert.equal(next.dataset.chatsGroupBy, 'date');
  assert.equal(next.querySelector('.chats-project-filter-name').textContent, 'By date');
  assert.equal(h.doc.activeElement, next, 'focus stays on the group-by button');
  next.click();
  h.pickMenu('Group by project');
  h.controller.renderNow();
  assert.equal(h.stored().mode, 'project');
  assert.equal(h.qa('.project-group').length, 3);

  const single = makeHarness(t, { sessions: [chat('a1', 1, 'project_alpha'), chat('a2', 2, 'project_alpha')] });
  await ready(single);
  assert.equal(single.q('[data-chats-group-by]'), null, 'one project: nothing to group');
});

test('date mode renders exactly the old date groups', async (t) => {
  const h = makeHarness(t, { prefs: { v: 1, mode: 'date', collapsed: {}, names: {} } });
  await ready(h);
  assert.equal(h.q('.project-group'), null);
  assert.equal(h.q('.project-header'), null);
  const labels = h.qa('.conversation-group > .group-label').map((el) => el.textContent);
  assert.deepEqual(labels, ['Pinned', 'Today']);
  assert.deepEqual(h.qa('.conversation-item[data-session-id]').map((row) => row.dataset.sessionId), ['pin1', 'a1', 'a2', 'a3', 'b1', 'b2', 'g1']);
});

test('starting a chat in a collapsed project opens it', async (t) => {
  const h = makeHarness(t, { prefs: { v: 1, mode: 'project', collapsed: { project_beta: true }, names: {} } });
  await ready(h);
  h.q('[data-project-new="project_beta"]').click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(h.switcher.calls.newChat, ['project_beta']);
  assert.deepEqual(h.stored().collapsed, {}, 'the new chat is not hidden in a closed project');
});

test('By date stays reachable while the list is grouped by the empty current project alone', async (t) => {
  const h = makeHarness(t, { sessions: [chat('g1', 1), chat('g2', 2)], switcher: makeSwitcher('project_alpha') });
  await ready(h);
  assert.deepEqual(headerNames(h), ['Alpha', 'General']);
  assert.ok(h.q('[data-chats-group-by]'), 'the group-by button shows so the user can go back to By date');
});

test('a section never carries project classes when its key switches back to a date group', async (t) => {
  const h = makeHarness(t);
  await ready(h);
  projectsUi.setGroupMode(h.window.localStorage, 'date');
  h.controller.renderNow();
  projectsUi.setGroupMode(h.window.localStorage, 'project');
  h.controller.renderNow();
  assert.equal(h.qa('.conversation-group:not(.project-group) .project-header').length, 0);
  assert.equal(h.qa('.project-group').length, 3);
  assert.equal(h.q('[data-chats-group="recent_pinned"]').classList.contains('project-group'), false);
});
