'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  PID_FILENAME,
  buildLaunchArgs,
  buildPidRecordCommand,
  normalizeModelTagForFilename,
  pipeChildLogs,
  probeHealth,
  readPidFile,
  reapStalePidFile,
  resolveGgufPath,
  resolveProjectorPath,
  shutdownLlamaServerSync,
  startLlamaServer,
  stripLatestTag,
  writePidFile,
} = require('../services/llama-server-lifecycle');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');
const {
  FakeChildProcess,
  closeServer,
  createStream,
  getClosedPort,
  listen,
  makeUserDataDir,
  startReadyFakeServer,
  writeIdentityPidFile,
} = require('./helpers/llama-server-lifecycle-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// ---------------------------------------------------------------------------
// F2c / F2d — pid-file identity + ownership retention
// ---------------------------------------------------------------------------

test('writePidFile persists the spawn command line and readPidFile returns the record', () => {
  const dir = makeUserDataDir('jenny-llama-pidrec-');
  const pidPath = path.join(dir, PID_FILENAME);
  const command = buildPidRecordCommand('/opt/llama/llama-server', ['-m', '/models/a.gguf', '--port', '8033']);
  assert.equal(command, '/opt/llama/llama-server -m /models/a.gguf --port 8033');

  writePidFile(pidPath, 4321, { command });

  const record = readPidFile(pidPath);
  assert.equal(record.pid, 4321);
  assert.equal(record.command, command);
  assert.ok(record.startedAt, 'startedAt must be persisted');
});

test('readPidFile yields command:"" for a legacy pid-only file and 0 for a missing one', () => {
  const dir = makeUserDataDir('jenny-llama-legacy-');
  const pidPath = path.join(dir, PID_FILENAME);
  assert.deepEqual(readPidFile(pidPath), { pid: 0, command: '', startedAt: '' });
  fs.writeFileSync(pidPath, JSON.stringify({ pid: 9090, writtenAt: 1 }), 'utf8');
  assert.deepEqual(readPidFile(pidPath), { pid: 9090, command: '', startedAt: '' });
});

test('shutdownLlamaServerSync refuses to kill a pid whose live command line does not match', () => {
  const dir = makeUserDataDir('jenny-llama-reuse-');
  writeIdentityPidFile(dir, {
    pid: 6001,
    command: '/opt/llama/llama-server -m /models/a.gguf',
    startedAt: '2026-01-01T00:00:00.000Z',
  });
  const logs = [];
  const spawnCalls = [];

  const result = shutdownLlamaServerSync({
    userDataPath: dir,
    logger: (level, event, details) => logs.push({ level, event, details }),
    // win32 routes every kill through the injected spawnSyncImpl; the posix
    // branch of forceKillProcessTreeSync would issue a REAL process.kill.
    platform: 'win32',
    spawnSyncImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args: [...args] });
      return { status: 0 };
    },
    isProcessAliveImpl: () => true,
    // The OS recycled pid 6001 onto an unrelated process.
    getProcessCommandLineSyncImpl: () => '/usr/bin/python3 train.py',
  });

  assert.deepEqual(result, {
    hadState: true,
    killed: false,
    pid: 6001,
    skipped: 'identity_unconfirmed',
  });
  assert.deepEqual(spawnCalls, [], 'a recycled pid must NEVER be killed');
  const warn = logs.find((entry) => entry.event === 'llama.server.force_kill_identity_unconfirmed');
  assert.ok(warn, 'expected llama.server.force_kill_identity_unconfirmed');
  assert.equal(warn.level, 'WARN');
  assert.equal(fs.existsSync(path.join(dir, PID_FILENAME)), false, 'the foreign record is dropped');
});

test('shutdownLlamaServerSync retains the pid file when the kill is never confirmed', () => {
  const dir = makeUserDataDir('jenny-llama-retain-');
  const command = '/opt/llama/llama-server -m /models/a.gguf';
  writeIdentityPidFile(dir, { pid: 6002, command, startedAt: '2026-01-01T00:00:00.000Z' });
  const logs = [];

  const result = shutdownLlamaServerSync({
    userDataPath: dir,
    logger: (level, event, details) => logs.push({ level, event, details }),
    platform: 'win32',
    spawnSyncImpl: () => ({ status: 0 }),
    isProcessAliveImpl: () => true,
    getProcessCommandLineSyncImpl: () => `${command} --extra`,
  });

  assert.deepEqual(result, { hadState: true, killed: false, pid: 6002, retained: true });
  assert.equal(
    fs.existsSync(path.join(dir, PID_FILENAME)),
    true,
    'ownership must be RETAINED on an unconfirmed exit so the next launch can retry',
  );
  const warn = logs.find((entry) => entry.event === 'llama.server.force_kill_failed');
  assert.ok(warn && warn.details.retained === true, 'expected a retained force_kill_failed WARN');
});

test('shutdownLlamaServerSync kills and clears when identity matches and the exit is confirmed', () => {
  const dir = makeUserDataDir('jenny-llama-confirmed-');
  const command = '/opt/llama/llama-server -m /models/a.gguf';
  writeIdentityPidFile(dir, { pid: 6003, command, startedAt: '2026-01-01T00:00:00.000Z' });
  let alive = true;
  const spawnCalls = [];

  const result = shutdownLlamaServerSync({
    userDataPath: dir,
    platform: 'win32',
    spawnSyncImpl: (cmd, args) => {
      spawnCalls.push({ cmd, args: [...args] });
      alive = false;
      return { status: 0 };
    },
    isProcessAliveImpl: () => alive,
    getProcessCommandLineSyncImpl: () => `"${command}"`,
  });

  assert.deepEqual(result, { hadState: true, killed: true, pid: 6003 });
  assert.ok(spawnCalls.some((call) => call.cmd === 'taskkill' && call.args.includes('6003')));
  assert.equal(fs.existsSync(path.join(dir, PID_FILENAME)), false);
});

test('reapStalePidFile skips an identity-unconfirmed orphan and retains an unverified kill', () => {
  const skipDir = makeUserDataDir('jenny-llama-reap-skip-');
  writeIdentityPidFile(skipDir, { pid: 7001, command: '/opt/llama/llama-server -m a.gguf' });
  const skipSpawns = [];
  const skipResult = reapStalePidFile({
    userDataPath: skipDir,
    platform: 'win32',
    spawnSyncImpl: (cmd, args) => { skipSpawns.push({ cmd, args: [...args] }); return { status: 0 }; },
    isProcessAliveImpl: () => true,
    getProcessCommandLineSyncImpl: () => '/usr/bin/node server.js',
  });
  assert.equal(skipResult.reaped, false);
  assert.equal(skipResult.skipped, 'identity_unconfirmed');
  assert.deepEqual(skipSpawns, [], 'a recycled pid must NEVER be killed during a reap');

  const retainDir = makeUserDataDir('jenny-llama-reap-retain-');
  const command = '/opt/llama/llama-server -m a.gguf';
  writeIdentityPidFile(retainDir, { pid: 7002, command });
  const retainResult = reapStalePidFile({
    userDataPath: retainDir,
    platform: 'win32',
    spawnSyncImpl: () => ({ status: 0 }),
    isProcessAliveImpl: () => true,
    getProcessCommandLineSyncImpl: () => command,
  });
  assert.equal(retainResult.killed, false);
  assert.equal(retainResult.retained, true);
  assert.equal(
    fs.existsSync(path.join(retainDir, PID_FILENAME)),
    true,
    'an unverified orphan kill must retain the record for the next launch',
  );
});

test('pipeChildLogs preserves stdout and stderr stream identity and severity', () => {
  const stdout = createStream();
  const stderr = createStream();
  const logs = [];

  pipeChildLogs({ stdout, stderr }, {
    prefix: 'llama.test',
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  stdout.emit('data', 'ready\n\n');
  stderr.emit('data', 'warning: gpu fallback\n');

  assert.equal(stdout.encoding, 'utf8');
  assert.equal(stderr.encoding, 'utf8');
  assert.deepEqual(logs, [
    {
      level: 'DEBUG',
      event: 'llama.test.output',
      details: { stream: 'stdout', line: 'ready' },
    },
    {
      level: 'WARN',
      event: 'llama.test.output',
      details: { stream: 'stderr', line: 'warning: gpu fallback' },
    },
  ]);
});

test('probeHealth rejects foreign HTTP services with non-model payloads', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  });
  const baseUrl = await listen(server);
  try {
    assert.equal(await probeHealth(baseUrl), false);
  } finally {
    await closeServer(server);
  }
});

test('probeHealth requires the expected OpenAI-compatible model id when supplied', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'qwen3:0.5b' }],
    }));
  });
  const baseUrl = await listen(server);
  try {
    assert.equal(
      await probeHealth(baseUrl, { expectedModelId: 'qwen3:0.5b' }),
      true
    );
    assert.equal(
      await probeHealth(baseUrl, { expectedModelId: 'gemma:2b' }),
      false
    );
  } finally {
    await closeServer(server);
  }
});

test('model tag normalization separates filesystem-safe names from launch aliases', () => {
  assert.equal(stripLatestTag('gemma:latest'), 'gemma');
  assert.equal(stripLatestTag('qwen3:0.5b'), 'qwen3:0.5b');
  assert.equal(normalizeModelTagForFilename('qwen3:0.5b'), 'qwen3_0.5b');
  assert.equal(
    normalizeModelTagForFilename('llama3.2:3b-instruct-q4_K_M'),
    'llama3.2_3b-instruct-q4_K_M'
  );
  assert.equal(normalizeModelTagForFilename('<>:"/\\|?*'), '');
});

test('resolveGgufPath uses a filesystem-safe model tag directory', () => {
  const userDataPath = path.join('C:', 'Users', 'Jenny');
  const seenDirs = [];
  const fsImpl = {
    readdirSync(dir) {
      seenDirs.push(dir);
      return ['model.gguf'];
    },
  };

  const resolved = resolveGgufPath({
    modelTag: 'qwen3:0.5b',
    userDataPath,
    repoRoot: path.join('C:', 'repo'),
    fsImpl,
  });

  assert.equal(resolved.reason, 'resolved');
  assert.equal(seenDirs[0], path.join(userDataPath, 'models', 'qwen3_0.5b'));
  assert.equal(resolved.path, path.join(seenDirs[0], 'model.gguf'));
  assert.equal(resolved.projectorPath, '');
});

test('resolveGgufPath never serves a co-located drafter or projector as the main model', () => {
  const userDataPath = path.join('C:', 'Users', 'Jenny');
  // 'mtp-' and 'mmproj' sort BEFORE the lowercase main model name — the old
  // first-sorted pick would have served the drafter as the model.
  const fsImpl = {
    readdirSync: () => [
      'mmproj-BF16.gguf',
      'mtp-gemma-4-12B-it-Q8_0.gguf',
      'ornith-1.5-9b-q4_k_m.gguf',
    ],
  };

  const resolved = resolveGgufPath({
    modelTag: 'ornith15:9b',
    userDataPath,
    repoRoot: path.join('C:', 'repo'),
    fsImpl,
  });

  assert.equal(resolved.reason, 'resolved');
  assert.equal(path.basename(resolved.path), 'ornith-1.5-9b-q4_k_m.gguf');
  assert.equal(path.basename(resolved.projectorPath), 'mmproj-BF16.gguf');

  // A directory holding ONLY auxiliary GGUFs (e.g. a partial download) means
  // the main model is absent — report not_found, never launch the drafter.
  const auxOnly = resolveGgufPath({
    modelTag: 'ornith15:9b',
    userDataPath,
    repoRoot: path.join('C:', 'repo'),
    fsImpl: { readdirSync: () => ['mtp-gemma-4-12B-it-Q8_0.gguf'] },
  });
  assert.equal(auxOnly.path, '');
  assert.equal(auxOnly.projectorPath, '');
  assert.equal(auxOnly.reason, 'not_found');
});

test('resolveProjectorPath finds the first sorted projector beside an explicit model path', () => {
  const modelPath = path.join('G:', 'models', 'vision', 'model.gguf');
  const fsImpl = { readdirSync: () => ['mmproj-Z.gguf', 'model.gguf', 'mmproj-A.gguf'] };
  assert.equal(
    resolveProjectorPath({ modelPath, fsImpl }),
    path.join(path.dirname(modelPath), 'mmproj-A.gguf')
  );
  assert.equal(resolveProjectorPath({ modelPath, fsImpl: { readdirSync: () => ['model.gguf'] } }), '');
  assert.equal(resolveProjectorPath({ modelPath, fsImpl: { readdirSync: () => { throw new Error('nope'); } } }), '');
});

test('buildLaunchArgs owns mmproj across acceleration fallback profile args', () => {
  const options = {
    modelPath: 'G:/models/model.gguf',
    host: '127.0.0.1',
    port: 8033,
    contextSize: 32768,
    modelAlias: 'vision-model',
    extraArgs: ['--flash-attn', 'on', '--no-mmproj'],
  };
  assert.equal(buildLaunchArgs(options).includes('--mmproj'), false);
  const projectorPath = 'G:/models/mmproj-F16.gguf';
  const fallbackArgs = buildLaunchArgs({ ...options, projectorPath });
  assert.deepEqual(
    fallbackArgs.slice(fallbackArgs.indexOf('--mmproj'), fallbackArgs.indexOf('--mmproj') + 2),
    ['--mmproj', projectorPath]
  );
  assert.deepEqual(fallbackArgs.slice(-2), ['--mmproj', projectorPath]);
  assert.ok(fallbackArgs.indexOf('--no-mmproj') < fallbackArgs.indexOf('--mmproj'));
});

test('projector-aware reuse requires /props vision truth while text-only reuse stays unchanged', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'vision-model' }] }));
  });
  const baseUrl = await listen(server);
  const port = Number(new URL(baseUrl).port);
  try {
    const cases = [
      { name: 'vision true', response: { ok: true, json: async () => ({ modalities: { vision: true } }) }, reused: true },
      { name: 'vision false', response: { ok: true, json: async () => ({ modalities: { vision: false } }) }, reused: false },
      { name: '404', response: { ok: false, json: async () => ({}) }, reused: false },
      { name: 'timeout', error: Object.assign(new Error('request timed out'), { name: 'AbortError' }), reused: false },
    ];
    for (const entry of cases) {
      const userDataPath = makeUserDataDir(`jenny-llama-props-${entry.name.replace(/\s/g, '-')}-`);
      fs.writeFileSync(path.join(userDataPath, 'model.gguf'), 'model');
      fs.writeFileSync(path.join(userDataPath, 'mmproj-F16.gguf'), 'projector');
      const logs = [];
      const propsCalls = [];
      let spawnCount = 0;
      const start = () => startLlamaServer({
        modelTag: 'vision-model',
        binaryPath: path.join(userDataPath, 'llama-server.exe'),
        modelPath: path.join(userDataPath, 'model.gguf'),
        userDataPath,
        port,
        readinessTimeoutMs: 1000,
        readinessPollIntervalMs: 1,
        spawnImpl: () => { spawnCount += 1; return new FakeChildProcess(43000 + spawnCount); },
        isProcessAliveImpl: () => false,
        fetchImpl: async (url, options) => {
          propsCalls.push({ url, options });
          if (entry.error) throw entry.error;
          return entry.response;
        },
        logger: (level, event, details) => logs.push({ level, event, details }),
      });
      if (entry.reused) {
        const handle = await start();
        assert.equal(handle.reused, true, entry.name);
        assert.equal(handle.mmproj, 'unknown');
      } else {
        await assert.rejects(start(), { message: 'llama_server_port_busy_no_mmproj' });
      }
      assert.equal(spawnCount, 0, entry.name);
      assert.equal(propsCalls.length, 1, entry.name);
      assert.equal(propsCalls[0].url, `http://127.0.0.1:${port}/props`, entry.name);
      assert.equal(logs.some((log) => log.event === 'llama.server.reuse_rejected_no_mmproj'), !entry.reused);
      if (!entry.reused) {
        assert.ok(logs.some((log) => log.event === 'llama.server.port_busy_no_mmproj'));
      }
    }

    const userDataPath = makeUserDataDir('jenny-llama-props-text-');
    fs.writeFileSync(path.join(userDataPath, 'model.gguf'), 'model');
    let propsCalled = false;
    const handle = await startLlamaServer({
      modelTag: 'vision-model',
      modelPath: path.join(userDataPath, 'model.gguf'),
      userDataPath,
      port,
      fetchImpl: async () => { propsCalled = true; throw new Error('must not probe props'); },
    });
    assert.equal(handle.reused, true);
    assert.equal(handle.mmproj, 'unknown');
    assert.equal(propsCalled, false);
  } finally {
    await closeServer(server);
  }
});

test('startLlamaServer aborts before spawn when startup was already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;

  await assert.rejects(
    startLlamaServer({
      abortSignal: controller.signal,
      spawnImpl: () => {
        spawned = true;
        return new FakeChildProcess(41001);
      },
    }),
    /readiness_aborted/
  );

  assert.equal(spawned, false);
});

test('startLlamaServer aborts readiness wait and kills the spawned child', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-abort-'));
  trackDirectory(userDataPath);
  const controller = new AbortController();
  const child = new FakeChildProcess(41002);
  const killCalls = [];
  const port = await getClosedPort();

  setImmediate(() => controller.abort());

  await assert.rejects(
    startLlamaServer({
      modelTag: 'qwen3:0.5b',
      binaryPath: path.join(userDataPath, 'llama-server.exe'),
      modelPath: path.join(userDataPath, 'model.gguf'),
      userDataPath,
      port,
      readinessTimeoutMs: 1000,
      readinessPollIntervalMs: 1,
      abortSignal: controller.signal,
      platform: 'win32',
      spawnImpl: () => child,
      // Without this, production's post-kill liveness check runs
      // process.kill(41002, 0) against the HOST: if that pid exists the exit is
      // unconfirmed, the pid file is retained, and the assertion below fails for
      // a reason that has nothing to do with this test.
      isProcessAliveImpl: () => false,
      spawnSyncImpl: (command, args) => {
        killCalls.push({ command, args });
        return { status: 0 };
      },
    }),
    /readiness_aborted/
  );

  assert.deepEqual(killCalls, [
    { command: 'taskkill', args: ['/PID', '41002', '/T', '/F'] },
  ]);
  assert.equal(
    fs.existsSync(path.join(userDataPath, 'llama-server.pid')),
    false
  );
});

test('readiness failure retains the pid file when forced exit is unconfirmed', async () => {
  const userDataPath = makeUserDataDir('jenny-llama-readiness-failed-retain-');
  const controller = new AbortController();
  const logs = [];
  const port = await getClosedPort();
  setImmediate(() => controller.abort());

  await assert.rejects(
    startLlamaServer({
      modelTag: 'qwen3:0.5b',
      binaryPath: path.join(userDataPath, 'llama-server.exe'),
      modelPath: path.join(userDataPath, 'model.gguf'),
      userDataPath,
      port,
      readinessTimeoutMs: 1000,
      readinessPollIntervalMs: 1,
      abortSignal: controller.signal,
      platform: 'win32',
      spawnImpl: () => new FakeChildProcess(41003),
      spawnSyncImpl: () => ({ status: 0 }),
      isProcessAliveImpl: () => true,
      logger: (level, event, details) => logs.push({ level, event, details }),
    }),
    /readiness_aborted/
  );

  assert.equal(fs.existsSync(path.join(userDataPath, PID_FILENAME)), true);
  assert.ok(logs.some((entry) => (
    entry.level === 'WARN'
    && entry.event === 'llama.server.force_kill_unconfirmed'
    && entry.details.reason === 'readiness_failed'
    && entry.details.retained === true
  )));
});

test('readiness timeout retains the pid file when forced exit is unconfirmed', async () => {
  const userDataPath = makeUserDataDir('jenny-llama-readiness-timeout-retain-');
  const logs = [];
  const port = await getClosedPort();

  await assert.rejects(
    startLlamaServer({
      modelTag: 'qwen3:0.5b',
      binaryPath: path.join(userDataPath, 'llama-server.exe'),
      modelPath: path.join(userDataPath, 'model.gguf'),
      userDataPath,
      port,
      readinessTimeoutMs: 1,
      readinessPollIntervalMs: 1,
      platform: 'win32',
      spawnImpl: () => new FakeChildProcess(41004),
      spawnSyncImpl: () => ({ status: 0 }),
      isProcessAliveImpl: () => true,
      logger: (level, event, details) => logs.push({ level, event, details }),
    }),
    /llama_server_readiness_timeout/
  );

  assert.equal(fs.existsSync(path.join(userDataPath, PID_FILENAME)), true);
  assert.ok(logs.some((entry) => (
    entry.event === 'llama.server.force_kill_unconfirmed'
    && entry.details.reason === 'readiness_timeout'
  )));
});

test('stop retains the pid file when forced exit is unconfirmed', async () => {
  const userDataPath = makeUserDataDir('jenny-llama-stop-retain-');
  const logs = [];
  const child = new FakeChildProcess(41005);
  const { handle, server } = await startReadyFakeServer({ userDataPath, child, logs });
  try {
    await handle.stop({ timeoutMs: 1 });
  } finally {
    await closeServer(server);
  }

  assert.equal(fs.existsSync(path.join(userDataPath, PID_FILENAME)), true);
  assert.ok(logs.some((entry) => (
    entry.event === 'llama.server.force_kill_unconfirmed'
    && entry.details.reason === 'stop_timeout'
  )));
});

test('stopSync retains the pid file when forced exit is unconfirmed', async () => {
  const userDataPath = makeUserDataDir('jenny-llama-stop-sync-retain-');
  const logs = [];
  const child = new FakeChildProcess(41006);
  const { handle, server } = await startReadyFakeServer({ userDataPath, child, logs });
  try {
    handle.stopSync();
  } finally {
    await closeServer(server);
  }

  assert.equal(fs.existsSync(path.join(userDataPath, PID_FILENAME)), true);
  assert.ok(logs.some((entry) => (
    entry.event === 'llama.server.force_kill_unconfirmed'
    && entry.details.reason === 'stop_sync'
  )));
});

test('splitGgufFiles classifies main, drafter, and projector files identically for every consumer', () => {
  const { splitGgufFiles } = require('../services/llama-server-lifecycle');
  assert.deepEqual(
    splitGgufFiles(['mtp-x.gguf', 'notes.txt', 'Z-main.gguf', 'mmproj-F16.gguf', 'a-main.GGUF', 'MTP-y.gguf']),
    { main: ['Z-main.gguf', 'a-main.GGUF'], drafters: ['MTP-y.gguf', 'mtp-x.gguf'], projectors: ['mmproj-F16.gguf'] }
  );
  assert.deepEqual(splitGgufFiles(null), { main: [], drafters: [], projectors: [] });
});
