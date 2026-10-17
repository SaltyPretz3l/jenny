'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGpuSampler } = require('../services/performance/gpu-sampler');
const { createGpuWarningTracker } = require('../services/performance/gpu-warning-state');
const identity = { pid: 10, createdAt: '123' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, sampleImpl) {
  let time = 0; let calls = 0; let releases = 0; let disposed = false; let id = 0; const timers = new Map();
  const sample = () => ({ schema_version: 1, sequence: calls, sampled_at: time, state: 'fresh', reason: null,
    adapter: { luid: 'a', dedicated_free_bytes: 0 }, managed_process: { shared_bytes: 0 }, external_processes: [], truncated: false, other_process_count: 0 });
  const tracker = createGpuWarningTracker({ now: () => time, uuid: () => 'warning' });
  const collector = { sample: arg => { calls++; assert.deepEqual(arg, identity); return sampleImpl ? sampleImpl(calls, sample()) : Promise.resolve(sample()); },
    release: () => { releases++; }, dispose: () => { disposed = true; } };
  const sampler = createGpuSampler({ collector, tracker, now: () => time,
    setTimer: (fn, delay) => { timers.set(++id, { fn, delay, at: time + delay }); return id; }, clearTimer: timer => timers.delete(timer) });
  t.after(() => sampler.dispose());
  return { sampler, tracker, timers, calls: () => calls, releases: () => releases, disposed: () => disposed,
    advance: async ms => { time += ms; const due = [...timers.entries()].filter(([, timer]) => timer.at <= time);
      for (const [key, timer] of due) { timers.delete(key); timer.fn(); } await tick(); },
    elapse: ms => { time += ms; } };
}
test('no demand does no work; starts idle at 15s, active at 2s, subscribers keep sampling', async t => {
  const f = fixture(t); f.sampler.setDemand({}); await tick(); assert.equal(f.calls(), 0);
  f.sampler.setDemand({ warnings: true, counter: true, active: true }); await tick(); assert.equal(f.calls(), 0);
  f.sampler.setDemand({ warnings: true, identity }); await tick(); assert.equal(f.calls(), 1);
  assert.equal(f.sampler.latest().cadence_ms, 15000); assert.equal([...f.timers.values()][0].delay, 15000);
  f.sampler.setDemand({ counter: true, active: true, identity }); assert.equal(f.sampler.latest().cadence_ms, 2000);
  await f.advance(2000); assert.equal(f.calls(), 2);
  f.sampler.setDemand({ subscribers: 1, identity }); assert.equal(f.sampler.latest().cadence_ms, 15000);
  await f.advance(15000); assert.equal(f.calls(), 3);
  f.sampler.setDemand({ identity }); assert.equal(f.timers.size, 0); assert.equal(f.sampler.latest().cadence_ms, null);
  await f.advance(90000); assert.equal(f.calls(), 3);
});
test('only one in-flight sample across ticks and demand changes', async t => {
  let resolve; const f = fixture(t, () => new Promise(r => { resolve = r; }));
  f.sampler.setDemand({ warnings: true, active: true, identity }); await tick();
  f.sampler.setDemand({ counter: true, identity }); f.sampler.setDemand({ warnings: true, active: true, identity });
  await f.advance(20000); assert.equal(f.calls(), 1);
  resolve({ state: 'fresh', sampled_at: 0 }); await tick();
  assert.equal(f.timers.size, 1); await f.advance(2000); assert.equal(f.calls(), 2);
  f.sampler.dispose(); resolve({ state: 'fresh' }); await tick(); assert.equal(f.timers.size, 0);
});
test('demand that ends during a sample releases the helper once the sample settles', async t => {
  let resolve; const f = fixture(t, (_n, s) => new Promise(r => { resolve = () => r(s); }));
  f.sampler.setDemand({ counter: true, active: true, identity }); await tick(); assert.equal(f.calls(), 1);
  f.sampler.setDemand({ identity }); assert.equal(f.releases(), 1, 'asked at once (a busy collector ignores it)');
  resolve(); await tick();
  assert.equal(f.releases(), 2, 'released again after the in-flight sample'); assert.equal(f.timers.size, 0);
  f.sampler.setDemand({ counter: true, active: true, identity }); await tick(); resolve(); await tick();
  assert.equal(f.releases(), 2, 'a sample under live demand releases nothing');
});
test('sample latency is included in cadence instead of extending the sampling interval', async t => {
  let resolve; const f = fixture(t, (_n, s) => new Promise(r => { resolve = () => r(s); }));
  f.sampler.setDemand({ warnings: true, active: true, identity }); await tick();
  f.elapse(1200); resolve(); await tick(); assert.equal([...f.timers.values()][0].delay, 800);
  await f.advance(800); assert.equal(f.calls(), 2); resolve(); await tick();
});
test('failed refresh is stale immediately, retains values and projects warning unknown', async t => {
  const f = fixture(t, (n, s) => n > 3 ? { state: 'unavailable', reason: 'helper_unavailable' } : s);
  f.sampler.setDemand({ warnings: true, active: true, identity }); await tick(); await f.advance(2000); await f.advance(2000);
  assert.equal(f.sampler.latest().warning.state, 'low_headroom'); const previous = f.sampler.latest();
  await f.advance(2000); const failed = f.sampler.latest();
  assert.equal(failed.state, 'stale'); assert.equal(failed.reason, 'helper_unavailable');
  assert.equal(failed.sampled_at, previous.sampled_at); assert.deepEqual(failed.adapter, previous.adapter);
  assert.equal(failed.warning.state, 'unknown'); assert.equal(failed.warning.last_confirmed_state, 'low_headroom');
});
test('rejections and first-sample failures mark stale immediately, later success recovers', async t => {
  const f = fixture(t, (n, s) => n === 1 ? Promise.reject(new Error('private path')) : s);
  f.sampler.setDemand({ counter: true, active: true, identity }); await tick();
  assert.equal(f.sampler.latest().state, 'stale'); assert.equal(f.sampler.latest().reason, 'collection_unavailable');
  await f.advance(2000); assert.equal(f.sampler.latest().state, 'fresh');
});
test('age staleness follows max(3*cadence,6s) with original timestamp, including partial data', async t => {
  for (const active of [true, false]) {
    const f = fixture(t, (_n, s) => ({ ...s, state: 'partial' }));
    f.sampler.setDemand({ warnings: true, active, identity }); await tick();
    const limit = active ? 6000 : 45000; f.elapse(limit - 1); assert.equal(f.sampler.latest().state, 'partial');
    f.elapse(1); assert.equal(f.sampler.latest().state, 'stale'); assert.equal(f.sampler.latest().sampled_at, 0);
    assert.equal(f.sampler.latest().warning.state, 'unknown');
  }
});
test('runtime change discards prior in-flight result and immediately refreshes new identity', async t => {
  let resolve; let calls = 0; const seen = []; const timers = new Map();
  const tracker = createGpuWarningTracker(); const second = { pid: 11, createdAt: '456' };
  const sampler = createGpuSampler({ tracker, collector: { sample: value => { seen.push(value); calls++;
    return calls === 1 ? new Promise(r => { resolve = r; }) : { state: 'fresh', adapter: { luid: 'b' }, external_processes: [] }; }, dispose() {} },
    setTimer: (fn, ms) => { timers.set(fn, ms); return fn; }, clearTimer: fn => timers.delete(fn) });
  t.after(() => sampler.dispose()); sampler.setDemand({ warnings: true, identity }); await tick();
  sampler.setDemand({ warnings: true, identity: second }); resolve({ state: 'fresh', adapter: { luid: 'a' } }); await tick();
  assert.equal(sampler.latest().adapter, null); const [fn, delay] = [...timers][0]; assert.equal(delay, 0); fn(); await tick();
  assert.deepEqual(seen, [identity, second]); assert.equal(sampler.latest().adapter.luid, 'b');
});
test('ring retains exactly latest sixty snapshots and returned objects cannot mutate retained state', async t => {
  // Inspect the private ring in a test-only module evaluation, without adding a public API.
  const fs = require('node:fs'); const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../services/performance/gpu-sampler'), 'utf8')
    .replace('return { setDemand, latest, dispose };', 'return { setDemand, latest, dispose, retained: () => samples };');
  const sandbox = { module: { exports: {} }, structuredClone, Date, setTimeout, clearTimeout }; vm.runInNewContext(source, sandbox);
  let sequence = 0; let next;
  const sampler = sandbox.module.exports.createGpuSampler({ collector: { sample: () => ({ state: 'fresh', sequence: ++sequence,
    adapter: { luid: 'a' } }), dispose() {} }, tracker: { accept() {}, snapshot: () => ({ state: 'unknown' }) },
    setTimer: fn => { next = fn; return fn; }, clearTimer() {} });
  t.after(() => sampler.dispose()); sampler.setDemand({ counter: true, identity }); await tick();
  for (let i = 0; i < 64; i++) { next(); await tick(); }
  assert.equal(sampler.retained().length, 60); assert.equal(sampler.retained()[0].sequence, 6);
  assert.equal(sampler.latest().sequence, 65); const snapshot = sampler.latest(); snapshot.adapter.luid = 'changed';
  assert.equal(sampler.latest().adapter.luid, 'a'); sampler.dispose(); assert.equal(sampler.retained().length, 0);
});
test('dispose cancels timers and collector exactly once and ignores subsequent demand', async t => {
  const f = fixture(t); f.sampler.setDemand({ counter: true, identity }); await tick(); f.sampler.dispose();
  assert.equal(f.disposed(), true); assert.equal(f.timers.size, 0); f.sampler.dispose();
  f.sampler.setDemand({ counter: true, active: true, identity }); await f.advance(60000); assert.equal(f.calls(), 1);
});
