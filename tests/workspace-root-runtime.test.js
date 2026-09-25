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

test('a committed root provisions its workspace project after the managed refresh, and a failure there never rolls back', async () => {
  for (const provisionerThrows of [false, true]) {
    const config = createConfig();
    const events = [];
    const runtime = createWorkspaceRootRuntime({
      configService: config,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['G:/new'] }) },
      backendService: {
        refreshManagedConfig: async (reason) => { events.push(['refresh', reason]); },
        ensureWorkspaceProject: async (rootPath, reason) => {
          events.push(['provision', rootPath, reason]);
          if (provisionerThrows) throw new Error('store offline');
          return { ok: true, created: true, project: { id: 'project_new' } };
        },
      },
      coordinatorOptions: {
      normalizeRootPath: (value) => String(value || '').replace(/\\/g, '/'),
        rootIdFactory: (value) => value ? `root:${value.toLowerCase()}` : null,
      },
    });

    const prepared = await runtime.coordinator.prepareChoose();
    const result = await runtime.coordinator.commit({ transitionId: prepared.transitionId });
    assert.equal(result.committed, true, `throws=${provisionerThrows}`);
    assert.equal(result.rolledBack, false);
    assert.equal(config.getToolsWorkspaceRoot(), 'G:/new');
    // The managed refresh is kicked off in the background (2026-09-20): the
    // commit never waits on it, so provisioning may land first.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events.slice().sort(), [
      ['provision', 'G:/new', 'workspace_root_commit'],
      ['refresh', 'workspace_root_commit'],
    ]);
  }
});

test('a commit does not wait for the managed sidecar refresh, and refreshes never overlap', async () => {
  const config = createConfig();
  const releases = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const runtime = createWorkspaceRootRuntime({
    configService: config,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['G:/new'] }) },
    backendService: {
      refreshManagedConfig: () => new Promise((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        releases.push(() => { inFlight -= 1; resolve(null); });
      }),
    },
    coordinatorOptions: {
      normalizeRootPath: (value) => String(value || '').replace(/\\/g, '/'),
      rootIdFactory: (value) => value ? `root:${value.toLowerCase()}` : null,
    },
  });

  const first = await runtime.coordinator.prepareChoose();
  const committed = await runtime.coordinator.commit({ transitionId: first.transitionId });
  assert.equal(committed.committed, true, 'the commit resolves while the refresh is still pending');
  assert.equal(config.getToolsWorkspaceRoot(), 'G:/new');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1, 'the refresh was started');

  const cleared = await runtime.coordinator.prepareClear();
  const clearedResult = await runtime.coordinator.commit({ transitionId: cleared.transitionId });
  assert.equal(clearedResult.committed, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1, 'the second refresh waits for the first to finish');
  releases[0]();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2);
  assert.equal(maxInFlight, 1);
  releases[1]();
});

test('clearing the root never asks for a project', async () => {
  const config = createConfig();
  const events = [];
  const runtime = createWorkspaceRootRuntime({
    configService: config,
    backendService: {
      ensureWorkspaceProject: async (...args) => { events.push(args); },
    },
    coordinatorOptions: {
      normalizeRootPath: (value) => String(value || '').replace(/\\/g, '/'),
      rootIdFactory: (value) => value ? `root:${value.toLowerCase()}` : null,
    },
  });
  const prepared = await runtime.coordinator.prepareClear();
  const result = await runtime.coordinator.commit({ transitionId: prepared.transitionId });
  assert.equal(result.committed, true);
  assert.deepEqual(events, []);
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

test('UI root transitions do not terminate session-owned test runs', async () => {
 const config = createConfig();
 const runtime = createWorkspaceRootRuntime({ configService: config,
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['G:/new'] }) },
  testRunnerService: {
   hasWorkspaceRun: () => false,
   getState: () => ({ activeRun: 'session-owned-run' }),
   abortAndWait: async () => assert.fail('UI selection must not cancel session work'),
  },
  coordinatorOptions: { normalizeRootPath: value => value, rootIdFactory: value => value },
 });
 const prepared = await runtime.coordinator.prepareChoose();
 assert.equal((await runtime.coordinator.commit({ transitionId: prepared.transitionId })).committed, true);
});

test('root transition rechecks test ownership after another participant settles', async () => {
 let uiRun = true;
 let terminalActive = true;
 const runtime = createWorkspaceRootRuntime({ configService: createConfig(),
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['G:/new'] }) },
  terminalService: { hasSession: () => terminalActive, kill: async () => { uiRun = false; terminalActive = false; } },
  testRunnerService: { hasWorkspaceRun: () => uiRun,
   abortAndWait: async () => assert.fail('replacement session run must survive UI transition') },
  coordinatorOptions: { normalizeRootPath: value => value, rootIdFactory: value => value },
 });
 const prepared = await runtime.coordinator.prepareChoose();
 const result = await runtime.coordinator.commit({ transitionId: prepared.transitionId, terminateProcesses: true });
 assert.equal(result.committed, true);
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
