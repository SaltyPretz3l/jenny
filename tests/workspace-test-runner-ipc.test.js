'use strict';
// SPEC: Workspace Test Runner P0 — S9 (Architecture): the workspaceTestRunner.*
// IPC namespace round-trips through the descriptor table + registerIpcInvokeHandlers,
// carrying structured results and the CMP error envelope.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JENNY_SHELL_BRIDGE_DESCRIPTORS,
  getBridgeChannel,
  registerIpcInvokeHandlers,
} = require('../services/ipc-contract');
const { WORKSPACE_TEST_RUNNER_ERROR_CODES } = require('../services/backend/error-codes');
const { createWorkspaceTestRunnerService } = require('../services/workspace-test-runner-service');
const { createTestRunnerHistory } = require('../services/workspace-test-runner-history');

function fakeIpcMain() {
  const handlers = {};
  return {
    handle(channel, fn) { handlers[channel] = fn; },
    invoke(channel, payload) { return handlers[channel](null, payload); },
    registered: () => Object.keys(handlers),
  };
}

function makeStore(initial) {
  let value = initial;
  return { read: (def) => (value === undefined ? def : value), write: (v) => { value = v; } };
}

// The REAL service behind the IPC seam, so this round-trip has teeth: it goes
// red now (the service throws) and only greens when the service truly works.
function realService() {
  return createWorkspaceTestRunnerService({
    runner: { runTestCommand: () => Promise.resolve({ status: 'passed', exitCode: 0, durationMs: 7, startedAt: 'S', finishedAt: 'F' }) },
    history: createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) }),
    rootProvider: () => '/root',
    configProvider: () => [{ id: 'unit', label: 'Unit', command: 'npm test' }],
    now: () => new Date(1000),
    makeRunId: () => 'r1',
    defaultTimeoutMs: 600000,
  });
}

test('s9: the workspaceTestRunner.* descriptors map to kebab channels', () => {
  // RED-BECAUSE: this fails until the descriptors are added to the contract table.
  assert.equal(JENNY_SHELL_BRIDGE_DESCRIPTORS['workspaceTestRunner.listConfigs'].channel, 'workspace-test-runner:list-configs');
  assert.equal(JENNY_SHELL_BRIDGE_DESCRIPTORS['workspaceTestRunner.run'].channel, 'workspace-test-runner:run');
  assert.equal(JENNY_SHELL_BRIDGE_DESCRIPTORS['workspaceTestRunner.getState'].channel, 'workspace-test-runner:get-state');
  assert.equal(getBridgeChannel('workspaceTestRunner.run', 'invoke'), 'workspace-test-runner:run');
});

test('s14: the workspaceTestRunner.abort descriptor maps to its kebab channel and round-trips', async () => {
  // RED-BECAUSE: the abort descriptor + service.abort do not exist yet.
  assert.equal(JENNY_SHELL_BRIDGE_DESCRIPTORS['workspaceTestRunner.abort'].channel, 'workspace-test-runner:abort');
  assert.equal(getBridgeChannel('workspaceTestRunner.abort', 'invoke'), 'workspace-test-runner:abort');

  const service = realService();
  const ipcMain = fakeIpcMain();
  registerIpcInvokeHandlers(ipcMain, {
    'workspaceTestRunner.abort': () => service.abort(),
  });
  // No active run -> a clean structured no-op round-trips through the channel.
  assert.deepEqual(await ipcMain.invoke('workspace-test-runner:abort'), { aborted: false });
});

test('s13: the workspaceTestRunner.onStateChanged subscribe descriptor maps to its kebab channel', () => {
  // RED-BECAUSE: the onStateChanged subscribe descriptor does not exist yet.
  assert.equal(JENNY_SHELL_BRIDGE_DESCRIPTORS['workspaceTestRunner.onStateChanged'].kind, 'subscribe');
  assert.equal(JENNY_SHELL_BRIDGE_DESCRIPTORS['workspaceTestRunner.onStateChanged'].channel, 'workspace-test-runner:state-changed');
  assert.equal(getBridgeChannel('workspaceTestRunner.onStateChanged', 'subscribe'), 'workspace-test-runner:state-changed');
});

test('s18: the workspaceTestRunner.saveConfigs descriptor maps to its channel and round-trips a normalized write', async () => {
  // RED-BECAUSE: the saveConfigs descriptor + service.saveConfigs do not exist yet.
  assert.equal(JENNY_SHELL_BRIDGE_DESCRIPTORS['workspaceTestRunner.saveConfigs'].channel, 'workspace-test-runner:save-configs');
  assert.equal(getBridgeChannel('workspaceTestRunner.saveConfigs', 'invoke'), 'workspace-test-runner:save-configs');

  const written = [];
  const service = createWorkspaceTestRunnerService({
    runner: { runTestCommand: () => Promise.resolve({ status: 'passed', exitCode: 0, durationMs: 1, startedAt: 'S', finishedAt: 'F' }) },
    history: createTestRunnerHistory({ store: makeStore(undefined), now: () => new Date(9000) }),
    rootProvider: () => '/root',
    configProvider: () => [],
    configWriter: (configs) => written.push(configs),
    now: () => new Date(1000),
    makeRunId: () => 'r1',
  });
  const ipcMain = fakeIpcMain();
  registerIpcInvokeHandlers(ipcMain, {
    'workspaceTestRunner.saveConfigs': (_event, configs) => service.saveConfigs(configs),
  });
  const res = await ipcMain.invoke('workspace-test-runner:save-configs', [{ id: 'unit', command: 'npm test' }, { id: 'bad' }]);
  assert.deepEqual(res.configs.map((c) => c.id), ['unit'], 'the normalized set round-trips');
  assert.equal(written.length, 1, 'the write reached the injected writer');
});

test('s9: handlers round-trip a structured run record and the CMP error envelope', async () => {
  // RED-BECAUSE: the real service's run()/listConfigs() throw NotImplementedError.
  const service = realService();
  const ipcMain = fakeIpcMain();
  registerIpcInvokeHandlers(ipcMain, {
    'workspaceTestRunner.listConfigs': () => service.listConfigs(),
    'workspaceTestRunner.run': (_event, payload) => service.run(payload),
    'workspaceTestRunner.getState': () => service.getState(),
  });

  assert.deepEqual(ipcMain.registered().sort(), [
    'workspace-test-runner:get-state',
    'workspace-test-runner:list-configs',
    'workspace-test-runner:run',
  ]);

  const listed = await ipcMain.invoke('workspace-test-runner:list-configs');
  assert.equal(listed.configs[0].id, 'unit');

  const ran = await ipcMain.invoke('workspace-test-runner:run', { configId: 'unit' });
  assert.deepEqual(ran, {
    configId: 'unit', runId: 'r1', status: 'passed',
    exitCode: 0, durationMs: 7, startedAt: 'S', finishedAt: 'F',
  }, 'the full structured run record round-trips, not just status/runId');

  const missed = await ipcMain.invoke('workspace-test-runner:run', { configId: 'ghost' });
  assert.equal(missed.error.code, WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_NOT_FOUND);

  const state = await ipcMain.invoke('workspace-test-runner:get-state');
  assert.deepEqual(state.configs.map((c) => c.id), ['unit']);
  assert.equal(state.activeRun, null, 'the lock released after the run completed');
  assert.equal(state.history.byConfig.unit.length, 1, 'the completed run persisted to history');
  assert.equal(state.history.byConfig.unit[0].status, 'passed');
});
