const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SchedulerService,
  readScheduledTasksFile,
  resolveBackgroundRuntimeRoot,
  resolveScheduledTasksPath,
} = require('../services/scheduler-service');
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

test('scheduler stays idle without enabled durable automation tasks', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-idle-'));
  trackDirectory(userDataPath);
  let intervalStarts = 0;
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(''),
    backendService: createBackendStub(),
    setIntervalImpl() {
      intervalStarts += 1;
      return { unref() {} };
    },
  });

  try {
    assert.equal(await scheduler.start(), false);
    const snapshot = scheduler.getStateSnapshot();
    assert.equal(intervalStarts, 0);
    assert.equal(scheduler.started, false);
    assert.equal(snapshot.relevant, false);
    assert.equal(snapshot.lifecycle.phase, 'idle');
    assert.equal(snapshot.lifecycle.qualifyingTaskCount, 0);
  } finally {
    scheduler.stop();
  }
});

test('ordinary Home reminders never qualify as scheduler runtime work', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-reminders-'));
  trackDirectory(userDataPath);
  let intervalStarts = 0;
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(''),
    backendService: createBackendStub(),
    setIntervalImpl() {
      intervalStarts += 1;
      return { unref() {} };
    },
  });

  try {
    assert.deepEqual(scheduler._getQualifyingTasks([
      { id: 'home-reminder', kind: 'reminder', enabled: true },
    ]), []);
    assert.equal(await scheduler.start(), false);
    assert.equal(intervalStarts, 0);
    assert.equal(scheduler.getStateSnapshot().lifecycle.phase, 'idle');
  } finally {
    scheduler.stop();
  }
});

test('scheduler starts and stops with the last enabled automation task', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-derived-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-derived-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);
  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot,
    userDataPath,
    backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
  });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify({
    version: 3,
    tasks: [createAutomationTask({ enabled: true })],
  }));
  let intervalStarts = 0;
  let intervalStops = 0;
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backendService: createBackendStub({ phase: 'starting' }),
    setIntervalImpl() {
      intervalStarts += 1;
      return { unref() {} };
    },
    clearIntervalImpl() { intervalStops += 1; },
  });

  try {
    assert.equal(await scheduler.start(), true);
    assert.equal(intervalStarts, 1);
    assert.equal(scheduler.getStateSnapshot().lifecycle.phase, 'running');
    fs.writeFileSync(tasksPath, JSON.stringify({
      version: 3,
      tasks: [createAutomationTask({ enabled: false })],
    }));
    assert.equal(await scheduler._requestLifecycleReconcile('test_disable'), false);
    const snapshot = scheduler.getStateSnapshot();
    assert.equal(intervalStops, 1);
    assert.equal(snapshot.relevant, false);
    assert.equal(snapshot.lifecycle.phase, 'idle');
  } finally {
    scheduler.stop();
  }
});

test('scheduler stop fences an in-flight lifecycle reconcile from restarting the runtime', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-stop-race-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-stop-race-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);
  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot,
    userDataPath,
    backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
  });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify({
    version: 4,
    tasks: [createAutomationTask({ enabled: true })],
  }));
  let releaseEnsure;
  let ensureStarted;
  const ensureStartedPromise = new Promise((resolve) => { ensureStarted = resolve; });
  const ensureReleasePromise = new Promise((resolve) => { releaseEnsure = resolve; });
  let intervalStarts = 0;
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backendService: createBackendStub({ phase: 'starting' }),
    setIntervalImpl() {
      intervalStarts += 1;
      return { unref() {} };
    },
  });
  scheduler._ensureTaskFile = async () => {
    ensureStarted();
    await ensureReleasePromise;
    return true;
  };

  const startPromise = scheduler.start();
  await ensureStartedPromise;
  scheduler.stop();
  releaseEnsure();

  assert.equal(await startPromise, false);
  assert.equal(intervalStarts, 0);
  assert.equal(scheduler.started, false);
  assert.equal(scheduler.getStateSnapshot().lifecycle.phase, 'stopped');
});

test('scheduler exposes structured lifecycle failure when task storage is unavailable', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-failed-'));
  trackDirectory(userDataPath);
  const fsImpl = Object.create(fs);
  fsImpl.mkdirSync = () => {
    const error = new Error('EACCES: C:\\Users\\Alice\\private\\scheduled_tasks.json api_key=sk-test-secret-value');
    error.code = 'EACCES';
    throw error;
  };
  const logs = [];
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(''),
    backendService: createBackendStub(),
    fsImpl,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  try {
    assert.equal(await scheduler.start(), false);
    const snapshot = scheduler.getStateSnapshot();
    assert.equal(snapshot.lifecycle.phase, 'failed');
    assert.equal(snapshot.lifecycle.relevant, true);
    assert.match(snapshot.lifecycle.error, /\[redacted\]/i);
    assert.doesNotMatch(snapshot.lifecycle.error, /Alice|sk-test-secret-value/);
    assert.ok(logs.some((entry) => entry.event === 'scheduler.lifecycle_reconcile_failed'));
  } finally {
    scheduler.stop();
  }
});

test('scheduler reports malformed durable task state instead of claiming idle', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-malformed-'));
  trackDirectory(userDataPath);
  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot: '',
    userDataPath,
    backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
  });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, '{not-json', 'utf8');
  let intervalStarts = 0;
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(''),
    backendService: createBackendStub(),
    setIntervalImpl() {
      intervalStarts += 1;
      return { unref() {} };
    },
  });

  try {
    assert.equal(await scheduler.start(), false);
    const snapshot = scheduler.getStateSnapshot();
    assert.equal(intervalStarts, 0);
    assert.equal(snapshot.relevant, true);
    assert.equal(snapshot.lifecycle.phase, 'failed');
    assert.match(snapshot.lifecycle.error, /malformed or unreadable/i);
  } finally {
    scheduler.stop();
  }
});

test('scheduler logs result persistence failures without throwing', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-persist-fail-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-persist-fail-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const now = new Date('2026-04-01T12:00:00.000Z');
  const logs = [];
  const fsImpl = Object.create(fs);
  fsImpl.renameSync = () => {
    const error = new Error('EPERM: operation not permitted, rename temp -> scheduled_tasks.json');
    error.code = 'EPERM';
    throw error;
  };

  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backendService: createBackendStub(),
    fsImpl,
    logger: (level, event, details) => logs.push({ level, event, details }),
    nowProvider: () => new Date(now),
  });

  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot,
    userDataPath,
    backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
  });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify({
    version: 3,
    tasks: [
      createAutomationTask({ id: 'automation:persist_fail', task: 'persist_fail' }),
    ],
  }, null, 2));
  const task = readScheduledTasksFile(tasksPath, {
    nowProvider: () => new Date(now),
  }).tasks.find((entry) => entry.id === 'automation:persist_fail');

  await assert.doesNotReject(() => scheduler._safeRecordTaskResult(
    tasksPath,
    { status: 'completed', task: task.task, run_id: 'run_persist_fail' },
    task.id,
    { reason: 'startup', taskName: task.task },
  ));

  assert.equal(logs.some((entry) => entry.event === 'scheduler.task_failed'), false);
  assert.equal(
    logs.some((entry) =>
      entry.level === 'WARN'
      && entry.event === 'scheduler.task_result_persist_failed'
      && entry.details?.reason === 'startup'
      && entry.details?.taskId === 'automation:persist_fail'
    ),
    true
  );
});

test('scheduler runTick logs failures instead of rejecting background ticks', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-tick-fail-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-tick-fail-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const logs = [];
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backendService: createBackendStub(),
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  scheduler.started = true;
  scheduler._runTick = async () => {
    const error = new Error('EPERM: operation not permitted, rename temp -> scheduled_tasks.json');
    error.code = 'EPERM';
    throw error;
  };

  let result;
  await assert.doesNotReject(async () => {
    result = await scheduler.runTick('startup');
  });

  assert.equal(result, false);
  assert.equal(
    logs.some((entry) =>
      entry.level === 'WARN'
      && entry.event === 'scheduler.tick_failed'
      && entry.details?.reason === 'startup'
    ),
    true
  );
});

for (const version of [2, 3]) {
  test(`scheduler migrates v${version} retired sub-agent tasks without dispatching them`, async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-subagent-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-subagent-workspace-'));
    trackDirectory(userDataPath);
    trackDirectory(workspaceRoot);

    const now = new Date('2026-05-08T12:00:00.000Z');
    const configService = new FakeConfigService(workspaceRoot);
    const calls = [];
    const scheduler = new SchedulerService({
      userDataPath,
      configService,
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
      backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
    });
    fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
    fs.writeFileSync(tasksPath, JSON.stringify({
      version,
      tasks: [
        {
          id: 'builtin:sub_agent_verification',
          task: 'sub_agent_verification',
          kind: 'sub_agent',
          enabled: true,
          trigger: { type: 'interval', interval_seconds: 1 },
          last_status: '',
          last_reason: '',
          last_started_at: '',
          last_result_at: '',
          last_completed_at: '',
          updated_at: now.toISOString(),
        },
      ],
    }, null, 2));

    await scheduler.start();

    assert.equal(calls.length, 0);
    const onDisk = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
    assert.equal(onDisk.version, 4);
    const persisted = readScheduledTasksFile(tasksPath);
    assert.equal(persisted.version, 4);
    assert.equal(persisted.tasks.some((entry) => entry.id === 'builtin:sub_agent_verification'), false);

    scheduler.stop();
  });
}

test('scheduler rejects a crafted non-automation task before background dispatch', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-kind-reject-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-kind-reject-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);
  const calls = [];
  const logs = [];
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backendService: createBackendStub({
      onBackgroundRun: async (...args) => calls.push(args),
    }),
    logger: (level, event, details) => logs.push({ level, event, details }),
    nowProvider: () => new Date('2026-05-08T12:00:00.000Z'),
  });

  await scheduler._runScheduledTask('unused.json', {
    id: 'builtin:sub_agent_planner',
    task: 'sub_agent_planner',
    kind: 'sub_agent',
    enabled: true,
    trigger: { type: 'interval', interval_seconds: 1 },
    policy: {},
  }, { reason: 'test' });

  assert.equal(calls.length, 0);
  assert.equal(
    logs.some((entry) =>
      entry.level === 'WARN'
      && entry.event === 'scheduler.task_kind_rejected'
      && entry.details?.taskId === 'builtin:sub_agent_planner'
    ),
    true
  );
});

test('scheduler falls back to the app-owned scheduled task file when no workspace root is configured', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-fallback-'));
  trackDirectory(userDataPath);

  const configService = new FakeConfigService('');
  const scheduler = new SchedulerService({
    userDataPath,
    configService,
    backendService: createBackendStub({
      phase: 'starting',
    }),
    pollIntervalMs: 60_000,
  });

  scheduler.start();
  await scheduler.runTick('test');

  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot: '',
    userDataPath,
    backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
  });
  assert.equal(fs.existsSync(tasksPath), true);
  scheduler.stop();
});

test('scheduler debounces file watch refreshes into a single tick', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-watch-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-watch-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const configService = new FakeConfigService(workspaceRoot);
  let watchCallback = null;
  const scheduler = new SchedulerService({
    userDataPath,
    configService,
    backendService: createBackendStub({
      phase: 'starting',
    }),
    watchImpl(targetPath, callback) {
      watchCallback = callback;
      return {
        close() {
          void targetPath;
        },
      };
    },
    pollIntervalMs: 60_000,
    watchDebounceMs: 10,
  });

  await scheduler.start();
  scheduler._ignoreWatchEventsUntilMs = 0;
  const reconcileReasons = [];
  scheduler._reconcileLifecycle = async (reason) => {
    reconcileReasons.push(reason);
  };

  watchCallback();
  watchCallback();
  watchCallback();
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(reconcileReasons, ['watch']);
  scheduler.stop();
});

test('scheduler disposes a zombie watcher on full-path rename spew and rebuilds next tick', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-zombie-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-zombie-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const configService = new FakeConfigService(workspaceRoot);
  const logs = [];
  const watchers = [];
  const scheduler = new SchedulerService({
    userDataPath,
    configService,
    backendService: createBackendStub({
      phase: 'starting',
    }),
    logger(level, event, payload) {
      logs.push({ level, event, payload });
    },
    watchImpl(targetPath, callback) {
      const watcher = {
        targetPath,
        callback,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      watchers.push(watcher);
      return watcher;
    },
    pollIntervalMs: 60_000,
    watchDebounceMs: 10,
  });

  scheduler.start();
  assert.equal(watchers.length, 1);

  // Windows deleted-dir pathology: the zombie watcher spews 'rename' events
  // whose filename is the FULL watched path instead of a bare basename.
  watchers[0].callback('rename', watchers[0].targetPath);

  assert.equal(watchers[0].closed, true);
  assert.equal(scheduler._watcher, null);
  assert.equal(
    logs.some((entry) => entry.event === 'scheduler.watch_zombie_disposed'),
    true
  );

  // The next tick reconciles the unchanged path and reinstalls a watcher.
  await scheduler.runTick('poll');
  assert.equal(watchers.length, 2);
  assert.equal(watchers[1].targetPath, watchers[0].targetPath);
  assert.equal(watchers[1].closed, false);

  scheduler.stop();
  assert.equal(watchers[1].closed, true);
});

test('scheduler start after stop reinstalls the tasks watcher', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-restart-'));
  trackDirectory(userDataPath);

  const configService = new FakeConfigService('');
  const watchers = [];
  const scheduler = new SchedulerService({
    userDataPath,
    configService,
    backendService: createBackendStub({
      phase: 'starting',
    }),
    watchImpl(targetPath, callback) {
      const watcher = {
        targetPath,
        callback,
        closed: false,
        close() {
          this.closed = true;
        },
      };
      watchers.push(watcher);
      return watcher;
    },
    pollIntervalMs: 60_000,
    watchDebounceMs: 10,
  });

  scheduler.start();
  assert.equal(watchers.length, 1);
  scheduler.stop();
  assert.equal(watchers[0].closed, true);

  // The tasks path is unchanged, but a restarted service must not run
  // poll-only: reconcile rebuilds the watcher.
  scheduler.start();
  assert.equal(watchers.length, 2);
  scheduler.stop();
  assert.equal(watchers[1].closed, true);
});

test('scheduler recovers stale lock owners before writing the task file', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-lock-'));
  trackDirectory(userDataPath);

  const configService = new FakeConfigService('');
  const scheduler = new SchedulerService({
    userDataPath,
    configService,
    backendService: createBackendStub({
      phase: 'starting',
    }),
  });

  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot: '',
    userDataPath,
    backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
  });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(`${tasksPath}.lock`, JSON.stringify({
    pid: 999999,
    token: 'stale-owner',
    acquired_at: '2026-03-31T00:00:00.000Z',
  }, null, 2));

  let acquired = false;
  const result = await scheduler._withTaskFileLock(tasksPath, async () => {
    acquired = true;
  });

  assert.equal(result, true);
  assert.equal(acquired, true);
  assert.equal(fs.existsSync(`${tasksPath}.lock`), false);
});

test('scheduler reclaims a corrupt (torn-write) lock instead of deadlocking forever', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-corrupt-lock-'));
  trackDirectory(userDataPath);

  const configService = new FakeConfigService('');
  const scheduler = new SchedulerService({
    userDataPath,
    configService,
    backendService: createBackendStub({
      phase: 'starting',
    }),
  });

  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot: '',
    userDataPath,
    backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
  });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });

  // Simulate a torn write from a previous hard kill: the lock file is the
  // right size but holds only whitespace (JSON.parse throws). Age its mtime
  // past the stale window so it is unambiguously abandoned.
  const lockPath = `${tasksPath}.lock`;
  fs.writeFileSync(lockPath, ' '.repeat(104));
  const stalePast = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stalePast, stalePast);

  let acquired = false;
  const result = await scheduler._withTaskFileLock(tasksPath, async () => {
    acquired = true;
  });

  assert.equal(result, true);
  assert.equal(acquired, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('scheduler leaves a freshly-written corrupt lock intact within the stale window', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-fresh-corrupt-lock-'));
  trackDirectory(userDataPath);

  const configService = new FakeConfigService('');
  const scheduler = new SchedulerService({
    userDataPath,
    configService,
    backendService: createBackendStub({
      phase: 'starting',
    }),
  });

  const tasksPath = resolveScheduledTasksPath({
    workspaceRoot: '',
    userDataPath,
    backgroundRuntimeRoot: resolveBackgroundRuntimeRoot(userDataPath),
  });
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });

  // A corrupt lock that was just written may belong to a peer that is still
  // mid-create — it must NOT be reclaimed until it has been idle for the full
  // stale window (default 15s). Recovery is declined while it is fresh.
  const lockPath = `${tasksPath}.lock`;
  fs.writeFileSync(lockPath, ' '.repeat(104));

  assert.equal(scheduler._recoverStaleLock(lockPath), false);
  assert.equal(fs.existsSync(lockPath), true);
});

test('scheduler ignores unrelated config changes instead of moving task files', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-config-ignore-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-config-ignore-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backendService: createBackendStub({
      phase: 'starting',
    }),
  });
  let reconciled = 0;
  let scheduled = 0;
  scheduler._reconcileScheduledTasksLocation = () => {
    reconciled += 1;
  };
  // _scheduleWatchTick does not exist in production -- spying on it made the
  // `scheduled` assertion below unfalsifiable. _scheduleLifecycleReconcile is
  // the seam _handleConfigChanged actually calls.
  scheduler._scheduleLifecycleReconcile = () => {
    scheduled += 1;
  };

  scheduler._handleConfigChanged({}, { reason: 'speech_settings_updated' });

  assert.equal(reconciled, 0);
  assert.equal(scheduled, 0);
});

test('scheduler reconciles task ownership for transactional root apply and rollback', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-root-transaction-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-root-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);
  const scheduler = new SchedulerService({
    userDataPath,
    configService: new FakeConfigService(workspaceRoot),
    backendService: createBackendStub(),
  });
  const calls = [];
  scheduler._reconcileScheduledTasksLocation = () => { calls.push('reconcile'); };
  scheduler._scheduleLifecycleReconcile = (reason) => { calls.push(reason); };

  scheduler._handleConfigChanged({}, { reason: 'workspace_root_transaction_applied' });
  scheduler._handleConfigChanged({}, { reason: 'workspace_root_transaction_rolled_back' });

  assert.deepEqual(calls, ['reconcile', 'config', 'reconcile', 'config']);
});

test('scheduler stop closes the watcher without starting a poller when no task qualifies', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-stop-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-scheduler-stop-workspace-'));
  trackDirectory(userDataPath);
  trackDirectory(workspaceRoot);

  const configService = new FakeConfigService(workspaceRoot);
  let closedWatcher = false;
  let clearedTimer = false;
  const timerToken = { id: 'poller' };
  const scheduler = new SchedulerService({
    userDataPath,
    configService,
    backendService: createBackendStub({
      phase: 'starting',
    }),
    watchImpl() {
      return {
        close() {
          closedWatcher = true;
        },
      };
    },
    setIntervalImpl() {
      return timerToken;
    },
    clearIntervalImpl(token) {
      if (token === timerToken) {
        clearedTimer = true;
      }
    },
  });

  scheduler.start();
  scheduler.stop();

  assert.equal(closedWatcher, true);
  assert.equal(clearedTimer, false);
  assert.equal(scheduler.started, false);
  assert.equal(scheduler.getStateSnapshot().relevant, false);
});
