const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  SidecarManager,
  describeMissingPythonInterpreter,
  resolvePythonExecutable,
  venvPythonRelativePath,
} = require('../services/backend/sidecar-manager');
const {
  getManagedSidecarStatePath,
  shutdownManagedSidecarSync,
} = require('../services/backend/sidecar-shutdown');
const { killProcessTree } = require('../services/backend/process-utils');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');
const { createFakeTimers } = require('./helpers/fake-timers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar starts, records state, and shuts down cleanly', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-'));
  trackDirectory(userDataPath);

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-'));
  trackDirectory(repoRoot);

  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    launchCommand: process.execPath,
    launchArgs: [path.join(__dirname, 'fixtures', 'fake-sidecar.js')],
    jwtSecret: createFakeSafeStorage().decryptString(
      createFakeSafeStorage().encryptString('jwt_secret')
    ),
  });

  const status = await manager.start();

  assert.equal(status.phase, 'ready');
  assert.equal(status.baseUrl, 'stdio://sidecar');
  assert.equal(fs.existsSync(manager.sandboxLayout.stateFilePath), true);

  const firstChild = manager.process;
  const firstExit = new Promise((resolve) => firstChild.once('exit', resolve));
  firstChild.kill();
  await firstExit;
  await manager.stop();

  assert.equal(manager.getStatus().phase, 'stopped');
  assert.equal(fs.existsSync(manager.sandboxLayout.stateFilePath), false);
});

test('managed sidecar adopts packaged-binary launch metadata and persists it', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-packaged-'));
  trackDirectory(userDataPath);

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-packaged-'));
  trackDirectory(repoRoot);

  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: path.join(repoRoot, 'missing-python'),
    packagedSidecarLaunch: {
      ok: true,
      launchCommand: process.execPath,
      launchArgs: [path.join(__dirname, 'fixtures', 'fake-sidecar.js')],
      launchSource: 'packaged-binary',
      packagedLaunchDetail: 'Packaged sidecar validated via manifest integrity and version probe.',
    },
    jwtSecret: 'jwt_secret',
  });

  const status = await manager.start();
  const persistedState = JSON.parse(fs.readFileSync(manager.sandboxLayout.stateFilePath, 'utf8'));

  assert.equal(status.phase, 'ready');
  assert.equal(status.launchSource, 'packaged-binary');
  assert.match(status.packagedLaunchDetail, /validated via manifest/i);
  assert.equal(persistedState.launchSource, 'packaged-binary');
  assert.match(persistedState.packagedLaunchDetail, /validated via manifest/i);

  const packagedChild = manager.process;
  const packagedExit = new Promise((resolve) => packagedChild.once('exit', resolve));
  packagedChild.kill();
  await packagedExit;
  await manager.stop();
});

test('managed sidecar resolves a deferred packaged launch during start (off the pre-window path)', async () => {
  // Regression for the release first-paint stall: packaged launch validation
  // (full-binary SHA-256 + --version probe) is deferred behind an async resolver
  // so it runs inside the awaited start() phase, not synchronously at construction
  // before the window exists.
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-deferred-'));
  trackDirectory(userDataPath);

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-deferred-'));
  trackDirectory(repoRoot);

  let resolverCalls = 0;
  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: path.join(repoRoot, 'missing-python'),
    resolvePackagedLaunch: async () => {
      resolverCalls += 1;
      return {
        ok: true,
        launchCommand: process.execPath,
        launchArgs: [path.join(__dirname, 'fixtures', 'fake-sidecar.js')],
        launchSource: 'packaged-binary',
        packagedLaunchDetail: 'Packaged sidecar validated via manifest integrity and version probe.',
      };
    },
    jwtSecret: 'jwt_secret',
  });

  // Resolver must not run at construction time (that would re-block first paint).
  assert.equal(resolverCalls, 0);

  const status = await manager.start();

  assert.equal(resolverCalls, 1);
  assert.equal(status.phase, 'ready');
  assert.equal(status.launchSource, 'packaged-binary');
  assert.match(status.packagedLaunchDetail, /validated via manifest/i);

  const deferredChild = manager.process;
  const deferredExit = new Promise((resolve) => deferredChild.once('exit', resolve));
  deferredChild.kill();
  await deferredExit;
  await manager.stop();
});

test('managed sidecar fails closed when packaged sidecar launch resolution is invalid', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-packaged-fail-'));
  trackDirectory(userDataPath);

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-packaged-fail-'));
  trackDirectory(repoRoot);

  const failureReason = 'Packaged sidecar artifact is missing.';
  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    packagedSidecarLaunch: {
      ok: false,
      launchCommand: '',
      launchArgs: [],
      launchSource: 'packaged-binary',
      packagedLaunchDetail: failureReason,
      failureReason,
    },
    jwtSecret: 'jwt_secret',
  });

  await assert.rejects(manager.start(), new RegExp(failureReason.replace('.', '\\.')));

  assert.equal(manager.getStatus().phase, 'failed');
  assert.equal(manager.getStatus().startupStage, 'packaged_launch_invalid');
  assert.equal(manager.getStatus().launchSource, 'packaged-binary');
  assert.equal(manager.getStatus().packagedLaunchDetail, failureReason);
  assert.equal(fs.existsSync(manager.sandboxLayout.stateFilePath), false);
});

test('managed sidecar cleans stale state before launching a fresh child', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-stale-'));
  trackDirectory(userDataPath);

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-'));
  trackDirectory(repoRoot);

  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    launchCommand: process.execPath,
    launchArgs: [path.join(__dirname, 'fixtures', 'fake-sidecar.js')],
    jwtSecret: 'jwt_secret',
  });

  manager.stateStore.write({
    pid: 999999,
    port: 65500,
    baseUrl: 'http://127.0.0.1:65500',
  });

  const cleaned = await manager.cleanupStaleState();
  assert.equal(cleaned, false);
  assert.equal(fs.existsSync(manager.sandboxLayout.stateFilePath), false);
});

test('stale-state cleanup skips the kill when the live pid no longer matches the stored command', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-stale-reused-'));
  trackDirectory(userDataPath);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-'));
  trackDirectory(repoRoot);

  const killCalls = [];
  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    jwtSecret: 'jwt_secret',
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
    },
    // The recycled pid now belongs to an unrelated process.
    getProcessCommandLineImpl: async () => 'C:\\Windows\\System32\\notepad.exe untitled.txt',
  });
  const logEvents = [];
  manager.on('log', (line) => logEvents.push(line));

  // Use our own pid so the liveness probe passes; the kill impl is stubbed.
  manager.stateStore.write({
    pid: process.pid,
    command: `${process.execPath} ${path.join('sidecar', 'fake-sidecar.js')}`,
  });

  await manager.cleanupStaleState();
  assert.deepEqual(killCalls, [], 'an unverified process must never be killed');
  assert.equal(fs.existsSync(manager.sandboxLayout.stateFilePath), false);
  assert.equal(logEvents.some((line) => /skipped stale-state kill/i.test(line)), true);
});

test('stale-state cleanup kills the tree when the live pid still matches the stored command', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-stale-match-'));
  trackDirectory(userDataPath);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-'));
  trackDirectory(repoRoot);

  const storedCommand = `${process.execPath} ${path.join('sidecar', 'fake-sidecar.js')}`;
  const killCalls = [];
  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    jwtSecret: 'jwt_secret',
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
    },
    // The OS reports the same command we launched (quoting may differ).
    getProcessCommandLineImpl: async () =>
      `"${process.execPath}" ${path.join('sidecar', 'fake-sidecar.js')}`,
  });

  manager.stateStore.write({
    pid: process.pid,
    command: storedCommand,
  });

  await manager.cleanupStaleState();
  assert.deepEqual(killCalls, [{ pid: process.pid, force: true }]);
  assert.equal(fs.existsSync(manager.sandboxLayout.stateFilePath), false);
});

test('managed sidecar stop uses the shared deadline and avoids killing after graceful exit', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-stop-graceful-'));
  trackDirectory(userDataPath);

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-'));
  trackDirectory(repoRoot);

  const killCalls = [];
  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    jwtSecret: 'jwt_secret',
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
    },
  });

  manager.process = { pid: 4321 };
  manager._waitForProcessExit = async (timeoutMs) => {
    assert.ok(timeoutMs <= 5000 && timeoutMs > 0);
    return true;
  };
  manager.status = {
    ...manager.getStatus(),
    phase: 'ready',
    baseUrl: 'http://127.0.0.1:4311',
    pid: 4321,
  };

  const result = await manager.stop({ gracefulDeadlineAt: Date.now() + 5000 });

  assert.deepEqual(killCalls, []);
  assert.equal(result.graceful, true);
  assert.equal(result.forced, false);
  assert.equal(result.exitConfirmed, true);
  assert.equal(manager.getStatus().phase, 'stopped');
});

// Regression: a stop that runs with NO sidecar client attached -- initialization
// failed before ensureSidecarClientAttached, or a crash disposed the client --
// used to reach the graceful wait with the child's stdin still open. The sidecar's
// only live tie to this process is stdin EOF (sidecar/runtime/parent_watchdog.py),
// so it never exited on its own: every such stop burned the full 5s graceful window
// and force-kill became the only thing reaping the child.
test('managed sidecar stop closes child stdin so a client-less shutdown stays graceful', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-stop-stdin-eof-'));
  trackDirectory(userDataPath);

  // Spy that DELEGATES rather than replacing: a stub that swallowed the kill
  // would leave the child alive on the red side of this test, and its stdio
  // pipes would pin this file's event loop instead of failing an assertion.
  const killCalls = [];
  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    launchCommand: process.execPath,
    launchArgs: [path.join(__dirname, 'fixtures', 'fake-sidecar.js')],
    jwtSecret: 'jwt_secret_test',
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
      return killProcessTree(pid, options);
    },
  });

  const status = await manager.start();
  assert.equal(status.phase, 'ready');
  const child = manager.process;
  assert.ok(child && child.pid);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await killProcessTree(child.pid, { force: true }).catch(() => null);
    }
  });

  // No sidecarClient exists here, so nothing has sent `shutdown` or ended stdin:
  // stop() itself has to close the pipe.
  const startedAt = Date.now();
  const result = await manager.stop();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(child.stdin.writableEnded, true);
  assert.equal(result.graceful, true);
  assert.equal(result.forced, false);
  assert.equal(result.exitConfirmed, true);
  assert.deepEqual(killCalls, []);
  // The graceful window is 5s; a stop that only ever ended by force-kill cannot
  // land anywhere near this bound.
  assert.equal(elapsedMs < 2000, true, `stop took ${elapsedMs}ms`);
  assert.equal(manager.getStatus().phase, 'stopped');
});

test('managed sidecar stop forces termination when graceful shutdown times out', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-stop-force-'));
  trackDirectory(userDataPath);

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-'));
  trackDirectory(repoRoot);

  const killCalls = [];
  const shutdownLogs = [];
  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    jwtSecret: 'jwt_secret',
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, ...options });
      return { terminated: true };
    },
    logger: (level, event, details) => shutdownLogs.push({ level, event, details }),
  });

  manager.process = { pid: 9876 };
  manager._waitForProcessExit = async () => false;
  manager.status = {
    ...manager.getStatus(),
    phase: 'ready',
    baseUrl: 'http://127.0.0.1:9877',
    pid: 9876,
  };

  const result = await manager.stop({ gracefulDeadlineAt: Date.now() });

  assert.deepEqual(killCalls, [
    {
      pid: 9876,
      force: true,
      confirmExit: true,
      timeoutMs: 2000,
    },
  ]);
  assert.equal(result.forced, true);
  assert.equal(result.exitConfirmed, true);
  assert.equal(
    shutdownLogs.filter((entry) => entry.event === 'backend.sidecar_shutdown_stage').length,
    3,
  );
  assert.ok(shutdownLogs.every((entry) => Number.isFinite(entry.details.durationMs)));
  assert.equal(manager.getStatus().phase, 'stopped');
});

test('managed sidecar stop preserves state when force-tree exit is unconfirmed', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-stop-kill-failure-'));
  trackDirectory(userDataPath);

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-'));
  trackDirectory(repoRoot);

  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    jwtSecret: 'jwt_secret',
    killProcessTreeImpl: async () => ({ terminated: false }),
  });

  manager.process = { pid: 2468 };
  manager._waitForProcessExit = async () => false;
  manager.stateStore.write({
    pid: 2468,
    baseUrl: 'stdio://sidecar',
  });
  manager.status = {
    ...manager.getStatus(),
    phase: 'ready',
    pid: 2468,
  };

  const result = await manager.stop({ gracefulDeadlineAt: Date.now() });

  assert.equal(manager.process, null);
  assert.equal(manager.getStatus().phase, 'stopped');
  assert.equal(manager.getStatus().pid, 0);
  assert.equal(result.exitConfirmed, false);
  assert.equal(fs.existsSync(manager.sandboxLayout.stateFilePath), true);
});

test('managed sidecar fails fast when the child exits during startup', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-exit-'));
  trackDirectory(userDataPath);

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-'));
  trackDirectory(repoRoot);

  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    launchCommand: process.execPath,
    launchArgs: ['-e', 'process.exit(7)'],
    jwtSecret: 'jwt_secret',
    startupSoftTimeoutMs: 1000,
  });

  const startedAt = Date.now();
  await assert.rejects(
    manager.start(),
    /Backend exited with code 7 signal=none\./
  );

  assert.equal(Date.now() - startedAt < 500, true);
  assert.equal(manager.getStatus().phase, 'failed');
  assert.match(manager.getStatus().detail, /code=7/i);
});

test('managed sidecar reports failed status when the ready child exits unexpectedly', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-runtime-exit-'));
  trackDirectory(userDataPath);

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-runtime-exit-'));
  trackDirectory(repoRoot);

  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    launchCommand: process.execPath,
    launchArgs: [path.join(__dirname, 'fixtures', 'fake-sidecar.js')],
    jwtSecret: 'jwt_secret',
  });

  const failedStatus = new Promise((resolve) => {
    manager.on('status', (status) => {
      if (status.phase === 'failed') {
        resolve(status);
      }
    });
  });

  await manager.start();
  manager.process.kill();

  const status = await failedStatus;
  assert.equal(status.phase, 'failed');
  assert.match(status.detail, /exited before shutdown/i);
});

test('_waitForProcessExit removes temporary exit listeners when timeout wins', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-exit-timeout-'));
  trackDirectory(userDataPath);

  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-'));
  trackDirectory(repoRoot);

  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    jwtSecret: 'jwt_secret',
  });
  const processMock = new EventEmitter();
  processMock.exitCode = null;
  manager.process = processMock;

  const stoppedGracefully = await manager._waitForProcessExit(5);

  assert.equal(stoppedGracefully, false);
  assert.equal(processMock.listenerCount('exit'), 0);
});

test('_waitForSpawnSettle resolves early on the first stderr byte and cleans up listeners', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-settle-'));
  trackDirectory(userDataPath);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-settle-'));
  trackDirectory(repoRoot);

  const timers = createFakeTimers();
  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    jwtSecret: 'jwt_secret',
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });
  const processMock = new EventEmitter();
  processMock.exitCode = null;
  processMock.stderr = new EventEmitter();
  manager.process = processMock;

  // Huge 60s grace registered on the virtual clock; emit a stderr byte so the
  // wait resolves on the EVENT, not on the timer. Virtual time never advances.
  const settlePromise = manager._waitForSpawnSettle(60000);
  assert.equal(timers.pending(), 1); // grace timer armed but not yet fired
  processMock.stderr.emit('data', Buffer.from('sidecar server started\n'));
  const exited = await settlePromise;

  assert.equal(exited, false); // healthy: process did not exit
  assert.equal(timers.pending(), 0); // grace timer was cleared on settle, never fired
  // Even advancing past the full 60s grace does not change the resolved value:
  // the wait already resolved on the stderr byte, so the timer is gone.
  timers.tick(60000);
  assert.equal(timers.pending(), 0);
  assert.equal(processMock.listenerCount('exit'), 0);
  assert.equal(processMock.stderr.listenerCount('data'), 0);
});

test('_waitForSpawnSettle reports exit when the process dies during the grace', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-settle-exit-'));
  trackDirectory(userDataPath);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-settle-exit-'));
  trackDirectory(repoRoot);

  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    jwtSecret: 'jwt_secret',
  });
  const processMock = new EventEmitter();
  processMock.exitCode = null;
  processMock.stderr = new EventEmitter();
  manager.process = processMock;

  const settlePromise = manager._waitForSpawnSettle(60000);
  processMock.emit('exit', 7, null);
  const exited = await settlePromise;

  assert.equal(exited, true); // spawn failure path
  assert.equal(processMock.stderr.listenerCount('data'), 0);
});

test('shutdownManagedSidecarSync kills the persisted sidecar pid and clears state', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-emergency-'));
  trackDirectory(userDataPath);

  const statePath = getManagedSidecarStatePath(userDataPath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    pid: 12345,
    baseUrl: 'stdio://sidecar',
    command: 'python -m sidecar',
  }, null, 2));

  const spawnCalls = [];
  let aliveChecks = 0;
  const result = shutdownManagedSidecarSync({
    userDataPath,
    platform: 'win32',
    spawnSyncImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0 };
    },
    isProcessAliveImpl: () => {
      aliveChecks += 1;
      return aliveChecks <= 1;
    },
    getProcessCommandLineSyncImpl: () => 'python -m sidecar',
  });

  assert.deepEqual(result, {
    hadState: true,
    killed: true,
    pid: 12345,
  });
  assert.equal(fs.existsSync(statePath), false);
  assert.deepEqual(spawnCalls, [
    { cmd: 'taskkill', args: ['/PID', '12345', '/T', '/F'] },
  ]);
});

test('shutdownManagedSidecarSync preserves state when force kill is unconfirmed', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-emergency-throw-'));
  trackDirectory(userDataPath);

  const statePath = getManagedSidecarStatePath(userDataPath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    pid: 42424,
    baseUrl: 'stdio://sidecar',
    command: 'python -m sidecar',
  }, null, 2));

  const logs = [];
  const result = shutdownManagedSidecarSync({
    userDataPath,
    platform: 'win32',
    spawnSyncImpl: () => {
      throw new Error('taskkill exploded');
    },
    isProcessAliveImpl: () => true,
    getProcessCommandLineSyncImpl: () => 'python -m sidecar',
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.deepEqual(result, {
    hadState: true,
    killed: false,
    pid: 42424,
  });
  assert.equal(fs.existsSync(statePath), true);
  assert.ok(
    logs.some((entry) => entry.event === 'sidecar.force_kill_failed' && entry.details.pid === 42424),
    'expected sidecar.force_kill_failed log',
  );
  assert.ok(
    logs.some((entry) => (
      entry.event === 'sidecar.force_kill_complete'
      && entry.details.confirmed === false
      && Number.isFinite(entry.details.durationMs)
    )),
    'expected bounded completion timing log',
  );
});

test('shutdownManagedSidecarSync clears stale state when the pid is already gone', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-emergency-stale-'));
  trackDirectory(userDataPath);

  const statePath = getManagedSidecarStatePath(userDataPath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    pid: 54321,
    baseUrl: 'stdio://sidecar',
  }, null, 2));

  const result = shutdownManagedSidecarSync({
    userDataPath,
    platform: 'win32',
    spawnSyncImpl: () => {
      throw new Error('should not run');
    },
    isProcessAliveImpl: () => false,
  });

  assert.deepEqual(result, {
    hadState: true,
    killed: false,
    pid: 54321,
  });
  assert.equal(fs.existsSync(statePath), false);
});

test('retryStart coalesces concurrent callers onto one stop/start cycle (W3.9)', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-retry-'));
  trackDirectory(userDataPath);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-retry-'));
  trackDirectory(repoRoot);

  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    launchCommand: process.execPath,
    launchArgs: [path.join(__dirname, 'fixtures', 'fake-sidecar.js')],
    jwtSecret: 'jwt_secret_test',
  });

  const calls = [];
  let releaseStop;
  manager.stop = async () => {
    calls.push('stop');
    await new Promise((resolve) => { releaseStop = resolve; });
  };
  manager.start = async () => {
    calls.push('start');
    return { phase: 'ready' };
  };

  const first = manager.retryStart();
  const second = manager.retryStart();
  assert.notEqual(manager._retryStartInFlight, null);

  releaseStop();
  const [firstStatus, secondStatus] = await Promise.all([first, second]);

  assert.deepEqual(calls, ['stop', 'start']);
  assert.deepEqual(firstStatus, { phase: 'ready' });
  assert.equal(firstStatus, secondStatus);
  assert.equal(manager._retryStartInFlight, null);

  // The latch releases after settle: a later retry runs a fresh cycle.
  manager.stop = async () => { calls.push('stop2'); };
  manager.start = async () => { calls.push('start2'); return { phase: 'ready' }; };
  await manager.retryStart();
  assert.deepEqual(calls, ['stop', 'start', 'stop2', 'start2']);
});

test('retryStart clears the in-flight latch when the cycle fails (W3.9)', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-retry-fail-'));
  trackDirectory(userDataPath);
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-repo-retry-fail-'));
  trackDirectory(repoRoot);

  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath,
    repoRoot,
    pythonExecutable: process.execPath,
    launchCommand: process.execPath,
    launchArgs: [path.join(__dirname, 'fixtures', 'fake-sidecar.js')],
    jwtSecret: 'jwt_secret_test',
  });

  manager.stop = async () => {};
  manager.start = async () => {
    throw new Error('spawn failed');
  };

  await assert.rejects(() => manager.retryStart(), /spawn failed/);
  assert.equal(manager._retryStartInFlight, null);

  manager.start = async () => ({ phase: 'ready' });
  const recovered = await manager.retryStart();
  assert.deepEqual(recovered, { phase: 'ready' });
});

test('resolvePythonExecutable: explicit interpreter always wins', () => {
  const resolved = resolvePythonExecutable('/repo', '/custom/python', {
    platform: 'darwin',
    fileExists: () => false,
  });
  assert.equal(resolved, '/custom/python');
});

test('resolvePythonExecutable: macOS resolves the POSIX .venv/bin/python', () => {
  const repoRoot = path.join(os.tmpdir(), 'jenny-resolve-darwin');
  const expected = path.join(repoRoot, venvPythonRelativePath('darwin'));
  const resolved = resolvePythonExecutable(repoRoot, undefined, {
    platform: 'darwin',
    // Only the repo-root venv interpreter exists on disk.
    fileExists: (candidate) => candidate === expected,
  });
  assert.equal(resolved, expected);
  assert.ok(resolved.includes(path.join('.venv', 'bin')));
  assert.ok(!resolved.includes('Scripts'));
});

test('resolvePythonExecutable: Windows resolves the .venv/Scripts/python.exe', () => {
  const repoRoot = path.join(os.tmpdir(), 'jenny-resolve-win');
  const expected = path.join(repoRoot, venvPythonRelativePath('win32'));
  const resolved = resolvePythonExecutable(repoRoot, undefined, {
    platform: 'win32',
    fileExists: (candidate) => candidate === expected,
  });
  assert.equal(resolved, expected);
  assert.ok(resolved.endsWith('python.exe'));
});

test('resolvePythonExecutable: JENNY_BACKEND_PYTHON takes priority over the venv', () => {
  const previous = process.env.JENNY_BACKEND_PYTHON;
  process.env.JENNY_BACKEND_PYTHON = '/opt/python3.11/bin/python';
  try {
    const resolved = resolvePythonExecutable('/repo', undefined, {
      platform: 'darwin',
      // Pretend everything exists; the env candidate is first, so it wins.
      fileExists: () => true,
    });
    assert.equal(resolved, '/opt/python3.11/bin/python');
  } finally {
    if (previous === undefined) {
      delete process.env.JENNY_BACKEND_PYTHON;
    } else {
      process.env.JENNY_BACKEND_PYTHON = previous;
    }
  }
});

test('resolvePythonExecutable: falls back to the first candidate when no venv exists', () => {
  const previous = process.env.JENNY_BACKEND_PYTHON;
  delete process.env.JENNY_BACKEND_PYTHON;
  try {
    const repoRoot = path.join(os.tmpdir(), 'jenny-resolve-missing');
    const resolved = resolvePythonExecutable(repoRoot, undefined, {
      platform: 'darwin',
      fileExists: () => false,
    });
    // No interpreter found on disk: return the expected repo-root venv path so
    // the managed-dev launch surfaces a clear "create your .venv" style error.
    assert.equal(resolved, path.join(repoRoot, venvPythonRelativePath('darwin')));
  } finally {
    if (previous !== undefined) {
      process.env.JENNY_BACKEND_PYTHON = previous;
    }
  }
});

test('describeMissingPythonInterpreter: POSIX names the venv and setup.sh', () => {
  const detail = describeMissingPythonInterpreter({
    pythonExecutable: '/repo/.venv/bin/python',
    repoRoot: '/repo',
    platform: 'linux',
    env: {},
  });
  assert.ok(detail.includes('/repo/.venv/bin/python'));
  assert.ok(detail.includes(path.join('/repo', '.venv')));
  assert.match(detail, /bash \.\/setup\.sh/);
  // The Windows command must not leak into a POSIX message.
  assert.ok(!detail.includes('npm run setup'));
});

test('describeMissingPythonInterpreter: Windows names the npm setup script', () => {
  const detail = describeMissingPythonInterpreter({
    pythonExecutable: 'C:\\repo\\.venv\\Scripts\\python.exe',
    repoRoot: 'C:\\repo',
    platform: 'win32',
    env: {},
  });
  assert.match(detail, /npm run setup/);
  assert.ok(!detail.includes('setup.sh'));
});

test('describeMissingPythonInterpreter: blames JENNY_BACKEND_PYTHON when it supplied the path', () => {
  const detail = describeMissingPythonInterpreter({
    pythonExecutable: '/opt/bogus/python',
    repoRoot: '/repo',
    platform: 'linux',
    env: { JENNY_BACKEND_PYTHON: '/opt/bogus/python' },
  });
  assert.match(detail, /JENNY_BACKEND_PYTHON/);
  // Telling the user to run setup would not fix a mis-set env var.
  assert.ok(!detail.includes('bash ./setup.sh'));
});

test('describeMissingPythonInterpreter: unrelated JENNY_BACKEND_PYTHON still points at setup', () => {
  const detail = describeMissingPythonInterpreter({
    pythonExecutable: '/repo/.venv/bin/python',
    repoRoot: '/repo',
    platform: 'linux',
    // Set, but not the path that failed — the venv is still the real problem.
    env: { JENNY_BACKEND_PYTHON: '/somewhere/else/python' },
  });
  assert.match(detail, /bash \.\/setup\.sh/);
  assert.ok(!detail.includes('JENNY_BACKEND_PYTHON'));
});
