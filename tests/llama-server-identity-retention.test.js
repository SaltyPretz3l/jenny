'use strict';

// Identity retention for the chat GPU handoff: stop({ retainIdentity }) parks
// the api key and launch plan of a confirmed stop, ensureRunning(null,
// { reuseIdentity: true }) relaunches exactly that (same key, same port, no
// adoption), and the launch gates refuse everything else meanwhile.

const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createLlamaServerManager } = require('../services/main/llama-server-manager');
const { startLlamaServer } = require('../services/llama-server-lifecycle');
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

const PROFILE = Object.freeze({
  id: 'gemma4-12b', modelTag: 'gemma4:12b', contextSize: 32768, extraArgs: [], acceleration: null,
});
const SETTINGS = Object.freeze({
  autostart: true, binaryOverride: '', host: '127.0.0.1', port: 8033, profileId: 'gemma4-12b',
  profile: PROFILE, profileError: '', modelPathOverride: '', modelTagOverride: '', readinessTimeoutMs: 1000,
});

function makeHarness({ launchGate, chatModelGate } = {}) {
  const launches = [];
  const logs = [];
  const transitions = [];
  let nextPid = 100;
  const lifecycle = {
    reuseNext: false,
    stopUnconfirmed: false,
    async startLlamaServer(options) {
      launches.push(options);
      const pid = nextPid++;
      const reused = lifecycle.reuseNext;
      lifecycle.reuseNext = false;
      return {
        pid: reused ? 0 : pid,
        baseUrl: `http://127.0.0.1:${options.port}/v1`,
        reused,
        mmproj: '',
        // A real launch honors the retained key; a fresh one mints its own.
        apiKey: reused ? '' : (options.retainedApiKey || `key-${pid}`),
        async stop() {
          if (lifecycle.stopUnconfirmed) {
            lifecycle.stopUnconfirmed = false;
            return { confirmed: false };
          }
          return { confirmed: true };
        },
        stopSync() {},
      };
    },
    resolveGgufPath: () => ({ path: 'G:/models/model.gguf', projectorPath: '' }),
    resolveProjectorPath: () => '',
    sweepStaleApiKeyFiles() {},
  };
  const manager = createLlamaServerManager({
    onStateChange: (status) => { transitions.push(status); },
    processRef: { env: {}, resourcesPath: '' },
    rootDir: 'G:/repo',
    userDataPath: 'G:/userData',
    getShellConfigService: () => ({
      getLocalEngines: () => ({ openaiCompatible: { port: 8033, apiUrl: '', acceleration: null, managed: null } }),
      getState: () => ({ featureOverrides: {} }),
    }),
    log: (level, event, payload) => logs.push({ level, event, payload }),
    lifecycle,
    ...(launchGate ? { launchGate } : {}),
    ...(chatModelGate ? { chatModelGate } : {}),
    resolveLaunchAccelerationImpl: () => ({ mode: 'off', reason: 'flag_off', extraArgs: [], drafter: '', vramHeadroomMb: 0 }),
    resolveSettingsImpl: () => SETTINGS,
    buildFeatureFlagsImpl: () => ({ llama_server_acceleration: false }),
  });
  return { manager, launches, lifecycle, logs, transitions };
}

test('a retained stop parks the key and an identity relaunch reuses it without adoption', async () => {
  const h = makeHarness();
  await h.manager.start({ modelTag: 'gemma4:12b', contextSize: 16384 });
  const key = h.manager.getApiKey();
  assert.match(key, /^key-\d+$/);
  assert.equal(h.manager.getStatus().identityRetained, false);

  const stopped = await h.manager.stop({ retainIdentity: true });
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.identityRetained, true);
  assert.equal(h.manager.getApiKey(), '', 'no server, no key');

  const restored = await h.manager.ensureRunning(null, { reuseIdentity: true });
  assert.equal(restored.state, 'ready');
  assert.equal(restored.identityReused, true);
  assert.equal(restored.identityRetained, false);
  assert.equal(h.manager.getApiKey(), key, 'the parked chat turn keeps sending this key');
  assert.equal(h.launches.length, 2);
  const relaunch = h.launches[1];
  assert.equal(relaunch.retainedApiKey, key);
  assert.equal(relaunch.adopt, false);
  assert.equal(relaunch.port, h.launches[0].port);
  assert.equal(relaunch.contextSize, 16384, 'the captured plan, not re-read settings');
  assert.equal(h.launches[0].retainedApiKey, undefined, 'a normal launch never carries a key');
  // The identity is consumed: a second reuse does nothing.
  assert.equal((await h.manager.ensureRunning(null, { reuseIdentity: true })).state, 'ready');
  assert.equal(h.launches.length, 2);
});

test('a reused (adopted) server or an unconfirmed stop retains nothing', async () => {
  const adopted = makeHarness();
  adopted.lifecycle.reuseNext = true;
  await adopted.manager.start();
  assert.equal((await adopted.manager.stop({ retainIdentity: true })).identityRetained, false);
  const skipped = await adopted.manager.ensureRunning(null, { reuseIdentity: true });
  assert.equal(skipped.state, 'stopped');
  assert.equal(skipped.identityReused, false);
  assert.equal(skipped.lastError, 'llama_server_identity_missing');
  assert.equal(adopted.launches.length, 1, 'nothing is relaunched without an identity');

  const unconfirmed = makeHarness();
  await unconfirmed.manager.start();
  unconfirmed.lifecycle.stopUnconfirmed = true;
  const stopped = await unconfirmed.manager.stop({ retainIdentity: true });
  assert.equal(stopped.lastError, 'stop_unconfirmed');
  assert.equal(stopped.identityRetained, false);
});

test('a fresh launch abandons a parked identity and a plain stop never retains one', async () => {
  const h = makeHarness();
  await h.manager.start();
  await h.manager.stop({ retainIdentity: true });
  await h.manager.start();
  assert.equal(h.manager.getStatus().identityReused, false);
  assert.equal(h.launches[1].retainedApiKey, undefined);
  await h.manager.stop();
  assert.equal(h.manager.getStatus().identityRetained, false);
  assert.equal((await h.manager.ensureRunning(null, { reuseIdentity: true })).lastError, 'llama_server_identity_missing');
});

test('the launch gate refuses every launch except the identity restore', async () => {
  let refusal = '';
  const h = makeHarness({ launchGate: () => refusal });
  await h.manager.start();
  await h.manager.stop({ retainIdentity: true });
  refusal = 'gpu_lease_held';
  assert.equal((await h.manager.start()).lastError, 'gpu_lease_held');
  assert.equal((await h.manager.restart()).lastError, 'gpu_lease_held');
  assert.equal((await h.manager.startFromSettings()).lastError, 'gpu_lease_held');
  assert.equal(h.launches.length, 1, 'no launch ran while the lease is held');
  assert.equal(h.logs.filter((entry) => entry.event === 'llama.server.launch_refused').length, 3);
  assert.equal(h.manager.getStatus().identityRetained, true, 'the refusals did not consume the identity');

  const restored = await h.manager.ensureRunning(null, { reuseIdentity: true });
  assert.equal(restored.state, 'ready');
  assert.equal(restored.identityReused, true);
  assert.equal(h.launches.length, 2);
  // A ready server is left alone by a refused launch: no stop, no error.
  assert.equal((await h.manager.restart()).state, 'ready');
  assert.equal(h.manager.getStatus().lastError, '');
});

test('a restart refused by the gate does not abort the identity restore in flight', async () => {
  let refusal = '';
  const h = makeHarness({ launchGate: () => refusal });
  await h.manager.start();
  await h.manager.stop({ retainIdentity: true });
  refusal = 'gpu_lease_held';
  const restoring = h.manager.ensureRunning(null, { reuseIdentity: true });
  const refused = await h.manager.restart(null);
  assert.equal(refused.lastError, 'gpu_lease_held');
  const restored = await restoring;
  assert.equal(restored.state, 'ready', 'the parked turn gets its endpoint back');
  assert.equal(restored.identityReused, true);
  assert.equal(h.launches.length, 2);
});

test('the chat-model gate refuses a plan for a file that is not a chat model', async () => {
  const h = makeHarness({
    chatModelGate: ({ modelPath }) => (modelPath.endsWith('image.gguf') ? 'gguf_not_a_chat_model' : ''),
  });
  const refused = await h.manager.start({ modelTag: 'qwen-image:latest', modelPath: 'G:/models/image.gguf' });
  assert.equal(refused.state, 'stopped');
  assert.equal(refused.lastError, 'gguf_not_a_chat_model');
  assert.equal(refused.alias, 'qwen-image');
  assert.equal(h.launches.length, 0);
  assert.ok(h.logs.some((entry) => entry.event === 'llama.server.model_refused'));
  assert.equal((await h.manager.start({ modelTag: 'gemma4:12b', modelPath: 'G:/models/chat.gguf' })).state, 'ready');
});

test('lifecycle: an identity restore refuses a port that is already taken instead of adopting it', async () => {
  const userDataPath = makeUserDataDir('jenny-llama-noadopt-');
  const foreign = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3:0.5b' }] }));
  });
  const baseUrl = await listen(foreign);
  let spawned = false;
  try {
    await assert.rejects(startLlamaServer({
      modelTag: 'qwen3:0.5b',
      binaryPath: path.join(userDataPath, 'llama-server.exe'),
      modelPath: path.join(userDataPath, 'model.gguf'),
      userDataPath,
      port: Number(new URL(baseUrl).port),
      readinessTimeoutMs: 500,
      readinessPollIntervalMs: 1,
      platform: 'win32',
      adopt: false,
      retainedApiKey: 'a'.repeat(32),
      spawnImpl: () => { spawned = true; return new FakeChildProcess(42010); },
      spawnSyncImpl: () => ({ status: 0 }),
      isProcessAliveImpl: () => false,
    }), /llama_server_port_busy/);
    assert.equal(spawned, false, 'a foreign server on the port is never adopted, and nothing is spawned behind it');
  } finally {
    await closeServer(foreign);
  }
});

test('lifecycle: an identity restore launches with the retained key and readiness authenticates with it', async () => {
  const userDataPath = makeUserDataDir('jenny-llama-retained-');
  const port = await getClosedPort();
  const retainedApiKey = '0123456789abcdef0123456789abcdef';
  const authorization = [];
  const server = http.createServer((request, response) => {
    authorization.push(request.headers.authorization);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3:0.5b' }] }));
  });
  let keyFileAtSpawn = '';
  try {
    const handle = await startLlamaServer({
      modelTag: 'qwen3:0.5b',
      binaryPath: path.join(userDataPath, 'llama-server.exe'),
      modelPath: path.join(userDataPath, 'model.gguf'),
      userDataPath,
      port,
      readinessTimeoutMs: 2000,
      readinessPollIntervalMs: 5,
      platform: 'win32',
      adopt: false,
      retainedApiKey,
      spawnImpl: (_command, args) => {
        keyFileAtSpawn = require('node:fs').readFileSync(args[args.indexOf('--api-key-file') + 1], 'utf8');
        // The "child" serves the port only after it was spawned.
        server.listen(port, '127.0.0.1');
        return new FakeChildProcess(42011);
      },
      spawnSyncImpl: () => ({ status: 0 }),
      isProcessAliveImpl: () => false,
    });
    assert.equal(handle.apiKey, retainedApiKey);
    assert.equal(handle.reused, false);
    assert.equal(keyFileAtSpawn, `${retainedApiKey}\n`);
    assert.ok(authorization.length > 0);
    assert.ok(authorization.every((value) => value === `Bearer ${retainedApiKey}`), 'readiness used the retained key');
    await handle.stop();
  } finally {
    await closeServer(server);
  }
  await assert.rejects(startLlamaServer({
    modelTag: 'qwen3:0.5b', userDataPath, port, retainedApiKey: 'not-a-key', adopt: false,
  }), /llama_server_retained_key_invalid/);
});
