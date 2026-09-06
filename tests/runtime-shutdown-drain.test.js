const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// SAFETY: runtime-shutdown's emergency path calls shutdownAnyLocalOllamaSync /
// shutdownManagedSidecarSync / shutdownLlamaServerSync, which spawnSync
// `ollama stop`, `taskkill`, and `wsl --shutdown` against the REAL machine.
// shutdownAnyLocalOllamaSync is UNCONDITIONALLY destructive (no managed-state
// gate), so a single emergency-path invocation would stop the developer's
// running Ollama models and shut down WSL. The controller now accepts these
// three as injectable impls; every controller below that can reach the
// emergency path is wired with inert recording fakes via
// createShutdownImplFakes(), which both neutralizes the destructive subprocess
// layer and lets us assert the emergency path actually invokes each impl. This
// replaces the previous module-load child_process global stub.

const {
  createRuntimeShutdownController,
  SHUTDOWN_STEP_INDEX,
} = require('../services/main/runtime-shutdown');
// Same module objects the controller closes over — monkeypatch their named
// exports and restore originals in t.after/finally.
const llamaLifecycle = require('../services/llama-server-lifecycle');
const { MainLifecycleController } = require('../services/main-lifecycle');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createDrainProbeService() {
  const drained = [];
  return {
    drained,
    service: {
      sessionStore: { dispose() { drained.push('sessionStore'); } },
      shadowStore: { flush() { drained.push('shadowStore'); } },
      turnEventJournal: { dispose() { drained.push('turnEventJournal'); } },
      terminalRepairStore: { dispose() { drained.push('terminalRepairStore'); } },
    },
  };
}

// Inert, recording stand-ins for the three destructive sync shutdown helpers.
// `order` records the relative invocation sequence; `calls` captures each
// options object so tests can assert userDataPath/logger were threaded through.
function createShutdownImplFakes() {
  const order = [];
  const calls = { llama: [], sidecar: [], ollama: [] };
  return {
    order,
    calls,
    impls: {
      shutdownLlamaServerSyncImpl: (opts) => {
        order.push('llama');
        calls.llama.push(opts);
        return { hadState: false, killed: false, pid: 0 };
      },
      shutdownManagedSidecarSyncImpl: (opts) => {
        order.push('sidecar');
        calls.sidecar.push(opts);
      },
      shutdownAnyLocalOllamaSyncImpl: (opts) => {
        order.push('ollama');
        calls.ollama.push(opts);
      },
    },
  };
}

function createController(service, userDataPath, shutdownImpls) {
  return createRuntimeShutdownController({
    app: { getPath: () => userDataPath },
    processRef: { env: {}, platform: process.platform },
    rootDir: userDataPath,
    clearSuggestionCache: () => {},
    suggestionCache: null,
    getBackendService: () => service,
    log: () => {},
    ...(shutdownImpls || {}),
  });
}

test('emergency runtime shutdown drains debounced session stores before killing processes', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-emergency-drain-'));
  trackDirectory(userDataPath);
  const probe = createDrainProbeService();
  const fakes = createShutdownImplFakes();
  const controller = createController(probe.service, userDataPath, fakes.impls);

  controller.runEmergencyRuntimeShutdownSync();

  assert.deepEqual(
    probe.drained,
    ['sessionStore', 'shadowStore', 'turnEventJournal', 'terminalRepairStore'],
    'all session stores must be drained on the emergency path'
  );
});

test('emergency runtime shutdown invokes every injected shutdown impl with the userData path', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-emergency-impls-'));
  trackDirectory(userDataPath);
  const probe = createDrainProbeService();
  const fakes = createShutdownImplFakes();
  const controller = createController(probe.service, userDataPath, fakes.impls);

  controller.runEmergencyRuntimeShutdownSync();

  // Each destructive helper must be invoked exactly once via its injected impl.
  assert.equal(fakes.calls.llama.length, 1, 'emergency path must invoke the llama-server shutdown impl once');
  assert.equal(fakes.calls.sidecar.length, 1, 'emergency path must invoke the managed-sidecar shutdown impl once');
  assert.equal(fakes.calls.ollama.length, 1, 'emergency path must invoke the local-ollama shutdown impl once');

  // The userData path + a logger must be threaded into every impl.
  for (const opts of [fakes.calls.llama[0], fakes.calls.sidecar[0], fakes.calls.ollama[0]]) {
    assert.equal(opts.userDataPath, userDataPath, 'shutdown impl must receive app.getPath(userData)');
    assert.equal(typeof opts.logger, 'function', 'shutdown impl must receive a logger');
  }

  // Source order: llama-server, then managed sidecar, then local ollama.
  assert.deepEqual(
    fakes.order,
    ['llama', 'sidecar', 'ollama'],
    'emergency path must stop llama-server, then sidecar, then local ollama, in that order'
  );

  // Stores are still drained before the kill helpers run.
  assert.deepEqual(
    probe.drained,
    ['sessionStore', 'shadowStore', 'turnEventJournal', 'terminalRepairStore']
  );
});

// F2d: the llama-server result is consumed exactly like the sidecar's — a
// retained (unconfirmed) kill must not be reported as a clean emergency stop.
// F2/F2a: the residue-gated ollama sweep reports why it skipped.
test('emergency runtime shutdown reports unconfirmed when the llama-server kill is retained', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-emergency-llama-'));
  trackDirectory(userDataPath);
  const probe = createDrainProbeService();
  const entries = [];
  const controller = createRuntimeShutdownController({
    app: { getPath: () => userDataPath },
    processRef: { env: {}, platform: process.platform },
    rootDir: userDataPath,
    clearSuggestionCache: () => {},
    suggestionCache: null,
    getBackendService: () => probe.service,
    log: (level, event, fields) => entries.push({ level, event, fields }),
    shutdownLlamaServerSyncImpl: () => ({ hadState: true, killed: false, pid: 42, retained: true }),
    shutdownManagedSidecarSyncImpl: () => ({ hadState: true, killed: true, pid: 7 }),
    shutdownAnyLocalOllamaSyncImpl: () => ({
      discoveredPids: [], killedPids: [], skipped: 'no_owned_state',
    }),
  });

  controller.runEmergencyRuntimeShutdownSync();

  const stage = entries.find(
    (entry) => entry.event === 'runtime.shutdown_stage' && entry.fields.stage === 'emergency_fallback'
  );
  assert.ok(stage, 'expected an emergency_fallback stage log');
  assert.equal(stage.level, 'WARN');
  assert.equal(stage.fields.status, 'unconfirmed');
  assert.equal(stage.fields.confirmed, false);
  assert.equal(stage.fields.ollamaSweepSkipped, 'no_owned_state');
});

test('emergency runtime shutdown reports ok when every kill is confirmed', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-emergency-ok-'));
  trackDirectory(userDataPath);
  const probe = createDrainProbeService();
  const entries = [];
  const controller = createRuntimeShutdownController({
    app: { getPath: () => userDataPath },
    processRef: { env: {}, platform: process.platform },
    rootDir: userDataPath,
    clearSuggestionCache: () => {},
    suggestionCache: null,
    getBackendService: () => probe.service,
    log: (level, event, fields) => entries.push({ level, event, fields }),
    shutdownLlamaServerSyncImpl: () => ({ hadState: true, killed: true, pid: 42 }),
    shutdownManagedSidecarSyncImpl: () => ({ hadState: true, killed: true, pid: 7 }),
    shutdownAnyLocalOllamaSyncImpl: () => ({ discoveredPids: [], killedPids: [] }),
  });

  controller.runEmergencyRuntimeShutdownSync();

  const stage = entries.find(
    (entry) => entry.event === 'runtime.shutdown_stage' && entry.fields.stage === 'emergency_fallback'
  );
  assert.ok(stage);
  assert.equal(stage.level, 'INFO');
  assert.equal(stage.fields.confirmed, true);
  assert.equal(stage.fields.ollamaSweepSkipped, undefined);
});

test('emergency runtime shutdown drains stores only once across repeated triggers', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-emergency-drain-once-'));
  trackDirectory(userDataPath);
  const probe = createDrainProbeService();
  const fakes = createShutdownImplFakes();
  const controller = createController(probe.service, userDataPath, fakes.impls);

  controller.runEmergencyRuntimeShutdownSync();
  controller.runEmergencyRuntimeShutdownSync();

  assert.equal(probe.drained.length, 4, 'the emergency latch must keep the drain single-shot');
  // The latch must also keep the destructive shutdown helpers single-shot.
  assert.equal(fakes.calls.ollama.length, 1, 'the emergency latch must invoke the ollama shutdown impl only once');
  assert.equal(fakes.calls.sidecar.length, 1, 'the emergency latch must invoke the sidecar shutdown impl only once');
  assert.equal(fakes.calls.llama.length, 1, 'the emergency latch must invoke the llama shutdown impl only once');
});

// ---------------------------------------------------------------------------
// emitLifecycleProgress: percent is Math.round(stepIndex / max(stepCount,1) * 100)
// ---------------------------------------------------------------------------

test('emitLifecycleProgress sends lifecycle.onProgress with the rounded percent for the step pair', () => {
  const events = [];
  const controller = createRuntimeShutdownController({
    app: { getPath: () => '' },
    processRef: { env: {} },
    sendBridgeEvent: (channel, payload) => { events.push({ channel, payload }); },
    log: () => {},
  });

  controller.emitLifecycleProgress('startup', 'model_load', 'Loading weights', 3, 7);

  assert.equal(events.length, 1, 'exactly one bridge event must be emitted');
  const { channel, payload } = events[0];
  assert.equal(channel, 'lifecycle.onProgress', 'must emit on the lifecycle.onProgress channel');
  assert.equal(payload.scenario, 'startup');
  assert.equal(payload.phase, 'model_load');
  assert.equal(payload.detail, 'Loading weights');
  assert.equal(payload.stepIndex, 3);
  assert.equal(payload.stepCount, 7);
  // 3/7 * 100 = 42.857... -> rounds to 43
  assert.equal(payload.percent, 43, 'percent must be Math.round(stepIndex/stepCount*100) = 43');
  assert.equal(payload.percent, Math.round((3 / 7) * 100));
  assert.equal(payload.error, '', 'error must default to empty string when not provided');
  assert.equal(typeof payload.timestamp, 'number');
});

// ---------------------------------------------------------------------------
// startLlamaServerBeforeBackend
// ---------------------------------------------------------------------------

function buildStartController({ env, startLlamaServerImpl, logs, marks, userDataPath, rootDir = userDataPath }) {
  return createRuntimeShutdownController({
    app: { getPath: () => userDataPath },
    processRef: { env, resourcesPath: '' },
    rootDir,
    log: (level, event, fields) => { logs.push({ level, event, fields }); },
    emitStartupAuditMark: (mark, fields) => { marks.push({ mark, fields }); },
  });
}

test('startLlamaServerBeforeBackend skips startup when autostart is disabled via env', async (t) => {
  const original = llamaLifecycle.startLlamaServer;
  let called = false;
  llamaLifecycle.startLlamaServer = async () => { called = true; return {}; };
  t.after(() => { llamaLifecycle.startLlamaServer = original; });

  const logs = [];
  const marks = [];
  const controller = buildStartController({
    env: { JENNY_LLAMA_SERVER_AUTOSTART: '0' },
    logs,
    marks,
    userDataPath: '',
  });

  await controller.startLlamaServerBeforeBackend();

  assert.equal(called, false, 'startLlamaServer must NOT be invoked when autostart is disabled');
  assert.ok(
    logs.some((entry) => entry.event === 'llama.server.autostart_disabled'),
    'must log llama.server.autostart_disabled'
  );
  assert.equal(
    marks.length, 0,
    'no startup-audit marks should be emitted on the disabled path'
  );
});

test('startLlamaServerBeforeBackend logs start_skipped_reused and a reused audit mark when the server is reused', async (t) => {
  const original = llamaLifecycle.startLlamaServer;
  let startArgs = null;
  llamaLifecycle.startLlamaServer = async (opts) => {
    startArgs = opts;
    return { reused: true, baseUrl: 'http://127.0.0.1:8033/v1', pid: 0 };
  };
  t.after(() => { llamaLifecycle.startLlamaServer = original; });

  const logs = [];
  const marks = [];
  const controller = buildStartController({
    env: { JENNY_LLAMA_SERVER_AUTOSTART: '1' },
    logs,
    marks,
    userDataPath: 'C:/jenny-user-data',
  });

  await controller.startLlamaServerBeforeBackend();

  assert.ok(startArgs, 'startLlamaServer must be invoked when autostart is enabled');
  assert.equal(startArgs.userDataPath, 'C:/jenny-user-data', 'app.getPath(userData) must feed startLlamaServer');

  const reusedLog = logs.find((entry) => entry.event === 'llama.server.start_skipped_reused');
  assert.ok(reusedLog, 'must log llama.server.start_skipped_reused on the reused branch');
  assert.equal(reusedLog.fields.baseUrl, 'http://127.0.0.1:8033/v1');
  assert.ok(
    !logs.some((entry) => entry.event === 'llama.server.started'),
    'the reused branch must NOT log llama.server.started'
  );

  const readyMark = marks.find((m) => m.mark === 'llama-server-ready');
  assert.ok(readyMark, 'must emit llama-server-ready audit mark');
  assert.equal(readyMark.fields.reused, true, 'ready mark must record reused:true');
});

test('startLlamaServerBeforeBackend applies the selected Qwen3.8 llama-server profile', async (t) => {
  const original = llamaLifecycle.startLlamaServer;
  let startArgs = null;
  llamaLifecycle.startLlamaServer = async (opts) => {
    startArgs = opts;
    return { reused: true, baseUrl: 'http://127.0.0.1:8033/v1', pid: 0 };
  };
  t.after(() => { llamaLifecycle.startLlamaServer = original; });

  const controller = buildStartController({
    env: {
      JENNY_LLAMA_SERVER_AUTOSTART: '1',
      JENNY_LLAMA_SERVER_PROFILE: 'qwen3.8-27b-ud-iq3-s-128k',
    },
    logs: [],
    marks: [],
    userDataPath: 'C:/jenny-user-data',
    rootDir: path.resolve(__dirname, '..'),
  });

  await controller.startLlamaServerBeforeBackend();

  assert.equal(startArgs.modelTag, 'qwen3.8:27b-ud-iq3-s');
  assert.equal(startArgs.contextSize, 131072);
  assert.ok(startArgs.extraArgs.includes('--no-mmproj'));
  assert.deepEqual(
    startArgs.extraArgs.slice(0, 2),
    ['--parallel', '1'],
    'the profile must force one server slot'
  );
});

test('startLlamaServerBeforeBackend fails closed when an explicit profile is invalid', async (t) => {
  const original = llamaLifecycle.startLlamaServer;
  let called = false;
  llamaLifecycle.startLlamaServer = async () => { called = true; return {}; };
  t.after(() => { llamaLifecycle.startLlamaServer = original; });

  const logs = [];
  const marks = [];
  const controller = buildStartController({
    env: {
      JENNY_LLAMA_SERVER_AUTOSTART: '1',
      JENNY_LLAMA_SERVER_PROFILE: '../outside',
    },
    logs,
    marks,
    userDataPath: 'C:/jenny-user-data',
  });

  await controller.startLlamaServerBeforeBackend();

  assert.equal(called, false);
  assert.equal(marks.length, 0);
  assert.deepEqual(
    logs.find((entry) => entry.event === 'llama.server.profile_invalid').fields,
    { profileId: '../outside', error: 'invalid_profile_id' }
  );
});

test('startLlamaServerBeforeBackend logs started with baseUrl+pid when a fresh server is launched', async (t) => {
  const original = llamaLifecycle.startLlamaServer;
  llamaLifecycle.startLlamaServer = async () => ({
    reused: false,
    baseUrl: 'http://127.0.0.1:8033/v1',
    pid: 4321,
  });
  t.after(() => { llamaLifecycle.startLlamaServer = original; });

  const logs = [];
  const marks = [];
  const controller = buildStartController({
    env: { JENNY_LLAMA_SERVER_AUTOSTART: 'true' },
    logs,
    marks,
    userDataPath: 'C:/jenny-user-data',
  });

  await controller.startLlamaServerBeforeBackend();

  const startedLog = logs.find((entry) => entry.event === 'llama.server.started');
  assert.ok(startedLog, 'must log llama.server.started on the fresh-launch branch');
  assert.equal(startedLog.fields.baseUrl, 'http://127.0.0.1:8033/v1');
  assert.equal(startedLog.fields.pid, 4321, 'started log must carry the spawned pid');
  assert.ok(
    !logs.some((entry) => entry.event === 'llama.server.start_skipped_reused'),
    'the fresh-launch branch must NOT log start_skipped_reused'
  );

  const readyMark = marks.find((m) => m.mark === 'llama-server-ready');
  assert.ok(readyMark, 'must emit llama-server-ready audit mark');
  assert.equal(readyMark.fields.reused, false, 'ready mark must record reused:false');
  assert.equal(readyMark.fields.pid, 4321, 'ready mark must carry the spawned pid');
});

test('startLlamaServerBeforeBackend logs start_failed and a failed audit mark when startup rejects', async (t) => {
  const original = llamaLifecycle.startLlamaServer;
  llamaLifecycle.startLlamaServer = async () => {
    throw new Error('boom-launch-failure');
  };
  t.after(() => { llamaLifecycle.startLlamaServer = original; });

  const logs = [];
  const marks = [];
  const controller = buildStartController({
    env: { JENNY_LLAMA_SERVER_AUTOSTART: 'yes' },
    logs,
    marks,
    userDataPath: 'C:/jenny-user-data',
  });

  await controller.startLlamaServerBeforeBackend();

  const failedLog = logs.find((entry) => entry.event === 'llama.server.start_failed');
  assert.ok(failedLog, 'must log llama.server.start_failed when startup rejects');
  assert.equal(failedLog.level, 'WARN');
  assert.equal(failedLog.fields.message, 'boom-launch-failure', 'failure log must carry the error message');

  const failedMark = marks.find((m) => m.mark === 'llama-server-failed');
  assert.ok(failedMark, 'must emit llama-server-failed audit mark on rejection');
  assert.equal(failedMark.fields.message, 'boom-launch-failure');
  assert.ok(
    !marks.some((m) => m.mark === 'llama-server-ready'),
    'no ready mark should be emitted when startup fails'
  );
});

// ---------------------------------------------------------------------------
// stopRuntimeBeforeQuit: dependency disposal + delegation to runtime-stop.
//
// runtime-shutdown.js binds stopRuntimeWithDependencies via a destructured
// require (`const { stopRuntimeWithDependencies } = require('../runtime-stop')`),
// so the controller closes over that LOCAL binding and reassigning the property
// on the module object cannot intercept it. We therefore drive the REAL
// runtime-stop function and pin its observable effects through injected
// dependencies: backendService.stop receives the wired bundle, the controller's
// own emergency shutdown fires in the finally, and the 'done' lifecycle progress
// lands at the exported done-step index with the matching percent.
// ---------------------------------------------------------------------------

test('stopRuntimeBeforeQuit disposes dependencies, clears singletons, and drives the real runtime-stop with the controller wiring', async (t) => {
  // Patch the start helper to a no-op so no real handle exists.
  const originalStart = llamaLifecycle.startLlamaServer;
  llamaLifecycle.startLlamaServer = async () => ({ reused: false, baseUrl: '', pid: 0 });
  t.after(() => { llamaLifecycle.startLlamaServer = originalStart; });

  const calls = [];
  let packagedSmokeSetterArg = 'UNSET';
  let windowUnsubSetterArg = 'UNSET';
  const progressEvents = [];

  const packagedSmokeController = { dispose() { calls.push('packagedSmoke.dispose'); } };
  const updateService = { dispose() { calls.push('updateService.dispose'); } };
  const windowUnsubscribe = () => { calls.push('windowUnsubscribe'); };
  // The real stopRuntimeWithDependencies calls backendService.stop with the
  // phase->index map and step count we hand it; this is the channel that proves
  // SHUTDOWN_STEP_INDEX / SHUTDOWN_STEP_COUNT were forwarded.
  let backendStopArgs = null;
  const backendService = {
    async stop(opts) {
      calls.push('backendService.stop');
      backendStopArgs = opts;
      // Replay one progress callback so we can confirm the index mapping.
      opts.onProgress('sidecar_shutdown', 'Stopping sidecar');
    },
  };

  const controller = createRuntimeShutdownController({
    app: { getPath: () => '' },
    processRef: { env: {} },
    rootDir: '',
    clearSuggestionCache: () => {},
    suggestionCache: null,
    getBackendService: () => backendService,
    getPackagedSmokeController: () => packagedSmokeController,
    setPackagedSmokeController: (value) => {
      calls.push('setPackagedSmokeController');
      packagedSmokeSetterArg = value;
    },
    getUpdateService: () => updateService,
    getWindowStateDisplayUnsubscribe: () => windowUnsubscribe,
    setWindowStateDisplayUnsubscribe: (value) => {
      calls.push('setWindowStateDisplayUnsubscribe');
      windowUnsubSetterArg = value;
    },
    sendBridgeEvent: (channel, payload) => {
      if (channel === 'lifecycle.onProgress') {
        progressEvents.push(payload);
      }
    },
    log: () => {},
    // stopRuntimeBeforeQuit's runtime-stop finally reaches the emergency path;
    // neutralize the destructive shutdown helpers.
    ...createShutdownImplFakes().impls,
  });

  await controller.stopRuntimeBeforeQuit();

  // Disposal and singleton clears.
  assert.ok(calls.includes('packagedSmoke.dispose'), 'packaged-smoke controller must be disposed');
  assert.ok(calls.includes('setPackagedSmokeController'), 'packaged-smoke setter must be called');
  assert.equal(packagedSmokeSetterArg, null, 'packaged-smoke singleton must be cleared to null');

  assert.ok(calls.includes('updateService.dispose'), 'update service must be disposed');

  assert.ok(calls.includes('windowUnsubscribe'), 'window-state display unsubscribe must be invoked');
  assert.ok(calls.includes('setWindowStateDisplayUnsubscribe'), 'window-unsub setter must be called');
  assert.equal(windowUnsubSetterArg, null, 'window-unsub singleton must be cleared to null');

  // Delegation to the real runtime-stop: backendService.stop must run with the
  // any_local ollama scope.
  assert.ok(calls.includes('backendService.stop'), 'real runtime-stop must call backendService.stop');
  assert.ok(backendStopArgs, 'backendService.stop must receive options');
  assert.equal(backendStopArgs.ollamaShutdownScope, 'any_local');

  // The progress callback maps phase -> SHUTDOWN_STEP_INDEX. sidecar_shutdown is
  // index 2 of 7; the controller emitted it through emitLifecycleProgress.
  const sidecarProgress = progressEvents.find((p) => p.phase === 'sidecar_shutdown');
  assert.ok(sidecarProgress, 'a sidecar_shutdown progress event must be emitted');
  assert.equal(sidecarProgress.stepIndex, SHUTDOWN_STEP_INDEX.sidecar_shutdown);
  assert.equal(sidecarProgress.stepIndex, 2, 'sidecar_shutdown must map to step index 2');
  assert.equal(sidecarProgress.stepCount, 7, 'shutdownStepCount must be forwarded to the progress');

  // The terminal 'done' progress lands at the configured done-step index 6 of 7
  // -> Math.round(6/7*100) = 86.
  const doneProgress = progressEvents.find((p) => p.phase === 'done');
  assert.ok(doneProgress, 'a terminal done progress event must be emitted');
  assert.equal(doneProgress.stepIndex, 6, 'done must use shutdownDoneStepIndex 6');
  assert.equal(doneProgress.percent, 86, 'done percent must be Math.round(6/7*100) = 86');
});

test('stopRuntimeBeforeQuit forwards its own emergency shutdown impl into the real runtime-stop finally', async (t) => {
  const originalStart = llamaLifecycle.startLlamaServer;
  llamaLifecycle.startLlamaServer = async () => ({ reused: false, baseUrl: '', pid: 0 });
  t.after(() => { llamaLifecycle.startLlamaServer = originalStart; });

  // The emergency path drains session stores via getBackendService(); the real
  // runtime-stop finally calls runEmergencyShutdownImpl, which IS the
  // controller's runEmergencyRuntimeShutdownSync. Detect it by the drain.
  const drained = [];
  const backendService = {
    sessionStore: { dispose() { drained.push('sessionStore'); } },
    async stop() { /* succeed quietly */ },
  };

  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-stop-before-quit-'));
  trackDirectory(userDataPath);

  const controller = createRuntimeShutdownController({
    app: { getPath: () => userDataPath },
    processRef: { env: {} },
    rootDir: userDataPath,
    clearSuggestionCache: () => {},
    suggestionCache: null,
    getBackendService: () => backendService,
    log: () => {},
    // Neutralize the destructive shutdown helpers reached via the finally.
    ...createShutdownImplFakes().impls,
  });

  await controller.stopRuntimeBeforeQuit();

  // If runtime-stop did not call the controller's emergency impl, sessionStore
  // would never be drained.
  assert.deepEqual(
    drained,
    ['sessionStore'],
    'runtime-stop finally must invoke the controller runEmergencyRuntimeShutdownSync (which drains session stores)'
  );
});

test('stopRuntimeBeforeQuit flushes process logging last with a two-second bound', async () => {
  const order = [];
  const flushCalls = [];
  const logs = [];
  const controller = createRuntimeShutdownController({
    app: { getPath: () => '' },
    processRef: { env: {} },
    rootDir: '',
    clearSuggestionCache: () => {},
    suggestionCache: null,
    getBackendService: () => ({ async stop() { order.push('backend.stop'); } }),
    getProcessLogWriter: () => ({
      async flush(options) { flushCalls.push(options); order.push('logs.flush'); return { flushed: true }; },
    }),
    log: (level, event, fields) => logs.push({ level, event, fields }),
    ...createShutdownImplFakes().impls,
  });

  await controller.stopRuntimeBeforeQuit();

  assert.deepEqual(flushCalls, [{ timeoutMs: 2000 }]);
  assert.equal(order.at(-1), 'logs.flush');
  assert.ok(order.indexOf('backend.stop') < order.indexOf('logs.flush'));
  const shutdownStages = logs.filter((entry) => entry.event === 'runtime.shutdown_stage');
  assert.ok(shutdownStages.some((entry) => entry.fields.stage === 'backend_runtime'));
  assert.ok(shutdownStages.some((entry) => entry.fields.stage === 'process_log_flush'));
  assert.ok(shutdownStages.some((entry) => entry.fields.stage === 'total'));
  for (const entry of shutdownStages) {
    assert.equal(Number.isFinite(entry.fields.durationMs), true);
    assert.equal(Object.hasOwn(entry.fields, 'remainingBudgetMs'), true);
    assert.equal(typeof entry.fields.forced, 'boolean');
    assert.equal(typeof entry.fields.confirmed, 'boolean');
  }
});

test('process log flush failure is logged and cannot block shutdown', async () => {
  const logs = [];
  const controller = createRuntimeShutdownController({
    app: { getPath: () => '' }, processRef: { env: {} }, rootDir: '',
    clearSuggestionCache: () => {}, suggestionCache: null,
    getBackendService: () => ({ async stop() {} }),
    getProcessLogWriter: () => ({ async flush() { throw new Error('flush exploded'); } }),
    log: (level, event, fields) => logs.push({ level, event, fields }),
    ...createShutdownImplFakes().impls,
  });

  await assert.doesNotReject(() => controller.stopRuntimeBeforeQuit());
  assert.equal(logs.find((entry) => entry.event === 'logs.process_log_flush_failed').fields.message, 'flush exploded');
});

// ---------------------------------------------------------------------------
// stopRuntimeBeforeQuit: workspace terminal disposal is AWAITED in-sequence.
//
// Regression cover for the async-dispose race. Terminal teardown moved off an
// app.once('will-quit', …) hook — which drops async work and cannot delay quit —
// into this awaited sequence. WorkspaceTerminalService.dispose() is async (it
// awaits a Windows `taskkill /T /F` tree kill); WorkspacePtyService.dispose() is
// synchronous. Both must run before the controller delegates to runtime-stop, a
// throwing disposer must be isolated + logged, and — end to end — the process
// appExit must not fire until the async dispose has completed.
// ---------------------------------------------------------------------------

function createTerminalDrivenController({
  terminalService,
  ptyService,
  testRunnerService = null,
  backendService,
  log,
  userDataPath = '',
}) {
  return createRuntimeShutdownController({
    app: { getPath: () => userDataPath },
    processRef: { env: {} },
    rootDir: userDataPath,
    clearSuggestionCache: () => {},
    suggestionCache: null,
    getBackendService: () => backendService,
    getWorkspaceTerminalService: () => terminalService,
    getWorkspacePtyService: () => ptyService,
    getWorkspaceTestRunnerService: () => testRunnerService,
    log: log || (() => {}),
    // Neutralize the destructive sync shutdown helpers reached via the finally.
    ...createShutdownImplFakes().impls,
  });
}

test('stopRuntimeBeforeQuit awaits an async workspace-terminal dispose before delegating to runtime-stop', async (t) => {
  const originalStart = llamaLifecycle.startLlamaServer;
  llamaLifecycle.startLlamaServer = async () => ({ reused: false, baseUrl: '', pid: 0 });
  t.after(() => { llamaLifecycle.startLlamaServer = originalStart; });

  const order = [];
  let resolveDispose;
  const disposeGate = new Promise((resolve) => { resolveDispose = resolve; });
  const terminalService = {
    async dispose() { await disposeGate; order.push('terminalDispose'); },
  };
  const backendService = { async stop() { order.push('backendStop'); } };

  const controller = createTerminalDrivenController({ terminalService, ptyService: null, backendService });

  const shutdownPromise = controller.stopRuntimeBeforeQuit();
  // Flush every ungated microtask; the sequence must PARK on the pending terminal
  // dispose and never reach runtime-stop (backendService.stop) until it resolves.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], 'runtime-stop must NOT run while the async terminal dispose is pending');

  resolveDispose();
  await shutdownPromise;

  assert.deepEqual(
    order,
    ['terminalDispose', 'backendStop'],
    'the async terminal dispose must complete BEFORE runtime-stop calls backendService.stop'
  );
});

test('stopRuntimeBeforeQuit disposes BOTH the async line-terminal and the sync pty services', async (t) => {
  const originalStart = llamaLifecycle.startLlamaServer;
  llamaLifecycle.startLlamaServer = async () => ({ reused: false, baseUrl: '', pid: 0 });
  t.after(() => { llamaLifecycle.startLlamaServer = originalStart; });

  const disposed = [];
  const terminalService = { async dispose() { disposed.push('terminal'); } };
  const ptyService = { dispose() { disposed.push('pty'); } }; // synchronous, mirrors WorkspacePtyService
  const backendService = { async stop() {} };

  const controller = createTerminalDrivenController({ terminalService, ptyService, backendService });
  await controller.stopRuntimeBeforeQuit();

  assert.ok(disposed.includes('terminal'), 'the piped line-terminal service must be disposed');
  assert.ok(disposed.includes('pty'), 'the ConPTY pty service must be disposed');
});

test('stopRuntimeBeforeQuit awaits the workspace test runner before backend shutdown', async (t) => {
  const originalStart = llamaLifecycle.startLlamaServer;
  llamaLifecycle.startLlamaServer = async () => ({ reused: false, baseUrl: '', pid: 0 });
  t.after(() => { llamaLifecycle.startLlamaServer = originalStart; });

  const order = [];
  let resolveDispose;
  const disposeGate = new Promise((resolve) => { resolveDispose = resolve; });
  const testRunnerService = {
    async dispose() {
      await disposeGate;
      order.push('testRunnerDispose');
    },
  };
  const backendService = { async stop() { order.push('backendStop'); } };
  const controller = createTerminalDrivenController({
    terminalService: null,
    ptyService: null,
    testRunnerService,
    backendService,
  });

  const shutdownPromise = controller.stopRuntimeBeforeQuit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], 'backend shutdown must wait for the test runner process tree');

  resolveDispose();
  await shutdownPromise;
  assert.deepEqual(order, ['testRunnerDispose', 'backendStop']);
});

test('a failing workspace test runner disposer is isolated and identified', async (t) => {
  const originalStart = llamaLifecycle.startLlamaServer;
  llamaLifecycle.startLlamaServer = async () => ({ reused: false, baseUrl: '', pid: 0 });
  t.after(() => { llamaLifecycle.startLlamaServer = originalStart; });

  const logs = [];
  const disposed = [];
  let backendStopped = false;
  const controller = createTerminalDrivenController({
    terminalService: { dispose() { disposed.push('terminal'); } },
    ptyService: { dispose() { disposed.push('pty'); } },
    testRunnerService: { async dispose() { throw new Error('runner-tree-kill-failed'); } },
    backendService: { async stop() { backendStopped = true; } },
    log: (level, event, fields) => { logs.push({ level, event, fields }); },
  });

  await controller.stopRuntimeBeforeQuit();

  const failure = logs.find((entry) => entry.event === 'workspace.process.dispose_failed');
  assert.ok(failure, 'the failing runner disposer must emit a process disposal warning');
  assert.equal(failure.fields.service, 'workspaceTestRunner');
  assert.equal(failure.fields.message, 'runner-tree-kill-failed');
  assert.deepEqual(disposed.sort(), ['pty', 'terminal']);
  assert.equal(backendStopped, true);
});

test('a throwing terminal disposer is logged and does not block the pty disposer or backend shutdown', async (t) => {
  const originalStart = llamaLifecycle.startLlamaServer;
  llamaLifecycle.startLlamaServer = async () => ({ reused: false, baseUrl: '', pid: 0 });
  t.after(() => { llamaLifecycle.startLlamaServer = originalStart; });

  const logs = [];
  const disposed = [];
  let backendStopped = false;
  const terminalService = { async dispose() { throw new Error('taskkill-exploded'); } };
  const ptyService = { dispose() { disposed.push('pty'); } };
  const backendService = { async stop() { backendStopped = true; } };

  const controller = createTerminalDrivenController({
    terminalService,
    ptyService,
    backendService,
    log: (level, event, fields) => { logs.push({ level, event, fields }); },
  });

  await controller.stopRuntimeBeforeQuit();

  const failLog = logs.find((entry) => entry.event === 'workspace.process.dispose_failed');
  assert.ok(failLog, 'a failing terminal dispose must be logged as workspace.process.dispose_failed');
  assert.equal(failLog.level, 'WARN');
  assert.equal(failLog.fields.service, 'workspaceTerminal', 'the log must name which disposer failed');
  assert.equal(failLog.fields.message, 'taskkill-exploded');
  assert.ok(disposed.includes('pty'), 'the pty disposer must still run after the terminal disposer throws');
  assert.equal(backendStopped, true, 'a failing terminal dispose must not block backend shutdown');
});

test('a SYNCHRONOUSLY-throwing disposer is isolated (converted to a rejection), logged, and still runs the sibling', async (t) => {
  const originalStart = llamaLifecycle.startLlamaServer;
  llamaLifecycle.startLlamaServer = async () => ({ reused: false, baseUrl: '', pid: 0 });
  t.after(() => { llamaLifecycle.startLlamaServer = originalStart; });

  const logs = [];
  const disposed = [];
  let backendStopped = false;
  // NON-async: dispose() throws synchronously (the real WorkspacePtyService.dispose
  // is synchronous). The Promise.resolve().then(...) wrapper must turn that into an
  // isolated rejection rather than an uncaught throw that aborts the .map() and
  // skips the sibling disposer — this is the wrapper's whole reason to exist.
  const terminalService = { dispose() { throw new Error('sync-taskkill-exploded'); } };
  const ptyService = { dispose() { disposed.push('pty'); } };
  const backendService = { async stop() { backendStopped = true; } };

  const controller = createTerminalDrivenController({
    terminalService,
    ptyService,
    backendService,
    log: (level, event, fields) => { logs.push({ level, event, fields }); },
  });

  await controller.stopRuntimeBeforeQuit();

  const failLog = logs.find((entry) => entry.event === 'workspace.process.dispose_failed');
  assert.ok(failLog, 'a synchronous throw in a disposer must be caught and logged as workspace.process.dispose_failed');
  assert.equal(failLog.fields.service, 'workspaceTerminal', 'the log must name which disposer threw');
  assert.equal(failLog.fields.message, 'sync-taskkill-exploded');
  assert.ok(disposed.includes('pty'), 'the sibling disposer must still run after a SYNC throw in the first disposer');
  assert.equal(backendStopped, true, 'a synchronous disposer throw must not block backend shutdown');
});

test('the full quit path (MainLifecycleController) awaits terminal disposal before appExit', async (t) => {
  const originalStart = llamaLifecycle.startLlamaServer;
  llamaLifecycle.startLlamaServer = async () => ({ reused: false, baseUrl: '', pid: 0 });
  t.after(() => { llamaLifecycle.startLlamaServer = originalStart; });

  const order = [];
  let resolveDispose;
  const disposeGate = new Promise((resolve) => { resolveDispose = resolve; });
  const terminalService = {
    async dispose() { await disposeGate; order.push('terminalDispose'); },
  };
  const backendService = { async stop() {} };

  const controller = createTerminalDrivenController({ terminalService, ptyService: null, backendService });
  const lifecycle = new MainLifecycleController({
    appExit: () => order.push('appExit'),
    stopRuntime: () => controller.stopRuntimeBeforeQuit(),
  });

  let preventDefaulted = false;
  const quitPromise = lifecycle.handleBeforeQuit({ preventDefault() { preventDefaulted = true; } });
  assert.equal(preventDefaulted, true, 'before-quit must be preventDefault-ed so async shutdown can run');

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], 'appExit must NOT fire while terminal disposal is still pending');

  resolveDispose();
  await quitPromise;

  assert.deepEqual(
    order,
    ['terminalDispose', 'appExit'],
    'terminal disposal must complete (happen-before) the appExit that ends the process'
  );
});

// ---------------------------------------------------------------------------
// Onboarding-download reaping: in-flight `ollama pull` children and installer
// downloads must be cancelled on BOTH shutdown paths (awaited + emergency).
// ---------------------------------------------------------------------------

test('emergency runtime shutdown reaps in-flight setup pulls and installer children', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-emergency-reap-'));
  trackDirectory(userDataPath);
  const probe = createDrainProbeService();
  const fakes = createShutdownImplFakes();
  const reaped = [];
  const logs = [];
  const controller = createController(probe.service, userDataPath, {
    ...fakes.impls,
    log: (level, event, details) => logs.push({ level, event, details }),
    getSetupService: () => ({ signalActivePulls() { reaped.push('pulls'); return 1; } }),
    getOllamaInstallService: () => ({ signalActiveInstalls() { reaped.push('installs'); return 1; } }),
  });

  controller.runEmergencyRuntimeShutdownSync();

  assert.deepEqual(reaped, ['pulls', 'installs'], 'emergency path must reap pulls then installs');
  const terminal = logs.find((entry) => entry.event === 'runtime.shutdown_stage'
    && entry.details.stage === 'emergency_fallback');
  assert.equal(terminal.details.confirmed, false, 'signalled setup children are not confirmed stopped');
  assert.equal(terminal.details.setupSignals, 2);
});

test('stopRuntimeBeforeQuit reaps in-flight setup downloads before stopping the runtime', async () => {
  const reaped = [];
  const calls = [];
  const backendService = {
    async stop() { calls.push('backendService.stop'); },
  };
  const controller = createRuntimeShutdownController({
    app: { getPath: () => '' },
    processRef: { env: {} },
    rootDir: '',
    clearSuggestionCache: () => {},
    suggestionCache: null,
    getBackendService: () => backendService,
    getSetupService: () => ({ disposeActivePulls() { reaped.push('pulls'); return 0; } }),
    getOllamaInstallService: () => ({ disposeActiveInstalls() { reaped.push('installs'); return 0; } }),
    log: () => {},
    ...createShutdownImplFakes().impls,
  });

  await controller.stopRuntimeBeforeQuit();

  assert.deepEqual(reaped.slice(0, 2), ['pulls', 'installs'], 'awaited path must reap before the runtime stop');
  assert.ok(calls.includes('backendService.stop'), 'the runtime stop still runs after the reap');
});

test('a throwing reap never blocks the rest of the shutdown sequence', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-emergency-reap-throw-'));
  trackDirectory(userDataPath);
  const probe = createDrainProbeService();
  const fakes = createShutdownImplFakes();
  const controller = createController(probe.service, userDataPath, {
    ...fakes.impls,
    getSetupService: () => ({ signalActivePulls() { throw new Error('reap boom'); } }),
    getOllamaInstallService: () => ({ signalActiveInstalls() { throw new Error('reap boom'); } }),
  });

  controller.runEmergencyRuntimeShutdownSync();

  assert.equal(fakes.calls.ollama.length, 1, 'the destructive shutdown helpers must still run');
  assert.deepEqual(
    probe.drained,
    ['sessionStore', 'shadowStore', 'turnEventJournal', 'terminalRepairStore']
  );
});
