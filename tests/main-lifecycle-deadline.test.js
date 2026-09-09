const test = require('node:test');
const assert = require('node:assert/strict');

const { MainLifecycleController } = require('../services/main-lifecycle');

function createTimerHarness() {
  const scheduled = [];
  const cleared = [];
  return {
    scheduled,
    cleared,
    setTimeoutImpl(callback, delayMs) {
      const handle = { callback, delayMs };
      scheduled.push(handle);
      return handle;
    },
    clearTimeoutImpl(handle) {
      cleared.push(handle);
    },
    fire(index = 0) {
      scheduled[index].callback();
    },
  };
}

test('graceful shutdown shares a deadline context and removes its timer', async () => {
  const timers = createTimerHarness();
  const contexts = [];
  const exitCalls = [];
  const lifecycle = new MainLifecycleController({
    appExit: (code) => exitCalls.push(code),
    shutdownTimeoutMs: 2_500,
    nowImpl: () => 10_000,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    stopRuntime: async (context) => contexts.push(context),
  });
  lifecycle.registerShutdownTask(async (context) => contexts.push(context));

  await lifecycle.handleBeforeQuit({ preventDefault() {} });

  assert.equal(timers.scheduled[0].delayMs, 2_500);
  assert.deepEqual(timers.cleared, [timers.scheduled[0]]);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0], contexts[1]);
  assert.equal(Object.isFrozen(contexts[0]), true);
  assert.equal(contexts[0].deadlineAt, 12_500);
  assert.equal(contexts[0].signal.aborted, false);
  assert.deepEqual(exitCalls, [0]);
});

test('shutdown timeout is finite, integer-normalized, and clamped', async () => {
  const cases = [
    { input: Number.NaN, expected: 15_000 },
    { input: '2500', expected: 15_000 },
    { input: 15.9, expected: 1_000 },
    { input: 500_000, expected: 120_000 },
  ];

  for (const { input, expected } of cases) {
    const timers = createTimerHarness();
    const lifecycle = new MainLifecycleController({
      appExit() {},
      stopRuntime: async () => {},
      shutdownTimeoutMs: input,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });

    await lifecycle.requestEmergencyShutdown({ exitCode: 0 });
    assert.equal(timers.scheduled[0].delayMs, expected);
  }
});

test('reentrant shutdown returns one promise and preserves the first exit code', async () => {
  const timers = createTimerHarness();
  const exitCalls = [];
  let releaseRuntime;
  const runtimeGate = new Promise((resolve) => {
    releaseRuntime = resolve;
  });
  const lifecycle = new MainLifecycleController({
    appExit: (code) => exitCalls.push(code),
    stopRuntime: () => runtimeGate,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  const first = lifecycle.requestEmergencyShutdown({ exitCode: 7 });
  const second = lifecycle.handleBeforeQuit({ preventDefault() {} });

  assert.equal(first, second);
  releaseRuntime();
  await first;
  assert.deepEqual(exitCalls, [7]);
});

test('shutdown promise is published before a task can synchronously re-enter quit', async () => {
  const timers = createTimerHarness();
  const exitCalls = [];
  let reentrantPromise;
  const lifecycle = new MainLifecycleController({
    appExit: (code) => exitCalls.push(code),
    stopRuntime: async () => {},
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  lifecycle.registerShutdownTask(() => {
    reentrantPromise = lifecycle.requestEmergencyShutdown({ exitCode: 9 });
  });

  const shutdown = lifecycle.handleBeforeQuit({ preventDefault() {} });
  await shutdown;

  assert.equal(reentrantPromise, shutdown);
  assert.deepEqual(exitCalls, [0]);
});

test('deadline aborts a hung task before emergency cleanup and fences later work', async () => {
  const timers = createTimerHarness();
  const logs = [];
  const order = [];
  const exitCalls = [];
  let rejectTask;
  let taskContext;
  const taskGate = new Promise((_resolve, reject) => {
    rejectTask = reject;
  });
  const lifecycle = new MainLifecycleController({
    appExit: (code) => exitCalls.push(code),
    stopRuntime: async () => order.push('runtime'),
    shutdownTimeoutMs: 4_000,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    log: (level, event, details) => logs.push({ level, event, details }),
    onEmergencyShutdown: ({ reason }) => {
      assert.equal(taskContext.signal.aborted, true);
      order.push(`emergency:${reason}`);
      throw new Error('emergency cleanup failed');
    },
  });
  lifecycle.registerShutdownTask(async (context) => {
    taskContext = context;
    order.push('task:start');
    await taskGate;
    order.push('task:late');
  });
  lifecycle.registerShutdownTask(async () => order.push('task:second'));

  const shutdown = lifecycle.handleBeforeQuit({ preventDefault() {} });
  await Promise.resolve();
  timers.fire();
  await shutdown;

  assert.deepEqual(order, ['task:start', 'emergency:deadline_exceeded']);
  assert.deepEqual(exitCalls, [0]);
  assert.deepEqual(
    logs.find(({ event }) => event === 'app.shutdown_deadline_exceeded'),
    {
      level: 'WARN',
      event: 'app.shutdown_deadline_exceeded',
      details: { timeoutMs: 4_000, phase: 'shutdown_tasks', taskIndex: 0 },
    }
  );
  assert.equal(
    logs.some(({ event }) => event === 'app.emergency_shutdown_failed'),
    true
  );

  rejectTask(new Error('late task rejection'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ['task:start', 'emergency:deadline_exceeded']);
  assert.deepEqual(exitCalls, [0]);
});

test('deadline fences a late runtime rejection and exits only once', async () => {
  const timers = createTimerHarness();
  const exitCalls = [];
  const emergencyReasons = [];
  let rejectRuntime;
  let runtimeContext;
  const runtimeGate = new Promise((_resolve, reject) => {
    rejectRuntime = reject;
  });
  const lifecycle = new MainLifecycleController({
    appExit: (code) => exitCalls.push(code),
    stopRuntime: (context) => {
      runtimeContext = context;
      return runtimeGate;
    },
    onEmergencyShutdown: ({ reason }) => emergencyReasons.push(reason),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  const shutdown = lifecycle.requestEmergencyShutdown({ exitCode: 3 });
  await Promise.resolve();
  timers.fire();
  await shutdown;

  assert.equal(runtimeContext.signal.aborted, true);
  assert.deepEqual(emergencyReasons, ['deadline_exceeded']);
  assert.deepEqual(exitCalls, [3]);

  rejectRuntime(new Error('late runtime rejection'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(emergencyReasons, ['deadline_exceeded']);
  assert.deepEqual(exitCalls, [3]);
});

test('runtime rejection is contained, logged with bounded detail, and falls back once', async () => {
  const timers = createTimerHarness();
  const logs = [];
  const emergencyReasons = [];
  const exitCalls = [];
  const lifecycle = new MainLifecycleController({
    appExit: (code) => exitCalls.push(code),
    stopRuntime: async () => {
      throw new Error(`token=super-secret-token-value ${'x'.repeat(400)}`);
    },
    onEmergencyShutdown: ({ reason }) => emergencyReasons.push(reason),
    log: (level, event, details) => logs.push({ level, event, details }),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  await lifecycle.handleBeforeQuit({ preventDefault() {} });

  const failure = logs.find(({ event }) => event === 'app.runtime_shutdown_failed');
  assert.equal(failure.level, 'ERROR');
  assert.equal(failure.details.message.length, 200);
  assert.equal(failure.details.message.includes('super-secret-token-value'), false);
  assert.equal(failure.details.message.includes('[redacted]'), true);
  assert.deepEqual(emergencyReasons, ['runtime_failed']);
  assert.deepEqual(exitCalls, [0]);
  assert.deepEqual(timers.cleared, [timers.scheduled[0]]);
});
