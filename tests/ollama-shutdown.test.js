const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listLocalOllamaProcessesSync,
  forceKillAnyRemainingLocalOllamaSync,
  forceKillAnyRemainingLocalOllamaVerifiedSync,
  shutdownWslSync,
  shutdownWslVerifiedSync,
  shutdownAnyLocalOllamaSync,
} = require('../services/backend/ollama-shutdown');

// F2/F2a: shutdownAnyLocalOllamaSync is now residue-gated on an owned-state
// record. These fakes stand in for that file so the tests never touch disk.
function ownedStateFs(record) {
  return {
    existsSync: () => Boolean(record),
    readFileSync: () => JSON.stringify(record || {}),
  };
}

const FAKE_USER_DATA_PATH = '/fake/userData/jenny-ollama-shutdown-test';

test('listLocalOllamaProcessesSync discovers processes via PowerShell on win32', () => {
  const psJson = JSON.stringify([
    { ProcessId: 1234, ParentProcessId: 100, Name: 'ollama.exe', ExecutablePath: 'C:\\ollama.exe', CommandLine: 'ollama serve' },
    { ProcessId: 5678, ParentProcessId: 1234, Name: 'ollama.exe', ExecutablePath: 'C:\\ollama.exe', CommandLine: 'ollama runner' },
    { ProcessId: 9012, ParentProcessId: 0, Name: 'Ollama App.exe', ExecutablePath: 'C:\\Users\\test\\AppData\\Local\\Programs\\Ollama\\Ollama App.exe', CommandLine: '"Ollama App.exe"' },
  ]);

  const result = listLocalOllamaProcessesSync({
    platform: 'win32',
    execFileSyncImpl: (_cmd, _args, _opts) => psJson,
  });

  assert.equal(result.length, 3);
  assert.equal(result[0].pid, 1234);
  assert.equal(result[0].parentPid, 100);
  assert.equal(result[0].name, 'ollama.exe');
  assert.equal(result[1].pid, 5678);
  assert.equal(result[1].parentPid, 1234);
  assert.equal(result[2].pid, 9012);
  assert.equal(result[2].name, 'Ollama App.exe');
});

test('listLocalOllamaProcessesSync falls back to WMIC when PowerShell fails', () => {
  let callIndex = 0;
  const result = listLocalOllamaProcessesSync({
    platform: 'win32',
    execFileSyncImpl: (_cmd, _args, _opts) => {
      callIndex += 1;
      if (callIndex === 1) {
        throw new Error('PowerShell not available');
      }
      return 'Node,Name,ParentProcessId,ProcessId\nHOST,Ollama App.exe,200,3456\n';
    },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].pid, 3456);
  assert.equal(result[0].parentPid, 200);
  assert.equal(result[0].name, 'Ollama App.exe');
});

test('forceKillAnyRemainingLocalOllamaSync kills discovered processes by PID and by name', () => {
  const spawnCalls = [];
  const psJson = JSON.stringify([
    { ProcessId: 1111, ParentProcessId: 0, Name: 'ollama.exe' },
    { ProcessId: 2222, ParentProcessId: 1111, Name: 'ollama.exe' },
  ]);

  const result = forceKillAnyRemainingLocalOllamaSync({
    platform: 'win32',
    execFileSyncImpl: () => psJson,
    spawnSyncImpl: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0 };
    },
    isProcessAliveImpl: () => true,
  });

  assert.deepEqual(result.discoveredPids, [1111, 2222]);
  assert.deepEqual(result.killedPids, [1111, 2222]);

  const pidKills = spawnCalls.filter(
    (c) => c.cmd === 'taskkill' && c.args.includes('/PID'),
  );
  assert.equal(pidKills.length, 2);
  assert.equal(pidKills[0].args[1], '1111');
  assert.equal(pidKills[1].args[1], '2222');

  const nameKills = spawnCalls.filter(
    (c) => c.cmd === 'taskkill' && c.args.includes('/IM'),
  );
  assert.equal(nameKills.length, 3);
  assert.ok(nameKills[0].args.includes('ollama.exe'));
  assert.ok(nameKills[1].args.includes('ollama_llama_server.exe'));
  assert.ok(nameKills[2].args.includes('ollama app.exe'));
});

test('forceKillAnyRemainingLocalOllamaVerifiedSync retries when processes survive', () => {
  const logs = [];
  let discoveryCallCount = 0;
  let aliveCallCount = 0;

  const result = forceKillAnyRemainingLocalOllamaVerifiedSync({
    platform: 'win32',
    execFileSyncImpl: () => {
      discoveryCallCount += 1;
      if (discoveryCallCount <= 2) {
        return JSON.stringify([
          { ProcessId: 4444, ParentProcessId: 0, Name: 'ollama.exe' },
        ]);
      }
      return '[]';
    },
    spawnSyncImpl: () => ({ status: 0 }),
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => {
      aliveCallCount += 1;
      return aliveCallCount <= 2;
    },
    maxRetries: 3,
    retryDelayMs: 0,
  });

  assert.ok(discoveryCallCount >= 2, `expected >= 2 discovery calls, got ${discoveryCallCount}`);
  assert.ok(
    logs.some((entry) => entry.event === 'ollama.processes_survived_kill'),
    'expected ollama.processes_survived_kill log',
  );
  assert.ok(
    logs.some((entry) => entry.event === 'ollama.verified_all_killed'),
    'expected ollama.verified_all_killed log',
  );
});

test('shutdownWslSync calls wsl --shutdown on win32 with 15s timeout', () => {
  const spawnCalls = [];

  shutdownWslSync({
    platform: 'win32',
    spawnSyncImpl: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args: [...args], timeout: opts.timeout });
      return { status: 0 };
    },
  });

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].cmd, 'wsl');
  assert.deepEqual(spawnCalls[0].args, ['--shutdown']);
  assert.equal(spawnCalls[0].timeout, 15000);
});

test('shutdownWslVerifiedSync retries when VmmemWSL survives', () => {
  const logs = [];
  let wslShutdownCount = 0;
  let vmmemCheckCount = 0;

  shutdownWslVerifiedSync({
    platform: 'win32',
    spawnSyncImpl: (cmd, args, opts) => {
      if (cmd === 'wsl') {
        wslShutdownCount += 1;
      }
      return { status: 0 };
    },
    logger: (level, event, details) => logs.push({ level, event, details }),
    retryDelayMs: 0,
    isVmmemWslAliveSyncImpl: () => {
      vmmemCheckCount += 1;
      return vmmemCheckCount <= 1;
    },
  });

  assert.ok(wslShutdownCount >= 2, `expected >= 2 wsl shutdown calls, got ${wslShutdownCount}`);
  assert.ok(
    logs.some((entry) => entry.event === 'ollama.vmmemwsl_survived_shutdown'),
    'expected ollama.vmmemwsl_survived_shutdown log',
  );
  assert.ok(
    logs.some((entry) => entry.event === 'ollama.vmmemwsl_verified_dead'),
    'expected ollama.vmmemwsl_verified_dead log',
  );
});

test('shutdownWslVerifiedSync force-kills VmmemWSL when all retries fail', () => {
  const spawnCalls = [];

  shutdownWslVerifiedSync({
    platform: 'win32',
    spawnSyncImpl: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0 };
    },
    retryDelayMs: 0,
    maxRetries: 1,
    isVmmemWslAliveSyncImpl: () => true,
  });

  const vmmemKill = spawnCalls.find(
    (c) => c.cmd === 'taskkill' && c.args.includes('vmmemwsl'),
  );
  assert.ok(vmmemKill, 'expected taskkill /IM vmmemwsl /F to be called');
  assert.ok(vmmemKill.args.includes('/F'), 'expected /F flag');
});

// F2: with no owned-state record on disk this install never owned a local
// ollama, so an ordinary quit must not discover or kill ANYTHING.
test('shutdownAnyLocalOllamaSync skips the whole sweep when no owned state exists', () => {
  const logs = [];
  const spawnCalls = [];
  let discoveryCalls = 0;

  const result = shutdownAnyLocalOllamaSync({
    userDataPath: FAKE_USER_DATA_PATH,
    platform: 'win32',
    fsImpl: ownedStateFs(null),
    execFileSyncImpl: () => {
      discoveryCalls += 1;
      return JSON.stringify([{ ProcessId: 4242, ParentProcessId: 0, Name: 'ollama.exe' }]);
    },
    spawnSyncImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0, stdout: '' };
    },
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => true,
  });

  assert.deepEqual(result, { discoveredPids: [], killedPids: [], skipped: 'no_owned_state' });
  assert.equal(discoveryCalls, 0, 'no process discovery may run without owned residue');
  assert.deepEqual(spawnCalls, [], 'no kill/wsl/ollama subprocess may run without owned residue');
  const skip = logs.find((entry) => entry.event === 'ollama.any_local_sweep_skipped');
  assert.ok(skip, 'expected the ollama.any_local_sweep_skipped observability log');
  assert.equal(skip.details.reason, 'no_owned_state');
});

// F2b (OWNER DECISION): `wsl --shutdown` terminates EVERY WSL2 distribution and
// the shared VM (Docker Desktop backend, dev containers, in-flight builds). It
// must never run as a side effect of quitting the app.
// F2a(4): `ollama stop <model>` unloads every resident model from VRAM,
// including another tool's — also off the quit path.
test('shutdownAnyLocalOllamaSync runs NO wsl shutdown and NO graceful model stop on quit', () => {
  const spawnCalls = [];
  let killAttempted = false;

  assert.doesNotThrow(() => {
    shutdownAnyLocalOllamaSync({
      userDataPath: FAKE_USER_DATA_PATH,
      platform: 'win32',
      fsImpl: ownedStateFs({ pid: 9999, command: 'C:\\Ollama\\ollama.exe', app_owned: true }),
      execFileSyncImpl: (cmd) => {
        assert.notEqual(cmd, 'where', 'the ollama CLI must not be resolved on the quit path');
        return JSON.stringify([
          { ProcessId: 9999, ParentProcessId: 0, Name: 'ollama.exe' },
        ]);
      },
      spawnSyncImpl: (cmd, args) => {
        spawnCalls.push({ cmd, args: [...args] });
        if (cmd === 'taskkill' && args.includes('/PID')) {
          killAttempted = true;
          throw new Error('taskkill exploded');
        }
        return { status: 0, stdout: '' };
      },
      isProcessAliveImpl: () => true,
    });
  }, 'the taskkill failure must be contained, not propagated');

  assert.ok(killAttempted, 'expected taskkill to be attempted');
  assert.deepEqual(
    spawnCalls.filter((c) => c.cmd === 'wsl'),
    [],
    'wsl --shutdown must NOT run on an ordinary quit',
  );
  assert.deepEqual(
    spawnCalls.filter((c) => c.cmd === 'tasklist' || (c.args || []).includes('vmmemwsl')),
    [],
    'no VmmemWSL probing or force-kill may run on an ordinary quit',
  );
  assert.deepEqual(
    spawnCalls.filter((c) => c.args[0] === 'ps' || c.args[0] === 'stop'),
    [],
    '`ollama ps` / `ollama stop <model>` must NOT run on an ordinary quit',
  );
});

// F2(3): once the owned pid is known, the blanket `taskkill /IM <image> /T /F`
// pass is skipped — it cannot tell our daemon from another tool's.
test('shutdownAnyLocalOllamaSync kills only the owned pid and its verified descendants', () => {
  const logs = [];
  const spawnCalls = [];

  shutdownAnyLocalOllamaSync({
    userDataPath: FAKE_USER_DATA_PATH,
    platform: 'win32',
    fsImpl: ownedStateFs({ pid: 10001, command: 'ollama.exe serve', app_owned: true }),
    execFileSyncImpl: () => JSON.stringify([
      { ProcessId: 10001, ParentProcessId: 0, Name: 'ollama.exe' },
      { ProcessId: 10002, ParentProcessId: 10001, Name: 'ollama.exe' },
      { ProcessId: 20001, ParentProcessId: 0, Name: 'ollama.exe' },
      { ProcessId: 20002, ParentProcessId: 20001, Name: 'ollama.exe' },
    ]),
    spawnSyncImpl: (cmd, args) => {
      if (cmd === 'taskkill' && args.includes('/PID') && args.includes('10001')) {
        throw new Error('taskkill exploded');
      }
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0, stdout: '', stderr: '' };
    },
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => true,
  });

  assert.ok(
    logs.some((entry) => entry.event === 'ollama.force_kill_failed' && entry.details.pid === 10001),
    'expected ollama.force_kill_failed log for the failed PID kill',
  );
  assert.ok(
    spawnCalls.some((call) => call.cmd === 'taskkill' && call.args.includes('/PID') && call.args.includes('10002')),
    'expected cleanup to continue to the second PID after the first kill failed',
  );
  assert.deepEqual(
    spawnCalls.filter((call) => call.cmd === 'taskkill' && call.args.includes('/PID')
      && (call.args.includes('20001') || call.args.includes('20002'))),
    [],
    'unrelated Ollama roots and their descendants must not be killed',
  );
  assert.deepEqual(
    spawnCalls.filter((call) => call.cmd === 'taskkill' && call.args.includes('/IM')),
    [],
    'the blanket taskkill /IM sweep must be skipped once the owned pid is known',
  );
  const skipped = logs.find((entry) => entry.event === 'ollama.force_kill_by_name_skipped');
  assert.ok(skipped, 'expected the ollama.force_kill_by_name_skipped observability log');
  assert.deepEqual(skipped.details.ownedPids, [10001]);
});

test('shutdownAnyLocalOllamaSync full sequence verifies no processes remain', () => {
  const logs = [];
  const spawnCalls = [];
  let discoveryCallCount = 0;
  let aliveCallCount = 0;

  shutdownAnyLocalOllamaSync({
    userDataPath: FAKE_USER_DATA_PATH,
    platform: 'win32',
    fsImpl: ownedStateFs({ pid: 7001, command: 'ollama.exe serve', app_owned: true }),
    execFileSyncImpl: (cmd) => {
      assert.notEqual(cmd, 'where', 'the ollama CLI must not be resolved on the quit path');
      discoveryCallCount += 1;
      if (discoveryCallCount === 1) {
        return JSON.stringify([
          { ProcessId: 7001, ParentProcessId: 0, Name: 'ollama.exe' },
          { ProcessId: 7002, ParentProcessId: 7001, Name: 'ollama.exe' },
        ]);
      }
      return '[]';
    },
    spawnSyncImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0, stdout: '' };
    },
    logger: (level, event, details) => logs.push({ level, event, details }),
    isProcessAliveImpl: () => {
      aliveCallCount += 1;
      return aliveCallCount <= 2;
    },
  });

  assert.ok(discoveryCallCount >= 2, `expected >= 2 discovery calls, got ${discoveryCallCount}`);

  const pidKills = spawnCalls.filter(
    (c) => c.cmd === 'taskkill' && c.args.includes('/PID'),
  );
  assert.ok(pidKills.length >= 2, `expected >= 2 PID kills, got ${pidKills.length}`);

  assert.ok(
    logs.some((entry) => entry.event === 'ollama.force_kill' && entry.details.pid === 7001),
    'expected force_kill log for pid 7001',
  );
  assert.ok(
    logs.some((entry) => entry.event === 'ollama.force_kill' && entry.details.pid === 7002),
    'expected force_kill log for pid 7002',
  );

  assert.deepEqual(
    spawnCalls.filter((c) => c.cmd === 'wsl'),
    [],
    'wsl --shutdown must NOT be reachable from the quit path',
  );

  assert.ok(
    logs.some((entry) => entry.event === 'ollama.verified_all_killed'),
    'expected ollama.verified_all_killed log',
  );
});

// The by-name sweep still runs for callers that cannot name an owned pid.
test('forceKillAnyRemainingLocalOllamaSync keeps the by-name sweep when ownedPids is empty', () => {
  const spawnCalls = [];
  forceKillAnyRemainingLocalOllamaSync({
    platform: 'win32',
    execFileSyncImpl: () => '[]',
    spawnSyncImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0 };
    },
    isProcessAliveImpl: () => false,
    ownedPids: [],
  });
  assert.ok(
    spawnCalls.some((c) => c.cmd === 'taskkill' && c.args.includes('/IM')),
    'expected the by-name sweep when no owned pid is known',
  );
});

test('forceKillAnyRemainingLocalOllamaVerifiedSync does not verify a failed live PID kill', () => {
  const logs = [];

  const result = forceKillAnyRemainingLocalOllamaVerifiedSync({
    platform: 'win32',
    maxRetries: 1,
    retryDelayMs: 0,
    execFileSyncImpl: () => JSON.stringify([
      { ProcessId: 303, ParentProcessId: 0, Name: 'ollama.exe' },
    ]),
    spawnSyncImpl: () => ({ status: 5, stderr: 'access denied' }),
    isProcessAliveImpl: () => true,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.deepEqual(result.discoveredPids, [303]);
  assert.equal(result.verifiedAllKilled, false);
  assert.ok(logs.some((entry) => entry.event === 'ollama.processes_survived_kill'));
  assert.equal(logs.some((entry) => entry.event === 'ollama.verified_all_killed'), false);
});

test('shutdownAnyLocalOllamaSync retains owned state when the PID survives verification', () => {
  const calls = [];
  const logs = [];
  const fsImpl = {
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ pid: 505, command: 'ollama.exe serve' }),
    unlinkSync: () => calls.push(['unlink']),
  };

  const result = shutdownAnyLocalOllamaSync({
    userDataPath: FAKE_USER_DATA_PATH,
    platform: 'win32',
    fsImpl,
    execFileSyncImpl: () => JSON.stringify([
      { ProcessId: 505, ParentProcessId: 0, Name: 'ollama.exe' },
    ]),
    spawnSyncImpl: () => ({ status: 5, stderr: 'access denied' }),
    isProcessAliveImpl: () => true,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.equal(result.verifiedAllKilled, false);
  assert.deepEqual(calls, []);
  assert.ok(logs.some((entry) => entry.level === 'WARN'
    && entry.event === 'ollama.state_retained'
    && entry.details.pid === 505));
});

test('shutdownAnyLocalOllamaSync fails closed on a malformed owned-state record', () => {
  const logs = [];
  const spawnCalls = [];
  let discoveryCalls = 0;
  const fsImpl = {
    existsSync: () => true,
    readFileSync: () => '{bad',
  };

  const result = shutdownAnyLocalOllamaSync({
    userDataPath: FAKE_USER_DATA_PATH,
    platform: 'win32',
    fsImpl,
    execFileSyncImpl: () => {
      discoveryCalls += 1;
      return JSON.stringify([{ ProcessId: 404, ParentProcessId: 0, Name: 'ollama.exe' }]);
    },
    spawnSyncImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0, stdout: '', stderr: '' };
    },
    isProcessAliveImpl: () => true,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.deepEqual(result, { discoveredPids: [], killedPids: [], skipped: 'malformed_owned_state' });
  assert.equal(discoveryCalls, 0, 'a malformed record must not start process discovery');
  assert.deepEqual(spawnCalls, [], 'a malformed record must not authorize any taskkill');
  assert.ok(logs.some((entry) => entry.level === 'WARN' && entry.event === 'ollama.owned_state_malformed'));
});
