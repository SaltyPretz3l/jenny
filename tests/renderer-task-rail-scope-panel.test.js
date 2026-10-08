'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadRendererApp, waitForUi, row, bootOptions, stubWorkspaceLayout, carryProjectIds,
  boot, openTasks,
} = require('./helpers/task-rail-panel-fixture');

// ---- Project scope (FG-002 B4) ----------------------------------------------

const SCOPE_PROJECTS = [
  { id: 'project_general', name: 'General (stored)', root_path: null, folder_exists: null, is_current: false },
  { id: 'project_alpha', name: 'Alpha', root_path: 'D:\\Work\\Alpha', folder_exists: true, is_current: true },
  { id: 'project_beta', name: 'Beta', root_path: 'D:\\Work\\Beta', folder_exists: true, is_current: false },
];

const SCOPE_BOARD = {
  active: [
    row('alpha-1', 'Alpha one', { projectId: 'project_alpha' }),
    row('alpha-2', 'Alpha two', { projectId: 'project_alpha' }),
    row('beta-1', 'Beta one', { projectId: 'project_beta' }),
    row('orphan-1', 'Orphan one', { projectId: '' }),
  ],
  recentResolved: [row('alpha-done', 'Alpha done', { projectId: 'project_alpha', status: 'resolved' })],
};

// The chat sits in Alpha; a second chat sits in Beta.
async function bootScoped(board = SCOPE_BOARD, { listed = SCOPE_PROJECTS, chatProject = 'project_alpha' } = {}) {
  const options = bootOptions(board);
  options.shell.projects = { async list() { return { ok: true, projects: listed.slice() }; } };
  // The harness lazy loader only serves the IDE manifest, so hand it the shared project switcher scripts.
  options.windowGlobals = {
    rendererProjectMenu: require('../renderer/features/renderer-project-menu'),
    rendererProjectSwitcher: require('../renderer/features/renderer-project-switcher'),
  };
  const app = await loadRendererApp(options);
  stubWorkspaceLayout(app.window.document);
  carryProjectIds(app);
  app.window.document.getElementById('newChatButton').click();
  await waitForUi(app.window, 30);
  const state = app.window.__rendererState;
  state.sessions.find((session) => session.id === state.currentSessionId).project_id = chatProject;
  state.sessions.push({ id: 'beta-chat', title: 'Beta chat', project_id: 'project_beta' });
  return app;
}

function scopeButton(app) {
  return app.window.document.getElementById('task-rail-scope');
}

async function openScopeMenu(app) {
  scopeButton(app).click();
  await waitForUi(app.window, 30);
  return Array.from(app.window.document.querySelectorAll('#projectMenu [data-project-menu-item]'));
}

function menuRowText(rowEl) {
  return {
    label: rowEl.querySelector('.project-menu-name')?.textContent || '',
    detail: rowEl.querySelector('.project-menu-detail')?.textContent || '',
    count: rowEl.querySelector('.project-menu-count')?.textContent || '',
    selected: rowEl.querySelector('.project-menu-check')?.textContent === '\u2713',
  };
}

function groupHeadings(panel) {
  return Array.from(panel.querySelectorAll('.task-rail-group')).map((group) => group.querySelector('b').textContent);
}

test('the rail follows the chat project: scope button, rows, badge and summary', async (t) => {
  const app = await bootScoped();
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  await waitForUi(app.window, 20);
  assert.equal(scopeButton(app).dataset.taskScope, 'current');
  assert.equal(scopeButton(app).querySelector('.task-rail-scope-name').textContent, 'Alpha');
  assert.equal(scopeButton(app).getAttribute('aria-label'), 'Show tasks from: Alpha');
  assert.match(panel.textContent, /Alpha one/);
  assert.match(panel.textContent, /Alpha two/);
  assert.doesNotMatch(panel.textContent, /Beta one|Orphan one/);
  assert.match(panel.querySelector('.task-rail-summary').textContent, /2 follow-ups open/);
  assert.equal(panel.querySelector('[data-task-draft-title]').getAttribute('placeholder'), 'Add a task to Alpha');
  // The badge counts the chat's project only, whatever the rail shows.
  assert.equal(app.window.document.querySelector('[data-task-count]').textContent, '2');
  app.window.__rendererState.ui.taskRail.scope = 'all';
  app.window.rendererTaskRailActions.refreshChecklist();
  assert.equal(app.window.document.querySelector('[data-task-count]').textContent, '2', 'the badge ignores the rail scope');
});

test('the scope menu lists the chat project first, All projects second, with open-task counts', async (t) => {
  const app = await bootScoped();
  t.after(() => app.dispose());
  await openTasks(app);
  await waitForUi(app.window, 20);
  const rows = await openScopeMenu(app);
  const menu = app.window.document.getElementById('projectMenu');
  assert.ok(menu, 'the shared project menu opens');
  assert.match(menu.textContent, /Show tasks from/);
  const texts = rows.map(menuRowText);
  assert.deepEqual(texts[0], { label: 'Alpha', detail: 'this chat', count: '2', selected: true });
  assert.deepEqual(texts[1], { label: 'All projects', detail: '', count: '4', selected: false });
  assert.deepEqual(texts.slice(2).map((entry) => [entry.label, entry.count]), [['Beta', '1'], ['General', '0']]);
  assert.equal(scopeButton(app).getAttribute('aria-haspopup'), 'menu');
});

test('picking All projects groups the rail by project; picking another project marks the scope away', async (t) => {
  const app = await bootScoped();
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  await waitForUi(app.window, 20);
  let rows = await openScopeMenu(app);
  rows[1].click();
  await waitForUi(app.window, 20);
  assert.equal(scopeButton(app).dataset.taskScope, 'all');
  assert.equal(scopeButton(app).querySelector('.task-rail-scope-name').textContent, 'All projects');
  assert.deepEqual(groupHeadings(panel), ['Alpha', 'Beta', 'No project']);
  assert.match(panel.querySelector('.task-rail-group span').textContent, /2 open . this chat/);
  assert.match(panel.querySelector('.task-rail-summary').textContent, /4 follow-ups open in 2 projects/);
  assert.equal(panel.querySelector('[data-task-draft-title]').getAttribute('placeholder'), 'Add a task to Alpha');

  rows = await openScopeMenu(app);
  assert.equal(menuRowText(rows[1]).selected, true, 'All projects is marked selected');
  rows[2].click();
  await waitForUi(app.window, 20);
  assert.equal(scopeButton(app).dataset.taskScope, 'project');
  assert.equal(scopeButton(app).classList.contains('task-rail-scope--away'), true);
  assert.equal(scopeButton(app).querySelector('.task-rail-scope-name').textContent, 'Beta');
  assert.match(panel.textContent, /Beta one/);
  assert.doesNotMatch(panel.textContent, /Alpha one|Orphan one/);
  assert.equal(panel.querySelector('[data-task-draft-title]').getAttribute('placeholder'), 'Add a task to Beta');

  rows = await openScopeMenu(app);
  rows[0].click();
  await waitForUi(app.window, 20);
  assert.equal(app.window.__rendererState.ui.taskRail.scope, 'current', 'picking the chat project returns to following the chat');
  assert.equal(scopeButton(app).classList.contains('task-rail-scope--away'), false);
});

test('Add files the task in the scoped project, or the chat project under All projects', async (t) => {
  const app = await bootScoped();
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  await waitForUi(app.window, 20);
  const addTask = async (title) => {
    panel.querySelector('[data-task-draft-title]').value = title;
    panel.querySelector('[data-action="task-rail-add"]').click();
    await waitForUi(app.window, 30);
  };
  await addTask('Into the chat project');
  let rows = await openScopeMenu(app);
  rows[2].click();
  await waitForUi(app.window, 20);
  await addTask('Into Beta');
  rows = await openScopeMenu(app);
  rows[1].click();
  await waitForUi(app.window, 20);
  await addTask('From All projects');
  const calls = app.shell.__state.companionCalls.addFollowUp;
  assert.deepEqual(calls.map((call) => [call.label, call.projectId]), [
    ['Into the chat project', 'project_alpha'],
    ['Into Beta', 'project_beta'],
    ['From All projects', 'project_alpha'],
  ]);
});

test('the rail re-scopes when the active chat changes project and keeps an away scope', async (t) => {
  const app = await bootScoped();
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  await waitForUi(app.window, 20);
  assert.equal(scopeButton(app).querySelector('.task-rail-scope-name').textContent, 'Alpha');
  app.window.__rendererState.currentSessionId = 'beta-chat';
  app.window.rendererTaskRailActions.refreshChecklist();
  assert.equal(scopeButton(app).querySelector('.task-rail-scope-name').textContent, 'Beta');
  assert.match(panel.textContent, /Beta one/);
  assert.doesNotMatch(panel.textContent, /Alpha one/);
  assert.equal(app.window.document.querySelector('[data-task-count]').textContent, '1');
});

test('a picked project that disappears falls back to following the chat', async (t) => {
  const listed = SCOPE_PROJECTS.slice();
  const app = await bootScoped(SCOPE_BOARD, { listed });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  await waitForUi(app.window, 20);
  const rows = await openScopeMenu(app);
  rows[2].click();
  await waitForUi(app.window, 20);
  assert.equal(app.window.__rendererState.ui.taskRail.scope, 'project_beta');
  // Beta is deleted: the switcher announces the new list.
  listed.splice(2, 1);
  app.window.dispatchEvent(new app.window.CustomEvent('jenny:projects-changed', { detail: { source: 'settings' } }));
  await waitForUi(app.window, 40);
  assert.equal(app.window.__rendererState.ui.taskRail.scope, 'current');
  assert.equal(scopeButton(app).querySelector('.task-rail-scope-name').textContent, 'Alpha');
  assert.match(panel.textContent, /Alpha one/);
});

test('a stored scope that is not a string falls back to current', async (t) => {
  const app = await bootScoped();
  t.after(() => app.dispose());
  app.window.__rendererState.ui.taskRail.scope = { bogus: true };
  const panel = await openTasks(app);
  await waitForUi(app.window, 20);
  assert.equal(app.window.__rendererState.ui.taskRail.scope, 'current');
  assert.match(panel.textContent, /Alpha one/);
});

test('send list composes the open tasks inside the current scope', async (t) => {
  const app = await bootScoped();
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  await waitForUi(app.window, 20);
  panel.querySelector('[data-action="task-rail-send-list"]').click();
  const value = app.window.document.getElementById('chatInput').value;
  assert.match(value, /Alpha one \(id alpha-1\)/);
  assert.doesNotMatch(value, /Beta one|Orphan one/);
});

test('without a loaded project switcher the scope button names the chat project and a click is harmless', async (t) => {
  const app = await boot({ active: [row('g1', 'General one')] });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  assert.equal(scopeButton(app).querySelector('.task-rail-scope-name').textContent, 'General');
  scopeButton(app).click();
  await waitForUi(app.window, 10);
  assert.equal(app.window.document.getElementById('projectMenu'), null);
  assert.match(panel.textContent, /General one/);
});
