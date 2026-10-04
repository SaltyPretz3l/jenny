'use strict';

// While the chat GPU handoff holds the lease, every path that would put a chat
// engine back on the GPU is refused or deferred: sidecar config refresh, model
// loads, llama-server launches. The shutdown controller sequences the handoff's
// closing latch before the llama_server stage and reaps an orphan render before
// llama-server autostart; an identity-restore launch never re-brokers the key.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ExclusiveGpuCoordinator } = require('../services/backend/exclusive-gpu-coordinator');
const { refreshManagedConfig } = require('../services/backend/managed-sidecar-lifecycle');
const { loadModel } = require('../services/backend/backend-runtime');
const { createRuntimeShutdownController } = require('../services/main/runtime-shutdown');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const OWNER = Object.freeze({ kind: 'builtin', tool_name: 'image_generate', call_id: 'c', stream_id: 's' });

async function leasedCoordinator() {
  const coordinator = new ExclusiveGpuCoordinator();
  const { leaseId } = await coordinator.acquireExclusiveLease({ owner: OWNER });
  return { coordinator, release: () => coordinator.releaseLease(leaseId, OWNER) };
}

test('refreshManagedConfig is deferred for any reason while the GPU lease is held', async () => {
  const { coordinator, release } = await leasedCoordinator();
  const logs = [];
  let initialized = 0;
  const service = {
    sidecarClient: {},
    sidecarManager: { process: {} },
    activeStreams: new Map(),
    exclusiveGpuCoordinator: coordinator,
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    async _initializeManagedSidecar() { initialized += 1; return {}; },
    async refreshStatusSnapshot() {},
  };
  assert.equal(await refreshManagedConfig(service, 'llama_server_ready'), null);
  assert.equal(await refreshManagedConfig(service, 'config_updated'), null);
  assert.equal(initialized, 0, 'no stack rebuild under a parked chat engine');
  const deferred = logs.filter((entry) => entry.event === 'sidecar.config_refresh_deferred');
  assert.equal(deferred.length, 2);
  assert.ok(deferred.every((entry) => entry.details.scope === 'gpu_lease_held'));
  assert.equal(service.deferredConfigRefreshReason, 'config_updated', 'the latest deferred reason is remembered for replay');
  release();
  await refreshManagedConfig(service, 'config_updated');
  assert.equal(initialized, 1, 'released lease: the refresh runs');
});

test('loadModel is refused with gpu_busy_plugin while the GPU lease is held', async () => {
  const { coordinator, release } = await leasedCoordinator();
  let initialized = 0;
  const service = {
    activeStreams: new Map(),
    currentEngineType: 'ollama',
    currentModel: 'gemma4:12b',
    exclusiveGpuCoordinator: coordinator,
    options: {},
    providerIntegrationRegistry: null,
    configService: { getState: () => ({ preferredEngineType: 'ollama' }), getLocalEngines: () => ({}) },
    _emitServiceLog() {},
    async _initializeManagedSidecar() { initialized += 1; },
    async refreshStatusSnapshot() {},
  };
  await assert.rejects(loadModel(service, { model: 'other:7b', engine_type: 'ollama' }), (error) => {
    assert.equal(error.code, 'gpu_busy_plugin');
    assert.equal(error.category, 'model_busy');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(initialized, 0);
  release();
  await loadModel(service, { model: 'other:7b', engine_type: 'ollama' });
  assert.equal(initialized, 1, 'released lease: the load proceeds');
});

// A controller whose llama-server lifecycle is a fake that honors the retained
// key, so the manager can be driven through a real stop/restore cycle.
function makeController({ backendService, reconcileImageEngine, killImageEngineSync, imageEngineReconcileTimeoutMs } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-gpu-gate-'));
  trackDirectory(userDataPath);
  const logs = [];
  const launches = [];
  let nextPid = 500;
  const lifecycle = {
    async startLlamaServer(options) {
      launches.push(options);
      const pid = nextPid++;
      return {
        pid, baseUrl: `http://127.0.0.1:${options.port}/v1`, reused: false, mmproj: '',
        apiKey: options.retainedApiKey || `key-${pid}`,
        async stop() { return { confirmed: true }; },
        stopSync() {},
      };
    },
    resolveGgufPath: () => ({ path: path.join(userDataPath, 'model.gguf'), projectorPath: '' }),
    resolveProjectorPath: () => '',
    resolveBinaryPath: () => path.join(userDataPath, 'llama-server.exe'),
    sweepStaleApiKeyFiles() {},
    shutdownLlamaServerSync: () => ({ hadState: false, killed: false, pid: 0 }),
  };
  const controller = createRuntimeShutdownController({
    app: { getPath: () => userDataPath },
    processRef: { env: { JENNY_LLAMA_SERVER_AUTOSTART: '1' }, resourcesPath: '', platform: process.platform },
    rootDir: userDataPath,
    clearSuggestionCache: () => {},
    suggestionCache: null,
    getBackendService: () => backendService,
    log: (level, event, fields) => logs.push({ level, event, fields }),
    llamaServerLifecycleImpl: lifecycle,
    resolveLaunchAccelerationImpl: () => ({ mode: 'off', reason: 'flag_off', extraArgs: [], drafter: '', vramHeadroomMb: 0 }),
    shutdownLlamaServerSyncImpl: () => ({ hadState: false, killed: false, pid: 0 }),
    shutdownManagedSidecarSyncImpl: () => {},
    shutdownAnyLocalOllamaSyncImpl: () => ({ skipped: 'no_owned_state' }),
    reconcileImageEngine,
    killImageEngineSync,
    ...(imageEngineReconcileTimeoutMs === undefined ? {} : { imageEngineReconcileTimeoutMs }),
  });
  return { controller, launches, logs, userDataPath };
}

test('an identity-restore launch skips the api-key re-broker; a fresh launch re-brokers', async () => {
  const refreshes = [];
  const backendService = {
    currentEngineType: 'openai-compatible',
    refreshManagedConfig: async (reason) => { refreshes.push(reason); },
  };
  const { controller } = makeController({ backendService });
  const manager = controller.getLlamaServerManager();
  await manager.start();
  assert.deepEqual(refreshes, ['llama_server_ready']);
  await manager.stop({ retainIdentity: true });
  const restored = await manager.ensureRunning(null, { reuseIdentity: true });
  assert.equal(restored.identityReused, true);
  assert.deepEqual(refreshes, ['llama_server_ready'], 'the parked turn keeps its stack: nothing to re-broker');
  await manager.stop();
  await manager.start();
  assert.deepEqual(refreshes, ['llama_server_ready', 'llama_server_ready']);
});

test('the manager consults the handoff launch refusal, and only the restore bypasses it', async () => {
  let refusal = 'gpu_lease_held';
  const backendService = { currentEngineType: 'ollama', chatGpuHandoff: { launchRefusal: () => refusal } };
  const { controller, launches } = makeController({ backendService });
  const manager = controller.getLlamaServerManager();
  assert.equal((await manager.start()).lastError, 'gpu_lease_held');
  assert.equal(launches.length, 0);
  refusal = '';
  await manager.start();
  assert.equal(launches.length, 1);
  await manager.stop({ retainIdentity: true });
  refusal = 'gpu_lease_held';
  assert.equal((await manager.ensureRunning(null, { reuseIdentity: true })).identityReused, true);
  assert.equal(launches.length, 2);
});

test('shutdown closes the image engine (cancel, no restore) before the llama_server stage', async () => {
  const order = [];
  const backendService = {
    currentEngineType: 'ollama',
    chatGpuHandoff: { async close() { order.push('image_engine'); return { cancelled: true, confirmed: true }; } },
  };
  const { controller, logs } = makeController({ backendService });
  const manager = controller.getLlamaServerManager();
  await manager.start();
  const originalStop = manager.stop;
  manager.stop = (...args) => { order.push('llama_server'); return originalStop(...args); };
  await controller.stopRuntimeBeforeQuit({});
  assert.deepEqual(order.slice(0, 2), ['image_engine', 'llama_server']);
  const stages = logs.filter((entry) => entry.event === 'runtime.shutdown_stage').map((entry) => entry.fields.stage);
  assert.ok(stages.indexOf('image_engine') < stages.indexOf('llama_server'));
  assert.equal(manager.getStatus().state, 'stopped');
});

test('a failing handoff close never blocks the llama_server stage', async () => {
  const backendService = {
    currentEngineType: 'ollama',
    chatGpuHandoff: { async close() { throw new Error('cancel failed'); } },
  };
  const { controller, logs } = makeController({ backendService });
  const manager = controller.getLlamaServerManager();
  await manager.start();
  await controller.stopRuntimeBeforeQuit({});
  assert.equal(manager.getStatus().state, 'stopped');
  const failed = logs.find((entry) => entry.event === 'runtime.shutdown_stage' && entry.fields.stage === 'image_engine');
  assert.equal(failed.fields.status, 'failed');
});

test('startup reaps an orphan render before llama-server autostart', async () => {
  const order = [];
  const { controller, launches, logs } = makeController({
    backendService: { currentEngineType: 'openai-compatible' },
    reconcileImageEngine: async () => { order.push('reconcile'); return { confirmed: true }; },
  });
  await controller.startLlamaServerBeforeBackend();
  assert.deepEqual(order, ['reconcile']);
  assert.equal(launches.length, 1);
  const step = logs.find((entry) => entry.event === 'runtime.startup_step');
  assert.equal(step.fields.step, 'image_engine_reconcile');
  assert.equal(step.fields.status, 'ok');
});

test('an unconfirmed or failing startup reconcile keeps the chat engine off the GPU', async () => {
  const unconfirmed = makeController({
    backendService: { currentEngineType: 'openai-compatible' },
    reconcileImageEngine: async () => ({ confirmed: false }),
  });
  await unconfirmed.controller.startLlamaServerBeforeBackend();
  assert.equal(unconfirmed.launches.length, 0, 'no autostart onto a GPU an orphan may hold');
  assert.equal(unconfirmed.logs.find((entry) => entry.event === 'runtime.startup_step').fields.status, 'unconfirmed');
  const skipped = unconfirmed.logs.find((entry) => entry.fields?.step === 'llama_server_autostart');
  assert.deepEqual(skipped.fields, { step: 'llama_server_autostart', status: 'skipped', reason: 'image_engine_unconfirmed' });
  const failing = makeController({
    backendService: { currentEngineType: 'openai-compatible' },
    reconcileImageEngine: async () => { throw new Error('reap failed'); },
  });
  await failing.controller.startLlamaServerBeforeBackend();
  assert.equal(failing.launches.length, 0);
  assert.equal(failing.logs.find((entry) => entry.event === 'runtime.startup_step').fields.status, 'failed');
});

test('a startup reconcile that never answers is bounded and reported unconfirmed', async () => {
  const hung = makeController({
    backendService: { currentEngineType: 'openai-compatible' },
    reconcileImageEngine: () => new Promise(() => {}),
    imageEngineReconcileTimeoutMs: 20,
  });
  await hung.controller.startLlamaServerBeforeBackend();
  assert.equal(hung.launches.length, 0, 'autostart waits for proof');
  const step = hung.logs.find((entry) => entry.event === 'runtime.startup_step');
  assert.equal(step.fields.status, 'unconfirmed');
  assert.equal(step.fields.timedOut, true);
});

test('the emergency path latches the handoff closed, then signals the image engine before llama-server', () => {
  const order = [];
  const { controller } = makeController({
    backendService: { currentEngineType: 'ollama', sessionStore: { dispose() {} },
      chatGpuHandoff: { markClosing: () => { order.push('closing'); } } },
    killImageEngineSync: () => { order.push('image_engine'); },
  });
  const manager = controller.getLlamaServerManager();
  const originalStopSync = manager.stopSync;
  manager.stopSync = () => { order.push('llama_server'); return originalStopSync(); };
  controller.runEmergencyRuntimeShutdownSync();
  assert.deepEqual(order, ['closing', 'image_engine', 'llama_server']);
});

function writeSyntheticGguf(filePath, architecture) {
  const key = Buffer.from('general.architecture');
  const value = Buffer.from(architecture);
  const header = Buffer.alloc(4 + 4 + 8 + 8 + 8 + key.length + 4 + 8 + value.length);
  let offset = header.write('GGUF', 0, 'ascii');
  offset = header.writeUInt32LE(3, offset);
  offset = header.writeBigUInt64LE(0n, offset);
  offset = header.writeBigUInt64LE(1n, offset);
  offset = header.writeBigUInt64LE(BigInt(key.length), offset);
  offset += key.copy(header, offset);
  offset = header.writeUInt32LE(8, offset);
  offset = header.writeBigUInt64LE(BigInt(value.length), offset);
  value.copy(header, offset);
  fs.writeFileSync(filePath, header);
}

test('the controller-built manager refuses a diffusion GGUF as a chat model and admits a chat one', async () => {
  const { controller, launches, logs, userDataPath } = makeController({ backendService: { currentEngineType: 'ollama' } });
  const manager = controller.getLlamaServerManager();
  const imagePath = path.join(userDataPath, 'image-model.gguf');
  const chatPath = path.join(userDataPath, 'chat-model.gguf');
  writeSyntheticGguf(imagePath, 'qwen_image21');
  writeSyntheticGguf(chatPath, 'llama');
  const refused = await manager.start({ modelTag: 'image-model', modelPath: imagePath });
  assert.equal(refused.state, 'stopped');
  assert.equal(refused.lastError, 'gguf_not_a_chat_model');
  assert.equal(launches.length, 0);
  assert.ok(logs.some((entry) => entry.event === 'llama.server.model_refused'));
  const admitted = await manager.start({ modelTag: 'chat-model', modelPath: chatPath });
  assert.equal(admitted.state, 'ready');
  assert.equal(launches.length, 1);
});
