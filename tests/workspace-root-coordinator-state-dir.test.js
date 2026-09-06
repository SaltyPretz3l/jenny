'use strict';

// Split out of workspace-root-coordinator.test.js to stay under the
// 600-line test-file ratchet: guards rejecting Jenny's own .jenny state
// directory as a workspace root.

const test = require('node:test');
const assert = require('node:assert/strict');

const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');

function createTimerHarness() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    setTimeoutImpl(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeoutImpl(id) {
      callbacks.delete(id);
    },
  };
}

function createHarness({
  initialRootPath = 'G:/workspace/old',
  chooseResult = { canceled: false, path: 'G:/workspace/new' },
} = {}) {
  let persistedRoot = initialRootPath;
  const logs = [];
  let nextTransition = 1;
  let nextOperation = 1;
  const timers = createTimerHarness();
  const normalizeRootPath = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '');
  const rootIdFactory = (rootPath) => rootPath
    ? `root:${normalizeRootPath(rootPath).toLowerCase()}`
    : null;

  const coordinator = new WorkspaceRootCoordinator({
    initialRootPath,
    normalizeRootPath,
    rootIdFactory,
    chooseTarget: async () => chooseResult,
    applyRootPath: async (context) => {
      persistedRoot = context.rootPath;
    },
    restoreRootPath: async (context) => {
      persistedRoot = context.rootPath;
    },
    refreshManagedRoot: async () => {},
    stopRootServices: async () => {},
    startRootServices: async () => {},
    transitionIdFactory: () => `transition-${nextTransition++}`,
    operationIdFactory: () => `operation-${nextOperation++}`,
    transitionTtlMs: 120_000,
    mutationDrainTimeoutMs: 30_000,
    hookTimeoutMs: 30_000,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  return {
    coordinator,
    logs,
    getPersistedRoot: () => persistedRoot,
  };
}

test('a root whose final segment is .jenny is rejected at every set-root entrypoint', async () => {
  for (const rootPath of ['G:/workspace/.jenny', 'G:/workspace/.JENNY', 'G:/workspace/.jenny/']) {
    const harness = createHarness();
    const before = harness.coordinator.captureContext();
    const result = await harness.coordinator.prepareTarget(rootPath);

    assert.equal(result.prepared, false);
    assert.equal(result.blocked, true);
    assert.equal(result.code, 'workspace_root_is_state_dir');
    assert.match(result.message, /internal state/i);
    assert.deepEqual(harness.coordinator.captureContext(), before, 'rejected target never opens a transition');
    assert.ok(
      harness.logs.some((entry) => entry.event === 'workspace_root.state_dir_root_rejected'),
      'rejection is observable'
    );
  }
});

test('a .jenny-suffixed folder name is not rejected (only an exact .jenny segment is)', async () => {
  const harness = createHarness();
  const result = await harness.coordinator.prepareTarget('G:/workspace/.jenny-stuff');
  assert.equal(result.prepared, true);
  assert.equal(result.candidate.rootPath, 'G:/workspace/.jenny-stuff');
});

test('prepareClear is never rejected by the .jenny guard (empty target short-circuits it)', async () => {
  const harness = createHarness();
  const result = await harness.coordinator.prepareClear();
  assert.equal(result.prepared, true);
  assert.equal(result.candidate.rootPath, '');
});

test('prepareChoose additionally rejects a picker target with .jenny anywhere in the path', async () => {
  const harness = createHarness({
    chooseResult: { canceled: false, path: 'G:/workspace/.jenny/artifacts/session-1' },
  });
  const before = harness.coordinator.captureContext();
  const result = await harness.coordinator.prepareChoose();

  assert.equal(result.prepared, false);
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'workspace_root_inside_state_dir');
  assert.match(result.message, /internal state/i);
  assert.deepEqual(harness.coordinator.captureContext(), before);
  assert.ok(harness.logs.some((entry) => entry.event === 'workspace_root.state_dir_segment_rejected'));
});

test('prepareChoose accepts a picker target merely named like .jenny (no exact segment match)', async () => {
  const harness = createHarness({
    chooseResult: { canceled: false, path: 'G:/workspace/.jenny-archive/session-1' },
  });
  const result = await harness.coordinator.prepareChoose();
  assert.equal(result.prepared, true);
  assert.equal(result.candidate.rootPath, 'G:/workspace/.jenny-archive/session-1');
});
