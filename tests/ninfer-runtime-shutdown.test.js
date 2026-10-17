'use strict';

// Boot and shutdown wiring of the managed NInfer runtime (row 54 Step 6)
// through the real runtime-shutdown controller: NInfer autostarts first and
// llama-server stays down; the llama-server launch gate refuses while NInfer
// is up; flag-off hides the manager; both managers stop on shutdown.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const llamaLifecycle = require('../services/llama-server-lifecycle');
const { createRuntimeShutdownController } = require('../services/main/runtime-shutdown');
const { createNinferManager } = require('../services/main/ninfer-manager');

const ARTIFACT = { id: 'qwen3.8-27b-nvfp4', display_name: 'Qwen3.8 27B', model_id: 'qwen3.8-27b-nvfp4', supports_mtp: true, context_windows: [65536], default_context_window: 65536 };

function buildController({
  env = {}, lastUsedArtifactId = 'qwen3.8-27b-nvfp4', lastUsedTag = '',
  // ownManager: the controller builds the NInfer manager itself (the real
  // onStateChange: bridge event, key re-broker, endpoint release).
  ownManager = false, userDataPath = 'C:/jenny-user-data',
} = {}) {
  const logs = [];
  const launches = [];
  const ninferLaunches = [];
  const lifecycle = {
    ...llamaLifecycle,
    sweepStaleApiKeyFiles() {},
    async startLlamaServer(options) {
      launches.push(options);
      return { pid: 4321, reused: false, apiKey: 'key', baseUrl: `http://127.0.0.1:${options.port}/v1`, async stop() { return { confirmed: true }; }, stopSync() {} };
    },
  };
  const ninferLifecycle = {
    DEFAULT_NINFER_PORT: 8034,
    NINFER_PID_FILENAME: 'ninfer-serve.pid',
    stopConfirmed: true,
    async startNinferServer(options) {
      ninferLaunches.push(options);
      return { pid: 777, port: 8034, baseUrl: 'http://127.0.0.1:8034/v1', apiKey: 'nkey', modelId: options.modelId, contextSize: options.contextSize, mtp: options.mtp, hostKvMib: 0, async stop() { return { confirmed: ninferLifecycle.stopConfirmed }; }, stopSync() {} };
    },
  };
  const backend = {
    currentEngineType: 'openai-compatible',
    refreshes: [],
    _modelLifecycle: { state: 'unloaded' },
    sidecarManager: { process: null, getStatus: () => ({ phase: 'starting' }) },
    emit() {},
    async refreshManagedConfig(reason) { backend.refreshes.push(reason); },
    ninferRuntime: {
      install: { resolveExecutable: () => ({ ok: true, path: 'G:\\engines\\ninfer-serve.exe', version: '0.9.1' }) },
      artifacts: { artifacts: [ARTIFACT], async resolveArtifactPath() { return { ok: true, path: 'G:\\engines\\models\\q.ninfer', artifact: ARTIFACT }; } },
      eligibility: async () => ({ eligible: true, reason: '', device: { index: 0 }, probed: true }),
    },
  };
  const shellConfig = {
    getLocalEngines: () => ({
      startupModelLoad: true,
      openaiCompatible: { port: 8033, apiUrl: '', managed: { enabled: true, profileId: '', lastUsedTag, perModel: {} } },
      ninfer: { lastUsedArtifactId, suggestionDismissed: false, contextSize: 65536, mtp: true, watchdog: { enabled: false, maxWatts: 460, maxTempC: 83 } },
    }),
    getState: () => ({ featureOverrides: {}, preferredEngineType: 'openai-compatible' }),
  };
  let controller;
  const stubWatchdog = () => ({ start() {}, stop() {}, tick: async () => ({}), isRunning: () => false, settle: async () => {} });
  const ninferManager = ownManager ? undefined : createNinferManager({
    userDataPath,
    getShellConfigService: () => shellConfig,
    getRuntime: () => backend.ninferRuntime,
    getLlamaServerManager: () => controller.getLlamaServerManager(),
    lifecycle: ninferLifecycle,
    onStateChange: (status) => (status.state === 'ready' ? backend.refreshManagedConfig('ninfer_ready') : undefined),
    createWatchdog: stubWatchdog,
    log: (level, event, fields) => logs.push({ level, event, fields }),
  });
  const bridgeEvents = [];
  controller = createRuntimeShutdownController({
    app: { getPath: () => userDataPath },
    sendBridgeEvent: (channel, payload) => bridgeEvents.push({ channel, payload }),
    ninferLifecycleImpl: ninferLifecycle,
    createNinferWatchdogImpl: stubWatchdog,
    processRef: { env, resourcesPath: '' },
    rootDir: 'C:/jenny-repo',
    getShellConfigService: () => shellConfig,
    getBackendService: () => backend,
    llamaServerLifecycleImpl: lifecycle,
    resolveLaunchAccelerationImpl: () => ({ mode: 'off', reason: 'flag_off', extraArgs: [], drafter: '', vramHeadroomMb: 0 }),
    ninferManager,
    log: (level, event, fields) => logs.push({ level, event, fields }),
  });
  return { controller, logs, launches, ninferLaunches, backend, ninferManager, ninferLifecycle, bridgeEvents };
}

test('boot: the last-used NInfer artifact autostarts and llama-server autostart is skipped', async () => {
  const { controller, logs, launches, ninferLaunches, backend } = buildController();
  await controller.startLlamaServerBeforeBackend();
  assert.equal(ninferLaunches.length, 1);
  assert.equal(ninferLaunches[0].modelId, 'qwen3.8-27b-nvfp4');
  assert.deepEqual(launches, []);
  assert.equal(controller.getNinferManager().getStatus().state, 'ready');
  assert.equal(controller.getLlamaServerManager().getStatus().state, 'stopped');
  assert.deepEqual(backend.refreshes, ['ninfer_ready']);
  const skipped = logs.find((entry) => entry.event === 'runtime.startup_step' && entry.fields.step === 'llama_server_autostart');
  assert.equal(skipped?.fields.reason, 'ninfer_autostarted');
});

test('boot: with no NInfer target the llama-server autostart runs as before', async () => {
  const { controller, launches, ninferLaunches } = buildController({ lastUsedArtifactId: '', lastUsedTag: 'gemma4-12b' });
  await controller.startLlamaServerBeforeBackend();
  assert.deepEqual(ninferLaunches, []);
  assert.equal(launches.length, 1);
});

test('the llama-server launch gate refuses while NInfer is up; a NInfer launch stops llama-server first', async () => {
  const { controller, launches, ninferLaunches } = buildController({ lastUsedArtifactId: '', lastUsedTag: 'gemma4-12b' });
  await controller.startLlamaServerBeforeBackend();
  assert.equal(launches.length, 1);
  const ninfer = await controller.getNinferManager().ensureRunning({ artifactId: 'qwen3.8-27b-nvfp4' });
  assert.equal(ninfer.state, 'ready');
  assert.equal(ninferLaunches.length, 1);
  assert.equal(controller.getLlamaServerManager().getStatus().state, 'stopped');
  const refused = await controller.getLlamaServerManager().ensureRunning({ modelTag: 'gemma4:12b' });
  assert.equal(refused.state, 'stopped');
  assert.equal(refused.lastError, 'ninfer_running');
  assert.equal(launches.length, 1);
  await controller.getNinferManager().stop();
  const relaunched = await controller.getLlamaServerManager().ensureRunning({ modelTag: 'gemma4:12b' });
  assert.equal(relaunched.state, 'ready');
  assert.equal(launches.length, 2);
});

test('JENNY_ENABLE_NINFER=0 hides the manager: no NInfer autostart, no getter', async () => {
  const { controller, launches, ninferLaunches } = buildController({ env: { JENNY_ENABLE_NINFER: '0' }, lastUsedTag: 'gemma4-12b' });
  assert.equal(controller.getNinferManager(), null);
  await controller.startLlamaServerBeforeBackend();
  assert.deepEqual(ninferLaunches, []);
  assert.equal(launches.length, 1);
});

test('an unconfirmed NInfer stop with its pid alive keeps the llama-server gate closed until the record settles', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ninfer-gate-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const { controller, launches, ninferLifecycle } = buildController({ lastUsedArtifactId: '', lastUsedTag: 'gemma4-12b', ownManager: true, userDataPath });
  const ninfer = controller.getNinferManager();
  assert.equal((await ninfer.ensureRunning({ artifactId: 'qwen3.8-27b-nvfp4' })).state, 'ready');
  fs.writeFileSync(path.join(userDataPath, 'ninfer-serve.pid'), JSON.stringify({ pid: process.pid }), 'utf8');
  ninferLifecycle.stopConfirmed = false;
  assert.equal((await ninfer.stop()).lastError, 'stop_unconfirmed');
  const refused = await controller.getLlamaServerManager().ensureRunning({ modelTag: 'gemma4:12b' });
  assert.equal(refused.lastError, 'ninfer_stop_unconfirmed');
  assert.deepEqual(launches, []);
  fs.rmSync(path.join(userDataPath, 'ninfer-serve.pid'), { force: true });
  assert.equal((await controller.getLlamaServerManager().ensureRunning({ modelTag: 'gemma4:12b' })).state, 'ready');
});

test('leaving readiness re-brokers the sidecar once (not a parked identity), and the bridge hears every state', async () => {
  const { controller, backend, bridgeEvents } = buildController({ lastUsedArtifactId: '', lastUsedTag: '', ownManager: true });
  const ninfer = controller.getNinferManager();
  await ninfer.ensureRunning({ artifactId: 'qwen3.8-27b-nvfp4' });
  assert.deepEqual(backend.refreshes, ['ninfer_ready']);
  // Parked for the chat GPU handoff: the turn keeps its key, nothing is re-brokered.
  await ninfer.stop({ retainIdentity: true });
  assert.deepEqual(backend.refreshes, ['ninfer_ready']);
  await ninfer.ensureRunning(null, { reuseIdentity: true });
  assert.deepEqual(backend.refreshes, ['ninfer_ready'], 'an identity restore keeps the brokered key');
  await ninfer.stop();
  assert.deepEqual(backend.refreshes, ['ninfer_ready', 'ninfer_stopped']);
  await ninfer.stop();
  assert.deepEqual(backend.refreshes, ['ninfer_ready', 'ninfer_stopped'], 'a stop of a stopped server re-brokers nothing');
  assert.deepEqual(bridgeEvents.map((event) => event.channel), bridgeEvents.map(() => 'ninfer.onChanged'));
  assert.deepEqual(bridgeEvents.map((event) => event.payload.state), ['starting', 'ready', 'stopping', 'stopped', 'starting', 'ready', 'stopping', 'stopped']);
});
