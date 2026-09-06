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
