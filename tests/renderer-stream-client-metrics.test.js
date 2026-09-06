const { test } = require('node:test');
const assert = require('node:assert');

const { createStreamClientMetrics } = require('../renderer/chat/renderer-stream-client-metrics');

test('counts deltas and render kinds per stream and derives first-paint latency', () => {
  let clock = 1000;
  const metrics = createStreamClientMetrics({ now: () => clock, ship: () => {} });

  metrics.noteDelta('stream-1', 'session-1');
  clock = 1040;
  metrics.noteRenderForSession('session-1', 'patch');
  metrics.noteDelta('stream-1', 'session-1');
  metrics.noteRenderForSession('session-1', 'patch');
  metrics.noteRenderForSession('session-1', 'noop');
  metrics.noteRenderForSession('session-1', 'full');

  const snapshot = metrics.take('stream-1');
  assert.deepStrictEqual(snapshot, {
    deltas_received: 2,
    first_delta_at_ms: 1000,
    first_paint_at_ms: 1040,
    first_delta_to_first_paint_ms: 40,
    last_delta_to_terminal_ms: 0,
    stream_reveal_patches_applied: 2,
    full_renders: 1,
    noop_renders: 1,
    reasoning_header_rewrites: 0,
    reasoning_header_morphs: 0,
    reasoning_body_renders: 0,
    reasoning_body_full_renders: 0,
    reasoning_body_fallback_reasons: Object.create(null),
    reasoning_body_render_ms_max: 0,
    reasoning_peak_entry_chars: 0,
    mailbox_peak_depth: 0,
    mailbox_peak_queued_bytes: 0,
    mailbox_dropped: 0,
    // A full render charged with no reason still counts; the tally stays empty.
    full_render_reasons: {},
  });
  // take() removes the entry — a second take yields nothing.
  assert.strictEqual(metrics.take('stream-1'), null);
});

test('counts reasoning header rewrites vs morphs without touching first-paint latency', () => {
  const metrics = createStreamClientMetrics({ now: () => 100, ship: () => {} });
  metrics.noteDelta('stream-h', 'session-h');
  metrics.noteRenderForSession('session-h', 'reasoning_header_rewrite');
  metrics.noteRenderForSession('session-h', 'reasoning_header_rewrite');
  metrics.noteRenderForSession('session-h', 'reasoning_header_morph');
  const snapshot = metrics.take('stream-h');
  assert.strictEqual(snapshot.reasoning_header_rewrites, 2);
  assert.strictEqual(snapshot.reasoning_header_morphs, 1);
  // Header sub-counters are intra-patch cost markers, not paint events.
  assert.strictEqual(snapshot.first_paint_at_ms, null);
});

test('reasoning body render counters accumulate and ship with snake_case names', () => {
  const metrics = createStreamClientMetrics({ now: () => 100, ship: () => {} });
  metrics.noteDelta('stream-reasoning', 'session-reasoning');
  metrics.noteReasoningBodyRender({
    mode: 'full',
    fallbackReason: 'initial',
    durationMs: 1.234,
    entryChars: 120,
  });
  metrics.noteReasoningBodyRender({
    mode: 'incremental',
    fallbackReason: '',
    durationMs: 4.567,
    entryChars: 90,
  });
  metrics.noteReasoningBodyRender({
    mode: 'full',
    fallbackReason: 'no_stable_prefix',
    durationMs: 2.345,
    entryChars: 160,
  });

  const snapshot = metrics.take('stream-reasoning');
  assert.strictEqual(snapshot.reasoning_body_renders, 3);
  assert.strictEqual(snapshot.reasoning_body_full_renders, 2);
  assert.deepStrictEqual({ ...snapshot.reasoning_body_fallback_reasons }, {
    initial: 1,
    no_stable_prefix: 1,
  });
  assert.strictEqual(snapshot.reasoning_body_render_ms_max, 4.57);
  assert.strictEqual(snapshot.reasoning_peak_entry_chars, 160);
  assert.equal('reasoningBodyRenders' in snapshot, false);
});

test('reasoning body fallback histogram is bounded and null-prototype', () => {
  const metrics = createStreamClientMetrics({ now: () => 100, ship: () => {} });
  metrics.noteDelta('stream-reason-bounds', 'session-reason-bounds');
  for (let index = 0; index < 40; index += 1) {
    metrics.noteReasoningBodyRender({
      mode: 'full',
      fallbackReason: `${index}_${'r'.repeat(80)}`,
      durationMs: 1,
      entryChars: 1,
    });
  }

  const reasons = metrics.take('stream-reason-bounds').reasoning_body_fallback_reasons;
  assert.strictEqual(Object.getPrototypeOf(reasons), null);
  assert.strictEqual(Object.keys(reasons).length, 32);
  assert.ok(Object.keys(reasons).every((reason) => reason.length <= 64));
});

test('reasoning body observations without a prior delta are ignored', () => {
  const metrics = createStreamClientMetrics({ now: () => 100, ship: () => {} });
  metrics.noteReasoningBodyRender({
    mode: 'full',
    fallbackReason: 'initial',
    durationMs: 1,
    entryChars: 10,
  });
  assert.strictEqual(metrics.take('stream-untracked'), null);
});

test('take clears last-delta attribution for reasoning body observations', () => {
  const metrics = createStreamClientMetrics({ now: () => 100, ship: () => {} });
  metrics.noteDelta('stream-earlier', 'session-earlier');
  metrics.noteDelta('stream-latest', 'session-latest');
  metrics.take('stream-latest');
  metrics.noteReasoningBodyRender({
    mode: 'full',
    fallbackReason: 'initial',
    durationMs: 1,
    entryChars: 10,
  });

  const earlier = metrics.take('stream-earlier');
  assert.strictEqual(earlier.reasoning_body_renders, 0);
});

test('warns once for an unknown render kind while real header kinds still count', () => {
  const logged = [];
  const metrics = createStreamClientMetrics({
    now: () => 100,
    ship: () => {},
    appendClientLog: (level, event, fields) => logged.push({ level, event, fields }),
  });
  metrics.noteDelta('stream-kinds', 'session-kinds');
  metrics.noteRenderForSession('session-kinds', 'bogus_kind');
  metrics.noteRenderForSession('session-kinds', 'bogus_kind');
  metrics.noteRenderForSession('session-kinds', 'reasoning_header_rewrite');
  metrics.noteRenderForSession('session-kinds', 'reasoning_header_morph');

  assert.deepStrictEqual(logged, [{
    level: 'WARN',
    event: 'stream.render_kind_unknown',
    fields: { kind: 'bogus_kind' },
  }]);
  const snapshot = metrics.take('stream-kinds');
  assert.strictEqual(snapshot.reasoning_header_rewrites, 1);
  assert.strictEqual(snapshot.reasoning_header_morphs, 1);
});

test('renders for sessions without a live stream are ignored', () => {
  const metrics = createStreamClientMetrics({ now: () => 0, ship: () => {} });
  metrics.noteRenderForSession('session-untracked', 'full');
  assert.strictEqual(metrics.take(''), null);

  metrics.noteDelta('stream-2', 'session-2');
  metrics.noteRenderForSession('session-other', 'patch');
  const snapshot = metrics.take('stream-2');
  assert.strictEqual(snapshot.stream_reveal_patches_applied, 0);
});

test('a frozen stream shows deltas with zero patches — the motivating diagnostic', () => {
  const metrics = createStreamClientMetrics({ now: () => 5, ship: () => {} });
  for (let index = 0; index < 142; index += 1) {
    metrics.noteDelta('stream-frozen', 'session-1');
  }
  metrics.noteRenderForSession('session-1', 'noop');
  metrics.noteRenderForSession('session-1', 'noop');
  const snapshot = metrics.take('stream-frozen');
  assert.strictEqual(snapshot.deltas_received, 142);
  assert.strictEqual(snapshot.stream_reveal_patches_applied, 0);
  assert.strictEqual(snapshot.full_renders, 0);
  assert.strictEqual(snapshot.noop_renders, 2);
  assert.strictEqual(snapshot.first_paint_at_ms, null);
});

test('reportTerminal ships a snake_case payload once and tolerates ship failures', () => {
  const shipped = [];
  const metrics = createStreamClientMetrics({
    now: () => 7,
    ship: (payload) => shipped.push(payload),
  });
  metrics.noteDelta('stream-3', 'session-3');
  metrics.reportTerminal({ streamId: 'stream-3', sessionId: 'session-3' });
  assert.strictEqual(shipped.length, 1);
  assert.strictEqual(shipped[0].stream_id, 'stream-3');
  assert.strictEqual(shipped[0].session_id, 'session-3');
  assert.strictEqual(shipped[0].client_timing.deltas_received, 1);
  // Already taken — terminal for the same stream ships nothing further.
  metrics.reportTerminal({ streamId: 'stream-3', sessionId: 'session-3' });
  assert.strictEqual(shipped.length, 1);

  const throwingMetrics = createStreamClientMetrics({
    now: () => 7,
    ship: () => {
      throw new Error('bridge gone');
    },
  });
  throwingMetrics.noteDelta('stream-4', 'session-4');
  assert.doesNotThrow(() => throwingMetrics.reportTerminal({ streamId: 'stream-4' }));
});

test('warns stream.terminal_gap_slow when the last-delta-to-terminal gap exceeds 1000ms', () => {
  let clock = 0;
  const logged = [];
  const metrics = createStreamClientMetrics({
    now: () => clock,
    ship: () => {},
    appendClientLog: (level, event, fields) => logged.push({ level, event, fields }),
  });
  metrics.noteDelta('stream-slow', 'session-slow');
  clock = 1500;
  metrics.reportTerminal({ streamId: 'stream-slow', sessionId: 'session-slow' });
  assert.strictEqual(logged.length, 1);
  assert.strictEqual(logged[0].level, 'WARN');
  assert.strictEqual(logged[0].event, 'stream.terminal_gap_slow');
  assert.deepStrictEqual(logged[0].fields, {
    streamId: 'stream-slow',
    sessionId: 'session-slow',
    gapMs: 1500,
  });
});

test('does not warn when the settle gap is within 1000ms or no delta arrived', () => {
  let clock = 0;
  const logged = [];
  const metrics = createStreamClientMetrics({
    now: () => clock,
    ship: () => {},
    appendClientLog: (...args) => logged.push(args),
  });
  metrics.noteDelta('stream-fast', 'session-fast');
  clock = 1000; // exactly at the threshold — not over it
  metrics.reportTerminal({ streamId: 'stream-fast', sessionId: 'session-fast' });
  assert.strictEqual(logged.length, 0);
  // Unknown stream (no entry): early return, no log.
  metrics.reportTerminal({ streamId: 'stream-unknown', sessionId: 'session-fast' });
  assert.strictEqual(logged.length, 0);
});

test('a throwing appendClientLog never breaks terminal handling', () => {
  let clock = 0;
  const shipped = [];
  const metrics = createStreamClientMetrics({
    now: () => clock,
    ship: (payload) => shipped.push(payload),
    appendClientLog: () => {
      throw new Error('logger gone');
    },
  });
  metrics.noteDelta('stream-5', 'session-5');
  clock = 2000;
  assert.doesNotThrow(() => metrics.reportTerminal({ streamId: 'stream-5', sessionId: 'session-5' }));
  // The diagnostics ship still happens and carries the gap.
  assert.strictEqual(shipped.length, 1);
  assert.strictEqual(shipped[0].client_timing.last_delta_to_terminal_ms, 2000);
});

test('tracked stream map stays bounded', () => {
  const metrics = createStreamClientMetrics({ now: () => 1, ship: () => {} });
  for (let index = 0; index < 40; index += 1) {
    metrics.noteDelta(`stream-${index}`, `session-${index}`);
  }
  // Oldest entries evicted; the most recent still tracked.
  assert.strictEqual(metrics.take('stream-0'), null);
  assert.ok(metrics.take('stream-39'));
});

test('mailbox observations do not create metrics entries', () => {
  const metrics = createStreamClientMetrics({ now: () => 1, ship: () => {} });
  metrics.noteMailbox('stream-unknown', 'session-unknown', {
    peakDepth: 5,
    peakQueuedBytes: 120,
    dropped: 2,
  });
  assert.strictEqual(metrics.take('stream-unknown'), null);
});

test('mailbox observations retain monotonic peaks for tracked streams', () => {
  const metrics = createStreamClientMetrics({ now: () => 1, ship: () => {} });
  metrics.noteDelta('stream-mailbox', 'session-mailbox');
  metrics.noteMailbox('stream-mailbox', 'session-mailbox', {
    peakDepth: 5,
    peakQueuedBytes: 120,
    dropped: 2,
  });
  metrics.noteMailbox('stream-mailbox', 'session-mailbox', {
    peakDepth: 3,
    peakQueuedBytes: 80,
    dropped: 1,
  });

  const snapshot = metrics.take('stream-mailbox');
  assert.strictEqual(snapshot.mailbox_peak_depth, 5);
  assert.strictEqual(snapshot.mailbox_peak_queued_bytes, 120);
  assert.strictEqual(snapshot.mailbox_dropped, 2);
});

test('full renders are tallied by the gate that forced them', () => {
  // Post-approval flicker RCA: full_renders alone says the timeline rebuilt,
  // not WHY. The reason tally is what turns a degraded turn in the diagnostics
  // dump into a named gate instead of a guess.
  const metrics = createStreamClientMetrics({ now: () => 100, ship: () => {} });
  metrics.noteDelta('stream-r', 'session-r');
  metrics.noteRenderForSession('session-r', 'full', 'patch_fallback:row_model_not_surgical');
  metrics.noteRenderForSession('session-r', 'full', 'patch_fallback:row_model_not_surgical');
  metrics.noteRenderForSession('session-r', 'full', 'projection_revision');
  metrics.noteRenderForSession('session-r', 'full');
  metrics.noteRenderForSession('session-r', 'patch', 'ignored-for-patches');

  const snapshot = metrics.take('stream-r');
  assert.strictEqual(snapshot.full_renders, 4);
  assert.deepStrictEqual(snapshot.full_render_reasons, {
    'patch_fallback:row_model_not_surgical': 2,
    projection_revision: 1,
  });
});
