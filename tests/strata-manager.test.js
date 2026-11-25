'use strict';

// Managed Strata manager (row 200 S2 step 4): one serial chain, lower-ranked
// managers (NInfer, then llama-server) stopped first and the launch refused
// when one stop is unconfirmed, typed plan refusals, crash surfaced without
// respawn, identity retention for the GPU handoff, the learned window, boot
// autostart and the emergency stopSync.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStrataManager, normalizeStrataSpec } = require('../services/main/strata-manager');

function makeLower(kind, { state = 'ready', stopError = '', unconfirmed = false } = {}) {
  const lower = {
    kind,
    state,
    calls: [],
    getStatus: () => ({ state: lower.state, lastError: '' }),
    cleanupUnconfirmed: () => unconfirmed,
    async stop() {
      lower.calls.push('stop');
      lower.state = 'stopped';
      return { state: 'stopped', lastError: stopError };
    },
  };
  return lower;
}

function plan(settings, overrides = {}) {
  return {
    install: { root: 'C:\\S', terminalDir: 'C:\\S\\terminal\\0.1.67', pythonExe: 'C:\\S\\terminal\\0.1.67\\python\\python.exe', version: '0.1.67' },
    config: { exe: 'C:\\S\\engine\\strata-inkling.exe', log: 'C:\\u\\strata\\logs\\strata-server.log' },
    slots: settings.slots,
    kv: settings.kv,
    vision: settings.vision,
    drafting: settings.drafting,
    maxContext: 114432,
    fit: 114432,
    fitSource: 'measured',
    modelId: 'inkling-2-mini-sq-20',
    displayName: 'Inkling 2 Mini',
    version: '0.1.67',
    ...overrides,
  };
}

function makeHarness({ settings = {}, lowers = null, planOverrides = {}, planError = '', launchGate = () => '', onStateChange = () => {} } = {}) {
  const calls = [];
  const logs = [];
  const launches = [];
  const plans = [];
  const learned = [];
  let nextPid = 700;
  const lifecycle = {
    DEFAULT_STRATA_PORT: 8035,
    STRATA_PID_FILENAME: 'strata-serve.pid',
    pending: null,
    failNext: null,
    stopUnconfirmed: false,
    async startStrataServer(options) {
      launches.push(options);
      calls.push(`start:${options.slots}`);
      if (options.abortSignal?.aborted) throw Object.assign(new Error('readiness_aborted'), { reason: 'readiness_aborted' });
      if (lifecycle.failNext) {
        const error = lifecycle.failNext;
        lifecycle.failNext = null;
        throw error;
      }
      if (lifecycle.pending) await lifecycle.pending;
      const pid = nextPid++;
      const handle = {
        pid, port: 8035, baseUrl: 'http://127.0.0.1:8035/v1', apiKey: options.retainedApiKey || `${String(pid).padStart(32, 'a')}`,
        modelId: 'inkling-2-mini-sq-20', contextSize: lifecycle.reportedWindow || 114432, vision: true, slots: options.slots,
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
  const localEngines = { startupModelLoad: true, strata: { slots: 4, kv: 'k8v8', vision: true, drafting: 'off', ...settings } };
  const runtime = {
    enabled: true,
    async plan({ settings: effective, onPhase }) {
      plans.push(effective);
      calls.push('plan');
      if (onPhase) onPhase('verifying');
      if (planError) return { error: planError };
      return plan(effective, planOverrides);
    },
  };
  const lowerPairs = lowers || [['ninfer', makeLower('ninfer')], ['llama-server', makeLower('llama-server')]];
  const manager = createStrataManager({
    userDataPath: 'C:/jenny-user-data',
    getShellConfigService: () => ({ getLocalEngines: () => localEngines, getState: () => ({ preferredEngineType: 'openai-compatible' }) }),
    getRuntime: () => runtime,
    getLowerManagers: () => lowerPairs,
    launchGate,
    onStateChange,
    onWindowLearned: (key, window) => learned.push([key, window]),
    lifecycle,
    log: (level, event, fields) => logs.push({ level, event, fields }),
    createWatchdog: ({ getSettings, onTrip }) => {
      const watchdog = { running: false, getSettings, onTrip, start() { watchdog.running = true; }, stop() { watchdog.running = false; }, tick: async () => ({}), isRunning: () => watchdog.running, settle: async () => {} };
      lifecycle.watchdog = watchdog;
      return watchdog;
    },
  });
  return { manager, calls, logs, launches, plans, learned, lifecycle, localEngines, runtime, lowerPairs };
}

test('normalizeStrataSpec keeps only the steerable keys', () => {
  assert.deepEqual(normalizeStrataSpec({ slots: 2, kv: 'k8v4', drafting: 'dspark', vision: false, context: 65536, exe: 'x', args: ['--host', '0.0.0.0'] }),
    { slots: 2, kv: 'k8v4', drafting: 'dspark', vision: false, context: 65536 });
  assert.equal(normalizeStrataSpec({ slots: 3, kv: 'fp16', drafting: 'auto', context: 12 }), null);
  assert.equal(normalizeStrataSpec(null), null);
});

test('a launch stops NInfer then llama-server, verifies, loads and brokers the key', async () => {
  const transitions = [];
  const h = makeHarness({ onStateChange: (status) => transitions.push(`${status.state}:${status.phase}`) });
  const status = await h.manager.ensureRunning(null);
  assert.equal(status.state, 'ready');
  assert.equal(status.contextSize, 114432);
  assert.equal(status.slots, 4);
  assert.equal(status.kv, 'k8v8');
  assert.equal(status.alias, 'inkling-2-mini-sq-20');
  assert.deepEqual(h.lowerPairs.map(([, lower]) => lower.calls), [['stop'], ['stop']]);
  assert.deepEqual(h.calls, ['plan', 'start:4']);
  assert.deepEqual(transitions, ['starting:verifying', 'starting:verifying', 'starting:loading', 'ready:']);
  assert.equal(h.manager.getBaseUrl(), 'http://127.0.0.1:8035/v1');
  assert.equal(h.manager.getApiKey(), h.lifecycle.lastHandle.apiKey);
  assert.equal(h.lifecycle.watchdog.running, true);
  assert.equal(JSON.stringify(h.manager.getStatus()).includes(h.manager.getApiKey()), false, 'the status never carries the key');
});

test('an unconfirmed stop of a lower-ranked manager refuses the launch before any plan or spawn', async () => {
  const h = makeHarness({ lowers: [['ninfer', makeLower('ninfer', { stopError: 'stop_unconfirmed' })], ['llama-server', makeLower('llama-server')]] });
  const status = await h.manager.ensureRunning(null);
  assert.equal(status.state, 'stopped');
  assert.equal(status.lastError, 'ninfer_stop_unconfirmed');
  assert.deepEqual(h.calls, []);
  const lingering = makeHarness({ lowers: [['llama-server', makeLower('llama-server', { unconfirmed: true })]] });
  assert.equal((await lingering.manager.ensureRunning(null)).lastError, 'llama_server_stop_unconfirmed');
  assert.deepEqual(lingering.calls, []);
});

test('a plan refusal is typed and nothing is spawned', async () => {
  const h = makeHarness({ planError: 'strata_pack_sha256_mismatch' });
  const status = await h.manager.ensureRunning(null);
  assert.equal(status.state, 'stopped');
  assert.equal(status.lastError, 'strata_pack_sha256_mismatch');
  assert.deepEqual(h.calls, ['plan']);
});

test('the launch gate refuses a launch and is not consulted for an identity restore', async () => {
  let gate = '';
  const h = makeHarness({ launchGate: () => gate });
  await h.manager.ensureRunning(null);
  const key = h.manager.getApiKey();
  await h.manager.stop({ retainIdentity: true });
  gate = 'gpu_lease_active';
  assert.equal((await h.manager.ensureRunning({ slots: 2 })).lastError, 'gpu_lease_active');
  const restored = await h.manager.ensureRunning(null, { reuseIdentity: true });
  assert.equal(restored.state, 'ready');
  assert.equal(restored.identityReused, true);
  assert.equal(h.manager.getApiKey(), key);
  assert.equal(h.launches[1].retainedApiKey, key);
  assert.deepEqual(h.calls.filter((call) => call === 'plan'), ['plan'], 'the restore reuses the plan without re-verifying');
});

test('a ready server is reused when nothing changes and relaunched when slots, KV or context change', async () => {
  const h = makeHarness();
  await h.manager.ensureRunning(null);
  await h.manager.ensureRunning(null);
  await h.manager.ensureRunning({ slots: 4, kv: 'k8v8' });
  assert.deepEqual(h.calls, ['plan', 'start:4']);
  const switched = await h.manager.ensureRunning({ slots: 2 });
  assert.equal(switched.state, 'ready');
  assert.equal(switched.slots, 2);
  assert.deepEqual(h.calls.slice(2), ['stop:700', 'plan', 'start:2']);
  await h.manager.ensureRunning({ context: 65536 });
  assert.equal(h.calls.filter((call) => call === 'plan').length, 3);
});

test('concurrent starts are serialized into one launch', async () => {
  const h = makeHarness();
  const results = await Promise.all([h.manager.ensureRunning(null), h.manager.ensureRunning(null), h.manager.start(null)]);
  assert.deepEqual(results.map((status) => status.state), ['ready', 'ready', 'ready']);
  assert.deepEqual(h.calls, ['plan', 'start:4']);
});

test('a crash is surfaced without respawn and ensureRunning recovers', async () => {
  const h = makeHarness();
  await h.manager.ensureRunning(null);
  h.lifecycle.lastHandle.onExit({ pid: 700, code: 3, signal: '' });
  assert.equal(h.manager.getStatus().state, 'crashed');
  assert.equal(h.manager.getStatus().lastError, 'strata_exited:3');
  assert.deepEqual(h.calls, ['plan', 'start:4']);
  const recovered = await h.manager.ensureRunning(null);
  assert.equal(recovered.state, 'ready');
  assert.deepEqual(h.calls, ['plan', 'start:4', 'plan', 'start:4']);
});

test('a start failure carries its reason and an unconfirmed kill is kept for reconcile', async () => {
  const h = makeHarness();
  h.lifecycle.failNext = Object.assign(new Error('strata_blocked_by_windows'), { reason: 'strata_blocked_by_windows' });
  const status = await h.manager.ensureRunning(null);
  assert.equal(status.state, 'stopped');
  assert.equal(status.lastError, 'strata_blocked_by_windows');
  assert.equal(status.phase, '');
});

test('an unconfirmed stop is never laundered into a clean stop', async () => {
  const h = makeHarness();
  await h.manager.ensureRunning(null);
  h.lifecycle.stopUnconfirmed = true;
  const stopped = await h.manager.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.lastError, 'stop_unconfirmed');
  assert.equal(stopped.identityRetained, false);
});

test('a window the engine reports at an unmeasured pairing is saved for the next launch', async () => {
  const measured = makeHarness();
  await measured.manager.ensureRunning(null);
  assert.deepEqual(measured.learned, []);
  const h = makeHarness({ settings: { slots: 2, kv: 'k8v4' }, planOverrides: { fitSource: 'default', maxContext: 32768, fit: 32768 } });
  h.lifecycle.reportedWindow = 32768;
  await h.manager.ensureRunning(null);
  assert.deepEqual(h.learned, [['2:k8v4', 32768]]);
});

test('the watchdog trip stops the server and surfaces it like a crash, named', async () => {
  const h = makeHarness();
  await h.manager.ensureRunning(null);
  h.lifecycle.watchdog.onTrip({ watts: 471.4, tempC: 70 });
  const status = await h.manager.settled();
  assert.equal(status.state, 'crashed');
  assert.equal(status.lastError, 'strata_watchdog_tripped');
  assert.equal(status.stoppedBy, 'watchdog');
  assert.equal(status.watchdogWatts, 471);
});

test('startFromSettings autostarts only when Strata was last used on an openai-compatible boot', async () => {
  const idle = makeHarness();
  assert.equal((await idle.manager.startFromSettings({})).autostarted, false);
  assert.deepEqual(idle.calls, []);
  const other = makeHarness({ settings: { lastUsed: true } });
  assert.equal((await other.manager.startFromSettings({ engineType: 'ollama' })).autostarted, false);
  const off = makeHarness({ settings: { lastUsed: true } });
  off.localEngines.startupModelLoad = false;
  assert.equal((await off.manager.startFromSettings({})).autostarted, false);
  const boot = makeHarness({ settings: { lastUsed: true, slots: 1, kv: 'auto' } });
  const started = await boot.manager.startFromSettings({ engineType: 'openai-compatible' });
  assert.equal(started.autostarted, true);
  assert.equal(started.state, 'ready');
  assert.deepEqual(boot.plans[0], { slots: 1, kv: 'auto', context: null, vision: true, drafting: 'off' });
});

test('stopSync retires the child synchronously and a late launch kills its own child', async () => {
  const h = makeHarness();
  let release;
  h.lifecycle.pending = new Promise((resolve) => { release = resolve; });
  const launch = h.manager.ensureRunning(null);
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
  h.manager.stopSync();
  assert.equal(h.manager.getStatus().state, 'stopped');
  release();
  await launch;
  assert.equal(h.manager.getStatus().state, 'stopped');
  assert.ok(h.calls.some((entry) => entry.startsWith('stopSync:')));
  assert.equal((await h.manager.ensureRunning(null)).lastError, 'strata_halted');
});

test('the launch reads `starting` while a lower-ranked manager is still stopping', async () => {
  const slow = makeLower('ninfer');
  let release;
  slow.stop = () => new Promise((resolve) => { release = () => { slow.state = 'stopped'; resolve({ state: 'stopped', lastError: '' }); }; });
  const h = makeHarness({ lowers: [['ninfer', slow]] });
  const launch = h.manager.ensureRunning(null);
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.manager.getStatus().state, 'starting', 'the GPU is reserved before the lower stop is awaited');
  assert.deepEqual(h.calls, []);
  release();
  assert.equal((await launch).state, 'ready');
});
