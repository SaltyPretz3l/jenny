'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function row(id, title, overrides = {}) {
  return {
    id: `followup:${id}`,
    followUpId: id,
    title,
    body: `${title} notes`,
    status: 'active',
    sessionId: 'origin-session',
    sessionTitle: 'Origin chat',
    sourceKind: 'agent_task',
    sourceBadge: 'Agent task',
    actions: [],
    isDue: false,
    timingLabel: '',
    ...overrides,
  };
}

function companionState(board = {}) {
  const active = board.active || [];
  const deferred = board.deferred || [];
  const recentResolved = board.recentResolved || [];
  const archived = board.archived || [];
  const toFollowUp = (entry, section) => ({
    id: entry.followUpId,
    label: entry.title,
    body: entry.body,
    status: section === 'active' ? 'active' : section === 'deferred' ? 'deferred' : 'resolved',
    sessionId: entry.sessionId,
    sourceKind: entry.sourceKind,
    sourceMeta: { sessionTitle: entry.sessionTitle },
    createdAt: '2026-03-19T10:00:00.000Z',
    updatedAt: '2026-03-19T11:00:00.000Z',
    deferredUntil: section === 'deferred' ? '2026-03-20T09:00:00.000Z' : '',
    deferPreset: section === 'deferred' ? 'tomorrow' : '',
    resolvedAt: section === 'recentResolved' || section === 'archived' ? '2026-03-19T11:30:00.000Z' : '',
    archivedAt: section === 'archived' ? '2026-03-19T11:45:00.000Z' : '',
  });
  return {
    loaded: true,
    followUps: [
      ...active.map((entry) => toFollowUp(entry, 'active')),
      ...deferred.map((entry) => toFollowUp(entry, 'deferred')),
      ...recentResolved.map((entry) => toFollowUp(entry, 'recentResolved')),
      ...archived.map((entry) => toFollowUp(entry, 'archived')),
    ],
    openLoopsBoard: {
      active,
      deferred,
      recentResolved,
      archived,
    },
  };
}

function bootOptions(board, overrides = {}) {
  return {
    windowInnerWidth: 1600,
    windowInnerHeight: 900,
    persistedActiveView: 'chat',
    shell: {
      companion: { state: companionState(board) },
      features: { state: { featureFlags: { tools_task_board_enabled: true, artifact_panel_v2: true, artifact_panel_v3: true } } },
    },
    ...overrides,
  };
}

function stubWorkspaceLayout(doc, width = 1600) {
  const workspace = doc.getElementById('workspace');
  workspace.getBoundingClientRect = () => ({ width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0 });
}

async function boot(board = {}, overrides = {}) {
  const app = await loadRendererApp(bootOptions(board, overrides));
  const { window } = app;
  stubWorkspaceLayout(window.document, Number(overrides.workspaceWidth || 1600));
  window.document.getElementById('newChatButton').click();
  await waitForUi(window, 30);
  return app;
}

async function openTasks(app) {
  const { window } = app;
  const toggle = window.document.getElementById('chatTimelineTasksToggle');
  assert.ok(toggle, 'task toggle should be installed after feature hydration');
  toggle.click();
  await waitForUi(window, 20);
  return window.document.getElementById('artifactReviewPanel');
}

test('toggle opens tasks mode with rail layout and narrow overlay behavior', async (t) => {
  const app = await boot({ active: [row('open-1', 'Open one')] });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  const toggle = app.window.document.getElementById('chatTimelineTasksToggle');
  assert.equal(panel.classList.contains('hidden'), false);
  assert.equal(panel.dataset.artifactReviewMode, 'tasks');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.match(app.window.document.getElementById('workspace').style.getPropertyValue('--artifact-review-width'), /^\d+px$/);

  const narrow = await boot({ active: [row('narrow', 'Narrow')] }, { workspaceWidth: 900 });
  t.after(() => narrow.dispose());
  const narrowPanel = await openTasks(narrow);
  assert.equal(narrowPanel.classList.contains('artifact-review-overlay'), true);
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
  const panel = await openTasks(app);
  assert.ok(panel.querySelector('[data-inv-checkbox][data-follow-up-id="agent-1"]'));
  assert.match(panel.textContent, /Agent task/);
  assert.match(panel.textContent, /from Origin chat/);
  assert.doesNotMatch(panel.textContent, /Manual row/);
  assert.match(panel.textContent, /Refreshes automatically when the model files a task\./);
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
  assert.match(panel.textContent, /Open task/);
  assert.doesNotMatch(panel.textContent, /Done task|Archived task/);
  panel.querySelector('.inv-segmented-option[data-value="done"]').click();
  await waitForUi(app.window, 10);
  assert.match(panel.textContent, /Done task/);
  assert.doesNotMatch(panel.textContent, /Open task|Archived task/);
  panel.querySelector('.inv-segmented-option[data-value="all"]').click();
  await waitForUi(app.window, 10);
  assert.match(panel.textContent, /Open task/);
  assert.match(panel.textContent, /Done task/);
  assert.match(panel.textContent, /Archived task/);
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
  panel.querySelector('[data-action="task-rail-start"]').click();
  assert.equal(calls[0].linkedTaskId, 'task-link');
  assert.match(calls[0].initialPrompt, /Jenny task id: task-link/);
  const busyButton = panel.querySelector('[data-action="task-rail-start"]');
  assert.equal(busyButton.disabled, true);
  busyButton.dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
  assert.equal(calls.length, 1);
  finishStart();
  await new Promise((resolve) => setImmediate(resolve));

  app.window.__rendererState.sessions.push({ id: 'linked-session', title: 'Linked', linked_task_id: 'task-link' });
  app.window.rendererTaskRailActions.open();
  await waitForUi(app.window, 10);
  assert.match(panel.textContent, /Open session/);
  assert.doesNotMatch(panel.textContent, /Start a session/);
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

test('overflow exposes task actions and delete invokes companion IPC', async (t) => {
  const app = await boot({ recentResolved: [row('menu-task', 'Menu task', { status: 'resolved' })] });
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  panel.querySelector('.inv-segmented-option[data-value="done"]').click();
  await waitForUi(app.window, 10);
  panel.querySelector('[data-action="task-rail-overflow"]').click();
  const menu = app.window.document.querySelector('.inv-context-menu');
  assert.match(menu.textContent, /Edit/);
  assert.match(menu.textContent, /Defer until tomorrow/);
  assert.match(menu.textContent, /Archive/);
  const deleteButton = Array.from(menu.querySelectorAll('.inv-context-menu-item'))
    .find((button) => button.textContent.includes('Delete'));
  deleteButton.click();
  await waitForUi(app.window, 30);
  assert.deepEqual(app.shell.__state.companionCalls.deleteFollowUp, ['menu-task']);
});

test('mutation refreshes rows and the count badge hides at zero', async (t) => {
  const app = await boot({});
  t.after(() => app.dispose());
  const panel = await openTasks(app);
  const count = app.window.document.querySelector('[data-task-count]');
  assert.equal(count.hidden, true);
  app.shell.__state.companionState = companionState({ active: [row('fresh', 'Fresh task')] });
  await app.window.rendererTaskBoard.notifyMutation();
  assert.match(panel.textContent, /Fresh task/);
  assert.equal(count.textContent, '1');
  assert.equal(count.hidden, false);
});
