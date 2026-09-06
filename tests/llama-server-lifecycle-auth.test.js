'use strict';

// llama-server launch hardening: Jenny-owned per-launch api key delivered via
// --api-key-file, --no-slots, authenticated readiness, reused-server and
// keyed-orphan behavior, fail-closed without userData.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PID_FILENAME,
  buildLaunchArgs,
  readPidFile,
  resolveProjectorPath,
  startLlamaServer,
} = require('../services/llama-server-lifecycle');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const {
  FakeChildProcess,
  closeServer,
  getClosedPort,
  listen,
  makeUserDataDir,
} = require('./helpers/llama-server-lifecycle-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('buildLaunchArgs preserves legacy argv and inserts managed auth flags before profile args', () => {
  const options = {
    modelPath: 'C:/models/model.gguf',
    host: '127.0.0.1',
    port: 8033,
    contextSize: 32768,
    modelAlias: 'qwen3:0.5b',
    extraArgs: ['--parallel', '1'],
  };
  const legacyArgs = [
    '-m', 'C:/models/model.gguf',
    '--host', '127.0.0.1',
    '--port', '8033',
    '-c', '32768',
    '-a', 'qwen3:0.5b',
    '--parallel', '1',
  ];

  assert.deepEqual(buildLaunchArgs(options), legacyArgs);
  assert.deepEqual(buildLaunchArgs({ ...options, apiKeyPath: 'C:/data/llama-server.key' }), [
    ...legacyArgs.slice(0, -2),
    '--api-key-file', 'C:/data/llama-server.key', '--no-slots',
    '--parallel', '1',
  ]);
});

test('managed spawn writes a per-launch key, authenticates readiness, and removes it once ready', async () => {
  const userDataPath = makeUserDataDir('jenny-llama-keyed-');
  const child = new FakeChildProcess(42001);
  const spawnCalls = [];
  const requestAuthorization = [];
  const exits = [];
  let keyFileAtSpawn = '';
  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    requestAuthorization.push(request.headers.authorization);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(
      requestCount === 1
        ? { ok: true }
        : { object: 'list', data: [{ id: 'qwen3:0.5b' }] }
    ));
  });
  const baseUrl = await listen(server);

  try {
    const handle = await startLlamaServer({
      modelTag: 'qwen3:0.5b',
      binaryPath: path.join(userDataPath, 'llama-server.exe'),
      modelPath: path.join(userDataPath, 'model.gguf'),
      userDataPath,
      port: Number(new URL(baseUrl).port),
      readinessTimeoutMs: 1000,
      readinessPollIntervalMs: 1,
      platform: 'win32',
      onExit: (info) => exits.push(info),
      spawnImpl: (command, args) => {
        spawnCalls.push({ command, args: [...args] });
        keyFileAtSpawn = fs.readFileSync(args[args.indexOf('--api-key-file') + 1], 'utf8');
        return child;
      },
      spawnSyncImpl: () => ({ status: 0 }),
      isProcessAliveImpl: () => false,
    });

    assert.match(handle.apiKey, /^[0-9a-f]{32}$/);
    assert.equal(spawnCalls.length, 1);
    const launchArgs = spawnCalls[0].args;
    assert.equal(launchArgs.includes('--api-key'), false);
    const keyPath = launchArgs[launchArgs.indexOf('--api-key-file') + 1];
    assert.equal(path.dirname(keyPath), userDataPath);
    assert.match(path.basename(keyPath), /^llama-server-[0-9a-f]{8}\.key$/, 'key file name is per-launch');
    assert.deepEqual(launchArgs.slice(launchArgs.indexOf('-a') + 2), ['--api-key-file', keyPath, '--no-slots']);
    assert.equal(keyFileAtSpawn, `${handle.apiKey}\n`, 'the key is on disk when the child starts');
    // llama-server reads the file while parsing args, so once readiness is
    // confirmed the key must no longer sit on disk for the server's lifetime.
    assert.equal(fs.existsSync(keyPath), false, 'key file is removed as soon as the server is ready');
    assert.deepEqual(requestAuthorization, [undefined, `Bearer ${handle.apiKey}`]);
    assert.equal(readPidFile(path.join(userDataPath, PID_FILENAME)).command.includes(handle.apiKey), false);

    // Crash surface: the exit hook fires once with the child's exit info.
    child.emit('exit', 137, null);
    assert.deepEqual(exits, [{ pid: 42001, code: 137, signal: '' }]);

    assert.deepEqual(await handle.stop(), { confirmed: true });
    assert.equal(fs.existsSync(keyPath), false);
  } finally {
    await closeServer(server);
  }
});

test('reused openai-compatible server remains unkeyed and receives no authorization header', async () => {
  const userDataPath = makeUserDataDir('jenny-llama-reused-unkeyed-');
  const authorization = [];
  const server = http.createServer((request, response) => {
    authorization.push(request.headers.authorization);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3:0.5b' }] }));
  });
  const baseUrl = await listen(server);

  try {
    const handle = await startLlamaServer({
      modelTag: 'qwen3:0.5b',
      userDataPath,
      port: Number(new URL(baseUrl).port),
      spawnImpl: () => {
        throw new Error('reused server must not spawn');
      },
    });

    assert.equal(handle.reused, true);
    assert.equal(handle.apiKey, '');
    assert.deepEqual(authorization, [undefined]);
    assert.equal(fs.existsSync(path.join(userDataPath, 'llama-server.key')), false);
  } finally {
    await closeServer(server);
  }
});

test('resolveProjectorPath only pairs an unambiguous or stem-matched explicit model', () => {
  const dir = path.join('G:', 'models', 'vision');
  const files = ['qwen-vl.gguf', 'mmproj-qwen-vl.gguf', 'gemma.gguf'];
  const resolve = (name, names = files) => resolveProjectorPath({
    modelPath: path.join(dir, name),
    fsImpl: { readdirSync: () => names },
  });

  assert.equal(resolve('gemma.gguf'), '');
  assert.equal(resolve('qwen-vl.gguf'), path.join(dir, 'mmproj-qwen-vl.gguf'));
  assert.equal(resolve('model.gguf', ['other.gguf', 'model.gguf', 'mmproj-F16.gguf']), '');
  assert.equal(
    resolve('model.gguf', ['model.gguf', 'mmproj-A.gguf']),
    path.join(dir, 'mmproj-A.gguf')
  );
});

test('startLlamaServer still reports a missing model when no server can be reused', async () => {
  const userDataPath = makeUserDataDir('jenny-llama-no-model-');
  const port = await getClosedPort();
  await assert.rejects(
    startLlamaServer({ modelTag: 'missing-model', userDataPath, port }),
    { message: 'llama_server_model_not_found:not_found' }
  );
});

test('readiness timeout removes the key file created immediately before spawn', async () => {
  const userDataPath = makeUserDataDir('jenny-llama-key-timeout-');
  const port = await getClosedPort();
  let keyFileAtSpawn = '';

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
      spawnImpl: (_command, args) => {
        keyFileAtSpawn = fs.readFileSync(args[args.indexOf('--api-key-file') + 1], 'utf8');
        return new FakeChildProcess(42002);
      },
      spawnSyncImpl: () => ({ status: 0 }),
      isProcessAliveImpl: () => false,
    }),
    /llama_server_readiness_timeout/
  );

  assert.match(keyFileAtSpawn, /^[0-9a-f]{32}\n$/);
  assert.deepEqual(fs.readdirSync(userDataPath).filter((name) => name.endsWith('.key')), []);
});

test('startLlamaServer fails closed instead of launching unauthenticated without userDataPath', async () => {
  const port = await getClosedPort();
  let spawned = false;
  await assert.rejects(
    startLlamaServer({
      modelTag: 'qwen3:0.5b',
      binaryPath: path.join(os.tmpdir(), 'llama-server.exe'),
      modelPath: path.join(os.tmpdir(), 'model.gguf'),
      port,
      platform: 'win32',
      spawnImpl: () => {
        spawned = true;
        return new FakeChildProcess(42003);
      },
    }),
    /llama_server_user_data_path_required/
  );
  assert.equal(spawned, false);
});

test('a keyed server already on the port is not reused and is called out in the log', async () => {
  const userDataPath = makeUserDataDir('jenny-llama-keyed-orphan-');
  const logs = [];
  const server = http.createServer((_request, response) => {
    response.statusCode = 401;
    response.end('{"error":"unauthorized"}');
  });
  const baseUrl = await listen(server);
  try {
    await assert.rejects(
      startLlamaServer({
        modelTag: 'qwen3:0.5b',
        binaryPath: path.join(userDataPath, 'llama-server.exe'),
        modelPath: path.join(userDataPath, 'model.gguf'),
        userDataPath,
        port: Number(new URL(baseUrl).port),
        readinessTimeoutMs: 5,
        readinessPollIntervalMs: 1,
        platform: 'win32',
        logger: (level, event, payload) => logs.push({ level, event, payload }),
        spawnImpl: () => new FakeChildProcess(42004),
        spawnSyncImpl: () => ({ status: 0 }),
        isProcessAliveImpl: () => false,
      }),
      /llama_server_readiness_timeout/
    );
    const warn = logs.find((entry) => entry.event === 'llama.server.existing_server_requires_auth');
    assert.ok(warn, 'unauthorized existing server is logged');
    assert.equal(warn.level, 'WARN');
    assert.equal(warn.payload.statusCode, 401);
    assert.equal(logs.some((entry) => entry.event === 'llama.server.reuse_existing'), false);
  } finally {
    await closeServer(server);
  }
});

test('a launch sweeps key files a dead main process left behind', async () => {
  const userDataPath = makeUserDataDir('jenny-llama-key-sweep-');
  const stale = path.join(userDataPath, 'llama-server-deadbeef.key');
  fs.writeFileSync(stale, 'stale-secret\n');
  fs.writeFileSync(path.join(userDataPath, 'unrelated.key'), 'keep\n');
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
      spawnImpl: () => new FakeChildProcess(42005),
      spawnSyncImpl: () => ({ status: 0 }),
      isProcessAliveImpl: () => false,
    }),
    /llama_server_readiness_timeout/
  );
  assert.equal(fs.existsSync(stale), false, 'stale per-launch key is swept');
  assert.equal(fs.existsSync(path.join(userDataPath, 'unrelated.key')), true, 'only llama-server-*.key files are touched');
  assert.deepEqual(fs.readdirSync(userDataPath).filter((name) => /^llama-server-.*\.key$/.test(name)), []);
});
