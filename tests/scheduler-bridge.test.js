const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSchedulerSnapshot, formatEta } = require('../services/scheduler-snapshot');
const {
  SchedulerService,
  resolveBackgroundRuntimeRoot,
  resolveScheduledTasksPath,
} = require('../services/scheduler-service');
const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const {
  FakeConfigService,
  createAutomationTask,
  createBackendStub,
} = require('./helpers/scheduler-service-harness');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const NOW = new Date('2026-06-10T12:00:00.000Z');

test('buildSchedulerSnapshot derives sorted upcoming items with eta labels', () => {
  const snapshot = buildSchedulerSnapshot([
    createAutomationTask({
      id: 'automation:project_health',
      task: 'project_health',
      last_result_at: new Date(NOW.getTime() - 23.5 * 3600 * 1000).toISOString(),
    }),
    createAutomationTask({
      id: 'automation:never_ran',
      task: 'never_ran',
    }),
    createAutomationTask({
      id: 'automation:disabled',
      task: 'disabled_task',
      enabled: false,
    }),
    // Sub-minute interval = continuous runtime machinery, excluded from upcoming.
    createAutomationTask({
      id: 'automation:continuous',
      task: 'continuous',
      trigger: { type: 'interval', interval_seconds: 1 },
    }),
  ], NOW);

  assert.deepEqual(snapshot.upcoming.map((item) => item.id), [
    'automation:never_ran',
    'automation:project_health',
  ]);
  assert.equal(snapshot.upcoming[0].eta, 'due');
  assert.equal(snapshot.upcoming[1].eta, 'in 30m');
  assert.equal(snapshot.upcoming[1].label, 'project health');
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.generatedAt, NOW.toISOString());
});

test('buildSchedulerSnapshot reports active automation runs as running', () => {
  const snapshot = buildSchedulerSnapshot([
    createAutomationTask({
      id: 'automation:active',
      task: 'active_run',
      last_started_at: NOW.toISOString(),
      automation_runs: [{ run_id: 'run_1', status: 'running', started_at: NOW.toISOString() }],
    }),
    createAutomationTask({
      id: 'automation:settled',
      task: 'settled_run',
      automation_runs: [{ run_id: 'run_0', status: 'completed', completed_at: NOW.toISOString() }],
    }),
  ], NOW);

  assert.deepEqual(snapshot.running.map((item) => item.id), [
    'automation:active',
  ]);
  assert.equal(snapshot.running[0].label, 'active run');
  // The settled automation falls through to upcoming, not running.
  assert.deepEqual(snapshot.upcoming.map((item) => item.id), ['automation:settled']);
});

test('formatEta buckets minutes, hours, and days', () => {
  const nowMs = NOW.getTime();
  assert.equal(formatEta(nowMs - 1, nowMs), 'due');
  assert.equal(formatEta(nowMs + 20_000, nowMs), 'in <1m');
  assert.equal(formatEta(nowMs + 5 * 60_000, nowMs), 'in 5m');
  assert.equal(formatEta(nowMs + 90 * 60_000, nowMs), 'in 1h 30m');
  assert.equal(formatEta(nowMs + 2 * 3600_000, nowMs), 'in 2h');
  assert.equal(formatEta(nowMs + 3 * 86_400_000, nowMs), 'in 3d');
});

function createSchedulerFixture() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-bridge-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-bridge-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backendService: createBackendStub(),
    logger: () => {},
    nowProvider: () => new Date(NOW),
  });
  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot,
    userDataPath,
    backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
  });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify({
    version: 2,
    tasks: [createAutomationTask()],
  }, null, 2));
  return { scheduler, tasksPath };
}

test('scheduler getStateSnapshot derives relevance from enabled durable tasks', () => {
  const enabled = createSchedulerFixture();
  const snapshot = enabled.scheduler.getStateSnapshot();
  assert.equal(snapshot.upcoming.length, 1);
  assert.equal(snapshot.upcoming[0].id, 'automation:project_health');
  assert.equal(snapshot.upcoming[0].eta, 'due');

});

test('scheduler emits changed after a tick and dedupes identical snapshots', async () => {
  const { scheduler } = createSchedulerFixture();
  const emitted = [];
  scheduler.on('changed', (snapshot) => emitted.push(snapshot));
  scheduler._initialized = true;
  scheduler.started = true;

  await scheduler.runTick('startup');
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].upcoming[0].id, 'automation:project_health');

  await scheduler.runTick('poll');
  assert.equal(emitted.length, 1);

  scheduler.stop();
});

test('scheduler.getState IPC handler returns the snapshot or a safe fallback', () => {
  const handlers = new Map();
  const ipcMainLike = {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
  };
  registerAuxiliaryIpcHandlers({ ipcMainLike });
  const fallback = handlers.get('scheduler:get-state')();
  assert.deepEqual(fallback, {
    upcoming: [], running: [], generatedAt: '', relevant: false,
    lifecycle: { phase: 'unavailable', relevant: false, qualifyingTaskCount: 0, reason: 'service_unavailable', error: '', updatedAt: '' },
  });

  const wired = new Map();
  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, fn) {
        wired.set(channel, fn);
      },
    },
    schedulerService: {
      getStateSnapshot: () => buildSchedulerSnapshot([createAutomationTask()], NOW),
    },
  });
  const snapshot = wired.get('scheduler:get-state')();
  assert.equal(snapshot.upcoming[0].id, 'automation:project_health');
});

test('scheduler retries watcher installation after transient creation and runtime failures', () => {
  let watchCalls = 0;
  const watchers = [];
  const scheduler = new SchedulerService({
    userDataPath: 'X:/user-data',
    configService: { getState: () => ({}), on() {} },
    backendService: {},
    fsImpl: { mkdirSync() {} },
    watchImpl() {
      watchCalls += 1;
      if (watchCalls === 1) {
        throw Object.assign(new Error('transient'), { code: 'EMFILE' });
      }
      const watcher = {
        closed: false,
        handlers: {},
        close() { this.closed = true; },
        unref() {},
        on(event, handler) { this.handlers[event] = handler; },
      };
      watchers.push(watcher);
      return watcher;
    },
  });

  scheduler._reconcileScheduledTasksLocation();
  assert.equal(scheduler._watcherNeedsRebuild, true);
  scheduler._reconcileScheduledTasksLocation();
  assert.equal(watchCalls, 2);

  watchers[0].handlers.error(new Error('watch lost'));
  assert.equal(watchers[0].closed, true);
  assert.equal(scheduler._watcher, null);
  assert.equal(scheduler._watcherNeedsRebuild, true);

  scheduler._reconcileScheduledTasksLocation();
  assert.equal(watchCalls, 3);
  assert.equal(scheduler._watcher, watchers[1]);
});
