'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PLUGIN_ERROR_CODES } = require('../../../services/backend/error-codes');
const { CANONICAL_METADATA_VERSION } = require('../../../services/plugins/package/canonical-metadata');
const {
  ACCEPTED_ALGORITHMS,
  verifyOne,
  verifySignatures,
} = require('../../../services/plugins/package/signature-verifier.js');

const RESULT_KEYS = ['ok', 'reason', 'code', 'key_id', 'requires_retrust', 'algorithm'].sort();

const PAYLOAD = Object.freeze({
  canonicalization_version: CANONICAL_METADATA_VERSION,
  publisher_id: 'acme-labs',
  plugin_id: 'widgets',
  package_version: '1.0.0',
  contract_versions: {
    package_semver: '1.0.0',
    manifest_schema_version: 1,
    contribution_contract_version: 1,
    capability_abi_version: 1,
    data_schema_version: 1,
  },
  entries: [{ path: 'plugin.json', sha256: 'a'.repeat(64) }],
});

function trustRecord(overrides = {}) {
  return {
    publisher_id: 'acme-labs',
    keys: [
      { key_id: 'key-active', public_key: 'pub-active', algorithm: 'ed25519', status: 'active' },
      { key_id: 'key-rotated', public_key: 'pub-rotated', algorithm: 'ed25519', status: 'rotated' },
      { key_id: 'key-revoked', public_key: 'pub-revoked', algorithm: 'ed25519', status: 'revoked' },
    ],
    ...overrides,
  };
}

function signature(overrides = {}) {
  return {
    algorithm: 'ed25519',
    key_id: 'key-active',
    canonicalization_version: CANONICAL_METADATA_VERSION,
    signature: 'sig-bytes',
    ...overrides,
  };
}

function countingVerify(returnValue = true) {
  const fn = () => returnValue;
  const calls = [];
  const wrapped = (args) => {
    calls.push(args);
    return typeof returnValue === 'function' ? returnValue(args) : fn(args);
  };
  wrapped.calls = calls;
  return wrapped;
}

function assertConstantShape(result) {
  assert.deepEqual(Object.keys(result).sort(), RESULT_KEYS, 'result must always carry the same key set');
}

test('ACCEPTED_ALGORITHMS is frozen and pins Ed25519 as the only accepted family', () => {
  assert.deepEqual(ACCEPTED_ALGORITHMS, ['ed25519']);
  assert.equal(Object.isFrozen(ACCEPTED_ALGORITHMS), true);
});

test('verifyOne rejects algorithm "none" on Jenny\'s allowlist before touching key material', () => {
  const verify = countingVerify(true);
  const result = verifyOne(signature({ algorithm: 'none' }), PAYLOAD, trustRecord(), verify);
  assertConstantShape(result);
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
  assert.equal(result.reason, 'unsupported_algorithm');
  assert.equal(verify.calls.length, 0, 'verify must never be called for a rejected algorithm');
});

test('verifyOne rejects an unknown algorithm name', () => {
  const verify = countingVerify(true);
  const result = verifyOne(signature({ algorithm: 'rsa-4096' }), PAYLOAD, trustRecord(), verify);
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
  assert.equal(verify.calls.length, 0);
});

test('verifyOne rejects a signature that omits the algorithm field entirely', () => {
  const raw = signature();
  delete raw.algorithm;
  const verify = countingVerify(true);
  const result = verifyOne(raw, PAYLOAD, trustRecord(), verify);
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
  assert.equal(result.reason, 'unsupported_algorithm');
  assert.equal(verify.calls.length, 0);
});

test('verifyOne rejects a malformed (non-object) signature', () => {
  const result = verifyOne('not-an-object', PAYLOAD, trustRecord(), countingVerify(true));
  assertConstantShape(result);
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
});

test('verifyOne rejects a signature computed over a different canonicalization version', () => {
  const verify = countingVerify(true);
  const result = verifyOne(signature({ canonicalization_version: CANONICAL_METADATA_VERSION + 1 }), PAYLOAD, trustRecord(), verify);
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
  assert.equal(result.reason, 'canonicalization_version_mismatch');
  assert.equal(verify.calls.length, 0, 'a version-confused signature must not reach the cryptographic check');
});

test('verifyOne rejects a publisher_id mismatch between the trust record and the signed metadata', () => {
  const verify = countingVerify(true);
  const result = verifyOne(signature(), PAYLOAD, trustRecord({ publisher_id: 'someone-else' }), verify);
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED);
  assert.equal(result.reason, 'publisher_id_mismatch');
  assert.equal(verify.calls.length, 0);
});

test('verifyOne rejects an unknown key_id', () => {
  const verify = countingVerify(true);
  const result = verifyOne(signature({ key_id: 'key-does-not-exist' }), PAYLOAD, trustRecord(), verify);
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED);
  assert.equal(result.reason, 'unknown_key_id');
  assert.equal(verify.calls.length, 0);
});

test('verifyOne rejects a key registered under a different algorithm than the signature claims', () => {
  const verify = countingVerify(true);
  const record = trustRecord({ keys: [{ key_id: 'key-active', public_key: 'pub', algorithm: 'rsa-4096', status: 'active' }] });
  const result = verifyOne(signature(), PAYLOAD, record, verify);
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED);
  assert.equal(result.reason, 'key_algorithm_mismatch');
  assert.equal(verify.calls.length, 0);
});

test('verifyOne rejects a revoked key WITHOUT ever calling verify, even though the math would check out', () => {
  const verify = countingVerify(true);
  const result = verifyOne(signature({ key_id: 'key-revoked' }), PAYLOAD, trustRecord(), verify);
  assertConstantShape(result);
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED);
  assert.equal(result.reason, 'key_revoked');
  assert.equal(verify.calls.length, 0, 'a revoked key must cost nothing -- verify is never invoked');
});

test('verifyOne accepts an active key whose signature verifies, with requires_retrust false', () => {
  const verify = countingVerify(true);
  const result = verifyOne(signature({ key_id: 'key-active' }), PAYLOAD, trustRecord(), verify);
  assertConstantShape(result);
  assert.equal(result.ok, true);
  assert.equal(result.requires_retrust, false);
  assert.equal(result.key_id, 'key-active');
  assert.equal(result.algorithm, 'ed25519');
  assert.equal(verify.calls.length, 1);
  assert.equal(verify.calls[0].algorithm, 'ed25519');
  assert.equal(verify.calls[0].publicKey, 'pub-active');
  assert.ok(Buffer.isBuffer(verify.calls[0].message), 'verify must receive serialized canonical payload bytes, not a pre-serialized blob');
});

test('verifyOne accepts a rotated key whose signature verifies, with requires_retrust true', () => {
  const verify = countingVerify(true);
  const result = verifyOne(signature({ key_id: 'key-rotated' }), PAYLOAD, trustRecord(), verify);
  assert.equal(result.ok, true);
  assert.equal(result.requires_retrust, true, 'a rotated key is continuity evidence a human must still accept');
});

test('verifyOne rejects when the injected verify() returns false', () => {
  const verify = countingVerify(false);
  const result = verifyOne(signature(), PAYLOAD, trustRecord(), verify);
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
  assert.equal(result.reason, 'signature_verification_failed');
});

test('verifyOne treats a throwing verify() as a failed verification, not a crash', () => {
  const verify = () => { throw new Error('boom'); };
  const result = verifyOne(signature(), PAYLOAD, trustRecord(), verify);
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
});

// --- verifySignatures: array handling ---------------------------------------

test('verifySignatures rejects an empty or non-array signatures list', () => {
  for (const bad of [[], null, undefined, 'nope']) {
    const result = verifySignatures({ signatures: bad, payload: PAYLOAD, trustRecord: trustRecord(), verify: countingVerify(true) });
    assertConstantShape(result);
    assert.equal(result.ok, false);
    assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
    assert.equal(result.reason, 'no_signatures');
  }
});

test('verifySignatures: a lone rotated-key signature is accepted with requires_retrust true (not subject to the multi-signature "at least one active" rule)', () => {
  const result = verifySignatures({
    signatures: [signature({ key_id: 'key-rotated' })],
    payload: PAYLOAD,
    trustRecord: trustRecord(),
    verify: countingVerify(true),
  });
  assert.equal(result.ok, true);
  assert.equal(result.requires_retrust, true);
});

test('verifySignatures: two valid signatures, one active and one rotated, are both accepted with requires_retrust true', () => {
  const result = verifySignatures({
    signatures: [signature({ key_id: 'key-active' }), signature({ key_id: 'key-rotated' })],
    payload: PAYLOAD,
    trustRecord: trustRecord(),
    verify: countingVerify(true),
  });
  assert.equal(result.ok, true);
  assert.equal(result.requires_retrust, true);
});

test('verifySignatures: multiple signatures that are ALL rotated (no active key) are rejected as untrusted', () => {
  const record = trustRecord({
    keys: [
      { key_id: 'key-rotated-1', public_key: 'p1', algorithm: 'ed25519', status: 'rotated' },
      { key_id: 'key-rotated-2', public_key: 'p2', algorithm: 'ed25519', status: 'rotated' },
    ],
  });
  const result = verifySignatures({
    signatures: [signature({ key_id: 'key-rotated-1' }), signature({ key_id: 'key-rotated-2' })],
    payload: PAYLOAD,
    trustRecord: record,
    verify: countingVerify(true),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED);
  assert.equal(result.reason, 'no_active_key_signature');
});

test('verifySignatures: one good signature plus one malformed signature rejects the WHOLE package, not a partial accept', () => {
  const verify = countingVerify(true);
  const result = verifySignatures({
    signatures: [signature({ key_id: 'key-active' }), signature({ algorithm: 'none' })],
    payload: PAYLOAD,
    trustRecord: trustRecord(),
    verify,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
});

test('verifySignatures: order matters not -- a malformed signature listed FIRST still rejects the whole package', () => {
  const result = verifySignatures({
    signatures: [signature({ algorithm: 'none' }), signature({ key_id: 'key-active' })],
    payload: PAYLOAD,
    trustRecord: trustRecord(),
    verify: countingVerify(true),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
});
