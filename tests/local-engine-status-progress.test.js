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
    _normalizeManagedReasoningEfforts() {},
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
