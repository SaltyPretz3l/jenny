const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OllamaProcessManager,
  isEngineActivityLine,
} = require('../services/backend/ollama-process-manager');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

class FakeChildProcess extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = createStream();
    this.stderr = createStream();
  }
}

function createStream() {
  const stream = new EventEmitter();
  stream.encoding = '';
  stream.setEncoding = (encoding) => {
    stream.encoding = encoding;
  };
  return stream;
}

async function listen(server) {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

test.afterEach(async () => {
  await cleanupTrackedResources();
  delete process.env.OLLAMA_MODELS;
});

test('ollama manager persists app-owned process state and clears it after stop', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-owned-'));
  trackDirectory(userDataPath);

  const child = new FakeChildProcess(43210);
  const killCalls = [];
  const stateFilePath = path.join(userDataPath, 'ollama-process.json');
  let alive = true;

  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    spawnImpl: () => child,
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
      alive = false;
    },
    isProcessAliveImpl: () => alive,
    waitForProcessExitImpl: async () => !alive,
  });
  manager._resolveCommand = () => 'C:/Ollama/ollama.exe';
  manager._isRunning = async () => false;
  manager._waitForReady = async () => true;
  manager._killOrphanedRunners = async () => {};
  manager._shutdownWsl = () => {};

  const startResult = await manager.start();
  const storedState = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));

  assert.equal(startResult.started, true);
  assert.equal(storedState.pid, 43210);
  assert.equal(storedState.app_owned, true);
  assert.equal(storedState.command, 'C:/Ollama/ollama.exe');

  await manager.stop();

  assert.deepEqual(killCalls, [
    { pid: 43210, force: false },
  ]);
  assert.equal(fs.existsSync(stateFilePath), false);
});

test('ollama manager strips an unusable OLLAMA_MODELS value before spawn', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-sanitized-env-'));
  trackDirectory(userDataPath);

  process.env.OLLAMA_MODELS = path.join(userDataPath, 'missing-ollama-models');

  const child = new FakeChildProcess(43211);
  const logs = [];
  let spawnOptions = null;

  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    spawnImpl: (_command, _args, options = {}) => {
      spawnOptions = options;
      return child;
    },
  });
  manager._resolveCommand = () => 'C:/Ollama/ollama.exe';
  manager._isRunning = async () => false;
  manager._waitForReady = async () => true;
  manager._killOrphanedRunners = async () => {};
  manager._shutdownWsl = () => {};

  const startResult = await manager.start();

  assert.equal(startResult.started, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(spawnOptions.env, 'OLLAMA_MODELS'),
    false
  );
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.models_dir_ignored'),
    true
  );
});

test('ollama manager stops an app-owned process when startup readiness times out', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-startup-timeout-'));
  trackDirectory(userDataPath);

  const child = new FakeChildProcess(43213);
  const logs = [];
  const killCalls = [];
  const stateFilePath = path.join(userDataPath, 'ollama-process.json');
  let alive = true;

  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    spawnImpl: () => child,
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
      alive = false;
      child.emit('exit', 0, null);
    },
    isProcessAliveImpl: () => alive,
    waitForProcessExitImpl: async () => !alive,
  });
  manager._resolveCommand = () => 'C:/Ollama/ollama.exe';
  manager._isRunning = async () => false;
  manager._waitForReady = async () => false;

  const startResult = await manager.start();

  assert.equal(startResult.started, false);
  assert.equal(startResult.external, false);
  assert.deepEqual(killCalls, [
    { pid: 43213, force: false },
  ]);
  assert.equal(fs.existsSync(stateFilePath), false);
  assert.equal(manager._ownedProcess, false);
  assert.equal(manager._ownedPid, 0);
  const startupFailed = logs.find((entry) => entry.event === 'ollama.startup_failed');
  assert.ok(startupFailed, 'expected a durable ollama.startup_failed event');
  assert.equal(startupFailed.level, 'ERROR');
  assert.equal(startupFailed.details.reason, 'startup_timeout');
  assert.equal(startResult.failure.reason, 'startup_timeout');
});

test('ollama manager logs unexpected owned process exits by severity', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-unexpected-exit-'));
  trackDirectory(userDataPath);

  const child = new FakeChildProcess(43212);
  const logs = [];
  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    spawnImpl: () => child,
  });
  manager._resolveCommand = () => 'C:/Ollama/ollama.exe';
  manager._isRunning = async () => false;
  manager._waitForReady = async () => true;
  manager._killOrphanedRunners = async () => {};
  manager._shutdownWsl = () => {};

  await manager.start();
  child.emit('exit', 1, null);

  assert.deepEqual(
    logs
      .filter((entry) => entry.event === 'ollama.exited')
      .map((entry) => ({ level: entry.level, code: entry.details.code, expected: entry.details.expected })),
    [{ level: 'ERROR', code: 1, expected: false }]
  );
});

test('ollama manager fast-fails and classifies a code-1 startup crash', async () => {
  const child = new FakeChildProcess(43299);
  const logs = [];
  let isRunningCalls = 0;

  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    logger: (level, event, details) => logs.push({ level, event, details }),
    clearOwnedOllamaStateImpl: () => {},
    spawnImpl: () => {
      // Emit the fatal stderr line then crash, after start() has attached its
      // stderr/exit handlers (next tick).
      setImmediate(() => {
        child.stderr.emit(
          'data',
          'Error: listen tcp 127.0.0.1:11434: bind: address already in use\n'
        );
        child.emit('exit', 1, null);
      });
      return child;
    },
  });
  manager._resolveCommand = () => 'C:/Ollama/ollama.exe';
  manager._isRunning = async () => {
    isRunningCalls += 1;
    return false;
  };
  // NOTE: _waitForReady is intentionally NOT stubbed — its fast-fail path is
  // under test.
  manager._killOrphanedRunners = async () => {};
  manager._shutdownWsl = () => {};

  const startResult = await manager.start();

  assert.equal(startResult.started, false);
  assert.equal(startResult.failure.reason, 'crash');
  assert.equal(startResult.failure.code, 1);
  assert.equal(startResult.failure.likelyCause, 'port_in_use');
  assert.match(startResult.failure.stderrTail, /address already in use/);

  // The durable ollama.exited ERROR carries the cause + stderr tail.
  const exited = logs.find((entry) => entry.event === 'ollama.exited');
  assert.ok(exited);
  assert.equal(exited.level, 'ERROR');
  assert.equal(exited.details.likelyCause, 'port_in_use');
  assert.match(exited.details.stderrTail, /address already in use/);

  // A durable ollama.startup_failed ERROR is also emitted with the cause.
  const startupFailed = logs.find((entry) => entry.event === 'ollama.startup_failed');
  assert.ok(startupFailed);
  assert.equal(startupFailed.level, 'ERROR');
  assert.equal(startupFailed.details.likelyCause, 'port_in_use');

  // Fast-fail: it must not blind-poll the dead port for the full timeout. The
  // pre-spawn check + at most one wait poll => a tiny call count, not ~50.
  assert.ok(isRunningCalls <= 3, `expected few _isRunning calls, got ${isRunningCalls}`);
});

test('ollama manager surfaces a spawn error as a structured failure', async () => {
  const child = new FakeChildProcess(43298);
  const logs = [];

  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    logger: (level, event, details) => logs.push({ level, event, details }),
    clearOwnedOllamaStateImpl: () => {},
    spawnImpl: () => {
      setImmediate(() => child.emit('error', new Error('ENOENT spawn ollama')));
      return child;
    },
  });
  manager._resolveCommand = () => 'C:/Ollama/ollama.exe';
  manager._isRunning = async () => false;
  manager._killOrphanedRunners = async () => {};
  manager._shutdownWsl = () => {};

  const startResult = await manager.start();

  assert.equal(startResult.started, false);
  assert.equal(startResult.failure.reason, 'spawn_error');
  assert.match(startResult.failure.remediation, /ENOENT spawn ollama/);
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.spawn_error' && entry.level === 'ERROR'),
    true
  );
  const startupFailed = logs.find((entry) => entry.event === 'ollama.startup_failed');
  assert.ok(startupFailed);
  assert.equal(startupFailed.details.reason, 'spawn_error');
});

test('ollama manager startup_failed message reflects an unclassified crash, not a timeout', async () => {
  const child = new FakeChildProcess(43297);
  const logs = [];

  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    logger: (level, event, details) => logs.push({ level, event, details }),
    clearOwnedOllamaStateImpl: () => {},
    spawnImpl: () => {
      // Crash with stderr that matches no fatal pattern => no classification,
      // so the log message must fall back to crash wording (not the timeout).
      setImmediate(() => {
        child.stderr.emit('data', 'some unrecognized failure line\n');
        child.emit('exit', 1, null);
      });
      return child;
    },
  });
  manager._resolveCommand = () => 'C:/Ollama/ollama.exe';
  manager._isRunning = async () => false;
  manager._killOrphanedRunners = async () => {};
  manager._shutdownWsl = () => {};

  const startResult = await manager.start();

  assert.equal(startResult.failure.reason, 'crash');
  assert.equal(startResult.failure.likelyCause, null);
  const startupFailed = logs.find((entry) => entry.event === 'ollama.startup_failed');
  assert.match(startupFailed.details.message, /exited unexpectedly \(exit code 1\)/);
  assert.doesNotMatch(startupFailed.details.message, /did not become ready/);
});

test('ollama manager ensureRunning restarts when health check is down', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-ensure-running-'));
  trackDirectory(userDataPath);

  const child = new FakeChildProcess(43214);
  const logs = [];
  let running = false;
  let spawnCount = 0;
  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    spawnImpl: () => {
      spawnCount += 1;
      return child;
    },
  });
  manager._resolveCommand = () => 'C:/Ollama/ollama.exe';
  manager._isRunning = async () => running;
  manager._waitForReady = async () => {
    running = true;
    return true;
  };
  manager._killOrphanedRunners = async () => {};
  manager._shutdownWsl = () => {};

  const result = await manager.ensureRunning();

  assert.equal(spawnCount, 1);
  assert.deepEqual(result, { started: true, external: false, ready: true });
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.preflight_unavailable'),
    true
  );
});

test('ollama manager kills stale owned process on startup before proceeding', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-adopt-'));
  trackDirectory(userDataPath);

  const stateFilePath = path.join(userDataPath, 'ollama-process.json');
  fs.writeFileSync(stateFilePath, JSON.stringify({
    pid: 50123,
    command: 'C:/Ollama/ollama.exe',
    startedAt: '2026-03-18T00:00:00.000Z',
    app_owned: true,
  }, null, 2));

  const logs = [];
  const sweepOptions = [];
  let syncKillCalled = false;

  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => !syncKillCalled,
    // F2c: the live command line matches the recorded one, so this really is
    // our stale process.
    getProcessCommandLineSyncImpl: () => 'C:/Ollama/ollama.exe serve',
    forceKillAnyRemainingLocalOllamaSyncImpl: (options = {}) => {
      syncKillCalled = true;
      sweepOptions.push(options);
    },
  });
  manager._isRunning = async () => false;
  manager._resolveCommand = () => null;

  const startResult = await manager.start();
  assert.equal(syncKillCalled, true, 'should have called sync force kill for stale owned process');
  assert.equal(startResult.started, false, 'no binary found so no new process spawned');
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.killing_stale_owned_process'),
    true
  );
  // F2(3): the stale-owned kill knows the pid, so the blanket by-name sweep is off.
  assert.deepEqual(sweepOptions[0].ownedPids, [50123]);
  assert.equal(fs.existsSync(stateFilePath), false, 'state file cleared after killing stale process');
});

// F2c PID-reuse coverage for start()/stop() lives in the sibling file
// tests/ollama-process-ownership.test.js (file-size ceiling).

test('ollama manager clears stale ownership state before treating a running server as external', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-stale-'));
  trackDirectory(userDataPath);

  const stateFilePath = path.join(userDataPath, 'ollama-process.json');
  fs.writeFileSync(stateFilePath, JSON.stringify({
    pid: 60123,
    command: 'C:/Ollama/ollama.exe',
    startedAt: '2026-03-18T00:00:00.000Z',
    app_owned: true,
  }, null, 2));

  const logs = [];
  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => false,
  });
  manager._isRunning = async () => true;

  const result = await manager.start();

  assert.equal(result.external, true);
  assert.equal(fs.existsSync(stateFilePath), false);
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.stale_owned_process_state_cleared'),
    true
  );
});

test('ollama manager leaves external running ollama alone on shutdown', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-external-'));
  trackDirectory(userDataPath);

  const logs = [];
  const killCalls = [];
  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
    },
  });
  manager._isRunning = async () => true;

  await manager.stop();

  assert.deepEqual(killCalls, []);
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.external_left_running'),
    true
  );
});

test('ollama manager escalates to forced process-tree shutdown for owned persisted pid', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-force-'));
  trackDirectory(userDataPath);

  const stateFilePath = path.join(userDataPath, 'ollama-process.json');
  fs.writeFileSync(stateFilePath, JSON.stringify({
    pid: 70123,
    command: 'C:/Ollama/ollama.exe',
    startedAt: '2026-03-18T00:00:00.000Z',
    app_owned: true,
  }, null, 2));

  const killCalls = [];
  let waitCallCount = 0;
  let alive = true;

  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
      if (options.force) {
        alive = false;
      }
    },
    isProcessAliveImpl: () => alive,
    getProcessCommandLineSyncImpl: () => 'C:/Ollama/ollama.exe serve',
    waitForProcessExitImpl: async () => {
      waitCallCount += 1;
      return waitCallCount > 1;
    },
  });
  manager._killOrphanedRunners = async () => {};

  await manager.stop();

  assert.deepEqual(killCalls, [
    { pid: 70123, force: false },
    { pid: 70123, force: true },
  ]);
  assert.equal(manager._expectedExitPids.has(70123), false);
  assert.equal(fs.existsSync(stateFilePath), false);
});

// F2d retention coverage lives in tests/ollama-process-ownership.test.js.

// F2: an ordinary quit force-killed EVERY ollama.exe on the machine, gated on
// nothing — reached even when the live engine is vLLM/replay/cloud. This test
// previously PINNED that behavior ("kills ... without owned state"); it now
// pins the residue gate.
test('ollama manager any_local stop skips the sweep when this install owns no local ollama', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-any-local-'));
  trackDirectory(userDataPath);

  const logs = [];
  const forceKillCalls = [];
  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    forceKillAnyRemainingLocalOllamaSyncImpl: (options = {}) => {
      forceKillCalls.push(options);
      return { discoveredPids: [80123], killedPids: [80123] };
    },
  });

  await manager.stop({ scope: 'any_local' });

  assert.deepEqual(forceKillCalls, [], 'no machine-wide sweep without owned residue');
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.stopping_any_local'),
    false
  );
  const skip = logs.find((entry) => entry.event === 'ollama.any_local_sweep_skipped');
  assert.ok(skip, 'expected the ollama.any_local_sweep_skipped observability log');
  assert.equal(skip.details.reason, 'no_local_ollama_residue');
});

test('ollama manager any_local stop runs the sweep once this run has owned a process', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-any-local-residue-'));
  trackDirectory(userDataPath);

  const logs = [];
  const forceKillCalls = [];
  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => false,
    forceKillAnyRemainingLocalOllamaSyncImpl: (options = {}) => {
      forceKillCalls.push(options);
      return { discoveredPids: [80123], killedPids: [80123] };
    },
  });
  // Latched by a real start(); set directly so this test stays a unit.
  manager._everOwnedProcess = true;

  await manager.stop({ scope: 'any_local' });

  assert.equal(forceKillCalls.length, 1, 'residue present, so the sweep runs');
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.stopping_any_local'),
    true
  );
});

test('ollama manager any_local stop clears stale owned state before aggressive shutdown', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-any-local-stale-'));
  trackDirectory(userDataPath);

  const stateFilePath = path.join(userDataPath, 'ollama-process.json');
  fs.writeFileSync(stateFilePath, JSON.stringify({
    pid: 90123,
    command: 'C:/Ollama/ollama.exe',
    startedAt: '2026-03-18T00:00:00.000Z',
    app_owned: true,
  }, null, 2));

  const logs = [];
  // The stale-state log is emitted BEFORE the residue gate and the state file is
  // deleted regardless, so an unrecorded sweep stub leaves both assertions below
  // true even when production skips the aggressive sweep entirely.
  let sweepCalls = 0;
  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => false,
    forceKillAnyRemainingLocalOllamaSyncImpl: () => {
      sweepCalls += 1;
      return { discoveredPids: [], killedPids: [] };
    },
  });

  await manager.stop({ scope: 'any_local' });

  assert.equal(sweepCalls, 1, 'the aggressive sweep must run exactly once');
  // "clears stale owned state before" is the in-memory _resetLiveOwnership() and
  // its log, not the file: _finalizeOwnedStop deletes ollama-process.json AFTER
  // the sweep, so the file is still on disk while the sweep callback runs.
  assert.equal(fs.existsSync(stateFilePath), false);
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.stale_owned_process_state_cleared'),
    true
  );
});

test('ollama manager any_local stop gracefully stops owned pid before aggressive cleanup', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-any-local-owned-'));
  trackDirectory(userDataPath);

  const stateFilePath = path.join(userDataPath, 'ollama-process.json');
  fs.writeFileSync(stateFilePath, JSON.stringify({
    pid: 100123,
    command: 'C:/Ollama/ollama.exe',
    startedAt: '2026-03-18T00:00:00.000Z',
    app_owned: true,
  }, null, 2));

  const killCalls = [];
  const forceKillCalls = [];
  let waitCallCount = 0;
  let alive = true;

  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
      if (options.force) {
        alive = false;
      }
    },
    isProcessAliveImpl: () => alive,
    getProcessCommandLineSyncImpl: () => 'C:/Ollama/ollama.exe serve',
    waitForProcessExitImpl: async () => {
      waitCallCount += 1;
      return waitCallCount > 1;
    },
    forceKillAnyRemainingLocalOllamaSyncImpl: (options = {}) => {
      forceKillCalls.push(options);
      return { discoveredPids: [], killedPids: [] };
    },
  });

  await manager.stop({ scope: 'any_local' });

  assert.deepEqual(killCalls, [
    { pid: 100123, force: false },
    { pid: 100123, force: true },
  ]);
  assert.equal(forceKillCalls.length, 1);
  assert.deepEqual(forceKillCalls[0].ownedPids, [100123],
    'the owned pid narrows the sweep so the blanket by-name kill is skipped');
  assert.equal(fs.existsSync(stateFilePath), false);
});

test('ollama manager rejects foreign HTTP services on the Ollama port', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-foreign-'));
  trackDirectory(userDataPath);
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server);
  const child = new FakeChildProcess(110123);
  let spawned = false;

  try {
    const manager = new OllamaProcessManager({
      detectTrayConflictImpl: () => null,
      userDataPath,
      port,
      spawnImpl: () => {
        spawned = true;
        return child;
      },
    });
    manager._resolveCommand = () => 'C:/Ollama/ollama.exe';
    manager._waitForReady = async () => true;
    manager._killOrphanedRunners = async () => {};
    manager._shutdownWsl = () => {};

    const result = await manager.start();

    assert.equal(result.started, true);
    assert.equal(result.external, false);
    assert.equal(spawned, true);
  } finally {
    await closeServer(server);
  }
});

test('ollama manager reuses only a valid Ollama tags endpoint', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-valid-tags-'));
  trackDirectory(userDataPath);
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ models: [{ name: 'llama3.2' }] }));
  });
  const port = await listen(server);
  let spawned = false;

  try {
    const manager = new OllamaProcessManager({
      detectTrayConflictImpl: () => null,
      userDataPath,
      port,
      spawnImpl: () => {
        spawned = true;
        return new FakeChildProcess(120123);
      },
    });

    const result = await manager.start();

    assert.equal(result.started, false);
    assert.equal(result.external, true);
    assert.equal(spawned, false);
  } finally {
    await closeServer(server);
  }
});

test('ollama manager forwards stdout and resolves structured stderr levels from owned Ollama process', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-logs-'));
  trackDirectory(userDataPath);
  const logs = [];
  const child = new FakeChildProcess(130123);
  let spawnOptions = null;

  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    spawnImpl: (_command, _args, options = {}) => {
      spawnOptions = options;
      return child;
    },
  });
  manager._resolveCommand = () => 'C:/Ollama/ollama.exe';
  manager._isRunning = async () => false;
  manager._waitForReady = async () => true;
  manager._killOrphanedRunners = async () => {};
  manager._shutdownWsl = () => {};

  const result = await manager.start();
  child.stdout.emit('data', [
    'ollama ready',
    'stdout level=ERROR stays debug',
  ].join('\n') + '\n');
  child.stderr.emit('data', [
    'time=2026-04-29T16:03:23 level=INFO msg="server config"',
    'time=2026-04-29T16:03:24 level=WARN msg="gpu warning"',
    'time=2026-04-29T16:03:25 level=ERROR msg="startup failed"',
    'plain stderr warning',
  ].join('\n') + '\n');

  assert.equal(result.started, true);
  assert.deepEqual(spawnOptions.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(
    logs.filter((entry) => entry.event === 'ollama.output'),
    [
      {
        level: 'DEBUG',
        event: 'ollama.output',
        details: { stream: 'stdout', line: 'ollama ready' },
      },
      {
        level: 'DEBUG',
        event: 'ollama.output',
        details: { stream: 'stdout', line: 'stdout level=ERROR stays debug' },
      },
      {
        level: 'INFO',
        event: 'ollama.output',
        details: {
          stream: 'stderr',
          line: 'time=2026-04-29T16:03:23 level=INFO msg="server config"',
        },
      },
      {
        level: 'WARN',
        event: 'ollama.output',
        details: {
          stream: 'stderr',
          line: 'time=2026-04-29T16:03:24 level=WARN msg="gpu warning"',
        },
      },
      {
        level: 'ERROR',
        event: 'ollama.output',
        details: {
          stream: 'stderr',
          line: 'time=2026-04-29T16:03:25 level=ERROR msg="startup failed"',
        },
      },
      {
        level: 'WARN',
        event: 'ollama.output',
        details: { stream: 'stderr', line: 'plain stderr warning' },
      },
    ]
  );
});

test('ollama manager kills orphaned Windows runner processes', async () => {
  const killCalls = [];
  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    platform: 'win32',
    listLocalOllamaProcessesImpl: () => [
      { pid: 140123, parentPid: 999999 },
      { pid: 140124, parentPid: 140000 },
    ],
    isProcessAliveImpl: (pid) => pid === 140000,
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
    },
  });

  await manager._killOrphanedRunners(140000);

  assert.deepEqual(killCalls, [
    { pid: 140123, force: true },
    { pid: 140124, force: true },
  ]);
});

test('managed ollama stderr decode telemetry forwards throttled engine-activity heartbeats', async () => {
  // 2026-07-11 CMP-LOOP-0015 RCA: while Ollama buffers a huge tool call it
  // streams no chat chunks, but its embedded llama.cpp server prints per-slot
  // telemetry on stderr every few seconds. The manager forwards that liveness
  // (throttled) so the sidecar watchdog can tell "busy" from "hung".
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-engine-activity-'));
  trackDirectory(userDataPath);

  const child = new FakeChildProcess(43299);
  let now = 100000;
  const heartbeats = [];
  const killCalls = [];
  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    spawnImpl: () => child,
    isProcessAliveImpl: () => true,
    waitForProcessExitImpl: async () => true,
    // Without this the manager falls back to the REAL killProcessTree, and
    // stop() below spawns `taskkill /PID 43299 /T` against the host.
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
    },
    onEngineActivity: () => heartbeats.push(now),
    engineActivityThrottleMs: 1000,
    nowImpl: () => now,
  });
  manager._resolveCommand = () => 'C:/Ollama/ollama.exe';
  manager._isRunning = async () => false;
  manager._waitForReady = async () => true;
  manager._killOrphanedRunners = async () => {};
  manager._shutdownWsl = () => {};
  await manager.start();

  const emitStderr = (line) => child.stderr.emit('data', `${line}\n`);

  emitStderr('slot print_timing: id  0 | task 5602 | n_decoded =   143, tg =  47.49 t/s');
  assert.equal(heartbeats.length, 1, 'decode telemetry forwards a heartbeat');

  emitStderr('slot   operator(): id  0 | task 5602 | cached n_tokens = 13264');
  assert.equal(heartbeats.length, 1, 'a second line inside the throttle window is suppressed');

  now += 1001;
  emitStderr('cmn  common_reaso: activated, budget=2147483647 tokens');
  assert.equal(heartbeats.length, 2, 'a fresh throttle window forwards again');

  now += 1001;
  emitStderr('[GIN] 2026/07/11 - 13:09:00 | 200 | 624.9us | 127.0.0.1 | GET "/api/tags"');
  emitStderr('srv  update_slots: all slots are idle');
  assert.equal(
    heartbeats.length,
    2,
    'HTTP access logs and idle srv lines must never count as liveness'
  );

  now += 1001;
  emitStderr('load_tensors: loading model tensors, this can take a while... (mmap = true)');
  assert.equal(heartbeats.length, 3, 'model-load progress counts as engine activity');

  now += 1001;
  child.stdout.emit('data', 'slot print_timing: id  0 | task 9 | n_decoded = 1\n');
  assert.equal(heartbeats.length, 3, 'only stderr carries llama.cpp telemetry');

  await manager.stop();
  assert.deepEqual(
    killCalls.map((entry) => entry.pid),
    [43299],
    'stop() must go through the injected killer, never the host process table'
  );
});

test('isEngineActivityLine classifies decode/load telemetry and rejects ambient traffic', () => {
  assert.equal(isEngineActivityLine('slot print_timing: id 0 | task 1 | n_decoded = 10'), true);
  assert.equal(isEngineActivityLine('slot launch_slot_: id  0 | task -1 | sampler chain: logits'), true);
  assert.equal(isEngineActivityLine('cmn  common_reaso: deactivated (natural end)'), true);
  assert.equal(isEngineActivityLine('llama_model_loader: loaded meta data'), true);
  assert.equal(isEngineActivityLine('load_tensors: offloading 36 layers to GPU'), true);
  assert.equal(isEngineActivityLine('ggml_cuda_init: found 1 CUDA devices:'), true);

  assert.equal(isEngineActivityLine('srv  update_slots: all slots are idle'), false);
  assert.equal(isEngineActivityLine('[GIN] 2026/07/11 - 13:09:00 | 200 | GET "/api/tags"'), false);
  assert.equal(isEngineActivityLine('time=2026-07-11 level=INFO msg="server listening"'), false);
  assert.equal(isEngineActivityLine(''), false);
});
