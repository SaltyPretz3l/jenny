'use strict';

// Projects v2 (2026-09-20): the Chats panel filtered by project (parity with
// the Claude Code / Codex desktop apps, on the owner's ask). A plain button at
// the end of the Recent / Archived row opens the shared project menu; picking
// a project narrows the list, keeps the date groups, and offers a new chat
// there when that is truthfully where one would land. Window-scoped; follows
// a Workspace switch; falls back to all when the project is gone.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { buildChatsViewModel, createChatsPanelController } = require('../renderer/shell/renderer-chats-panel');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');

function session(id, title, projectId, extra = {}) {
  return { id, title, project_id: projectId, updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), created_at: new Date().toISOString(), archived_at: null, ...extra };
}

const SESSIONS = [
  session('s1', 'Review the intake module', 'project_ascend'),
  session('s2', 'Dinner ideas', undefined),
  session('s3', 'Variance narrative, Q1', 'project_budget'),
  session('s4', 'Why is the CSV import slow', 'project_ascend', { archived_at: new Date().toISOString() }),
];

test('the view model filters by project id, treats a missing project_id as General, keeps date groups, and reports the project-empty kind', () => {
  const all = buildChatsViewModel({ sessions: SESSIONS, scope: 'recent' });
  assert.equal(all.projectId, '');
  assert.equal(all.visibleCount, 3);

  const ascend = buildChatsViewModel({ sessions: SESSIONS, scope: 'recent', projectId: 'project_ascend' });
  assert.deepEqual(ascend.visibleSessions.map((row) => row.id), ['s1']);
  assert.equal(ascend.projectTotal, 2, 'the project total counts archived chats too');
  assert.equal(ascend.recentTotal, 3, 'the Recent / Archived counts stay unfiltered');
  assert.equal(ascend.archivedTotal, 1);
  assert.ok(ascend.groups.length >= 1, 'date groups survive the filter');

  const general = buildChatsViewModel({ sessions: SESSIONS, scope: 'recent', projectId: 'project_general' });
  assert.deepEqual(general.visibleSessions.map((row) => row.id), ['s2']);

  const empty = buildChatsViewModel({ sessions: SESSIONS, scope: 'recent', projectId: 'project_grants' });
  assert.equal(empty.emptyKind, 'project');
  const archivedEmpty = buildChatsViewModel({ sessions: SESSIONS, scope: 'archived', projectId: 'project_budget' });
  assert.equal(archivedEmpty.emptyKind, 'archived', 'the archived scope keeps its own empty state');
  const searchEmpty = buildChatsViewModel({ sessions: SESSIONS, scope: 'recent', projectId: 'project_ascend', query: 'zzz' });
  assert.equal(searchEmpty.emptyKind, 'search', 'search inside the filter keeps the search empty state');
});

function makeHarness(t, { state, switcher } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div class="chats-project-row" id="chatsProjectRow"></div><div class="chats-scope-row"><div class="chats-scope-slot" id="chatsScopeSlot"></div></div><div id="conversationGroups"></div><div id="chatsPanelStatus"></div><span id="conversationCount"></span></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const doc = dom.window.document;
  const calls = { newChat: 0, opened: [] };
  const controller = createChatsPanelController({
    state,
    documentRef: doc,
    windowRef: dom.window,
    dom: { conversationGroups: doc.getElementById('conversationGroups'), conversationCount: doc.getElementById('conversationCount'), scopeSlot: doc.getElementById('chatsScopeSlot'), projectRow: doc.getElementById('chatsProjectRow'), status: doc.getElementById('chatsPanelStatus') },
    inventory: { actionButton, segmentedControl },
    callbacks: {
      newChat: () => { calls.newChat += 1; },
      ...(switcher === null ? {} : { getProjectSwitcher: async () => switcher }),
    },
  });
  t.after(() => controller.dispose());
  return { dom, doc, controller, calls, filterButton: () => doc.querySelector('[data-chats-project-filter]'), rows: () => Array.from(doc.querySelectorAll('.conversation-item[data-session-id]')).map((row) => row.getAttribute('data-session-id')).sort() };
}

function makeSwitcher(currentId) {
  const projects = [
    { id: 'project_general', name: 'General', rootPath: '' },
    { id: 'project_ascend', name: 'Ascend', rootPath: 'D:\\Projects\\Ascend' },
    { id: 'project_budget', name: 'Budget FY27', rootPath: 'C:\\Budget' },
  ];
  const opened = [];
  return {
    opened,
    async refresh() {},
    getProjects: () => projects,
    projectById: (id) => projects.find((project) => project.id === id) || null,
    currentProject: () => projects.find((project) => project.id === currentId) || null,
    async openFilterMenu(options) { opened.push(options); },
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test('the filter button reads "All projects", opens the shared menu with the current selection, and picking narrows the list while keeping groups', async (t) => {
  const state = { ui: {}, sessions: SESSIONS.slice() };
  const switcher = makeSwitcher('project_ascend');
  const { doc, controller, filterButton, rows } = makeHarness(t, { state, switcher });
  controller.renderNow();
  await settle();
  const button = filterButton();
  assert.ok(button, 'the filter renders');
  assert.ok(doc.querySelector('#chatsProjectRow > [data-chats-project-filter]'), 'the filter sits on its own row above the tabs, not inside the tab slot');
  assert.equal(doc.querySelector('#chatsScopeSlot [data-chats-project-filter]'), null);
  assert.equal(button.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(button.querySelector('.chats-project-filter-name').textContent, 'All projects');
  assert.ok(doc.querySelector('#chatsScopeSlot .inv-segmented'), 'the Recent / Archived control keeps its markup');
  assert.deepEqual(rows(), ['s1', 's2', 's3']);

  button.click();
  await settle();
  assert.equal(switcher.opened.length, 1);
  assert.equal(switcher.opened[0].anchor, button);
  assert.equal(switcher.opened[0].selectedId, '');
  switcher.opened[0].onPick('project_ascend');
  controller.renderNow();
  assert.equal(state.ui.chatsProjectFilter, 'project_ascend');
  assert.deepEqual(rows(), ['s1']);
  assert.equal(filterButton().querySelector('.chats-project-filter-name').textContent, 'Ascend');
  assert.ok(filterButton().classList.contains('chats-project-filter--set'));
  assert.ok(doc.querySelector('.sidebar-group, [data-chats-group], .conversation-group') || doc.querySelector('#conversationGroups').children.length, 'date grouping is still rendered');

  filterButton().click();
  await settle();
  assert.equal(switcher.opened[1].selectedId, 'project_ascend');
  switcher.opened[1].onPick('');
  controller.renderNow();
  assert.deepEqual(rows(), ['s1', 's2', 's3']);
});

test('an empty project offers "New chat in {name}" only when that is the current Workspace project; otherwise the way back to all projects', async (t) => {
  const state = { ui: { chatsProjectFilter: 'project_budget' }, sessions: [session('s1', 'Intake', 'project_ascend')] };
  const switcher = makeSwitcher('project_ascend');
  const { doc, controller, calls } = makeHarness(t, { state, switcher });
  controller.renderNow();
  await settle();
  controller.renderNow();
  let empty = doc.querySelector('[data-chats-empty]');
  assert.equal(empty.dataset.emptyKind, 'project');
  assert.equal(empty.querySelector('.sidebar-empty-title').textContent, 'No chats in Budget FY27 yet.');
  assert.match(empty.querySelector('.sidebar-empty-copy').textContent, /current Workspace project/);
  const back = empty.querySelector('[data-chats-empty-action="project-all"]');
  assert.equal(back.textContent.trim(), 'Show all projects');
  back.click();
  controller.renderNow();
  assert.equal(state.ui.chatsProjectFilter, '');
  assert.equal(doc.querySelector('[data-chats-empty]'), null);

  state.sessions = [];
  controller.setProjectFilter('project_ascend');
  controller.renderNow();
  empty = doc.querySelector('[data-chats-empty]');
  assert.equal(empty.querySelector('.sidebar-empty-title').textContent, 'No chats in Ascend yet.');
  const create = empty.querySelector('[data-chats-empty-action="project-new"]');
  assert.equal(create.textContent.trim(), 'New chat in Ascend');
  create.click();
  assert.equal(calls.newChat, 1);
});

test('a filter pointing at a deleted project falls back to all projects; without a switcher wired the row has no filter button', async (t) => {
  const state = { ui: { chatsProjectFilter: 'project_gone' }, sessions: SESSIONS.slice() };
  const switcher = makeSwitcher('project_ascend');
  const { controller, rows, filterButton } = makeHarness(t, { state, switcher });
  controller.renderNow();
  await settle();
  controller.renderNow();
  assert.equal(state.ui.chatsProjectFilter, '');
  assert.deepEqual(rows(), ['s1', 's2', 's3']);
  assert.equal(filterButton().querySelector('.chats-project-filter-name').textContent, 'All projects');

  const bare = makeHarness(t, { state: { ui: {}, sessions: SESSIONS.slice() }, switcher: null });
  bare.controller.renderNow();
  assert.equal(bare.filterButton(), null);
  assert.ok(bare.doc.querySelector('#chatsScopeSlot .inv-segmented'));
});
