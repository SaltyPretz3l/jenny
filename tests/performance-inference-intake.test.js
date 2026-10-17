'use strict';

/* Inference intake (row 59 checkpoint 6): request/session ownership against the
 * stream context, one latest attempt per session, stale attempts and requests
 * refused, change notification with the terminal flag, available_next_request,
 * and the bounded terminal summaries for the usage record. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInferenceIntake } = require('../services/performance/inference-intake');

const A1 = 'a1'.repeat(16);
const A2 = 'b2'.repeat(16);
const NULLS = {
  generated_tokens: null, decode_interval_tokens: null, decode_elapsed_ms: null, prompt_tokens: null,
  cached_prompt_tokens: null, processed_prompt_tokens: null, prefill_elapsed_ms: null,
  time_to_first_generated_token_ms: null, terminal_decode_tps: null, terminal_prefill_tps: null,
};
const ctx = (over = {}) => ({ streamId: 'req_1', resolvedSessionId: 'sess_1', ...over });
function params(over = {}) {
  return {
    schema_version: 1, request_id: 'req_1', trace_id: 't', session_id: 'sess_1', turn_id: 'turn_1', provider_call_id: null,
    attempt_id: A1, sequence: 0, sampled_at: 1_000_000, phase: 'waiting', source: 'provider', provider_kind: 'ninfer',
    ...NULLS, ...over,
  };
}
function fixture() {
  let time = 10_000;
  const intake = createInferenceIntake({ now: () => time });
  const changes = [];
  intake.onChange((sessionId, detail) => changes.push([sessionId, detail.terminal]));
  return { intake, changes, advance: (ms) => { time += ms; }, time: () => time };
}

test('a notification is accepted only for the stream and session that own it', () => {
  const { intake } = fixture();
  assert.equal(intake.accept(ctx(), params({ request_id: 'req_other' })), false);
  assert.equal(intake.accept(ctx(), params({ session_id: 'sess_other' })), false);
  assert.equal(intake.accept(ctx({ streamId: '' }), params()), false);
  assert.equal(intake.accept(ctx({ resolvedSessionId: undefined }), params()), false);
  assert.equal(intake.accept(null, params()), false);
  assert.equal(intake.accept(ctx(), null), false);
  assert.equal(intake.accept(ctx(), params({ schema_version: 2 })), false);
  assert.equal(intake.accept(ctx(), params({ phase: 'bogus' })), false);
  assert.equal(intake.snapshotForSession('sess_1'), null, 'nothing was accepted');
  assert.equal(intake.snapshotForSession('sess_other'), null);
  assert.equal(intake.accept(ctx(), params()), true);
  assert.equal(intake.snapshotForSession('sess_1').observation.phase, 'waiting');
  assert.equal(intake.snapshotForSession('sess_other'), null, 'a session only sees its own request');
});

test('accept never throws, even for hostile or exotic input', () => {
  const { intake } = fixture();
  const hostile = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); } });
  assert.equal(intake.accept(ctx(), hostile), false);
  assert.equal(intake.accept(hostile, params()), false);
  assert.equal(intake.accept(), false);
  intake.onChange(() => { throw new Error('listener failure'); });
  assert.equal(intake.accept(ctx(), params()), true, 'a throwing listener never fails the stream');
});

test('sequence must increase within an attempt; the same or an older one is refused', () => {
  const { intake } = fixture();
  assert.equal(intake.accept(ctx(), params({ sequence: 2 })), true);
  assert.equal(intake.accept(ctx(), params({ sequence: 2 })), false);
  assert.equal(intake.accept(ctx(), params({ sequence: 1 })), false);
  assert.equal(intake.accept(ctx(), params({ sequence: 3, phase: 'prefill' })), true);
  assert.equal(intake.snapshotForSession('sess_1').observation.sequence, 3);
});

test('a session keeps only its latest attempt; a retired attempt cannot come back', () => {
  const { intake } = fixture();
  assert.equal(intake.accept(ctx(), params({ attempt_id: A1, sequence: 0 })), true);
  assert.equal(intake.accept(ctx(), params({ attempt_id: A1, sequence: 1, phase: 'finished', generated_tokens: 8 })), true);
  // A tool-loop iteration: a new attempt restarts the sequence at 0.
  assert.equal(intake.accept(ctx(), params({ attempt_id: A2, sequence: 0 })), true);
  assert.equal(intake.snapshotForSession('sess_1').observation.attempt_id, A2);
  assert.equal(intake.snapshotForSession('sess_1').observation.generated_tokens, null, 'no cross-attempt carry-over');
  // A late frame of the first attempt is stale, even with a fresh-looking sequence.
  assert.equal(intake.accept(ctx(), params({ attempt_id: A1, sequence: 9 })), false);
  assert.equal(intake.snapshotForSession('sess_1').observation.attempt_id, A2);
  assert.equal(intake.accept(ctx(), params({ attempt_id: A2, sequence: 1, phase: 'decode' })), true);
});

test('a newer request in the session retires the older one for good', () => {
  const { intake } = fixture();
  assert.equal(intake.accept(ctx(), params({ attempt_id: A1 })), true);
  const second = ctx({ streamId: 'req_2' });
  assert.equal(intake.accept(second, params({ request_id: 'req_2', attempt_id: A2 })), true);
  assert.equal(intake.snapshotForSession('sess_1').observation.attempt_id, A2);
  // The first request's late notification must not swap the snapshot back.
  assert.equal(intake.accept(ctx(), params({ attempt_id: A1, sequence: 5 })), false);
  assert.equal(intake.accept(ctx(), params({ attempt_id: 'c3'.repeat(16), sequence: 0 })), false);
  assert.equal(intake.snapshotForSession('sess_1').observation.attempt_id, A2);
});

test('nonmonotonic cumulative fields mark that metric unavailable without failing the attempt', () => {
  const { intake } = fixture();
  intake.accept(ctx(), params({ sequence: 0, phase: 'decode', generated_tokens: 50, decode_interval_tokens: 49, decode_elapsed_ms: 500 }));
  assert.equal(intake.accept(ctx(), params({ sequence: 1, phase: 'decode', generated_tokens: 10, decode_interval_tokens: 9, decode_elapsed_ms: 100 })), true);
  assert.equal(intake.snapshotForSession('sess_1').live_decode.state, 'unavailable');
  assert.equal(intake.accept(ctx(), params({ sequence: 2, phase: 'finished', terminal_decode_tps: 99 })), true);
  assert.equal(intake.snapshotForSession('sess_1').observation.terminal_decode_tps, 99);
});

test('onChange fires per accepted notification with the terminal flag, and unsubscribes', () => {
  const { intake, changes } = fixture();
  const seen = [];
  const unsubscribe = intake.onChange((sessionId, detail) => seen.push([sessionId, detail]));
  intake.accept(ctx(), params({ sequence: 0 }));
  intake.accept(ctx(), params({ sequence: 0 })); // refused: no change
  intake.accept(ctx(), params({ sequence: 1, phase: 'decode' }));
  intake.accept(ctx(), params({ sequence: 2, phase: 'finished' }));
  assert.deepEqual(changes, [['sess_1', false], ['sess_1', false], ['sess_1', true]]);
  assert.deepEqual(seen.map(([, detail]) => detail), [{ terminal: false }, { terminal: false }, { terminal: true }]);
  for (const phase of ['failed', 'cancelled']) {
    const other = fixture();
    other.intake.accept(ctx(), params({ phase }));
    assert.deepEqual(other.changes, [['sess_1', true]], phase);
  }
  unsubscribe();
  intake.accept(ctx({ streamId: 'req_2' }), params({ request_id: 'req_2', attempt_id: A2 }));
  assert.equal(seen.length, 3);
  assert.equal(typeof intake.onChange('not a function'), 'function');
});

test('the counter being off at request creation projects available_next_request, never a restart', () => {
  const { intake } = fixture();
  assert.equal(intake.markRequest('sess_1', { live_requested: false, request_id: 'req_1' }), true);
  const before = intake.snapshotForSession('sess_1');
  assert.equal(before.observation, null);
  assert.deepEqual(before.live_decode, { value: null, state: 'available_next_request', sampled_at: null });
  assert.equal(before.live_prefill.state, 'available_next_request');
  intake.accept(ctx(), params({ sequence: 0, phase: 'waiting' }));
  intake.accept(ctx(), params({ sequence: 1, phase: 'finished', generated_tokens: 8, decode_interval_tokens: 7, decode_elapsed_ms: 56.3681,
    terminal_decode_tps: 124.18, prompt_tokens: 18, cached_prompt_tokens: 0 }));
  const after = intake.snapshotForSession('sess_1');
  assert.equal(after.live_decode.state, 'available_next_request');
  assert.equal(after.observation.terminal_decode_tps, 124.18, 'terminal averages are still reported');
  assert.equal(after.cache_fraction.state, 'available');
});

test('a provider that cannot stream live metrics reports unavailable, not available_next_request', () => {
  const { intake } = fixture();
  intake.markRequest('sess_1', { live_requested: false, live_capable: false, request_id: 'req_1' });
  assert.equal(intake.snapshotForSession('sess_1').live_decode.state, 'unavailable');
  intake.accept(ctx(), params({ provider_kind: 'llama-server' }));
  assert.equal(intake.snapshotForSession('sess_1').live_decode.state, 'unavailable');
  assert.equal(intake.snapshotForSession('sess_1').live_prefill.state, 'unavailable');
  // A live-capable provider (the other mark) whose frames say llama-server stays unavailable too.
  const other = fixture();
  other.intake.markRequest('sess_1', { live_requested: false, request_id: 'req_1' });
  other.intake.accept(ctx(), params({ provider_kind: 'ollama' }));
  assert.equal(other.intake.snapshotForSession('sess_1').live_decode.state, 'unavailable');
});

test('a live-requested NInfer request is warming until measured, and goes stale on the receive clock', () => {
  const { intake, advance } = fixture();
  intake.markRequest('sess_1', { live_requested: true, request_id: 'req_1' });
  assert.equal(intake.snapshotForSession('sess_1').live_decode.state, 'warming');
  for (let i = 0; i < 6; i += 1) {
    intake.accept(ctx(), params({
      sequence: i, phase: 'decode', sampled_at: 1_000_000 + i * 250,
      generated_tokens: 25 * i + 1, decode_interval_tokens: 25 * i, decode_elapsed_ms: 250 * (i + 1),
    }));
    advance(250);
  }
  const live = intake.snapshotForSession('sess_1');
  assert.equal(live.live_decode.state, 'available');
  assert.equal(live.live_decode.value, 100);
  advance(2500);
  const stale = intake.snapshotForSession('sess_1');
  assert.equal(stale.live_decode.state, 'stale');
  assert.equal(stale.live_decode.sampled_at, live.live_decode.sampled_at);
});

test('terminal summaries are kept per request, bounded to 32 with an omitted count, and taken once', () => {
  const { intake } = fixture();
  for (let i = 0; i < 40; i += 1) {
    const attempt = String(i + 1).padStart(32, 'e');
    assert.equal(intake.accept(ctx(), params({
      attempt_id: attempt, sequence: 0, phase: i % 3 === 0 ? 'failed' : 'finished', sampled_at: 1_000_000 + i,
      generated_tokens: i, decode_interval_tokens: Math.max(i - 1, 0), decode_elapsed_ms: 50,
    })), true, `attempt ${i}`);
  }
  const record = intake.takeTerminalSummaries('req_1');
  assert.equal(record.schema_version, 1);
  assert.equal(record.summaries.length, 32);
  assert.equal(record.omitted_count, 8);
  assert.equal(record.summaries[0].generated_tokens, 8);
  assert.equal(record.summaries.at(-1).generated_tokens, 39);
  assert.equal(intake.takeTerminalSummaries('req_1'), null, 'taken once');
  assert.equal(intake.takeTerminalSummaries('req_unknown'), null);
});

test('non-terminal observations leave no summary, and forgetSession drops a chat entirely', () => {
  const { intake } = fixture();
  intake.accept(ctx(), params({ phase: 'decode' }));
  assert.equal(intake.takeTerminalSummaries('req_1'), null);
  intake.accept(ctx(), params({ sequence: 1, phase: 'finished' }));
  intake.forgetSession('sess_1');
  assert.equal(intake.snapshotForSession('sess_1'), null);
  assert.equal(intake.takeTerminalSummaries('req_1'), null);
});

test('memory stays bounded: old sessions are evicted past 256 and a snapshot is a detached copy', () => {
  const { intake } = fixture();
  for (let i = 0; i < 300; i += 1) {
    intake.accept({ streamId: `req_${i}`, resolvedSessionId: `sess_${i}` }, params({ request_id: `req_${i}`, session_id: `sess_${i}` }));
  }
  assert.equal(intake.snapshotForSession('sess_0'), null);
  assert.notEqual(intake.snapshotForSession('sess_299'), null);
  const snapshot = intake.snapshotForSession('sess_299');
  snapshot.observation.phase = 'tampered';
  assert.equal(intake.snapshotForSession('sess_299').observation.phase, 'waiting');
  assert.equal(intake.markRequest('', { live_requested: true }), false);
  assert.equal(intake.markRequest(7, { live_requested: true }), false);
});
