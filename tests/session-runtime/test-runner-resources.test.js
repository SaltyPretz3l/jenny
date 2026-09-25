'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createWorkspaceTestRunnerService } = require('../../services/workspace-test-runner-service');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');
const {
  ResourceBroker,
  capacityResource,
} = require('../../services/session-runtime/resource-broker');
const { cleanupTrackedResources, createTrackedTempDir } = require('../helpers/resource-cleanup');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function completed(overrides = {}) {
  return {
    status: 'passed',
    exitCode: 0,
    durationMs: 1,
    startedAt: 'S',
    finishedAt: 'F',
    stdoutTail: '',
    stderrTail: '',
    terminationConfirmed: true,
    ...overrides,
  };
}

function createRuntime(options = {}) {
  let leaseId = 0;
  const broker = new ResourceBroker({
    ...options,
    createId: () => `lease-${++leaseId}`,
  });
  const pathResolver = new PhysicalPathResolver();
  return { broker, pathResolver, provider: () => ({ broker, pathResolver }) };
}

function makeService(rootProvider, runtime, runner, configs = null) {
  return createWorkspaceTestRunnerService({
    runner,
    rootProvider,
    configProvider: () => configs
      || [{ id: 'unit', label: 'Unit', command: 'npm test', cwd: '.' }],
    makeRunId: () => 'run-1',
    resourceAdmissionProvider: runtime?.provider,
  });
}

function gatedRunner() {
  const entered = deferred();
  const finish = deferred();
  let calls = 0;
  return {
    entered,
    finish,
    get calls() { return calls; },
    runTestCommand() {
      calls += 1;
      entered.resolve();
      return finish.promise;
    },
  };
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('same-root runs conflict on the physical root when test capacity permits both', async () => {
  const root = createTrackedTempDir('jenny-test-root-lock-');
  const runtime = createRuntime({ limits: { tests: 2, native_processes: 2 } });
  const firstRunner = gatedRunner();
  const secondRunner = gatedRunner();
  const first = makeService(() => root, runtime, firstRunner);
  const second = makeService(() => root, runtime, secondRunner);

  const firstRun = first.run({ configId: 'unit' });
  await firstRunner.entered.promise;
  const secondRun = second.run({ configId: 'unit' });
  await nextTurn();
  assert.equal(secondRunner.calls, 0);
  assert.equal(runtime.broker.snapshot().waiter_count, 1);

  firstRunner.finish.resolve(completed());
  await firstRun;
  await secondRunner.entered.promise;
  secondRunner.finish.resolve(completed());
  await secondRun;
  assert.equal(runtime.broker.snapshot().lease_count, 0);
});

test('one test capacity serializes disjoint roots and Jenny attribution also claims a tool slot', async () => {
  const base = createTrackedTempDir('jenny-test-capacity-');
  const firstRoot = path.join(base, 'first');
  const secondRoot = path.join(base, 'second');
  fs.mkdirSync(firstRoot);
  fs.mkdirSync(secondRoot);
  const runtime = createRuntime();
  const firstRunner = gatedRunner();
  const secondRunner = gatedRunner();
  const first = makeService(() => firstRoot, runtime, firstRunner);
  const second = makeService(() => secondRoot, runtime, secondRunner);

  const firstRun = first.run({ configId: 'unit', initiator: 'user' });
  await firstRunner.entered.promise;
  assert.equal(runtime.broker.snapshot().capacity.tool_operations, 0);
  const secondRun = second.run({ configId: 'unit', initiator: 'jenny' });
  await nextTurn();
  assert.equal(secondRunner.calls, 0);
  assert.equal(runtime.broker.snapshot().waiter_count, 1);

  firstRunner.finish.resolve(completed());
  await firstRun;
  await secondRunner.entered.promise;
  assert.equal(runtime.broker.snapshot().capacity.tool_operations, 1);
  secondRunner.finish.resolve(completed());
  const result = await secondRun;
  assert.equal(result.terminationConfirmed, true);
  assert.equal(runtime.broker.snapshot().lease_count, 0);
});

test('a captured scope change while waiting rejects before producer dispatch', async () => {
  const root = createTrackedTempDir('jenny-test-stale-scope-');
  const runtime = createRuntime();
  const holder = await runtime.broker.acquire({
    ownerId: 'test-holder',
    resources: [capacityResource('tests')],
  });
  let current = true;
  let calls = 0;
  const service = makeService(() => root, runtime, {
    runTestCommand: async () => { calls += 1; return completed(); },
  });
  const scope = {
    root,
    configs: [{ id: 'unit', label: 'Unit', command: 'npm test', cwd: '.' }],
    history: null,
    assertCurrent() {
      if (!current) throw new Error('stale project scope');
    },
  };

  const pending = service.run({ configId: 'unit', initiator: 'jenny' }, scope);
  await nextTurn();
  assert.equal(runtime.broker.snapshot().waiter_count, 1);
  assert.equal(runtime.broker.snapshot().capacity.native_processes, 0);
  current = false;
  runtime.broker.release(holder, { producerSettled: true });

  await assert.rejects(pending, /stale project scope/);
  assert.equal(calls, 0);
  assert.equal(service.getState().activeRun, null);
  assert.equal(runtime.broker.snapshot().lease_count, 0);
});

test('a request cancellation while waiting removes the waiter before producer dispatch', async () => {
  const root = createTrackedTempDir('jenny-test-cancelled-waiter-');
  const runtime = createRuntime();
  const holder = await runtime.broker.acquire({
    ownerId: 'test-holder', resources: [capacityResource('tests')],
  });
  const controller = new AbortController();
  let calls = 0;
  const service = makeService(() => root, runtime, {
    runTestCommand: async () => { calls += 1; return completed(); },
  });
  const pending = service.run({ configId: 'unit', initiator: 'jenny' }, {
    root,
    configs: [{ id: 'unit', label: 'Unit', command: 'npm test', cwd: '.' }],
    history: null,
    abortSignal: controller.signal,
    assertCurrent() {},
  });
  await nextTurn();
  assert.equal(runtime.broker.snapshot().waiter_count, 1);

  controller.abort(new Error('model cancelled'));
  await assert.rejects(pending, /model cancelled/);
  runtime.broker.release(holder, { producerSettled: true });
  assert.equal(calls, 0);
  assert.equal(service.getState().activeRun, null);
  assert.equal(runtime.broker.snapshot().lease_count, 0);
});

test('a queued cwd junction replacement is rejected before producer dispatch', async () => {
  const base = createTrackedTempDir('jenny-test-cwd-swap-');
  const root = path.join(base, 'root');
  const inside = path.join(root, 'inside');
  const outside = path.join(base, 'outside');
  const alias = path.join(root, 'work');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(inside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const runtime = createRuntime();
  const holder = await runtime.broker.acquire({
    ownerId: 'test-holder', resources: [capacityResource('tests')],
  });
  let calls = 0;
  const service = makeService(() => root, runtime, {
    runTestCommand: async () => { calls += 1; return completed(); },
  }, [{ id: 'unit', label: 'Unit', command: 'npm test', cwd: 'work' }]);

  const pending = service.run({ configId: 'unit' });
  await nextTurn();
  fs.rmSync(alias, { recursive: true, force: true });
  fs.symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  runtime.broker.release(holder, { producerSettled: true });

  await assert.rejects(pending, /working directory|authority changed/i);
  assert.equal(calls, 0);
  assert.equal(service.getState().activeRun, null);
  assert.equal(runtime.broker.snapshot().lease_count, 0);
});

test('an unscoped root change while waiting rejects before producer dispatch', async () => {
  const base = createTrackedTempDir('jenny-test-stale-root-');
  const firstRoot = path.join(base, 'first');
  const secondRoot = path.join(base, 'second');
  fs.mkdirSync(firstRoot);
  fs.mkdirSync(secondRoot);
  const runtime = createRuntime();
  const holder = await runtime.broker.acquire({
    ownerId: 'test-holder', resources: [capacityResource('tests')],
  });
  let root = firstRoot;
  let calls = 0;
  const service = makeService(() => root, runtime, {
    runTestCommand: async () => { calls += 1; return completed(); },
  });

  const pending = service.run({ configId: 'unit' });
  await nextTurn();
  root = secondRoot;
  runtime.broker.release(holder, { producerSettled: true });

  await assert.rejects(pending, /authority changed/);
  assert.equal(calls, 0);
  assert.equal(runtime.broker.snapshot().lease_count, 0);
});

test('a thrown dispatched producer quarantines resources and retains run ownership', async () => {
  const root = createTrackedTempDir('jenny-test-throw-');
  const runtime = createRuntime();
  const service = makeService(() => root, runtime, {
    runTestCommand: async () => { throw new Error('runner transport failed'); },
  });

  await assert.rejects(service.run({ configId: 'unit' }), /runner transport failed/);
  assert.equal(runtime.broker.snapshot().quarantined_count, 1);
  assert.equal(service.getState().activeRun, 'run-1');
  assert.deepEqual(await service.abortAndWait(), {
    aborted: true,
    runId: 'run-1',
    terminationConfirmed: false,
    reason: 'kill_unconfirmed',
  });
});

test('late retry proof confirms a quarantined lease once for concurrent cleanup callers', async () => {
  const root = createTrackedTempDir('jenny-test-retry-');
  const runtime = createRuntime();
  const retry = deferred();
  let retryCalls = 0;
  const service = makeService(() => root, runtime, {
    runTestCommand: async () => completed({
      status: 'timeout',
      terminationConfirmed: false,
      retryTermination: () => { retryCalls += 1; return retry.promise; },
    }),
  });

  const runResult = await service.run({ configId: 'unit' });
  assert.equal(runResult.terminationConfirmed, false);
  assert.equal(runtime.broker.snapshot().quarantined_count, 1);
  const firstCleanup = service.abortAndWait();
  const secondCleanup = service.abortAndWait();
  await nextTurn();
  assert.equal(retryCalls, 1);

  retry.resolve({ confirmed: true });
  assert.equal((await firstCleanup).terminationConfirmed, true);
  assert.equal((await secondCleanup).terminationConfirmed, true);
  assert.equal(service.getState().activeRun, null);
  assert.equal(runtime.broker.snapshot().lease_count, 0);
});

test('a resource-enabled result without termination proof remains quarantined', async () => {
  const root = createTrackedTempDir('jenny-test-missing-proof-');
  const runtime = createRuntime();
  const resultWithoutProof = completed();
  delete resultWithoutProof.terminationConfirmed;
  const service = makeService(() => root, runtime, {
    runTestCommand: async () => resultWithoutProof,
  });

  const result = await service.run({ configId: 'unit' });
  assert.equal(result.terminationConfirmed, false);
  assert.equal(runtime.broker.snapshot().quarantined_count, 1);
  assert.equal(service.getState().activeRun, 'run-1');
});

test('a declared unavailable provider fails closed without dispatching the runner', async () => {
  const root = createTrackedTempDir('jenny-test-provider-');
  let calls = 0;
  const service = createWorkspaceTestRunnerService({
    runner: { runTestCommand: async () => { calls += 1; return completed(); } },
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', command: 'npm test', cwd: '.' }],
    resourceAdmissionProvider: () => null,
  });

  await assert.rejects(service.run({ configId: 'unit' }), /resource admission is unavailable/);
  assert.equal(calls, 0);
  assert.equal(service.getState().activeRun, null);
});
