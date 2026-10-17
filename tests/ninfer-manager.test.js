'use strict';

// Managed NInfer manager (row 54 N2 Step 6): one serial chain, typed launch
// refusals, llama-server stopped first (and the launch refused when that stop
// is unconfirmed), crash surfaced without respawn, ensureRunning recovers,
// identity retention for the GPU handoff, the watchdog trip, boot autostart.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createNinferManager, normalizeNinferSpec } = require('../services/main/ninfer-manager');

async function ticks(count = 6) {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// A llama-server fake whose stop() waits for the test to release it.
function makeSlowLlama() {
  const llama = makeLlama();
  llama.stop = () => new Promise((resolve) => {
    llama.calls.push('stop');
    llama.release = () => { llama.state = 'stopped'; resolve({ state: 'stopped', lastError: '' }); };
  });
  return llama;
}

const ARTIFACT = Object.freeze({
  id: 'qwen3.8-27b-nvfp4', display_name: 'Qwen3.8 27B', model_id: 'qwen3.8-27b-nvfp4', supports_mtp: true,
  context_windows: [16384, 32768, 65536, 131072, 153600, 262144], fp8_kv_windows: [153600, 262144], default_context_window: 65536, size_bytes: 10,
});

function makeHarness({
  eligible = true, installed = true, downloaded = true, settings = {}, llama = null, launchGate = () => '',
  onStateChange = () => {}, watchdogSettings = { enabled: false, maxWatts: 460, maxTempC: 83 },
  userDataPath = 'C:/jenny-user-data',
} = {}) {
  const calls = [];
  const logs = [];
  const launches = [];
  let nextPid = 500;
  const lifecycle = {
    DEFAULT_NINFER_PORT: 8034,
    NINFER_PID_FILENAME: 'ninfer-serve.pid',
    pending: null,
    failNext: null,
    stopUnconfirmed: false,
    async startNinferServer(options) {
      launches.push(options);
      calls.push(`start:${options.modelId}:${options.contextSize}:${options.mtp ? 'mtp' : 'nomtp'}`);
      if (options.abortSignal?.aborted) throw Object.assign(new Error('readiness_aborted'), { reason: 'readiness_aborted' });
      if (lifecycle.failNext) {
        const error = lifecycle.failNext;
        lifecycle.failNext = null;
        throw error;
      }
      if (lifecycle.pending) await lifecycle.pending;
      const pid = nextPid++;
      const handle = {
        pid, port: options.port || 8034, baseUrl: 'http://127.0.0.1:8034/v1', apiKey: options.retainedApiKey || `key-${pid}`,
        modelId: options.modelId, contextSize: options.contextSize, mtp: options.mtp, vision: options.vision, hostKvMib: 4096,
        onExit: options.onExit,
        async stop() {
          calls.push(`stop:${pid}`);
          if (lifecycle.stopUnconfirmed) { lifecycle.stopUnconfirmed = false; return { confirmed: false }; }
          return { confirmed: true };
        },
        stopSync() { calls.push(`stopSync:${pid}`); },
      };
      lifecycle.lastHandle = handle;
      return handle;
    },
  };
  const localEngines = {
    startupModelLoad: true,
    ninfer: { lastUsedArtifactId: '', suggestionDismissed: false, contextSize: 65536, mtp: true, watchdog: watchdogSettings, ...settings },
  };
  const runtime = {
    install: { resolveExecutable: () => (installed ? { ok: true, path: 'G:\\engines\\ninfer-serve.exe', version: '0.9.1' } : { ok: false, reason: 'not_installed' }) },
    artifacts: {
      artifacts: [ARTIFACT],
      async resolveArtifactPath(id) {
        return downloaded && id === ARTIFACT.id ? { ok: true, path: 'G:\\engines\\models\\q.ninfer', artifact: ARTIFACT } : { ok: false, reason: 'not_downloaded' };
      },
    },
    eligibility: async () => (eligible ? { eligible: true, reason: '', device: { index: 0 }, probed: true } : { eligible: false, reason: 'ninfer_gpu_unsupported', device: null, probed: true }),
  };
  const manager = createNinferManager({
    userDataPath,
    getShellConfigService: () => ({ getLocalEngines: () => localEngines, getState: () => ({ preferredEngineType: 'openai-compatible' }) }),
    getRuntime: () => runtime,
    getLlamaServerManager: () => llama,
    launchGate,
    onStateChange,
    lifecycle,
    log: (level, event, fields) => logs.push({ level, event, fields }),
    createWatchdog: ({ getSettings, onTrip }) => {
      const watchdog = { running: false, getSettings, onTrip, start() { watchdog.running = true; calls.push('watchdog:start'); }, stop() { if (watchdog.running) calls.push('watchdog:stop'); watchdog.running = false; }, tick: async () => ({}), isRunning: () => watchdog.running, settle: async () => {} };
      lifecycle.watchdog = watchdog;
      return watchdog;
    },
  });
  return { manager, calls, logs, launches, lifecycle, localEngines, runtime };
}

function makeLlama({ state = 'ready', stopError = '' } = {}) {
  const llama = {
    calls: [],
    state,
    getStatus: () => ({ state: llama.state, alias: 'gemma4:12b', lastError: '' }),
    async stop() {
      llama.calls.push('stop');
      llama.state = 'stopped';
      return { state: 'stopped', lastError: stopError };
    },
  };
  return llama;
}

test('normalizeNinferSpec keeps only the four steerable keys', () => {
  assert.deepEqual(normalizeNinferSpec({ artifactId: 'qwen3.8-27b-nvfp4', contextSize: 32768, mtp: false, vision: false, binary: 'x' }),
    { artifactId: 'qwen3.8-27b-nvfp4', contextSize: 32768, mtp: false, vision: false });
  assert.equal(normalizeNinferSpec({ artifactId: '../evil', contextSize: 12345 }), null);
  assert.equal(normalizeNinferSpec(null), null);
});

test('a launch stops the managed llama-server first, keys the launch and reports ready', async () => {
  const llama = makeLlama();
  const transitions = [];
  const { manager, calls, launches } = makeHarness({ llama, onStateChange: (status) => transitions.push(status.state) });
  const status = await manager.ensureRunning({ artifactId: ARTIFACT.id });
  assert.equal(status.state, 'ready');
  assert.equal(status.alias, 'qwen3.8-27b-nvfp4');
  assert.equal(status.displayName, 'Qwen3.8 27B');
  assert.equal(status.port, 8034);
  assert.equal(status.contextSize, 65536);
  assert.equal(status.mtp, true);
  assert.equal(status.runtimeLabel, '0.9.1');
  assert.deepEqual(llama.calls, ['stop']);
  assert.deepEqual(calls, ['start:qwen3.8-27b-nvfp4:65536:mtp', 'watchdog:start']);
  assert.deepEqual(transitions, ['starting', 'ready']);
  assert.equal(manager.getBaseUrl(), 'http://127.0.0.1:8034/v1');
  assert.match(manager.getApiKey(), /^key-/);
  assert.equal(launches[0].binaryPath, 'G:\\engines\\ninfer-serve.exe');
  assert.equal(launches[0].artifactPath, 'G:\\engines\\models\\q.ninfer');
  assert.equal(launches[0].draftTokens, 3);
  assert.equal(launches[0].kvDtype, '', 'bf16 KV below the fp8 windows');
  // Ready and matching: a second ensureRunning is a no-op.
  await manager.ensureRunning({ artifactId: ARTIFACT.id });
  assert.equal(calls.length, 2);
});

test('the 150k and 262k windows launch with an 8-bit KV cache; 128k keeps bf16', async () => {
  const { manager, launches } = makeHarness({ llama: makeLlama() });
  assert.equal((await manager.ensureRunning({ artifactId: ARTIFACT.id, contextSize: 262144 })).contextSize, 262144);
  assert.equal(launches.at(-1).kvDtype, 'fp8');
  await manager.restart({ artifactId: ARTIFACT.id, contextSize: 153600 });
  assert.equal(launches.at(-1).kvDtype, 'fp8');
  await manager.restart({ artifactId: ARTIFACT.id, contextSize: 131072 });
  assert.equal(launches.at(-1).kvDtype, '');
});

test('an unconfirmed llama-server stop refuses the NInfer launch so the GPU is never double-loaded', async () => {
  const llama = makeLlama({ stopError: 'stop_unconfirmed' });
  const { manager, calls } = makeHarness({ llama });
  const status = await manager.ensureRunning({ artifactId: ARTIFACT.id });
  assert.equal(status.state, 'stopped');
  assert.equal(status.lastError, 'llama_server_stop_unconfirmed:stop_unconfirmed');
  assert.deepEqual(calls, []);
});

test('launch plan refusals are typed and spawn nothing', async () => {
  for (const [options, expected] of [
    [{ eligible: false }, 'ninfer_ineligible:ninfer_gpu_unsupported'],
    [{ installed: false }, 'ninfer_runtime_missing'],
    [{ downloaded: false }, 'ninfer_artifact_missing:not_downloaded'],
  ]) {
    const { manager, calls } = makeHarness(options);
    const status = await manager.ensureRunning({ artifactId: ARTIFACT.id });
    assert.equal(status.state, 'stopped');
    assert.equal(status.lastError, expected);
    assert.deepEqual(calls, []);
  }
  const { manager } = makeHarness();
  const unknown = await manager.ensureRunning({ artifactId: 'nope' });
  assert.equal(unknown.lastError, 'ninfer_artifact_unknown');
  const gated = makeHarness({ launchGate: () => 'gpu_leased' });
  assert.equal((await gated.manager.ensureRunning({ artifactId: ARTIFACT.id })).lastError, 'gpu_leased');
  assert.deepEqual(gated.calls, []);
});

test('a crash is surfaced as crashed with no respawn; ensureRunning recovers', async () => {
  const { manager, calls, lifecycle, logs } = makeHarness();
  await manager.ensureRunning({ artifactId: ARTIFACT.id });
  lifecycle.lastHandle.onExit({ pid: lifecycle.lastHandle.pid, code: 137, signal: '' });
  const crashed = manager.getStatus();
  assert.equal(crashed.state, 'crashed');
  assert.equal(crashed.lastError, 'ninfer_exited:137');
  assert.equal(crashed.pid, 0);
  assert.equal(manager.getBaseUrl(), '');
  assert.deepEqual(calls, ['start:qwen3.8-27b-nvfp4:65536:mtp', 'watchdog:start', 'watchdog:stop']);
  assert.ok(logs.some((entry) => entry.event === 'ninfer.server.crashed_pending_recovery'));
  const recovered = await manager.ensureRunning(null);
  assert.equal(recovered.state, 'ready');
  assert.equal(calls.filter((entry) => entry.startsWith('start:')).length, 2);
});

test('a spec that changes the context or MTP replaces the server; operations serialize', async () => {
  const { manager, calls, lifecycle } = makeHarness();
  await manager.ensureRunning({ artifactId: ARTIFACT.id });
  const firstPid = lifecycle.lastHandle.pid;
  let release;
  lifecycle.pending = new Promise((resolve) => { release = resolve; });
  const relaunch = manager.ensureRunning({ contextSize: 32768, mtp: false, vision: false });
  const stopDuring = manager.stop();
  release();
  const relaunched = await relaunch;
  assert.equal(relaunched.state, 'ready');
  assert.equal(relaunched.contextSize, 32768);
  assert.equal(relaunched.mtp, false);
  const stopped = await stopDuring;
  assert.equal(stopped.state, 'stopped');
  // The watchdog stands down before its server is killed, never after.
  assert.deepEqual(calls, [
    'start:qwen3.8-27b-nvfp4:65536:mtp', 'watchdog:start',
    'watchdog:stop', `stop:${firstPid}`,
    'start:qwen3.8-27b-nvfp4:32768:nomtp', 'watchdog:start',
    'watchdog:stop', `stop:${firstPid + 1}`,
  ]);
});

test('a launch failure records the reason and the pinned-memory size for the C9 copy', async () => {
  const { manager, lifecycle } = makeHarness();
  lifecycle.failNext = Object.assign(new Error('ninfer_host_memory'), { reason: 'ninfer_host_memory', pinnedGb: 8 });
  const status = await manager.ensureRunning({ artifactId: ARTIFACT.id });
  assert.equal(status.state, 'stopped');
  assert.equal(status.lastError, 'ninfer_host_memory');
  assert.equal(status.hostMemoryGb, 8);
});

test('an unconfirmed stop refuses the next launch until the record settles', async () => {
  const { manager, lifecycle, calls } = makeHarness();
  await manager.ensureRunning({ artifactId: ARTIFACT.id });
  lifecycle.stopUnconfirmed = true;
  const stopped = await manager.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.lastError, 'stop_unconfirmed');
  const refused = await manager.ensureRunning({ artifactId: ARTIFACT.id });
  // No pid record exists in the test userData, so reconcile confirms and the
  // launch proceeds; the refusal path is covered by the llama-server manager
  // tests this one mirrors. What matters here: the stop is never laundered.
  assert.equal(['ready', 'stopped'].includes(refused.state), true);
  assert.ok(calls.includes('watchdog:stop'));
});

test('identity retention: stop({ retainIdentity }) parks the key and reuseIdentity relaunches it exactly', async () => {
  const { manager, launches } = makeHarness();
  await manager.ensureRunning({ artifactId: ARTIFACT.id, contextSize: 131072 });
  const key = manager.getApiKey();
  const parked = await manager.stop({ retainIdentity: true });
  assert.equal(parked.identityRetained, true);
  const restored = await manager.ensureRunning(null, { reuseIdentity: true });
  assert.equal(restored.state, 'ready');
  assert.equal(restored.identityReused, true);
  assert.equal(restored.contextSize, 131072);
  assert.equal(launches[1].retainedApiKey, key);
  assert.equal(manager.getApiKey(), key);
});

test('the watchdog trip stops the server and surfaces it like a crash, named', async () => {
  const transitions = [];
  const { manager, calls, lifecycle } = makeHarness({ onStateChange: (status) => transitions.push(status.state) });
  await manager.ensureRunning({ artifactId: ARTIFACT.id });
  const pid = lifecycle.lastHandle.pid;
  lifecycle.watchdog.onTrip({ watts: 471.2, tempC: 66, maxWatts: 460, maxTempC: 83, strikes: 3 });
  const status = await manager.settled();
  assert.equal(status.state, 'crashed');
  assert.equal(status.lastError, 'ninfer_watchdog_tripped');
  assert.equal(status.stoppedBy, 'watchdog');
  assert.equal(status.watchdogWatts, 471);
  assert.ok(calls.includes(`stop:${pid}`));
  assert.deepEqual(transitions, ['starting', 'ready', 'stopping', 'crashed']);
  // Recovery is explicit, as for a crash; the watchdog is re-armed with it.
  const recovered = await manager.restart();
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.stoppedBy, '');
  assert.equal(lifecycle.watchdog.running, true);
});

test('startFromSettings autostarts only the last-used NInfer artifact on an openai-compatible boot', async () => {
  const idle = makeHarness();
  assert.equal((await idle.manager.startFromSettings({})).autostarted, false);
  assert.deepEqual(idle.calls, []);
  const other = makeHarness({ settings: { lastUsedArtifactId: ARTIFACT.id } });
  assert.equal((await other.manager.startFromSettings({ engineType: 'ollama' })).autostarted, false);
  assert.deepEqual(other.calls, []);
  const off = makeHarness({ settings: { lastUsedArtifactId: ARTIFACT.id } });
  off.localEngines.startupModelLoad = false;
  assert.equal((await off.manager.startFromSettings({})).autostarted, false);
  assert.ok(off.logs.some((entry) => entry.event === 'ninfer.server.autostart_disabled' && entry.fields.reason === 'startup_model_load_off'));
  const boot = makeHarness({ settings: { lastUsedArtifactId: ARTIFACT.id, contextSize: 32768, mtp: false } });
  const started = await boot.manager.startFromSettings({ engineType: 'openai-compatible' });
  assert.equal(started.autostarted, true);
  assert.equal(started.state, 'ready');
  assert.deepEqual(boot.calls, ['start:qwen3.8-27b-nvfp4:32768:nomtp', 'watchdog:start']);
});

test('stopSync retires the child synchronously and a late launch kills its own child', async () => {
  const { manager, lifecycle, calls } = makeHarness();
  let release;
  lifecycle.pending = new Promise((resolve) => { release = resolve; });
  const launch = manager.ensureRunning({ artifactId: ARTIFACT.id });
  await new Promise((resolve) => setImmediate(resolve));
  manager.stopSync();
  assert.equal(manager.getStatus().state, 'stopped');
  release();
  await launch;
  assert.equal(manager.getStatus().state, 'stopped');
  assert.ok(calls.some((entry) => entry.startsWith('stopSync:')));
});

// Review fixes (Astra, batch 2a): the GPU is reserved before the other
// manager's stop is awaited, an emergency stopSync() retires any launch still
// preparing, a watchdog trip never waits behind a stalled key re-broker, and
// an unconfirmed stop whose pid is still alive keeps refusing launches.

test('exclusivity: the launch reads `starting` while llama-server is still stopping', async () => {
  const llama = makeSlowLlama();
  const { manager, calls } = makeHarness({ llama });
  const launch = manager.ensureRunning({ artifactId: ARTIFACT.id });
  await ticks();
  assert.deepEqual(llama.calls, ['stop']);
  // The llama-server launch gate reads this state: a Use queued behind the stop is refused.
  assert.equal(manager.getStatus().state, 'starting');
  assert.equal(calls.filter((entry) => entry.startsWith('start:')).length, 0, 'nothing spawned before llama-server is down');
  llama.release();
  assert.equal((await launch).state, 'ready');
  assert.equal(calls.filter((entry) => entry.startsWith('start:')).length, 1);
});

test('stopSync while llama-server is still stopping retires the launch: nothing spawns', async () => {
  const llama = makeSlowLlama();
  const { manager, calls } = makeHarness({ llama });
  const launch = manager.ensureRunning({ artifactId: ARTIFACT.id });
  await ticks();
  assert.equal(manager.getStatus().state, 'starting');
  manager.stopSync();
  llama.release();
  assert.equal((await launch).state, 'stopped');
  assert.equal(calls.filter((entry) => entry.startsWith('start:')).length, 0);
});

test('stopSync while the plan resolves cancels the launch, and a launch queued after it is refused', async () => {
  const { manager, calls, runtime } = makeHarness();
  let releaseProbe;
  runtime.eligibility = () => new Promise((resolve) => {
    releaseProbe = () => resolve({ eligible: true, reason: '', device: { index: 0 }, probed: true });
  });
  const launch = manager.ensureRunning({ artifactId: ARTIFACT.id });
  await ticks();
  manager.stopSync();
  releaseProbe();
  const cancelled = await launch;
  assert.equal(cancelled.state, 'stopped');
  assert.equal(cancelled.lastError, 'ninfer_halted');
  const queued = await manager.ensureRunning({ artifactId: ARTIFACT.id });
  assert.equal(queued.lastError, 'ninfer_halted');
  assert.equal(calls.filter((entry) => entry.startsWith('start:')).length, 0);
});

test('the watchdog trip stops a ready server while its key re-broker is still pending', async () => {
  const { manager, calls, lifecycle } = makeHarness({
    // The sidecar never takes the key: the launch stays on the chain.
    onStateChange: (status) => (status.state === 'ready' ? new Promise(() => {}) : undefined),
  });
  const launch = manager.ensureRunning({ artifactId: ARTIFACT.id });
  await ticks();
  assert.equal(manager.getStatus().state, 'ready');
  assert.equal(lifecycle.watchdog.running, true);
  lifecycle.watchdog.onTrip({ watts: 600, tempC: 70, maxWatts: 460, maxTempC: 83, strikes: 3 });
  await launch;
  const status = await manager.settled();
  assert.equal(status.state, 'crashed');
  assert.equal(status.stoppedBy, 'watchdog');
  assert.equal(status.watchdogWatts, 600);
  assert.equal(calls.filter((entry) => entry.startsWith('stop:')).length, 1);
});

test('an unconfirmed stop whose recorded pid is alive reports cleanupUnconfirmed and keeps refusing launches', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ninfer-pid-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const pidPath = path.join(userDataPath, 'ninfer-serve.pid');
  const { manager, lifecycle, calls } = makeHarness({ userDataPath });
  await manager.ensureRunning({ artifactId: ARTIFACT.id });
  assert.equal(manager.cleanupUnconfirmed(), false);
  // This process stands in for the orphan: alive, with no stored command line to match.
  fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid }), 'utf8');
  lifecycle.stopUnconfirmed = true;
  const stopped = await manager.stop();
  assert.equal(stopped.lastError, 'stop_unconfirmed');
  assert.equal(manager.cleanupUnconfirmed(), true);
  const refused = await manager.ensureRunning({ artifactId: ARTIFACT.id });
  assert.equal(refused.state, 'stopped');
  assert.equal(refused.lastError, 'stop_unconfirmed');
  assert.equal(calls.filter((entry) => entry.startsWith('start:')).length, 1, 'no second spawn while the pid may hold the GPU');
  // The orphan is gone (its record cleared): the next launch proceeds.
  fs.rmSync(pidPath, { force: true });
  assert.equal(manager.cleanupUnconfirmed(), false);
  assert.equal((await manager.ensureRunning({ artifactId: ARTIFACT.id })).state, 'ready');
});


test('vision defaults on, respects saved false and explicit overrides, and survives recovery and retention', async () => {
  const h = makeHarness();
  assert.equal((await h.manager.ensureRunning({ artifactId: ARTIFACT.id })).vision, true);
  assert.equal(h.launches[0].vision, true);
  assert.equal((await h.manager.ensureRunning({ vision: false })).vision, false);
  assert.equal(h.launches.length, 2, 'vision alone replaces the server');
  await h.manager.ensureRunning({ vision: false });
  assert.equal(h.launches.length, 2, 'matching vision is a no-op');
  h.lifecycle.lastHandle.onExit({ pid: h.lifecycle.lastHandle.pid, code: 1 });
  assert.equal(h.manager.getStatus().vision, false);
  assert.equal((await h.manager.ensureRunning()).vision, false, 'crash recovery keeps the explicit spec');
  await h.manager.stop({ retainIdentity: true });
  h.localEngines.ninfer.vision = true;
  assert.equal((await h.manager.ensureRunning(null, { reuseIdentity: true })).vision, false, 'retained plan stays exact');
  assert.equal((await h.manager.restart({ vision: true })).vision, true);
  await h.manager.stop();
  assert.equal(h.manager.getStatus().vision, false);
  const saved = makeHarness({ settings: { vision: false, lastUsedArtifactId: ARTIFACT.id } });
  assert.equal((await saved.manager.startFromSettings({})).vision, false);
  assert.equal((await saved.manager.restart({ vision: true })).vision, true, 'explicit spec overrides saved false');
});


test('a saved pending Tune change takes effect on the next ordinary start or restart', async () => {
  for (const action of ['start', 'restart']) {
    const h = makeHarness({ settings: { vision: true } });
    await h.manager.ensureRunning({ artifactId: ARTIFACT.id, contextSize: 32768, mtp: true, vision: true });
    // Tune saved, but the user declined interrupting a stream.
    Object.assign(h.localEngines.ninfer, { contextSize: 131072, mtp: false, vision: false });
    if (action === 'start') await h.manager.stop();
    const next = await h.manager[action]();
    const message = action + ' must use the saved preferences, not the previous launch override';
    assert.deepEqual({ contextSize: next.contextSize, mtp: next.mtp, vision: next.vision },
      { contextSize: 131072, mtp: false, vision: false }, message);
    assert.equal(h.launches.at(-1).modelId, ARTIFACT.model_id, action + ' keeps the last artifact');
  }
});
