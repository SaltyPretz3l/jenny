'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  keyIdentity,
  validateTrustedPublisherRoots,
  loadTrustedPublisherRoots,
  findTrustedPublisher,
} = require('../../../services/plugins/package/trusted-publisher-roots');
const { NOW, keyFixture } = require('../../helpers/plugins/zip-fixture-builder');

function documentFor(key, overrides = {}) {
  return {
    trust_roots_schema_version: 1,
    updated_at: NOW,
    publishers: [{
      publisher_id: 'acme-labs',
      current_key_id: key.key_id,
      established_at: NOW,
      keys: [key],
      ...overrides,
    }],
  };
}

test('valid Ed25519 SPKI roots normalize to crypto keys bound to stable publisher identity', () => {
  const key = keyFixture().key;
  const result = validateTrustedPublisherRoots(documentFor(key));
  assert.equal(result.ok, true);
  const publisher = findTrustedPublisher(result, 'acme-labs');
  assert.equal(publisher.current_key_id, key.key_id);
  assert.equal(publisher.keys[0].public_key.asymmetricKeyType, 'ed25519');
  assert.equal(findTrustedPublisher(result, 'unknown'), null);
});

test('key id, fingerprint, base64, and key type are independently fail-closed', () => {
  const valid = keyFixture().key;
  for (const [mutate, reason] of [
    [(key) => ({ ...key, key_id: 'f'.repeat(64) }), 'publisher_key_identity_mismatch'],
    [(key) => ({ ...key, fingerprint: `SHA256:${'A'.repeat(43)}=` }), 'publisher_key_identity_mismatch'],
    [(key) => ({ ...key, public_key_spki_der_base64: `${key.public_key_spki_der_base64.slice(0, -1)}!` }), 'trust_roots_invalid'],
  ]) {
    const result = validateTrustedPublisherRoots(documentFor(mutate(valid)));
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
  }

  const x25519 = crypto.generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' });
  const identity = keyIdentity(x25519);
  const wrongTypeKey = {
    key_id: identity.keyId,
    fingerprint: identity.fingerprint,
    algorithm: 'ed25519',
    public_key_spki_der_base64: x25519.toString('base64'),
    status: 'active',
    added_at: NOW,
  };
  assert.equal(validateTrustedPublisherRoots(documentFor(wrongTypeKey)).reason, 'publisher_key_type_invalid');
});

test('revocation timestamps and the active current-key invariant are enforced', () => {
  const active = keyFixture().key;
  const revokedWithoutTime = { ...active, status: 'revoked' };
  assert.equal(validateTrustedPublisherRoots(documentFor(revokedWithoutTime)).reason, 'revoked_key_missing_timestamp');

  const activeWithRevocation = { ...active, revoked_at: NOW };
  assert.equal(validateTrustedPublisherRoots(documentFor(activeWithRevocation)).reason, 'non_revoked_key_has_revocation_timestamp');

  const rotated = { ...active, status: 'rotated' };
  assert.equal(validateTrustedPublisherRoots(documentFor(rotated)).reason, 'publisher_current_key_not_active');
});

test('loader bounds parse/read failures and never exposes a local path', async () => {
  const key = keyFixture().key;
  const loaded = await loadTrustedPublisherRoots({
    filePath: 'not-observable',
    readFile: async () => Buffer.from(JSON.stringify(documentFor(key))),
  });
  assert.equal(loaded.ok, true);

  const malformed = await loadTrustedPublisherRoots({
    filePath: 'C:\\secret\\trusted.json',
    readFile: async () => Buffer.from('{bad'),
  });
  assert.deepEqual({ ok: malformed.ok, reason: malformed.reason }, { ok: false, reason: 'trust_roots_json_invalid' });
  assert.equal(JSON.stringify(malformed).includes('secret'), false);

  const missing = await loadTrustedPublisherRoots({
    filePath: 'C:\\secret\\trusted.json',
    readFile: async () => { throw new Error('C:\\secret\\trusted.json'); },
  });
  assert.deepEqual({ ok: missing.ok, reason: missing.reason }, { ok: false, reason: 'trust_roots_unavailable' });
  assert.equal(JSON.stringify(missing).includes('secret'), false);
});
