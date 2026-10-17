'use strict';

/* performance.* service (row 59 checkpoint 6): snapshot shape, closed validation,
 * the strict settings write, warning dismissal (stale ids fail CMP-PERFORMANCE-0004),
 * what the GPU sampler is told to demand, and the invalidation events. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPerformanceService, SUBSCRIBER_LEASE_MS } = require('../services/performance/performance-service');
const { createInferenceIntake } = require('../services/performance/inference-intake');

const WARNING_ID = '123e4567-e89b-42d3-a456-426614174000';
const ATTEMPT = 'a1'.repeat(16);
const NULLS = {
  generated_tokens: null, decode_interval_tokens: null, decode_elapsed_ms: null, prompt_tokens: null,
  cached_prompt_tokens: null, processed_prompt_tokens: null, prefill_elapsed_ms: null,
  time_to_first_generated_token_ms: null, terminal_decode_tps: null, terminal_prefill_tps: null,
};
const frame = (over = {}) => ({
  schema_version: 1, request_id: 'req_1', session_id: 'sess_1', turn_id: 'turn_1', provider_call_id: null, attempt_id: ATTEMPT,
  sequence: 0, sampled_at: 1_000_000, phase: 'waiting', source: 'provider', provider_kind: 'ninfer', ...NULLS, ...over,
});
const GPU = { schema_version: 1, sequence: 4, sampled_at: 99, cadence_ms: 15000, state: 'fresh', reason: null, adapter: null,
  managed_process: null, external_processes: [], other_process_count: 0, truncated: false,
  warning: { warning_id: null, state: 'clear', since: null, evidence_codes: [], dismissed_until: null, last_confirmed_state: 'clear' } };

function fixture({ telemetry = { schemaVersion: 1, showCounter: false, gpuWarningsEnabled: true }, dismiss } = {}) {
  let time = 1_000;
  const timers = new Map();
  let timerId = 0;
  const events = [];
  const demands = [];
  const writes = [];
  const state = { performanceTelemetry: telemetry };
  const shellConfig = {
    getState: () => ({ performanceTelemetry: structuredClone(state.performanceTelemetry) }),
    updatePerformanceTelemetry: (patch) => { writes.push(patch); state.performanceTelemetry = { ...state.performanceTelemetry, ...patch }; return state.performanceTelemetry; },
  };
  let gpu = structuredClone(GPU);
  const sampler = { setDemand: (demand) => demands.push(structuredClone(demand)), latest: () => structuredClone(gpu), dispose() { sampler.disposed = true; } };
  const tracker = { dismiss: dismiss || ((id) => (id === WARNING_ID ? { ok: true } : { ok: false, reason: 'stale_warning' })) };
  const intake = createInferenceIntake({ now: () => time });
  const service = createPerformanceService({
    shellConfig, intake, sampler, tracker, now: () => time,
    emitChanged: (event) => events.push(event),
    setTimer: (fn, ms) => { timers.set(++timerId, { fn, at: time + ms }); return timerId; },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    service, intake, events, demands, writes, state, sampler, setGpu: (next) => { gpu = next; },
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
    },
    lastDemand: () => demands.at(-1),
  };
}

test('getSnapshot answers settings, the session inference and the GPU snapshot', () => {
  const f = fixture();
  let result = f.service.getSnapshot({ schema_version: 1, session_id: 'sess_1' });
  assert.deepEqual(Object.keys(result).sort(), ['gpu', 'inference', 'ok', 'settings']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings, { schema_version: 1, show_counter: false, gpu_warnings_enabled: true });
  assert.equal(result.inference, null, 'null before any associated request');
  assert.deepEqual(result.gpu, GPU);
  f.intake.accept({ streamId: 'req_1', resolvedSessionId: 'sess_1' }, frame({ prompt_tokens: 10, cached_prompt_tokens: 5 }));
  result = f.service.getSnapshot({ schema_version: 1, session_id: 'sess_1' });
  assert.equal(result.inference.observation.phase, 'waiting');
  assert.deepEqual(Object.keys(result.inference).sort(), ['cache_fraction', 'live_decode', 'live_prefill', 'observation']);
  assert.equal(result.inference.cache_fraction.value, 0.5);
  assert.equal(f.service.getSnapshot({ schema_version: 1, session_id: 'sess_2' }).inference, null, 'every pane shows only its own request');

  const host = f.service.getSnapshot({ schema_version: 1, session_id: null });
  assert.equal(host.inference, null, 'the host scope never carries inference');
  assert.deepEqual(host.gpu, GPU);
});

test('getSnapshot rejects anything but the closed request with CMP-PERFORMANCE-0001', () => {
  const f = fixture();
  for (const raw of [undefined, null, {}, { schema_version: 1 }, { schema_version: 1, session_id: 'a', extra: 1 }, { schema_version: 2, session_id: 'a' }]) {
    assert.deepEqual(f.service.getSnapshot(raw), { ok: false, code: 'CMP-PERFORMANCE-0001', reason: 'invalid_request' });
  }
});

test('an unreadable settings store answers CMP-PERFORMANCE-0003 without exception text', () => {
  const f = fixture();
  const broken = createPerformanceService({
    shellConfig: { getState: () => { throw new Error('C:\\secret\\path'); } }, intake: f.intake, sampler: f.sampler, tracker: {},
    emitChanged() {},
  });
  const result = broken.getSnapshot({ schema_version: 1, session_id: 'sess_1' });
  assert.deepEqual(result, { ok: false, code: 'CMP-PERFORMANCE-0003', reason: 'collection_unavailable' });
  assert.doesNotMatch(JSON.stringify(result), /secret/u);
  assert.equal(broken.updateSettings({ schema_version: 1, show_counter: true }).code, 'CMP-PERFORMANCE-0003');
  assert.equal(createPerformanceService({}).getSnapshot({ schema_version: 1, session_id: 's' }).ok, true, 'a bare service still answers');
});

test('updateSettings needs at least one strict boolean and writes through the settings store', () => {
  const f = fixture();
  for (const raw of [undefined, { schema_version: 1 }, { schema_version: 1, show_counter: 'yes' }, { schema_version: 1, show_counter: true, other: 1 },
    { schema_version: 1, gpu_warnings_enabled: null }]) {
    assert.deepEqual(f.service.updateSettings(raw), { ok: false, code: 'CMP-PERFORMANCE-0001', reason: 'invalid_request' }, JSON.stringify(raw));
  }
  assert.deepEqual(f.writes, [], 'nothing reached the store');
  const counter = f.service.updateSettings({ schema_version: 1, show_counter: true });
  assert.deepEqual(counter, { ok: true, settings: { schema_version: 1, show_counter: true, gpu_warnings_enabled: true } });
  const both = f.service.updateSettings({ schema_version: 1, show_counter: false, gpu_warnings_enabled: false });
  assert.deepEqual(both.settings, { schema_version: 1, show_counter: false, gpu_warnings_enabled: false });
  assert.deepEqual(f.writes, [{ showCounter: true }, { showCounter: false, gpuWarningsEnabled: false }]);
  assert.deepEqual(f.events.filter((e) => e.scope === 'settings'), [
    { session_id: null, terminal: false, scope: 'settings' }, { session_id: null, terminal: false, scope: 'settings' },
  ]);
});

test('a settings block from a newer build is read-only: CMP-PERFORMANCE-0002 and defaults', () => {
  const future = { schemaVersion: 2, showCounter: true, gpuWarningsEnabled: false, newThing: [1] };
  const f = fixture({ telemetry: future });
  const result = f.service.updateSettings({ schema_version: 1, show_counter: true });
  assert.deepEqual(result, { ok: false, code: 'CMP-PERFORMANCE-0002', reason: 'settings_read_only' });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.service.getSnapshot({ schema_version: 1, session_id: 's' }).settings,
    { schema_version: 1, show_counter: false, gpu_warnings_enabled: true }, 'an unknown schema is not interpreted');
});

test('a throwing settings store answers CMP-PERFORMANCE-0003', () => {
  const f = fixture();
  f.state.performanceTelemetry = { schemaVersion: 1, showCounter: false, gpuWarningsEnabled: true };
  const service = createPerformanceService({
    shellConfig: { getState: () => ({ performanceTelemetry: f.state.performanceTelemetry }), updatePerformanceTelemetry: () => { throw new Error('disk'); } },
    intake: f.intake, sampler: f.sampler, tracker: {}, emitChanged() {},
  });
  assert.deepEqual(service.updateSettings({ schema_version: 1, show_counter: true }), { ok: false, code: 'CMP-PERFORMANCE-0003', reason: 'collection_unavailable' });
});

test('dismissWarning succeeds for the current episode and fails stale ids with CMP-PERFORMANCE-0004', () => {
  const f = fixture();
  const ok = f.service.dismissWarning({ schema_version: 1, session_id: 'sess_1', warning_id: WARNING_ID });
  assert.deepEqual(ok, { ok: true, gpu: GPU });
  assert.deepEqual(f.events.at(-1), { session_id: null, terminal: false, scope: 'gpu' });
  const stale = f.service.dismissWarning({ schema_version: 1, session_id: 'sess_1', warning_id: '223e4567-e89b-42d3-a456-426614174000' });
  assert.deepEqual(stale, { ok: false, code: 'CMP-PERFORMANCE-0004', reason: 'stale_warning' });
  assert.equal(f.service.dismissWarning({ schema_version: 1, session_id: 'sess_1', warning_id: 'nope' }).code, 'CMP-PERFORMANCE-0001');
  assert.equal(f.service.dismissWarning({ schema_version: 1, warning_id: WARNING_ID }).code, 'CMP-PERFORMANCE-0001');
  const throwing = fixture({ dismiss: () => { throw new Error('tracker'); } });
  assert.equal(throwing.service.dismissWarning({ schema_version: 1, session_id: 's', warning_id: WARNING_ID }).code, 'CMP-PERFORMANCE-0003');
});

test('sampler demand follows the settings, the active generation, the identity and the subscriber lease', () => {
  const f = fixture();
  assert.deepEqual(f.lastDemand(), { counter: false, warnings: true, subscribers: 0, active: false, identity: null });
  f.service.updateSettings({ schema_version: 1, show_counter: true });
  assert.equal(f.lastDemand().counter, true);
  f.service.updateSettings({ schema_version: 1, gpu_warnings_enabled: false });
  assert.deepEqual([f.lastDemand().counter, f.lastDemand().warnings], [true, false]);
  f.service.updateSettings({ schema_version: 1, show_counter: false });
  assert.deepEqual([f.lastDemand().counter, f.lastDemand().warnings, f.lastDemand().subscribers], [false, false, 0]);

  f.service.setActiveGeneration(true);
  assert.equal(f.lastDemand().active, true);
  const count = f.demands.length;
  f.service.setActiveGeneration(true);
  assert.equal(f.demands.length, count, 'an unchanged value does not re-announce');
  f.service.setActiveGeneration('yes');
  assert.equal(f.lastDemand().active, false, 'only a strict true is active');

  f.service.setRuntimeIdentity({ pid: 42, createdAt: '639000000000000000' });
  assert.deepEqual(f.lastDemand().identity, { pid: 42, createdAt: '639000000000000000' });
  for (const bad of [null, {}, { pid: 0, createdAt: '1' }, { pid: 1.5, createdAt: '1' }, { pid: 4, createdAt: '' }, { pid: 4, createdAt: 7 }, 'x']) {
    f.service.setRuntimeIdentity(bad);
    assert.equal(f.lastDemand().identity, null, JSON.stringify(bad));
    f.service.setRuntimeIdentity({ pid: 42, createdAt: '639000000000000000' });
  }

  // With both settings off a reader takes no lease (no hardware sampling for nobody).
  f.service.getSnapshot({ schema_version: 1, session_id: 'sess_1' });
  assert.equal(f.lastDemand().subscribers, 0);
  // With a setting on, a getSnapshot renews a subscriber lease that lapses on its own.
  f.service.updateSettings({ schema_version: 1, gpu_warnings_enabled: true });
  f.service.getSnapshot({ schema_version: 1, session_id: 'sess_1' });
  assert.equal(f.lastDemand().subscribers, 1);
  f.advance(SUBSCRIBER_LEASE_MS - 1);
  f.service.getSnapshot({ schema_version: 1, session_id: 'sess_1' });
  f.advance(SUBSCRIBER_LEASE_MS - 1);
  assert.equal(f.lastDemand().subscribers, 1, 'renewed, so still held');
  f.advance(2);
  assert.equal(f.lastDemand().subscribers, 0, 'the lease lapsed');
});

test('inference changes are rate limited per session and terminal ones are immediate', () => {
  const f = fixture();
  const owner = { streamId: 'req_1', resolvedSessionId: 'sess_1' };
  f.intake.accept(owner, frame({ sequence: 0 }));
  assert.deepEqual(f.events, [{ session_id: 'sess_1', terminal: false, scope: 'inference' }], 'the first change is immediate');
  for (let i = 1; i <= 5; i += 1) f.intake.accept(owner, frame({ sequence: i, phase: 'decode' }));
  assert.equal(f.events.length, 1, 'collapsed into one trailing emit');
  f.advance(250);
  assert.equal(f.events.length, 2);
  f.intake.accept(owner, frame({ sequence: 6, phase: 'finished' }));
  assert.deepEqual(f.events.at(-1), { session_id: 'sess_1', terminal: true, scope: 'inference' }, 'terminal bypasses the limit');
  assert.equal(f.events.length, 3);
  f.advance(1000);
  assert.ok(f.events.length <= 4, 'only the pending trailing emit may follow');
});

test('GPU news is emitted only when the state or the warning changes', () => {
  const f = fixture();
  f.service.noteGpuSample();
  assert.deepEqual(f.events.at(-1), { session_id: null, terminal: false, scope: 'gpu' });
  const count = f.events.length;
  f.setGpu({ ...GPU, sequence: 5, sampled_at: 120 });
  f.service.noteGpuSample();
  assert.equal(f.events.length, count, 'a fresher sample with the same state is not news');
  f.setGpu({ ...GPU, state: 'stale', reason: 'sample_expired' });
  f.service.noteGpuSample();
  f.advance(300);
  assert.equal(f.events.length, count + 1, 'a state change is announced through the rate limit');
  f.setGpu({ ...GPU, state: 'stale', reason: 'sample_expired',
    warning: { ...GPU.warning, state: 'possible_spill', warning_id: WARNING_ID } });
  f.service.noteGpuSample();
  assert.equal(f.events.length, count + 2, 'a warning transition is immediate');
});

test('dispose stops listening, clears timers and disposes the sampler once', () => {
  const f = fixture();
  f.service.getSnapshot({ schema_version: 1, session_id: 'sess_1' });
  f.service.dispose();
  f.service.dispose();
  assert.equal(f.sampler.disposed, true);
  const count = f.events.length;
  f.intake.accept({ streamId: 'req_1', resolvedSessionId: 'sess_1' }, frame());
  f.service.noteGpuSample();
  f.advance(SUBSCRIBER_LEASE_MS * 2);
  assert.equal(f.events.length, count);
});
