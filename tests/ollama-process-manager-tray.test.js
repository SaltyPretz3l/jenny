const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OllamaProcessManager,
} = require('../services/backend/ollama-process-manager');

// Wiring tests for the Ollama tray-app conflict detection (see
// services/backend/ollama-tray-conflict.js for the detector's own unit
// suite). Split out of ollama-process-manager.test.js, which sits at the
// file-size ceiling.

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
function makeTrayTestManager({ logs, child, detectTrayConflictImpl }) {
  const manager = new OllamaProcessManager({
    stateStore: null,
    platform: 'win32',
    logger: (level, event, details) => logs.push({ level, event, details }),
    spawnImpl: () => child,
    killProcessTreeImpl: async () => {},
    isProcessAliveImpl: () => false,
    waitForProcessExitImpl: async () => true,
    clearOwnedOllamaStateImpl: () => {},
    postExitProbeDelayMs: 0,
    detectTrayConflictImpl,
  });
  manager._resolveCommand = () => 'C:/Ollama/ollama.exe';
  manager._isRunning = async () => false;
  manager._waitForReady = async () => true;
  manager._killOrphanedRunners = async () => {};
  manager._shutdownWsl = () => {};
  return manager;
}

test('ollama manager warns at start when the tray app conflict is detected', async () => {
  const logs = [];
  const child = new FakeChildProcess(150123);
  const manager = makeTrayTestManager({
    logs,
    child,
    detectTrayConflictImpl: () => ({
      detected: true,
      trayProcesses: [{ pid: 4242, name: 'ollama app.exe' }],
      startupShortcuts: ['Ollama.lnk'],
    }),
  });

  const result = await manager.start();

  assert.equal(result.started, true);
  const warning = logs.find((entry) => entry.event === 'ollama.tray_app_conflict_detected');
  assert.ok(warning, 'expected ollama.tray_app_conflict_detected log');
  assert.equal(warning.level, 'WARN');
  assert.deepEqual(warning.details.trayPids, [4242]);
  assert.deepEqual(warning.details.startupShortcuts, ['Ollama.lnk']);
  assert.match(String(warning.details.message), /tray/i);
  assert.match(String(warning.details.remediation), /Startup/i);
});

test('ollama manager warns even when an external server already holds the port', async () => {
  const logs = [];
  const child = new FakeChildProcess(150129);
  const manager = makeTrayTestManager({
    logs,
    child,
    detectTrayConflictImpl: () => ({
      detected: true,
      trayProcesses: [{ pid: 4242, name: 'ollama app.exe' }],
      startupShortcuts: [],
    }),
  });
  // The tray's own server answering on 11434 is the incident's silent state:
  // start() must still surface the conflict before short-circuiting.
  manager._isRunning = async () => true;

  const result = await manager.start();

  assert.equal(result.external, true);
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.tray_app_conflict_detected'),
    true,
  );
});

test('ollama manager stays silent at start when no tray conflict is detected', async () => {
  const logs = [];
  const child = new FakeChildProcess(150124);
  const manager = makeTrayTestManager({
    logs,
    child,
    detectTrayConflictImpl: () => ({ detected: false, trayProcesses: [], startupShortcuts: [] }),
  });

  await manager.start();

  assert.equal(
    logs.some((entry) => entry.event === 'ollama.tray_app_conflict_detected'),
    false,
  );
});

test('ollama manager survives a throwing tray detector', async () => {
  const logs = [];
  const child = new FakeChildProcess(150125);
  const manager = makeTrayTestManager({
    logs,
    child,
    detectTrayConflictImpl: () => {
      throw new Error('detector exploded');
    },
  });

  const result = await manager.start();

  assert.equal(result.started, true);
});

test('ollama manager escalates a silent-kill crash to name the tray app', async () => {
  const logs = [];
  const child = new FakeChildProcess(150126);
  const manager = makeTrayTestManager({
    logs,
    child,
    detectTrayConflictImpl: () => ({
      detected: true,
      trayProcesses: [{ pid: 4242, name: 'ollama app.exe' }],
      startupShortcuts: ['Ollama.lnk'],
    }),
  });

  await manager.start();
  // Silent-kill signature: code 1, no signal, no level=ERROR stderr captured.
  child.emit('exit', 1, null);

  const exitLog = logs.find((entry) => entry.event === 'ollama.exited');
  assert.ok(exitLog, 'expected ollama.exited log');
  assert.equal(exitLog.details.traySuspected, true);
  assert.equal(exitLog.details.likelyCause, 'tray_app_conflict');
  assert.match(String(exitLog.details.message), /tray/i);
  assert.equal(manager._lastFailure.likelyCause, 'tray_app_conflict');
  assert.match(String(manager._lastFailure.remediation), /tray/i);
});

test('ollama manager does not blame the tray when stderr already explains the crash', async () => {
  const logs = [];
  const child = new FakeChildProcess(150127);
  const manager = makeTrayTestManager({
    logs,
    child,
    detectTrayConflictImpl: () => ({
      detected: true,
      trayProcesses: [{ pid: 4242, name: 'ollama app.exe' }],
      startupShortcuts: [],
    }),
  });

  await manager.start();
  manager._recentStderr = ['Error: listen tcp 127.0.0.1:11434: bind: Only one usage of each socket address'];
  child.emit('exit', 1, null);

  const exitLog = logs.find((entry) => entry.event === 'ollama.exited');
  assert.ok(exitLog, 'expected ollama.exited log');
  // Signature still matches (no level=ERROR token), so the tray stays flagged,
  // but the classified stderr cause must win the likelyCause slot.
  assert.equal(exitLog.details.traySuspected, true);
  assert.equal(exitLog.details.likelyCause, 'port_in_use');
});

test('ollama manager does not blame the tray on a non-silent crash when none was detected', async () => {
  const logs = [];
  const child = new FakeChildProcess(150128);
  const manager = makeTrayTestManager({
    logs,
    child,
    detectTrayConflictImpl: () => ({ detected: false, trayProcesses: [], startupShortcuts: [] }),
  });

  await manager.start();
  child.emit('exit', 1, null);

  const exitLog = logs.find((entry) => entry.event === 'ollama.exited');
  assert.ok(exitLog, 'expected ollama.exited log');
  assert.equal('traySuspected' in exitLog.details, false);
  assert.notEqual(manager._lastFailure.likelyCause, 'tray_app_conflict');
});

test('ollama manager re-detects the tray at exit when it launches after start (post-2026-07-05 regression)', async () => {
  const logs = [];
  const child = new FakeChildProcess(150130);
  // Stateful/mutable fake detector: absent at start(), present by the time the
  // exit handler runs — the exact live scenario where the tray app launches
  // AFTER Jenny and the boot-time snapshot in this._trayConflict is stale.
  let trayState = { detected: false, trayProcesses: [], startupShortcuts: [] };
  const manager = makeTrayTestManager({
    logs,
    child,
    detectTrayConflictImpl: () => trayState,
  });

  await manager.start();
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.tray_app_conflict_detected'),
    false,
    'no tray warning expected yet — detector reported nothing at start time',
  );

  // Tray app launches after Jenny's engine is already up.
  trayState = {
    detected: true,
    trayProcesses: [{ pid: 4242, name: 'ollama app.exe' }],
    startupShortcuts: [],
  };
  // Silent-kill signature: code 1, no signal, no level=ERROR stderr captured.
  child.emit('exit', 1, null);

  const warning = logs.find((entry) => entry.event === 'ollama.tray_app_conflict_detected');
  assert.ok(warning, 'expected a fresh ollama.tray_app_conflict_detected WARN at exit time');
  assert.equal(warning.level, 'WARN');
  assert.deepEqual(warning.details.trayPids, [4242]);

  const exitLog = logs.find((entry) => entry.event === 'ollama.exited');
  assert.ok(exitLog, 'expected ollama.exited log');
  assert.equal(exitLog.details.traySuspected, true);
  assert.equal(exitLog.details.likelyCause, 'tray_app_conflict');
});

test('ollama manager start() joins an async tray detector before resolving', async () => {
  const logs = [];
  const child = new FakeChildProcess(150131);
  const manager = makeTrayTestManager({
    logs,
    child,
    // Async detector resolving on a later tick — the production shape after the
    // start()-time check went non-blocking (the win32 scan runs off-loop).
    detectTrayConflictImpl: () => new Promise((resolve) => {
      setTimeout(() => resolve({
        detected: true,
        trayProcesses: [{ pid: 4242, name: 'ollama app.exe' }],
        startupShortcuts: ['Ollama.lnk'],
      }), 20);
    }),
  });

  const result = await manager.start();

  assert.equal(result.started, true);
  const warning = logs.find((entry) => entry.event === 'ollama.tray_app_conflict_detected');
  assert.ok(warning, 'expected the async detector result surfaced before start() resolved');
  assert.deepEqual(warning.details.trayPids, [4242]);
});

test('ollama manager start() surfaces an async-detected conflict before the external short-circuit', async () => {
  const logs = [];
  const child = new FakeChildProcess(150132);
  const manager = makeTrayTestManager({
    logs,
    child,
    detectTrayConflictImpl: () => new Promise((resolve) => {
      setTimeout(() => resolve({
        detected: true,
        trayProcesses: [{ pid: 4242, name: 'ollama app.exe' }],
        startupShortcuts: [],
      }), 20);
    }),
  });
  manager._isRunning = async () => true;

  const result = await manager.start();

  assert.equal(result.external, true);
  assert.equal(
    logs.some((entry) => entry.event === 'ollama.tray_app_conflict_detected'),
    true,
    'the incident contract: the WARN lands before start() classifies the port holder as external',
  );
});

test('ollama manager start() survives a rejecting async tray detector', async () => {
  const logs = [];
  const child = new FakeChildProcess(150133);
  const manager = makeTrayTestManager({
    logs,
    child,
    detectTrayConflictImpl: () => Promise.reject(new Error('async detector exploded')),
  });

  const result = await manager.start();

  assert.equal(result.started, true);
});
