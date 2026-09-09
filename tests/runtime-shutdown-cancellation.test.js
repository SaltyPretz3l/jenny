const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeShutdownController } = require('../services/main/runtime-shutdown');
const { stopRuntimeWithDependencies } = require('../services/runtime-stop');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createProbe(pausedStage) {
  const entered = deferred();
  const gate = deferred();
  const calls = [];
  const logs = [];
  const progress = [];
  async function run(stage) {
    calls.push(stage);
    if (stage === pausedStage) {
      entered.resolve();
      await gate.promise;
    }
  }
  const controller = createRuntimeShutdownController({
    app: { getPath: () => '' },
    clearSuggestionCache: () => {},
    getSetupService: () => ({ disposeActivePulls: () => run('setup') }),
    getWorkspaceTerminalService: () => ({ dispose: () => run('workspace') }),
    getBackendService: () => ({
      async stop(options) {
        await run('backend');
        options.onProgress('sidecar_stopped', 'Stopped');
      },
    }),
    getProcessLogWriter: () => ({ flush: () => run('flush') }),
    llamaServerManager: { stop: () => run('llama'), stopSync() {} },
    // Every emergency edge is inert. Never signal the user's running processes.
    shutdownAnyLocalOllamaSyncImpl: () => ({ skipped: 'no_owned_state' }),
    shutdownManagedSidecarSyncImpl: () => ({ hadState: false }),
    shutdownLlamaServerSyncImpl: () => ({ hadState: false }),
    sendBridgeEvent: (_channel, payload) => progress.push(payload),
    log: (level, event, fields) => logs.push({ level, event, fields }),
  });
  return { controller, calls, logs, progress, entered, gate };
}

for (const stage of ['setup', 'llama', 'workspace', 'backend', 'flush']) {
  test(`cancelled shutdown does not advance or report success after late ${stage} completion`, async () => {
    const probe = createProbe(stage);
    const abort = new AbortController();
    const pending = probe.controller.stopRuntimeBeforeQuit({ signal: abort.signal });
    await probe.entered.promise;
    abort.abort();
    const callsAtAbort = [...probe.calls];
    const logsAtAbort = [...probe.logs];
    const progressAtAbort = [...probe.progress];
    probe.gate.resolve();
    await pending;
    assert.deepEqual(probe.calls, callsAtAbort);
    assert.deepEqual(probe.logs, logsAtAbort);
    assert.deepEqual(probe.progress, progressAtAbort);
  });
}

test('already cancelled runtime shutdown performs no disposal', async () => {
  const probe = createProbe();
  const abort = new AbortController();
  abort.abort();
  await probe.controller.stopRuntimeBeforeQuit({ signal: abort.signal });
  assert.deepEqual(probe.calls, []);
  assert.deepEqual(probe.logs, []);
});

test('late backend rejection after the shutdown deadline cannot launch cleanup again', async () => {
  const gate = deferred();
  const entered = deferred();
  const abort = new AbortController();
  const events = [];
  const pending = stopRuntimeWithDependencies({
    signal: abort.signal,
    backendService: {
      async stop() { entered.resolve(); await gate.promise; },
      ollamaManager: { async stop() { events.push('ollama'); } },
    },
    clearSuggestionCacheImpl() {},
    emitLifecycleProgressImpl() { events.push('progress'); },
    logImpl() { events.push('log'); },
    runEmergencyShutdownImpl() { events.push('emergency'); },
  });
  await entered.promise;
  abort.abort();
  gate.reject(new Error('late backend failure'));
  await pending;
  assert.deepEqual(events, []);
});

for (const result of [
  { skipped: 'identity_unconfirmed' },
  { discoveredPids: [123], killedPids: [], verifiedAllKilled: false },
]) {
  test(`emergency shutdown reports Ollama cleanup as unconfirmed: ${result.skipped || 'survivor'}`, () => {
    const logs = [];
    const controller = createRuntimeShutdownController({
      app: { getPath: () => '' },
      llamaServerManager: { stopSync() {} },
      shutdownManagedSidecarSyncImpl: () => ({ hadState: false }),
      shutdownLlamaServerSyncImpl: () => ({ hadState: false }),
      shutdownAnyLocalOllamaSyncImpl: () => result,
      log: (_level, event, fields) => logs.push({ event, fields }),
    });
    controller.runEmergencyRuntimeShutdownSync();
    const terminal = logs.find(({ fields }) => fields.stage === 'emergency_fallback');
    assert.equal(terminal.fields.confirmed, false);
    assert.equal(terminal.fields.status, 'unconfirmed');
  });
}

test('the lifecycle deadline reaches emergency cleanup while a runtime stage is hung', async () => {
  const { MainLifecycleController } = require('../services/main-lifecycle');
  const probe = createProbe('setup');
  const events = [];
  let expire;
  let runtimePromise;
  const lifecycle = new MainLifecycleController({
    shutdownTimeoutMs: 1000,
    setTimeoutImpl(callback) { expire = callback; return 1; },
    clearTimeoutImpl() {},
    stopRuntime(context) {
      runtimePromise = probe.controller.stopRuntimeBeforeQuit(context);
      return runtimePromise;
    },
    onEmergencyShutdown() {
      events.push('emergency');
      probe.controller.runEmergencyRuntimeShutdownSync();
    },
    appExit(code) { events.push(`exit:${code}`); },
  });
  const pending = lifecycle.handleBeforeQuit({ preventDefault() {} });
  await probe.entered.promise;
  expire();
  await pending;
  assert.deepEqual(events, ['emergency', 'exit:0']);
  const logCount = probe.logs.length;
  assert.equal(probe.logs.filter(({ fields }) => fields.stage === 'emergency_fallback').length, 1);
  probe.gate.resolve();
  await runtimePromise;
  assert.deepEqual(probe.calls, ['setup', 'workspace']);
  assert.equal(probe.logs.length, logCount);
  assert.deepEqual(events, ['emergency', 'exit:0']);
});
