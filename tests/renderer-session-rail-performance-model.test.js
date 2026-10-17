'use strict';

/* Row 59 checkpoint 6 (renderer): the Performance section's pure model and markup. Every metric state,
   stale never shown as live, finished turns labelled as averages, the engine named when a metric is
   unavailable, the host scope line, and the toggle readout's source value. */

const test = require('node:test');
const assert = require('node:assert/strict');
const perf = require('../renderer/chat/renderer-session-rail-performance.js');
const { SECTION_KEYS } = require('../renderer/chat/renderer-session-rail-model.js');
const fx = require('./helpers/performance-snapshot-fixture.js');

const view = (overrides = {}, ageMs = 0) => perf.buildPerformanceView({ snapshot: fx.snapshot(overrides), ageMs });
const row = (v, key) => v.rows.find((entry) => entry.key === key);

test('the section is not a summary section and the rows come in the PO order', () => {
  assert.equal(SECTION_KEYS.includes('performance'), false);
  const v = view();
  assert.deepEqual(v.rows.map((entry) => entry.label), ['Writing', 'Prompt reading', 'First token', 'Reused from cache']);
  assert.equal(v.title, 'Performance');
});

test('available: live rates, first token and cache reuse read as values', () => {
  const v = view();
  assert.equal(row(v, 'writing').text, '182 tok/s');
  assert.equal(row(v, 'writing').state, 'available');
  assert.equal(row(v, 'prompt_reading').text, '8.8k tok/s');
  assert.equal(row(v, 'first_token').text, '640 ms');
  assert.equal(row(v, 'cache').text, '60%');
  assert.equal(v.header, '182 tok/s');
  assert.equal(v.readout, '182 tok/s');
  assert.equal(v.live, true);
});

test('formatters: rate tiers, durations and bytes', () => {
  assert.equal(perf.formatRate(7.26), '7.3 tok/s');
  assert.equal(perf.formatRate(124.18), '124 tok/s');
  assert.equal(perf.formatRate(10_000), '10.0k tok/s');
  assert.equal(perf.formatRate(null), '');
  assert.equal(perf.formatDuration(999), '999 ms');
  assert.equal(perf.formatDuration(1500), '1.5 s');
  assert.equal(perf.formatGigabytes(7.2 * fx.GiB), '7.2 GB');
  assert.equal(perf.formatPercent(0.604), '60%');
  assert.equal(perf.formatPercent(null), '');
});

test('warming reads "Measuring…" and no readout is offered', () => {
  const v = view({ inference: fx.inference({ live_decode: fx.metric(null, 'warming', null), live_prefill: fx.metric(null, 'warming', null) }) });
  assert.equal(row(v, 'writing').text, 'Measuring…');
  assert.equal(row(v, 'writing').tone, 'muted');
  assert.equal(v.header, 'Measuring…');
  assert.equal(v.readout, '');
  assert.equal(v.live, true);
});

test('stale keeps its value labelled "stale" and is never a live reading or a readout', () => {
  const v = view({ inference: fx.inference({ live_decode: fx.metric(180, 'stale', 900), live_prefill: fx.metric(null, 'stale', 900) }) });
  assert.equal(row(v, 'writing').text, '180 tok/s');
  assert.equal(row(v, 'writing').meta, 'stale');
  assert.equal(row(v, 'writing').state, 'stale');
  assert.equal(row(v, 'writing').tone, 'muted');
  assert.equal(row(v, 'prompt_reading').text, '');
  assert.equal(row(v, 'prompt_reading').meta, 'stale');
  assert.equal(v.header, 'stale');
  assert.equal(v.readout, '', 'a stale number is not on display');
});

test('an "available" reading older than the freshness window is aged to stale locally', () => {
  const fresh = view({}, perf.LOCAL_STALE_MS);
  assert.equal(row(fresh, 'writing').state, 'available');
  const aged = view({}, perf.LOCAL_STALE_MS + 1);
  assert.equal(row(aged, 'writing').state, 'stale');
  assert.equal(row(aged, 'writing').meta, 'stale');
  assert.equal(row(aged, 'writing').text, '182 tok/s');
  assert.equal(aged.readout, '');
  assert.equal(aged.header, 'stale');
  assert.equal(row(aged, 'cache').state, 'available', 'a cache proportion is a cumulative fact, not a live rate');
});

test('a finished turn shows the terminal averages, labelled as averages', () => {
  const finished = fx.observation({ phase: 'finished', terminal_decode_tps: 124.18, terminal_prefill_tps: 5200 });
  const v = view({ inference: fx.inference({ observation: finished, live_decode: fx.metric(180, 'stale', 900), live_prefill: fx.metric(8000, 'stale', 900) }) });
  assert.equal(row(v, 'writing').text, '124 tok/s');
  assert.equal(row(v, 'writing').meta, 'average');
  assert.equal(row(v, 'writing').state, 'average');
  assert.equal(row(v, 'prompt_reading').text, '5.2k tok/s');
  assert.equal(row(v, 'prompt_reading').meta, 'average');
  assert.equal(v.readout, '');
  assert.equal(v.live, false);
});

test('a finished turn without a terminal average never relabels a live number as one', () => {
  const finished = fx.observation({ phase: 'cancelled', terminal_decode_tps: null });
  const v = view({ inference: fx.inference({ observation: finished, live_decode: fx.metric(180, 'stale', 900) }) });
  assert.equal(row(v, 'writing').meta, 'stale');
  assert.notEqual(row(v, 'writing').state, 'average');
});

test('unavailable names the engine; an unknown engine says "this engine"', () => {
  const unavailable = { live_decode: fx.metric(null, 'unavailable', null), live_prefill: fx.metric(null, 'unavailable', null), cache_fraction: fx.metric(null, 'unavailable', null) };
  const ollama = view({ inference: fx.inference({ observation: fx.observation({ provider_kind: 'ollama', phase: 'decode', time_to_first_generated_token_ms: null }), ...unavailable }) });
  assert.equal(row(ollama, 'writing').text, 'not reported by Ollama');
  assert.equal(row(ollama, 'prompt_reading').text, 'not reported by Ollama');
  assert.equal(row(ollama, 'cache').text, 'not reported by Ollama');
  assert.equal(row(ollama, 'first_token').text, 'not reported by Ollama');
  const llama = view({ inference: fx.inference({ observation: fx.observation({ provider_kind: 'llama-server' }), ...unavailable }) });
  assert.equal(row(llama, 'writing').text, 'not reported by llama-server');
  const unknown = view({ inference: fx.inference({ observation: null, ...unavailable }) });
  assert.equal(row(unknown, 'writing').text, 'not reported by this engine');
});

test('not_applicable is a dash; available_next_request is a short hint', () => {
  const v = view({ inference: fx.inference({ live_prefill: fx.metric(null, 'not_applicable', 1000), live_decode: fx.metric(null, 'available_next_request', null) }) });
  assert.equal(row(v, 'prompt_reading').text, '—');
  assert.equal(row(v, 'prompt_reading').state, 'not_applicable');
  assert.equal(row(v, 'writing').text, 'from the next request');
  assert.equal(row(v, 'writing').state, 'available_next_request');
  assert.equal(v.readout, '');
});

test('idle (no request yet) reads dashes, not zeros', () => {
  const v = view({ inference: null });
  assert.deepEqual(v.rows.map((entry) => entry.text), ['—', '—', '—', '—']);
  assert.equal(v.header, '');
  assert.equal(v.readout, '');
  assert.equal(v.live, false);
});

test('first token: measuring while the request has not produced output yet', () => {
  const waiting = view({ inference: fx.inference({ observation: fx.observation({ phase: 'prefill', time_to_first_generated_token_ms: null }), live_decode: fx.metric(null, 'warming', null) }) });
  assert.equal(row(waiting, 'first_token').text, 'Measuring…');
  const slow = view({ inference: fx.inference({ observation: fx.observation({ time_to_first_generated_token_ms: 2400 }) }) });
  assert.equal(row(slow, 'first_token').text, '2.4 s');
});

test('the counter off: the view is disabled and offers nothing', () => {
  const v = view({ settings: fx.settings({ show_counter: false }) });
  assert.equal(v.enabled, false);
  assert.equal(v.readout, '');
  assert.equal(v.live, false);
  assert.equal(perf.buildPerformanceView({ snapshot: null }).enabled, false);
});

test('scope line: host scope with free/total and the managed process; unknown stays unknown', () => {
  const full = perf.describeScope(fx.gpu(), (k, d, p) => (p ? d.replace(/\{(\w+)\}/g, (m, n) => p[n]) : d));
  assert.equal(full.headline, 'This PC · GPU 7.2 GB of 32.0 GB free');
  assert.equal(full.detail, 'Engine · 24.1 GB dedicated · 0.2 GB shared');
  const sharedUnknown = perf.describeScope(fx.gpu({ managed_process: { pid: 1, created_at: '1', basename: 'x', dedicated_bytes: 2 * fx.GiB, shared_bytes: null } }));
  assert.equal(sharedUnknown.detail, 'Engine · 2.0 GB dedicated');
  const none = perf.describeScope(fx.gpu({ managed_process: null }));
  assert.equal(none.detail, '');
  const unavailable = perf.describeScope(fx.gpu({ state: 'unavailable', adapter: null }));
  assert.equal(unavailable.headline, 'This PC · GPU not reported');
  assert.equal(perf.describeScope(null).headline, 'This PC · GPU not reported');
  const stale = perf.describeScope(fx.gpu({ state: 'stale' }));
  assert.match(stale.headline, /free · stale$/);
});

test('markup: rows carry data-state, the scope line is last, values are escaped', () => {
  const html = perf.bodyHtml(perf.buildPerformanceView({ snapshot: fx.snapshot({
    gpu: fx.gpu({ managed_process: { pid: 1, created_at: '1', basename: '<img src=x onerror=1>', dedicated_bytes: fx.GiB, shared_bytes: 0 } }),
  }) }));
  assert.match(html, /data-row-key="writing" data-state="available"/);
  assert.match(html, /session-rail-perf-scope/);
  assert.ok(html.lastIndexOf('session-rail-perf-scope') > html.lastIndexOf('data-row-key="cache"'));
  assert.doesNotMatch(html, /<img/);
  const stale = perf.bodyHtml(view({ inference: fx.inference({ live_decode: fx.metric(180, 'stale', 900) }) }));
  assert.match(stale, /data-state="stale"[^>]*>.*session-rail-perf-meta">stale</s);
});
