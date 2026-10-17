'use strict';

/* performance.* IPC registration and desktop composition (row 59 checkpoint 6):
 * the trusted-sender gate, raw-payload forwarding to the service-owned closed
 * schema, the failure envelope when the service is absent or throws, and the
 * live wiring against a backend-shaped object. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { registerPerformanceIpc } = require('../services/main/performance-ipc-registration');
const { createPerformanceWiring } = require('../services/main/performance-wiring');
const { JENNY_SHELL_BRIDGE_DESCRIPTORS } = require('../services/ipc-contract');

const CHANNELS = {
  getSnapshot: 'performance:get-snapshot',
  updateSettings: 'performance:update-settings',
  dismissWarning: 'performance:dismiss-warning',
};

function register({ allow = true, service } = {}) {
  const handlers = new Map();
  const backendService = { performance: service };
  registerPerformanceIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    backendService, authorization: { authorize: () => allow },
  });
  return { handlers, invoke: (channel, payload) => handlers.get(channel)({ sender: {} }, payload) };
}

test('exactly the three descriptor-backed invoke channels are registered, and onChanged is a subscription', () => {
  const { handlers } = register({ service: {} });
  assert.deepEqual([...handlers.keys()].sort(), Object.values(CHANNELS).sort());
  for (const [method, channel] of Object.entries(CHANNELS)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[`performance.${method}`], { kind: 'invoke', channel });
  }
  assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS['performance.onChanged'], { kind: 'subscribe', channel: 'performance:changed' });
});

test('an untrusted sender reaches no service method', async () => {
  const calls = [];
  const service = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, args]); return { ok: true }; } });
  const denied = register({ allow: false, service });
  for (const channel of Object.values(CHANNELS)) {
    const result = await denied.invoke(channel, { schema_version: 1, session_id: 's' });
    assert.equal(result.ok, false);
  }
  assert.equal(calls.length, 0);
});

test('payloads reach the service raw and its envelope returns unchanged', async () => {
  const calls = [];
  const service = {
    async getSnapshot(raw) { calls.push(['getSnapshot', raw]); return { ok: true, settings: {}, inference: null, gpu: null }; },
    async updateSettings(raw) { calls.push(['updateSettings', raw]); return { ok: true, settings: {} }; },
    async dismissWarning(raw) { calls.push(['dismissWarning', raw]); return { ok: false, code: 'CMP-PERFORMANCE-0004', reason: 'stale_warning' }; },
  };
  const { invoke } = register({ service });
  const hostile = { schema_version: 1, session_id: 's', pid: 4, command: 'powershell', extra: { deep: [1, 2] } };
  assert.deepEqual(await invoke(CHANNELS.getSnapshot, hostile), { ok: true, settings: {}, inference: null, gpu: null });
  assert.deepEqual(await invoke(CHANNELS.dismissWarning, hostile), { ok: false, code: 'CMP-PERFORMANCE-0004', reason: 'stale_warning' });
  await invoke(CHANNELS.updateSettings, undefined);
  assert.deepEqual(calls.map(([name]) => name), ['getSnapshot', 'dismissWarning', 'updateSettings']);
  assert.equal(calls[0][1], hostile, 'no coercion or copying before the service validates');
  assert.equal(calls[2][1], undefined);
});

test('a missing service and a throwing service answer the failure envelope without exception text', async () => {
  const expected = { ok: false, code: 'CMP-PERFORMANCE-0003', reason: 'collection_unavailable' };
  assert.deepEqual(await register({ service: undefined }).invoke(CHANNELS.getSnapshot, {}), expected);
  const throwing = { getSnapshot: async () => { throw new Error('secret path C:\\Users\\x'); } };
  const result = await register({ service: throwing }).invoke(CHANNELS.getSnapshot, {});
  assert.deepEqual(result, expected);
  assert.doesNotMatch(JSON.stringify(result), /secret|Users/u);
});

function fakeWiring(overrides = {}) {
  const backend = new EventEmitter();
  backend.activeStreams = new Map();
  backend.currentEngineType = 'openai-compatible';
  const state = { performanceTelemetry: { schemaVersion: 1, showCounter: false, gpuWarningsEnabled: true } };
  const shell = Object.assign(new EventEmitter(), {
    getState: () => ({ performanceTelemetry: { ...state.performanceTelemetry } }),
    updatePerformanceTelemetry: (patch) => { Object.assign(state.performanceTelemetry, patch); shell.emit('changed', {}, { reason: 'performance_telemetry_updated' }); },
  });
  let ninfer = { state: 'stopped', pid: 0 };
  const samples = [];
  const collector = { sample: async (identity) => { samples.push(identity); return { state: 'unavailable', reason: 'test' }; }, dispose() { collector.disposed = true; } };
  const bridge = [];
  const lookups = [];
  const service = createPerformanceWiring({
    backendService: backend, shellConfigService: shell, getNinferManager: () => ({ getStatus: () => ({ ...ninfer }) }),
    sendBridgeEvent: (channel, payload) => bridge.push([channel, payload]), platform: 'win32',
    createCollector: () => collector,
    getProcessStartTime: async (pid) => { lookups.push(pid); return `ticks-${pid}`; },
    ...overrides,
  });
  return {
    backend, shell, service, bridge, samples, lookups, collector,
    setNinfer: (next) => { ninfer = next; service.refreshRuntime(); },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the wiring publishes the intake and the service on the backend and routes events over the bridge bus', async () => {
  const f = fakeWiring();
  assert.equal(typeof f.backend.inferenceIntake.accept, 'function');
  assert.equal(f.backend.performance, f.service);
  const snapshot = await f.service.getSnapshot({ schema_version: 1, session_id: 'sess_1' });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.gpu.state, 'unavailable');
  assert.deepEqual(f.service.updateSettings({ schema_version: 1, show_counter: true }).settings.show_counter, true);
  assert.deepEqual(f.bridge.at(-1), ['performance.onChanged', { session_id: null, terminal: false, scope: 'settings' }]);
  f.service.dispose();
  assert.equal(f.collector.disposed, true);
});

test('the managed NInfer identity is resolved once per launch and drives the sampler; a stop clears it', async () => {
  const f = fakeWiring();
  await f.service.updateSettings({ schema_version: 1, show_counter: true });
  await tick();
  assert.deepEqual(f.samples, [], 'no managed runtime, nothing to sample');
  f.setNinfer({ state: 'starting', pid: 77 });
  await tick();
  assert.deepEqual(f.lookups, [], 'only a ready server has an identity');
  f.setNinfer({ state: 'ready', pid: 77 });
  f.service.refreshRuntime();
  f.service.refreshRuntime();
  await tick(); await tick();
  assert.deepEqual(f.lookups, [77], 'resolved once, cached by pid');
  assert.deepEqual(f.samples, [{ pid: 77, createdAt: 'ticks-77' }]);
  f.setNinfer({ state: 'stopped', pid: 0 });
  f.setNinfer({ state: 'ready', pid: 78 });
  await tick(); await tick();
  assert.deepEqual(f.lookups, [77, 78], 'a new launch is a new identity');
  f.service.dispose();
});

test('a lookup that loses to a newer launch cannot install a stale identity', async () => {
  let release;
  const f = fakeWiring({ getProcessStartTime: (pid) => (pid === 90 ? new Promise((resolve) => { release = () => resolve('ticks-90'); }) : Promise.resolve(`ticks-${pid}`)) });
  await f.service.updateSettings({ schema_version: 1, show_counter: true });
  f.setNinfer({ state: 'ready', pid: 90 });
  f.setNinfer({ state: 'stopped', pid: 0 });
  f.setNinfer({ state: 'ready', pid: 91 });
  await tick(); await tick();
  release();
  await tick(); await tick();
  assert.deepEqual(f.samples.map((identity) => identity.pid), [91]);
  f.service.dispose();
});

test('active generation follows live chat streams while the NInfer serves the openai-compatible engine', async () => {
  const f = fakeWiring();
  f.setNinfer({ state: 'ready', pid: 5 });
  await tick(); await tick();
  // Observe through the sampler's cadence: an active stream samples at 2 s instead of 15 s.
  f.backend.activeStreams.set('stream_1', {});
  f.backend.emit('chat-stream', { type: 'started', sessionId: 'sess_1', streamId: 'stream_1' });
  assert.equal(f.service.getSnapshot({ schema_version: 1, session_id: 'sess_1' }).gpu.cadence_ms, 2000);
  f.backend.activeStreams.clear();
  f.backend.emit('chat-stream', { type: 'complete', sessionId: 'sess_1', streamId: 'stream_1' });
  assert.equal(f.service.getSnapshot({ schema_version: 1, session_id: 'sess_1' }).gpu.cadence_ms, 15000);
  f.backend.currentEngineType = 'ollama';
  f.backend.activeStreams.set('stream_2', {});
  f.backend.emit('chat-stream', { type: 'started', sessionId: 'sess_1', streamId: 'stream_2' });
  assert.equal(f.service.getSnapshot({ schema_version: 1, session_id: 'sess_1' }).gpu.cadence_ms, 15000, 'another engine is not NInfer generation');
  f.service.dispose();
});

test('inference notifications reach the snapshot through the published intake', async () => {
  const f = fakeWiring();
  const frame = {
    schema_version: 1, request_id: 'stream_1', session_id: 'sess_1', turn_id: 't', provider_call_id: null, attempt_id: 'a1'.repeat(16),
    sequence: 0, sampled_at: 5, phase: 'prefill', source: 'provider', provider_kind: 'ninfer',
  };
  assert.equal(f.backend.inferenceIntake.accept({ streamId: 'stream_1', resolvedSessionId: 'sess_1' }, frame), true);
  assert.equal((await f.service.getSnapshot({ schema_version: 1, session_id: 'sess_1' })).inference.observation.phase, 'prefill');
  assert.equal(f.bridge.some(([channel, payload]) => channel === 'performance.onChanged' && payload.scope === 'inference'), true);
  f.service.dispose();
});

test('a start-time lookup that comes back empty is logged and retried after 30 s, not cached for the launch', async () => {
  let clock = 1000; let answer = '';
  const f = fakeWiring({ now: () => clock, getProcessStartTime: async (pid) => { f.lookups.push(pid); return answer; } });
  f.setNinfer({ state: 'ready', pid: 81 });
  await tick(); await tick();
  assert.deepEqual(f.lookups, [81]);
  f.service.refreshRuntime(); await tick();
  assert.deepEqual(f.lookups, [81], 'inside the retry window');
  clock += 30001; answer = 'ticks-81';
  f.service.refreshRuntime(); await tick(); await tick();
  assert.deepEqual(f.lookups, [81, 81], 'retried after the window');
  f.service.dispose();
});

test('a replaced config invalidates open settings views', () => {
  const f = fakeWiring();
  f.shell.emit('changed', {}, { reason: 'state_replaced' });
  assert.ok(f.bridge.some(([channel, payload]) => channel === 'performance.onChanged' && payload.scope === 'settings'));
  f.service.dispose();
});
