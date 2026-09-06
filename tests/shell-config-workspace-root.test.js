'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ShellConfigService } = require('../services/shell-config-service');

const {
  createWorkspaceRootStatusController,
  getWorkspaceRootStatus,
  workspaceRootMethods,
} = require('../services/shell-config-workspace-root');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('workspace root status distinguishes missing, ready, non-directory, and inaccessible roots', () => {
  let statCalls = 0;
  assert.deepEqual(getWorkspaceRootStatus('', {
    statSync() {
      statCalls += 1;
      throw new Error('must not stat an empty root');
    },
  }), {
    state: 'missing',
    message: 'No workspace root is configured. Workspace-dependent proactive behaviors are blocked.',
  });
  assert.equal(statCalls, 0);

  assert.deepEqual(getWorkspaceRootStatus('G:/workspace', {
    statSync() {
      return { isDirectory: () => true };
    },
  }), { state: 'ready', message: 'Workspace root is configured.' });

  assert.deepEqual(getWorkspaceRootStatus('G:/file.txt', {
    statSync() {
      return { isDirectory: () => false };
    },
  }), {
    state: 'invalid',
    message: 'The configured workspace root is not a directory. Workspace-dependent behaviors are blocked.',
  });

  assert.deepEqual(getWorkspaceRootStatus('G:/missing', {
    statSync() {
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    },
  }), {
    state: 'invalid',
    message: 'The configured workspace root does not exist. Workspace-dependent behaviors are blocked.',
  });
});

test('a persisted root resolving to .jenny surfaces as invalid without a stat probe', () => {
  let statCalls = 0;
  const status = getWorkspaceRootStatus('C:/dev/jenny/.jenny', {
    statSync() {
      statCalls += 1;
      throw new Error('must not stat a rejected .jenny root');
    },
  });
  assert.equal(status.state, 'invalid');
  assert.match(status.message, /internal state/i);
  assert.equal(statCalls, 0);

  // Only an exact final .jenny segment is rejected; a directory that merely
  // starts with .jenny is a normal (if unusual) user directory name.
  assert.deepEqual(getWorkspaceRootStatus('C:/dev/jenny/.jenny-archive', {
    statSync: () => ({ isDirectory: () => true }),
  }), { state: 'ready', message: 'Workspace root is configured.' });
});

test('workspace root writes preserve legacy reasons and accept coordinator-owned reasons', () => {
  const writes = [];
  const target = {
    state: { toolsWorkspaceRoot: null },
    getState() { return { ...this.state }; },
    _writeState(nextState, reason) {
      writes.push(reason);
      this.state = nextState;
      return this.getState();
    },
  };
  Object.assign(target, workspaceRootMethods);

  target.setToolsWorkspaceRoot('G:/one');
  target.setToolsWorkspaceRoot('G:/two', { reason: 'workspace_root_transaction_applied' });
  target.clearToolsWorkspaceRoot({ reason: 'workspace_root_transaction_rolled_back' });

  assert.deepEqual(writes, [
    'workspace_root_updated',
    'workspace_root_transaction_applied',
    'workspace_root_transaction_rolled_back',
  ]);
});

test('wide-042: a delayed root probe returns checking synchronously and never blocks unrelated work', async () => {
  const gate = deferred();
  let statCalls = 0;
  const controller = createWorkspaceRootStatusController({
    stat: () => { statCalls += 1; return gate.promise; },
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  const immediate = controller.get('G:/slow-share');
  assert.equal(immediate.state, 'checking');
  assert.equal(statCalls, 0, 'filesystem work starts after the synchronous caller returns');
  const unrelated = { responsive: true };
  assert.equal(unrelated.responsive, true);
  await Promise.resolve();
  assert.equal(statCalls, 1);
  const settled = controller.refresh('G:/slow-share');
  gate.resolve({ isDirectory: () => true });
  assert.equal((await settled).state, 'ready');
});

test('wide-042: a hung probe times out to stale and logs without accepting a late result', async () => {
  const first = deferred();
  let fireTimeout = null;
  const logs = [];
  const controller = createWorkspaceRootStatusController({
    stat: () => first.promise,
    setTimeoutImpl: (callback) => { fireTimeout = callback; return { unref() {} }; },
    clearTimeoutImpl: () => {},
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  controller.get('G:/hung');
  await Promise.resolve();
  fireTimeout();
  const stale = await controller.refresh('G:/hung');
  assert.equal(stale.state, 'stale');
  assert.ok(logs.some((entry) => entry.event === 'workspace_root.probe_timeout'));
  first.resolve({ isDirectory: () => true });
  await Promise.resolve();
  assert.equal(controller.get('G:/hung').state, 'stale', 'late completion cannot revive a timed-out generation');
});

test('wide-042: invalid roots reconnect and stale ready entries revalidate by generation', async () => {
  let now = 100;
  const lastProbe = deferred();
  const probes = [
    () => Promise.reject(Object.assign(new Error('offline'), { code: 'ENOENT' })),
    () => Promise.resolve({ isDirectory: () => true }),
    () => lastProbe.promise,
  ];
  const controller = createWorkspaceRootStatusController({
    stat: () => probes.shift()(),
    now: () => now,
    ttlMs: 10,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  assert.equal((await controller.refresh('G:/reconnect')).state, 'invalid');
  assert.equal((await controller.refresh('G:/reconnect', { force: true })).state, 'ready');
  now = 111;
  const stale = controller.get('G:/reconnect');
  assert.equal(stale.state, 'stale');
  lastProbe.resolve({ isDirectory: () => true });
  assert.equal((await controller.refresh('G:/reconnect')).state, 'ready');
});

test('the status controller rejects an already-persisted .jenny root without probing and logs it', async () => {
  let statCalls = 0;
  const logs = [];
  const controller = createWorkspaceRootStatusController({
    stat: () => { statCalls += 1; return Promise.resolve({ isDirectory: () => true }); },
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  const status = controller.get('C:/dev/jenny/.jenny');
  assert.equal(status.state, 'invalid');
  assert.match(status.message, /internal state/i);
  assert.equal(statCalls, 0);
  assert.ok(logs.some((entry) => entry.event === 'workspace_root.state_dir_root_rejected'));

  // Recovers once a normal root is configured.
  const recovered = await controller.refresh('C:/dev/jenny/workspace');
  assert.equal(recovered.state, 'ready');
  assert.equal(statCalls, 1);
});

test('wide-042: shell config publishes checking to ready without a renderer poll', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-root-status-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const gate = deferred();
  const service = new ShellConfigService({
    userDataPath,
    workspaceRootStatusOptions: {
      stat: () => gate.promise,
      setTimeoutImpl: () => ({ unref() {} }),
      clearTimeoutImpl: () => {},
    },
  });
  const settled = new Promise((resolve) => {
    service.on('changed', (_state, context) => {
      if (context.reason === 'workspace_root_status_updated') resolve();
    });
  });
  service.setToolsWorkspaceRoot('G:/deferred-root');
  assert.equal(service.getWorkspaceRootStatus().state, 'checking');
  gate.resolve({ isDirectory: () => true });
  await settled;
  assert.equal(service.getWorkspaceRootStatus().state, 'ready');
});
