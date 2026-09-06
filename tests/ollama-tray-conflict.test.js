const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectOllamaTrayConflictAsync,
  detectOllamaTrayConflictSync,
  findOllamaStartupShortcutsSync,
  getWindowsStartupFolderPath,
  isSilentExternalKillSignature,
  listLocalOllamaProcessesViaPowerShellAsync,
  TRAY_CONFLICT_REMEDIATION,
} = require('../services/backend/ollama-tray-conflict');

const FAKE_ENV = { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' };
const STARTUP_DIR = path.join(
  FAKE_ENV.APPDATA,
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'Startup',
);

test('getWindowsStartupFolderPath derives the Startup folder from APPDATA', () => {
  assert.equal(getWindowsStartupFolderPath(FAKE_ENV), STARTUP_DIR);
  assert.equal(getWindowsStartupFolderPath({}), '');
  assert.equal(getWindowsStartupFolderPath({ APPDATA: '   ' }), '');
});

test('findOllamaStartupShortcutsSync matches ollama .lnk entries case-insensitively', () => {
  const shortcuts = findOllamaStartupShortcutsSync({
    env: FAKE_ENV,
    readdirSyncImpl: (dir) => {
      assert.equal(dir, STARTUP_DIR);
      return ['Ollama.lnk', 'OLLAMA APP.LNK', 'ollama.txt', 'Other.lnk'];
    },
  });
  assert.deepEqual(shortcuts, ['Ollama.lnk', 'OLLAMA APP.LNK']);
});

test('findOllamaStartupShortcutsSync returns [] on unreadable dir or missing APPDATA', () => {
  assert.deepEqual(
    findOllamaStartupShortcutsSync({
      env: FAKE_ENV,
      readdirSyncImpl: () => {
        throw new Error('ENOENT');
      },
    }),
    [],
  );
  assert.deepEqual(findOllamaStartupShortcutsSync({ env: {} }), []);
});

test('detectOllamaTrayConflictSync no-ops off win32', () => {
  const result = detectOllamaTrayConflictSync({
    platform: 'linux',
    env: FAKE_ENV,
    listProcessesImpl: () => {
      throw new Error('must not be called off win32');
    },
    readdirSyncImpl: () => {
      throw new Error('must not be called off win32');
    },
  });
  assert.deepEqual(result, { detected: false, trayProcesses: [], startupShortcuts: [] });
});

test('detectOllamaTrayConflictSync flags a running tray process', () => {
  const result = detectOllamaTrayConflictSync({
    platform: 'win32',
    env: FAKE_ENV,
    listProcessesImpl: () => [
      { pid: 100, parentPid: 1, name: 'ollama.exe' },
      { pid: 200, parentPid: 1, name: 'ollama app.exe' },
    ],
    readdirSyncImpl: () => [],
  });
  assert.equal(result.detected, true);
  assert.deepEqual(result.trayProcesses, [{ pid: 200, name: 'ollama app.exe' }]);
  assert.deepEqual(result.startupShortcuts, []);
});

test('detectOllamaTrayConflictSync flags a Startup shortcut with no tray process', () => {
  const result = detectOllamaTrayConflictSync({
    platform: 'win32',
    env: FAKE_ENV,
    listProcessesImpl: () => [{ pid: 100, parentPid: 1, name: 'ollama.exe' }],
    readdirSyncImpl: () => ['Ollama.lnk'],
  });
  assert.equal(result.detected, true);
  assert.deepEqual(result.trayProcesses, []);
  assert.deepEqual(result.startupShortcuts, ['Ollama.lnk']);
});

test('detectOllamaTrayConflictSync reports clean when nothing is found', () => {
  const result = detectOllamaTrayConflictSync({
    platform: 'win32',
    env: FAKE_ENV,
    listProcessesImpl: () => [],
    readdirSyncImpl: () => [],
  });
  assert.deepEqual(result, { detected: false, trayProcesses: [], startupShortcuts: [] });
});

test('detectOllamaTrayConflictSync survives a throwing process lister', () => {
  const result = detectOllamaTrayConflictSync({
    platform: 'win32',
    env: FAKE_ENV,
    listProcessesImpl: () => {
      throw new Error('powershell exploded');
    },
    readdirSyncImpl: () => ['Ollama.lnk'],
  });
  assert.equal(result.detected, true);
  assert.deepEqual(result.trayProcesses, []);
  assert.deepEqual(result.startupShortcuts, ['Ollama.lnk']);
});

test('isSilentExternalKillSignature matches code 1, no signal, no level=ERROR stderr', () => {
  assert.equal(
    isSilentExternalKillSignature({ code: 1, signal: null, stderrTail: null }),
    true,
  );
  assert.equal(
    isSilentExternalKillSignature({
      code: 1,
      signal: null,
      stderrTail: 'time=x level=INFO msg=listening\n[GIN] request',
    }),
    true,
  );
});

test('isSilentExternalKillSignature rejects non-matching exits', () => {
  assert.equal(isSilentExternalKillSignature({ code: 0, signal: null, stderrTail: '' }), false);
  assert.equal(isSilentExternalKillSignature({ code: 2, signal: null, stderrTail: '' }), false);
  assert.equal(isSilentExternalKillSignature({ code: 1, signal: 'SIGKILL', stderrTail: '' }), false);
  assert.equal(
    isSilentExternalKillSignature({
      code: 1,
      signal: null,
      stderrTail: 'time=x level=ERROR msg="bind: address in use"',
    }),
    false,
  );
});

test('TRAY_CONFLICT_REMEDIATION names the tray quit + Startup shortcut removal', () => {
  assert.match(TRAY_CONFLICT_REMEDIATION, /tray/i);
  assert.match(TRAY_CONFLICT_REMEDIATION, /Startup/i);
});

test('detectOllamaTrayConflictAsync awaits the process lister and filters tray entries', async () => {
  let listerArgs = null;
  const result = await detectOllamaTrayConflictAsync({
    platform: 'win32',
    env: FAKE_ENV,
    listProcessesImpl: async (options) => {
      listerArgs = options;
      return [
        { pid: 100, name: 'ollama.exe' },
        { pid: 4242, name: 'ollama app.exe' },
        { pid: 4243, name: 'Ollama App 0.9.exe' },
      ];
    },
    readdirSyncImpl: () => [],
  });
  assert.equal(listerArgs.platform, 'win32');
  assert.equal(result.detected, true);
  assert.deepEqual(result.trayProcesses, [
    { pid: 4242, name: 'ollama app.exe' },
    { pid: 4243, name: 'Ollama App 0.9.exe' },
  ]);
  assert.deepEqual(result.startupShortcuts, []);
});

test('detectOllamaTrayConflictAsync no-ops off win32 without touching the lister', async () => {
  let listerCalled = false;
  const result = await detectOllamaTrayConflictAsync({
    platform: 'linux',
    env: FAKE_ENV,
    listProcessesImpl: async () => {
      listerCalled = true;
      return [{ pid: 4242, name: 'ollama app.exe' }];
    },
    readdirSyncImpl: () => ['Ollama.lnk'],
  });
  assert.equal(listerCalled, false);
  assert.deepEqual(result, { detected: false, trayProcesses: [], startupShortcuts: [] });
});

test('detectOllamaTrayConflictAsync degrades a rejecting lister to the shortcut half', async () => {
  const result = await detectOllamaTrayConflictAsync({
    platform: 'win32',
    env: FAKE_ENV,
    listProcessesImpl: async () => {
      throw new Error('lister exploded');
    },
    readdirSyncImpl: () => ['Ollama.lnk'],
  });
  assert.equal(result.detected, true);
  assert.deepEqual(result.trayProcesses, []);
  assert.deepEqual(result.startupShortcuts, ['Ollama.lnk']);
});

test('listLocalOllamaProcessesViaPowerShellAsync parses records without blocking on the callback', async () => {
  const records = await listLocalOllamaProcessesViaPowerShellAsync({
    execFileImpl: (command, args, options, callback) => {
      assert.equal(command, 'powershell');
      assert.ok(args.includes('-NoProfile'));
      assert.ok(Number(options.timeout) > 0);
      setImmediate(() => callback(
        null,
        JSON.stringify([
          { ProcessId: 4242, ParentProcessId: 1, Name: 'ollama app.exe' },
          { ProcessId: 7, ParentProcessId: 1, Name: 'notollama.exe' },
        ]),
      ));
    },
  });
  assert.deepEqual(records.map((entry) => entry.pid), [4242]);
});

test('listLocalOllamaProcessesViaPowerShellAsync resolves [] on spawn error or bad JSON', async () => {
  assert.deepEqual(
    await listLocalOllamaProcessesViaPowerShellAsync({
      execFileImpl: (command, args, options, callback) => {
        setImmediate(() => callback(new Error('spawn failed')));
      },
    }),
    [],
  );
  assert.deepEqual(
    await listLocalOllamaProcessesViaPowerShellAsync({
      execFileImpl: (command, args, options, callback) => {
        setImmediate(() => callback(null, 'not json'));
      },
    }),
    [],
  );
});
