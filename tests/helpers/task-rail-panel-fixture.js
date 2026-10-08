'use strict';

// Shared fixture for the Tasks rail panel tests (renderer-task-rail-panel.test.js and
// renderer-task-rail-scope-panel.test.js): board rows, companion state, boot options,
// the workspace layout stub and the project-id carry-through the harness stub drops.

const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./renderer-shell-harness');

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
    // The harness chat has no project_id, so it belongs to General.
    projectId: 'project_general',
    ...overrides,
  };
}

// The shell harness stub rebuilds the board from follow-ups and drops
// projectId, so remember each task's project here and re-stamp it on every
// board the stub hands the renderer (see carryProjectIds).
const PROJECT_BY_TASK = new Map();
const BOARD_SECTIONS = ['active', 'deferred', 'recentResolved', 'archived'];

function stampProjects(payload) {
  for (const section of BOARD_SECTIONS) {
    for (const entry of payload?.openLoopsBoard?.[section] || []) {
      if (PROJECT_BY_TASK.has(entry.followUpId)) entry.projectId = PROJECT_BY_TASK.get(entry.followUpId);
    }
  }
  return payload;
}

function carryProjectIds(app) {
  const companion = app.window.jennyShell.companion;
  for (const name of Object.keys(companion)) {
    const original = companion[name];
    if (typeof original !== 'function') continue;
    companion[name] = async (...args) => stampProjects(await original.apply(companion, args));
  }
  stampProjects(app.window.__rendererState.companion);
}

function companionState(board = {}) {
  const active = board.active || [];
  const deferred = board.deferred || [];
  const recentResolved = board.recentResolved || [];
  const archived = board.archived || [];
  for (const entry of [...active, ...deferred, ...recentResolved, ...archived]) {
    PROJECT_BY_TASK.set(entry.followUpId, entry.projectId || '');
  }
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
      features: { state: { featureFlags: { tools_task_board_enabled: true } } },
    },
    ...overrides,
  };
}

function stubWorkspaceLayout(doc, width = 1600) {
  const workspace = doc.getElementById('workspace');
  workspace.getBoundingClientRect = () => ({ width, height: 900, top: 0, left: 0, right: width, bottom: 900, x: 0, y: 0 });
}

// Pass the node:test context as `t` to have the app disposed with the test.
async function boot(board, overrides, t) {
  const options = overrides || {};
  const app = await loadRendererApp(bootOptions(board || {}, options));
  if (t) t.after(() => app.dispose());
  const { window } = app;
  stubWorkspaceLayout(window.document, Number(options.workspaceWidth || 1600));
  carryProjectIds(app);
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

function checklistMessage(items, timestamp = '2026-09-21T10:00:00.000Z') {
  return {
    kind: 'tool_result',
    timestamp,
    tool_result: {
      tool_name: 'todo_write',
      output_text: JSON.stringify({ count: items.length, todos: items }),
      is_error: false,
      error_code: '',
    },
  };
}

function setSessionChecklist(app, sessionId, items, timestamp) {
  app.window.__rendererState.messagesBySession.set(sessionId, [checklistMessage(items, timestamp)]);
}

function menuItem(app, label) {
  return Array.from(app.window.document.querySelectorAll('.inv-context-menu-item'))
    .find((button) => button.textContent.includes(label));
}

module.exports = {
  loadRendererApp,
  waitForUi,
  boot,
  openTasks,
  row,
  PROJECT_BY_TASK,
  BOARD_SECTIONS,
  stampProjects,
  carryProjectIds,
  companionState,
  bootOptions,
  stubWorkspaceLayout,
  checklistMessage,
  setSessionChecklist,
  menuItem,
};
