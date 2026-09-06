const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchedulerService,
  readScheduledTasksFile,
  readScheduledTasksFileAsync,
  resolveBackgroundRuntimeRoot,
  resolveScheduledTasksPath,
  writeScheduledTasksFile,
} = require('../services/scheduler-service');
const {
  SCHEDULED_TASKS_SCHEMA_VERSION,
} = require('../services/scheduler-schema-version');
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

test('scheduler reads scheduled tasks asynchronously when an async fs implementation is available', async () => {
  const calls = [];
  const payload = {
    version: SCHEDULED_TASKS_SCHEMA_VERSION,
    tasks: [
      createAutomationTask({
        id: 'automation:async_read',
        task: 'async_read',
      }),
    ],
  };
  const fsImpl = {
    promises: {
      async readFile(tasksPath, encoding) {
        calls.push({ tasksPath, encoding });
        return JSON.stringify(payload);
      },
    },
    readFileSync() {
      throw new Error('sync read should not be used');
    },
  };

  const result = await readScheduledTasksFileAsync('C:/tmp/scheduled_tasks.json', {
    fsImpl,
    nowProvider: () => new Date('2026-05-08T12:00:00.000Z'),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].encoding, 'utf8');
  assert.equal(result.version, SCHEDULED_TASKS_SCHEMA_VERSION);
  assert.equal(result.tasks[0].id, 'automation:async_read');
});

test('scheduler drops retired v2 planner records during normalization', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-v2-trigger-'));
  trackDirectory(userDataPath);
  const tasksPath = path.join(userDataPath, 'scheduled_tasks.json');
  fs.writeFileSync(tasksPath, JSON.stringify({
    version: 2,
    tasks: [
      {
        id: 'builtin:sub_agent_planner',
        task: 'sub_agent_planner',
        kind: 'sub_agent',
        enabled: true,
        trigger: { type: 'interval', interval_seconds: 300 },
      },
    ],
  }, null, 2));

  const payload = readScheduledTasksFile(tasksPath, {
    nowProvider: () => new Date('2026-05-08T12:00:00.000Z'),
  });
  assert.equal(payload.tasks.some((entry) => entry.id === 'builtin:sub_agent_planner'), false);
});

test('scheduler drops retired v2 planner records even when their trigger is malformed', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-v2-trigger-fraction-'));
  trackDirectory(userDataPath);
  const tasksPath = path.join(userDataPath, 'scheduled_tasks.json');
  fs.writeFileSync(tasksPath, JSON.stringify({
    version: 2,
    tasks: [
      {
        id: 'builtin:sub_agent_planner',
        task: 'sub_agent_planner',
        kind: 'sub_agent',
        enabled: true,
        trigger: { type: 'interval', interval_seconds: 0.5 },
      },
    ],
  }, null, 2));

  const payload = readScheduledTasksFile(tasksPath, {
    nowProvider: () => new Date('2026-05-08T12:00:00.000Z'),
  });
  assert.equal(payload.tasks.some((entry) => entry.id === 'builtin:sub_agent_planner'), false);
});

test('scheduler result persistence does not resurrect retired background tasks', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-result-cadence-'));
  trackDirectory(userDataPath);
  const configService = new FakeConfigService('');
  let now = new Date('2026-05-08T12:00:00.000Z');
  const scheduler = new SchedulerService({
    userDataPath,
    configService,
    backendService: createBackendStub(),
    nowProvider: () => new Date(now),
  });
  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot: '',
    userDataPath,
    backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
  });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify({
    version: 2,
    tasks: [
      {
        id: 'builtin:sub_agent_planner',
        task: 'sub_agent_planner',
        kind: 'sub_agent',
        enabled: true,
        trigger: { type: 'interval', interval_seconds: 60 },
      },
      {
        id: 'builtin:sub_agent_verification',
        task: 'sub_agent_verification',
        kind: 'sub_agent',
        enabled: true,
        trigger: { type: 'interval', interval_seconds: 60 },
      },
    ],
  }, null, 2));

  await scheduler._recordTaskResult(tasksPath, {
    status: 'failed',
    task: 'sub_agent_planner',
    reason: 'spawn_failed',
  }, 'builtin:sub_agent_planner');
  await scheduler._recordTaskResult(tasksPath, {
    status: 'skipped',
    task: 'sub_agent_verification',
    reason: 'feature_disabled',
  }, 'builtin:sub_agent_verification');

  const persisted = readScheduledTasksFile(tasksPath, { nowProvider: () => new Date(now) });
  assert.deepEqual(persisted.tasks, []);
});

test('scheduler records automation outcomes into bounded run history', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-result-'));
  trackDirectory(userDataPath);
  const configService = new FakeConfigService('');
  let now = new Date('2026-05-19T10:00:00.000Z');
  const scheduler = new SchedulerService({
    userDataPath,
    configService,
    backendService: createBackendStub(),
    nowProvider: () => new Date(now),
  });
  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot: '',
    userDataPath,
    backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
  });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify({
    version: SCHEDULED_TASKS_SCHEMA_VERSION,
    tasks: [
      createAutomationTask({
        automation_runs: [
          {
            run_id: 'run_existing',
            status: 'completed',
            started_at: '2026-05-18T10:00:00.000Z',
            completed_at: '2026-05-18T10:00:05.000Z',
            summary: 'Previous result.',
          },
        ],
      }),
    ],
  }, null, 2));

  await scheduler._recordTaskResult(tasksPath, {
    run_id: 'run_started',
    status: 'started',
    task: 'project_health',
    reason: 'scheduled',
    started_at: '2026-05-19T10:00:00.000Z',
    summary: 'Run started.',
  }, 'automation:project_health');
  now = new Date('2026-05-19T10:00:07.000Z');
  await scheduler._recordTaskResult(tasksPath, {
    run_id: 'run_completed',
    status: 'completed',
    task: 'project_health',
    reason: 'ok',
    started_at: '2026-05-19T10:00:00.000Z',
    completed_at: '2026-05-19T10:00:07.000Z',
    summary: 'x'.repeat(2_100),
    budget: { runtime_ms: 7_000, tool_calls: 3 },
    artifacts: [
      { artifact_id: 'artifact_project_health', kind: 'report', title: 'Project Health' },
    ],
  }, 'automation:project_health');

  const persisted = readScheduledTasksFile(tasksPath, { nowProvider: () => new Date(now) });
  const task = persisted.tasks.find((entry) => entry.id === 'automation:project_health');

  assert.ok(task);
  assert.equal(task.last_status, 'completed');
  assert.equal(task.last_reason, 'ok');
  assert.equal(task.last_completed_at, '2026-05-19T10:00:07.000Z');
  assert.equal(task.automation_runs.length, 2);
  assert.equal(task.automation_runs[0].run_id, 'run_started');
  assert.equal(task.automation_runs[0].status, 'started');
  assert.equal(task.automation_runs[1].run_id, 'run_completed');
  assert.equal(task.automation_runs[1].summary.length, 2_000);
  assert.deepEqual(task.automation_runs[1].budget, {
    runtime_ms: 7000,
    tool_calls: 3,
  });
  assert.deepEqual(task.automation_runs[1].artifacts, [
    { artifact_id: 'artifact_project_health', kind: 'report', title: 'Project Health' },
  ]);
});

test('scheduler preserves newer scheduled task files and blocks writes', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-future-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-future-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const logs = [];
  const now = new Date('2026-04-01T12:00:00.000Z');
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backendService: createBackendStub({
      phase: 'starting',
    }),
    logger: (level, event, details) => logs.push({ level, event, details }),
    nowProvider: () => new Date(now),
  });

  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot,
    userDataPath,
    backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
  });
  const futurePayload = {
    version: 99,
    tasks: [
      {
        id: 'future:unknown_task',
        task: 'unknown_task',
        enabled: true,
        futureField: 'keep',
      },
    ],
    futureOnly: {
      keep: true,
    },
  };
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify(futurePayload, null, 2), 'utf8');

  await scheduler._ensureTaskFile(tasksPath);
  await scheduler._recordTaskResult(tasksPath, {
    status: 'started',
    reason: 'should_not_write',
  });
  await scheduler._ensureTaskFile(tasksPath);

  assert.deepEqual(JSON.parse(fs.readFileSync(tasksPath, 'utf8')), futurePayload);
  const detectedLogs = logs.filter((entry) =>
    entry.level === 'WARN'
    && entry.event === 'scheduler.tasks_newer_schema_detected'
    && entry.details?.observedVersion === 99
  );
  const writeBlockedLogs = logs.filter((entry) =>
    entry.level === 'WARN'
    && entry.event === 'scheduler.tasks_newer_schema_write_blocked'
    && entry.details?.observedVersion === 99
  );
  assert.equal(detectedLogs.length, 1);
  assert.equal(writeBlockedLogs.length, 1);
});

test('writeScheduledTasksFile uses unique temp files even within the same millisecond', () => {
  const tempPaths = [];
  const fsImpl = {
    mkdirSync() {},
    writeFileSync(targetPath) {
      tempPaths.push(String(targetPath));
    },
    renameSync() {},
    unlinkSync() {},
  };
  const originalNow = Date.now;
  Date.now = () => 1_700_000_000_000;

  try {
    writeScheduledTasksFile('C:\\tasks\\scheduled_tasks.json', { version: 1, tasks: [] }, { fsImpl });
    writeScheduledTasksFile('C:\\tasks\\scheduled_tasks.json', { version: 1, tasks: [] }, { fsImpl });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(tempPaths.length, 2);
  assert.notEqual(tempPaths[0], tempPaths[1]);
});

test('writeScheduledTasksFile cleans up temp files when rename fails', () => {
  const unlinked = [];
  let writtenTempPath = '';
  const fsImpl = {
    mkdirSync() {},
    writeFileSync(targetPath) {
      writtenTempPath = String(targetPath);
    },
    renameSync() {
      throw new Error('rename failed');
    },
    unlinkSync(targetPath) {
      unlinked.push(String(targetPath));
    },
  };

  assert.throws(
    () => writeScheduledTasksFile('C:\\tasks\\scheduled_tasks.json', { version: 1, tasks: [] }, { fsImpl }),
    /rename failed/
  );
  assert.deepEqual(unlinked, [writtenTempPath]);
});
