const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  initializeManagedSidecarWithTimeout,
} = require('../../services/backend/local-engine-status');

// H3b: the ChatGPT auth-preparation phase used to run BEFORE the flight's abort
// race was constructed, so a stalled getAccessToken sat outside every watchdog
// and pinned _managedInitializeFlight (and its dedupe joiners) forever.
// These live in their own file so managed-model-acquisition.test.js stays under
// the 600-line test ratchet.

function createService(initialize) {
  const service = new EventEmitter();
  const sidecarProcess = {};
  Object.assign(service, {
    appVersion: '0.1.0',
    currentEngineType: 'chatgpt',
    currentModel: '',
    defaultModel: '',
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

function chatgptPayload() {
  return {
    active_engine: 'chatgpt',
    active_model: '',
    active_model_capabilities: { text: true },
    local_runtime: { engine: { type: 'chatgpt' }, model: { id: '', loaded: false } },
  };
}

test('a stalled chatgpt token refresh settles at the inactivity deadline and releases the flight', async () => {
  let initializeCalls = 0;
  let stall = true;
  const service = createService(async () => {
    initializeCalls += 1;
    return chatgptPayload();
  });
  service.chatgptAuthService = {
    getAccessToken: () => (stall ? new Promise(() => {}) : Promise.resolve('fresh-token')),
    getCachedAccessToken: () => '',
    getAccountId: () => '',
    getCredentialEpoch: () => 7,
  };

  await assert.rejects(
    initializeManagedSidecarWithTimeout(service, {
      requestedEngineType: 'chatgpt',
      inactivityTimeoutMs: 20,
      absoluteTimeoutMs: 400,
    }),
    (error) => error.error_code === 'CMP-SIDECAR-0001'
  );

  assert.equal(initializeCalls, 0, 'the initialize RPC is never sent for a stalled auth phase');
  assert.equal(service._managedInitializeFlight, null, 'the flight must not latch');

  // The retry reaches initialize, proving the failure released the flight.
  stall = false;
  await initializeManagedSidecarWithTimeout(service, {
    requestedEngineType: 'chatgpt',
    absoluteTimeoutMs: 400,
  });
  assert.equal(initializeCalls, 1);
  assert.equal(
    service._chatgptRuntimeCredentialEpoch,
    7,
    'a successful init records the credential generation the sidecar received'
  );
});

test('a stalled auth phase rejects dedupe joiners together while a conflicting model stays busy', async () => {
  const service = createService(async () => chatgptPayload());
  service.chatgptAuthService = {
    getAccessToken: () => new Promise(() => {}),
    getCachedAccessToken: () => '',
    getAccountId: () => '',
    getCredentialEpoch: () => 1,
  };

  const first = initializeManagedSidecarWithTimeout(service, {
    requestedEngineType: 'chatgpt',
    inactivityTimeoutMs: 30,
    absoluteTimeoutMs: 400,
  });
  const joined = initializeManagedSidecarWithTimeout(service, {
    requestedEngineType: 'chatgpt',
    inactivityTimeoutMs: 30,
    absoluteTimeoutMs: 400,
  });
  await assert.rejects(
    initializeManagedSidecarWithTimeout(service, {
      requestedEngineType: 'chatgpt',
      requestedModel: 'different:1b',
      absoluteTimeoutMs: 400,
    }),
    (error) => error.category === 'model_busy' && error.retryable === true
  );

  const settled = await Promise.allSettled([first, joined]);

  assert.deepEqual(settled.map((entry) => entry.status), ['rejected', 'rejected']);
  assert.equal(settled[0].reason.error_code, 'CMP-SIDECAR-0001');
  assert.equal(settled[1].reason, settled[0].reason, 'the joiner shares the flight failure');
  assert.equal(service._managedInitializeFlight, null);
});

test('an explicit cancel during the auth phase fails the flight instead of proceeding tokenless', async () => {
  let initializeCalls = 0;
  const service = createService(async () => {
    initializeCalls += 1;
    return chatgptPayload();
  });
  const external = new AbortController();
  service.chatgptAuthService = {
    getAccessToken: () => new Promise(() => {}),
    getCachedAccessToken: () => '',
    getAccountId: () => '',
    getCredentialEpoch: () => 3,
  };

  const flight = initializeManagedSidecarWithTimeout(service, {
    requestedEngineType: 'chatgpt',
    signal: external.signal,
    absoluteTimeoutMs: 2000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  external.abort('user cancelled');

  await assert.rejects(flight, (error) => error.error_code === 'CMP-SIDECAR-0002');
  assert.equal(initializeCalls, 0);
  assert.equal(service._chatgptRuntimeCredentialEpoch, undefined);
});
