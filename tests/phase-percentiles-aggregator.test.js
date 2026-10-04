const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PHASE_PERCENTILE_TARGETS,
  createPhasePercentilesAggregator,
  normalizePhaseClientTiming,
} = require('../services/backend/phase-percentiles-aggregator');

test('phase percentiles aggregator uses nearest-rank percentiles', () => {
  const aggregator = createPhasePercentilesAggregator({ samplesPerPhase: 256 });

  for (let value = 1; value <= 100; value += 1) {
    assert.equal(aggregator.record('provider_request_start_to_first_chunk', value), true);
  }

  const snapshot = aggregator.snapshot();
  const phase = snapshot.phases.provider_request_start_to_first_chunk;
  assert.equal(phase.count, 100);
  assert.equal(phase.p50, 50);
  assert.equal(phase.p95, 95);
  assert.equal(phase.p99, 99);
  assert.equal(phase.min, 1);
  assert.equal(phase.max, 100);
  assert.equal(phase.last_N, 100);
  assert.deepEqual(snapshot.targets, PHASE_PERCENTILE_TARGETS);
});

test('phase percentiles aggregator rolls over per phase', () => {
  const aggregator = createPhasePercentilesAggregator({ samplesPerPhase: 3 });

  assert.equal(aggregator.record('click_to_optimistic_render', 1), true);
  assert.equal(aggregator.record('click_to_optimistic_render', 2), true);
  assert.equal(aggregator.record('click_to_optimistic_render', 3), true);
  assert.equal(aggregator.record('click_to_optimistic_render', 4), true);

  const phase = aggregator.snapshot().phases.click_to_optimistic_render;
  assert.equal(phase.count, 3);
  assert.equal(phase.min, 2);
  assert.equal(phase.max, 4);
  assert.equal(phase.p50, 3);
  assert.equal(phase.p95, 4);
});

test('phase percentiles aggregator rejects invalid samples', () => {
  const aggregator = createPhasePercentilesAggregator();

  assert.equal(aggregator.record('', 12), false);
  assert.equal(aggregator.record('unbounded_user_phase', 12), false);
  assert.equal(aggregator.record('phase', -1), false);
  assert.equal(aggregator.record('phase', Number.NaN), false);
  assert.equal(aggregator.record('phase', Number.POSITIVE_INFINITY), false);

  assert.deepEqual(aggregator.snapshot().phases, {});
});

test('phase percentiles aggregator reset clears samples', () => {
  const aggregator = createPhasePercentilesAggregator();

  assert.equal(aggregator.record('completion_to_terminal_persist', 42), true);
  assert.equal(aggregator.snapshot().phases.completion_to_terminal_persist.count, 1);

  const resetSnapshot = aggregator.reset();
  assert.deepEqual(resetSnapshot.phases, {});
  assert.deepEqual(aggregator.snapshot().phases, {});
});

test('phase client timing normalization derives local render latency when omitted', () => {
  assert.deepEqual(
    normalizePhaseClientTiming({
      send_started_at_ms: 100,
      optimistic_rendered_at_ms: 135,
    }),
    {
      sendStartedAtMs: 100,
      optimisticRenderedAtMs: 135,
      localRenderLatencyMs: 35,
    }
  );

  assert.deepEqual(
    normalizePhaseClientTiming({
      send_started_at_ms: 100,
      optimistic_rendered_at_ms: 135,
      local_render_latency_ms: 12,
    }),
    {
      sendStartedAtMs: 100,
      optimisticRenderedAtMs: 135,
      localRenderLatencyMs: 12,
    }
  );
});

test('absent client timing is "not measured", never a 0 ms sample (P3-PERF-A 2026-09-25)', () => {
  // Number(null) === 0 used to pass the finite check, so every turn without
  // renderer timing recorded click_to_optimistic_render = 0.
  const aggregator = createPhasePercentilesAggregator();
  for (const value of [null, undefined, '', '   ', true]) {
    assert.equal(aggregator.record('click_to_optimistic_render', value), false, `recorded ${String(value)}`);
  }
  assert.deepEqual(aggregator.snapshot().phases, {});
  assert.equal(aggregator.record('click_to_optimistic_render', 0), true, 'a real 0 ms duration is still a sample');

  const missing = { sendStartedAtMs: null, optimisticRenderedAtMs: null, localRenderLatencyMs: null };
  assert.deepEqual(normalizePhaseClientTiming(null), missing);
  assert.deepEqual(normalizePhaseClientTiming({
    send_started_at_ms: null, optimistic_rendered_at_ms: null, local_render_latency_ms: null,
  }), missing);
  // 0 is the renderer's "unknown start" fallback, not a wall-clock timestamp.
  assert.deepEqual(normalizePhaseClientTiming({ send_started_at_ms: 0, optimistic_rendered_at_ms: 135 }),
    { sendStartedAtMs: null, optimisticRenderedAtMs: 135, localRenderLatencyMs: null });
});
