const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { BackendService } = require('../services/backend/backend-service');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { backfillTaskBoardProjects } = require('../services/backend/task-board-project-backfill');
const { GENERAL_PROJECT_ID } = require('../services/projects/project-schema');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createService() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-task-board-backfill-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath });
  const commits = [];
  const commit = service._commitState.bind(service);
  service._commitState = (state, reason, details) => {
    commits.push(reason);
    return commit(state, reason, details);
  };
  return { service, commits };
}

function stampOf(service, id) {
  return service.getState().followUps.find((entry) => entry.id === id).projectId;
}

function recorder() {
  const entries = [];
  return { entries, logger: (level, event, details) => entries.push({ level, event, details }) };
}

test('backfill stamps live sessions, orphans and manual tasks, and leaves stamped rows alone', () => {
  const { service } = createService();
  service.upsertFollowUp({ id: 'live', label: 'Live', sourceKind: 'agent_task', sessionId: 'session-live' });
  service.upsertFollowUp({ id: 'orphan', label: 'Orphan', sourceKind: 'agent_task', sessionId: 'session-gone' });
  service.upsertFollowUp({ id: 'manual', label: 'Manual', sourceKind: 'agent_task', sessionId: '' });
  service.upsertFollowUp({
    id: 'stamped', label: 'Stamped', sourceKind: 'agent_task', sessionId: 'session-live', projectId: 'project_keep',
  });
  service.upsertFollowUp({ id: 'plain', label: 'Plain', sourceKind: 'assistant_reply', sessionId: 'session-live' });
  const sessionStore = {
    getSessionSummary: (id) => (id === 'session-live' ? { id, project_id: 'project_ascend' } : null),
  };
  const { entries, logger } = recorder();
  const updatedAt = service.getState().followUps.map((entry) => entry.updatedAt);

  const counts = backfillTaskBoardProjects({ configService: service, sessionStore, logger });

  assert.deepEqual(counts, { stamped: 3, from_session: 1, general: 2 });
  assert.equal(stampOf(service, 'live'), 'project_ascend');
  assert.equal(stampOf(service, 'orphan'), GENERAL_PROJECT_ID);
  assert.equal(stampOf(service, 'manual'), GENERAL_PROJECT_ID);
  assert.equal(stampOf(service, 'stamped'), 'project_keep');
  assert.equal(stampOf(service, 'plain'), '');
  assert.deepEqual(service.getState().followUps.map((entry) => entry.updatedAt), updatedAt);
  assert.deepEqual(entries, [{
    level: 'INFO',
    event: 'task_board.project_backfill',
    details: { stamped: 3, from_session: 1, general: 2 },
  }]);
});

test('a second backfill run stamps nothing, writes nothing and logs nothing', () => {
  const { service, commits } = createService();
  service.upsertFollowUp({ id: 'live', label: 'Live', sourceKind: 'agent_task', sessionId: 'session-live' });
  const sessionStore = { getSessionSummary: () => ({ project_id: 'project_ascend' }) };
  const { entries, logger } = recorder();
  backfillTaskBoardProjects({ configService: service, sessionStore, logger });
  commits.length = 0;
  entries.length = 0;

  const counts = backfillTaskBoardProjects({ configService: service, sessionStore, logger });

  assert.deepEqual(counts, { stamped: 0, from_session: 0, general: 0 });
  assert.deepEqual(commits, []);
  assert.deepEqual(entries, []);
});

test('an invalid project id on the session summary falls back to General', () => {
  const { service } = createService();
  service.upsertFollowUp({ id: 'live', label: 'Live', sourceKind: 'agent_task', sessionId: 'session-live' });
  const sessionStore = { getSessionSummary: () => ({ project_id: '../escape' }) };
  const counts = backfillTaskBoardProjects({ configService: service, sessionStore, logger: () => {} });
  assert.deepEqual(counts, { stamped: 1, from_session: 0, general: 1 });
  assert.equal(stampOf(service, 'live'), GENERAL_PROJECT_ID);
});

test('a throwing session store is caught, logged by message only, and returns zeros', () => {
  const { service, commits } = createService();
  service.upsertFollowUp({ id: 'live', label: 'Secret title', sourceKind: 'agent_task', sessionId: 'session-live' });
  commits.length = 0;
  const sessionStore = {
    getSessionSummary() {
      throw new Error('store exploded');
    },
  };
  const { entries, logger } = recorder();

  const counts = backfillTaskBoardProjects({ configService: service, sessionStore, logger });

  assert.deepEqual(counts, { stamped: 0, from_session: 0, general: 0 });
  assert.deepEqual(commits, []);
  assert.equal(stampOf(service, 'live'), '');
  assert.deepEqual(entries, [{
    level: 'WARN',
    event: 'task_board.project_backfill_failed',
    details: { error: 'store exploded' },
  }]);
});

test('missing arguments never throw', () => {
  assert.deepEqual(backfillTaskBoardProjects(), { stamped: 0, from_session: 0, general: 0 });
});

test('BackendService stamps unstamped agent tasks at construction and tolerates config stubs without the method', () => {
  const { service: configService } = createService();
  configService.upsertFollowUp({ id: 'manual', label: 'Manual', sourceKind: 'agent_task', sessionId: '' });
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-task-board-backfill-backend-'));
  trackDirectory(userDataPath);

  const backend = new BackendService({ userDataPath, safeStorage: createFakeSafeStorage(), configService });
  backend.dispose();
  assert.equal(stampOf(configService, 'manual'), GENERAL_PROJECT_ID);

  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-task-board-backfill-stub-'));
  trackDirectory(stubDir);
  const stub = new BackendService({
    userDataPath: stubDir,
    safeStorage: createFakeSafeStorage(),
    configService: { getState: () => ({ followUps: [] }) },
  });
  stub.dispose();
});
