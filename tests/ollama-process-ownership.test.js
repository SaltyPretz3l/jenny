'use strict';

// Ownership + process-identity contract for OllamaProcessManager.
//
// Split out of tests/ollama-process-manager*.test.js (both are at the file-size
// ceiling). Covers three findings:
//   F2  — an ordinary quit must not force-kill every ollama.exe on the machine;
//         the machine-wide sweep is gated on THIS install having residue, and
//         is narrowed to the owned pid when one is known.
//   F2c — a persisted pid may have been recycled by the OS onto an unrelated
//         process, so the recorded command line is verified before any kill.
//   F2d — ownership is cleared ONLY on a confirmed exit; an unconfirmed exit
//         retains the record so the next launch's stale-state sweep retries.
//
// Every subprocess/kill/identity seam is injected — no real child_process fires.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { OllamaProcessManager } = require('../services/backend/ollama-process-manager');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const STATE_FILENAME = 'ollama-process.json';

function makeUserDataDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(dir);
  return dir;
}

function writeOwnedState(userDataPath, record) {
  fs.writeFileSync(
    path.join(userDataPath, STATE_FILENAME),
    JSON.stringify({ app_owned: true, ...record }, null, 2),
  );
}

function makeRecordingStore(record) {
  const deletes = [];
  return {
    deletes,
    store: {
      read: () => record,
      write: () => {},
      delete: () => { deletes.push(true); },
    },
  };
}

/** Manager with every destructive seam injected and no real filesystem use. */
function makeManager(overrides = {}) {
  return new OllamaProcessManager({
    stateStore: null,
    detectTrayConflictImpl: () => null,
    spawnImpl: () => { throw new Error('spawnImpl not configured'); },
    killProcessTreeImpl: async () => {},
    isProcessAliveImpl: () => false,
    waitForProcessExitImpl: async () => true,
    listLocalOllamaProcessesImpl: () => [],
    forceKillAnyRemainingLocalOllamaSyncImpl: () => ({ discoveredPids: [], killedPids: [] }),
    clearOwnedOllamaStateImpl: () => {},
    getProcessCommandLineSyncImpl: () => '',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// F2c — PID reuse
// ---------------------------------------------------------------------------

test('start() refuses to force-kill a stale owned pid whose live command line does not match', async () => {
  const userDataPath = makeUserDataDir('jenny-ollama-reuse-start-');
  const stateFilePath = path.join(userDataPath, STATE_FILENAME);
  writeOwnedState(userDataPath, {
    pid: 50124,
    command: 'C:/Ollama/ollama.exe',
    startedAt: '2026-03-18T00:00:00.000Z',
  });

  const logs = [];
  let syncKillCalled = false;

  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => true,
    getProcessCommandLineSyncImpl: () => 'C:/Windows/System32/notepad.exe',
    forceKillAnyRemainingLocalOllamaSyncImpl: () => { syncKillCalled = true; },
  });
  manager._isRunning = async () => false;
  manager._resolveCommand = () => null;

  await manager.start();

  assert.equal(syncKillCalled, false, 'a recycled pid must NEVER be force-killed');
  const warn = logs.find((entry) => entry.event === 'ollama.force_kill_identity_unconfirmed');
  assert.ok(warn, 'expected the ollama.force_kill_identity_unconfirmed WARN');
  assert.equal(warn.level, 'WARN');
  assert.equal(warn.details.pid, 50124);
  assert.equal(warn.details.phase, 'start');
  assert.equal(fs.existsSync(stateFilePath), false, 'the foreign record is dropped either way');
});

test('stop() refuses to kill an owned pid whose live command line does not match', async () => {
  const logs = [];
  const killCalls = [];
  const recording = makeRecordingStore({
    pid: 55071,
    app_owned: true,
    command: '/usr/bin/ollama',
    startedAt: '2026-01-01T00:00:00.000Z',
  });

  const manager = makeManager({
    stateStore: recording.store,
    platform: 'linux',
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => true,
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
    },
    // The OS recycled pid 55071 onto somebody else's process.
    getProcessCommandLineSyncImpl: () => '/usr/lib/firefox/firefox --new-window',
  });

  await manager.stop();

  assert.deepEqual(killCalls, [], 'a recycled pid must NEVER be killed');
  const warn = logs.find((e) => e.event === 'ollama.force_kill_identity_unconfirmed');
  assert.ok(warn, 'expected the ollama.force_kill_identity_unconfirmed WARN');
  assert.equal(warn.level, 'WARN');
  assert.equal(warn.details.pid, 55071);
  assert.ok(recording.deletes.length >= 1, 'the foreign record must be dropped');
});

test('stop() kills normally when the live command line still matches the record', async () => {
  const logs = [];
  const killCalls = [];
  let alive = true;
  const recording = makeRecordingStore({
    pid: 55073,
    app_owned: true,
    command: '/usr/bin/ollama',
    startedAt: '2026-01-01T00:00:00.000Z',
  });

  const manager = makeManager({
    stateStore: recording.store,
    platform: 'linux',
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => alive,
    killProcessTreeImpl: async (pid, options = {}) => {
      killCalls.push({ pid, force: Boolean(options.force) });
      alive = false;
    },
    getProcessCommandLineSyncImpl: () => '"/usr/bin/ollama"  serve',
  });

  await manager.stop();

  assert.deepEqual(killCalls.map((entry) => entry.pid), [55073]);
  const stopped = logs.find((e) => e.event === 'ollama.stopped');
  assert.ok(stopped);
  assert.equal(stopped.level, 'INFO');
  assert.equal(stopped.details.confirmed, true);
  assert.ok(recording.deletes.length >= 1, 'a confirmed exit clears the record');
});

// ---------------------------------------------------------------------------
// F2d — clear ownership only on a CONFIRMED exit
// ---------------------------------------------------------------------------

test('stop() retains owned state on disk when the persisted pid never confirms an exit', async () => {
  const userDataPath = makeUserDataDir('jenny-ollama-retain-');
  const stateFilePath = path.join(userDataPath, STATE_FILENAME);
  writeOwnedState(userDataPath, {
    pid: 70124,
    command: 'C:/Ollama/ollama.exe',
    startedAt: '2026-03-18T00:00:00.000Z',
  });

  const logs = [];
  const manager = new OllamaProcessManager({
    detectTrayConflictImpl: () => null,
    userDataPath,
    logger: (level, event, details) => logs.push({ level, event, details }),
    killProcessTreeImpl: async () => {},
    isProcessAliveImpl: () => true,
    getProcessCommandLineSyncImpl: () => 'C:/Ollama/ollama.exe serve',
    waitForProcessExitImpl: async () => false,
  });
  manager._killOrphanedRunners = async () => {};

  await manager.stop();

  const stopped = logs.find((entry) => entry.event === 'ollama.stopped');
  assert.ok(stopped, 'expected ollama.stopped log');
  assert.equal(stopped.level, 'WARN', 'an unconfirmed exit must not report a clean INFO stop');
  assert.equal(stopped.details.confirmed, false);
  assert.equal(stopped.details.retained, true);
  assert.equal(
    fs.existsSync(stateFilePath),
    true,
    'the owned-state record must be RETAINED when the exit is unconfirmed',
  );
});

// ---------------------------------------------------------------------------
// F2 / F2d — any_local scope: residue gate + owned-pid narrowing + retention
// ---------------------------------------------------------------------------

test('any_local stop skips the machine-wide sweep with no residue and no owned state', async () => {
  const logs = [];
  const sweeps = [];

  const manager = makeManager({
    platform: 'win32',
    logger: (level, event, details) => logs.push({ level, event, details }),
    forceKillAnyRemainingLocalOllamaSyncImpl: (options = {}) => {
      sweeps.push(options);
      return { discoveredPids: [], killedPids: [] };
    },
  });

  await manager.stop({ scope: 'any_local' });

  assert.deepEqual(sweeps, [], 'no sweep may run when this install never owned a local ollama');
  const skip = logs.find((e) => e.event === 'ollama.any_local_sweep_skipped');
  assert.ok(skip, 'expected the ollama.any_local_sweep_skipped observability log');
  assert.equal(skip.details.reason, 'no_local_ollama_residue');
  assert.equal(
    logs.some((e) => e.event === 'ollama.stopping_any_local'),
    false,
    'must not announce a sweep it does not run',
  );
});

test('any_local stop narrows the sweep to the owned pid and retains state on an unconfirmed exit', async () => {
  const logs = [];
  const sweeps = [];
  const recording = makeRecordingStore({
    pid: 55072,
    app_owned: true,
    command: '/usr/bin/ollama',
    startedAt: '2026-01-01T00:00:00.000Z',
  });

  const manager = makeManager({
    stateStore: recording.store,
    platform: 'win32',
    logger: (level, event, details) => logs.push({ level, event, details }),
    // The process never dies: every kill attempt fails to confirm an exit.
    isProcessAliveImpl: () => true,
    killProcessTreeImpl: async () => {},
    waitForProcessExitImpl: async () => false,
    getProcessCommandLineSyncImpl: () => '/usr/bin/ollama serve',
    forceKillAnyRemainingLocalOllamaSyncImpl: (options = {}) => {
      sweeps.push(options);
      return { discoveredPids: [55072], killedPids: [] };
    },
  });

  await manager.stop({ scope: 'any_local' });

  assert.equal(sweeps.length, 1, 'residue present, so the sweep runs');
  assert.deepEqual(sweeps[0].ownedPids, [55072],
    'the owned pid must be threaded through so the blanket by-name kill is skipped');
  const stopped = logs.find((e) => e.event === 'ollama.stopped');
  assert.ok(stopped, 'expected ollama.stopped log');
  assert.equal(stopped.level, 'WARN', 'an unconfirmed exit must not report a clean INFO stop');
  assert.equal(stopped.details.confirmed, false);
  assert.equal(stopped.details.retained, true);
  assert.deepEqual(recording.deletes, [],
    'the owned-state record must be RETAINED so the next launch can reap it');
});

test('failed-start cleanup retains ownership when the spawned process survives termination', async () => {
  const logs = [];
  const recording = makeRecordingStore({
    pid: 55073,
    app_owned: true,
    command: '/usr/bin/ollama',
  });
  const manager = makeManager({
    stateStore: recording.store,
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => true,
    waitForProcessExitImpl: async () => false,
  });
  manager._process = { pid: 55073 };

  await manager._cleanupFailedStartup('timeout');

  assert.deepEqual(recording.deletes, []);
  const warning = logs.find((entry) => entry.event === 'ollama.cleanup_unconfirmed');
  assert.ok(warning);
  assert.equal(warning.level, 'WARN');
  assert.equal(warning.details.pid, 55073);
  assert.equal(warning.details.confirmed, false);
  assert.equal(warning.details.retained, true);
});
