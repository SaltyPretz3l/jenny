'use strict';

// new-test-file: a different harness (the real runtime-shutdown controller and the
// chat GPU handoff), and together with local-subagent-engine.test.js the cases
// would pass the 600-line cap. Boot, re-broker and GPU handoff with a resident
// local subagent engine (row 179 P3).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const llamaLifecycle = require('../services/llama-server-lifecycle');
const { createRuntimeShutdownController } = require('../services/main/runtime-shutdown');
const { createChatGpuHandoff } = require('../services/backend/chat-gpu-handoff');
const { ExclusiveGpuCoordinator } = require('../services/backend/exclusive-gpu-coordinator');
const { verifyGpuEvictedForEngine } = require('../services/backend/exclusive-gpu-preflight');
const { BackendService } = require('../services/backend/backend-service');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const ARTIFACT = { id: 'qwen3.8-27b-nvfp4', display_name: 'Qwen3.8 27B', model_id: 'qwen3.8-27b-nvfp4', supports_mtp: true, context_windows: [65536], default_context_window: 65536 };
const NINFER_HELPER = Object.freeze({ engine: 'ninfer', model: ARTIFACT.model_id });
const LLAMA_HELPER = Object.freeze({ engine: 'llama-server', model: 'gemma4:12b' });

function buildController({ engine = 'api-provider', helper = NINFER_HELPER, flags = {}, startupModelLoad = true } = {}) {
  const logs = [];
  const launches = [];
  const ninferLaunches = [];
  const exits = {};
  const lifecycle = {
    ...llamaLifecycle,
    sweepStaleApiKeyFiles() {},
    async startLlamaServer(options) {
      launches.push(options);
      exits.llama = options.onExit;
      return { pid: 4321, reused: false, apiKey: 'test-llama-launch-key-0123456789', baseUrl: `http://127.0.0.1:${options.port}/v1`, async stop() { return { confirmed: true }; }, stopSync() {} };
    },
  };
  const ninferLifecycle = {
    DEFAULT_NINFER_PORT: 8034,
    NINFER_PID_FILENAME: 'ninfer-serve.pid',
    async startNinferServer(options) {
      ninferLaunches.push(options);
      exits.ninfer = options.onExit;
      return { pid: 777, port: 8034, baseUrl: 'http://127.0.0.1:8034/v1', apiKey: 'test-ninfer-launch-key-0123456789', modelId: options.modelId, contextSize: options.contextSize, mtp: options.mtp, hostKvMib: 0, async stop() { return { confirmed: true }; }, stopSync() {} };
    },
  };
  const managed = { enabled: true, profileId: '', lastUsedTag: '', perModel: { 'gemma4-12b': { engine: 'llama-server', modelPath: '', tag: 'gemma4:12b', mtp: null } } };
  const shellConfig = {
    getLocalEngines: () => ({
      startupModelLoad,
      openaiCompatible: { port: 8033, apiUrl: '', managed },
      ninfer: { lastUsedArtifactId: '', suggestionDismissed: false, contextSize: 65536, mtp: true, watchdog: { enabled: false, maxWatts: 460, maxTempC: 83 } },
    }),
    getState: () => ({ featureOverrides: {}, preferredEngineType: engine, localSubagentEngine: helper }),
  };
  const backend = {
    currentEngineType: engine,
    refreshes: [],
    _modelLifecycle: { state: 'unloaded' },
    featureFlags: { local_subagent_engine: true, ...flags },
    offlineIntelligenceService: { getMode: () => 'off' },
    configService: shellConfig,
    sidecarManager: { process: null, getStatus: () => ({ phase: 'starting' }) },
    emit() {},
    _emitServiceLog: (level, event, fields) => logs.push({ level, event, fields }),
    async refreshManagedConfig(reason) { backend.refreshes.push(reason); },
    ninferRuntime: {
      install: { resolveExecutable: () => ({ ok: true, path: 'G:\\engines\\ninfer-serve.exe', version: '0.9.1' }) },
      artifacts: { artifacts: [ARTIFACT], async resolveArtifactPath() { return { ok: true, path: 'G:\\engines\\models\\q.ninfer', artifact: ARTIFACT }; } },
      eligibility: async () => ({ eligible: true, reason: '', device: { index: 0 }, probed: true }),
    },
  };
  const stubWatchdog = () => ({ start() {}, stop() {}, tick: async () => ({}), isRunning: () => false, settle: async () => {} });
  const controller = createRuntimeShutdownController({
    app: { getPath: () => 'C:/jenny-user-data' },
    ninferLifecycleImpl: ninferLifecycle,
    createNinferWatchdogImpl: stubWatchdog,
    processRef: { env: {}, resourcesPath: '' },
    rootDir: 'C:/jenny-repo',
    getShellConfigService: () => shellConfig,
    getBackendService: () => backend,
    llamaServerLifecycleImpl: lifecycle,
    resolveLaunchAccelerationImpl: () => ({ mode: 'off', reason: 'flag_off', extraArgs: [], drafter: '', vramHeadroomMb: 0 }),
    log: (level, event, fields) => logs.push({ level, event, fields }),
    clearSuggestionCache: () => {},
    shutdownLlamaServerSyncImpl: () => ({ hadState: false, killed: false }),
    shutdownManagedSidecarSyncImpl: () => ({ hadState: false, killed: false }),
    shutdownAnyLocalOllamaSyncImpl: () => ({ skipped: 'no_owned_state' }),
  });
  backend.options = { getNinferManager: () => controller.getNinferManager(), getLlamaServerManager: () => controller.getLlamaServerManager() };
  return { controller, backend, logs, launches, ninferLaunches, exits };
}

// ---- re-broker -------------------------------------------------------------------

test('a NInfer helper under a cloud primary re-brokers on ready, stop and crash', async () => {
  const { controller, backend } = buildController();
  const ninfer = controller.getNinferManager();
  await ninfer.ensureRunning({ artifactId: ARTIFACT.id });
  assert.deepEqual(backend.refreshes, ['ninfer_ready']);
  assert.deepEqual(backend._modelLifecycle, { state: 'unloaded' }, 'a helper start is not a primary model load');
  await ninfer.stop();
  assert.deepEqual(backend.refreshes, ['ninfer_ready', 'ninfer_stopped']);
  const crash = buildController();
  await crash.controller.getNinferManager().ensureRunning({ artifactId: ARTIFACT.id });
  crash.exits.ninfer({ pid: 777, code: 1 });
  assert.equal(crash.controller.getNinferManager().getStatus().state, 'crashed');
  assert.deepEqual(crash.backend.refreshes, ['ninfer_ready', 'ninfer_stopped']);
});

test('a llama-server helper under a cloud primary re-brokers on ready, stop and crash; a parked identity does not', async () => {
  const { controller, backend, exits } = buildController({ helper: LLAMA_HELPER });
  const llama = controller.getLlamaServerManager();
  assert.equal((await llama.ensureRunning({ modelTag: 'gemma4:12b' })).state, 'ready');
  assert.deepEqual(backend.refreshes, ['llama_server_ready']);
  await llama.stop({ retainIdentity: true });
  assert.deepEqual(backend.refreshes, ['llama_server_ready'], 'a GPU handoff park keeps the brokered key');
  await llama.ensureRunning(null, { reuseIdentity: true });
  exits.llama({ pid: 4321, code: 1 });
  assert.equal(llama.getStatus().state, 'crashed');
  assert.deepEqual(backend.refreshes, ['llama_server_ready', 'local_subagent_engine_stopped']);
  await llama.ensureRunning({ modelTag: 'gemma4:12b' });
  await llama.stop();
  assert.deepEqual(backend.refreshes.slice(2), ['llama_server_ready', 'local_subagent_engine_stopped']);
});

test('flag off or no pick: a managed server under a cloud primary re-brokers nothing, as before', async () => {
  for (const options of [{ flags: { local_subagent_engine: false } }, { helper: { engine: '', model: '' } }]) {
    const { controller, backend } = buildController(options);
    await controller.getNinferManager().ensureRunning({ artifactId: ARTIFACT.id });
    await controller.getNinferManager().stop();
    assert.deepEqual(backend.refreshes, []);
  }
});

// ---- boot ----------------------------------------------------------------------------

test('a cloud boot starts the picked helper once and skips the primary autostart', async () => {
  const { controller, backend, logs, ninferLaunches, launches } = buildController();
  await controller.startLlamaServerBeforeBackend();
  await controller.getNinferManager().settled();
  assert.equal(ninferLaunches.length, 1);
  assert.equal(ninferLaunches[0].modelId, ARTIFACT.model_id);
  assert.deepEqual(launches, []);
  assert.deepEqual(backend.refreshes, ['ninfer_ready']);
  const step = logs.find((entry) => entry.event === 'runtime.startup_step' && entry.fields.step === 'local_subagent_engine_autostart');
  assert.deepEqual(step.fields, { step: 'local_subagent_engine_autostart', status: 'started', engine: 'ninfer' });
});

test('boot honours startup model load off and the flag; a local boot is unchanged', async () => {
  const off = buildController({ startupModelLoad: false });
  await off.controller.startLlamaServerBeforeBackend();
  assert.deepEqual(off.ninferLaunches, []);
  assert.ok(off.logs.some((entry) => entry.fields?.reason === 'startup_model_load_off'));
  const flagOff = buildController({ flags: { local_subagent_engine: false } });
  await flagOff.controller.startLlamaServerBeforeBackend();
  assert.deepEqual([flagOff.ninferLaunches, flagOff.launches], [[], []]);
  const local = buildController({ engine: 'openai-compatible' });
  await local.controller.startLlamaServerBeforeBackend();
  assert.deepEqual(local.ninferLaunches, []);
  assert.equal(local.logs.some((entry) => entry.fields?.step === 'local_subagent_engine_autostart'), false);
});

test('a helper launch failure at boot is logged and never blocks it', async () => {
  const { controller, backend, logs } = buildController();
  backend.ninferRuntime.artifacts.resolveArtifactPath = async () => ({ ok: false, reason: 'not_downloaded' });
  await controller.startLlamaServerBeforeBackend();
  await controller.getNinferManager().settled();
  await new Promise((resolve) => setImmediate(resolve));
  const failure = logs.find((entry) => entry.event === 'backend.local_subagent_engine_start_failed');
  assert.equal(failure.fields.reason, 'boot');
  assert.equal(JSON.stringify(logs).includes('launch-key'), false);
});

// ---- GPU handoff ----------------------------------------------------------------------

const OWNER = Object.freeze({ kind: 'builtin', tool_name: 'image_generate', call_id: 'call-1', stream_id: 'stream-1' });

function makeHandoff({ engine = 'api-provider', ninferStatus = null, llamaStatus = null, flags = {}, picked = 'ninfer' } = {}) {
  const calls = [];
  const alive = new Set();
  const manager = (name, initial) => {
    if (!initial) return null;
    if (initial.state === 'ready') alive.add(initial.pid);
    return {
      getStatus: () => ({ ...initial }),
      async stop(options) { calls.push([`${name}.stop`, options]); alive.delete(initial.pid); return { state: 'stopped', identityRetained: true, lastError: '' }; },
      async ensureRunning(spec, options) { calls.push([`${name}.ensureRunning`, spec, options]); return { state: 'ready', identityReused: true, lastError: '' }; },
    };
  };
  const ninfer = manager('ninfer', ninferStatus);
  const llama = manager('llama', llamaStatus);
  const handoff = createChatGpuHandoff({
    backendService: {
      currentEngineType: engine, featureFlags: { local_subagent_engine: true, ...flags }, activeStreams: new Map([[OWNER.stream_id, {}]]),
      configService: { getState: () => ({ localSubagentEngine: { engine: picked, model: 'helper-model' } }) },
    },
    coordinator: new ExclusiveGpuCoordinator(),
    getNinferManager: () => ninfer,
    getLlamaServerManager: () => llama,
    probeVram: async () => ({ available: true, usedMb: alive.size ? 20_000 : 500, totalMb: 24_000, devices: [{ index: 0, usedMb: alive.size ? 20_000 : 500, totalMb: 24_000 }] }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ models: [] }) }),
    pendingInferenceCount: () => 0,
    isProcessAliveImpl: (pid) => alive.has(pid),
    sleep: async () => {},
  });
  return { calls, handoff };
}

test('the GPU handoff parks and restores a resident NInfer or llama-server helper under a cloud primary', async () => {
  const ninfer = makeHandoff({ ninferStatus: { state: 'ready', pid: 5151 } });
  await ninfer.handoff.suspend(OWNER, { requiredFreeMb: 8_000 });
  assert.deepEqual(ninfer.calls, [['ninfer.stop', { retainIdentity: true }]]);
  assert.deepEqual(await ninfer.handoff.restoreAndRelease(), { restored: true, released: true, reason: 'done' });
  assert.deepEqual(ninfer.calls[1], ['ninfer.ensureRunning', null, { reuseIdentity: true }]);
  const llama = makeHandoff({ engine: 'chatgpt', llamaStatus: { state: 'ready', pid: 4242, reused: false } });
  await llama.handoff.suspend(OWNER, { requiredFreeMb: 8_000 });
  assert.deepEqual(llama.calls, [['llama.stop', { retainIdentity: true }]]);
  assert.equal((await llama.handoff.restoreAndRelease()).restored, true);
});

test('a helper that cannot be parked is never reported as a free GPU; no helper keeps cloud behaviour', async () => {
  const starting = makeHandoff({ ninferStatus: { state: 'starting', pid: 0 } });
  await assert.rejects(starting.handoff.suspend(OWNER, { requiredFreeMb: 8_000 }), (error) => error.reason === 'local_subagent_engine_resident');
  const adopted = makeHandoff({ llamaStatus: { state: 'ready', pid: 4242, reused: true } });
  await assert.rejects(adopted.handoff.suspend(OWNER, { requiredFreeMb: 8_000 }), (error) => error.reason === 'local_subagent_engine_resident');
  const none = makeHandoff();
  await none.handoff.suspend(OWNER, { requiredFreeMb: 8_000 });
  assert.deepEqual(none.calls, []);
  assert.deepEqual(await none.handoff.restoreAndRelease(), { restored: true, released: true, reason: 'done' });
  const flagOff = makeHandoff({ flags: { local_subagent_engine: false }, ninferStatus: { state: 'starting', pid: 0 } });
  await flagOff.handoff.suspend(OWNER, { requiredFreeMb: 0 });
  assert.deepEqual(flagOff.calls, [], 'flag off: today\'s cloud path');
  const unpicked = makeHandoff({ picked: '', ninferStatus: { state: 'starting', pid: 0 } });
  await unpicked.handoff.suspend(OWNER, { requiredFreeMb: 0 });
  assert.deepEqual(unpicked.calls, [], 'no helper picked: the cloud path is unchanged');
  const verdict = await verifyGpuEvictedForEngine({ engineType: 'api-provider', fetchImpl: async () => ({ ok: true, json: async () => ({ models: [] }) }) });
  assert.equal(verdict.proof, 'engine_has_no_local_gpu_runtime');
});

// ---- BackendService surface --------------------------------------------------------------

test('BackendService exposes the helper status and sync', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-local-subagent-engine-'));
  trackDirectory(userDataPath);
  const service = new BackendService({
    userDataPath, repoRoot: process.cwd(), pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(), featureFlags: { local_subagent_engine: false },
  });
  assert.equal(service.getLocalSubagentEngineStatus().reason, 'flag_off');
  assert.deepEqual(await service.syncLocalSubagentEngine('test'), { synced: false, reason: 'not_cloud' });
});
