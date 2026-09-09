const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OllamaProcessManager,
  runOllamaDisposeForceKillSweep,
} = require('../services/backend/ollama-process-manager');

function makeManager({ commandLine = '', alive = true, stateOverrides = {} } = {}) {
  const calls = { deletes: 0, logs: [], sweeps: [] };
  const state = { pid: 61001, command: 'C:/Ollama/ollama.exe', app_owned: true, ...stateOverrides };
  const manager = new OllamaProcessManager({
    stateStore: {
      read: () => state,
      write: () => {},
      delete: () => { calls.deletes += 1; },
    },
    platform: 'win32',
    logger: (level, event, details) => calls.logs.push({ level, event, details }),
    isProcessAliveImpl: () => alive,
    getProcessCommandLineSyncImpl: () => commandLine,
    killProcessTreeImpl: async () => {},
    waitForProcessExitImpl: async () => true,
    forceKillAnyRemainingLocalOllamaSyncImpl: (options) => {
      calls.sweeps.push(options);
      return { discoveredPids: [61001], killedPids: [61001], verifiedAllKilled: true };
    },
    clearOwnedOllamaStateImpl: () => {},
    detectTrayConflictImpl: () => null,
  });
  return { calls, manager };
}

test('any_local stop rejects a reused owned pid before any process sweep', async () => {
  const { calls, manager } = makeManager({ commandLine: 'C:/Windows/System32/notepad.exe' });

  await manager.stop({ scope: 'any_local' });

  assert.deepEqual(calls.sweeps, []);
  assert.equal(calls.deletes, 1, 'a positively mismatched stale record is cleared');
  assert.ok(calls.logs.some((entry) => entry.event === 'ollama.force_kill_identity_unconfirmed'
    && entry.details.phase === 'stop_any_local'
    && entry.details.reason === 'mismatch'));
  assert.ok(calls.logs.some((entry) => entry.event === 'ollama.stopped'
    && entry.details.confirmed === false
    && entry.details.retained === false));
});

test('any_local stop retains state when identity lookup is unavailable', async () => {
  const { calls, manager } = makeManager({ commandLine: '' });

  await manager.stop({ scope: 'any_local' });

  assert.deepEqual(calls.sweeps, []);
  assert.equal(calls.deletes, 0);
  assert.ok(calls.logs.some((entry) => entry.event === 'ollama.stopped'
    && entry.details.confirmed === false
    && entry.details.retained === true));
});

test('dispose clears stale ownership without sweeping', () => {
  const { calls, manager } = makeManager({ commandLine: 'C:/Ollama/ollama.exe serve', alive: false });

  const result = runOllamaDisposeForceKillSweep(manager);

  assert.equal(result.skipped, 'stale_owned_pid');
  assert.deepEqual(calls.sweeps, []);
  assert.equal(calls.deletes, 1);
});

test('dispose scopes cleanup to a live verified owned pid', () => {
  const { calls, manager } = makeManager({ commandLine: 'C:/Ollama/ollama.exe serve' });

  const result = runOllamaDisposeForceKillSweep(manager);

  assert.deepEqual(calls.sweeps[0].ownedPids, [61001]);
  assert.deepEqual(result.killedPids, [61001]);
});

test('dispose rejects a reused pid without discovering or killing other processes', () => {
  const { calls, manager } = makeManager({ commandLine: 'C:/Windows/System32/notepad.exe' });

  const result = runOllamaDisposeForceKillSweep(manager);

  assert.equal(result.skipped, 'identity_unconfirmed');
  assert.deepEqual(calls.sweeps, []);
  assert.equal(calls.deletes, 1);
});

test('dispose retains unknown ownership without a sweep', () => {
  const { calls, manager } = makeManager();
  assert.equal(runOllamaDisposeForceKillSweep(manager).skipped, 'identity_unconfirmed');
  assert.deepEqual(calls.sweeps, []);
  assert.equal(calls.deletes, 0);
});

test('startup retains a verified owned process record when cleanup does not stop it', async () => {
  const { calls, manager } = makeManager({ commandLine: 'C:/Ollama/ollama.exe serve' });
  manager._isRunning = async () => false;
  manager._resolveCommand = () => null;
  await manager.start();
  assert.deepEqual(calls.sweeps[0].ownedPids, [61001]);
  assert.equal(calls.deletes, 0, 'a still-live owner remains available for cleanup retry');
});

for (const command of [123, {}, [], null, '']) {
  test(`malformed owned command cannot authorize normal or dispose cleanup: ${JSON.stringify(command)}`, async () => {
    const { calls, manager } = makeManager({
      commandLine: 'C:/Ollama/ollama.exe serve', stateOverrides: { command },
    });
    await manager.stop({ scope: 'any_local' });
    runOllamaDisposeForceKillSweep(manager);
    assert.deepEqual(calls.sweeps, []);
  });
}

for (const discoveryFails of [false, true]) {
  for (const killSucceeds of [false, true]) {
    test(`verified ownership survives missing enumeration: discoveryFails=${discoveryFails}, killSucceeds=${killSucceeds}`, () => {
      const { shutdownAnyLocalOllamaSync } = require('../services/backend/ollama-shutdown');
      let alive = true;
      let statePresent = true;
      const kills = [];
      const result = shutdownAnyLocalOllamaSync({
        userDataPath: '/inert-jenny-profile',
        platform: 'win32',
        fsImpl: {
          existsSync: () => statePresent,
          readFileSync: () => JSON.stringify({ pid: 61001, command: 'ollama.exe serve', app_owned: true }),
          unlinkSync: () => { statePresent = false; },
        },
        getProcessCommandLineSyncImpl: () => 'ollama.exe serve',
        execFileSyncImpl: () => {
          if (discoveryFails) throw new Error('enumeration unavailable');
          return '[]';
        },
        spawnSyncImpl: (command, args) => {
          kills.push({ command, args });
          if (killSucceeds) alive = false;
          return { status: killSucceeds ? 0 : 5 };
        },
        isProcessAliveImpl: (pid) => pid === 61001 && alive,
      });
      assert.equal(result.verifiedAllKilled, killSucceeds);
      assert.equal(statePresent, !killSucceeds);
      assert.ok(kills.length > 0, 'the known root must be attempted even without discovery');
      assert.ok(kills.every(({ command, args }) => command === 'taskkill'
        && args.includes('/PID') && args.includes('61001') && !args.includes('/IM')));
      assert.deepEqual(result.discoveredPids, [61001]);
    });
  }
}
