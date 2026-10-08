'use strict';

// The semantic catalog's embedding server: its own small managed llama-server
// beside the chat model's, driven through injected fakes (no process, no
// network). One serialized chain, reuse per spec, crash backoff, no respawn.

const crypto = require('node:crypto');
const net = require('node:net');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  allocateLoopbackPort,
  createEmbeddingServerManager,
} = require('../services/main/embedding-server-manager');

const MODEL = 'C:\\Models\\Embed\\EmbeddingGemma-300M.Q8_0.gguf';
const OTHER_MODEL = 'C:\\Models\\Embed\\nomic-embed-text-v1.5.gguf';
const STAT = Object.freeze({ size: 328_000_000, mtimeMs: 1_790_000_000_000 });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  const launches = [];
  const logs = [];
  const states = [];
  let clock = 1_000_000;
  let nextPort = 41000;
  const script = { fail: null, hold: null, stopResult: null, stopHold: null };
  const startServer = async (options) => {
    const launch = {
      options,
      stops: 0,
      stopSyncs: 0,
      exit: (info = { pid: 7, code: 1, signal: '' }) => options.onExit(info),
    };
    launches.push(launch);
    if (script.hold) await script.hold.promise;
    if (script.fail) throw script.fail;
    return {
      pid: 7000 + launches.length,
      baseUrl: `http://127.0.0.1:${options.port}/v1`,
      reused: false,
      // The real lifecycle returns no key for an unauthenticated launch.
      apiKey: options.authenticate === false ? '' : 'ab'.repeat(16),
      stop: async () => {
        launch.stops += 1;
        if (script.stopHold) await script.stopHold.promise;
        return script.stopResult || { confirmed: true };
      },
      stopSync: () => {
        launch.stopSyncs += 1;
      },
    };
  };
  const validations = [];
  const manager = createEmbeddingServerManager({
    userDataPath: 'C:\\Users\\me\\AppData\\Roaming\\jenny',
    resourcesPath: 'C:\\Program Files\\Jenny\\resources',
    repoRoot: 'C:\\repo',
    logger: (level, event, details) => logs.push({ level, event, details }),
    startServer,
    allocatePort: async () => {
      nextPort += 1;
      return nextPort;
    },
    now: () => clock,
    validateModel: (modelPath) => {
      validations.push(modelPath);
      return { ok: true, architecture: 'gemma-embedding', profileId: 'embeddinggemma' };
    },
    onStateChange: (state) => states.push(state),
    fsImpl: { statSync: () => STAT },
    platform: 'win32',
    ...overrides,
  });
  return {
    manager,
    launches,
    logs,
    states,
    script,
    validations,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('ensureRunning launches one unkeyed loopback embedding server with its own pid file', async () => {
  const { manager, launches, states } = createHarness();
  const result = await manager.ensureRunning({ modelPath: MODEL });

  assert.equal(launches.length, 1);
  const options = launches[0].options;
  assert.equal(options.modelTag, 'jenny-embedding');
  assert.equal(options.modelPath, MODEL);
  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, 41001);
  assert.equal(options.contextSize, 2048);
  assert.equal(options.adopt, false);
  assert.equal(options.pidFileName, 'embedding-server.pid');
  assert.equal(options.authenticate, false, 'the embedding server runs unkeyed');
  assert.equal(options.apiKeyFilePrefix, undefined);
  assert.equal(options.userDataPath, 'C:\\Users\\me\\AppData\\Roaming\\jenny');
  assert.equal(options.resourcesPath, 'C:\\Program Files\\Jenny\\resources');
  assert.equal(options.repoRoot, 'C:\\repo');
  assert.deepEqual(options.extraArgs, ['--embedding', '-b', '2048', '-ub', '2048', '-ngl', '0']);
  assert.equal(typeof options.onExit, 'function');
  assert.equal(typeof options.logger, 'function');

  assert.equal(result.baseUrl, 'http://127.0.0.1:41001/v1');
  assert.equal(result.apiKey, '');
  assert.equal(manager.getApiKey(), '');
  assert.equal(manager.getBaseUrl(), result.baseUrl);
  assert.deepEqual(manager.getState(), {
    status: 'ready',
    baseUrl: result.baseUrl,
    device: 'cpu',
    modelKey: result.modelKey,
    lastError: '',
  });
  assert.deepEqual(states.map((state) => state.status), ['starting', 'ready']);
});

test('modelKey is the first 16 hex of sha256 over the lowercased win32 path, size and mtime', async () => {
  const { manager } = createHarness();
  const { modelKey } = await manager.ensureRunning({ modelPath: MODEL });
  const expected = crypto.createHash('sha256')
    .update(`${MODEL.toLowerCase()}|${STAT.size}|${STAT.mtimeMs}`)
    .digest('hex')
    .slice(0, 16);
  assert.equal(modelKey, expected);
  assert.match(modelKey, /^[0-9a-f]{16}$/);
});

test('gpu device and clamped context size reach the launch args; unknown devices run on cpu', async () => {
  const gpu = createHarness();
  await gpu.manager.ensureRunning({ modelPath: MODEL, device: 'gpu', contextSize: 100_000 });
  assert.equal(gpu.launches[0].options.contextSize, 8192);
  assert.deepEqual(gpu.launches[0].options.extraArgs, ['--embedding', '-b', '8192', '-ub', '8192', '-ngl', '99']);
  assert.equal(gpu.manager.getState().device, 'gpu');

  const odd = createHarness();
  await odd.manager.ensureRunning({ modelPath: MODEL, device: 'npu', contextSize: 16 });
  assert.equal(odd.launches[0].options.contextSize, 512);
  assert.deepEqual(odd.launches[0].options.extraArgs, ['--embedding', '-b', '512', '-ub', '512', '-ngl', '0']);
  assert.equal(odd.manager.getState().device, 'cpu');
});

test('the same spec reuses the ready server; a different spec stops the old one first', async () => {
  const { manager, launches, validations } = createHarness();
  const first = await manager.ensureRunning({ modelPath: MODEL });
  const again = await manager.ensureRunning({ modelPath: MODEL, device: 'cpu', contextSize: 2048 });
  assert.deepEqual(again, first);
  assert.equal(launches.length, 1);
  assert.equal(validations.length, 1);

  const second = await manager.ensureRunning({ modelPath: OTHER_MODEL });
  assert.equal(launches.length, 2);
  assert.equal(launches[0].stops, 1, 'the old server stopped before the new launch');
  assert.notEqual(second.baseUrl, first.baseUrl);

  await manager.ensureRunning({ modelPath: OTHER_MODEL, device: 'gpu' });
  assert.equal(launches.length, 3);
  assert.equal(launches[1].stops, 1, 'a device change is a different spec');
});

test('concurrent calls run on one serialized chain: no overlapping starts', async () => {
  const harness = createHarness();
  harness.script.hold = deferred();
  const a = harness.manager.ensureRunning({ modelPath: MODEL });
  const b = harness.manager.ensureRunning({ modelPath: MODEL });
  const stopped = harness.manager.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.launches.length, 1, 'the second call waits for the first');
  assert.equal(harness.manager.getState().status, 'starting');
  harness.script.hold.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(rb, ra);
  assert.equal(harness.launches.length, 1);
  assert.deepEqual(await stopped, { confirmed: true });
  assert.equal(harness.launches[0].stops, 1);
  assert.equal(harness.manager.getState().status, 'stopped');
});

test('a refused model rejects with its reason and never launches', async () => {
  const { manager, launches } = createHarness({
    validateModel: () => ({ ok: false, reason: 'not_embedding_model' }),
  });
  await assert.rejects(manager.ensureRunning({ modelPath: MODEL }), {
    message: 'embedding_model_refused:not_embedding_model',
  });
  assert.equal(launches.length, 0);
});

test('a crash marks the server failed with no respawn, then backs off for 30 s', async () => {
  const harness = createHarness();
  const { manager, launches, states, logs } = harness;
  await manager.ensureRunning({ modelPath: MODEL });
  launches[0].exit({ pid: 7001, code: 3221225477, signal: '' });

  assert.deepEqual(manager.getState(), {
    status: 'failed',
    baseUrl: '',
    device: 'cpu',
    modelKey: manager.getState().modelKey,
    lastError: 'embedder_exited',
  });
  assert.equal(states.at(-1).status, 'failed');
  assert.equal(states.at(-1).lastError, 'embedder_exited');
  assert.equal(manager.getApiKey(), '');
  assert.ok(logs.some((entry) => entry.event === 'embedding.server.exited'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches.length, 1, 'no automatic respawn');

  harness.advance(29_999);
  await assert.rejects(manager.ensureRunning({ modelPath: MODEL }), { message: 'embedder_backoff' });
  assert.equal(launches.length, 1);
  harness.advance(2);
  await manager.ensureRunning({ modelPath: MODEL });
  assert.equal(launches.length, 2, 'a later call may relaunch');
  assert.equal(manager.getState().status, 'ready');
});

test('three consecutive launch failures for one spec refuse until reset or a new spec', async () => {
  const harness = createHarness();
  const { manager, launches, script } = harness;
  script.fail = new Error('llama_server_readiness_timeout');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(manager.ensureRunning({ modelPath: MODEL }), { message: 'llama_server_readiness_timeout' });
    assert.equal(manager.getState().status, 'failed');
    harness.advance(31_000);
  }
  assert.equal(launches.length, 3);
  await assert.rejects(manager.ensureRunning({ modelPath: MODEL }), { message: 'embedder_failed' });
  assert.equal(launches.length, 3);

  script.fail = null;
  await manager.ensureRunning({ modelPath: OTHER_MODEL });
  assert.equal(launches.length, 4, 'a different spec starts fresh');

  script.fail = new Error('llama_server_readiness_timeout');
  await manager.stop();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(manager.ensureRunning({ modelPath: MODEL }));
    harness.advance(31_000);
  }
  await assert.rejects(manager.ensureRunning({ modelPath: MODEL }), { message: 'embedder_failed' });
  manager.reset();
  script.fail = null;
  await manager.ensureRunning({ modelPath: MODEL });
  assert.equal(manager.getState().status, 'ready');
});

test('a successful readiness resets the failure count', async () => {
  const harness = createHarness();
  const { manager, launches, script } = harness;
  script.fail = new Error('llama_server_readiness_timeout');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(manager.ensureRunning({ modelPath: MODEL }));
    harness.advance(31_000);
  }
  script.fail = null;
  await manager.ensureRunning({ modelPath: MODEL });
  await manager.stop();
  script.fail = new Error('llama_server_readiness_timeout');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(manager.ensureRunning({ modelPath: MODEL }), { message: 'llama_server_readiness_timeout' });
    harness.advance(31_000);
  }
  assert.equal(launches.length, 5);
});

test('a start error that names a path is reported as a bounded code', async () => {
  const harness = createHarness();
  harness.script.fail = new Error('spawn C:\\Program Files\\Jenny\\llama-server.exe ENOENT');
  await assert.rejects(harness.manager.ensureRunning({ modelPath: MODEL }), { message: 'embedder_start_failed' });
  assert.equal(harness.manager.getState().lastError, 'embedder_start_failed');
});

test('stop is serialized and confirmed; an exit we asked for is not a crash', async () => {
  const { manager, launches, states } = createHarness();
  await manager.ensureRunning({ modelPath: MODEL });
  assert.deepEqual(await manager.stop(), { confirmed: true });
  launches[0].exit({ pid: 7001, code: 0, signal: '' });
  assert.equal(manager.getState().status, 'stopped');
  assert.equal(manager.getState().lastError, '');
  assert.equal(states.at(-1).status, 'stopped');
  assert.deepEqual(await manager.stop(), { confirmed: true }, 'stopping nothing is confirmed');
});

test('stopSync uses the handle\'s synchronous stop on the quit path', async () => {
  const { manager, launches } = createHarness();
  await manager.ensureRunning({ modelPath: MODEL });
  manager.stopSync();
  assert.equal(launches[0].stopSyncs, 1);
  assert.equal(manager.getState().status, 'stopped');
  assert.equal(manager.getBaseUrl(), '');
  manager.stopSync();
  assert.equal(launches[0].stopSyncs, 1);
});

test('logs and state never carry the full model path', async () => {
  const { manager, launches, logs, states } = createHarness();
  await manager.ensureRunning({ modelPath: MODEL });
  launches[0].exit();
  const text = JSON.stringify({ logs, states, state: manager.getState() });
  assert.equal(text.includes('C:\\\\Models'), false);
  const start = logs.find((entry) => entry.event === 'embedding.server.start');
  assert.equal(start.details.model, 'EmbeddingGemma-300M.Q8_0.gguf');
  assert.ok(logs.some((entry) => entry.event === 'embedding.server.ready'));
});

test('allocateLoopbackPort returns a free loopback port', async () => {
  const port = await allocateLoopbackPort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
});

test('ready-then-crash loops still give up after three tries; a stable run starts over', async () => {
  const harness = createHarness();
  const { manager, launches } = harness;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await manager.ensureRunning({ modelPath: MODEL });
    launches.at(-1).exit({ pid: 7000 + launches.length, code: 1, signal: '' });
    harness.advance(31_000);
  }
  await assert.rejects(manager.ensureRunning({ modelPath: MODEL }), { message: 'embedder_failed' });
  assert.equal(launches.length, 3);

  manager.reset();
  await manager.ensureRunning({ modelPath: MODEL });
  harness.advance(5 * 60_000);
  launches.at(-1).exit({ pid: 7004, code: 1, signal: '' });
  harness.advance(31_000);
  await manager.ensureRunning({ modelPath: MODEL });
  assert.equal(manager.getState().status, 'ready', 'a crash after a long healthy run counts as the first');
});

test('an unconfirmed stop keeps the handle and blocks a replacement launch', async () => {
  const harness = createHarness();
  const { manager, launches, script } = harness;
  await manager.ensureRunning({ modelPath: MODEL });
  script.stopResult = { confirmed: false };
  assert.deepEqual(await manager.stop(), { confirmed: false });
  assert.equal(manager.getState().status, 'failed');
  assert.equal(manager.getState().lastError, 'embedder_stop_unconfirmed');
  assert.equal(manager.getBaseUrl(), '', 'it no longer serves');

  await assert.rejects(manager.ensureRunning({ modelPath: OTHER_MODEL }), { message: 'embedder_stop_unconfirmed' });
  assert.equal(launches.length, 1, 'no second server beside an unconfirmed one');
  manager.stopSync();
  assert.equal(launches[0].stopSyncs, 1, 'the quit path still reaches the old process');
  script.stopResult = null;
  await assert.rejects(manager.ensureRunning({ modelPath: OTHER_MODEL }), { message: 'embedder_stopped' });
  assert.equal(launches.length, 1, 'nothing launches after the quit path');
});

test('a quit while a relaunch awaits the previous stop never leaves a server behind', async () => {
  const harness = createHarness();
  const { manager, launches, script } = harness;
  await manager.ensureRunning({ modelPath: MODEL });
  script.stopHold = deferred();
  const relaunch = manager.ensureRunning({ modelPath: OTHER_MODEL });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches[0].stops, 1, 'the relaunch is waiting on the old stop');

  manager.stopSync();
  script.stopHold.resolve();

  await assert.rejects(relaunch, { message: 'embedder_stopped' });
  assert.equal(launches.length, 1, 'no server started after the quit');
  assert.equal(manager.getState().status, 'stopped');
});

test('the launch runs the resolved runtime, and a missing saved runtime is a classified failure (the resolver is async)', async () => {
  let runtime = { binaryPath: 'D:\\llama\\llama-server.exe', source: 'saved', error: '' };
  const harness = createHarness({ resolveRuntime: async () => runtime });
  const { manager, launches } = harness;
  await manager.ensureRunning({ modelPath: MODEL });
  assert.equal(launches[0].options.binaryPath, 'D:\\llama\\llama-server.exe');
  assert.equal(launches[0].options.runtimeSource, 'saved');
  await manager.stop();

  runtime = { binaryPath: '', source: 'saved', error: 'llama_server_runtime_missing:llama' };
  await assert.rejects(manager.ensureRunning({ modelPath: MODEL }), { message: 'llama_server_runtime_missing:llama' });
  assert.equal(launches.length, 1, 'nothing spawned without a runtime');
  assert.equal(manager.getState().lastError, 'llama_server_runtime_missing:llama');
});
