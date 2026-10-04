const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  initializeManagedSidecarWithTimeout,
} = require('../services/backend/local-engine-status');
const {
  ensureManagedSidecarReadyForChat,
} = require('../services/backend/managed-sidecar-chat-reconnect');

// ELC-05: an initialization deadline ends Electron's wait, but the sidecar may
// still be blocked inside its inline initialize handler. The flight marks that
// process as stalled so the chat preflight replaces it instead of sending the
// next chat into a wedged process.

function createService(initialize) {
  const service = new EventEmitter();
  const processGeneration = {};
  const logs = [];
  return Object.assign(service, {
    logs,
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
    _modelLifecycle: { state: 'unloaded' },
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
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

function okPayload() {
  return {
    active_engine: 'ollama',
    active_model: 'ornith:9b',
    active_model_capabilities: { text: true },
    local_runtime: {
      engine: { type: 'ollama' },
      model: { id: 'ornith:9b', loaded: true },
    },
  };
}

const NEVER = () => new Promise(() => {});
const stallLogs = (service) => service.logs.filter(
  (entry) => entry.event === 'backend.managed_sidecar_initialize_stalled'
);

test('an inactivity deadline marks the unanswered process stalled and logs it', async () => {
  const service = createService(NEVER);
  const processGeneration = service.sidecarManager.process;
  await assert.rejects(
    initializeManagedSidecarWithTimeout(service, {
      requestedModel: 'ornith:9b', inactivityTimeoutMs: 20, absoluteTimeoutMs: 5_000,
    }),
    (error) => error.error_code === 'CMP-SIDECAR-0001'
  );
  assert.equal(service._managedInitializeStalledProcess, processGeneration);
  const logs = stallLogs(service);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'WARN');
  assert.deepEqual(logs[0].details, {
    requestedModel: 'ornith:9b',
    message: 'Managed sidecar initialization inactivity timed out after 20ms.',
  });
});

test('an absolute deadline marks the unanswered process stalled and logs it', async () => {
  const service = createService(NEVER);
  const processGeneration = service.sidecarManager.process;
  await assert.rejects(
    initializeManagedSidecarWithTimeout(service, {
      requestedModel: 'ornith:9b', inactivityTimeoutMs: 5_000, absoluteTimeoutMs: 20,
    }),
    (error) => error.error_code === 'CMP-SIDECAR-0001'
  );
  assert.equal(service._managedInitializeStalledProcess, processGeneration);
  assert.deepEqual(stallLogs(service)[0].details, {
    requestedModel: 'ornith:9b',
    message: 'Managed sidecar initialization absolute ceiling timed out after 20ms.',
  });
});

test('an external abort does not mark the process stalled', async () => {
  const service = createService(NEVER);
  const controller = new AbortController();
  const flight = initializeManagedSidecarWithTimeout(service, {
    requestedModel: 'ornith:9b',
    inactivityTimeoutMs: 5_000,
    absoluteTimeoutMs: 5_000,
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('user cancelled'));
  await assert.rejects(flight);
  assert.equal(service._managedInitializeStalledProcess ?? null, null);
  assert.equal(stallLogs(service).length, 0);
});

test('a flight whose process was replaced before the deadline does not mark anything', async () => {
  const service = createService(NEVER);
  const flight = initializeManagedSidecarWithTimeout(service, {
    requestedModel: 'ornith:9b', inactivityTimeoutMs: 40, absoluteTimeoutMs: 5_000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  service.sidecarManager.process = {};
  await assert.rejects(flight, (error) => error.error_code === 'CMP-SIDECAR-0001');
  assert.equal(service._managedInitializeStalledProcess ?? null, null);
  assert.equal(stallLogs(service).length, 0);
});

test('a non-deadline initialize failure does not mark the process stalled', async () => {
  const service = createService(async () => { throw new Error('engine refused'); });
  await assert.rejects(
    initializeManagedSidecarWithTimeout(service, {
      requestedModel: 'ornith:9b', inactivityTimeoutMs: 5_000, absoluteTimeoutMs: 5_000,
    }),
    /engine refused/
  );
  assert.equal(service._managedInitializeStalledProcess ?? null, null);
  assert.equal(stallLogs(service).length, 0);
});

test('a deadline before the initialize request was handed over does not mark the process', async () => {
  const service = createService(async () => okPayload());
  service.currentEngineType = 'chatgpt';
  service.chatgptAuthService = {
    getAccessToken: NEVER,
    getCachedAccessToken: () => '',
    getAccountId: () => '',
    getCredentialEpoch: () => 1,
  };
  await assert.rejects(
    initializeManagedSidecarWithTimeout(service, {
      requestedEngineType: 'chatgpt', inactivityTimeoutMs: 20, absoluteTimeoutMs: 5_000,
    }),
    (error) => error.error_code === 'CMP-SIDECAR-0001'
  );
  assert.equal(service._managedInitializeStalledProcess ?? null, null);
});

test('a later successful initialize on the same process clears the stalled marker', async () => {
  let answer = false;
  const service = createService(() => (answer ? Promise.resolve(okPayload()) : NEVER()));
  const processGeneration = service.sidecarManager.process;
  await assert.rejects(initializeManagedSidecarWithTimeout(service, {
    requestedModel: 'ornith:9b', inactivityTimeoutMs: 20, absoluteTimeoutMs: 5_000,
  }));
  assert.equal(service._managedInitializeStalledProcess, processGeneration);

  answer = true;
  await initializeManagedSidecarWithTimeout(service, {
    requestedModel: 'ornith:9b', inactivityTimeoutMs: 5_000, absoluteTimeoutMs: 5_000,
  });
  assert.equal(service._managedInitializeStalledProcess, null);
  assert.equal(service._managedInitializedProcess, processGeneration);
});

test('the chat preflight replaces only the stalled process', async () => {
  const service = createService(NEVER);
  const stalled = service.sidecarManager.process;
  const restarts = [];
  service._restartManagedSidecar = async (reason) => {
    restarts.push(reason);
    service.sidecarManager.process = {};
    return true;
  };
  const ids = { sessionId: 's', streamId: 'st', traceId: 't' };

  // Healthy process, no marker: nothing to do.
  assert.equal(await ensureManagedSidecarReadyForChat(service, ids), false);
  assert.deepEqual(restarts, []);

  // A marker for another (already replaced) process has no effect.
  service._managedInitializeStalledProcess = {};
  assert.equal(await ensureManagedSidecarReadyForChat(service, ids), false);
  assert.deepEqual(restarts, []);

  // The marker names the live process, but another conversation is still
  // streaming from it: the restart waits rather than cutting that response off.
  service._managedInitializeStalledProcess = stalled;
  service.sidecarManager.process = stalled;
  service.activeStreams = new Map([['st', {}], ['other-stream', {}]]);
  assert.equal(await ensureManagedSidecarReadyForChat(service, ids), false);
  assert.deepEqual(restarts, []);

  // Only this send's own stream is active: the preflight restarts it once.
  service.activeStreams = new Map([['st', {}]]);
  assert.equal(await ensureManagedSidecarReadyForChat(service, ids), true);
  assert.deepEqual(restarts, ['chat.preflight_reconnect']);

  // The replacement process is not the stalled one, so the next send is clean.
  assert.equal(await ensureManagedSidecarReadyForChat(service, ids), false);
  assert.deepEqual(restarts, ['chat.preflight_reconnect']);
});
