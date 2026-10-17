'use strict';

/* performance.* wire contract (row 59 checkpoint 6): closed requests, the failure
 * envelope with stable reasons, the closed observation normalizer and the bounded
 * terminal-summary record. */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_SUMMARIES, MAX_SUMMARY_BYTES, boundInferencePerformance, fail, normalizeObservation, succeed,
  validateDismissWarningRequest, validateGetSnapshotRequest, validateUpdateSettingsRequest,
} = require('../services/performance/performance-contract');
const { PERFORMANCE_ERROR_CODES } = require('../services/backend/error-codes');

const WARNING_ID = '123e4567-e89b-42d3-a456-426614174000';

test('getSnapshot accepts exactly {schema_version:1, session_id} and rejects everything else', () => {
  assert.deepEqual(validateGetSnapshotRequest({ schema_version: 1, session_id: 'sess_a' }), { ok: true, value: { session_id: 'sess_a' } });
  const bad = [
    undefined, null, 'x', [], 7,
    {}, { schema_version: 1 }, { session_id: 'sess_a' },
    { schema_version: 2, session_id: 'sess_a' }, { schema_version: '1', session_id: 'sess_a' },
    { schema_version: 1, session_id: 'sess_a', extra: true },
    { schema_version: 1, session_id: '' }, { schema_version: 1, session_id: 7 },
    { schema_version: 1, session_id: '../x' }, { schema_version: 1, session_id: 'a'.repeat(129) },
    { schema_version: 1, session_id: ' sess' },
    Object.assign(Object.create({ schema_version: 1 }), { session_id: 's' }),
  ];
  for (const raw of bad) assert.deepEqual(validateGetSnapshotRequest(raw), { ok: false, reason: 'invalid_request' }, JSON.stringify(raw));
  assert.equal(validateGetSnapshotRequest(Object.assign(Object.create(null), { schema_version: 1, session_id: 's' })).ok, true);
  // null is the host scope (health pill, Settings).
  assert.deepEqual(validateGetSnapshotRequest({ schema_version: 1, session_id: null }), { ok: true, value: { session_id: null } });
});

test('updateSettings needs at least one strict boolean and nothing else', () => {
  assert.deepEqual(validateUpdateSettingsRequest({ schema_version: 1, show_counter: true }), { ok: true, value: { showCounter: true } });
  assert.deepEqual(validateUpdateSettingsRequest({ schema_version: 1, gpu_warnings_enabled: false }), { ok: true, value: { gpuWarningsEnabled: false } });
  assert.deepEqual(
    validateUpdateSettingsRequest({ schema_version: 1, show_counter: false, gpu_warnings_enabled: true }),
    { ok: true, value: { showCounter: false, gpuWarningsEnabled: true } }
  );
  const bad = [
    undefined, null, [], 'x',
    { schema_version: 1 },
    { schema_version: 2, show_counter: true },
    { schema_version: 1, show_counter: 'true' }, { schema_version: 1, show_counter: 1 },
    { schema_version: 1, show_counter: null }, { schema_version: 1, show_counter: undefined },
    { schema_version: 1, gpu_warnings_enabled: 0 },
    { schema_version: 1, show_counter: true, extra: 1 }, { schema_version: 1, showCounter: true },
    { schema_version: 1, show_counter: true, session_id: 's' },
  ];
  for (const raw of bad) assert.deepEqual(validateUpdateSettingsRequest(raw), { ok: false, reason: 'invalid_request' }, JSON.stringify(raw));
});

test('dismissWarning needs a session id and a UUID warning id', () => {
  assert.deepEqual(
    validateDismissWarningRequest({ schema_version: 1, session_id: 'sess_a', warning_id: WARNING_ID }),
    { ok: true, value: { session_id: 'sess_a', warning_id: WARNING_ID } }
  );
  const bad = [
    null, {}, { schema_version: 1, session_id: 'sess_a' }, { schema_version: 1, warning_id: WARNING_ID },
    { schema_version: 1, session_id: 'sess_a', warning_id: 'not-a-uuid' },
    { schema_version: 1, session_id: 'sess_a', warning_id: WARNING_ID + 'x' },
    { schema_version: 1, session_id: 'sess_a', warning_id: 7 },
    { schema_version: 1, session_id: 'sess_a', warning_id: WARNING_ID, extra: 1 },
    { schema_version: 0, session_id: 'sess_a', warning_id: WARNING_ID },
    { schema_version: 1, session_id: '..', warning_id: WARNING_ID },
  ];
  for (const raw of bad) assert.deepEqual(validateDismissWarningRequest(raw), { ok: false, reason: 'invalid_request' }, JSON.stringify(raw));
  assert.equal(validateDismissWarningRequest({ schema_version: 1, session_id: null, warning_id: WARNING_ID }).ok, true);
});

test('failure envelopes carry a stable reason and the registered code, never prose', () => {
  assert.deepEqual(fail('invalid_request'), { ok: false, code: PERFORMANCE_ERROR_CODES.INVALID_REQUEST, reason: 'invalid_request' });
  assert.deepEqual(fail('settings_read_only'), { ok: false, code: 'CMP-PERFORMANCE-0002', reason: 'settings_read_only' });
  assert.deepEqual(fail('collection_unavailable'), { ok: false, code: 'CMP-PERFORMANCE-0003', reason: 'collection_unavailable' });
  assert.deepEqual(fail('stale_warning'), { ok: false, code: 'CMP-PERFORMANCE-0004', reason: 'stale_warning' });
  // An unknown token keeps its (valid) shape but degrades to the collection class; prose degrades entirely.
  assert.deepEqual(fail('made_up_reason'), { ok: false, code: 'CMP-PERFORMANCE-0003', reason: 'made_up_reason' });
  assert.deepEqual(fail('Error: C:\\secret path'), { ok: false, code: 'CMP-PERFORMANCE-0003', reason: 'collection_unavailable' });
  assert.deepEqual(fail(undefined), { ok: false, code: 'CMP-PERFORMANCE-0003', reason: 'collection_unavailable' });
  assert.deepEqual(succeed({ settings: {} }), { ok: true, settings: {} });
});

function observation(over = {}) {
  return {
    schema_version: 1, attempt_id: 'ab'.repeat(16), sequence: 3, sampled_at: 1_700_000_000_000, phase: 'decode',
    source: 'provider', provider_kind: 'ninfer', turn_id: 'turn_1', provider_call_id: null, ...over,
  };
}

test('an observation envelope must be exact; metric fields are range-checked and nulled, never fatal', () => {
  const clean = normalizeObservation(observation({ generated_tokens: 8, decode_elapsed_ms: 56.3681, terminal_decode_tps: 124.18 }));
  assert.equal(clean.generated_tokens, 8);
  assert.equal(clean.decode_elapsed_ms, 56.3681);
  assert.equal(clean.terminal_decode_tps, 124.18);
  assert.equal(clean.prompt_tokens, null);
  assert.equal(clean.turn_id, 'turn_1');
  const refused = [
    null, [], 'x', observation({ schema_version: 2 }), observation({ attempt_id: 'XYZ' }), observation({ attempt_id: 'ab' }),
    observation({ sequence: -1 }), observation({ sequence: 1.5 }), observation({ sequence: '1' }),
    observation({ sampled_at: -1 }), observation({ sampled_at: 1.5 }), observation({ sampled_at: Number.MAX_VALUE }),
    observation({ phase: 'running' }), observation({ phase: undefined }), observation({ source: 'sidecar' }),
    observation({ provider_kind: 'openai' }),
  ];
  for (const raw of refused) assert.equal(normalizeObservation(raw), null, JSON.stringify(raw));
  const ranges = normalizeObservation(observation({
    generated_tokens: 1_048_577, decode_interval_tokens: -1, prompt_tokens: 1.5, cached_prompt_tokens: '3',
    processed_prompt_tokens: 1_048_576, decode_elapsed_ms: 86_400_001, prefill_elapsed_ms: 86_400_000,
    time_to_first_generated_token_ms: NaN, terminal_decode_tps: 10_000_001, terminal_prefill_tps: 10_000_000,
  }));
  assert.equal(ranges.generated_tokens, null);
  assert.equal(ranges.decode_interval_tokens, null);
  assert.equal(ranges.prompt_tokens, null);
  assert.equal(ranges.cached_prompt_tokens, null);
  assert.equal(ranges.processed_prompt_tokens, 1_048_576);
  assert.equal(ranges.decode_elapsed_ms, null);
  assert.equal(ranges.prefill_elapsed_ms, 86_400_000);
  assert.equal(ranges.time_to_first_generated_token_ms, null);
  assert.equal(ranges.terminal_decode_tps, null);
  assert.equal(ranges.terminal_prefill_tps, 10_000_000);
  // Unsafe identifiers become null; extra transport keys are not copied.
  const ids = normalizeObservation(observation({ turn_id: '../x', provider_call_id: 'call 1', request_id: 'r', trace_id: 't' }));
  assert.equal(ids.turn_id, null);
  assert.equal(ids.provider_call_id, null);
  assert.equal(Object.hasOwn(ids, 'request_id'), false);
});

function summary(index, over = {}) {
  return {
    turn_id: 'turn_1', provider_call_id: null, attempt_id: String(index).padStart(32, 'a'), sampled_at: 1_700_000_000_000 + index,
    phase: 'finished', provider_kind: 'ninfer', generated_tokens: 8, decode_interval_tokens: 7, decode_elapsed_ms: 56.3681,
    prompt_tokens: 18, cached_prompt_tokens: 0, processed_prompt_tokens: 18, prefill_elapsed_ms: 96.035,
    time_to_first_generated_token_ms: 120, terminal_decode_tps: 124.18, terminal_prefill_tps: 187.4, ...over,
  };
}

test('terminal summaries keep the latest 32 with an omitted count and stay within 16 KiB', () => {
  assert.equal(boundInferencePerformance(null), null);
  assert.equal(boundInferencePerformance({ summaries: [] }), null);
  assert.equal(boundInferencePerformance({ summaries: 'x' }), null);
  const few = boundInferencePerformance({ summaries: [summary(1), summary(2)], omitted_count: 0 });
  assert.equal(few.schema_version, 1);
  assert.equal(few.summaries.length, 2);
  assert.equal(few.omitted_count, 0);
  const many = boundInferencePerformance({ summaries: Array.from({ length: 40 }, (_, i) => summary(i)), omitted_count: 5 });
  assert.equal(many.summaries.length, MAX_SUMMARIES);
  assert.equal(many.omitted_count, 5 + 8);
  assert.equal(many.summaries[0].attempt_id, summary(8).attempt_id, 'the oldest are shed first');
  assert.equal(many.summaries.at(-1).attempt_id, summary(39).attempt_id);
  assert.ok(Buffer.byteLength(JSON.stringify(many), 'utf8') <= MAX_SUMMARY_BYTES);
});

test('the 16 KiB bound sheds further summaries and counts them', () => {
  const fat = Array.from({ length: 32 }, (_, i) => summary(i, { turn_id: 'x'.repeat(128), provider_call_id: 'y'.repeat(128) }));
  const bounded = boundInferencePerformance({ summaries: fat });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= MAX_SUMMARY_BYTES);
  assert.equal(bounded.summaries.length + bounded.omitted_count, 32);
});

test('only terminal, well-formed summaries survive and nothing extra is persisted', () => {
  const bounded = boundInferencePerformance({
    summaries: [
      summary(1, { phase: 'decode' }), summary(2, { leaked: 'secret', request_id: 'r' }), summary(3, { attempt_id: 'nope' }),
      null, 'x', summary(4, { generated_tokens: 99_999_999 }),
    ],
  });
  assert.deepEqual(bounded.summaries.map((s) => s.attempt_id), [summary(2).attempt_id, summary(4).attempt_id]);
  assert.equal(bounded.omitted_count, 4);
  assert.equal(Object.hasOwn(bounded.summaries[0], 'leaked'), false);
  assert.equal(Object.hasOwn(bounded.summaries[0], 'request_id'), false);
  assert.equal(bounded.summaries[1].generated_tokens, null);
  assert.equal(boundInferencePerformance({ summaries: [summary(1, { phase: 'decode' })] }), null);
});
