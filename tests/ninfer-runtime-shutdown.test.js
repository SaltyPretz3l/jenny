'use strict';

// Boot and shutdown wiring of the managed NInfer runtime (row 54 Step 6)
// through the real runtime-shutdown controller: NInfer autostarts first and
// llama-server stays down; the llama-server launch gate refuses while NInfer
// is up; flag-off hides the manager; both managers stop on shutdown. Row 200
// adds Strata above both (llama-server < NInfer < Strata): its launch stops
// the two, their gates refuse while it is up, and concurrent triggers settle.

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
  // strata: a fake Strata runtime and lifecycle, on a win32 processRef.
  strata = null,
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
      strata: { lastUsed: Boolean(strata?.lastUsed), slots: 4, kv: 'k8v8', vision: true, drafting: 'off' },
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
  const strataLaunches = [];
  const strataReaps = [];
  const strataLifecycle = {
    DEFAULT_STRATA_PORT: 8035,
    STRATA_PID_FILENAME: 'strata-serve.pid',
    reapRecordedStrataServer(options) { strataReaps.push(options.userDataPath); return { reaped: false }; },
    async startStrataServer(options) {
      strataLaunches.push(options);
      if (strata?.pending) await strata.pending;
      return { pid: 888, port: 8035, baseUrl: 'http://127.0.0.1:8035/v1', apiKey: 'f'.repeat(32), modelId: 'inkling-2-mini-sq-20', contextSize: 114432, vision: true, async stop() { return { confirmed: true }; }, stopSync() {} };
    },
  };
  if (strata) {
    backend.strataRuntime = {
      enabled: true,
      async plan({ settings }) {
        return { install: { root: 'C:\\S' }, config: { exe: 'C:\\S\\e.exe', log: 'C:\\u\\l.log' }, slots: settings.slots, kv: settings.kv, vision: true, drafting: 'off', maxContext: 114432, fit: 114432, fitSource: 'measured', modelId: 'inkling-2-mini-sq-20', displayName: 'Inkling 2 Mini', version: '0.1.67' };
      },
    };
  }
  controller = createRuntimeShutdownController({
    app: { getPath: () => userDataPath },
    sendBridgeEvent: (channel, payload) => bridgeEvents.push({ channel, payload }),
    ninferLifecycleImpl: ninferLifecycle,
    createNinferWatchdogImpl: stubWatchdog,
    processRef: { env, resourcesPath: '', ...(strata ? { platform: 'win32' } : {}) },
    rootDir: 'C:/jenny-repo',
    getShellConfigService: () => shellConfig,
    getBackendService: () => backend,
    llamaServerLifecycleImpl: lifecycle,
    resolveLaunchAccelerationImpl: () => ({ mode: 'off', reason: 'flag_off', extraArgs: [], drafter: '', vramHeadroomMb: 0 }),
    ninferManager,
    strataLifecycleImpl: strataLifecycle,
    createStrataWatchdogImpl: stubWatchdog,
    log: (level, event, fields) => logs.push({ level, event, fields }),
    // Inert stand-ins: the quit path ends in the emergency sweep, whose real
    // helpers taskkill / `ollama stop` / `wsl --shutdown` on this machine.
    clearSuggestionCache: () => {},
    shutdownLlamaServerSyncImpl: () => ({ hadState: false, killed: false }),
    shutdownManagedSidecarSyncImpl: () => ({ hadState: false, killed: false }),
    shutdownAnyLocalOllamaSyncImpl: () => ({ skipped: 'no_owned_state' }),
  });
  return { controller, logs, launches, ninferLaunches, strataLaunches, strataReaps, backend, ninferManager, ninferLifecycle, bridgeEvents, shellConfig };
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

// The live-session logs showed every quit re-initializing the sidecar against the
// NInfer it had just stopped (sidecar.config_refresh_failed reason=ninfer_stopped).
async function readyNinfer() {
  const ctx = buildController({ lastUsedArtifactId: '', lastUsedTag: '', ownManager: true });
  const ninfer = ctx.controller.getNinferManager();
  await ninfer.ensureRunning({ artifactId: 'qwen3.8-27b-nvfp4' });
  assert.deepEqual(ctx.backend.refreshes, ['ninfer_ready']);
  return { ...ctx, ninfer };
}

// 2026-10-27: a chat's switch to an Ollama model stopped NInfer, the stop
// re-brokered the sidecar for the OLD model, and the switch's own initialize
// was refused busy (CMP-AI-0002, "Provider issue").
test('an engine-switch stop leaves the sidecar to the switch instead of re-brokering it', async () => {
  const { backend, ninfer } = await readyNinfer();
  const stopped = await ninfer.stop({ stoppedBy: 'engine_switch' });
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.stoppedBy, 'engine_switch');
  assert.deepEqual(backend.refreshes, ['ninfer_ready'], 'no ninfer_stopped re-broker during an engine switch');
  await ninfer.ensureRunning({ artifactId: 'qwen3.8-27b-nvfp4' });
  assert.equal(ninfer.getStatus().stoppedBy, '', 'a relaunch clears the stop reason');
  await ninfer.stop();
  assert.deepEqual(backend.refreshes, ['ninfer_ready', 'ninfer_ready', 'ninfer_stopped'], 'a plain stop still re-brokers');
});

test('app shutdown stops NInfer without re-brokering the sidecar to the stopped endpoint', async () => {
  const { controller, backend, logs, ninfer } = await readyNinfer();
  backend.stop = async () => {};
  await controller.stopRuntimeBeforeQuit();
  assert.equal(ninfer.getStatus().state, 'stopped');
  const llamaStage = logs.find((entry) => entry.event === 'runtime.shutdown_stage' && entry.fields.stage === 'llama_server');
  assert.equal(llamaStage?.fields.status, 'ok', 'NInfer is stopped by the awaited llama_server stage');
  assert.deepEqual(backend.refreshes, ['ninfer_ready'], 'no ninfer_stopped re-broker during app shutdown');
});

test('the emergency shutdown path stops NInfer without re-brokering the sidecar', async () => {
  const { controller, backend, ninfer } = await readyNinfer();
  controller.runEmergencyRuntimeShutdownSync();
  assert.equal(ninfer.getStatus().state, 'stopped');
  assert.deepEqual(backend.refreshes, ['ninfer_ready'], 'no ninfer_stopped re-broker during emergency shutdown');
});

test('a Strata launch stops NInfer and llama-server first; both gates then refuse while Strata is up', async () => {
  const { controller, launches, ninferLaunches, strataLaunches, backend, bridgeEvents } = buildController({ strata: {}, ownManager: true });
  await controller.getNinferManager().ensureRunning({ artifactId: 'qwen3.8-27b-nvfp4' });
  assert.equal(ninferLaunches.length, 1);
  const strata = await controller.getStrataManager().ensureRunning(null);
  assert.equal(strata.state, 'ready');
  assert.equal(strataLaunches.length, 1);
  assert.equal(controller.getNinferManager().getStatus().state, 'stopped');
  assert.equal((await controller.getNinferManager().ensureRunning({ artifactId: 'qwen3.8-27b-nvfp4' })).lastError, 'strata_running');
  assert.equal((await controller.getLlamaServerManager().ensureRunning({ modelTag: 'gemma4:12b' })).lastError, 'strata_running');
  assert.equal(ninferLaunches.length, 1);
  assert.deepEqual(launches, []);
  assert.ok(backend.refreshes.includes('strata_ready'));
  assert.ok(bridgeEvents.some((event) => event.channel === 'strata.onChanged' && event.payload.state === 'ready'));
  await controller.getStrataManager().stop();
  assert.equal((await controller.getNinferManager().ensureRunning({ artifactId: 'qwen3.8-27b-nvfp4' })).state, 'ready');
});

test('concurrent Strata and NInfer launch triggers both settle; neither chain waits forever', async () => {
  const { controller } = buildController({ strata: {}, ownManager: true });
  const timeout = new Promise((resolve) => { setTimeout(() => resolve('timeout'), 2000).unref(); });
  const both = Promise.all([
    controller.getStrataManager().ensureRunning(null),
    controller.getNinferManager().ensureRunning({ artifactId: 'qwen3.8-27b-nvfp4' }),
    controller.getStrataManager().restart(null),
    controller.getNinferManager().restart({ artifactId: 'qwen3.8-27b-nvfp4' }),
  ]);
  const result = await Promise.race([both, timeout]);
  assert.notEqual(result, 'timeout');
  const ready = [controller.getStrataManager(), controller.getNinferManager(), controller.getLlamaServerManager()]
    .filter((manager) => manager.getStatus().state === 'ready');
  assert.equal(ready.length <= 1, true, 'at most one managed server holds the GPU');
});

test('boot: a last-used Strata reaps its recorded server, autostarts, and NInfer and llama-server stay down', async () => {
  const { controller, launches, ninferLaunches, strataLaunches, strataReaps, logs } = buildController({ strata: { lastUsed: true }, ownManager: true });
  await controller.startLlamaServerBeforeBackend();
  assert.deepEqual(strataReaps, ['C:/jenny-user-data']);
  assert.equal(strataLaunches.length, 1);
  assert.deepEqual(ninferLaunches, []);
  assert.deepEqual(launches, []);
  const skipped = logs.find((entry) => entry.event === 'runtime.startup_step' && entry.fields.step === 'llama_server_autostart');
  assert.equal(skipped?.fields.reason, 'strata_autostarted');
});

test('Strata is hidden with its flag off and off Windows; app shutdown stops it', async () => {
  assert.equal(buildController({ strata: {}, env: { JENNY_ENABLE_STRATA: '0' } }).controller.getStrataManager(), null);
  assert.equal(buildController().controller.getStrataManager(), null, 'no win32 platform, no Strata');
  const { controller, backend } = buildController({ strata: {}, ownManager: true });
  await controller.getStrataManager().ensureRunning(null);
  await controller.stopRuntimeBeforeQuit();
  assert.equal(controller.getStrataManager().getStatus().state, 'stopped');
  assert.equal(backend.refreshes.includes('strata_stopped'), false, 'no re-broker to a stopped endpoint on quit');
});

test('the manager lookups read the feature flags once per shell-config state, not a config clone per call', () => {
  const { controller, shellConfig } = buildController({ strata: {} });
  let clones = 0;
  const overrides = { featureOverrides: {} };
  shellConfig.state = {};
  shellConfig.getState = () => { clones += 1; return overrides; };
  for (let i = 0; i < 5; i += 1) { controller.getStrataManager(); controller.getNinferManager(); }
  assert.equal(clones, 1);
  shellConfig.state = {}; // every config write replaces the state object
  controller.getStrataManager();
  assert.equal(clones, 2, 'a new state reads the flags again');
});

test('main threads the three managed-engine getters through one spread', () => {
  const managedServerGetters = require('../services/main/managed-server-getters');
  const { controller } = buildController({ strata: {}, ownManager: true });
  const getters = managedServerGetters(() => controller);
  assert.deepEqual(Object.keys(getters).sort(), ['getLlamaServerManager', 'getNinferManager', 'getStrataManager']);
  assert.equal(getters.getLlamaServerManager(), controller.getLlamaServerManager());
  assert.equal(getters.getNinferManager(), controller.getNinferManager());
  assert.equal(getters.getStrataManager(), controller.getStrataManager());
});
