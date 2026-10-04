'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { AI_ERROR_CODES } = require('../../services/backend/error-codes');
const {
  retryStartBackendService,
  startBackendService,
  stopBackendService,
} = require('../../services/backend/local-engine-lifecycle');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

function makeService() {
  const calls = [];
  const logs = [];
  const status = { phase: 'ready', pid: 41, baseUrl: 'http://127.0.0.1:8765' };
  return {
    activeStreams: new Map(),
    calls,
    logs,
    currentEngineType: 'replay',
    currentModel: '',
    defaultModel: '',
    currentStatus: null,
    options: {},
    sidecarManager: {
      isStopping: false,
      getStatus: () => status,
      async start() { calls.push('sidecar:start'); return status; },
      async retryStart() { calls.push('sidecar:retry'); return status; },
      async stop() { calls.push('sidecar:stop'); return { exitConfirmed: true, forced: false }; },
    },
    sidecarClient: {
      async shutdown() { calls.push('sidecar:shutdown'); },
      endInput() { calls.push('sidecar:end-input'); },
    },
    ollamaManager: {
      async stop() { calls.push('ollama:stop'); },
    },
    vllmManager: {
      async stop() { calls.push('vllm:stop'); },
    },
    emit() {},
    _emitServiceLog(level, event, details) { logs.push([level, event, details]); },
    _abortActiveStreams(reason) { calls.push(['streams:abort', reason]); },
    _clearPendingToolApprovals() { calls.push('approvals:clear'); },
    _disposeSidecarClient() { calls.push('sidecar:dispose'); this.sidecarClient = null; },
    async _initializeManagedSidecar() { calls.push('sidecar:initialize'); },
    async _unloadManagedModelForShutdown() { calls.push('model:unload'); },
    _autoLoadDefaultModel() { calls.push('model:auto-load'); },
    async restoreAuthState() { calls.push('auth:restore'); },
    async refreshStatusSnapshot() { calls.push('status:refresh'); },
    _schedulePendingSessionMigrations() { calls.push('migrations:schedule'); },
  };
}

test('backend stop drains runtime before generic stream abort', async () => {
  const service = makeService();
  const runtimeGate = deferred();
  service.sessionRuntime = {
    beginShutdown(options) {
      service.calls.push(['runtime:begin', options]);
      return { requested: true, completion: runtimeGate.promise };
    },
  };

  const stopping = stopBackendService(service, {});
  await tick();
  assert.deepEqual(service.calls[0], ['runtime:begin', { reason: 'service_stop', timeoutMs: 4500 }]);
  assert.equal(service.calls.some(call => Array.isArray(call) && call[0] === 'streams:abort'), false);
  runtimeGate.resolve({ ok: true });
  await stopping;
  assert.ok(service.calls.some(call => Array.isArray(call) && call[0] === 'streams:abort'));
});

test('unconfirmed runtime cleanup is logged without skipping process cleanup', async () => {
  const service = makeService();
  service.sessionRuntime = {
    beginShutdown: () => ({ requested: true, completion: Promise.resolve({
      ok: false, reason: 'runtime_cleanup_uncertain', timedOut: true,
    }) }),
  };

  await stopBackendService(service, {});

  assert.ok(service.calls.includes('sidecar:stop'));
  assert.ok(service.calls.includes('vllm:stop'));
  assert.ok(service.logs.some(entry => entry[1] === 'session_runtime.shutdown_unconfirmed'
    && entry[2].reason === 'runtime_cleanup_uncertain' && entry[2].timedOut === true));
});

test('work parked for the next start is logged as information, not as unconfirmed cleanup', async () => {
  const service = makeService();
  service.sessionRuntime = {
    beginShutdown: () => ({ requested: true, completion: Promise.resolve({
      ok: false, reason: 'runtime_cleanup_awaits_backend_restart',
    }) }),
  };

  await stopBackendService(service, {});

  assert.ok(service.calls.includes('sidecar:stop'));
  assert.ok(service.logs.some(entry => entry[0] === 'INFO' && entry[1] === 'session_runtime.shutdown_awaits_restart'));
  assert.equal(service.logs.some(entry => entry[1] === 'session_runtime.shutdown_unconfirmed'), false);
});

test('a throwing runtime shutdown is logged and process cleanup still runs', async () => {
  const service = makeService();
  service.sessionRuntime = {
    beginShutdown() { throw new Error('runtime begin failed'); },
  };

  await stopBackendService(service, {});

  assert.ok(service.calls.includes('sidecar:stop'));
  assert.ok(service.logs.some(entry => entry[1] === 'session_runtime.shutdown_unconfirmed'
    && entry[2].reason === 'runtime begin failed'));
});

test('successful backend start reopens runtime after reconciliation without pumping work', async () => {
  const service = makeService();
  service.sessionStore = {
    listSessionRecords() { service.calls.push('runtime:reconcile'); return []; },
  };
  service.sessionRuntime = {
    reopenAfterShutdown() { service.calls.push('runtime:reopen'); return { ok: true }; },
  };

  await startBackendService(service, {});

  assert.ok(service.calls.indexOf('sidecar:initialize') < service.calls.indexOf('runtime:reconcile'));
  assert.ok(service.calls.indexOf('runtime:reconcile') < service.calls.indexOf('runtime:reopen'));
  assert.equal(service.calls.filter(call => call === 'runtime:reopen').length, 1);
});

test('backend start reclaims abandoned runtime work before reopening and logs it', async () => {
  const service = makeService();
  service.sessionStore = {
    listSessionRecords() { service.calls.push('runtime:reconcile'); return []; },
  };
  service.sessionRuntime = {
    reclaimAbandonedAfterBackendRestart(options) {
      service.calls.push(['runtime:reclaim', options]);
      return { reclaimed: [{ work_id: 'work-1', session_id: 'session-1', status: 'failed' }],
        retained: [{ work_id: 'work-2', reason: 'runtime_producer_pending' }], resources_confirmed: 2,
        leases_confirmed: 1 };
    },
    reopenAfterShutdown() { service.calls.push('runtime:reopen'); return { ok: true }; },
  };

  await startBackendService(service, {});

  const reclaimIndex = service.calls.findIndex(call => Array.isArray(call) && call[0] === 'runtime:reclaim');
  assert.ok(reclaimIndex >= 0, 'reclaim runs');
  assert.ok(service.calls.indexOf('runtime:reconcile') < reclaimIndex);
  assert.ok(reclaimIndex < service.calls.indexOf('runtime:reopen'));
  assert.deepEqual(service.calls[reclaimIndex][1], { reason: 'backend_restart' });
  assert.deepEqual(service.logs.filter(([, event]) => event === 'session_runtime.abandoned_work_reclaimed'), [[
    'WARN', 'session_runtime.abandoned_work_reclaimed',
    { reason: 'backend_restart', reclaimed: ['work-1'], recovering: [], actorLeasesDropped: [],
      retained: ['work-2'], resourcesConfirmed: 2, leasesConfirmed: 1 },
  ]]);
});

test('backend start stays silent when the runtime had nothing to reclaim', async () => {
  const service = makeService();
  service.sessionRuntime = {
    reclaimAbandonedAfterBackendRestart() {
      return { reclaimed: [], retained: [], resources_confirmed: 0 };
    },
    reopenAfterShutdown() { service.calls.push('runtime:reopen'); return { ok: true }; },
  };

  await startBackendService(service, {});

  assert.equal(service.calls.includes('runtime:reopen'), true);
  assert.deepEqual(service.logs.filter(([, event]) => event === 'session_runtime.abandoned_work_reclaimed'), []);
});

for (const [label, report] of [['resources', { resources_confirmed: 1 }], ['orphaned-lease', { leases_confirmed: 1 }]]) {
  test(`backend start logs a ${label}-only reclaim at INFO`, async () => {
    const service = makeService();
    service.sessionRuntime = {
      reclaimAbandonedAfterBackendRestart() {
        return { reclaimed: [], retained: [], ...report };
      },
      reopenAfterShutdown() { return { ok: true }; },
    };

    await startBackendService(service, {});

    const logs = service.logs.filter(([, event]) => event === 'session_runtime.abandoned_work_reclaimed');
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'INFO');
  });
}

test('backend start fails closed when reconciled runtime cannot reopen', async () => {
  const service = makeService();
  service.sessionRuntime = {
    reopenAfterShutdown: () => ({ ok: false, reason: 'runtime_cleanup_unsettled' }),
  };

  await assert.rejects(() => startBackendService(service, {}), {
    code: 'runtime_cleanup_unsettled',
  });
  assert.equal(service.calls.includes('migrations:schedule'), false);
});

test('retry startup reconciles and reopens after a downgraded model failure', async () => {
  const service = makeService();
  service.sessionStore = {
    listSessionRecords() { service.calls.push('runtime:reconcile'); return []; },
  };
  service.sessionRuntime = {
    reopenAfterShutdown() { service.calls.push('runtime:reopen'); return { ok: true }; },
  };
  service._initializeManagedSidecar = async () => {
    service._modelLifecycle.state = 'unavailable';
    const error = new Error('engine unavailable');
    error.error_code = AI_ERROR_CODES.ENGINE_CONNECTION;
    throw error;
  };

  const status = await retryStartBackendService(service);

  assert.equal(status.phase, 'model_unavailable');
  assert.ok(service.calls.indexOf('runtime:reconcile') < service.calls.indexOf('runtime:reopen'));
});

test('retry startup cannot reopen runtime while a newer stop is in progress', async () => {
  const service = makeService();
  const restoreStarted = deferred();
  const restoreGate = deferred();
  const shutdownGate = deferred();
  service.restoreAuthState = async () => {
    service.calls.push('auth:restore');
    restoreStarted.resolve();
    await restoreGate.promise;
  };
  service.sessionRuntime = {
    beginShutdown: () => ({ requested: true, completion: shutdownGate.promise }),
    reopenAfterShutdown() { service.calls.push('runtime:reopen'); return { ok: true }; },
  };

  const starting = retryStartBackendService(service);
  await restoreStarted.promise;
  const stopping = stopBackendService(service, {});
  await tick();
  restoreGate.resolve();
  await starting;

  assert.equal(service.calls.includes('runtime:reopen'), false);
  shutdownGate.resolve({ ok: true });
  await stopping;
});

test('completed stop fences an older start while a fresh explicit start can reopen', async () => {
  const service = makeService();
  const restoreStarted = deferred();
  const restoreGate = deferred();
  service.restoreAuthState = async () => {
    service.calls.push('auth:restore');
    restoreStarted.resolve();
    await restoreGate.promise;
  };
  service.sessionRuntime = {
    beginShutdown: () => ({ requested: true, completion: Promise.resolve({ ok: true }) }),
    reopenAfterShutdown() { service.calls.push('runtime:reopen'); return { ok: true }; },
  };

  const staleStart = startBackendService(service, {});
  await restoreStarted.promise;
  await stopBackendService(service, {});
  restoreGate.resolve();
  await staleStart;
  assert.equal(service.calls.includes('runtime:reopen'), false);

  service.restoreAuthState = async () => { service.calls.push('auth:restore:fresh'); };
  await startBackendService(service, {});
  assert.equal(service.calls.filter(call => call === 'runtime:reopen').length, 1);
});

test('start and retry cannot reopen during an earlier stop model teardown', async () => {
  const service = makeService();
  const unloading = deferred();
  const finishUnload = deferred();
  service._unloadManagedModelForShutdown = async () => {
    unloading.resolve();
    await finishUnload.promise;
  };
  service.sessionRuntime = {
    beginShutdown: () => ({ completion: Promise.resolve({ ok: true }) }),
    reopenAfterShutdown() { service.calls.push('runtime:reopen'); return { ok: true }; },
  };
  const stopping = stopBackendService(service, {});
  await unloading.promise;
  assert.equal(stopBackendService(service, {}), stopping);
  await assert.rejects(startBackendService(service, {}), { code: 'CMP-RUNTIME-0005', reason: 'backend_stop_in_progress' });
  await assert.rejects(retryStartBackendService(service), { code: 'CMP-RUNTIME-0005', reason: 'backend_stop_in_progress' });
  assert.equal(service.calls.includes('sidecar:start'), false);
  assert.equal(service.calls.includes('sidecar:retry'), false);
  assert.equal(service.calls.includes('runtime:reopen'), false);
  finishUnload.resolve();
  await stopping;
  await startBackendService(service, {});
  assert.ok(service.calls.indexOf('sidecar:stop') < service.calls.indexOf('sidecar:start'));
  assert.ok(service.calls.indexOf('sidecar:start') < service.calls.indexOf('runtime:reopen'));
});

// An in-process restart recovers reclaimed work parked for recovery before the
// runtime reopens, as a new process recovers it before ready.
function recoveringRuntime(service, { reconcile = async () => ({ confirmed: 1 }), reopen = () => ({ ok: true }) } = {}) {
  service.sessionRuntime = {
    store: { get: () => null },
    reclaimAbandonedAfterBackendRestart() {
      return { reclaimed: [{ work_id: 'work-r', session_id: 'session-r', status: 'needs_attention' }], retained: [] };
    },
    async reconcileMutationPreparations() {
      service.calls.push('runtime:mutation-reconcile');
      return reconcile();
    },
    async recoverPausedCancellations() {
      service.calls.push('runtime:paused-cancellation');
      return { requested: 1, completed: 1, blocked: 0 };
    },
    reopenAfterShutdown() { service.calls.push('runtime:reopen'); return reopen(); },
  };
}

for (const [label, begin] of [['start', service => startBackendService(service, {})],
  ['retry start', service => retryStartBackendService(service)]]) {
  test(`${label} reopens only after reclaimed work's reconcile and cancellation retry finish`, async () => {
    const service = makeService();
    const gate = deferred();
    recoveringRuntime(service, { reconcile: () => gate.promise });
    let settled = false;
    const starting = begin(service).then(() => { settled = true; });
    while (!service.calls.includes('runtime:mutation-reconcile')) await tick();
    await tick();
    assert.equal(service.calls.includes('runtime:reopen'), false);
    assert.equal(settled, false);
    gate.resolve({ confirmed: 1 });
    await starting;
    assert.deepEqual(service.calls.filter(call => /^runtime:(mutation|paused|reopen)/.test(call)),
      ['runtime:mutation-reconcile', 'runtime:paused-cancellation', 'runtime:reopen']);
  });
}

test('a refused reopen after recovery still rejects start with the same error', async () => {
  const service = makeService();
  recoveringRuntime(service, { reopen: () => ({ ok: false, reason: 'runtime_cleanup_unsettled' }) });

  await assert.rejects(() => startBackendService(service, {}), { code: 'runtime_cleanup_unsettled' });
  assert.ok(service.calls.indexOf('runtime:paused-cancellation') < service.calls.indexOf('runtime:reopen'));
  assert.equal(service.calls.includes('migrations:schedule'), false);
});

test('a failing reconcile is logged and start still reopens', async () => {
  const service = makeService();
  recoveringRuntime(service, { reconcile: async () => { throw new Error('sidecar_gone'); } });

  await startBackendService(service, {});

  assert.equal(service.calls.includes('runtime:reopen'), true);
  assert.ok(service.logs.some(([level, event]) => level === 'ERROR'
    && event === 'session_runtime.paused_cancellation_recovery_failed'));
});

test('a stop landing during recovery keeps the older start from reopening', async () => {
  const service = makeService();
  const gate = deferred();
  recoveringRuntime(service, { reconcile: () => gate.promise });
  service.sessionRuntime.beginShutdown = () => ({ requested: true, completion: Promise.resolve({ ok: true }) });
  const starting = startBackendService(service, {});
  while (!service.calls.includes('runtime:mutation-reconcile')) await tick();
  const stopping = stopBackendService(service, {});
  await tick();
  gate.resolve({ confirmed: 1 });
  await starting;
  await stopping;
  assert.equal(service.calls.includes('runtime:reopen'), false);
});
