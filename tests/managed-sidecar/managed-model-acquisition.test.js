const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { BackendService } = require('../../services/backend/backend-service');
const { resolveModel } = require('../../services/backend/backend-chat-model-resolution');
const { loadModel } = require('../../services/backend/backend-runtime');
const {
  abortManagedSidecarInitialization,
  initializeManagedSidecarWithTimeout,
  DEFAULT_INACTIVITY_TIMEOUT_MS,
} = require('../../services/backend/local-engine-status');
const { createFakeSafeStorage } = require('../helpers/fake-safe-storage');
const { driveProgressTicks } = require('../helpers/mock-timer-progress');
const PROGRESS_INTERVAL_MS = 12;

function createService(initialize) {
  const service = new EventEmitter();
  const sidecarProcess = {};
  Object.assign(service, {
    appVersion: '0.1.0',
    currentEngineType: 'ollama',
    currentModel: '',
    defaultModel: 'ornith:9b',
    featureFlags: {},
    options: { userDataPath: process.cwd() },
    _disposed: false,
    _stopping: false,
    _managedInitializeFlight: null,
    _managedInitializeGeneration: 0,
    _managedPendingModel: '',
    _lastEngineFallback: null,
    _modelLifecycle: { state: 'unloaded' },
    _emitServiceLog() {},
    _normalizeManagedReasoningEfforts() {},
    sidecarManager: {
      process: sidecarProcess,
      getStatus() { return { phase: 'ready', pid: 42 }; },
    },
    sidecarClient: {
      process: sidecarProcess,
      connected: true,
      attachProcess(next) { this.process = next; this.connected = true; },
      initialize,
    },
  });
  return service;
}

function successPayload(model = 'ornith:9b') {
  return {
    active_engine: 'ollama',
    active_model: model,
    active_model_capabilities: { text: true },
    local_runtime: {
      engine: { type: 'ollama' },
      model: { id: model, loaded: true },
    },
  };
}


test('chatgpt initialization refreshes auth before managed secrets are built', async () => {
  let cachedToken = '';
  const events = [];
  const service = createService(async (payload) => {
    events.push('initialize');
    assert.equal(payload.secrets.chatgpt_access_token, 'fresh-access-token');
    return {
      ...successPayload(''),
      active_engine: 'chatgpt',
      local_runtime: { engine: { type: 'chatgpt' }, model: { id: '', loaded: false } },
    };
  });
  service.currentEngineType = 'chatgpt';
  service.defaultModel = '';
  service.chatgptAuthService = {
    async getAccessToken() {
      events.push('refresh');
      cachedToken = 'fresh-access-token';
    },
    getCachedAccessToken: () => cachedToken,
    getAccountId: () => 'acct_123',
  };

  await initializeManagedSidecarWithTimeout(service, { requestedEngineType: 'chatgpt' });

  assert.deepEqual(events, ['refresh', 'initialize']);
});

test('a rejected chatgpt refresh logs WARN and does not fail initialization', async () => {
  const logs = [];
  const service = createService(async () => ({
    ...successPayload(''),
    active_engine: 'chatgpt',
    local_runtime: { engine: { type: 'chatgpt' }, model: { id: '', loaded: false } },
  }));
  service.currentEngineType = 'chatgpt';
  service.defaultModel = '';
  service.chatgptAuthService = {
    getAccessToken: async () => { throw new TypeError('secret provider detail'); },
    getCachedAccessToken: () => '',
    getAccountId: () => '',
  };
  service._emitServiceLog = (level, event, details) => logs.push({ level, event, details });

  await initializeManagedSidecarWithTimeout(service, { requestedEngineType: 'chatgpt' });

  assert.deepEqual(logs, [{
    level: 'WARN',
    event: 'chatgpt_auth.refresh_at_init_failed',
    details: { errorName: 'TypeError' },
  }]);
});

test('shutdown aborts initialization and skips RPCs queued behind it', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-stop-initialize-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const service = new BackendService({
    userDataPath,
    backendUrl: 'http://127.0.0.1:1',
    safeStorage: createFakeSafeStorage(),
  });
  const calls = { unload: 0, shutdown: 0, stop: 0, dispose: 0 };
  const controller = new AbortController();
  service._managedInitializeFlight = {
    controller,
    generation: 1,
    process: {},
    requestedModel: 'ornith:9b',
    promise: new Promise(() => {}),
  };
  service.unloadModel = async () => { calls.unload += 1; };
  service.sidecarClient = {
    async shutdown() { calls.shutdown += 1; },
    dispose() { calls.dispose += 1; },
  };
  service.sidecarManager.stop = async () => { calls.stop += 1; };

  await service.stop();

  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason.error_code, 'CMP-SIDECAR-0002');
  assert.deepEqual(calls, { unload: 0, shutdown: 0, stop: 1, dispose: 1 });
});

test('default inactivity budget is verify-sized (survives a silent sha256 verify gap)', () => {
  // First-run callers (backend-runtime, local-engine-lifecycle) do not pass
  // inactivityTimeoutMs, so this default is what guards a real acquisition.
  // It must out-wait Ollama's silent verify phase (tens of seconds), not the
  // old 15s that aborted first-run multi-GB downloads mid-verify.
  assert.equal(DEFAULT_INACTIVITY_TIMEOUT_MS, 300_000);
  assert.ok(DEFAULT_INACTIVITY_TIMEOUT_MS >= 60_000);
});

test('default watchdog tolerates a >15s silent gap after one verify progress event', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let emitProgress = null;
  let finish = null;
  let started = null;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const service = createService((_payload, { signal, onProgress }) => new Promise((resolve, reject) => {
    emitProgress = onProgress;
    finish = () => resolve(successPayload());
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    started();
  }));

  // No inactivityTimeoutMs override -> exercises DEFAULT_INACTIVITY_TIMEOUT_MS.
  const flight = initializeManagedSidecarWithTimeout(service, { requestedModel: 'ornith:9b' });
  await startedPromise;

  // One "verifying sha256 digest" progress event, then silence.
  emitProgress({
    method: 'runtime.progress',
    params: {
      state: 'model_acquiring',
      engine: 'ollama',
      model: 'ornith:9b',
      status: 'verifying sha256 digest',
      percent: 50,
      completed_bytes: 1,
      total_bytes: 2,
    },
  });

  // Advance virtual time past the OLD 15s budget but under the new 300s default.
  t.mock.timers.tick(200_000);
  assert.equal(service._managedInitializeFlight?.controller.signal.aborted ?? false, false);

  finish();
  const result = await flight;
  assert.equal(result.active_model, 'ornith:9b');
  assert.equal(service._modelLifecycle.state, 'ready');
});

test('progressing acquisition may exceed the inactivity timeout and remains monotonic', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const observed = [];
  const service = createService((_payload, { signal, onProgress }) => new Promise((resolve, reject) => {
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      onProgress({
        method: 'runtime.progress',
        params: {
          state: tick < 4 ? 'model_acquiring' : 'model_loading',
          engine: 'ollama',
          model: 'ornith:9b',
          status: tick < 4 ? 'downloading' : 'loading',
          percent: Math.min(tick * 20, 100),
          completed_bytes: tick * 100,
          total_bytes: 500,
        },
      });
      if (tick === 5) {
        clearInterval(timer);
        resolve(successPayload());
      }
    }, PROGRESS_INTERVAL_MS);
    signal.addEventListener('abort', () => {
      clearInterval(timer);
      reject(signal.reason);
    }, { once: true });
  }));
  service.on('backend-status', (status) => observed.push(status.model_acquisition?.percent || 0));

  const flight = initializeManagedSidecarWithTimeout(service, {
    requestedModel: 'ornith:9b',
    inactivityTimeoutMs: 30,
    absoluteTimeoutMs: 300,
  });
  await driveProgressTicks(t, PROGRESS_INTERVAL_MS);
  const result = await flight;
  assert.equal(result.active_model, 'ornith:9b');
  assert.equal(service._modelLifecycle.state, 'ready');
  assert.deepEqual(observed, [...observed].sort((a, b) => a - b));
});

test('status-only acquisition progress extends the inactivity window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const service = createService((_payload, { signal, onProgress }) => new Promise((resolve, reject) => {
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      onProgress({ method: 'runtime.progress', params: {
        state: 'model_acquiring',
        engine: 'ollama',
        model: 'ornith:9b',
        status: `acquisition stage ${tick}`,
        percent: 0,
        completed_bytes: 0,
        total_bytes: 0,
      } });
      if (tick === 5) {
        clearInterval(timer);
        resolve(successPayload());
      }
    }, PROGRESS_INTERVAL_MS);
    signal.addEventListener('abort', () => {
      clearInterval(timer);
      reject(signal.reason);
    }, { once: true });
  }));

  const flight = initializeManagedSidecarWithTimeout(service, {
    requestedModel: 'ornith:9b',
    inactivityTimeoutMs: 30,
    absoluteTimeoutMs: 300,
  });
  await driveProgressTicks(t, PROGRESS_INTERVAL_MS);
  const result = await flight;

  assert.equal(result.active_model, 'ornith:9b');
  assert.equal(service._modelLifecycle.state, 'ready');
});

test('idle and absolute watchdogs retain CMP-SIDECAR-0001', async () => {
  const idleService = createService((_payload, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(
    initializeManagedSidecarWithTimeout(idleService, {
      inactivityTimeoutMs: 5,
      absoluteTimeoutMs: 100,
    }),
    (error) => error.error_code === 'CMP-SIDECAR-0001'
  );

  const absoluteService = createService((_payload, { signal, onProgress }) => new Promise((_, reject) => {
    let completed = 0;
    const timer = setInterval(() => {
      completed += 1;
      onProgress({ method: 'runtime.progress', params: {
        state: 'model_acquiring', percent: completed, completed_bytes: completed,
      } });
    }, 3);
    signal.addEventListener('abort', () => {
      clearInterval(timer);
      reject(signal.reason);
    }, { once: true });
  }));
  await assert.rejects(
    initializeManagedSidecarWithTimeout(absoluteService, {
      inactivityTimeoutMs: 10,
      absoluteTimeoutMs: 25,
    }),
    (error) => error.error_code === 'CMP-SIDECAR-0001' && /absolute ceiling/i.test(error.message)
  );
});

test('matching callers join one flight while a conflicting model is retryably busy', async () => {
  let initializeCalls = 0;
  let resolveInitialize;
  const service = createService(() => {
    initializeCalls += 1;
    return new Promise((resolve) => { resolveInitialize = resolve; });
  });
  const first = initializeManagedSidecarWithTimeout(service, { absoluteTimeoutMs: 200 });
  const joined = initializeManagedSidecarWithTimeout(service, { absoluteTimeoutMs: 200 });
  await assert.rejects(
    initializeManagedSidecarWithTimeout(service, {
      requestedModel: 'different:1b',
      absoluteTimeoutMs: 200,
    }),
    (error) => error.error_code === 'CMP-AI-0002' && error.retryable === true
  );
  resolveInitialize(successPayload());
  const [a, b] = await Promise.all([first, joined]);
  assert.equal(a.active_model, b.active_model);
  assert.equal(initializeCalls, 1);
});

test('same-model callers targeting different engines do not join one initialization flight', async () => {
  let initializeCalls = 0;
  let resolveInitialize;
  const service = createService(() => {
    initializeCalls += 1;
    return new Promise((resolve) => { resolveInitialize = resolve; });
  });
  const first = initializeManagedSidecarWithTimeout(service, {
    requestedModel: 'ornith:9b',
    requestedEngineType: 'ollama',
    absoluteTimeoutMs: 200,
  });

  await assert.rejects(
    initializeManagedSidecarWithTimeout(service, {
      requestedModel: 'ornith:9b',
      requestedEngineType: 'vllm',
      absoluteTimeoutMs: 200,
    }),
    (error) => error.category === 'model_busy' && error.retryable === true
  );

  resolveInitialize(successPayload());
  await first;
  assert.equal(initializeCalls, 1);
  assert.equal(service.currentEngineType, 'ollama');
});

test('conflicting loadModel rejection does not mutate the admitted flight identity', async () => {
  let resolveInitialize;
  const service = createService(() => new Promise((resolve) => { resolveInitialize = resolve; }));
  service._initializeManagedSidecar = (options) => initializeManagedSidecarWithTimeout(service, {
    ...options,
    absoluteTimeoutMs: 200,
  });
  service.refreshStatusSnapshot = async () => service.currentStatus;

  const admitted = loadModel(service, 'ornith:9b');
  await Promise.resolve();
  await assert.rejects(
    loadModel(service, 'Qwen/Qwen3.5-9B'),
    (error) => error.category === 'model_busy' && error.retryable === true
  );
  assert.equal(service._managedPendingModel, 'ornith:9b');
  assert.equal(service.currentEngineType, 'ollama');

  resolveInitialize(successPayload());
  await admitted;
  assert.equal(service.currentModel, 'ornith:9b');
  assert.equal(service._modelLifecycle.state, 'ready');
});

test('unavailable lifecycle retries the preferred model instead of blocking chat', async () => {
  // A latched 'unavailable' (engine was down, model missing) must not force a
  // manual load: the next chat turn retries the load itself.
  const loadCalls = [];
  const service = {
    _modelLifecycle: { state: 'unavailable' },
    currentModel: '',
    _emitServiceLog() {},
    async loadModel(model) { loadCalls.push(model); },
  };

  const model = await resolveModel(service, 'ornith:9b');

  assert.equal(model, 'ornith:9b');
  assert.deepEqual(loadCalls, ['ornith:9b']);
});

test('preferred model resolution preserves verified engine provenance for ambiguous local ids', async () => {
  const loadCalls = [];
  const service = {
    _modelLifecycle: { state: 'unloaded' },
    currentModel: '',
    _emitServiceLog() {},
    async loadModel(model) { loadCalls.push(model); },
  };

  const model = await resolveModel(service, 'gpt-5:local', 'ollama');

  assert.equal(model, 'gpt-5:local');
  assert.deepEqual(loadCalls, [{ model: 'gpt-5:local', engine_type: 'ollama' }]);
});

test('unavailable lifecycle retries the configured default on the next chat turn', async () => {
  const loadCalls = [];
  const service = {
    currentEngineType: 'ollama',
    defaultModel: 'ornith:9b',
    _modelLifecycle: { state: 'unavailable' },
    currentModel: '',
    _emitServiceLog() {},
    async loadModel(model) { loadCalls.push(model); },
    async listModels() { throw new Error('should not probe models while unavailable'); },
  };

  const model = await resolveModel(service, '');

  assert.equal(model, 'ornith:9b');
  assert.deepEqual(loadCalls, ['ornith:9b']);
});

test('synchronous progress observers re-enter the already-published flight', async () => {
  let initializeCalls = 0;
  let reentrantPromise = null;
  const service = createService(async (_payload, { onProgress }) => {
    initializeCalls += 1;
    onProgress({ method: 'runtime.progress', params: {
      state: 'model_acquiring', percent: 1, completed_bytes: 1,
    } });
    return successPayload();
  });
  service.on('backend-status', (status) => {
    if (status.phase === 'model_acquiring' && reentrantPromise === null) {
      reentrantPromise = initializeManagedSidecarWithTimeout(service, { absoluteTimeoutMs: 200 });
    }
  });

  const first = initializeManagedSidecarWithTimeout(service, { absoluteTimeoutMs: 200 });
  await first;
  assert.ok(reentrantPromise);
  await reentrantPromise;

  assert.equal(initializeCalls, 1);
});

test('explicit cancellation and process replacement suppress late readiness', async () => {
  let settle;
  const service = createService((_payload, { signal }) => new Promise((resolve, reject) => {
    settle = resolve;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const cancelled = initializeManagedSidecarWithTimeout(service, { absoluteTimeoutMs: 200 });
  assert.equal(abortManagedSidecarInitialization(service, 'cancel test'), true);
  await assert.rejects(cancelled, (error) => error.error_code === 'CMP-SIDECAR-0002');

  const replacement = createService(() => new Promise((resolve) => { settle = resolve; }));
  const pending = initializeManagedSidecarWithTimeout(replacement, { absoluteTimeoutMs: 200 });
  await Promise.resolve();
  replacement.sidecarManager.process = {};
  settle(successPayload());
  await assert.rejects(pending, (error) => error.error_code === 'CMP-SIDECAR-0002');
  assert.equal(replacement.currentModel, '');
  assert.notEqual(replacement._modelLifecycle.state, 'ready');
});

test('acquisition fallback is unavailable until a later retry succeeds', async () => {
  const service = createService(async () => ({
    active_engine: 'mock',
    active_model: 'mock-v1',
    engine_fallback: {
      requested_engine: 'ollama',
      reason: 'pull failed',
    },
    local_runtime: {
      engine: { type: 'mock' },
      model: { id: 'mock-v1', loaded: true },
      fallback: { active: true, requested_engine: 'ollama', reason: 'pull failed' },
    },
  }));

  await assert.rejects(
    initializeManagedSidecarWithTimeout(service, { requestedModel: 'ornith:9b', absoluteTimeoutMs: 200 }),
    (error) => error.error_code === 'CMP-AI-0002'
  );
  assert.equal(service.currentModel, '');
  assert.equal(service._modelLifecycle.state, 'unavailable');
  assert.equal(service._modelLifecycle.requested_model, 'ornith:9b');

  service.sidecarClient.initialize = async () => successPayload();
  await initializeManagedSidecarWithTimeout(service, { requestedModel: 'ornith:9b', absoluteTimeoutMs: 200 });
  assert.equal(service.currentModel, 'ornith:9b');
  assert.equal(service._modelLifecycle.state, 'ready');
});

test('an aborted flight after load progress self-heals instead of latching Loading Model', async () => {
  // GUI finding 2026-07-20: aborting/superseding a flight AFTER progress had
  // advanced the lifecycle left model_state latched at loading/acquiring with
  // no corrective emission — the health pill read "LOADING MODEL" forever
  // while chat kept working off its separately cached phase.
  const service = createService((_payload, { signal, onProgress }) => new Promise((resolve, reject) => {
    onProgress({ method: 'runtime.progress', params: {
      state: 'model_loading', percent: 40, completed_bytes: 10,
    } });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const statuses = [];
  service.on('backend-status', (status) => statuses.push(status));

  const flight = initializeManagedSidecarWithTimeout(service, { absoluteTimeoutMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service._modelLifecycle.state, 'loading', 'progress advanced the stored lifecycle');

  assert.equal(abortManagedSidecarInitialization(service, 'user cancelled'), true);
  await assert.rejects(flight, (error) => error.error_code === 'CMP-SIDECAR-0002');

  assert.ok(statuses.length > 0, 'the flight teardown pushed a corrective backend-status');
  const last = statuses[statuses.length - 1];
  assert.ok(
    last.model_state !== 'loading' && last.model_state !== 'acquiring',
    `presented model_state must not stay mid-flight (got ${last.model_state})`
  );
  assert.ok(
    last.phase !== 'model_loading' && last.phase !== 'model_acquiring',
    `presented phase must not stay mid-flight (got ${last.phase})`
  );
});

test('healing an aborted model switch reports the runtime model, not the aborted request', async () => {
  // Aborting an A->B switch after load progress left
  // B in the stored request fields while A is what is actually loaded; the
  // healed presentation must report runtime truth.
  const service = createService((_payload, { signal, onProgress }) => new Promise((resolve, reject) => {
    onProgress({ method: 'runtime.progress', params: {
      state: 'model_loading', percent: 30, completed_bytes: 5,
    } });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  service.defaultModel = 'model-b';
  service.currentModel = 'model-a';
  service.currentStatus = { model_loaded: true, model: 'model-a', engine: 'ollama' };
  const statuses = [];
  service.on('backend-status', (status) => statuses.push(status));

  const flight = initializeManagedSidecarWithTimeout(service, { absoluteTimeoutMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service._modelLifecycle.state, 'loading');

  abortManagedSidecarInitialization(service, 'switch abandoned');
  await assert.rejects(flight, (error) => error.error_code === 'CMP-SIDECAR-0002');

  const last = statuses[statuses.length - 1];
  assert.equal(last.model_state, 'ready', 'runtime still has a loaded model');
  assert.equal(last.model_lifecycle.requested_model, 'model-a', 'presented model is the runtime one');
  assert.equal(last.phase, 'ready');
});

test('the corrective teardown emit is suppressed while the service is stopping', async () => {
  const service = createService((_payload, { signal, onProgress }) => new Promise((resolve, reject) => {
    onProgress({ method: 'runtime.progress', params: {
      state: 'model_loading', percent: 10, completed_bytes: 1,
    } });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const statuses = [];
  service.on('backend-status', (status) => statuses.push(status));

  const flight = initializeManagedSidecarWithTimeout(service, { absoluteTimeoutMs: 500 });
  await new Promise((resolve) => setImmediate(resolve));

  service._stopping = true;
  const emitsBeforeAbort = statuses.length;
  abortManagedSidecarInitialization(service, 'shutdown');
  await assert.rejects(flight, (error) => error.error_code === 'CMP-SIDECAR-0002');

  assert.equal(
    statuses.length,
    emitsBeforeAbort,
    'no healed status may overwrite the renderer during shutdown'
  );
});
