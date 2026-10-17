'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGpuWarningTracker } = require('../services/performance/gpu-warning-state');
const GiB = 1024 ** 3;
const identity = { pid: 10, createdAt: '123' };
function fixture() {
  let time = 0; let id = 0;
  const tracker = createGpuWarningTracker({ now: () => time, uuid: () => `warning-${++id}` });
  const sample = (free = 2 * GiB, shared = 0, extra = {}) => ({ state: 'fresh',
    adapter: { luid: 'a', dedicated_free_bytes: free },
    managed_process: { pid: 10, created_at: '123', shared_bytes: shared }, external_processes: [], ...extra });
  const feed = (s, count = 1, options = {}) => { for (let i = 0; i < count; i++) tracker.accept(s, { runtimeIdentity: identity, active: true, ...options }); return tracker.snapshot(); };
  return { tracker, sample, feed, advance: ms => { time += ms; } };
}
test('three active low samples trigger; gap resets; hysteresis latches until five healthy samples', () => {
  const f = fixture(); assert.equal(f.tracker.snapshot().state, 'unknown');
  f.feed(f.sample(.5 * GiB), 2); assert.equal(f.tracker.snapshot().warning_id, null);
  f.feed(f.sample(1.2 * GiB)); f.feed(f.sample(.5 * GiB), 2);
  assert.equal(f.tracker.snapshot().warning_id, null);
  const triggered = f.feed(f.sample(.5 * GiB)); assert.equal(triggered.state, 'low_headroom');
  f.feed(f.sample(1.2 * GiB), 8); assert.equal(f.tracker.snapshot().warning_id, triggered.warning_id);
  f.feed(f.sample(2 * GiB), 4, { active: false }); assert.equal(f.tracker.snapshot().state, 'low_headroom');
  assert.equal(f.feed(f.sample(2 * GiB), 1, { active: false }).state, 'clear');
  assert.equal(f.tracker.dismiss(triggered.warning_id).reason, 'stale_warning');
});
test('idle low samples never start an episode and exact thresholds are respected', () => {
  const f = fixture(); f.feed(f.sample(0), 5, { active: false });
  assert.equal(f.tracker.snapshot().warning_id, null);
  f.feed(f.sample(GiB), 3); assert.equal(f.tracker.snapshot().warning_id, null);
  f.feed(f.sample(GiB - 1), 3); assert.equal(f.tracker.snapshot().state, 'low_headroom');
  f.feed(f.sample(1.5 * GiB - 1), 5); assert.equal(f.tracker.snapshot().state, 'low_headroom');
  assert.equal(f.feed(f.sample(1.5 * GiB), 5).state, 'clear');
});
test('baseline is fixed median of first five healthy samples; spill needs three consecutive increases', () => {
  const f = fixture(); for (const n of [100, 500, 300, 200, 400]) f.feed(f.sample(2 * GiB, n));
  f.feed(f.sample(2 * GiB, 9 * GiB), 5);
  f.feed(f.sample(.5 * GiB, 300 + .5 * GiB), 2);
  assert.equal(f.feed(f.sample(.5 * GiB, 300 + .5 * GiB)).state, 'possible_spill');
  assert.equal(f.feed(f.sample(.5 * GiB, 299 + .5 * GiB)).state, 'low_headroom');
});
test('no baseline means no spill; identity and adapter changes reset baseline and episode', () => {
  const f = fixture(); assert.equal(f.feed(f.sample(0, 4 * GiB), 3).state, 'low_headroom');
  f.feed(f.sample(2 * GiB), 5); f.feed(f.sample(0, GiB), 3);
  assert.equal(f.tracker.snapshot().state, 'possible_spill');
  f.feed(f.sample(0, GiB), 3, { runtimeIdentity: { pid: 10, createdAt: '456' } });
  assert.equal(f.tracker.snapshot().state, 'low_headroom');
  f.feed(f.sample(0, GiB, { adapter: { luid: 'b', dedicated_free_bytes: 0 } }), 3);
  assert.equal(f.tracker.snapshot().state, 'low_headroom');
});
test('inside a latched episode spill keeps counting between the thresholds', () => {
  const f = fixture(); f.feed(f.sample(2 * GiB, 0), 5); f.feed(f.sample(.5 * GiB), 3);
  const between = 1.25 * GiB;
  assert.equal(f.feed(f.sample(between, GiB), 3).state, 'possible_spill');
  assert.equal(f.feed(f.sample(between, GiB), 2, { active: false }).state, 'possible_spill');
});
test('the default clock publishes wall-clock timestamps', () => {
  const tracker = createGpuWarningTracker(); const before = Date.now();
  const sample = { state: 'fresh', adapter: { luid: 'a', dedicated_free_bytes: 0 },
    managed_process: { pid: 10, created_at: '123', shared_bytes: 0 }, external_processes: [] };
  for (let i = 0; i < 3; i++) tracker.accept(sample, { runtimeIdentity: identity, active: true });
  assert.ok(tracker.snapshot().since >= before);
});
test('contention requires the same observed process all three samples, spill has priority', () => {
  const f = fixture(); f.feed(f.sample(), 5);
  const external = pid => [{ pid, created_at: 'x', dedicated_bytes: .25 * GiB }];
  f.feed(f.sample(0, 0, { external_processes: external(20) }), 2);
  assert.equal(f.feed(f.sample(0, 0, { external_processes: external(21) })).state, 'low_headroom');
  assert.equal(f.feed(f.sample(0, 0, { external_processes: external(21) }), 2).state, 'possible_contention');
  assert.equal(f.feed(f.sample(0, GiB, { external_processes: external(21) }), 3).state, 'possible_spill');
});
test('partial coverage supports positive contention; headroom (adapter free memory) still clears', () => {
  const f = fixture(); const s = f.sample(0, 0, { state: 'partial', truncated: true,
    external_processes: [{ pid: 20, created_at: 'x', dedicated_bytes: .25 * GiB }] });
  assert.equal(f.feed(s, 3).state, 'possible_contention');
  assert.equal(f.feed(f.sample(2 * GiB, 0, { state: 'partial' }), 4).state, 'low_headroom', 'latched until five healthy samples');
  assert.equal(f.feed(f.sample(2 * GiB, 0, { state: 'partial' })).state, 'clear');
});
test('stale, failed and missing evidence project unknown, retain episode and reset counters', () => {
  const f = fixture(); const w = f.feed(f.sample(0), 3);
  for (const state of ['stale', 'unavailable']) {
    assert.equal(f.feed({ state }).state, 'unknown');
    assert.equal(f.tracker.snapshot().last_confirmed_state, 'low_headroom');
    assert.equal(f.tracker.snapshot().warning_id, w.warning_id);
  }
  assert.equal(f.feed(f.sample(null), 6).state, 'unknown');
  f.feed(f.sample(), 4); f.feed({ state: 'stale' }); f.feed(f.sample(), 4);
  assert.equal(f.tracker.snapshot().warning_id, w.warning_id);
  assert.equal(f.feed(f.sample()).state, 'clear');
});
test('dismissal lasts ten minutes, IDs are episode-stable, worsening spill resurfaces only once', () => {
  const f = fixture(); f.feed(f.sample(), 5); const w = f.feed(f.sample(0), 3);
  assert.deepEqual(f.tracker.dismiss('old'), { ok: false, reason: 'stale_warning' });
  assert.deepEqual(f.tracker.dismiss(w.warning_id), { ok: true });
  assert.equal(f.tracker.snapshot().dismissed_until, 600000);
  f.advance(100); const spill = f.feed(f.sample(0, GiB), 3);
  assert.equal(spill.warning_id, w.warning_id); assert.equal(spill.dismissed_until, null);
  f.tracker.dismiss(w.warning_id); f.feed(f.sample(0));
  assert.equal(f.feed(f.sample(0, GiB), 3).dismissed_until, 600100);
  f.advance(600001); assert.equal(f.tracker.snapshot().dismissed_until, null);
  f.feed(f.sample(), 5); assert.equal(f.tracker.dismiss(w.warning_id).ok, false);
  assert.notEqual(f.feed(f.sample(0), 3).warning_id, w.warning_id);
});
test('dismissal suppresses a repeated condition for the same identity across episodes only', () => {
  const f = fixture(); const w = f.feed(f.sample(0), 3); f.tracker.dismiss(w.warning_id);
  f.feed(f.sample(), 5); assert.equal(f.feed(f.sample(0), 3).dismissed_until, 600000);
  assert.equal(f.feed(f.sample(0), 3, { runtimeIdentity: { pid: 11, createdAt: '123' } }).dismissed_until, null);
});
test('runtime change invalidates the old warning even on a failed refresh; missing shared cannot clear', () => {
  const f = fixture(); f.feed(f.sample(), 5); const w = f.feed(f.sample(0), 3);
  assert.equal(f.feed(f.sample(2 * GiB, null), 5).state, 'unknown');
  assert.equal(f.tracker.snapshot().warning_id, w.warning_id);
  f.feed({ state: 'unavailable' }, 1, { runtimeIdentity: { pid: 11, createdAt: '456' } });
  assert.equal(f.tracker.snapshot().warning_id, null); assert.equal(f.tracker.dismiss(w.warning_id).ok, false);
});
test('a dismissed spill does not resurface again after healthy clearance and a new low episode', () => {
  const f = fixture(); f.feed(f.sample(), 5); let w = f.feed(f.sample(0), 3); f.tracker.dismiss(w.warning_id);
  w = f.feed(f.sample(0, GiB), 3); assert.equal(w.dismissed_until, null); f.tracker.dismiss(w.warning_id);
  f.feed(f.sample(), 5); f.feed(f.sample(0), 3);
  assert.equal(f.feed(f.sample(0, GiB), 3).dismissed_until, 600000);
});
test('worsening spill resurfaces only once during dismissal even without a second dismiss', () => {
  const f = fixture(); f.feed(f.sample(), 5); const w = f.feed(f.sample(0), 3); f.tracker.dismiss(w.warning_id);
  assert.equal(f.feed(f.sample(0, GiB), 3).dismissed_until, null);
  f.feed(f.sample(0)); assert.equal(f.feed(f.sample(0, GiB), 3).dismissed_until, 600000);
});
test('positive partial evidence can accumulate within an already latched episode', () => {
  for (const condition of ['possible_spill', 'possible_contention']) {
    const f = fixture(); f.feed(f.sample(), 5); f.feed(f.sample(0), 3);
    const extra = { state: 'partial', external_processes: condition === 'possible_contention'
      ? [{ pid: 20, created_at: 'x', dedicated_bytes: .25 * GiB }] : [] };
    const sample = f.sample(0, condition === 'possible_spill' ? GiB : 0, extra);
    assert.equal(f.feed(sample, 2).state, 'low_headroom'); assert.equal(f.feed(sample).state, condition);
  }
});
test('three partial low samples raise low headroom: process coverage never hides the adapter reading', () => {
  const f = fixture(); const s = f.sample(.5 * GiB, 0, { state: 'partial', truncated: true });
  const w = f.feed(s, 3);
  assert.equal(w.state, 'low_headroom'); assert.ok(w.warning_id);
});
test('a dismissal covers weaker conditions, so one noisy sample does not re-alert inside the episode', () => {
  const f = fixture(); f.feed(f.sample(), 5);
  const spill = f.feed(f.sample(0, GiB), 3);
  assert.equal(spill.state, 'possible_spill');
  f.tracker.dismiss(spill.warning_id);
  const noisy = f.feed(f.sample(0, 0));
  assert.equal(noisy.state, 'low_headroom'); assert.equal(noisy.dismissed_until, 600000);
  f.advance(600001); assert.equal(f.tracker.snapshot().dismissed_until, null);
});
