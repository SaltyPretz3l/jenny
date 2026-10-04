'use strict';

// Real-app pass 2026-09-29, through the real runtime-shutdown controller,
// llama-server manager and settings resolver (only the spawn is stubbed):
// X2 - boot autostart of the managed llama-server follows the active engine;
// E2 - a managed start reaches the backend as a model load with a clock.

const test = require('node:test');
const assert = require('node:assert/strict');

const llamaLifecycle = require('../services/llama-server-lifecycle');
const { createRuntimeShutdownController } = require('../services/main/runtime-shutdown');

const MANAGED = Object.freeze({ enabled: true, profileId: '', lastUsedTag: 'gemma4-12b', perModel: {} });

function buildController({ env = {}, backend }) {
  const logs = [];
  const launches = [];
  const lifecycle = {
    ...llamaLifecycle,
    sweepStaleApiKeyFiles() {},
    async startLlamaServer(options) {
      launches.push(options);
      return {
        pid: 4321,
        reused: false,
        apiKey: 'key',
        baseUrl: `http://127.0.0.1:${options.port}/v1`,
        async stop() { return { confirmed: true }; },
        stopSync() {},
      };
    },
  };
  const controller = createRuntimeShutdownController({
    app: { getPath: () => 'C:/jenny-user-data' },
    processRef: { env, resourcesPath: '' },
    rootDir: 'C:/jenny-repo',
    getShellConfigService: () => ({
      getLocalEngines: () => ({ startupModelLoad: true, openaiCompatible: { port: 8033, apiUrl: '', managed: MANAGED } }),
      getState: () => ({ featureOverrides: {}, preferredEngineType: backend?.currentEngineType || '' }),
    }),
    getBackendService: () => backend,
    llamaServerLifecycleImpl: lifecycle,
    resolveLaunchAccelerationImpl: () => ({ mode: 'off', reason: 'flag_off', extraArgs: [], drafter: '', vramHeadroomMb: 0 }),
    log: (level, event, fields) => logs.push({ level, event, fields }),
  });
  return { controller, logs, launches };
}

function makeBackend(currentEngineType) {
  const emits = [];
  const refreshes = [];
  return {
    currentEngineType,
    emits,
    refreshes,
    _modelLifecycle: { state: 'unloaded' },
    sidecarManager: { process: null, getStatus: () => ({ phase: 'starting' }) },
    emit(event, payload) { emits.push([event, payload]); },
    async refreshManagedConfig(reason) { refreshes.push(reason); },
  };
}

test('a replay boot does not autostart the managed llama-server and says why', async () => {
  const { controller, logs, launches } = buildController({ backend: makeBackend('replay') });

  await controller.startLlamaServerBeforeBackend();

  assert.deepEqual(launches, []);
  const skipped = logs.find((entry) => entry.event === 'llama.server.autostart_skipped');
  assert.deepEqual(skipped?.fields, { reason: 'engine_not_active' });
  assert.equal(controller.getLlamaServerManager().getStatus().state, 'stopped');
});

test('JENNY_LLAMA_SERVER_AUTOSTART=1 still forces the boot launch for another engine', async () => {
  const { controller, launches } = buildController({
    env: { JENNY_LLAMA_SERVER_AUTOSTART: '1' },
    backend: makeBackend('replay'),
  });

  await controller.startLlamaServerBeforeBackend();

  assert.equal(launches.length, 1);
});

test('an openai-compatible boot autostarts and the backend reads the start as a model load', async () => {
  const backend = makeBackend('openai-compatible');
  const { controller, launches, logs } = buildController({ backend });

  await controller.startLlamaServerBeforeBackend();

  assert.equal(launches.length, 1);
  assert.equal(logs.some((entry) => entry.event === 'llama.server.autostart_skipped'), false);
  const loading = backend.emits
    .map(([, status]) => status)
    .find((status) => status?.model_state === 'loading');
  assert.ok(loading, 'the managed start must surface as a model load');
  assert.equal(loading.model_acquisition.requested_model, 'gemma4-12b');
  assert.equal(loading.model_lifecycle.engine, 'openai-compatible');
  assert.ok(Number.isFinite(Date.parse(loading.model_acquisition.started_at)));
  assert.deepEqual(backend.refreshes, ['llama_server_ready']);
});
