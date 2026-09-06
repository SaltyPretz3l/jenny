'use strict';
// UIUX-014: the headless spawn primitive for "Run scripts" tasks. Each task
// is its OWN child process (not the shared interactive terminal session), so
// completion is the real 'close' event - never text scanned out of stdout.
// Covers: explicit shell selection (matches workspace-terminal-service.js),
// live streaming onData, real exit code -> 'exited', spawn failure -> 'error'
// + SPAWN_FAILED, and process-tree kill via the injected killProcessTree.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const { startRunTask } = require('../services/backend/workspace-run-task-runner');
const { RUN_TASK_ERROR_CODES } = require('../services/backend/error-codes');

function makeFakeChild() {
  const bags = { stdout: {}, stderr: {}, child: {} };
  const reg = (bag) => (event, cb) => { (bag[event] = bag[event] || []).push(cb); };
  const fire = (bag, event, ...args) => (bag[event] || []).slice().forEach((cb) => cb(...args));
  const child = {
    pid: 4242,
    stdout: { on: reg(bags.stdout), setEncoding() {} },
    stderr: { on: reg(bags.stderr), setEncoding() {} },
    on: reg(bags.child),
  };
  return {
    child,
    emitStdout: (chunk) => fire(bags.stdout, 'data', chunk),
    emitStderr: (chunk) => fire(bags.stderr, 'data', chunk),
    emitError: (err) => fire(bags.child, 'error', err),
    emitClose: (code, signal) => fire(bags.child, 'close', code, signal),
  };
}

test('spawns an explicit PowerShell shell on win32 with the command as ONE -Command argument', () => {
  const fc = makeFakeChild();
  const spawns = [];
  startRunTask({
    command: "node 'src/app.js'",
    cwd: 'C:/ws',
    platform: 'win32',
    spawnImpl: (shell, args, options) => { spawns.push({ shell, args, options }); return fc.child; },
  });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].shell, 'powershell.exe');
  assert.deepEqual(spawns[0].args, ['-NoLogo', '-NoProfile', '-Command', "node 'src/app.js'"]);
  assert.equal(spawns[0].options.cwd, 'C:/ws');
  assert.equal(spawns[0].options.detached, false);
  assert.deepEqual(spawns[0].options.stdio, ['ignore', 'pipe', 'pipe'], 'no stdin: fire-and-forget task, not an interactive session');
});

test('spawns bash -c on posix with the command as one argument', () => {
  const fc = makeFakeChild();
  const spawns = [];
  startRunTask({
    command: 'npm test', cwd: '/work', platform: 'linux',
    spawnImpl: (shell, args, options) => { spawns.push({ shell, args, options }); return fc.child; },
  });
  assert.equal(spawns[0].shell, 'bash');
  assert.deepEqual(spawns[0].args, ['-c', 'npm test']);
  assert.equal(spawns[0].options.detached, true, 'POSIX process-group cancellation requires a detached group leader');
});

test('scrubs JENNY_* env vars from the child (belt-and-braces credential hygiene)', () => {
  const fc = makeFakeChild();
  const spawns = [];
  startRunTask({
    command: 'echo hi', cwd: '/work', platform: 'linux',
    env: { PATH: '/bin', JENNY_ENABLE_SECRET_FLAG: '1', EDITOR: 'vim' },
    spawnImpl: (shell, args, options) => { spawns.push(options); return fc.child; },
  });
  assert.equal(spawns[0].env.PATH, '/bin');
  assert.equal(spawns[0].env.EDITOR, 'vim');
  assert.equal(spawns[0].env.JENNY_ENABLE_SECRET_FLAG, undefined);
});

test('streams stdout/stderr live via onData as chunks arrive (not just a post-hoc tail)', () => {
  const fc = makeFakeChild();
  const events = [];
  startRunTask({
    command: 'npm run build', cwd: '/work', platform: 'linux',
    spawnImpl: () => fc.child,
    onData: (stream, chunk) => events.push([stream, chunk]),
  });
  fc.emitStdout('compiling…\n');
  fc.emitStderr('warn: x\n');
  assert.deepEqual(events, [['stdout', 'compiling…\n'], ['stderr', 'warn: x\n']]);
});

test('a real exit code settles done as "exited" with the true numeric code - never inferred from output text', async () => {
  const fc = makeFakeChild();
  const { done } = startRunTask({ command: 'node x.js', cwd: '/work', platform: 'linux', spawnImpl: () => fc.child });
  // The script prints text that looks EXACTLY like the old completion marker
  // format, then the real process is still alive (no close event yet).
  fc.emitStdout('__JENNY_RUN_DONE_1__ 0\n');
  fc.emitStdout('still working...\n');
  fc.emitClose(2, null);
  const result = await done;
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 2, 'the REAL close-event code, unaffected by marker-shaped stdout text');
});

test('a signal-killed child (null exit code) is not conflated with a clean 0', async () => {
  const fc = makeFakeChild();
  const { done } = startRunTask({ command: 'node x.js', cwd: '/work', platform: 'linux', spawnImpl: () => fc.child });
  fc.emitClose(null, 'SIGKILL');
  const result = await done;
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
});

test('a spawn error (ENOENT) settles done as "error" + SPAWN_FAILED', async () => {
  const fc = makeFakeChild();
  const { done } = startRunTask({ command: 'nope', cwd: '/work', platform: 'linux', spawnImpl: () => fc.child });
  fc.emitError(Object.assign(new Error('spawn nope ENOENT'), { code: 'ENOENT' }));
  const result = await done;
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, RUN_TASK_ERROR_CODES.SPAWN_FAILED);
  assert.equal(result.exitCode, null);
});

test('a synchronous spawn throw also settles done as "error" + SPAWN_FAILED, and kill() is still safe to call', async () => {
  const { done, kill } = startRunTask({
    command: 'nope', cwd: '/work', platform: 'linux',
    spawnImpl: () => { throw new Error('boom'); },
  });
  const result = await done;
  assert.equal(result.status, 'error');
  assert.equal(result.errorCode, RUN_TASK_ERROR_CODES.SPAWN_FAILED);
  await assert.doesNotReject(() => kill());
});

test('kill() runs the injected process-tree kill and settles done as "killed" exactly once', async () => {
  const fc = makeFakeChild();
  const killCalls = [];
  const { done, kill } = startRunTask({
    command: 'node x.js', cwd: '/work', platform: 'linux', spawnImpl: () => fc.child,
    killProcessTree: async (child) => { killCalls.push(child.pid); return { terminated: true }; },
  });
  const outcome = await kill();
  assert.equal(outcome.terminated, true);
  assert.deepEqual(killCalls, [4242]);
  const result = await done;
  assert.equal(result.status, 'killed');
  // A close event racing in AFTER termination was requested must not re-settle.
  fc.emitClose(0, null);
  const second = await Promise.race([done, Promise.resolve('unchanged')]);
  assert.equal(second, result, 'done resolves to the SAME settled value (exactly-once)');
});

test('an unconfirmed kill still settles (never hangs the caller) and reports terminationConfirmed:false', async () => {
  const fc = makeFakeChild();
  const { kill } = startRunTask({
    command: 'node x.js', cwd: '/work', platform: 'linux', spawnImpl: () => fc.child,
    killProcessTree: async () => { throw new Error('taskkill failed'); },
  });
  const outcome = await kill();
  assert.equal(outcome.terminated, false);
});

test('real POSIX cancellation terminates the detached run-task process group', {
  skip: process.platform === 'win32',
}, async (t) => {
  let child = null;
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const { done, kill } = startRunTask({
    command: `node -e 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'`,
    cwd: process.cwd(),
    platform: process.platform,
    spawnImpl: (shell, args, options) => {
      child = spawn(shell, args, options);
      return child;
    },
    onData: (_stream, chunk) => {
      if (chunk.includes('ready')) ready();
    },
    terminationTimeoutMs: 2000,
  });
  t.after(() => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_error) { /* already gone */ }
  });
  await Promise.race([
    readyPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('run task did not become ready')), 2000)),
  ]);

  const outcome = await Promise.race([
    kill(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('run task cancellation timed out')), 3000)),
  ]);
  assert.equal(outcome.terminated, true);
  assert.equal((await done).terminationConfirmed, true);
});

test('a real close event after settlement (e.g. late duplicate) is a no-op, not a second bridge event', async () => {
  const fc = makeFakeChild();
  const { done } = startRunTask({ command: 'node x.js', cwd: '/work', platform: 'linux', spawnImpl: () => fc.child });
  fc.emitClose(0, null);
  const first = await done;
  fc.emitClose(1, null); // late duplicate close (should never happen from a real child, but must be inert)
  assert.equal(first.exitCode, 0);
});
