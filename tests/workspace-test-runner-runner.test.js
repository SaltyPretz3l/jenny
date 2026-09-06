'use strict';
// SPEC: Workspace Test Runner P0 — the headless spawn primitive.
//   S1 (Behavior/Architecture) — structured result with the run fields + status enum.
//   S2 (Behavior) — exit code -> status; spawn-never-started -> 'error' + CMP code.
//   S3 (Architecture/Reliability) — runs THROUGH a shell; env sanitized + user env merged on top.
//   S11 (Reliability) — a timeout bounds the run; an exceeded run is killed + recorded 'timeout'.
//   S12 (Performance/Reliability) — the output tail is capped AND token-redacted.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runTestCommand } = require('../services/backend/workspace-test-runner-runner');
const { WORKSPACE_TEST_RUNNER_ERROR_CODES } = require('../services/backend/error-codes');
const { MAX_TEST_TIMEOUT_MS } = require('../services/workspace-test-runner-config');

// Minimal fake child + spawn: registers on/once handlers and lets the test drive
// stdout/stderr/close/error. spawn is synchronous, so emitting AFTER the call
// reaches the already-registered handlers.
function makeFakeChild() {
  const bags = { stdout: {}, stderr: {}, child: {} };
  const reg = (bag) => (event, cb) => { (bag[event] = bag[event] || []).push(cb); };
  const fire = (bag, event, ...args) => (bag[event] || []).slice().forEach((cb) => cb(...args));
  const child = {
    pid: 4242,
    killed: false,
    stdout: { on: reg(bags.stdout) },
    stderr: { on: reg(bags.stderr) },
    on: reg(bags.child),
    once: reg(bags.child),
    kill() { this.killed = true; },
  };
  return {
    child,
    emitStdout: (chunk) => fire(bags.stdout, 'data', chunk),
    emitStderr: (chunk) => fire(bags.stderr, 'data', chunk),
    emitError: (err) => fire(bags.child, 'error', err),
    emitClose: (code, signal) => fire(bags.child, 'close', code, signal),
  };
}

function fixedClock(startMs, finishMs) {
  const queue = [new Date(startMs), new Date(finishMs)];
  let i = 0;
  return () => queue[Math.min(i++, queue.length - 1)];
}

test('s1/s2: exit code 0 yields a passed structured result', async () => {
  // RED-BECAUSE: runTestCommand rejects with NotImplementedError (no body yet).
  const fc = makeFakeChild();
  const promise = runTestCommand({
    command: 'npm test',
    cwd: '/work',
    spawn: () => fc.child,
    now: fixedClock(1000, 2500),
    outputLimit: 1000,
  });
  fc.emitStdout('ok\n');
  fc.emitClose(0, null);
  const result = await promise;
  assert.equal(result.status, 'passed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.durationMs, 1500);
  assert.equal(result.startedAt, new Date(1000).toISOString());
  assert.equal(result.finishedAt, new Date(2500).toISOString());
  assert.equal(result.stdoutTail, 'ok\n', 'the captured tail is exactly what was emitted');
});

test('s2: a non-zero exit code maps to failed', async () => {
  // RED-BECAUSE: runTestCommand rejects (no body yet).
  const fc = makeFakeChild();
  const promise = runTestCommand({ command: 'npm test', spawn: () => fc.child, now: fixedClock(0, 10) });
  fc.emitClose(1, null);
  const result = await promise;
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
});

test('s2: a spawn that never starts (ENOENT) records error + SPAWN_FAILED', async () => {
  // RED-BECAUSE: runTestCommand rejects (no body yet).
  const fc = makeFakeChild();
  const promise = runTestCommand({ command: 'nope', spawn: () => fc.child, now: fixedClock(0, 5) });
  fc.emitError(Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }));
  const result = await promise;
  assert.equal(result.status, 'error', 'a process that never ran is "error", not "failed"');
  assert.equal(result.errorCode, WORKSPACE_TEST_RUNNER_ERROR_CODES.SPAWN_FAILED);
  assert.equal(result.exitCode, null);
});

test('s2: a synchronous spawn throw also records error + SPAWN_FAILED', async () => {
  // RED-BECAUSE: runTestCommand rejects (no body yet).
  const result = await runTestCommand({
    command: 'boom',
    spawn: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    now: fixedClock(0, 1),
  });
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, WORKSPACE_TEST_RUNNER_ERROR_CODES.SPAWN_FAILED);
});

test('s2: a signal-killed child (null exit code) is failed, never passed', async () => {
  // A crash / OS-kill / OOM closes with exitCode=null + a signal — NOT a clean
  // exit. It must record 'failed'; `Number(null || 0) === 0` would mis-map it to
  // 'passed' (a green segfaulting suite). Regression guard for that bug.
  const fc = makeFakeChild();
  const promise = runTestCommand({ command: 'segfaulter', spawn: () => fc.child, now: fixedClock(0, 10) });
  fc.emitClose(null, 'SIGKILL');
  const result = await promise;
  assert.equal(result.status, 'failed', 'a null exit code (signal kill) is a failure, not a pass');
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
});

test('s14: an already-aborted signal settles as aborted without spawning', async () => {
  // The pre-spawn guard: an AbortSignal that is already aborted means no child
  // is spawned at all.
  let spawned = false;
  const controller = new AbortController();
  controller.abort();
  const result = await runTestCommand({
    command: 'npm test',
    spawn: () => { spawned = true; return makeFakeChild().child; },
    abortSignal: controller.signal,
    now: fixedClock(0, 2),
  });
  assert.equal(result.status, 'aborted');
  assert.equal(spawned, false, 'an already-aborted run never spawns a process');
});

test('s14: aborting a live run kills the tree, records aborted, and ignores a later close', async () => {
  // Post-spawn abort path + the `settled` idempotency guard: a late 'close' from
  // the dying process must NOT overwrite the aborted result with 'passed'.
  const fc = makeFakeChild();
  const controller = new AbortController();
  let killedChild = null;
  const promise = runTestCommand({
    command: 'sleep 999',
    spawn: () => fc.child,
    abortSignal: controller.signal,
    now: fixedClock(0, 7),
    killProcessTree: (child) => { killedChild = child; return { terminated: true }; },
  });
  controller.abort();
  fc.emitClose(0, null);   // the late close is ignored because the run already settled
  const result = await promise;
  assert.equal(result.status, 'aborted', 'a post-spawn abort wins, and the later close cannot flip it');
  assert.equal(killedChild, fc.child, 'the process tree is killed on abort');
});

test('wide-016: abort waits for async tree termination confirmation before settling', async () => {
  const fc = makeFakeChild();
  const controller = new AbortController();
  let confirmKill;
  const killGate = new Promise((resolve) => { confirmKill = resolve; });
  let settled = false;
  const promise = runTestCommand({
    command: 'sleep 999',
    spawn: () => fc.child,
    abortSignal: controller.signal,
    now: fixedClock(0, 7),
    killProcessTree: () => killGate,
  });
  promise.then(() => { settled = true; });

  controller.abort();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false, 'the run lock must stay live while tree termination is unconfirmed');

  confirmKill({ terminated: true });
  fc.emitClose(null, 'SIGKILL');
  const result = await promise;
  assert.equal(result.status, 'aborted');
  assert.equal(result.terminationConfirmed, true);
});

test('wide-016: a failed kill stays unconfirmed and exposes a retry without claiming tree death', async () => {
  const fc = makeFakeChild();
  const controller = new AbortController();
  let killCalls = 0;
  const promise = runTestCommand({
    command: 'sleep 999',
    spawn: () => fc.child,
    abortSignal: controller.signal,
    now: fixedClock(0, 7),
    killProcessTree: () => {
      killCalls += 1;
      if (killCalls === 1) return Promise.reject(new Error('taskkill failed'));
      return Promise.resolve({ terminated: true });
    },
  });

  controller.abort();
  const result = await promise;
  assert.equal(result.status, 'aborted');
  assert.equal(result.terminationConfirmed, false, 'kill failure cannot masquerade as confirmed tree death');
  assert.equal(result.terminationWarning, 'kill_failed');
  assert.equal(typeof result.retryTermination, 'function');
  assert.deepEqual(await result.retryTermination(), { confirmed: true });
  assert.equal(killCalls, 2);
});

test('s3: the command runs through a shell (shell:true, command unmodified)', async () => {
  // RED-BECAUSE: runTestCommand rejects, so spawn is never invoked.
  const fc = makeFakeChild();
  let spawnArgs = null;
  const promise = runTestCommand({
    command: 'npm test && echo done',
    cwd: '/work',
    spawn: (...args) => { spawnArgs = args; return fc.child; },
    now: fixedClock(0, 1),
  });
  fc.emitClose(0, null);
  await promise;
  assert.ok(spawnArgs, 'spawn was called');
  assert.equal(spawnArgs.length, 3, 'spawn(command, args, options) — the canonical 3-arg shape');
  assert.equal(spawnArgs[0], 'npm test && echo done', 'the full command reaches the shell unmodified');
  assert.deepEqual(spawnArgs[1], [], 'args is empty — the command string carries everything to the shell');
  const options = spawnArgs[2];
  assert.equal(options.shell, true, 'runs through a shell so &&/venv/npm test work as typed');
  assert.equal(options.cwd, '/work');
});

test('s3: env is sanitized (JENNY_*/credentials dropped) and user env merged on top', async () => {
  // RED-BECAUSE: runTestCommand rejects, so the env is never assembled.
  const fc = makeFakeChild();
  let options = null;
  const promise = runTestCommand({
    command: 'pytest',
    spawn: (_cmd, _args, opts) => { options = opts; return fc.child; },
    env: { PATH: '/bin', FOO: 'bar', JENNY_SECRET: 'leak', API_KEY: 'sk-live' },
    userEnv: { MY_VAR: '1', JENNY_OVERRIDE: 'explicit', ACCESS_TOKEN: 'user-explicit' },
    now: fixedClock(0, 1),
  });
  fc.emitClose(0, null);
  await promise;
  assert.equal(options.env.PATH, '/bin', 'system keys survive');
  assert.equal(options.env.FOO, 'bar', 'benign keys survive');
  assert.equal(options.env.MY_VAR, '1', 'user keys are added');
  assert.equal(options.env.JENNY_OVERRIDE, 'explicit', 'an explicit user key survives the JENNY_ deny pass');
  // The deny pass runs on the BASE env only; explicit user keys are layered on
  // top afterward and always win — even credential-shaped ones the user authored.
  assert.equal(options.env.ACCESS_TOKEN, 'user-explicit', 'an explicit user credential-shaped key survives the deny pass');
  assert.equal('JENNY_SECRET' in options.env, false, 'JENNY_* base keys are denied');
  assert.equal('API_KEY' in options.env, false, 'credential-shaped base keys are denied');
});

test('s11: a run that exceeds the timeout is killed and recorded as timeout', async () => {
  // RED-BECAUSE: runTestCommand rejects, so no timer/kill path runs.
  const fc = makeFakeChild();
  let killedChild = null;
  const result = await runTestCommand({
    command: 'sleep 999',
    spawn: () => fc.child,                 // never emits close
    now: fixedClock(0, 30),
    timeoutMs: 20,
    killProcessTree: (child) => { killedChild = child; return { terminated: true }; },
  });
  assert.equal(result.status, 'timeout');
  assert.equal(result.exitCode, null);
  assert.equal(killedChild, fc.child, 'the process tree is killed on timeout');
});

test('wide-034: execution clamps an oversized timeout before calling the Node timer API', async () => {
  const fc = makeFakeChild();
  let scheduledDelay = null;
  const promise = runTestCommand({
    command: 'npm test',
    spawn: () => fc.child,
    now: fixedClock(0, 1),
    timeoutMs: 2 ** 31,
    setTimeoutImpl: (_callback, delay) => {
      scheduledDelay = delay;
      return { unref() {} };
    },
    clearTimeoutImpl: () => {},
  });
  assert.equal(scheduledDelay, MAX_TEST_TIMEOUT_MS);
  fc.emitClose(0, null);
  assert.equal((await promise).status, 'passed');
});

test('s12: the output tail is capped to outputLimit', async () => {
  // RED-BECAUSE: runTestCommand rejects (no tail accumulation yet).
  const fc = makeFakeChild();
  const promise = runTestCommand({ command: 'noisy', spawn: () => fc.child, now: fixedClock(0, 1), outputLimit: 100 });
  fc.emitStdout('x'.repeat(20000));
  fc.emitClose(0, null);
  const result = await promise;
  assert.equal(result.stdoutTail.length, 100, 'a chatty suite cannot grow the tail past the cap');
});

test('s12: tokens in streamed output are redacted before they surface', async () => {
  // RED-BECAUSE: runTestCommand rejects (no redaction yet).
  const fc = makeFakeChild();
  const promise = runTestCommand({ command: 'leaky', spawn: () => fc.child, now: fixedClock(0, 1), outputLimit: 10000 });
  fc.emitStderr('error: token sk-abcdefghijklmnopqrstuvwxyz expired');
  fc.emitClose(1, null);
  const result = await promise;
  // Exact whole-tail oracle: a partial-`includes` check would still pass if the
  // masker left more of the token exposed. The masked form is `sk-***wxyz`.
  assert.equal(result.stderrTail, 'error: token sk-***wxyz expired', 'the whole tail is masked exactly');
  assert.equal(result.stderrTail.includes('sk-abcdefghijklmnop'), false, 'the raw token never surfaces');
});
