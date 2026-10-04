'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const ROOT = path.resolve(__dirname, '..');
const RUNNER_PATH = path.join(ROOT, 'scripts', 'run-node-tests-safe.js');
const safeRunner = require('../scripts/run-node-tests-safe');

test('real inherited pipes cannot keep a settled runner alive after green output', () => {
  const producer = [
    "const { spawn } = require('child_process');",
    "const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'],",
    "  { stdio: 'inherit', detached: true, windowsHide: true });",
    'descendant.unref();',
    "descendant.once('spawn', () => { console.log('green output'); process.exit(0); });",
  ].join('\n');
  const harness = [
    `const { runCapturedChild } = require(${JSON.stringify(RUNNER_PATH)});`,
    `runCapturedChild(['-e', ${JSON.stringify(producer)}], {`,
    '  activeChildren: new Set(), timeoutMs: 20000,',
    '}).then(result => { console.log(JSON.stringify(result)); process.exitCode = result.code; });',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', harness], {
    encoding: 'utf8', timeout: 8000, windowsHide: true,
  });
  assert.equal(result.status, 1, 'runner must exit with a cleanup failure instead of hanging after green output');
  assert.match(result.stdout, /orphaned descendants.*pipes/);
  assert.match(result.stdout, /"terminationFailed":false/);
});

test('post-exit undrained pipes fail that file and release the exited child', async (t) => {
  // The runner's drain timer is unref'd and this fake child holds no handles, so
  // keep the loop alive until the grace fires (Linux would otherwise exit first).
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const child = new EventEmitter();
  child.pid = 4545;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {};
  const activeChildren = new Set();
  const resultPromise = safeRunner.runCapturedChild([], {
    activeChildren, timeoutMs: 10_000, spawnImpl: () => child,
  });
  child.emit('exit', 0, null);
  const trackedAfterExit = activeChildren.has(child);
  const result = await resultPromise;
  assert.equal(trackedAfterExit, false, 'an exited child leaves the kill set while its pipes drain');
  assert.equal(result.code, 1, 'undrained pipes must not yield a green result');
  assert.equal(result.terminationFailed, false, 'an exited child must not abort sibling files');
  assert.equal(result.timedOut, false);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(activeChildren.has(child), false, 'an exited pid is no handle for a later tree kill');
  assert.match(result.output, /orphaned descendants.*pipes/);
});

test('post-exit pipes draining within grace preserve the real exit code', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const activeChildren = new Set();
  const resultPromise = safeRunner.runCapturedChild([], {
    activeChildren, timeoutMs: 10_000, spawnImpl: () => child,
  });
  child.emit('exit', 0, null);
  child.stdout.write('final output\n');
  child.emit('close', 0, null);
  const result = await resultPromise;
  child.stdout.destroy();
  child.stderr.destroy();
  assert.equal(result.code, 0);
  assert.equal(result.terminationFailed, false);
  assert.equal(activeChildren.size, 0);
  assert.equal(result.output, 'final output\n');
});

test('real-store durability replay keeps contention headroom in the heavy wave', () => {
  const overrides = safeRunner.loadTimeoutOverrides(ROOT);

  // The 194-replay real-disk sweep is ~37s alone but exceeded 180s while the
  // release gate also ran pytest-xdist and the ten-worker Node lane.
  assert.equal(
    safeRunner.resolvePerFileTimeoutMs(
      'tests/plugins/lifecycle/real-store-e2e.test.js',
      { overrides, cwd: ROOT }
    ),
    300_000
  );
});

test('per-file watchdog settles after a confirmed tree kill without exit or close events', async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const activeChildren = new Set();
  const killCalls = [];

  const result = await safeRunner.runCapturedChild(['--test', 'tests/hanging.test.js'], {
    activeChildren,
    timeoutMs: 5,
    spawnImpl: () => child,
    killProcessTreeImpl: async (pid, options) => {
      killCalls.push({ pid, options });
      return { terminated: true };
    },
    waitForProcessExitImpl: async () => {
      throw new Error('confirmed kills must not poll twice');
    },
    terminationGraceMs: 10,
  });

  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationFailed, false);
  assert.deepEqual(killCalls, [{
    pid: 4242,
    options: { force: true, confirmExit: true, timeoutMs: 10 },
  }]);
  assert.equal(activeChildren.size, 0);
});

test('per-file watchdog reports an unconfirmed kill without waiting for process events', async () => {
  const child = new EventEmitter();
  child.pid = 4343;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => false;
  child.unref = () => {};
  const activeChildren = new Set();

  const result = await safeRunner.runCapturedChild(['--test', 'tests/leaked.test.js'], {
    activeChildren,
    timeoutMs: 5,
    spawnImpl: () => child,
    killProcessTreeImpl: async () => ({ terminated: false }),
    waitForProcessExitImpl: async () => false,
    terminationGraceMs: 10,
  });

  assert.equal(result.code, 124);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationFailed, true);
  assert.equal(activeChildren.has(child), true);
  assert.match(result.output, /termination was not confirmed/);
});

test('per-file watchdog waits for tree-kill confirmation after child exit and close', async () => {
  const child = new EventEmitter();
  child.pid = 4444;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => false;
  child.unref = () => {};
  const activeChildren = new Set();
  let signalKillStarted;
  const killStarted = new Promise((resolve) => {
    signalKillStarted = resolve;
  });
  let completeKill;
  const killOutcome = new Promise((resolve) => {
    completeKill = resolve;
  });

  const resultPromise = safeRunner.runCapturedChild(['--test', 'tests/racy-timeout.test.js'], {
    activeChildren,
    timeoutMs: 1,
    spawnImpl: () => child,
    killProcessTreeImpl: async () => {
      signalKillStarted();
      return killOutcome;
    },
    waitForProcessExitImpl: async () => false,
    terminationGraceMs: 10,
  });

  await killStarted;
  child.emit('exit', null, 'SIGKILL');
  child.emit('close', null, 'SIGKILL');
  const trackedDuringConfirmation = activeChildren.has(child);
  completeKill({ terminated: false });
  const result = await resultPromise;

  assert.equal(trackedDuringConfirmation, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationFailed, true);
  assert.equal(activeChildren.has(child), true);
});

test('global watchdog exits within its bounded termination grace', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-safe-runner-timeout-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const testPath = path.join(tempRoot, 'global-hang.test.js');
  fs.writeFileSync(
    testPath,
    "const test = require('node:test');\ntest('hang', () => new Promise(() => {}));\n"
  );

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [
    RUNNER_PATH,
    '--no-lock',
    testPath,
    '--timeout-ms=500',
    '--per-file-timeout-ms=30000',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env },
    windowsHide: true,
  });

  assert.equal(result.status, 124);
  assert.ok(Date.now() - startedAt < 12_000, 'global watchdog must not inherit the per-file timeout');
  assert.match(String(result.stderr || ''), /timed out after 500ms \(global run budget\)/);
  assert.match(
    `${String(result.stderr || '')}\n${String(result.stdout || '')}`,
    /global-hang\.test\.js/,
    'the bounded shutdown report must name the interrupted file'
  );
  assert.match(
    String(result.stdout || ''),
    /(?:IN-FLIGHT AT SHUTDOWN|ABORTED \(fail-fast\/shutdown collateral\)): .*global-hang\.test\.js/
  );
});

test('global watchdog budget includes time spent waiting for the run lock', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-safe-runner-lock-budget-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const testPath = path.join(tempRoot, 'never-started.test.js');
  fs.writeFileSync(testPath, "const test = require('node:test');\ntest('ok', () => {});\n");
  fs.writeFileSync(
    path.join(tempRoot, safeRunner.LOCK_BASENAME),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
  );
  const env = { ...process.env };
  delete env[safeRunner.LOCK_ENV_VAR];

  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [
    RUNNER_PATH,
    testPath,
    '--timeout-ms=500',
    '--lock-wait-ms=30000',
  ], {
    cwd: tempRoot,
    encoding: 'utf8',
    timeout: 5_000,
    env,
    windowsHide: true,
  });

  assert.equal(result.status, 125);
  assert.ok(Date.now() - startedAt < 4_000, 'lock wait must not outlive the global run budget');
  assert.match(String(result.stderr || ''), /gave up waiting .* after 500ms/);
});
