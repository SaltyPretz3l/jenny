const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  quitOllamaTrayAppSync,
  disableOllamaStartupShortcutsSync,
} = require('../services/backend/ollama-tray-remediation');

test('quitOllamaTrayAppSync kills each detected tray pid', () => {
  const detectImpl = () => ({
    detected: true,
    trayProcesses: [
      { pid: 111, name: 'ollama app.exe' },
      { pid: 222, name: 'ollama app.exe' },
    ],
    startupShortcuts: [],
  });
  const killedCalls = [];
  const forceKillByPidImpl = (pid, options) => {
    killedCalls.push({ pid, options });
    return { status: 0 };
  };

  const result = quitOllamaTrayAppSync({
    platform: 'win32',
    detectImpl,
    forceKillByPidImpl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.killedPids, [111, 222]);
  assert.equal(killedCalls.length, 2);
  assert.equal(killedCalls[0].pid, 111);
  assert.equal(killedCalls[1].pid, 222);
});

// Regression (F1): the earlier tests inject forceKillByPidImpl, so they never
// exercise the REAL forceKillByPidSync — which has no spawnSyncImpl default and
// would throw on `undefined(...)`. Bind the real killer here and only stub the
// spawnSync seam, proving taskkill is actually invoked per detected pid.
test('quitOllamaTrayAppSync invokes taskkill via the real forceKillByPidSync', () => {
  const detectImpl = () => ({
    detected: true,
    trayProcesses: [{ pid: 4321, name: 'ollama app.exe' }],
    startupShortcuts: [],
  });
  const spawnCalls = [];
  const spawnSyncImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return { status: 0 };
  };

  const result = quitOllamaTrayAppSync({
    platform: 'win32',
    detectImpl,
    // forceKillByPidImpl intentionally omitted → real forceKillByPidSync runs
    spawnSyncImpl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.killedPids, [4321]);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'taskkill');
  assert.deepEqual(spawnCalls[0].args, ['/PID', '4321', '/T', '/F']);
});

test('quitOllamaTrayAppSync is a no-op off win32', () => {
  const detectImpl = () => {
    throw new Error('must not be called off win32');
  };
  const result = quitOllamaTrayAppSync({
    platform: 'darwin',
    detectImpl,
  });
  assert.deepEqual(result, { ok: true, killedPids: [], reason: 'unsupported_platform' });
});

test('quitOllamaTrayAppSync isolates per-item kill failures', () => {
  const detectImpl = () => ({
    detected: true,
    trayProcesses: [
      { pid: 111, name: 'ollama app.exe' },
      { pid: 222, name: 'ollama app.exe' },
    ],
    startupShortcuts: [],
  });
  const attempted = [];
  const forceKillByPidImpl = (pid) => {
    attempted.push(pid);
    if (pid === 111) {
      throw new Error('taskkill failed');
    }
    return { status: 0 };
  };

  const result = quitOllamaTrayAppSync({
    platform: 'win32',
    detectImpl,
    forceKillByPidImpl,
  });

  // Both pids must have been attempted despite the first throwing.
  assert.deepEqual(attempted, [111, 222]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.killedPids, [222]);
});

test('quitOllamaTrayAppSync reports no_tray_process when nothing detected', () => {
  const detectImpl = () => ({ detected: false, trayProcesses: [], startupShortcuts: [] });
  const forceKillByPidImpl = () => {
    throw new Error('must not be called when no tray process is detected');
  };

  const result = quitOllamaTrayAppSync({
    platform: 'win32',
    detectImpl,
    forceKillByPidImpl,
  });

  assert.deepEqual(result, { ok: true, killedPids: [], reason: 'no_tray_process' });
});

test('quitOllamaTrayAppSync returns ok:false when every kill attempt throws', () => {
  const detectImpl = () => ({
    detected: true,
    trayProcesses: [{ pid: 111, name: 'ollama app.exe' }],
    startupShortcuts: [],
  });
  const forceKillByPidImpl = () => {
    throw new Error('taskkill failed');
  };

  const result = quitOllamaTrayAppSync({
    platform: 'win32',
    detectImpl,
    forceKillByPidImpl,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.killedPids, []);
});

test('quitOllamaTrayAppSync rejects failed kill results and bounds partial failure details', () => {
  const detectImpl = () => ({
    detected: true,
    trayProcesses: [{ pid: 606 }, { pid: 607 }],
    startupShortcuts: [],
  });

  const failed = quitOllamaTrayAppSync({
    platform: 'win32',
    detectImpl,
    forceKillByPidImpl: (pid) => (
      pid === 606 ? { status: 5, stderr: 'access denied' } : { error: new Error('denied') }
    ),
  });
  assert.deepEqual(failed, { ok: false, killedPids: [], reason: 'kill_failed' });

  const partial = quitOllamaTrayAppSync({
    platform: 'win32',
    detectImpl,
    forceKillByPidImpl: (pid) => (pid === 606 ? { status: 0 } : { status: 5 }),
  });
  assert.deepEqual(partial, { ok: true, killedPids: [606], reason: 'partial_failure' });
});

test('disableOllamaStartupShortcutsSync moves only matching .lnk entries out of the Startup folder', () => {
  const readdirSyncImpl = () => ['Ollama.lnk', 'notes.txt'];
  const renameCalls = [];
  const renameSyncImpl = (from, to) => {
    renameCalls.push({ from, to });
  };
  const mkdirCalls = [];
  const mkdirSyncImpl = (dir, options) => {
    mkdirCalls.push({ dir, options });
  };
  const existsSyncImpl = () => false;

  const result = disableOllamaStartupShortcutsSync({
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
    readdirSyncImpl,
    renameSyncImpl,
    existsSyncImpl,
    mkdirSyncImpl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.disabled, ['Ollama.lnk']);
  assert.deepEqual(result.skipped, []);
  assert.equal(mkdirCalls.length, 1);
  assert.match(mkdirCalls[0].dir, /jenny[\\/]disabled-startup-shortcuts$/);
  assert.deepEqual(mkdirCalls[0].options, { recursive: true });
  assert.equal(renameCalls.length, 1);
  assert.match(renameCalls[0].from, /Startup[\\/]Ollama\.lnk$/);
  // Regression: the target must be OUTSIDE the Startup folder — Windows tries
  // to open every file there at login, so a renamed-in-place ".disabled" file
  // produces an "open with" picker prompt on every login.
  assert.doesNotMatch(renameCalls[0].to, /Startup/);
  assert.match(renameCalls[0].to, /disabled-startup-shortcuts[\\/]Ollama\.lnk\.disabled$/);
  // notes.txt must never be touched — findOllamaStartupShortcutsSync already
  // filters it out, but assert the rename call count stays at 1 as a guard.
});

test('disableOllamaStartupShortcutsSync uniquifies when the quarantine target already exists', () => {
  const readdirSyncImpl = () => ['Ollama.lnk'];
  const renameCalls = [];
  const renameSyncImpl = (from, to) => {
    renameCalls.push({ from, to });
  };
  // A leftover from an earlier disable must not block moving a re-added
  // shortcut out of Startup — the move must still happen, to a -2 suffix.
  const existsSyncImpl = (p) => /Ollama\.lnk\.disabled$/.test(p);

  const result = disableOllamaStartupShortcutsSync({
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
    readdirSyncImpl,
    renameSyncImpl,
    existsSyncImpl,
    mkdirSyncImpl: () => {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.disabled, ['Ollama.lnk']);
  assert.deepEqual(result.skipped, []);
  assert.equal(renameCalls.length, 1);
  assert.match(renameCalls[0].to, /disabled-startup-shortcuts[\\/]Ollama\.lnk\.disabled-2$/);
});

test('disableOllamaStartupShortcutsSync treats ENOENT source as benign', () => {
  const readdirSyncImpl = () => ['Ollama.lnk'];
  const renameSyncImpl = () => {
    const error = new Error('not found');
    error.code = 'ENOENT';
    throw error;
  };
  const existsSyncImpl = () => false;

  const result = disableOllamaStartupShortcutsSync({
    platform: 'win32',
    env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
    readdirSyncImpl,
    renameSyncImpl,
    existsSyncImpl,
    mkdirSyncImpl: () => {},
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.disabled, []);
  assert.deepEqual(result.skipped, ['Ollama.lnk']);
});

test('disableOllamaStartupShortcutsSync is a no-op off win32', () => {
  const readdirSyncImpl = () => {
    throw new Error('must not be called off win32');
  };
  const result = disableOllamaStartupShortcutsSync({
    platform: 'darwin',
    readdirSyncImpl,
  });
  assert.deepEqual(result, { ok: true, disabled: [], skipped: [], reason: 'unsupported_platform' });
});
