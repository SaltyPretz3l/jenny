'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../services/chat-messaging-contract');

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

test('setReporting validator is closed: schema_version, child_session_id, boolean enabled', () => {
  assert.deepEqual(contract.validateSetReportingRequest({ schema_version: 1, child_session_id: 'sess_child', enabled: false }),
    { ok: true, value: { child_session_id: 'sess_child', enabled: false } });
  assert.deepEqual(contract.validateSetReportingRequest({ schema_version: 1, child_session_id: 'sess_child', enabled: true }).value,
    { child_session_id: 'sess_child', enabled: true });
  const invalid = { ok: false, reason: 'invalid_request' };
  const good = { schema_version: 1, child_session_id: 'sess_child', enabled: true };
  const bad = [
    null, undefined, 'x', [], 7,
    { ...good, schema_version: 2 },
    { ...good, schema_version: undefined },
    { ...good, extra: true },
    { ...good, enabled: 'yes' },
    { ...good, enabled: 1 },
    { ...good, enabled: undefined },
    { ...good, child_session_id: '' },
    { ...good, child_session_id: '../x' },
    { ...good, child_session_id: 'a'.repeat(129) },
    { ...good, child_session_id: 7 },
    { schema_version: 1, enabled: true },
    { schema_version: 1, child_session_id: 'sess_child' },
  ];
  for (const raw of bad) assert.deepEqual(contract.validateSetReportingRequest(raw), invalid, JSON.stringify(raw));
});

test('every chatMessages method is real: nothing answers unsupported any more', () => {
  assert.deepEqual([...contract.UNSUPPORTED_METHODS], []);
  assert.equal(contract.validateUnsupportedRequest, undefined);
});

test('confirmRestored validates a closed request: operation id, the previewed envelope hash and a gesture id', () => {
  const good = { schema_version: 1, operation_id: UUID_A, expected_envelope_sha256: 'a'.repeat(64), gesture_id: UUID_B };
  assert.deepEqual(contract.validateConfirmRestoredRequest(good), {
    ok: true, value: { operation_id: UUID_A, expected_envelope_sha256: 'a'.repeat(64), gesture_id: UUID_B },
  });
  const invalid = { ok: false, reason: 'invalid_request' };
  const bad = [
    { ...good, extra: 1 },
    { ...good, schema_version: 2 },
    { ...good, operation_id: 'nope' },
    { ...good, gesture_id: 'nope' },
    { ...good, expected_envelope_sha256: 'A'.repeat(64) },
    { ...good, expected_envelope_sha256: 'a'.repeat(63) },
    { ...good, expected_envelope_sha256: 7 },
    { schema_version: 1, operation_id: UUID_A, gesture_id: UUID_B },
    { schema_version: 1, operation_id: UUID_A, expected_envelope_sha256: 'a'.repeat(64) },
    null,
    'x',
  ];
  for (const raw of bad) assert.deepEqual(contract.validateConfirmRestoredRequest(raw), invalid, JSON.stringify(raw));
});
