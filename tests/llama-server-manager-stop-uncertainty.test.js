'use strict';

// Termination uncertainty must survive until something proves the old server is
// gone: a failed or unconfirmed stop is never laundered into a clean 'stopped'
// by the next stop(), and no second server launches meanwhile.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLlamaServerManager } = require('../services/main/llama-server-manager');

const SETTINGS = Object.freeze({
  autostart: true,
  binaryOverride: '',
  host: '127.0.0.1',
  port: 8033,
  profileId: 'p',
  profile: { id: 'p', modelTag: 'gemma4:12b', contextSize: 32768, extraArgs: [], acceleration: null },
  profileError: '',
  modelPathOverride: '',
  modelTagOverride: '',
  readinessTimeoutMs: 1000,
});

// `record.pid` models the PID file on disk; reconcileRetainedPid clears it only
// when `reapKills` is set (an identity-verified kill that was confirmed).
function makeHarness({ lifecycleOverrides = {}, accelExtraArgs = [] } = {}) {
  const state = { record: { pid: 0 }, reapKills: false, reaps: 0, starts: 0, handle: null };
  const logs = [];
  const lifecycle = {
    async startLlamaServer(options) {
      state.starts += 1;
      if (state.startBehavior) {
        return state.startBehavior(options);
      }
      state.handle = {
        pid: 4242,
        baseUrl: `http://127.0.0.1:${options.port}`,
        reused: false,
        mmproj: '',
        apiKey: 'k',
        async stop() {
          if (state.stopBehavior) return state.stopBehavior();
          return { confirmed: true };
        },
        stopSync() {},
      };
      return state.handle;
    },
    resolveGgufPath: () => ({ path: 'G:/models/model.gguf', projectorPath: '' }),
    resolveProjectorPath: () => '',
    sweepStaleApiKeyFiles() {},
    reconcileRetainedPid() {
      state.reaps += 1;
      if (state.reapKills) state.record = { pid: 0 };
      return { confirmed: state.record.pid === 0, pid: 4242 };
    },
    ...lifecycleOverrides,
  };
  const manager = createLlamaServerManager({
    processRef: { env: {}, resourcesPath: '' },
    rootDir: 'G:/repo',
    userDataPath: 'G:/userData',
    getShellConfigService: () => ({
      getLocalEngines: () => ({ startupModelLoad: true, openaiCompatible: { port: 8033, apiUrl: '', acceleration: null, managed: null } }),
      getState: () => ({ featureOverrides: {} }),
    }),
    log: (level, event, payload) => logs.push({ level, event, payload }),
    lifecycle,
    resolveLaunchAccelerationImpl: () => (accelExtraArgs.length > 0
      ? { mode: 'mtp', reason: 'resolved', extraArgs: accelExtraArgs, drafter: '', vramHeadroomMb: 0 }
      : { mode: 'off', reason: 'flag_off', extraArgs: [], drafter: '', vramHeadroomMb: 0 }),
    resolveSettingsImpl: () => SETTINGS,
    buildFeatureFlagsImpl: () => ({}),
  });
  return { manager, state, logs };
}

// A startup that the abort kills but whose child cannot be confirmed dead.
function abortedStartupWithUnconfirmedKill(state) {
  state.record = { pid: 4242 };
  state.startBehavior = (options) => new Promise((_resolve, reject) => {
    options.abortSignal.addEventListener('abort', () => {
      reject(Object.assign(new Error('readiness_aborted'), { cleanupUnconfirmed: true }));
    }, { once: true });
  });
}

test('stop() after a startup aborted with an unconfirmed kill reports stop_unconfirmed, not clean', async () => {
  const h = makeHarness();
  abortedStartupWithUnconfirmedKill(h.state);
  const starting = h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  await new Promise((resolve) => setImmediate(resolve));

  const stopped = await h.manager.stop();
  await starting;

  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.lastError, 'stop_unconfirmed');
  assert.equal(h.manager.getStatus().lastError, 'stop_unconfirmed');
  assert.ok(h.state.reaps >= 1, 'the identity-verified reaper was consulted');
});

test('a launch failure with cleanupUnconfirmed keeps later stops unclean until the record is gone', async () => {
  const h = makeHarness();
  h.state.record = { pid: 4242 };
  h.state.startBehavior = async () => {
    throw Object.assign(new Error('llama_server_readiness_timeout'), { cleanupUnconfirmed: true });
  };

  const failed = await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  assert.equal(failed.lastError, 'llama_server_readiness_timeout');

  const first = await h.manager.stop();
  assert.equal(first.lastError, 'stop_unconfirmed');
  const second = await h.manager.stop();
  assert.equal(second.lastError, 'stop_unconfirmed', 'a retry without new proof stays unclean');
});

test('an unconfirmed handle stop is not forgotten by the next stop()', async () => {
  const h = makeHarness();
  await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  h.state.record = { pid: 4242 };
  h.state.stopBehavior = async () => ({ confirmed: false });

  const first = await h.manager.stop();
  assert.equal(first.lastError, 'stop_unconfirmed');
  const second = await h.manager.stop();
  assert.equal(second.state, 'stopped');
  assert.equal(second.lastError, 'stop_unconfirmed');
});

test('a throwing handle stop also keeps the uncertainty for the next stop()', async () => {
  const h = makeHarness();
  await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  h.state.record = { pid: 4242 };
  h.state.stopBehavior = async () => { throw new Error('taskkill_failed'); };

  const first = await h.manager.stop();
  assert.equal(first.state, 'stopped');
  assert.equal(first.lastError, 'stop_failed:taskkill_failed');
  assert.ok(h.logs.some((entry) => entry.event === 'llama.server.stop_failed'));
  const second = await h.manager.stop();
  assert.equal(second.lastError, 'stop_unconfirmed');
});

test('a failed stop whose record is already gone lets the next start and stop run clean', async () => {
  const h = makeHarness();
  await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  h.state.stopBehavior = async () => { throw new Error('taskkill_failed'); };
  assert.equal((await h.manager.stop()).lastError, 'stop_failed:taskkill_failed');

  h.state.stopBehavior = null;
  assert.equal((await h.manager.ensureRunning({ modelTag: 'gemma4:12b' })).state, 'ready');
  assert.equal((await h.manager.stop()).lastError, '');
});

test('reconcile succeeds once the PID record is gone: stop is clean and a later launch proceeds', async () => {
  const h = makeHarness();
  await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  h.state.record = { pid: 4242 };
  h.state.stopBehavior = async () => ({ confirmed: false });
  await h.manager.stop();
  assert.equal(h.manager.getStatus().lastError, 'stop_unconfirmed');

  // The identity-verified reap now kills the orphan and clears the record.
  h.state.reapKills = true;
  const clean = await h.manager.stop();
  assert.equal(clean.state, 'stopped');
  assert.equal(clean.lastError, '');

  const startsBefore = h.state.starts;
  h.state.stopBehavior = null;
  const relaunched = await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  assert.equal(relaunched.state, 'ready');
  assert.equal(h.state.starts, startsBefore + 1);
});

test('launch is refused while cleanup is pending and no second server starts', async () => {
  const h = makeHarness();
  await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  h.state.record = { pid: 4242 };
  h.state.stopBehavior = async () => ({ confirmed: false });
  await h.manager.stop();
  const startsBefore = h.state.starts;

  const refused = await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });

  assert.equal(refused.state, 'stopped');
  assert.equal(refused.lastError, 'stop_unconfirmed');
  assert.equal(h.state.starts, startsBefore, 'nothing was spawned');
  assert.deepEqual(
    h.logs.find((entry) => entry.event === 'llama.server.launch_refused')?.payload,
    { reason: 'stop_unconfirmed' }
  );
});

test('an accelerated attempt with an unconfirmed kill is not retried unaccelerated beside it', async () => {
  const h = makeHarness({ accelExtraArgs: ['--spec-type', 'draft-mtp'] });
  h.state.record = { pid: 4242 };
  h.state.startBehavior = async () => {
    throw Object.assign(new Error('llama_server_readiness_timeout'), { cleanupUnconfirmed: true });
  };

  const failed = await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });

  assert.equal(failed.state, 'stopped');
  assert.equal(h.state.starts, 1, 'the unaccelerated retry never spawned');
  assert.equal((await h.manager.stop()).lastError, 'stop_unconfirmed');
});

test('reconcile fails closed when the lifecycle cannot settle the PID record', async () => {
  const h = makeHarness({ lifecycleOverrides: { reconcileRetainedPid: undefined } });
  await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  h.state.stopBehavior = async () => ({ confirmed: false });
  await h.manager.stop();
  h.state.reapKills = true;

  const again = await h.manager.stop();
  assert.equal(again.lastError, 'stop_unconfirmed');
});

test('reconcile fails closed when the reaper throws or a pid is still recorded', async () => {
  const throwing = makeHarness({
    lifecycleOverrides: { reconcileRetainedPid() { throw new Error('boom'); } },
  });
  await throwing.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  throwing.state.stopBehavior = async () => ({ confirmed: false });
  await throwing.manager.stop();
  assert.equal((await throwing.manager.stop()).lastError, 'stop_unconfirmed');

  const stillRecorded = makeHarness();
  await stillRecorded.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  stillRecorded.state.record = { pid: 4242 };
  stillRecorded.state.stopBehavior = async () => ({ confirmed: false });
  await stillRecorded.manager.stop();
  // The reconcile runs but its kill is unverified, so the record is retained.
  assert.equal((await stillRecorded.manager.stop()).lastError, 'stop_unconfirmed');
});

test('a clean stop and a clean failure leave later stops clean', async () => {
  const h = makeHarness();
  h.state.startBehavior = async () => { throw new Error('llama_server_binary_not_found'); };
  const failed = await h.manager.ensureRunning({ modelTag: 'gemma4:12b' });
  assert.equal(failed.lastError, 'llama_server_binary_not_found');
  assert.equal((await h.manager.stop()).lastError, '');
  assert.equal(h.state.reaps, 0, 'no reconcile without pending uncertainty');
});
