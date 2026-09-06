'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRANSACTION_APPLY_REASON,
  TRANSACTION_ROLLBACK_REASON,
  createWorkspaceRootRuntime,
} = require('../services/workspace-root-runtime');

function createConfig(initialRoot = 'G:/old') {
  let root = initialRoot;
  const writes = [];
  return {
    writes,
    getToolsWorkspaceRoot: () => root,
    setToolsWorkspaceRoot(value, options) {
      writes.push(['set', value, options]);
      root = value;
    },
    clearToolsWorkspaceRoot(options) {
      writes.push(['clear', options]);
      root = '';
    },
  };
}

test('runtime selects first, then atomically persists, refreshes, and follows a running watcher', async () => {
  const config = createConfig();
  const events = [];
  let watching = true;
  const runtime = createWorkspaceRootRuntime({
    configService: config,
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['G:/new'] }),
    },
    watcher: {
      isRunning: () => watching,
      stop: () => { events.push('watcher.stop'); watching = false; },
      start: () => { events.push('watcher.start'); watching = true; },
    },
    backendService: {
      refreshManagedConfig: async (reason) => { events.push(['refresh', reason]); },
    },
    coordinatorOptions: {
      normalizeRootPath: (value) => String(value || '').replace(/\\/g, '/'),
      rootIdFactory: (value) => value ? `root:${value.toLowerCase()}` : null,
      transitionIdFactory: () => 'transition-1',
    },
  });

  const prepared = await runtime.coordinator.prepareChoose();
  assert.equal(prepared.prepared, true);
  assert.equal(config.getToolsWorkspaceRoot(), 'G:/old', 'prepare is non-mutating');
  const result = await runtime.coordinator.commit({ transitionId: prepared.transitionId });

  assert.equal(result.committed, true);
  assert.equal(config.getToolsWorkspaceRoot(), 'G:/new');
  assert.deepEqual(config.writes, [
    ['set', 'G:/new', { reason: TRANSACTION_APPLY_REASON }],
  ]);
  assert.deepEqual(events, [
    'watcher.stop',
    ['refresh', 'workspace_root_commit'],
    'watcher.start',
  ]);
});

test('persistence refusal rolls back under the new generation', async () => {
  const config = createConfig();
  config.setToolsWorkspaceRoot = (value, options) => {
    config.writes.push(['refused-set', value, options]);
  };
  const runtime = createWorkspaceRootRuntime({
    configService: config,
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: ['G:/new'] }),
    },
    coordinatorOptions: {
      normalizeRootPath: (value) => String(value || '').replace(/\\/g, '/'),
      rootIdFactory: (value) => value ? `root:${value.toLowerCase()}` : null,
    },
  });
  const prepared = await runtime.coordinator.prepareChoose();
  const result = await runtime.coordinator.commit({ transitionId: prepared.transitionId });

  assert.equal(result.rolledBack, true);
  assert.equal(result.stage, 'persistence');
  assert.equal(result.error.code, 'workspace_root_persistence_refused');
  assert.equal(result.context.rootPath, 'G:/old');
  assert.equal(result.context.generation, 1);
  assert.equal(
    config.writes.some((entry) => entry[2]?.reason === TRANSACTION_ROLLBACK_REASON),
    false,
    'already-restored old persistence is an idempotent rollback no-op'
  );
});

test('runtime participants are blocked by default and terminated only on explicit commit consent', async () => {
  const config = createConfig();
  let terminalActive = true;
  let killCalls = 0;
  const runtime = createWorkspaceRootRuntime({
    configService: config,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    terminalService: {
      hasSession: () => terminalActive,
      kill: async () => { killCalls += 1; terminalActive = false; },
    },
    coordinatorOptions: {
      normalizeRootPath: (value) => String(value || '').replace(/\\/g, '/'),
      rootIdFactory: (value) => value ? `root:${value.toLowerCase()}` : null,
    },
  });
  const prepared = await runtime.coordinator.prepareClear();
  const blocked = await runtime.coordinator.commit({ transitionId: prepared.transitionId });
  assert.equal(blocked.code, 'participants_active');
  assert.equal(killCalls, 0);

  const committed = await runtime.coordinator.commit({
    transitionId: prepared.transitionId,
    terminateProcesses: true,
  });
  assert.equal(committed.committed, true);
  assert.equal(killCalls, 1);
});

test('wide-016: root commit awaits test-runner abortAndWait before applying the new root', async () => {
  const config = createConfig();
  let active = true;
  let confirmTermination;
  const terminationGate = new Promise((resolve) => { confirmTermination = resolve; });
  const runtime = createWorkspaceRootRuntime({
    configService: config,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    testRunnerService: {
      getState: () => ({ activeRun: active ? 'run-1' : null }),
      abort: () => { throw new Error('abortAndWait must be preferred'); },
      abortAndWait: async () => {
        await terminationGate;
        active = false;
        return { aborted: true, terminationConfirmed: true };
      },
    },
    coordinatorOptions: {
      normalizeRootPath: (value) => String(value || '').replace(/\\/g, '/'),
      rootIdFactory: (value) => value ? `root:${value.toLowerCase()}` : null,
    },
  });
  const prepared = await runtime.coordinator.prepareClear();
  const commit = runtime.coordinator.commit({
    transitionId: prepared.transitionId,
    terminateProcesses: true,
  });
  await Promise.resolve();
  assert.equal(config.getToolsWorkspaceRoot(), 'G:/old', 'root stays pinned while tree death is unconfirmed');
  confirmTermination();
  assert.equal((await commit).committed, true);
  assert.equal(config.getToolsWorkspaceRoot(), '');
});

test('uiux-014: an active run task blocks a root switch until terminateProcesses consents, then is killed', async () => {
  const config = createConfig();
  let taskActive = true;
  let killCalls = 0;
  const runtime = createWorkspaceRootRuntime({
    configService: config,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    runTaskService: {
      hasActiveTask: () => taskActive,
      kill: async () => { killCalls += 1; taskActive = false; return { killed: true }; },
    },
    coordinatorOptions: {
      normalizeRootPath: (value) => String(value || '').replace(/\\/g, '/'),
      rootIdFactory: (value) => value ? `root:${value.toLowerCase()}` : null,
    },
  });
  const prepared = await runtime.coordinator.prepareClear();
  const blocked = await runtime.coordinator.commit({ transitionId: prepared.transitionId });
  assert.equal(blocked.code, 'participants_active');
  assert.equal(killCalls, 0, 'a root switch never kills a run task without explicit consent');

  const committed = await runtime.coordinator.commit({
    transitionId: prepared.transitionId,
    terminateProcesses: true,
  });
  assert.equal(committed.committed, true);
  assert.equal(killCalls, 1);
});

test('clearing a root stops an active watcher without restarting it rootless', async () => {
  const config = createConfig();
  let watching = true;
  let starts = 0;
  const runtime = createWorkspaceRootRuntime({
    configService: config,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    watcher: {
      isRunning: () => watching,
      stop: () => { watching = false; },
      start: () => { starts += 1; watching = true; },
    },
    coordinatorOptions: {
      normalizeRootPath: (value) => String(value || '').replace(/\\/g, '/'),
      rootIdFactory: (value) => value ? `root:${value.toLowerCase()}` : null,
    },
  });
  const prepared = await runtime.coordinator.prepareClear();
  const result = await runtime.coordinator.commit({ transitionId: prepared.transitionId });

  assert.equal(result.committed, true);
  assert.equal(watching, false);
  assert.equal(starts, 0);
});
