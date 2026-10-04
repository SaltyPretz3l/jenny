const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchedulerService,
  readScheduledTasksFile,
} = require('../services/scheduler-service');
const { dispatchAutomationTask } = require('../services/scheduler-automation-runtime');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');
const {
  FakeConfigService,
  createAutomationTask,
  createBackendStub,
  writeTasks,
} = require('./helpers/scheduler-automation-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('HOM-11 chat deferral retains the due occurrence until chat ends', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-home-defer-'));
  trackDirectory(userDataPath);
  const tasksPath = path.join(userDataPath, 'scheduled_tasks.json');
  const task = createAutomationTask();
  writeTasks(tasksPath, [task]);
  let calls = 0;
  const backend = createBackendStub({ onBackgroundRun: async () => { calls += 1; return { status: 'completed' }; } });
  backend.activeStreams.set('chat', {});
  const scheduler = new SchedulerService({ userDataPath, configService: new FakeConfigService(), backendService: backend });
  await scheduler._runScheduledTask(tasksPath, task);
  const deferred = readScheduledTasksFile(tasksPath).tasks[0];
  assert.equal(scheduler._isTaskDue(deferred), true);
  assert.equal(deferred.automation_runs.length, 0);
  backend.activeStreams.clear();
  await scheduler._runScheduledTask(tasksPath, deferred);
  assert.equal(calls, 1);
});

test('HOM-12 automation requires durable admission and revalidates the locked task', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-home-admit-'));
  trackDirectory(userDataPath);
  const tasksPath = path.join(userDataPath, 'scheduled_tasks.json');
  const task = createAutomationTask();
  let calls = 0;
  const backend = createBackendStub({ onBackgroundRun: async () => { calls += 1; return { status: 'completed' }; } });
  const scheduler = new SchedulerService({ userDataPath, configService: new FakeConfigService(), backendService: backend });
  writeTasks(tasksPath, [task]);
  const acquire = scheduler._acquireLock.bind(scheduler);
  scheduler._acquireLock = async () => false;
  await dispatchAutomationTask(scheduler, tasksPath, task);
  assert.equal(calls, 0, 'lock timeout must not dispatch');
  scheduler._acquireLock = acquire;
  for (const current of [[], [{ ...task, enabled: false }], [{ ...task, last_result_at: new Date().toISOString() }]]) {
    writeTasks(tasksPath, current);
    await dispatchAutomationTask(scheduler, tasksPath, task);
    assert.equal(calls, 0, 'stale task must not dispatch');
  }
  writeTasks(tasksPath, [{ ...task, input: { ...task.input, task_spec: 'Changed task' } }]);
  await dispatchAutomationTask(scheduler, tasksPath, task);
  assert.equal(calls, 0, 'changed task must not dispatch an old snapshot');
  fs.writeFileSync(tasksPath, JSON.stringify({ version: 999, tasks: [task] }));
  await dispatchAutomationTask(scheduler, tasksPath, task);
  assert.equal(calls, 0, 'newer schema must not dispatch');
  writeTasks(tasksPath, [task]);
  const admittedTask = readScheduledTasksFile(tasksPath).tasks[0];
  scheduler._acquireLock = async (...args) => {
    writeTasks(tasksPath, [{ ...task, enabled: false }]);
    return acquire(...args);
  };
  await dispatchAutomationTask(scheduler, tasksPath, admittedTask);
  assert.equal(calls, 0, 'disable during lock acquisition must prevent dispatch');
});
