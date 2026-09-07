'use strict';

const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createLlamaServerManager, normalizeSpec } = require('../services/main/llama-server-manager');

const PROFILE = Object.freeze({
  id: 'gemma4-12b',
  modelTag: 'gemma4:12b',
  contextSize: 32768,
  extraArgs: ['--flash-attn', 'on'],
  acceleration: null,
});

function makeSettings(overrides = {}) {
  return {
    autostart: true,
    binaryOverride: '',
    host: '127.0.0.1',
    port: 8033,
    profileId: 'gemma4-12b',
    profile: PROFILE,
    profileError: '',
    modelPathOverride: '',
    modelTagOverride: '',
    readinessTimeoutMs: 1000,
    ...overrides,
  };
}

function makeHarness({ settings = makeSettings(), accel, managed = null, acceleration = null, onReady = null, loadProfileImpl } = {}) {
  const calls = [];
  const logs = [];
  const marks = [];
  const launches = [];
  let clock = 1000;
  let nextPid = 100;
  // Each launch resolves to a handle whose stop/stopSync are recorded and whose
  // onExit hook is captured so a test can simulate a crash.
  const lifecycle = {
    async startLlamaServer(options) {
      launches.push(options);
      calls.push(`start:${options.modelTag}`);
      if (options.abortSignal && options.abortSignal.aborted) {
        throw new Error('readiness_aborted');
      }
      if (lifecycle.failNext) {
        const error = lifecycle.failNext;
        lifecycle.failNext = null;
        throw error;
      }
      if (lifecycle.pending) {
        await lifecycle.pending;
      }
      const pid = nextPid++;
      const handle = {
        pid,
        baseUrl: `http://127.0.0.1:${options.port}`,
        reused: Boolean(lifecycle.reuseNext),
        mmproj: lifecycle.reuseNext ? 'unknown' : lifecycle.projectorPath,
        apiKey: lifecycle.reuseNext ? '' : `key-${pid}`,
        onExit: options.onExit,
        async stop() {
          calls.push(`stop:${pid}`);
          if (lifecycle.stopGate) {
            await lifecycle.stopGate;
          }
          if (lifecycle.stopError) {
            const error = lifecycle.stopError;
            lifecycle.stopError = null;
            throw error;
          }
          if (lifecycle.stopUnconfirmed) {
            lifecycle.stopUnconfirmed = false;
            return { confirmed: false };
          }
          return { confirmed: true };
        },
        stopSync() { calls.push(`stopSync:${pid}`); },
      };
      lifecycle.reuseNext = false;
      lifecycle.lastHandle = handle;
      return handle;
    },
    resolveGgufPath: () => ({ path: 'G:/models/model.gguf', projectorPath: lifecycle.projectorPath }),
    resolveProjectorPath: () => lifecycle.projectorPath,
    sweepStaleApiKeyFiles(dir) { calls.push(`sweep:${dir}`); },
    failNext: null,
    pending: null,
    stopGate: null,
    stopError: null,
    stopUnconfirmed: false,
    reuseNext: false,
    projectorPath: '',
    lastHandle: null,
  };
  const resolverCalls = [];
  const transitions = [];
  const manager = createLlamaServerManager({
    onStateChange: (status) => {
      transitions.push(status.state);
      return status.state === 'ready' && onReady ? onReady(status) : undefined;
    },
    processRef: { env: {}, resourcesPath: '' },
    rootDir: 'G:/repo',
    userDataPath: 'G:/userData',
    getShellConfigService: () => ({
      getLocalEngines: () => ({ openaiCompatible: { port: 8033, apiUrl: '', acceleration, managed } }),
      getState: () => ({ featureOverrides: {} }),
    }),
    emitStartupAuditMark: (name, payload) => marks.push({ name, payload }),
    log: (level, event, payload) => logs.push({ level, event, payload }),
    lifecycle,
    loadProfileImpl,
    resolveLaunchAccelerationImpl: (options) => {
      resolverCalls.push(options);
      return accel || { mode: 'off', reason: 'flag_off', extraArgs: [], drafter: '', vramHeadroomMb: 0 };
    },
    resolveSettingsImpl: () => settings,
    buildFeatureFlagsImpl: () => ({ llama_server_acceleration: false }),
    now: () => ++clock,
  });
  return { manager, calls, logs, marks, launches, lifecycle, resolverCalls, transitions };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('starts stopped and startFromSettings honors autostart=false without launching', async () => {
  const h = makeHarness({ settings: makeSettings({ autostart: false }) });
  assert.equal(h.manager.getStatus().state, 'stopped');
  assert.equal(h.manager.getStatus().mmproj, '');
  assert.equal(h.manager.getStatus().accelerationReason, '');
  assert.equal(h.manager.getStatus().accelerationDrafter, '');
  const status = await h.manager.startFromSettings();
  assert.equal(status.state, 'stopped');
  assert.deepEqual(h.launches, []);
  assert.ok(h.logs.some((entry) => entry.event === 'llama.server.autostart_disabled'));
  assert.deepEqual(h.calls, ['sweep:G:/userData'], 'stale key files are swept even without a launch');
});

test('a launch resolves only after the ready observer settles (api key re-brokered first)', async () => {
  const gate = createDeferred();
  const h = makeHarness({ onReady: () => gate.promise });
  let settled = false;
  const starting = h.manager.start().then((status) => { settled = true; return status; });
  await tick();
  await tick();
  assert.equal(h.manager.getStatus().state, 'ready');
  assert.equal(settled, false, 'ensureRunning must wait for the observer');
  gate.resolve();
  assert.equal((await starting).state, 'ready');
  // A rejecting observer never fails the launch.
  const h2 = makeHarness({ onReady: () => Promise.reject(new Error('refresh failed')) });
  assert.equal((await h2.manager.start()).state, 'ready');
});

test('an exit reported for a pid other than the tracked child is ignored', async () => {
  const h = makeHarness();
  await h.manager.start();
  const { pid, onExit } = h.lifecycle.lastHandle;
  onExit({ pid: pid + 1000, code: 1, signal: null });
  assert.equal(h.manager.getStatus().state, 'ready', 'a retired attempt cannot crash its replacement');
  onExit({ pid, code: 1, signal: null });
  assert.equal(h.manager.getStatus().state, 'crashed');
});

test('ensureRunning relaunches when only the size tag differs', async () => {
  const h = makeHarness();
  await h.manager.ensureRunning({ modelTag: 'ornith:9b' });
  assert.equal(h.manager.getStatus().alias, 'ornith:9b');
  await h.manager.ensureRunning({ modelTag: 'ornith:9b' });
  assert.equal(h.launches.length, 1, 'same size tag is a no-op');
  const status = await h.manager.ensureRunning({ modelTag: 'ornith:27b' });
  assert.equal(h.launches.length, 2, 'another size of the family is another server');
  assert.equal(status.alias, 'ornith:27b');
});

test('a child that exits before its launch is recorded fails the launch instead of going ready', async () => {
  const h = makeHarness();
  const gate = createDeferred();
  h.lifecycle.pending = gate.promise;
  const starting = h.manager.start();
  await tick();
  assert.equal(h.manager.getStatus().state, 'starting');
  // The fake lifecycle hands out pid 100 first; the child dies while the
  // launch is still awaiting the handle.
  h.launches[0].onExit({ pid: 100, code: 1, signal: null });
  gate.resolve();
  const status = await starting;
  assert.equal(status.state, 'stopped');
  assert.equal(status.lastError, 'llama_server_exited:1');
  assert.equal(h.manager.getApiKey(), '');
  // A dead child from a RETIRED attempt (other pid) does not poison the launch.
  const h2 = makeHarness();
  const gate2 = createDeferred();
  h2.lifecycle.pending = gate2.promise;
  const starting2 = h2.manager.start();
  await tick();
  h2.launches[0].onExit({ pid: 4242, code: 1, signal: null });
  gate2.resolve();
  assert.equal((await starting2).state, 'ready');
});

test('an unconfirmed stop keeps stop_unconfirmed on the status', async () => {
  const h = makeHarness();
  await h.manager.start();
  h.lifecycle.stopUnconfirmed = true;
  const stopped = await h.manager.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.lastError, 'stop_unconfirmed');
});

test('stop() does not queue behind a stalled ready observer, and settled() waits for the chain', async () => {
  const h = makeHarness({ onReady: () => new Promise(() => {}) });
  let started = false;
  const starting = h.manager.start().then((status) => { started = true; return status; });
  await tick();
  await tick();
  assert.equal(h.manager.getStatus().state, 'ready');
  assert.equal(started, false);
  const stopping = h.manager.stop();
  const startStatus = await starting;
  assert.equal(startStatus.state, 'ready', 'the launch resolves once the stop aborts the wait');
  assert.equal((await stopping).state, 'stopped');

  const h2 = makeHarness();
  const pending = h2.manager.start();
  const settled = h2.manager.settled();
  let settledFirst = null;
  await Promise.all([
    pending.then(() => { if (settledFirst === null) settledFirst = false; }),
    settled.then(() => { if (settledFirst === null) settledFirst = true; }),
  ]);
  assert.equal(settledFirst, false, 'settled() resolves after the queued launch');
  assert.equal((await settled).state, 'ready');
});

test('a failing stop keeps the error on the stopped status and a clean stop clears it', async () => {
  const h = makeHarness();
  await h.manager.start();
  h.lifecycle.stopError = new Error('taskkill_failed');
  const failed = await h.manager.stop();
  assert.equal(failed.state, 'stopped');
  assert.equal(failed.lastError, 'stop_failed:taskkill_failed');
  assert.ok(h.logs.some((entry) => entry.event === 'llama.server.stop_failed'));
  await h.manager.start();
  assert.equal((await h.manager.stop()).lastError, '');
});

test('startFromSettings launches with profile args, reaches ready, emits both audit marks', async () => {
  const h = makeHarness();
  const status = await h.manager.startFromSettings();
  assert.equal(status.state, 'ready');
  assert.equal(status.alias, 'gemma4:12b');
  assert.equal(status.port, 8033);
  assert.equal(status.pid, 100);
  assert.equal(status.reused, false);
  assert.equal(status.accelerationMode, 'off');
  assert.equal(h.manager.getApiKey(), 'key-100');
  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.launches[0].extraArgs, ['--flash-attn', 'on']);
  assert.equal(typeof h.launches[0].onExit, 'function');
  assert.deepEqual(h.marks.map((mark) => mark.name), ['llama-server-start', 'llama-server-ready']);
  // Flag-off ready mark stays byte-identical to the pre-feature payload.
  assert.deepEqual(h.marks[1].payload, { source: 'main', reused: false, pid: 100 });
  // The resolver saw the exact profile object (no synthetic override view).
  assert.equal(h.resolverCalls[0].profile, PROFILE);
});

test('start failure records lastError, returns to stopped, emits failed mark, and a later start recovers', async () => {
  const h = makeHarness();
  h.lifecycle.failNext = new Error('spawn_failed:ENOENT');
  const failed = await h.manager.start();
  assert.equal(failed.state, 'stopped');
  assert.equal(failed.lastError, 'spawn_failed:ENOENT');
  assert.equal(h.manager.getApiKey(), '');
  assert.ok(h.marks.some((mark) => mark.name === 'llama-server-failed'));
  assert.ok(h.logs.some((entry) => entry.event === 'llama.server.start_failed'));
  const recovered = await h.manager.start();
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.lastError, '');
});

test('spawn failure with acceleration args retries once without them and reports mode off', async () => {
  const accel = { mode: 'mtp', reason: 'eligible', extraArgs: ['--spec-type', 'draft-mtp'], drafter: 'mtp-x.gguf', vramHeadroomMb: 1200 };
  const h = makeHarness({ accel });
  h.lifecycle.projectorPath = 'G:/models/mmproj-F16.gguf';
  h.lifecycle.failNext = new Error('spawn_failed:exit 1');
  const status = await h.manager.start();
  assert.equal(status.state, 'ready');
  assert.equal(status.accelerationMode, 'off');
  assert.equal(status.accelerationReason, 'spawn_failed');
  assert.equal(status.accelerationDrafter, 'mtp-x.gguf');
  assert.equal(h.launches.length, 2);
  assert.deepEqual(h.launches[0].extraArgs, ['--flash-attn', 'on', '--spec-type', 'draft-mtp']);
  assert.deepEqual(h.launches[1].extraArgs, ['--flash-attn', 'on']);
  assert.equal(h.launches[0].projectorPath, 'G:/models/mmproj-F16.gguf');
  assert.equal(h.launches[1].projectorPath, 'G:/models/mmproj-F16.gguf');
  assert.ok(h.logs.some((entry) => entry.event === 'llama.server.acceleration_fallback'));
  assert.equal(h.marks[1].payload.accelerationMode, 'off');
});

test('accelerated launch reports its mode; a reused server reports unknown and is never stopped', async () => {
  const accel = { mode: 'mtp', reason: 'eligible', extraArgs: ['--spec-type', 'draft-mtp'], drafter: 'mtp-x.gguf', vramHeadroomMb: 1200 };
  const h = makeHarness({ accel });
  h.lifecycle.projectorPath = 'G:/models/mmproj-F16.gguf';
  const ready = await h.manager.start();
  assert.equal(ready.accelerationMode, 'mtp');
  assert.equal(ready.accelerationReason, 'eligible');
  assert.equal(ready.accelerationDrafter, 'mtp-x.gguf');
  assert.equal(ready.mmproj, 'G:/models/mmproj-F16.gguf');
  const firstStopped = await h.manager.stop();
  assert.equal(firstStopped.mmproj, '');
  assert.equal(firstStopped.accelerationReason, '');
  assert.equal(firstStopped.accelerationDrafter, '');

  h.lifecycle.reuseNext = true;
  const reused = await h.manager.start();
  assert.equal(reused.state, 'ready');
  assert.equal(reused.reused, true);
  assert.equal(reused.accelerationMode, 'unknown');
  assert.equal(reused.accelerationReason, 'unknown');
  assert.equal(reused.accelerationDrafter, '');
  assert.equal(reused.mmproj, 'unknown');
  assert.equal(h.manager.getApiKey(), '');
  const callsBefore = h.calls.length;
  const stopped = await h.manager.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.mmproj, '');
  assert.equal(h.calls.length, callsBefore, 'reused handle must not be stopped');
});

test('ensureRunning relaunches a spawned text-only server when its model gains a projector', async () => {
  const h = makeHarness();
  await h.manager.start({ modelTag: 'gemma4:12b' });
  assert.equal(h.manager.getStatus().mmproj, '');
  await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  assert.equal(h.launches.length, 1, 'unchanged projector availability is a no-op');

  h.lifecycle.projectorPath = 'G:/models/mmproj-F16.gguf';
  const relaunched = await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  assert.equal(h.launches.length, 2);
  assert.equal(relaunched.mmproj, 'G:/models/mmproj-F16.gguf');
  assert.equal(h.launches[1].projectorPath, 'G:/models/mmproj-F16.gguf');
});

test('child exit while ready moves to crashed with a WARN and does not respawn', async () => {
  const h = makeHarness({
    accel: { mode: 'mtp', reason: 'eligible', extraArgs: ['--spec-type', 'draft-mtp'], drafter: 'mtp-x.gguf', vramHeadroomMb: 1200 },
  });
  h.lifecycle.projectorPath = 'G:/models/mmproj-F16.gguf';
  const ready = await h.manager.start();
  assert.equal(ready.accelerationReason, 'eligible');
  assert.equal(ready.accelerationDrafter, 'mtp-x.gguf');
  h.lifecycle.lastHandle.onExit({ code: 139, signal: null });
  const status = h.manager.getStatus();
  assert.equal(status.state, 'crashed');
  assert.equal(status.pid, 0);
  assert.equal(status.mmproj, '');
  assert.equal(status.accelerationReason, '');
  assert.equal(status.accelerationDrafter, '');
  assert.equal(status.lastError, 'llama_server_exited:139');
  assert.equal(h.manager.getApiKey(), '');
  const warn = h.logs.find((entry) => entry.event === 'llama.server.crashed_pending_recovery');
  assert.ok(warn);
  assert.equal(warn.level, 'WARN');
  assert.equal(warn.payload.code, 139);
  assert.equal(h.launches.length, 1, 'no automatic respawn');
});

test('ensureRunning relaunches from crashed, is a no-op for the same alias, restarts for a different alias', async () => {
  const h = makeHarness();
  await h.manager.start();
  h.lifecycle.lastHandle.onExit({ code: 1 });
  const recovered = await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  assert.equal(recovered.state, 'ready');
  assert.equal(h.launches.length, 2);

  const same = await h.manager.ensureRunning({ modelTag: 'Gemma4:12B' });
  assert.equal(same.state, 'ready');
  assert.equal(h.launches.length, 2, 'same canonical alias is a no-op');

  const pidBefore = same.pid;
  const switched = await h.manager.ensureRunning({ modelTag: 'qwen3:8b' });
  assert.equal(switched.state, 'ready');
  assert.equal(switched.alias, 'qwen3:8b');
  assert.equal(h.launches.length, 3);
  assert.deepEqual(
    h.calls.slice(-2),
    [`stop:${pidBefore}`, 'start:qwen3:8b'],
    'old server stops before the new one starts'
  );
  // A steered model gets a profile view carrying the requested tag.
  assert.equal(h.resolverCalls.at(-1).profile.modelTag, 'qwen3:8b');
  assert.deepEqual(h.resolverCalls.at(-1).profile.extraArgs, PROFILE.extraArgs);
});

test('a stale exit hook from a replaced server cannot move the state', async () => {
  const h = makeHarness();
  await h.manager.start();
  const first = h.lifecycle.lastHandle;
  await h.manager.restart({ modelTag: 'qwen3:8b' });
  first.onExit({ code: 0 });
  assert.equal(h.manager.getStatus().state, 'ready');
  assert.equal(h.manager.getStatus().alias, 'qwen3:8b');
});

test('spec mtp overrides the persisted shell acceleration and drops junk keys', async () => {
  const h = makeHarness({ acceleration: { mode: 'off', draftNMax: 2 } });
  await h.manager.start({
    modelTag: 'gemma4:12b',
    mtp: { mode: 'mtp', draftNMax: 3 },
    extraArgs: ['--evil'],
    binaryPath: 'C:/evil.exe',
  });
  assert.deepEqual(h.resolverCalls[0].shellAcceleration, { mode: 'mtp', draftNMax: 3 });
  assert.equal(h.resolverCalls[0].profile.acceleration, null, 'spec mtp wins over profile acceleration');
  assert.deepEqual(h.launches[0].extraArgs, ['--flash-attn', 'on']);
  assert.equal(h.launches[0].binaryPath, '');

  assert.equal(normalizeSpec({ extraArgs: ['x'] }), null);
  assert.deepEqual(normalizeSpec({ modelPath: 'a.txt', mtp: { mode: 'mtp', draftNMax: 9 } }), { mtp: { mode: 'mtp' } });
  // Ollama's blob copy of a GGUF is extensionless: `sha256-<64 hex>` launches, a lookalike does not.
  const blobPath = path.join(os.tmpdir(), 'blobs', 'sha256-' + 'a'.repeat(64));
  assert.deepEqual(normalizeSpec({ modelPath: blobPath }), { modelPath: blobPath });
  assert.equal(normalizeSpec({ modelPath: path.join(os.tmpdir(), 'blobs', 'sha256-nothex') }), null);
  // Absolute on every platform (a drive-rooted literal is relative on POSIX);
  // the upper-case extension is the point of the case.
  const upperCaseGguf = path.resolve('m', 'main.GGUF');
  assert.deepEqual(normalizeSpec({ modelPath: upperCaseGguf, profileId: 'Gemma4-12B' }), {
    modelPath: upperCaseGguf,
    profileId: 'gemma4-12b',
  });
  assert.equal(normalizeSpec({ modelPath: '../../evil.gguf' }), null, 'relative model paths are dropped');
});

test('a start that arrives during a stop waits for it and ends with one live server', async () => {
  const h = makeHarness();
  await h.manager.start();
  const firstPid = h.lifecycle.lastHandle.pid;
  const gate = createDeferred();
  h.lifecycle.stopGate = gate.promise;
  const stopping = h.manager.stop();
  await tick();
  assert.equal(h.manager.getStatus().state, 'stopping');
  const starting = h.manager.start();
  assert.equal(h.launches.length, 1, 'start must not launch while the stop is in flight');
  gate.resolve();
  const [stopped, started] = await Promise.all([stopping, starting]);
  assert.equal(stopped.state, 'stopped');
  assert.equal(started.state, 'ready');
  assert.equal(h.launches.length, 2);
  assert.deepEqual(h.calls, [`start:gemma4:12b`, `stop:${firstPid}`, `start:gemma4:12b`]);
  assert.equal(h.manager.getStatus().state, 'ready', 'the stop must not clobber the later start');
  assert.equal(h.manager.getApiKey(), `key-${h.lifecycle.lastHandle.pid}`);
});

test('explicit start while ready relaunches only when the spec differs', async () => {
  const h = makeHarness();
  await h.manager.start({ modelTag: 'gemma4:12b' });
  assert.equal(h.launches.length, 1);
  const same = await h.manager.start({ modelTag: 'gemma4:12b' });
  assert.equal(same.state, 'ready');
  assert.equal(h.launches.length, 1, 'same model is a no-op');
  const switched = await h.manager.start({ modelTag: 'qwen3:8b' });
  assert.equal(switched.alias, 'qwen3:8b');
  assert.equal(h.launches.length, 2, 'a different model replaces the server');
  // Same alias, different MTP setting: also a relaunch — the args changed.
  await h.manager.ensureRunning({ modelTag: 'qwen3:8b', mtp: { mode: 'mtp', draftNMax: 4 } });
  assert.equal(h.launches.length, 3);
  assert.deepEqual(h.resolverCalls.at(-1).shellAcceleration, { mode: 'mtp', draftNMax: 4 });
  await h.manager.ensureRunning({ modelTag: 'qwen3:8b', mtp: { mode: 'mtp', draftNMax: 4 } });
  assert.equal(h.launches.length, 3, 'identical MTP setting is a no-op');
});

test('restart and crash recovery without a spec relaunch the last spec', async () => {
  const h = makeHarness();
  await h.manager.start({ modelTag: 'qwen3:8b', mtp: { mode: 'mtp', draftNMax: 3 } });
  const restarted = await h.manager.restart();
  assert.equal(restarted.state, 'ready');
  assert.equal(restarted.alias, 'qwen3:8b', 'restart keeps the running model');
  assert.deepEqual(h.resolverCalls[1].shellAcceleration, { mode: 'mtp', draftNMax: 3 });
  h.lifecycle.lastHandle.onExit({ code: 1 });
  const recovered = await h.manager.ensureRunning();
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.alias, 'qwen3:8b', 'recovery keeps the crashed model');
  assert.deepEqual(h.resolverCalls[2].shellAcceleration, { mode: 'mtp', draftNMax: 3 });
  assert.equal(h.launches.length, 3);
});

test('state transitions are observable and stopSync retires a launch that completes afterwards', async () => {
  const h = makeHarness();
  await h.manager.start();
  assert.deepEqual(h.transitions, ['starting', 'ready']);
  await h.manager.stop();
  assert.deepEqual(h.transitions.slice(2), ['stopping', 'stopped']);

  const gate = createDeferred();
  h.lifecycle.pending = gate.promise;
  const starting = h.manager.start();
  await tick();
  assert.equal(h.manager.getStatus().state, 'starting');
  h.manager.stopSync();
  gate.resolve();
  const status = await starting;
  assert.equal(status.state, 'stopped');
  assert.equal(h.manager.getStatus().state, 'stopped', 'a late launch must not resurrect the state');
  assert.ok(h.calls.includes(`stopSync:${h.lifecycle.lastHandle.pid}`), 'the late child is killed');
  assert.equal(h.manager.getApiKey(), '');
});

test('stop is idempotent and aborts an in-flight startup', async () => {
  const h = makeHarness();
  assert.equal((await h.manager.stop()).state, 'stopped');

  const gate = createDeferred();
  h.lifecycle.pending = gate.promise;
  const starting = h.manager.start();
  await tick();
  assert.equal(h.manager.getStatus().state, 'starting');
  assert.equal(h.launches[0].abortSignal.aborted, false);
  const stopping = h.manager.stop();
  assert.equal(h.launches[0].abortSignal.aborted, true, 'stop aborts the startup signal');
  gate.resolve();
  await starting;
  const stopped = await stopping;
  assert.equal(stopped.state, 'stopped');
  assert.equal(h.manager.getApiKey(), '');
  // The server that finished coming up after the abort was stopped, not leaked.
  assert.ok(h.calls.includes(`stop:${h.lifecycle.lastHandle.pid}`));
});

test('concurrent start calls coalesce into one launch', async () => {
  const h = makeHarness();
  const gate = createDeferred();
  h.lifecycle.pending = gate.promise;
  const a = h.manager.start();
  const b = h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  gate.resolve();
  const [statusA, statusB] = await Promise.all([a, b]);
  assert.equal(statusA.state, 'ready');
  assert.equal(statusB.state, 'ready');
  assert.equal(h.launches.length, 1);
});

test('stopSync kills the tracked child synchronously and resets state', async () => {
  const h = makeHarness();
  await h.manager.start();
  const pid = h.lifecycle.lastHandle.pid;
  h.manager.stopSync();
  assert.ok(h.calls.includes(`stopSync:${pid}`));
  assert.equal(h.manager.getStatus().state, 'stopped');
  assert.equal(h.manager.getApiKey(), '');
  h.manager.stopSync(); // idempotent
});

test('invalid profile is surfaced without launching', async () => {
  const h = makeHarness({ settings: makeSettings({ profile: null, profileError: 'profile_not_found:nope', profileId: 'nope' }) });
  const status = await h.manager.start();
  assert.equal(status.state, 'stopped');
  assert.equal(status.lastError, 'profile_invalid:profile_not_found:nope');
  assert.deepEqual(h.launches, []);
  assert.ok(h.logs.some((entry) => entry.event === 'llama.server.profile_invalid'));
});

test('invalid profile stops a ready text-only server without throwing', async () => {
  const h = makeHarness({
    loadProfileImpl: () => ({ profile: null, error: 'profile_not_found:nope' }),
  });
  await h.manager.start();

  const status = await h.manager.ensureRunning({ profileId: 'nope' });

  assert.equal(status.state, 'stopped');
  assert.equal(status.lastError, 'profile_invalid:profile_not_found:nope');
  assert.equal(h.launches.length, 1);
});
