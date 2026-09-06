const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  SchedulerService,
  readScheduledTasksFile,
  resolveBackgroundRuntimeRoot,
  resolveScheduledTasksPath,
} = require('../services/scheduler-service');
const {
  SCHEDULED_TASKS_SCHEMA_VERSION,
} = require('../services/scheduler-schema-version');
const {
  buildAutomationRunId,
  resolveAutomationRunResultPath,
} = require('../services/scheduler-automation-runtime');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

class FakeConfigService extends EventEmitter {
  constructor(workspaceRoot = '') {
    super();
    this._state = { toolsWorkspaceRoot: workspaceRoot };
  }

  getState() {
    return { ...this._state };
  }
}

function createAutomationTask(overrides = {}) {
  return {
    id: 'automation:project_health',
    task: 'project_health',
    kind: 'automation',
    enabled: true,
    trigger: { type: 'interval', interval_seconds: 86_400 },
    policy: {
      requires_feature_flags: ['tools_automations_enabled'],
      defer_when_chat_active: true,
    },
    input: {
      task_spec: 'Run the read-only project health check.',
      tool_grants: ['filesystem', 'git'],
      isolation: { mode: 'read_only' },
    },
    retention: { max_runs: 2, max_log_bytes: 8_000 },
    automation_runs: [],
    ...overrides,
  };
}

function createBackendStub({ onBackgroundRun }) {
  return {
    featureFlags: {
      tools_automations_enabled: true,
    },
    activeStreams: new Map(),
    getBackendStatus() {
      return { phase: 'ready' };
    },
    getSessionSummariesForScheduler() {
      return [];
    },
    async runBackgroundTask(task, params) {
      return onBackgroundRun(task, params);
    },
  };
}

function writeTasks(tasksPath, tasks) {
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify({
    version: SCHEDULED_TASKS_SCHEMA_VERSION,
    tasks,
  }, null, 2));
}

test('scheduler dispatches due automations through the guarded automation runner', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-dispatch-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-dispatch-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const now = new Date('2026-05-19T11:00:00.000Z');
  const calls = [];
  const backgroundRuntimeRoot = resolveBackgroundRuntimeRoot(userDataPath);
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backgroundRuntimeRoot,
    backendService: createBackendStub({
      onBackgroundRun: async (task, params) => {
        calls.push({ task, params });
        return {
          status: 'started',
          task,
          run_id: params.run_id,
          started_at: params.started_at,
          result_ref: params.result_ref,
          budget: { runtime_ms: params.automation.runtime_budget_ms, tool_calls: 0 },
        };
      },
    }),
    nowProvider: () => new Date(now),
    pollIntervalMs: 60_000,
    watchDebounceMs: 10,
  });
  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot,
    userDataPath,
    backgroundRuntimeRoot,
  });
  writeTasks(tasksPath, [
    createAutomationTask({
      last_status: '',
      last_reason: '',
      last_started_at: '',
      last_result_at: '',
      last_completed_at: '',
      updated_at: now.toISOString(),
    }),
  ]);

  try {
    await scheduler.start();

    const persisted = readScheduledTasksFile(tasksPath);
    const task = persisted.tasks.find((entry) => entry.id === 'automation:project_health');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, 'automation_run');
    assert.equal(calls[0].params.task_id, 'automation:project_health');
    assert.equal(calls[0].params.run_id, buildAutomationRunId({
      taskId: 'automation:project_health',
      startedAt: now.toISOString(),
    }));
    assert.equal(calls[0].params.started_at, now.toISOString());
    assert.equal(calls[0].params.result_path, resolveAutomationRunResultPath({
      backgroundRuntimeRoot,
      automationId: 'automation:project_health',
      runId: calls[0].params.run_id,
    }));
    assert.equal(
      calls[0].params.result_ref,
      `automation_project_health/${calls[0].params.run_id}.result.json`
    );
    assert.deepEqual(calls[0].params.automation, {
      version: 1,
      run_id: calls[0].params.run_id,
      automation_id: 'automation:project_health',
      task: 'project_health',
      task_spec: 'Run the read-only project health check.',
      tool_grants: ['filesystem', 'git'],
      isolation: { mode: 'read_only' },
      workspace_root: workspaceRoot,
      started_at: now.toISOString(),
      runtime_budget_ms: 300000,
      result_ref: `automation_project_health/${calls[0].params.run_id}.result.json`,
    });
    assert.ok(task);
    assert.equal(task.last_status, 'started');
    assert.equal(task.last_reason, 'scheduled');
    assert.equal(task.automation_runs.length, 1);
    assert.equal(task.automation_runs[0].run_id, calls[0].params.run_id);
    assert.equal(task.automation_runs[0].status, 'started');
    assert.equal(task.automation_runs[0].reason, 'scheduled');
    assert.equal(task.automation_runs[0].result_ref, calls[0].params.result_ref);
  } finally {
    scheduler.stop();
  }
});

test('scheduler reconciles automation result files before launching another run', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-reconcile-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-reconcile-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const backgroundRuntimeRoot = resolveBackgroundRuntimeRoot(userDataPath);
  const startedAt = '2026-05-19T11:00:00.000Z';
  const now = new Date('2026-05-19T11:05:00.000Z');
  const runId = buildAutomationRunId({
    taskId: 'automation:project_health',
    startedAt,
  });
  const resultPath = resolveAutomationRunResultPath({
    backgroundRuntimeRoot,
    automationId: 'automation:project_health',
    runId,
  });
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify({
    version: 1,
    run_id: runId,
    automation_id: 'automation:project_health',
    status: 'completed',
    reason: 'ok',
    started_at: startedAt,
    completed_at: now.toISOString(),
    summary: 'Project health completed.',
    budget: { runtime_ms: 1000, tool_calls: 2 },
    artifacts: [{ artifact_id: 'artifact_health', kind: 'report', title: 'Health' }],
  }, null, 2));

  const calls = [];
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backgroundRuntimeRoot,
    backendService: createBackendStub({
      onBackgroundRun: async (task, params) => {
        calls.push({ task, params });
        return { status: 'started', task };
      },
    }),
    nowProvider: () => new Date(now),
    pollIntervalMs: 60_000,
    watchDebounceMs: 10,
  });
  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot,
    userDataPath,
    backgroundRuntimeRoot,
  });
  writeTasks(tasksPath, [
    createAutomationTask({
      trigger: { type: 'interval', interval_seconds: 1 },
      last_status: 'started',
      last_reason: 'scheduled',
      last_started_at: startedAt,
      last_result_at: startedAt,
      automation_runs: [
        {
          run_id: runId,
          status: 'started',
          reason: 'scheduled',
          started_at: startedAt,
          budget: { runtime_ms: 300000, tool_calls: 0 },
          result_ref: `automation_project_health/${runId}.result.json`,
        },
      ],
    }),
  ]);

  try {
    await scheduler.start();

    const persisted = readScheduledTasksFile(tasksPath);
    const task = persisted.tasks.find((entry) => entry.id === 'automation:project_health');
    assert.deepEqual(calls, []);
    assert.ok(task);
    assert.equal(task.last_status, 'completed');
    assert.equal(task.last_reason, 'ok');
    assert.equal(task.automation_runs.length, 1);
    assert.equal(task.automation_runs[0].run_id, runId);
    assert.equal(task.automation_runs[0].status, 'completed');
    assert.equal(task.automation_runs[0].summary, 'Project health completed.');
    assert.deepEqual(task.automation_runs[0].budget, { runtime_ms: 1000, tool_calls: 2 });
  } finally {
    scheduler.stop();
  }
});

test('scheduler does not dispatch a second automation while an active run is within budget', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-active-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-active-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const backgroundRuntimeRoot = resolveBackgroundRuntimeRoot(userDataPath);
  const startedAt = '2026-05-19T11:00:00.000Z';
  const now = new Date('2026-05-19T11:00:02.000Z');
  const runId = buildAutomationRunId({
    taskId: 'automation:project_health',
    startedAt,
  });
  const calls = [];
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backgroundRuntimeRoot,
    backendService: createBackendStub({
      onBackgroundRun: async (task, params) => {
        calls.push({ task, params });
        return { status: 'started', task };
      },
    }),
    nowProvider: () => new Date(now),
    pollIntervalMs: 60_000,
    watchDebounceMs: 10,
  });
  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot,
    userDataPath,
    backgroundRuntimeRoot,
  });
  writeTasks(tasksPath, [
    createAutomationTask({
      trigger: { type: 'interval', interval_seconds: 1 },
      last_status: 'started',
      last_reason: 'scheduled',
      last_started_at: startedAt,
      last_result_at: startedAt,
      automation_runs: [
        {
          run_id: runId,
          status: 'started',
          reason: 'scheduled',
          started_at: startedAt,
          budget: { runtime_ms: 300000, tool_calls: 0 },
          result_ref: `automation_project_health/${runId}.result.json`,
        },
      ],
    }),
  ]);

  try {
    await scheduler.start();

    const persisted = readScheduledTasksFile(tasksPath);
    const task = persisted.tasks.find((entry) => entry.id === 'automation:project_health');
    assert.deepEqual(calls, []);
    assert.ok(task);
    assert.equal(task.last_status, 'started');
    assert.equal(task.last_reason, 'scheduled');
    assert.equal(task.automation_runs.length, 1);
    assert.equal(task.automation_runs[0].run_id, runId);
    assert.equal(task.automation_runs[0].status, 'started');
  } finally {
    scheduler.stop();
  }
});

test('scheduler fails active automation runs with mismatched result files', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-invalid-result-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-invalid-result-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const backgroundRuntimeRoot = resolveBackgroundRuntimeRoot(userDataPath);
  const startedAt = '2026-05-19T11:00:00.000Z';
  const now = new Date('2026-05-19T11:00:02.000Z');
  const runId = buildAutomationRunId({
    taskId: 'automation:project_health',
    startedAt,
  });
  const resultPath = resolveAutomationRunResultPath({
    backgroundRuntimeRoot,
    automationId: 'automation:project_health',
    runId,
  });
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify({
    version: 1,
    run_id: 'run_wrong',
    automation_id: 'automation:project_health',
    status: 'completed',
    reason: 'ok',
    started_at: startedAt,
    completed_at: now.toISOString(),
    summary: 'Wrong run should not be trusted.',
  }, null, 2));

  const logs = [];
  const calls = [];
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backgroundRuntimeRoot,
    backendService: createBackendStub({
      onBackgroundRun: async (task, params) => {
        calls.push({ task, params });
        return { status: 'started', task };
      },
    }),
    logger(level, event, data) {
      logs.push({ level, event, data });
    },
    nowProvider: () => new Date(now),
    pollIntervalMs: 60_000,
    watchDebounceMs: 10,
  });
  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot,
    userDataPath,
    backgroundRuntimeRoot,
  });
  writeTasks(tasksPath, [
    createAutomationTask({
      trigger: { type: 'interval', interval_seconds: 1 },
      last_status: 'started',
      last_reason: 'scheduled',
      last_started_at: startedAt,
      last_result_at: startedAt,
      automation_runs: [
        {
          run_id: runId,
          status: 'started',
          reason: 'scheduled',
          started_at: startedAt,
          budget: { runtime_ms: 300000, tool_calls: 0 },
          result_ref: `automation_project_health/${runId}.result.json`,
        },
      ],
    }),
  ]);

  try {
    await scheduler.start();

    const persisted = readScheduledTasksFile(tasksPath);
    const task = persisted.tasks.find((entry) => entry.id === 'automation:project_health');
    assert.deepEqual(calls, []);
    assert.ok(task);
    assert.equal(task.last_status, 'failed');
    assert.equal(task.last_reason, 'invalid_result');
    assert.equal(task.automation_runs.length, 1);
    assert.equal(task.automation_runs[0].run_id, runId);
    assert.equal(task.automation_runs[0].status, 'failed');
    assert.equal(task.automation_runs[0].reason, 'invalid_result');
    assert.ok(logs.some((entry) => entry.event === 'scheduler.automation_result_invalid'));
  } finally {
    scheduler.stop();
  }
});

test('scheduler bounds untrusted automation result file timing and budget fields', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-result-bounds-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-result-bounds-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const backgroundRuntimeRoot = resolveBackgroundRuntimeRoot(userDataPath);
  const startedAt = '2026-05-19T11:00:00.000Z';
  const now = new Date('2026-05-19T11:00:02.000Z');
  const runId = buildAutomationRunId({
    taskId: 'automation:project_health',
    startedAt,
  });
  const resultPath = resolveAutomationRunResultPath({
    backgroundRuntimeRoot,
    automationId: 'automation:project_health',
    runId,
  });
  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, JSON.stringify({
    version: 1,
    run_id: runId,
    automation_id: 'automation:project_health',
    status: 'completed',
    reason: 'ok',
    started_at: '2099-01-01T00:00:00.000Z',
    completed_at: now.toISOString(),
    summary: 'Result fields should be bounded.',
    budget: { runtime_ms: 99_999_999, tool_calls: -5 },
  }, null, 2));

  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backgroundRuntimeRoot,
    backendService: createBackendStub({
      onBackgroundRun: async () => ({ status: 'started', task: 'automation_run' }),
    }),
    nowProvider: () => new Date(now),
    pollIntervalMs: 60_000,
    watchDebounceMs: 10,
  });
  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot,
    userDataPath,
    backgroundRuntimeRoot,
  });
  writeTasks(tasksPath, [
    createAutomationTask({
      trigger: { type: 'interval', interval_seconds: 1 },
      last_status: 'started',
      last_reason: 'scheduled',
      last_started_at: startedAt,
      last_result_at: startedAt,
      automation_runs: [
        {
          run_id: runId,
          status: 'started',
          reason: 'scheduled',
          started_at: startedAt,
          budget: { runtime_ms: 300000, tool_calls: 0 },
          result_ref: `automation_project_health/${runId}.result.json`,
        },
      ],
    }),
  ]);

  try {
    await scheduler.start();

    const persisted = readScheduledTasksFile(tasksPath);
    const task = persisted.tasks.find((entry) => entry.id === 'automation:project_health');
    assert.ok(task);
    assert.equal(task.automation_runs[0].started_at, startedAt);
    assert.deepEqual(task.automation_runs[0].budget, {
      runtime_ms: 1800000,
      tool_calls: 0,
    });
  } finally {
    scheduler.stop();
  }
});

test('scheduler fails active automation runs when the runtime budget expires', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-budget-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-automation-budget-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const backgroundRuntimeRoot = resolveBackgroundRuntimeRoot(userDataPath);
  const startedAt = '2026-05-19T11:00:00.000Z';
  const now = new Date('2026-05-19T11:00:02.000Z');
  const runId = buildAutomationRunId({
    taskId: 'automation:project_health',
    startedAt,
  });
  const calls = [];
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backgroundRuntimeRoot,
    backendService: createBackendStub({
      onBackgroundRun: async (task, params) => {
        calls.push({ task, params });
        return { status: 'started', task };
      },
    }),
    nowProvider: () => new Date(now),
    pollIntervalMs: 60_000,
    watchDebounceMs: 10,
  });
  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot,
    userDataPath,
    backgroundRuntimeRoot,
  });
  writeTasks(tasksPath, [
    createAutomationTask({
      trigger: { type: 'interval', interval_seconds: 1 },
      last_status: 'started',
      last_reason: 'scheduled',
      last_started_at: startedAt,
      last_result_at: startedAt,
      automation_runs: [
        {
          run_id: runId,
          status: 'started',
          reason: 'scheduled',
          started_at: startedAt,
          budget: { runtime_ms: 1000, tool_calls: 0 },
          result_ref: `automation_project_health/${runId}.result.json`,
        },
      ],
    }),
  ]);

  try {
    await scheduler.start();

    const persisted = readScheduledTasksFile(tasksPath);
    const task = persisted.tasks.find((entry) => entry.id === 'automation:project_health');
    assert.deepEqual(calls, []);
    assert.ok(task);
    assert.equal(task.last_status, 'failed');
    assert.equal(task.last_reason, 'budget_exceeded');
    assert.equal(task.automation_runs.length, 1);
    assert.equal(task.automation_runs[0].run_id, runId);
    assert.equal(task.automation_runs[0].status, 'failed');
    assert.equal(task.automation_runs[0].reason, 'budget_exceeded');
  } finally {
    scheduler.stop();
  }
});
