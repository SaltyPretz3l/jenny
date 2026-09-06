'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleSidecarStatus,
  retryStartBackendService,
  startBackendService,
  stopBackendService,
} = require('../services/backend/local-engine-lifecycle');
const { AI_ERROR_CODES, SIDECAR_ERROR_CODES } = require('../services/backend/error-codes');
const { buildObservedBackendStatus } = require('../services/backend/local-engine-status');
const { createLlamaServerManager } = require('../services/main/llama-server-manager');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeService({ engine = 'ollama' } = {}) {
  const calls = [];
  const emits = [];
  const logs = [];
  const sidecarStatus = { phase: 'ready', pid: 41, baseUrl: 'http://127.0.0.1:8765' };
  const service = {
    activeStreams: new Map(),
    calls,
    configService: {
      getLocalEngines() {
        calls.push('config:getLocalEngines');
        return { vllm: { port: 8077, extra: 'live' } };
      },
    },
    currentEngineType: engine,
    currentModel: '',
    currentStatus: null,
    defaultModel: '',
    emits,
    logs,
    ollamaManager: {
      async start() {
        calls.push('ollama:start');
        return { started: true };
      },
      async stop(options) {
        calls.push(['ollama:stop', options]);
      },
    },
    sidecarClient: {
      async shutdown() {
        calls.push('sidecarClient:shutdown');
      },
      endInput() {
        calls.push('sidecarClient:endInput');
      },
    },
    sidecarManager: {
      isStopping: false,
      getStatus() {
        return sidecarStatus;
      },
      async retryStart() {
        calls.push('sidecar:retryStart');
        return sidecarStatus;
      },
      async start() {
        calls.push('sidecar:start');
        return sidecarStatus;
      },
      async stop() {
        calls.push('sidecar:stop');
        return { exitConfirmed: true, forced: false };
      },
    },
    vllmManager: {
      configure(options) {
        calls.push(['vllm:configure', options]);
      },
      async start() {
        calls.push('vllm:start');
      },
      async stop() {
        calls.push('vllm:stop');
      },
    },
    _abortActiveStreams(reason) {
      calls.push(['streams:abort', reason]);
    },
    _autoLoadDefaultModel() {
      calls.push('model:autoLoad');
    },
    _clearPendingToolApprovals() {
      calls.push('approvals:clear');
    },
    _disposeSidecarClient() {
      calls.push('sidecarClient:dispose');
      this.sidecarClient = null;
    },
    emit(event, payload) {
      emits.push([event, payload]);
    },
    _emitServiceLog(level, event, details) {
      logs.push([level, event, details]);
    },
    async _initializeManagedSidecar() {
      calls.push('sidecar:initialize');
    },
    async _unloadManagedModelForShutdown() {
      calls.push('model:unload');
    },
    async refreshStatusSnapshot() {
      calls.push('status:refresh');
    },
    async restoreAuthState() {
      calls.push('auth:restore');
    },
    _schedulePendingSessionMigrations() {
      calls.push('migrations:schedule');
    },
  };
  return service;
}

test('startBackendService retries a sidecar spawn exactly once and announces retrying first', async () => {
  const service = makeService({ engine: 'replay' });
  service.sidecarManager.start = async () => {
    service.calls.push('sidecar:start');
    throw new Error('first spawn failed');
  };
  service.sidecarManager.retryStart = async () => {
    const retryStatus = service.emits.find((entry) => entry[1]?.phase === 'retrying');
    assert.ok(retryStatus, 'the retry status must be emitted before retryStart');
    service.calls.push('sidecar:retryStart');
    return service.sidecarManager.getStatus();
  };

  const status = await startBackendService(service, {});

  assert.equal(status.phase, 'ready');
  assert.deepEqual(
    service.calls.filter((entry) => entry === 'sidecar:start' || entry === 'sidecar:retryStart'),
    ['sidecar:start', 'sidecar:retryStart']
  );
});

test('handleSidecarStatus coalesces concurrent post-ready reconnect notifications', async () => {
  const gate = deferred();
  const service = makeService({ engine: 'replay' });
  service._managedReadyOnce = true;
  service.sidecarManager.retryStart = async () => {
    service.calls.push('sidecar:retryStart');
    await gate.promise;
    return service.sidecarManager.getStatus();
  };

  handleSidecarStatus(service, { phase: 'failed', detail: 'crashed' });
  handleSidecarStatus(service, { phase: 'failed', detail: 'duplicate' });

  assert.equal(service._autoReconnectPending, true);
  assert.equal(service.calls.filter((entry) => entry === 'sidecar:retryStart').length, 1);
  gate.resolve();
  await tick();
  assert.equal(service._autoReconnectPending, false);
});

test('handleSidecarStatus does not reconnect again after an attempted reconnect', () => {
  const service = makeService({ engine: 'replay' });
  service._managedReadyOnce = true;
  service._autoReconnectAttempted = true;
  let reconnects = 0;
  service._attemptAutoReconnect = () => { reconnects += 1; };

  handleSidecarStatus(service, { phase: 'failed', detail: 'repeat crash notification' });

  assert.equal(reconnects, 0);
});

for (const errorCode of [AI_ERROR_CODES.ENGINE_CONNECTION, SIDECAR_ERROR_CODES.TIMEOUT]) {
  test(`startBackendService downgrades ${errorCode} model initialization failures`, async () => {
    const service = makeService({ engine: 'replay' });
    service._initializeManagedSidecar = async () => {
      service._modelLifecycle.state = 'unavailable';
      const error = new Error('model endpoint unavailable');
      error.error_code = errorCode;
      throw error;
    };

    const status = await startBackendService(service, {});

    assert.equal(status.phase, 'model_unavailable');
    assert.equal(service._managedReadyOnce, true);
    assert.ok(service.logs.some((entry) => entry[1] === 'backend.start_model_unavailable'));
  });
}

test('retryStartBackendService preserves the engine-connection model-unavailable downgrade', async () => {
  const service = makeService({ engine: 'replay' });
  service._initializeManagedSidecar = async () => {
    service._modelLifecycle.state = 'unavailable';
    const error = new Error('retry could not reach the engine');
    error.error_code = AI_ERROR_CODES.ENGINE_CONNECTION;
    throw error;
  };

  const status = await retryStartBackendService(service);

  assert.equal(status.phase, 'model_unavailable');
  assert.equal(service._managedReadyOnce, true);
});

test('stopBackendService aborts active initialization and uses the cancellation teardown path', async () => {
  const service = makeService();
  const controller = new AbortController();
  service._managedInitializeFlight = { controller };

  await stopBackendService(service, {});

  assert.equal(controller.signal.aborted, true);
  assert.equal(service.calls.includes('model:unload'), false);
  assert.equal(service.calls.includes('sidecarClient:shutdown'), false);
  assert.ok(service.calls.includes('sidecarClient:endInput'));
  assert.ok(service.calls.includes('sidecarClient:dispose'));
});

test('stopBackendService always stops both local-engine managers after a sidecar stop failure', async () => {
  const service = makeService();
  service.sidecarManager.stop = async () => {
    service.calls.push('sidecar:stop');
    throw new Error('stop failed');
  };

  await stopBackendService(service, { ollamaShutdownScope: 'any_local' });

  assert.deepEqual(
    service.calls.find((entry) => Array.isArray(entry) && entry[0] === 'ollama:stop'),
    ['ollama:stop', { scope: 'any_local' }]
  );
  assert.ok(service.calls.includes('vllm:stop'));
  assert.ok(service.logs.some((entry) => entry[1] === 'backend.sidecar_stop_failed'));
});

test('Ollama starts before sidecar spawn settles and reports ready after the sidecar', async () => {
  const gate = deferred();
  const progress = [];
  const service = makeService({ engine: 'ollama' });
  service.sidecarManager.start = async () => {
    service.calls.push('sidecar:start');
    await gate.promise;
    return service.sidecarManager.getStatus();
  };

  const starting = startBackendService(service, {
    onProgress: (phase) => progress.push(phase),
  });

  assert.deepEqual(service.calls.slice(0, 2), ['ollama:start', 'sidecar:start']);
  gate.resolve();
  await starting;
  assert.ok(progress.indexOf('sidecar_spawned') < progress.indexOf('ollama_ready'));
});

test('replay startup skips both external local-engine managers', async () => {
  const service = makeService({ engine: 'replay' });

  await startBackendService(service, {});

  assert.equal(service.calls.includes('ollama:start'), false);
  assert.equal(service.calls.includes('vllm:start'), false);
  assert.ok(service.calls.includes('sidecar:start'));
  assert.ok(service.calls.includes('sidecar:initialize'));
});

test('vLLM reads live config and starts before sidecar spawn settles', async () => {
  const gate = deferred();
  const service = makeService({ engine: 'vllm' });
  service.currentModel = 'qwen-vllm';
  service.sidecarManager.start = async () => {
    service.calls.push('sidecar:start');
    await gate.promise;
    return service.sidecarManager.getStatus();
  };

  const starting = startBackendService(service, {});
  try {
    assert.deepEqual(service.calls.slice(0, 4), [
      'config:getLocalEngines',
      ['vllm:configure', {
        model: 'qwen-vllm',
        port: 8077,
        launchArgs: { port: 8077, extra: 'live' },
      }],
      'vllm:start',
      'sidecar:start',
    ]);
  } finally {
    gate.resolve();
    await starting;
  }
});

test('vLLM startup failure is logged and swallowed before managed initialization', async () => {
  const service = makeService({ engine: 'vllm' });
  service.vllmManager.start = async () => {
    service.calls.push('vllm:start');
    throw new Error('vllm unavailable');
  };

  const status = await startBackendService(service, {});

  assert.equal(status.phase, 'ready');
  assert.ok(service.calls.includes('sidecar:initialize'));
  assert.ok(service.logs.some((entry) => (
    entry[0] === 'WARN'
    && entry[1] === 'vllm.auto_start_failed'
    && /vllm unavailable/.test(entry[2].message)
  )));
});

test('slow managed llama-server startup overlaps sidecar spawn and joins before initialize', async () => {
  const localServerGate = deferred();
  const service = makeService({ engine: 'replay' });
  let settled = false;

  const starting = startBackendService(service, {
    localServerReadyPromise: localServerGate.promise,
  }).then((status) => {
    settled = true;
    return status;
  });
  try {
    await tick();
    assert.ok(service.calls.includes('sidecar:start'));
    assert.equal(service.calls.includes('sidecar:initialize'), false);
    assert.equal(settled, false);
  } finally {
    localServerGate.resolve({ state: 'ready' });
    await starting;
  }
  assert.ok(service.calls.includes('sidecar:initialize'));
});

for (const localServerStatus of [
  { state: 'ready', reused: true },
  { state: 'stopped', lastError: 'spawn_failed' },
]) {
  test(`managed llama-server ${localServerStatus.reused ? 'reuse' : 'failure'} settles before initialize`, async () => {
    const service = makeService({ engine: 'replay' });
    const localServerReadyPromise = {
      then(resolve) {
        service.calls.push('llama-server:settled');
        resolve(localServerStatus);
      },
    };

    await startBackendService(service, { localServerReadyPromise });

    assert.ok(service.calls.includes('llama-server:settled'));
    assert.ok(service.calls.indexOf('llama-server:settled') < service.calls.indexOf('sidecar:initialize'));
  });
}

test('a rejected managed llama-server start is logged and does not reject backend startup', async () => {
  const service = makeService({ engine: 'replay' });
  const localServerReadyPromise = {
    then(_resolve, reject) {
      reject(new Error('unexpected managed launch failure'));
    },
  };

  const status = await startBackendService(service, { localServerReadyPromise });

  assert.equal(status.phase, 'ready');
  // F8: a launch-plan throw here leaves a dead openai-compatible engine that
  // only surfaces at first chat, so it is logged at ERROR (not WARN) to stay
  // visible while the fail-soft behaviour is preserved.
  assert.ok(service.logs.some((entry) => (
    entry[0] === 'ERROR'
    && entry[1] === 'llama.server.auto_start_failed'
    && /unexpected managed launch failure/.test(entry[2].message)
  )));
});

test('managed llama-server stop aborts an in-flight launch and stops the late child', async () => {
  const gate = deferred();
  let launchOptions = null;
  let stopCalls = 0;
  const profile = {
    id: 'gemma4-12b',
    modelTag: 'gemma4:12b',
    contextSize: 32768,
    extraArgs: [],
    acceleration: null,
  };
  const manager = createLlamaServerManager({
    processRef: { env: {}, resourcesPath: '' },
    rootDir: 'G:/repo',
    userDataPath: 'G:/userData',
    lifecycle: {
      async startLlamaServer(options) {
        launchOptions = options;
        await gate.promise;
        return {
          pid: 73,
          baseUrl: 'http://127.0.0.1:8033',
          reused: false,
          apiKey: 'key-73',
          async stop() {
            stopCalls += 1;
            return { confirmed: true };
          },
        };
      },
      resolveGgufPath: () => ({ path: 'G:/models/model.gguf', projectorPath: '' }),
      resolveProjectorPath: () => '',
      sweepStaleApiKeyFiles() {},
    },
    resolveSettingsImpl: () => ({
      autostart: true,
      binaryOverride: '',
      host: '127.0.0.1',
      port: 8033,
      profileId: profile.id,
      profile,
      profileError: '',
      modelPathOverride: '',
      modelTagOverride: '',
      readinessTimeoutMs: 1000,
    }),
    resolveLaunchAccelerationImpl: () => ({
      mode: 'off', reason: 'flag_off', extraArgs: [], drafter: '', vramHeadroomMb: 0,
    }),
    buildFeatureFlagsImpl: () => ({}),
  });

  const starting = manager.startFromSettings();
  await tick();
  assert.equal(manager.getStatus().state, 'starting');
  const stopping = manager.stop();
  assert.equal(launchOptions.abortSignal.aborted, true);
  gate.resolve();
  await Promise.all([starting, stopping]);

  assert.equal(stopCalls, 1);
  assert.equal(manager.getStatus().state, 'stopped');
});

// ---------------------------------------------------------------------------
// F10a/F10b: local-engine kickoff must not repeat across a
// finalizeStart-failure -> retryStart cycle within a single startBackendService
// call (the outer try/catch in startBackendService wraps both the initial
// finalizeStart(status) call and the retried one, so a throw out of
// finalizeStart is retried through the very same try/catch).
// ---------------------------------------------------------------------------

test('F10a: vLLM is configured and started exactly once across a finalizeStart-failure -> retryStart cycle', async () => {
  const service = makeService({ engine: 'vllm' });
  let initializeCalls = 0;
  service._initializeManagedSidecar = async () => {
    initializeCalls += 1;
    if (initializeCalls === 1) {
      throw new Error('managed sidecar init failed');
    }
  };

  const status = await startBackendService(service, {});

  assert.equal(status.phase, 'ready');
  assert.equal(initializeCalls, 2);
  assert.ok(service.calls.includes('sidecar:retryStart'));
  assert.equal(service.calls.filter((entry) => entry === 'vllm:start').length, 1);
  assert.equal(
    service.calls.filter((entry) => Array.isArray(entry) && entry[0] === 'vllm:configure').length,
    1
  );
});

test('F10b: ollama_ready is emitted at most once across a finalizeStart-failure -> retryStart cycle', async () => {
  const service = makeService({ engine: 'ollama' });
  const progress = [];
  let initializeCalls = 0;
  service._initializeManagedSidecar = async () => {
    initializeCalls += 1;
    if (initializeCalls === 1) {
      throw new Error('managed sidecar init failed');
    }
  };

  const status = await startBackendService(service, {
    onProgress: (phase) => progress.push(phase),
  });

  assert.equal(status.phase, 'ready');
  assert.equal(initializeCalls, 2);
  assert.equal(service.calls.filter((entry) => entry === 'ollama:start').length, 1);
  assert.equal(progress.filter((phase) => phase === 'ollama_ready').length, 1);
});

// ---------------------------------------------------------------------------
// F6: a stop landing in the local-engine-join window (bounded by up to the
// 90s llama-server readiness timeout) must not resume into
// _initializeManagedSidecar against a torn-down client.
// ---------------------------------------------------------------------------

test('F6: a stop landing during the local-engine join skips managed-sidecar initialization', async () => {
  const gate = deferred();
  const service = makeService({ engine: 'replay' });

  const starting = startBackendService(service, {
    localServerReadyPromise: gate.promise,
  });

  await tick();
  assert.ok(service.calls.includes('sidecar:start'));
  assert.equal(service.calls.includes('sidecar:initialize'), false);

  // Simulate stopBackendService() having set _stopping and still being
  // in flight (has not yet reached its `finally` reset) while the
  // local-engine join is still pending.
  service._stopping = true;
  gate.resolve({ state: 'ready' });
  const status = await starting;

  assert.equal(service.calls.includes('sidecar:initialize'), false);
  assert.equal(service.calls.includes('model:autoLoad'), false);
  assert.deepEqual(status, buildObservedBackendStatus(service, service.sidecarManager.getStatus()));
});
