const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  initializeManagedSidecarWithTimeout,
} = require('../services/backend/local-engine-status');

function createService(initialize) {
  const service = new EventEmitter();
  const processGeneration = {};
  return Object.assign(service, {
    currentEngineType: 'ollama',
    currentModel: '',
    defaultModel: 'ornith:9b',
    featureFlags: {},
    options: { userDataPath: process.cwd() },
    _disposed: false,
    _managedInitializeFlight: null,
    _managedInitializeGeneration: 0,
    _managedPendingModel: '',
    _modelLifecycle: { state: 'unloaded' },
    _emitServiceLog() {},
    sidecarManager: {
      process: processGeneration,
      getStatus: () => ({ phase: 'ready', pid: 42 }),
    },
    sidecarClient: {
      process: processGeneration,
      connected: true,
      attachProcess(next) { this.process = next; },
      initialize,
    },
  });
}

test('managed initialization rejects progress from an earlier lifecycle stage', async () => {
  let emitProgress;
  let finish;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const service = createService((_payload, { onProgress }) => new Promise((resolve) => {
    emitProgress = onProgress;
    finish = () => resolve({
      active_engine: 'ollama',
      active_model: 'ornith:9b',
      active_model_capabilities: { text: true },
      local_runtime: {
        engine: { type: 'ollama' },
        model: { id: 'ornith:9b', loaded: true },
      },
    });
    started();
  }));
  const flight = initializeManagedSidecarWithTimeout(service, {
    requestedModel: 'ornith:9b',
    inactivityTimeoutMs: 1_000,
    absoluteTimeoutMs: 2_000,
  });
  await startedPromise;

  emitProgress({ method: 'runtime.progress', params: {
    state: 'model_loading', status: 'loading', percent: 60, completed_bytes: 600,
  } });
  emitProgress({ method: 'runtime.progress', params: {
    state: 'model_acquiring', status: 'stale download', percent: 90, completed_bytes: 900,
  } });

  assert.equal(service._modelLifecycle.state, 'loading');
  assert.equal(service._modelLifecycle.percent, 60);
  assert.equal(service._modelLifecycle.completed_bytes, 600);
  finish();
  await flight;
});

test('a pure loading -> ready flight records its duration and the next status carries last_load_ms', () => {
  const { setModelLifecycle, buildObservedBackendStatus } = require('../services/backend/local-engine-status');
  const recorded = [];
  const service = createService(async () => ({}));
  service.modelLoadDurationStore = {
    record: (entry) => recorded.push(entry),
    get: ({ engine, modelId }) => (engine === 'ollama' && modelId === 'ornith:9b' ? { lastMs: 48_250 } : null),
  };
  const startedAt = new Date(Date.now() - 48_250).toISOString();
  setModelLifecycle(service, {
    state: 'loading', requested_model: 'ornith:9b', engine: 'ollama', status: 'Loading model',
    percent: 40, completed_bytes: 0, total_bytes: 0, started_at: startedAt,
  }, { emit: false });
  setModelLifecycle(service, {
    state: 'ready', requested_model: 'ornith:9b', engine: 'ollama', status: 'Model ready', percent: 100,
  }, { emit: false });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].engine, 'ollama');
  assert.equal(recorded[0].modelId, 'ornith:9b');
  assert.ok(recorded[0].durationMs >= 48_000 && recorded[0].durationMs < 60_000, `duration ${recorded[0].durationMs}`);
  setModelLifecycle(service, { state: 'loading', requested_model: 'ornith:9b', engine: 'ollama', started_at: startedAt }, { emit: false });
  service._managedInitializeFlight = {}; // the next load is live
  assert.equal(buildObservedBackendStatus(service).model_acquisition.last_load_ms, 48_250);
});

// A-4: the popover shows the figure only while a model loads, so no other
// status build (every download tick, every ready poll) touches the store.
test('only a loading status reads the last load', () => {
  const { setModelLifecycle, buildObservedBackendStatus } = require('../services/backend/local-engine-status');
  const service = createService(async () => ({}));
  let reads = 0;
  service.modelLoadDurationStore = { record() {}, get: () => { reads += 1; return { lastMs: 9_000 }; } };
  for (const state of ['acquiring', 'ready', 'unavailable', 'unloaded']) {
    setModelLifecycle(service, { state, requested_model: 'm', engine: 'ollama', total_bytes: 0 }, { emit: false });
    assert.equal(buildObservedBackendStatus(service).model_acquisition.last_load_ms, null, state);
  }
  assert.equal(reads, 0);
  setModelLifecycle(service, { state: 'loading', requested_model: 'm', engine: 'ollama' }, { emit: false });
  service._managedInitializeFlight = {}; // a live load
  assert.equal(buildObservedBackendStatus(service).model_acquisition.last_load_ms, 9_000);
  assert.equal(reads, 1);
});

test('a flight that downloaded weights, a non-loading predecessor, or no store records nothing', () => {
  const { setModelLifecycle, buildObservedBackendStatus } = require('../services/backend/local-engine-status');
  const recorded = [];
  const service = createService(async () => ({}));
  service.modelLoadDurationStore = { record: (entry) => recorded.push(entry), get: () => null };
  const startedAt = new Date(Date.now() - 5_000).toISOString();

  // Download happened in this flight: total_bytes was observed while acquiring.
  setModelLifecycle(service, { state: 'acquiring', requested_model: 'm', engine: 'ollama', total_bytes: 900, completed_bytes: 900, started_at: startedAt }, { emit: false });
  setModelLifecycle(service, { state: 'loading', requested_model: 'm', engine: 'ollama' }, { emit: false });
  setModelLifecycle(service, { state: 'ready', requested_model: 'm', engine: 'ollama' }, { emit: false });
  assert.deepEqual(recorded, []);

  // Ready without a loading phase (runtime already had the model).
  setModelLifecycle(service, { state: 'unloaded', requested_model: 'm', engine: 'ollama', total_bytes: 0, started_at: startedAt }, { emit: false });
  setModelLifecycle(service, { state: 'ready', requested_model: 'm', engine: 'ollama' }, { emit: false });
  assert.deepEqual(recorded, []);
  assert.equal(buildObservedBackendStatus(service).model_acquisition.last_load_ms, null);

  // No store injected: the seam stays silent.
  const bare = createService(async () => ({}));
  setModelLifecycle(bare, { state: 'loading', requested_model: 'm', engine: 'ollama', started_at: startedAt }, { emit: false });
  assert.doesNotThrow(() => setModelLifecycle(bare, { state: 'ready', requested_model: 'm', engine: 'ollama' }, { emit: false }));
  assert.equal(buildObservedBackendStatus(bare).model_acquisition.last_load_ms, null);
});

// E2 (real-app pass 2026-09-29): a managed llama-server cold load showed
// "Starting engine" with no clock and never wrote the last-load record.
const { AI_ERROR_CODES } = require('../services/backend/error-codes');
const {
  buildObservedBackendStatus: observedStatus,
  observeManagedLlamaServerState,
  setModelLifecycle: writeLifecycle,
} = require('../services/backend/local-engine-status');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const FLIGHT_BOUNDS = { inactivityTimeoutMs: 1_000, absoluteTimeoutMs: 2_000 };

function loadClockService() {
  const service = createService(null);
  service.currentEngineType = 'openai-compatible';
  service.defaultModel = '';
  const recorded = [];
  service.modelLoadDurationStore = {
    record: (entry) => recorded.push(entry),
    get: ({ engine, modelId }) => (
      engine === 'openai-compatible' && modelId === 'gemma4:12b' ? { lastMs: 9_500 } : null
    ),
  };
  return { service, recorded };
}

function readyPayload(model) {
  return {
    active_engine: 'openai-compatible',
    active_model: model,
    local_runtime: { engine: { type: 'openai-compatible' }, model: { id: model, loaded: true } },
  };
}

function captureInitLifecycle(service, model) {
  const seen = {};
  service.sidecarClient.initialize = async () => {
    Object.assign(seen, service._modelLifecycle);
    return readyPayload(model);
  };
  return seen;
}

function initOpenAICompatible(service, requestedModel, extra = {}) {
  return initializeManagedSidecarWithTimeout(service, {
    requestedModel, requestedEngineType: 'openai-compatible', ...FLIGHT_BOUNDS, ...extra,
  });
}

test('a managed llama-server start reads as a model load with the manager clock and the last load', () => {
  const { service } = loadClockService();
  const changedAt = Date.now() - 4_000;
  observeManagedLlamaServerState(service, { state: 'starting', alias: 'gemma4:12b', changedAt, reused: false });

  const status = observedStatus(service);
  assert.equal(status.phase, 'model_loading');
  assert.equal(status.model_state, 'loading');
  assert.equal(status.model_lifecycle.engine, 'openai-compatible');
  assert.equal(status.model_acquisition.requested_model, 'gemma4:12b');
  assert.equal(status.model_acquisition.started_at, new Date(changedAt).toISOString());
  assert.equal(status.model_acquisition.last_load_ms, 9_500);
});

test('the sidecar init after a managed start keeps the load clock and records the load on ready', async () => {
  const { service, recorded } = loadClockService();
  const changedAt = Date.now() - 6_000;
  observeManagedLlamaServerState(service, { state: 'starting', alias: 'gemma4:12b', changedAt, reused: false });
  observeManagedLlamaServerState(service, { state: 'ready', alias: 'gemma4:12b', changedAt: Date.now(), reused: false });
  const seen = captureInitLifecycle(service, 'gemma4:12b');

  await initOpenAICompatible(service, 'gemma4:12b');

  assert.equal(seen.state, 'loading');
  assert.equal(seen.started_at, new Date(changedAt).toISOString());
  assert.equal(service._modelLifecycle.state, 'ready');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].engine, 'openai-compatible');
  assert.equal(recorded[0].modelId, 'gemma4:12b');
  assert.ok(recorded[0].durationMs >= 6_000 && recorded[0].durationMs < 30_000, `duration ${recorded[0].durationMs}`);
});

test('another model, a retry after an aborted init, or a load the manager did not start resets as today', async () => {
  const staleStart = Date.now() - 60_000;
  const staleIso = new Date(staleStart).toISOString();

  const other = loadClockService();
  observeManagedLlamaServerState(other.service, { state: 'starting', alias: 'gemma4:12b', changedAt: staleStart });
  const otherSeen = captureInitLifecycle(other.service, 'ornith:9b');
  await initOpenAICompatible(other.service, 'ornith:9b');
  assert.equal(otherSeen.state, 'unloaded');
  assert.notEqual(otherSeen.started_at, staleIso);
  assert.deepEqual(other.recorded, []);

  const retried = loadClockService();
  observeManagedLlamaServerState(retried.service, { state: 'starting', alias: 'gemma4:12b', changedAt: staleStart });
  const controller = new AbortController();
  retried.service.sidecarClient.initialize = () => new Promise(() => {});
  const aborted = initOpenAICompatible(retried.service, 'gemma4:12b', { signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(aborted);
  const retriedSeen = captureInitLifecycle(retried.service, 'gemma4:12b');
  await initOpenAICompatible(retried.service, 'gemma4:12b');
  assert.equal(retriedSeen.state, 'unloaded');
  assert.notEqual(retriedSeen.started_at, staleIso);
  assert.deepEqual(retried.recorded, []);

  const unowned = loadClockService();
  writeLifecycle(unowned.service, {
    state: 'loading', requested_model: 'gemma4:12b', engine: 'openai-compatible', started_at: staleIso,
  }, { emit: false });
  const unownedSeen = captureInitLifecycle(unowned.service, 'gemma4:12b');
  await initOpenAICompatible(unowned.service, 'gemma4:12b');
  assert.equal(unownedSeen.state, 'unloaded');
  assert.deepEqual(unowned.recorded, []);
});

test('a GPU handoff identity restore publishes ready itself, since no sidecar init follows it', () => {
  const { service, recorded } = loadClockService();
  writeLifecycle(service, {
    state: 'ready', requested_model: 'gemma4:12b', engine: 'openai-compatible', status: 'Model ready', percent: 100,
  }, { emit: false });
  const phases = [];
  service.on('backend-status', (status) => phases.push(status.phase));

  observeManagedLlamaServerState(service, { state: 'starting', alias: 'gemma4:12b', changedAt: Date.now() - 9_000 });
  observeManagedLlamaServerState(service, {
    state: 'ready', alias: 'gemma4:12b', changedAt: Date.now(), reused: false, identityReused: true,
  });

  assert.deepEqual(phases, ['model_loading', 'ready']);
  assert.equal(service._modelLifecycle.state, 'ready');
  assert.equal(service._managedEngineLoad, null);
  assert.notEqual(observedStatus(service).model_state, 'loading');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].modelId, 'gemma4:12b');
});

test('a managed start that fails, crashes, or reuses a running server drops its load clock', () => {
  for (const terminal of [
    { state: 'stopped', lastError: 'spawn_failed' },
    { state: 'crashed' },
    { state: 'ready', reused: true },
  ]) {
    const { service } = loadClockService();
    observeManagedLlamaServerState(service, { state: 'starting', alias: 'gemma4:12b', changedAt: Date.now() - 1_000 });
    observeManagedLlamaServerState(service, { alias: 'gemma4:12b', changedAt: Date.now(), ...terminal });
    assert.equal(service._modelLifecycle.state, 'unloaded', terminal.state);
    assert.notEqual(observedStatus(service).model_state, 'loading', terminal.state);
  }
});

test('entering a load stamps its own start instead of inheriting the init start', async () => {
  let emitProgress;
  let finish;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const service = createService((_payload, { onProgress }) => new Promise((resolve) => {
    emitProgress = onProgress;
    finish = () => resolve({
      active_engine: 'ollama',
      active_model: 'ornith:9b',
      local_runtime: { engine: { type: 'ollama' }, model: { id: 'ornith:9b', loaded: true } },
    });
    started();
  }));
  const flight = initializeManagedSidecarWithTimeout(service, { requestedModel: 'ornith:9b', ...FLIGHT_BOUNDS });
  await startedPromise;
  service._modelLifecycle.started_at = new Date(Date.now() - 60_000).toISOString();
  const before = Date.now();

  emitProgress({ method: 'runtime.progress', params: { state: 'model_loading', status: 'loading', percent: 10 } });

  const loadStartedAt = service._modelLifecycle.started_at;
  finish();
  await flight;
  assert.ok(Date.parse(loadStartedAt) >= before, loadStartedAt);
});

test('a no-model openai-compatible init that fell back reads unavailable; Ollama is unchanged', async () => {
  const fallbackPayload = (engine) => async () => ({
    active_engine: 'mock',
    active_model: 'mock-v1',
    engine_fallback: { requested_engine: engine, reason: 'engine failed to initialize: EngineConnectionError' },
  });
  // The persisted default is an Ollama tag, so the openai-compatible boot
  // requests no model (resolveManagedStartupModel).
  const deadPort = createService(fallbackPayload('openai-compatible'));
  deadPort.currentEngineType = 'openai-compatible';
  await assert.rejects(
    initializeManagedSidecarWithTimeout(deadPort, { requestedEngineType: 'openai-compatible', ...FLIGHT_BOUNDS }),
    (error) => error.error_code === AI_ERROR_CODES.ENGINE_CONNECTION
  );
  assert.equal(deadPort._modelLifecycle.state, 'unavailable');
  assert.equal(observedStatus(deadPort).phase, 'model_unavailable');

  const ollama = createService(fallbackPayload('ollama'));
  ollama.defaultModel = '';
  await initializeManagedSidecarWithTimeout(ollama, { requestedEngineType: 'ollama', ...FLIGHT_BOUNDS });
  assert.equal(ollama._modelLifecycle.state, 'unloaded');
});
