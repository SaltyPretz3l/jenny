'use strict';
// UIUX-014: WorkspaceRunTaskService orchestration - single-task lock, root
// precondition, taskId-stamped bridge events, kill-by-taskId, and awaited
// dispose (never orphans a running task's process tree).

const test = require('node:test');
const assert = require('node:assert/strict');

const { WorkspaceRunTaskService } = require('../services/workspace-run-task-service');
const { RUN_TASK_ERROR_CODES } = require('../services/backend/error-codes');

// A controllable fake runner: startRunTask-shaped ({done, kill}), driven by
// the test via resolve()/settle() rather than a real child process.
function fakeRunner() {
  const calls = [];
  const controllers = [];
  function runnerImpl(opts) {
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const record = {
      opts, kills: 0,
      settle: (result) => resolveDone(result),
      kill: async () => {
        record.kills += 1;
        record.settle({ status: 'killed', exitCode: null, signal: 'SIGTERM' });
        return { terminated: true };
      },
    };
    calls.push(opts);
    controllers.push(record);
    return { done, kill: record.kill };
  }
  return { runnerImpl, calls, controllers };
}

function fixture({ root = 'C:/ws', runner = fakeRunner() } = {}) {
  const events = [];
  const service = new WorkspaceRunTaskService({
    configService: { getToolsWorkspaceRoot: () => root },
    sendBridgeEvent: (key, payload) => events.push({ key, payload }),
    runnerImpl: runner.runnerImpl,
    scheduleOutputFlush: (cb) => { cb(); return null; }, // synchronous flush for deterministic assertions
  });
  return { service, events, runner };
}

test('start() assigns a main-owned taskId and spawns cwd-pinned to the workspace root', async () => {
  const { service, runner } = fixture();
  const result = await service.start({ command: "node 'src/app.js'", label: 'node app.js' });
  assert.equal(result.ok, true);
  assert.match(result.taskId, /^run-\d+$/);
  assert.equal(result.cwd, 'C:/ws');
  assert.equal(runner.calls[0].command, "node 'src/app.js'");
  assert.equal(runner.calls[0].cwd, 'C:/ws');
});

test('a second start() while a task is active is refused with ALREADY_RUNNING, never queued or reused', async () => {
  const { service, runner } = fixture();
  await service.start({ command: 'node a.js' });
  const second = await service.start({ command: 'node b.js' });
  assert.equal(second.ok, false);
  assert.equal(second.code, RUN_TASK_ERROR_CODES.ALREADY_RUNNING);
  assert.equal(runner.calls.length, 1, 'no second process was spawned');
});

test('start() without a configured root fails with ROOT_MISSING and never spawns', async () => {
  const { service, runner } = fixture({ root: '' });
  const result = await service.start({ command: 'node a.js' });
  assert.equal(result.ok, false);
  assert.equal(result.code, RUN_TASK_ERROR_CODES.ROOT_MISSING);
  assert.equal(runner.calls.length, 0);
});

test('onData bridge events are stamped with the taskId (never require content sniffing to attribute)', async () => {
  const { service, events, runner } = fixture();
  const result = await service.start({ command: 'node a.js' });
  runner.controllers[0].opts.onData('stdout', 'compiling…\n');
  const dataEvent = events.find((e) => e.key === 'workspaceRunTask.onData');
  assert.ok(dataEvent);
  assert.equal(dataEvent.payload.taskId, result.taskId);
  assert.equal(dataEvent.payload.stream, 'stdout');
  assert.equal(dataEvent.payload.chunk, 'compiling…\n');
});

test('JCA-009: interleaved stdout/stderr run output delivers in arrival order', async () => {
  // The run-task lane shares the terminal output queue; whole-batch stream
  // grouping used to deliver stdout A+C before stderr B, misstating
  // compiler/test output order in the panel.
  const runner = fakeRunner();
  const flushes = [];
  const events = [];
  const service = new WorkspaceRunTaskService({
    configService: { getToolsWorkspaceRoot: () => 'C:/ws' },
    sendBridgeEvent: (key, payload) => events.push({ key, payload }),
    runnerImpl: runner.runnerImpl,
    // Defer the flush so all three chunks land in ONE batch.
    scheduleOutputFlush: (cb) => { flushes.push(cb); return null; },
  });
  await service.start({ command: 'node a.js' });
  runner.controllers[0].opts.onData('stdout', 'A');
  runner.controllers[0].opts.onData('stderr', 'B');
  runner.controllers[0].opts.onData('stdout', 'C');
  for (const cb of flushes.splice(0)) cb();

  const dataEvents = events.filter((e) => e.key === 'workspaceRunTask.onData');
  assert.deepEqual(
    dataEvents.map((e) => [e.payload.stream, e.payload.chunk]),
    [['stdout', 'A'], ['stderr', 'B'], ['stdout', 'C']],
    'run order survives batching across the stdout/stderr boundary'
  );
});

test('the real exit settles onExit with the true exit code, and a new start() is now allowed', async () => {
  const { service, events, runner } = fixture();
  const result = await service.start({ command: 'node a.js' });
  runner.controllers[0].settle({ status: 'exited', exitCode: 2, signal: null });
  await new Promise((resolve) => setImmediate(resolve));
  const exitEvent = events.find((e) => e.key === 'workspaceRunTask.onExit');
  assert.equal(exitEvent.payload.taskId, result.taskId);
  assert.equal(exitEvent.payload.code, 2);
  assert.equal(service.hasActiveTask(), false);
  const again = await service.start({ command: 'node b.js' });
  assert.equal(again.ok, true, 'settlement released the single-task lock');
});

test('kill({taskId}) targets the RIGHT task by id and is a structured no-op for a stale/unknown id', async () => {
  const { service, runner } = fixture();
  const result = await service.start({ command: 'node a.js' });
  const staleKill = await service.kill({ taskId: 'run-999' });
  assert.equal(staleKill.killed, false, 'a stale/unknown id never touches the live task');
  assert.equal(runner.controllers[0].kills, 0);
  const realKill = await service.kill({ taskId: result.taskId });
  assert.equal(realKill.killed, true);
  assert.equal(runner.controllers[0].kills, 1);
});

// A runner whose termination is unconfirmed until the test flips `confirming`:
// the first attempt settles `done` as killed + terminationConfirmed:false (as
// the real runner does), later attempts return their real outcome.
function unconfirmedRunner() {
  const state = { confirming: false, kills: 0, calls: [] };
  function runnerImpl(opts) {
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    let resolved = false;
    state.calls.push(opts);
    return {
      done,
      kill: async () => {
        state.kills += 1;
        if (!resolved) {
          resolved = true;
          resolveDone({ status: 'killed', exitCode: null, signal: 'SIGTERM', terminationConfirmed: state.confirming });
        }
        return { terminated: state.confirming };
      },
    };
  }
  return { runnerImpl, state };
}

test('P03: an unconfirmed kill keeps ownership, refuses start(), and a later confirmed kill releases it', async () => {
  const runner = unconfirmedRunner();
  const logs = [];
  const events = [];
  const service = new WorkspaceRunTaskService({
    configService: { getToolsWorkspaceRoot: () => 'C:/ws' },
    sendBridgeEvent: (key, payload) => events.push({ key, payload }),
    runnerImpl: runner.runnerImpl,
    logger: (level, event) => logs.push([level, event]),
    scheduleOutputFlush: (cb) => { cb(); return null; },
  });
  const started = await service.start({ command: 'node a.js' });
  const first = await service.kill({ taskId: started.taskId });
  assert.deepEqual(first, { killed: false, terminationConfirmed: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(service.hasActiveTask(), true, 'an unconfirmed tree keeps the root-change blocker alive');
  assert.deepEqual(logs.filter(([, event]) => event === 'workspace_run_task.termination_unconfirmed'),
    [['WARN', 'workspace_run_task.termination_unconfirmed']]);
  assert.equal(events.filter((e) => e.key === 'workspaceRunTask.onExit').length, 1, 'onExit is still emitted once');

  const refused = await service.start({ command: 'node b.js' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, RUN_TASK_ERROR_CODES.ALREADY_RUNNING);
  assert.equal(refused.message, 'The previous task could not be confirmed stopped, so a new one was not started. Try again once it has ended.');
  assert.equal(runner.state.calls.length, 1, 'no second process was spawned');
  assert.equal(runner.state.kills, 2, 'start() retried the kill once');

  runner.state.confirming = true;
  const retried = await service.kill({ taskId: started.taskId });
  assert.deepEqual(retried, { killed: true, terminationConfirmed: true });
  assert.equal(service.hasActiveTask(), false);
  const again = await service.start({ command: 'node c.js' });
  assert.equal(again.ok, true);
});

test('P03: start() over an unconfirmed task proceeds when its retried kill now confirms', async () => {
  const runner = unconfirmedRunner();
  const service = new WorkspaceRunTaskService({
    configService: { getToolsWorkspaceRoot: () => 'C:/ws' },
    runnerImpl: runner.runnerImpl,
    scheduleOutputFlush: (cb) => { cb(); return null; },
  });
  const started = await service.start({ command: 'node a.js' });
  await service.kill({ taskId: started.taskId });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.hasActiveTask(), true);

  runner.state.confirming = true;
  const next = await service.start({ command: 'node b.js' });
  assert.equal(next.ok, true);
  assert.notEqual(next.taskId, started.taskId);
  assert.equal(runner.state.calls.length, 2);
});

test('P03: dispose() reports unconfirmed while the tree is unconfirmed and stays retryable', async () => {
  const runner = unconfirmedRunner();
  const service = new WorkspaceRunTaskService({
    configService: { getToolsWorkspaceRoot: () => 'C:/ws' },
    runnerImpl: runner.runnerImpl,
    scheduleOutputFlush: (cb) => { cb(); return null; },
  });
  await service.start({ command: 'node a.js' });
  const first = await service.dispose();
  assert.deepEqual(first, { disposed: false, terminationConfirmed: false });
  await new Promise((resolve) => setImmediate(resolve));
  runner.state.confirming = true;
  const second = await service.dispose();
  assert.deepEqual(second, { disposed: true, terminationConfirmed: true });
  assert.equal(service.hasActiveTask(), false);
});

test('dispose() awaits killing an active task so shutdown never orphans its process tree', async () => {
  const { service, runner } = fixture();
  await service.start({ command: 'node a.js' });
  const outcome = await service.dispose();
  assert.equal(outcome.disposed, true);
  assert.equal(runner.controllers[0].kills, 1);
});

test('dispose() with no active task resolves immediately (no-op)', async () => {
  const { service } = fixture();
  const outcome = await service.dispose();
  assert.equal(outcome.disposed, true);
  assert.equal(outcome.terminationConfirmed, true);
});

test('start() after dispose() is refused (service does not resurrect after shutdown began)', async () => {
  const { service } = fixture();
  await service.dispose();
  await assert.rejects(() => service.start({ command: 'node a.js' }), /disposed/i);
});
