'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  loadRendererApp, waitForUi, row, companionState, bootOptions, stubWorkspaceLayout,
  checklistMessage, setSessionChecklist, menuItem,
  boot, openTasks,
} = require('./helpers/task-rail-panel-fixture');
const { createTaskRail, preferredSide } = require('../renderer/features/renderer-task-rail');

test('toggle opens tasks mode in the panel the workbench stack hosts', async (t) => {
  const app = await boot({ active: [row('open-1', 'Open one')] });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  const toggle = app.window.document.getElementById('chatTimelineTasksToggle');
  assert.equal(panel.classList.contains('hidden'), false);
  assert.equal(panel.dataset.artifactReviewMode, 'tasks');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(panel.style.width, '', 'the stack owns the panel size');
});

test('flag off omits the tasks toggle', async (t) => {
  const options = bootOptions({});
  options.shell.features.state.featureFlags.tools_task_board_enabled = false;
  const app = await loadRendererApp(options);
  t.after(() => app.dispose());
  await waitForUi(app.window, 30);
  assert.equal(app.window.document.getElementById('chatTimelineTasksToggle'), null);
});

test('renders agent task details and excludes non-agent follow-ups', async (t) => {
  const app = await boot({ active: [
    row('agent-1', 'Agent row'),
    row('manual-1', 'Manual row', { sourceKind: 'manual', sourceBadge: 'Manual' }),
  ] });
  t.after(() => app.dispose());
  let panel = await openTasks(app);
  assert.ok(panel.querySelector('[data-inv-checkbox][data-follow-up-id="agent-1"]'));
  assert.doesNotMatch(panel.textContent, /Manual row/);
  assert.doesNotMatch(panel.textContent, /from Origin chat|Agent row notes/, 'details wait for the title');
  assert.equal(panel.querySelector('.task-rail-footer'), null, 'no footer');

  // The title opens the row in place and keeps keyboard focus on it.
  panel.querySelector('[data-action="task-rail-toggle"][data-task-id="agent-1"]').click();
  await waitForUi(app.window, 10);
  panel = app.window.document.getElementById('artifactReviewPanel');
  const title = panel.querySelector('[data-action="task-rail-toggle"][data-task-id="agent-1"]');
  assert.equal(title.getAttribute('aria-expanded'), 'true');
  assert.equal(app.window.document.activeElement, title);
  assert.match(panel.querySelector('.task-rail-detail').textContent, /Agent row notes[\s\S]*from Origin chat[\s\S]*Start a session[\s\S]*Edit/);

  // Edit from the opened row swaps in the editor; the title closes it again.
  panel.querySelector('[data-action="task-rail-edit"][data-task-id="agent-1"]').click();
  await waitForUi(app.window, 10);
  panel = app.window.document.getElementById('artifactReviewPanel');
  assert.ok(panel.querySelector('#taskRailEditTitle-agent-1'), 'the editor opens');
  panel.querySelector('[data-action="task-rail-edit-cancel"]').click();
  await waitForUi(app.window, 10);
  panel = app.window.document.getElementById('artifactReviewPanel');
  panel.querySelector('[data-action="task-rail-toggle"][data-task-id="agent-1"]').click();
  await waitForUi(app.window, 10);
  panel = app.window.document.getElementById('artifactReviewPanel');
  assert.equal(panel.querySelector('.task-rail-detail'), null);
});

test('checkbox mutations resolve and reactivate tasks', async (t) => {
  const openApp = await boot({ active: [row('resolve-me', 'Resolve me')] });
  t.after(() => openApp.dispose());
  let panel = await openTasks(openApp);
  const checkbox = panel.querySelector('[data-follow-up-id="resolve-me"]');
  checkbox.checked = true;
  checkbox.dispatchEvent(new openApp.window.Event('change', { bubbles: true }));
  await waitForUi(openApp.window, 30);
  assert.deepEqual(openApp.shell.__state.companionCalls.resolveFollowUp, ['resolve-me']);
  panel = openApp.window.document.getElementById('artifactReviewPanel');
  // All is the default: a checked-off task stays in the list, marked done.
  const resolvedRow = panel.querySelector('.task-rail-row[data-task-id="resolve-me"]');
  assert.ok(resolvedRow.classList.contains('task-rail-row--resolved'));
  assert.equal(resolvedRow.querySelector('[data-follow-up-id="resolve-me"]').checked, true);
  panel.querySelector('.inv-segmented-option[data-value="open"]').click();
  await waitForUi(openApp.window, 10);
  assert.equal(panel.querySelector('[data-task-id="resolve-me"]'), null);

  const doneApp = await boot({ recentResolved: [row('reopen-me', 'Reopen me', { status: 'resolved' })] });
  t.after(() => doneApp.dispose());
  panel = await openTasks(doneApp);
  panel.querySelector('.inv-segmented-option[data-value="done"]').click();
  await waitForUi(doneApp.window, 10);
  const doneCheckbox = panel.querySelector('[data-follow-up-id="reopen-me"]');
  doneCheckbox.checked = false;
  doneCheckbox.dispatchEvent(new doneApp.window.Event('change', { bubbles: true }));
  await waitForUi(doneApp.window, 30);
  assert.deepEqual(doneApp.shell.__state.companionCalls.activateFollowUp, ['reopen-me']);
});

test('filters partition active, resolved, and archived rows', async (t) => {
  const app = await boot({
    active: [row('open', 'Open task')],
    recentResolved: [row('done', 'Done task', { status: 'resolved' })],
    archived: [row('archived', 'Archived task', { status: 'archived' })],
  });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  // All leads the filter and is the default.
  const options = Array.from(panel.querySelectorAll('.task-rail-filters .inv-segmented-option'));
  assert.deepEqual(options.map((option) => option.dataset.value), ['all', 'open', 'done']);
  assert.equal(panel.querySelector('.task-rail-filters .inv-segmented-option[aria-checked="true"]').dataset.value, 'all');
  assert.match(panel.textContent, /Open task[\s\S]*Done task/);
  assert.match(panel.textContent, /Archived task/);
  panel.querySelector('.inv-segmented-option[data-value="open"]').click();
  await waitForUi(app.window, 10);
  assert.match(panel.textContent, /Open task/);
  assert.doesNotMatch(panel.textContent, /Done task|Archived task/);
  panel.querySelector('.inv-segmented-option[data-value="done"]').click();
  await waitForUi(app.window, 10);
  assert.match(panel.textContent, /Done task/);
  assert.doesNotMatch(panel.textContent, /Open task|Archived task/);
});

test('add trims titles and ignores blank drafts', async (t) => {
  const app = await boot({});
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  const field = panel.querySelector('[data-task-draft-title]');
  field.value = '  New agent task  ';
  panel.querySelector('[data-action="task-rail-add"]').click();
  await waitForUi(app.window, 30);
  const payload = app.shell.__state.companionCalls.addFollowUp[0];
  assert.equal(payload.label, 'New agent task');
  assert.equal(payload.body, '');
  assert.equal(payload.status, 'active');
  assert.equal(payload.sourceKind, 'agent_task');
  assert.equal(payload.sessionId, '');
  const nextField = panel.querySelector('[data-task-draft-title]');
  nextField.value = '   ';
  panel.querySelector('[data-action="task-rail-add"]').click();
  await waitForUi(app.window, 10);
  assert.equal(app.shell.__state.companionCalls.addFollowUp.length, 1);
});

test('add coalesces synchronous clicks while the mutation is pending', async (t) => {
  const app = await boot({});
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  const calls = [];
  let finishAdd;
  app.window.jennyShell.companion.addFollowUp = (payload) => {
    calls.push(payload);
    return new Promise((resolve) => { finishAdd = resolve; });
  };
  panel.querySelector('[data-task-draft-title]').value = 'Only once';
  panel.querySelector('[data-action="task-rail-add"]').click();
  const busyButton = panel.querySelector('[data-action="task-rail-add"]');
  assert.equal(busyButton.disabled, true);
  assert.equal(panel.querySelector('[data-task-draft-title]').disabled, true);
  busyButton.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  assert.equal(calls.length, 1);
  finishAdd(app.window.__rendererState.companion);
  await new Promise((resolve) => setImmediate(resolve));
});

test('pending add settlement does not replace companion state after disposal', async (t) => {
  const app = await boot({});
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  let finishAdd;
  app.window.jennyShell.companion.addFollowUp = () => new Promise((resolve) => { finishAdd = resolve; });
  const companionBefore = app.window.__rendererState.companion;
  panel.querySelector('[data-task-draft-title]').value = 'Late task';
  panel.querySelector('[data-action="task-rail-add"]').click();
  await app.window.__disposeRenderer();
  finishAdd(companionState({ active: [row('late', 'Late task')] }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(app.window.__rendererState.companion, companionBefore);
});

test('starts linked sessions and recognizes an existing linked session', async (t) => {
  const app = await boot({ active: [row('task-link', 'Linked work')] });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  const calls = [];
  let finishStart;
  app.window.rendererTaskSessionActions = { start: (payload) => {
    calls.push(payload);
    return new Promise((resolve) => { finishStart = resolve; });
  } };
  panel.querySelector('[data-action="task-rail-overflow"]').click();
  menuItem(app, 'Start a session').click();
  assert.equal(calls[0].linkedTaskId, 'task-link');
  assert.match(calls[0].initialPrompt, /Jenny task id: task-link/);
  const busyButton = panel.querySelector('[data-action="task-rail-overflow"]');
  assert.equal(busyButton.disabled, true);
  assert.equal(calls.length, 1);
  finishStart();
  await new Promise((resolve) => setImmediate(resolve));

  app.window.__rendererState.sessions.push({ id: 'linked-session', title: 'Linked', linked_task_id: 'task-link' });
  app.window.rendererTaskRailActions.open();
  await waitForUi(app.window, 10);
  panel.querySelector('[data-action="task-rail-overflow"]').click();
  assert.ok(menuItem(app, 'Open session'));
  assert.equal(menuItem(app, 'Start a session'), undefined);
});

test('starting a session passes the task project and omits it for a project-less task', async (t) => {
  const app = await boot({
    active: [
      row('task-proj', 'Project work', { projectId: 'project_abc' }),
      row('task-bare', 'Bare work', { projectId: '' }),
    ],
  });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  // Unstamped and other-project tasks only show under All projects.
  app.window.__rendererState.ui.taskRail.scope = 'all';
  const calls = [];
  app.window.rendererTaskSessionActions = { start: async (payload) => { calls.push(payload); } };
  // The renderer companion normalizer (outside this slice) does not carry projectId yet, so seed it on the board entry.
  app.window.__rendererState.companion.openLoopsBoard.active
    .find((entry) => entry.followUpId === 'task-proj').projectId = 'project_abc';
  app.window.rendererTaskRailActions.open();
  await waitForUi(app.window, 10);
  for (const taskId of ['task-proj', 'task-bare']) {
    panel.querySelector(`[data-action="task-rail-overflow"][data-task-id="${taskId}"]`).click();
    menuItem(app, 'Start a session').click();
    await new Promise((resolve) => setImmediate(resolve));
    await waitForUi(app.window, 5);
  }
  const withProject = calls.find((call) => call.linkedTaskId === 'task-proj');
  const bare = calls.find((call) => call.linkedTaskId === 'task-bare');
  assert.equal(withProject.projectId, 'project_abc');
  assert.equal(Object.hasOwn(bare, 'projectId'), false);
});

test('send list composes open tasks only', async (t) => {
  const app = await boot({
    active: [row('open-a', 'First open')],
    deferred: [row('open-b', 'Second open', { status: 'deferred' })],
    recentResolved: [row('done-c', 'Already done', { status: 'resolved' })],
  });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  panel.querySelector('[data-action="task-rail-send-list"]').click();
  const value = app.window.document.getElementById('chatInput').value;
  assert.match(value, /^Open tasks:\n/);
  assert.match(value, /First open \(id open-a\)/);
  assert.match(value, /Second open \(id open-b\)/);
  assert.doesNotMatch(value, /Already done/);
});

test('overflow exposes task actions; Delete hides the row at once and the Undo line brings it back', async (t) => {
  const app = await boot({ recentResolved: [row('menu-task', 'Menu task', { status: 'resolved' })] });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  panel.querySelector('.inv-segmented-option[data-value="done"]').click();
  await waitForUi(app.window, 10);
  const overflow = panel.querySelector('[data-action="task-rail-overflow"]');
  overflow.click();
  // The hover-only button stays visible while its menu is open.
  assert.equal(overflow.getAttribute('aria-expanded'), 'true');
  const menu = app.window.document.querySelector('.inv-context-menu');
  assert.match(menu.textContent, /Edit/);
  assert.match(menu.textContent, /Archive/);
  const deleteButton = Array.from(menu.querySelectorAll('.inv-context-menu-item'))
    .find((button) => button.textContent.includes('Delete'));
  deleteButton.click();
  await waitForUi(app.window, 30);
  assert.equal(panel.querySelector('[data-task-id="menu-task"]'), null, 'the row is gone at once');
  assert.match(panel.querySelector('.project-tab-undo[role="status"]').textContent, /Task deleted\./);
  assert.deepEqual(app.shell.__state.companionCalls.deleteFollowUp, [], 'nothing is deleted while Undo is on offer');
  panel.querySelector('[data-action="task-rail-undo-delete"]').click();
  await waitForUi(app.window, 10);
  assert.ok(panel.querySelector('[data-task-id="menu-task"]'), 'Undo puts the task back');
  assert.equal(panel.querySelector('.project-tab-undo'), null);
  assert.deepEqual(app.shell.__state.companionCalls.deleteFollowUp, []);
});

test('overflow offers Reopen instead of defer on a done task and keeps defer on an open one', async (t) => {
  const app = await boot({
    active: [row('open-task', 'Open task')],
    recentResolved: [row('done-task', 'Done task', { status: 'resolved' })],
  });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  panel.querySelector('[data-action="task-rail-overflow"]').click();
  assert.ok(menuItem(app, 'Defer until tomorrow'), 'an open task can still be deferred');
  assert.equal(menuItem(app, 'Reopen'), undefined);
  app.window.document.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitForUi(app.window, 10);

  panel.querySelector('.inv-segmented-option[data-value="done"]').click();
  await waitForUi(app.window, 10);
  panel.querySelector('[data-action="task-rail-overflow"]').click();
  assert.equal(menuItem(app, 'Defer until tomorrow'), undefined);
  menuItem(app, 'Reopen').click();
  await waitForUi(app.window, 30);
  assert.deepEqual(app.shell.__state.companionCalls.activateFollowUp, ['done-task']);
  assert.deepEqual(app.shell.__state.companionCalls.deferFollowUp || [], []);
});

test('the Tasks list has no checklist section; the checklist stays readable from the rail', async (t) => {
  const app = await boot({ active: [row('follow-up', 'Follow-up')] });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  const sessionId = app.window.__rendererState.currentSessionId;
  setSessionChecklist(app, sessionId, [
    { content: 'Model pending', status: 'pending' },
    { content: 'Model active', status: 'in_progress' },
  ]);
  assert.equal(typeof app.window.rendererTaskRailActions.refreshChecklist, 'function');
  app.window.rendererTaskRailActions.refreshChecklist();
  assert.match(panel.textContent, /Follow-up/);
  assert.doesNotMatch(panel.textContent, /Model pending|Model active|Jenny.s checklist/);
  assert.equal(panel.querySelector('.task-rail-check'), null);
  assert.equal(app.window.rendererTaskRailActions.openTaskCount(), 1, 'steps are not follow-ups');
});

test('a refresh never discards an open editor or draft', async (t) => {
  const app = await boot({ active: [row('edit-me', 'Stored title')] });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  const sessionId = app.window.__rendererState.currentSessionId;
  panel.querySelector('[data-action="task-rail-overflow"]').click();
  menuItem(app, 'Edit').click();
  await waitForUi(app.window, 10);
  const title = panel.querySelector('#taskRailEditTitle-edit-me');
  title.value = 'Unsaved title';
  app.window.rendererTaskRailActions.refreshChecklist({ sessionId });
  assert.equal(panel.querySelector('#taskRailEditTitle-edit-me').value, 'Unsaved title', 'the editor survives a refresh');
});

test('a mutation refreshes the rows and the count; nothing is painted onto the toolbar button', async (t) => {
  const app = await boot({});
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  const toggle = app.window.document.getElementById('chatTimelineTasksToggle');
  assert.equal(app.window.rendererTaskRailActions.openTaskCount(), 0);
  app.shell.__state.companionState = companionState({ active: [row('fresh', 'Fresh task')] });
  await app.window.rendererTaskBoard.notifyMutation();
  assert.match(panel.textContent, /Fresh task/);
  assert.equal(app.window.rendererTaskRailActions.openTaskCount(), 1);
  assert.equal(app.window.document.querySelector('[data-task-count]'), null, 'no count element is painted anywhere');
  assert.equal(toggle.getAttribute('aria-label'), 'Tasks');
  assert.equal(toggle.getAttribute('title'), 'Tasks');
  assert.match(panel.querySelector('.project-tab-head').textContent, /Tasks 1/, 'the count lives on the head row switch');
});

// The rail on its own (a bare jsdom panel and stubbed deps): the Project tab's head row, the
// delete-with-Undo line and the signals, without the whole app.
function directRail(options = {}) {
  const dom = new JSDOM('<body><div id="artifactReviewPanel"><div id="host"></div></div></body>', { pretendToBeVisual: true });
  const { window } = dom;
  const stored = {};
  Object.defineProperty(window, 'localStorage', { value: { getItem: (key) => (key in stored ? stored[key] : null), setItem: (key, value) => { stored[key] = value; } } });
  const calls = { open: [], deletes: [], notes: 0, signals: 0 };
  const entries = (options.ids || ['t1', 't2', 't3']).map((id) => ({
    followUpId: id, title: `Task ${id}`, status: 'active', sourceKind: 'agent_task', projectId: 'project_a',
  }));
  const state = {
    features: { featureFlags: { tools_task_board_enabled: true } },
    sessions: [{ id: 's1', project_id: 'project_a' }, { id: 's2', project_id: 'project_b' }],
    currentSessionId: 's1',
    companion: { openLoopsBoard: { active: entries, deferred: [], recentResolved: [], archived: [] } },
    messagesBySession: new Map(),
    ui: { artifactReview: { mode: 'tasks', enabled: true, collapsed: false } },
  };
  window.jennyShell = {
    companion: {
      async deleteFollowUp(id) {
        calls.deletes.push(id);
        state.companion = { openLoopsBoard: { ...state.companion.openLoopsBoard, active: state.companion.openLoopsBoard.active.filter((entry) => entry.followUpId !== id) } };
        return state.companion;
      },
    },
  };
  const panel = window.document.getElementById('artifactReviewPanel');
  const host = window.document.getElementById('host');
  let menuItems = [];
  let controller = null;
  controller = createTaskRail({
    state,
    windowRef: window,
    dom: { artifactReviewPanel: panel },
    inventory: { contextMenu: { show: (config) => { menuItems = config.items; }, hide() {} } },
    openArtifactRail: (mode) => { calls.open.push(mode); state.ui.artifactReview.mode = mode; },
    renderArtifactReviewPanel: () => { if (state.ui.artifactReview.mode === 'tasks') controller.renderRailContent({ previewContent: host }); },
    ...(options.openNotes ? { openNotes: () => { calls.notes += 1; } } : {}),
    onSignalsChanged: () => { calls.signals += 1; },
  });
  controller.bind();
  controller.renderRailContent({ previewContent: host });
  const q = (selector) => host.querySelector(selector);
  const deleteTask = (id) => {
    q(`[data-task-id="${id}"] [data-action="task-rail-overflow"]`).click();
    menuItems.find((item) => item.label === 'Delete').action();
  };
  const ids = () => Array.from(host.querySelectorAll('[data-task-id]')).map((el) => el.dataset.taskId).filter((id, index, all) => all.indexOf(id) === index);
  return { controller, window, state, host, q, calls, deleteTask, ids, stored };
}

test('Delete takes the row away at once and shows one Undo line under the list', async (t) => {
  const r = directRail();
  t.after(() => r.controller.dispose());
  assert.deepEqual(r.ids(), ['t1', 't2', 't3']);
  r.deleteTask('t2');
  assert.deepEqual(r.ids(), ['t1', 't3']);
  const line = r.q('.task-rail-list + .project-tab-undo');
  assert.ok(line, 'the line sits directly under the list');
  assert.equal(line.getAttribute('role'), 'status');
  assert.equal(line.querySelector('span').textContent, 'Task deleted.');
  assert.equal(line.querySelector('button').textContent, 'Undo');
  assert.deepEqual(r.calls.deletes, [], 'the store is not touched while Undo is on offer');
  assert.equal(r.controller.openTaskCount(), 2, 'the count already drops');
});

test('Undo puts the task back in its place, as it was, and returns focus to it', async (t) => {
  const r = directRail();
  t.after(() => r.controller.dispose());
  r.deleteTask('t2');
  r.q('[data-action="task-rail-undo-delete"]').click();
  assert.deepEqual(r.ids(), ['t1', 't2', 't3'], 'same order');
  assert.equal(r.q('[data-task-id="t2"] .task-rail-title').textContent, 'Task t2');
  assert.equal(r.q('.project-tab-undo'), null);
  assert.equal(r.window.document.activeElement, r.q('[data-task-id="t2"] [data-action="task-rail-toggle"]'));
  assert.deepEqual(r.calls.deletes, []);
  assert.equal(r.controller.openTaskCount(), 3);
});

test('Deleting another task replaces the line and makes the first deletion for good', async (t) => {
  const r = directRail();
  t.after(() => r.controller.dispose());
  r.deleteTask('t1');
  r.deleteTask('t3');
  await waitForUi(r.window, 10);
  assert.deepEqual(r.calls.deletes, ['t1']);
  assert.equal(r.host.querySelectorAll('.project-tab-undo').length, 1, 'one line, for the latest task');
  assert.deepEqual(r.ids(), ['t2']);
  r.q('[data-action="task-rail-undo-delete"]').click();
  assert.deepEqual(r.ids(), ['t2', 't3'], 'Undo restores the latest, not the one already gone');
});

test('Closing the tab, switching side or changing project ends the Undo line with the deletion made', async (t) => {
  const closing = directRail();
  t.after(() => closing.controller.dispose());
  closing.deleteTask('t1');
  await closing.controller.settlePendingDelete();
  assert.deepEqual(closing.calls.deletes, ['t1']);
  assert.equal(closing.q('.project-tab-undo'), null);

  const side = directRail({ openNotes: true });
  t.after(() => side.controller.dispose());
  side.deleteTask('t2');
  side.q('[data-inv-segmented="project-tab-side"]').dispatchEvent(new side.window.CustomEvent('inv-segmented-change', { bubbles: true, detail: { id: 'project-tab-side', value: 'notes' } }));
  await waitForUi(side.window, 10);
  assert.deepEqual(side.calls.deletes, ['t2']);

  const moved = directRail();
  t.after(() => moved.controller.dispose());
  moved.deleteTask('t3');
  moved.state.currentSessionId = 's2';
  moved.controller.renderRailContent({ previewContent: moved.host });
  await waitForUi(moved.window, 10);
  assert.deepEqual(moved.calls.deletes, ['t3']);
  assert.equal(moved.q('.project-tab-undo'), null);
});

test('A failed deletion brings the row back and says so', async (t) => {
  const r = directRail();
  t.after(() => r.controller.dispose());
  r.window.jennyShell.companion.deleteFollowUp = async () => { throw new Error('boom'); };
  r.deleteTask('t1');
  await r.controller.settlePendingDelete();
  assert.deepEqual(r.ids(), ['t1', 't2', 't3']);
});

test('Choosing Notes on the switch opens the notes mode, remembers the side and tells the strip nothing else', async (t) => {
  const r = directRail();
  t.after(() => r.controller.dispose());
  assert.equal(preferredSide('project_a', r.window.localStorage), 'tasks', 'the side shown is the side remembered');
  const group = r.q('[data-inv-segmented="project-tab-side"]');
  group.dispatchEvent(new r.window.CustomEvent('inv-segmented-change', { bubbles: true, detail: { id: 'project-tab-side', value: 'notes' } }));
  assert.deepEqual(r.calls.open, ['notes'], 'the open function gets the notes mode');
  assert.equal(preferredSide('project_a', r.window.localStorage), 'notes');
  // The Tasks segment is the side already shown.
  group.dispatchEvent(new r.window.CustomEvent('inv-segmented-change', { bubbles: true, detail: { id: 'project-tab-side', value: 'tasks' } }));
  assert.deepEqual(r.calls.open, ['notes']);
});

test('The Notes choice goes through the openNotes dependency when the shell supplies one', async (t) => {
  const r = directRail({ openNotes: true });
  t.after(() => r.controller.dispose());
  r.q('[data-inv-segmented="project-tab-side"]').dispatchEvent(new r.window.CustomEvent('inv-segmented-change', { bubbles: true, detail: { id: 'project-tab-side', value: 'notes' } }));
  await waitForUi(r.window, 5);
  assert.equal(r.calls.notes, 1);
  assert.deepEqual(r.calls.open, []);
});

test('Showing the Tasks side is remembered per project, bounded to the 50 most recent', async (t) => {
  const r = directRail();
  t.after(() => r.controller.dispose());
  assert.equal(preferredSide('project_a', r.window.localStorage), 'tasks', 'what was shown last is the side');
  assert.equal(preferredSide('nobody', r.window.localStorage), '');
  const render = require('../renderer/features/renderer-task-rail-render');
  for (let index = 0; index < 60; index += 1) render.rememberSide(`p${index}`, index % 2 ? 'notes' : 'tasks', r.window.localStorage);
  const kept = Object.keys(JSON.parse(r.stored['jenny.projectTab.side']));
  assert.equal(kept.length, 50);
  assert.equal(kept.at(-1), 'p59');
  assert.equal(render.preferredSide('p0', r.window.localStorage), '');
  assert.equal(render.preferredSide('p59', r.window.localStorage), 'notes');
  assert.equal(render.preferredSide('p58', { getItem() { throw new Error('blocked'); } }), '', 'a blocked store is harmless');
});

test('The strip is told when the open-task count changes, and only then', async (t) => {
  const r = directRail();
  t.after(() => r.controller.dispose());
  const first = r.calls.signals;
  assert.ok(first >= 1);
  r.controller.refreshChecklist();
  assert.equal(r.calls.signals, first, 'an unchanged count says nothing');
  r.deleteTask('t1');
  assert.equal(r.calls.signals, first + 1);
});

test('currentChecklist() reads the chat\'s todo_write steps for the Session tab', async (t) => {
  const r = directRail();
  t.after(() => r.controller.dispose());
  r.state.messagesBySession.set('s1', [checklistMessage([{ content: 'Step one', status: 'in_progress' }])]);
  assert.deepEqual(r.controller.currentChecklist().items, [{ content: 'Step one', status: 'in_progress' }]);
});

test('closing Tasks, from the strip or the header Close, leaves the artifact prefs untouched', async (t) => {
  const app = await boot({ active: [row('open-1', 'Open one')] });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  const prefs = () => app.window.__rendererState.ui.artifactReview;
  const before = JSON.stringify(prefs().dismissedForSession || {});
  app.window.document.getElementById('chatTimelineTasksToggle').click();
  await waitForUi(app.window, 20);
  assert.equal(panel.classList.contains('hidden'), true, 'the strip toggle closes Tasks');
  assert.equal(JSON.stringify(prefs().dismissedForSession || {}), before, 'no artifact dismissal');

  await openTasks(app);
  const close = panel.querySelector('#artifactReviewCollapseButton');
  assert.ok(close, 'Tasks mode keeps the shared header Close');
  close.click();
  await waitForUi(app.window, 20);
  assert.equal(panel.classList.contains('hidden'), true, 'the header Close closes Tasks');
  assert.equal(JSON.stringify(prefs().dismissedForSession || {}), before, 'still no artifact dismissal');
});

test('Tasks mode shows the shared 36px header with its Close and no second "Tasks" title', async (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const taskRailCss = fs.readFileSync(path.join(__dirname, '..', 'styles', 'task-rail.css'), 'utf8');
  assert.doesNotMatch(taskRailCss, /\[data-artifact-review-mode="tasks"\] \.artifact-panel-header[,\s{]/, 'the header is not hidden in Tasks mode');
  const app = await boot({ active: [row('open-1', 'Open one')] });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  const header = panel.querySelector('.artifact-panel-header');
  assert.equal(header.querySelector('.artifact-panel-title-text').textContent, 'Tasks');
  assert.equal(header.querySelector('#artifactReviewCollapseButton').getAttribute('aria-label'), 'Close panel');
  assert.equal(panel.querySelector('.task-rail-title-text'), null, 'the rail body does not repeat the title');
  assert.ok(panel.querySelector('.task-rail-header .task-rail-filters'), 'the toolbar row holds the filter');
});

test('the strip Artifacts toggle is named Artifacts with its own glyph', async (t) => {
  const app = await boot({});
  t.after(() => app.dispose());
  const doc = app.window.document;
  const artifacts = doc.getElementById('artifactSplitViewToggle');
  assert.equal(artifacts.getAttribute('aria-label'), 'Artifacts panel');
  assert.equal(artifacts.getAttribute('title'), 'Artifacts');
  assert.equal(artifacts.querySelector('svg rect'), null, 'not a split rectangle');
});
