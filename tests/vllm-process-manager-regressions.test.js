'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  VLLMProcessManager,
  buildVllmLaunchArgs,
} = require('../services/backend/vllm-process-manager');

function makeStateStore(initialValue = null) {
  let stored = initialValue;
  const deletes = [];
  return {
    deletes,
    read(defaultValue) { return stored === null ? defaultValue : stored; },
    write(value) { stored = value; },
    delete() { deletes.push(true); stored = null; },
    stored() { return stored; },
  };
}

function makeFakeProcess(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

async function expectBounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation did not settle promptly')), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function makeStaleManager({ killProcessTreeImpl, waitForProcessExitImpl }) {
  const pid = 5151;
  const logs = [];
  const store = makeStateStore({
    pid,
    app_owned: true,
    command: '/usr/bin/vllm',
    port: 8000,
    model: 'OldM',
    startedAt: '2026-01-01T00:00:00Z',
  });
  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'NewM',
    stateStore: store,
    isProcessAliveImpl: () => true,
    pidMatchesVllmImpl: () => true,
    killProcessTreeImpl,
    waitForProcessExitImpl,
  });
  manager._isRunning = async () => { throw new Error('replacement startup must be aborted'); };
  return { logs, manager, pid, store };
}

function makeLaunchManager(scheduleFailure) {
  const logs = [];
  const store = makeStateStore();
  const child = makeFakeProcess();
  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'Qwen/Qwen3.5-9B',
    stateStore: store,
    spawnImpl: () => {
      process.nextTick(() => scheduleFailure(child));
      return child;
    },
    isProcessAliveImpl: () => false,
    pidMatchesVllmImpl: () => false,
  });
  manager._isRunning = async () => false;
  manager._resolveCommand = async () => '/usr/bin/vllm';
  manager._waitForReady = () => new Promise(() => {});
  return { logs, manager, store };
}

test('buildVllmLaunchArgs rejects separate --port extra arguments', () => {
  assert.throws(() => buildVllmLaunchArgs({
    model: 'Qwen/Qwen3.5-9B',
    port: 8000,
    extraArgs: ['--port', '9001'],
  }), /--port is managed/);
});

test('buildVllmLaunchArgs rejects --port=<value> extra arguments', () => {
  assert.throws(() => buildVllmLaunchArgs({
    model: 'Qwen/Qwen3.5-9B',
    port: 8000,
    extraArgs: ['--port=9001'],
  }), /--port is managed/);
});

test('start retains stale ownership and aborts when the tree kill fails', async () => {
  const { logs, manager, pid, store } = makeStaleManager({
    killProcessTreeImpl: async () => { throw new Error('kill failed'); },
    waitForProcessExitImpl: async () => false,
  });

  assert.deepEqual(await manager.start(), { started: false, external: false });
  assert.equal(store.stored().pid, pid);
  assert.equal(store.deletes.length, 0);
  assert.ok(logs.some((entry) => entry.level === 'WARN'
    && entry.event === 'vllm.stale_owned_process_exit_unconfirmed'
    && entry.details.killTerminated === false));
});

test('start retains stale ownership and aborts when exit confirmation is false', async () => {
  const { logs, manager, pid, store } = makeStaleManager({
    killProcessTreeImpl: async () => ({ terminated: true }),
    waitForProcessExitImpl: async () => false,
  });

  assert.deepEqual(await manager.start(), { started: false, external: false });
  assert.equal(store.stored().pid, pid);
  assert.equal(store.deletes.length, 0);
  assert.ok(logs.some((entry) => entry.level === 'WARN'
    && entry.event === 'vllm.stale_owned_process_exit_unconfirmed'
    && entry.details.killTerminated === true));
});

test('start reports an early child error without waiting for readiness timeout', async () => {
  const { logs, manager, store } = makeLaunchManager((child) => {
    child.emit('error', new Error('spawn failed'));
  });

  assert.deepEqual(await expectBounded(manager.start()), { started: false, external: false });
  assert.equal(store.deletes.length, 1);
  assert.ok(logs.some((entry) => entry.event === 'vllm.spawn_error'));
  assert.ok(logs.some((entry) => entry.event === 'vllm.launch_failed'
    && entry.details.reason === 'spawn_error'));
  assert.equal(logs.some((entry) => entry.event === 'vllm.startup_timeout'), false);
});

test('start reports an early child exit without waiting for readiness timeout', async () => {
  const { logs, manager, store } = makeLaunchManager((child) => {
    child.emit('exit', 7, null);
  });

  assert.deepEqual(await expectBounded(manager.start()), { started: false, external: false });
  assert.equal(store.deletes.length, 1);
  assert.ok(logs.some((entry) => entry.event === 'vllm.exited'
    && entry.details.code === 7));
  assert.ok(logs.some((entry) => entry.event === 'vllm.launch_failed'
    && entry.details.reason === 'early_exit'));
  assert.equal(logs.some((entry) => entry.event === 'vllm.startup_timeout'), false);
});
