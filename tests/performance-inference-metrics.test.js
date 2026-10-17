'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAttemptMetrics } = require('../services/performance/inference-metrics');

const ATTEMPT = 'a1'.repeat(16);
const NULLS = {
  generated_tokens: null, decode_interval_tokens: null, decode_elapsed_ms: null,
  prompt_tokens: null, cached_prompt_tokens: null, processed_prompt_tokens: null, prefill_elapsed_ms: null,
  time_to_first_generated_token_ms: null, terminal_decode_tps: null, terminal_prefill_tps: null,
};
let sequence = 0;
function payload(over = {}) {
  return {
    schema_version: 1, request_id: 'r1', trace_id: 't1', session_id: 's1', turn_id: 'turn1', provider_call_id: null,
    attempt_id: ATTEMPT, sequence: sequence++, sampled_at: 1_000_000, phase: 'decode', source: 'provider',
    provider_kind: 'ninfer', ...NULLS, ...over,
  };
}
function fresh(opts) {
  sequence = 0;
  return createAttemptMetrics(opts || {});
}
// One decode observation: `index` steps of `stepMs` provider time, `perStep` tokens each.
function decodeStep(metrics, index, { stepMs = 250, perStep = 25, recv = index * stepMs } = {}) {
  const ok = metrics.observe(payload({
    sampled_at: 1_000_000 + recv,
    generated_tokens: perStep * index + 1,
    decode_interval_tokens: perStep * index,
    decode_elapsed_ms: stepMs * (index + 1),
  }), recv);
  assert.equal(ok, true);
}

test('think_off terminal fixture: 7 decode intervals over 56.3681 ms is 124.18 tok/s, kept as a terminal average', () => {
  const metrics = fresh();
  assert.equal(metrics.observe(payload({
    phase: 'finished', generated_tokens: 8, decode_interval_tokens: 7, decode_elapsed_ms: 56.3681,
    prompt_tokens: 18, cached_prompt_tokens: 0, processed_prompt_tokens: 18, prefill_elapsed_ms: 96.035,
    terminal_decode_tps: 124.18, terminal_prefill_tps: 187.43,
  }), 10), true);
  assert.equal(Number(((7 / 56.3681) * 1000).toFixed(2)), 124.18);
  const projected = metrics.project(20);
  assert.equal(projected.observation.terminal_decode_tps, 124.18);
  assert.equal(projected.observation.decode_interval_tokens, 7);
  // A terminal average is never relabelled as a live rate.
  assert.equal(projected.live_decode.state, 'unavailable');
  assert.equal(projected.live_decode.value, null);
  assert.equal(projected.cache_fraction.value, 0);
  assert.equal(projected.cache_fraction.state, 'available');
});

test('live decode rate uses a 2,000 ms provider window and needs a 1,000 ms span', () => {
  const metrics = fresh();
  for (let i = 0; i < 4; i += 1) decodeStep(metrics, i);
  // elapsed 250..1000: the span between the first and last observation is 750 ms.
  let projected = metrics.project(750);
  assert.equal(projected.live_decode.state, 'warming');
  assert.equal(projected.live_decode.value, null);
  decodeStep(metrics, 4);
  projected = metrics.project(1000);
  assert.equal(projected.live_decode.state, 'available', 'exactly 1,000 ms of span qualifies');
  assert.equal(projected.live_decode.value, 100);
  assert.equal(projected.live_decode.sampled_at, 1_001_000);
  for (let i = 5; i < 12; i += 1) decodeStep(metrics, i);
  projected = metrics.project(2750);
  assert.equal(projected.live_decode.state, 'available');
  assert.equal(projected.live_decode.value, 100);
});

test('the rate window slides: only the last 2,000 ms of provider time counts', () => {
  const metrics = fresh();
  for (let i = 0; i < 10; i += 1) decodeStep(metrics, i, { perStep: 5 }); // 20 tok/s
  let tokens = 5 * 9;
  for (let i = 10; i < 20; i += 1) {
    tokens += 50; // 200 tok/s
    assert.equal(metrics.observe(payload({
      sampled_at: 1_000_000 + i * 250, generated_tokens: tokens + 1, decode_interval_tokens: tokens,
      decode_elapsed_ms: 250 * (i + 1),
    }), i * 250), true);
  }
  assert.equal(metrics.project(19 * 250).live_decode.value, 200);
});

test('at most 16 observations are retained per attempt', () => {
  const metrics = fresh();
  let tokens = 0;
  for (let i = 0; i < 30; i += 1) {
    tokens += i < 14 ? 1 : 10; // 10 tok/s then 100 tok/s (100 ms steps)
    assert.equal(metrics.observe(payload({
      sampled_at: 1_000_000 + i * 100, generated_tokens: tokens + 1, decode_interval_tokens: tokens,
      decode_elapsed_ms: 100 * (i + 1),
    }), i * 100), true);
  }
  // Retained: observations 14..29 (1,500 ms of span). Uncapped, the 2,000 ms window would reach back to 9.
  const projected = metrics.project(29 * 100);
  assert.equal(projected.live_decode.state, 'available');
  assert.equal(projected.live_decode.value, 100);
});

test('the live rate goes stale 2,500 ms after the last measured observation and keeps its original timestamp', () => {
  const metrics = fresh();
  for (let i = 0; i < 6; i += 1) decodeStep(metrics, i);
  const lastRecv = 5 * 250;
  const live = metrics.project(lastRecv + 2499).live_decode;
  assert.equal(live.state, 'available');
  const stale = metrics.project(lastRecv + 2500).live_decode;
  assert.equal(stale.state, 'stale');
  assert.equal(stale.sampled_at, live.sampled_at);
  assert.equal(stale.sampled_at, 1_000_000 + lastRecv);
  // An observation that measures nothing new does not refresh the clock.
  assert.equal(metrics.observe(payload({
    sampled_at: 1_000_000 + lastRecv + 2000, phase: 'decode',
    generated_tokens: 126, decode_interval_tokens: 125, decode_elapsed_ms: 1500,
  }), lastRecv + 2000), true);
  assert.equal(metrics.project(lastRecv + 2500).live_decode.state, 'stale');
});

test('live prefill is measured on processed minus cached tokens over provider prefill time', () => {
  const metrics = fresh();
  for (let i = 1; i <= 5; i += 1) {
    assert.equal(metrics.observe(payload({
      sampled_at: 1_000_000 + i * 250, phase: 'prefill', prompt_tokens: 6100, cached_prompt_tokens: 100,
      processed_prompt_tokens: 100 + 1000 * i, prefill_elapsed_ms: 250 * i,
    }), i * 250), true);
  }
  const prefill = metrics.project(1250).live_prefill;
  assert.equal(prefill.state, 'available');
  // (5100 - 1100 fresh tokens) over 1,000 ms.
  assert.equal(prefill.value, 4000);
  assert.equal(metrics.project(1250).cache_fraction.value, 100 / 6100);
});

test('prefill stays warming until its span reaches 1,000 ms', () => {
  const metrics = fresh();
  for (let i = 1; i <= 3; i += 1) {
    metrics.observe(payload({
      phase: 'prefill', prompt_tokens: 3000, cached_prompt_tokens: 0, processed_prompt_tokens: 500 * i,
      prefill_elapsed_ms: 250 * i,
    }), i * 250);
  }
  assert.equal(metrics.project(750).live_prefill.state, 'warming');
});

test('a full cache hit has no fresh prompt work: prefill rate is not_applicable', () => {
  const metrics = fresh();
  metrics.observe(payload({
    phase: 'prefill', prompt_tokens: 2048, cached_prompt_tokens: 2048, processed_prompt_tokens: 2048, prefill_elapsed_ms: 12,
  }), 5);
  const projected = metrics.project(10);
  assert.equal(projected.live_prefill.state, 'not_applicable');
  assert.equal(projected.live_prefill.value, null);
  assert.equal(projected.cache_fraction.value, 1);
});

test('cache fraction: zero cached, zero total, and unknown cached never divide by zero', () => {
  let metrics = fresh();
  metrics.observe(payload({ prompt_tokens: 100, cached_prompt_tokens: 0, processed_prompt_tokens: 100 }), 1);
  assert.deepEqual(
    { ...metrics.project(2).cache_fraction },
    { value: 0, state: 'available', sampled_at: 1_000_000 }
  );
  metrics = fresh();
  metrics.observe(payload({ prompt_tokens: 0, cached_prompt_tokens: 0, processed_prompt_tokens: 0 }), 1);
  assert.equal(metrics.project(2).cache_fraction.state, 'not_applicable');
  assert.equal(metrics.project(2).cache_fraction.value, null);
  metrics = fresh();
  metrics.observe(payload({ prompt_tokens: 100, cached_prompt_tokens: null }), 1);
  assert.equal(metrics.project(2).cache_fraction.state, 'unavailable');
  metrics = fresh();
  metrics.observe(payload({ prompt_tokens: null, cached_prompt_tokens: null }), 1);
  assert.equal(metrics.project(2).cache_fraction.state, 'unavailable');
});

test('stale or out-of-order sequences are refused and nothing is accepted after a terminal phase', () => {
  const metrics = fresh();
  assert.equal(metrics.observe(payload({ sequence: 5 }), 1), true);
  assert.equal(metrics.observe(payload({ sequence: 5 }), 2), false);
  assert.equal(metrics.observe(payload({ sequence: 4 }), 3), false);
  assert.equal(metrics.observe(payload({ sequence: 6, phase: 'finished' }), 4), true);
  assert.equal(metrics.observe(payload({ sequence: 7 }), 5), false);
  assert.equal(metrics.observe({ schema_version: 2 }, 6), false);
  assert.equal(metrics.observe(null, 7), false);
});

test('a decreasing cumulative field marks that metric unavailable for the attempt without refusing the observation', () => {
  const metrics = fresh();
  for (let i = 0; i < 6; i += 1) decodeStep(metrics, i);
  assert.equal(metrics.project(5 * 250).live_decode.state, 'available');
  assert.equal(metrics.observe(payload({
    generated_tokens: 3, decode_interval_tokens: 2, decode_elapsed_ms: 100,
  }), 1500), true);
  const projected = metrics.project(1500);
  assert.equal(projected.live_decode.state, 'unavailable');
  assert.equal(projected.observation.decode_elapsed_ms, null);
  // Later monotonic readings do not revive the poisoned metric.
  decodeStep(metrics, 20);
  assert.equal(metrics.project(20 * 250).live_decode.state, 'unavailable');
});

test('out-of-range fields are nulled and a cached > processed contradiction disables prefill metrics', () => {
  const metrics = fresh();
  metrics.observe(payload({
    generated_tokens: 2_000_000, decode_elapsed_ms: -1, terminal_decode_tps: 20_000_000, time_to_first_generated_token_ms: Infinity,
    prompt_tokens: 100, cached_prompt_tokens: 90, processed_prompt_tokens: 50, prefill_elapsed_ms: 10,
  }), 1);
  const { observation, live_prefill: prefill, cache_fraction: cache } = metrics.project(2);
  assert.equal(observation.generated_tokens, null);
  assert.equal(observation.decode_elapsed_ms, null);
  assert.equal(observation.terminal_decode_tps, null);
  assert.equal(observation.time_to_first_generated_token_ms, null);
  assert.equal(observation.processed_prompt_tokens, null);
  assert.equal(prefill.state, 'unavailable');
  assert.equal(cache.state, 'unavailable');
});

test('only a live-capable provider reports a warming live metric; llama-server and ollama stay unavailable', () => {
  const ninfer = fresh();
  ninfer.observe(payload({ phase: 'waiting' }), 1);
  assert.equal(ninfer.project(2).live_decode.state, 'warming');
  assert.equal(ninfer.project(2).live_prefill.state, 'warming');
  for (const provider_kind of ['llama-server', 'ollama', 'other']) {
    const metrics = fresh();
    metrics.observe(payload({ phase: 'waiting', provider_kind }), 1);
    assert.equal(metrics.project(2).live_decode.state, 'unavailable', provider_kind);
    assert.equal(metrics.project(2).live_prefill.state, 'unavailable', provider_kind);
  }
  const notRequested = fresh({ live: false });
  notRequested.observe(payload({ phase: 'waiting' }), 1);
  assert.equal(notRequested.project(2).live_decode.state, 'unavailable');
});

test('project returns detached copies', () => {
  const metrics = fresh();
  metrics.observe(payload({ prompt_tokens: 10, cached_prompt_tokens: 0 }), 1);
  const first = metrics.project(2);
  first.observation.prompt_tokens = 999;
  first.cache_fraction.value = 5;
  assert.equal(metrics.project(2).observation.prompt_tokens, 10);
  assert.equal(metrics.project(2).cache_fraction.value, 0);
});
