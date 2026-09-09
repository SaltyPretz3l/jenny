'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { encodeEnvelope, decodeEnvelope, validateResponse } = require('../../services/host/worker-transport');
const key = randomBytes(32);
const ID = '11111111-1111-4111-8111-111111111111';
test('signed envelopes round-trip UTF-8 commands without shell interpolation', () => {
  const request = { schema_version: 1, request_id: ID, operation: 'submit',
    command: 'printf "$HOME é›ª\\n"; echo $(literal)' };
  assert.deepEqual(decodeEnvelope(encodeEnvelope(request, key).trimEnd(), key), request);
});
test('changed payload, wrong key and malformed envelopes are rejected', () => {
  const wire = encodeEnvelope({ operation: 'status' }, key);
  assert.throws(() => decodeEnvelope(wire, randomBytes(32)), /authentication_failed/);
  const modified = JSON.parse(wire);
  modified.payload = Buffer.from('{"operation":"submit"}').toString('base64');
  assert.throws(() => decodeEnvelope(JSON.stringify(modified), key), /authentication_failed/);
  for (const invalid of ['{}', '{"payload":{},"mac":"x"}', 'not-json',
    JSON.stringify({ ...JSON.parse(wire), extra: true })]) {
    assert.throws(() => decodeEnvelope(invalid, key), /response_invalid/);
  }
});
test('responses are bound to request identity and closed versioned schemas', () => {
  const request = { request_id: ID, operation: 'status' };
  const value = { schema_version: 1, request_id: ID, ok: true, incarnation: ID,
    phase: 'ready', job_id: null, previous_result: null };
  assert.equal(validateResponse(value, request), value);
  for (const changes of [{ schema_version: 2 }, { request_id: 'other' }, { phase: 'unknown' },
    { previous_result: {} }, { unknown: true }, { job_id: ID }, { phase: 'running' }]) {
    assert.throws(() => validateResponse({ ...value, ...changes }, request), /worker_/);
  }
  assert.throws(() => validateResponse({ schema_version: 1, request_id: ID, ok: true,
    accepted: false }, { ...request, operation: 'submit' }), /acknowledgement_invalid/);
});


test('worker output budget counts final UTF-8 bytes and forbids a current-incarnation receipt', () => {
  const { validateResult, MAX_OUTPUT_BYTES } = require('../../services/host/worker-transport');
  const other = '22222222-2222-4222-8222-222222222222';
  const result = { schema_version: 1, incarnation: ID, job_id: other, status: 'completed',
    exit_code: 0, stdout: 'x'.repeat(MAX_OUTPUT_BYTES), stderr: '', output_truncated: false, reason: null };
  assert.equal(validateResult(result), result);
  assert.throws(() => validateResult({ ...result, stderr: 'x' }), /worker_result_invalid/);
  assert.throws(() => validateResponse({ schema_version: 1, request_id: ID, ok: true,
    incarnation: ID, phase: 'ready', job_id: null, previous_result: result },
  { operation: 'status', request_id: ID }), /worker_status_invalid/);
  const wire = encodeEnvelope(result, key, { response: true });
  assert.deepEqual(decodeEnvelope(wire, key, { response: true }), result);
});
