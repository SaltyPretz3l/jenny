'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { PLUGIN_ERROR_CODES } = require('../../../services/backend/error-codes');
const {
  DEVELOPER_UNSIGNED_KEY_ID,
  verifyDistributionPackage,
} = require('../../../services/plugins/package/distribution-package-intake');
const { buildSignedPluginPackage } = require('../../helpers/plugins/zip-fixture-builder');

const NOW = '2026-09-01T00:00:00Z';
const EMPTY_ROOTS = Object.freeze({
  ok: true,
  value: Object.freeze({ trust_roots_schema_version: 1, updated_at: NOW, publishers: [] }),
  publishers: new Map(),
});

function localIdentity(fixture) {
  return { kind: 'local_package', package_path_digest: fixture.sourcePathDigest };
}

function verifyArgs(fixture, overrides = {}) {
  return { bytes: fixture.bytes, sourceIdentity: localIdentity(fixture),
    trustRoots: EMPTY_ROOTS, verificationCacheKey: 'c'.repeat(64), now: NOW,
    developerProfile: true, ...overrides };
}

function withoutTrustIdentity(verdict) {
  const copy = structuredClone(verdict);
  copy.publisher_key_id = '<publisher-key>';
  copy.package_record.signing_key_id = '<publisher-key>';
  return copy;
}

test('developer verification changes only signing identity and source trust for the same bytes', async () => {
  const fixture = buildSignedPluginPackage({ contractVersion: 3 });
  const signed = await verifyDistributionPackage({ bytes: fixture.bytes,
    sourceIdentity: localIdentity(fixture),
    trustRoots: fixture.trustRoots, verificationCacheKey: 'c'.repeat(64), now: NOW });
  const developer = await verifyDistributionPackage(verifyArgs(fixture));

  assert.equal(signed.ok, true, signed.reason);
  assert.equal(developer.ok, true, developer.reason);
  assert.equal(DEVELOPER_UNSIGNED_KEY_ID,
    crypto.createHash('sha256').update('developer-unsigned', 'ascii').digest('hex'));
  assert.equal(developer.publisher_key_id, DEVELOPER_UNSIGNED_KEY_ID);
  assert.equal(developer.package_record.signing_key_id, DEVELOPER_UNSIGNED_KEY_ID);
  assert.deepEqual(developer.package_record.source_identity, localIdentity(fixture));
  assert.deepEqual(withoutTrustIdentity(developer), withoutTrustIdentity(signed));
});

test('developer verification is unavailable when the profile flag is off', async () => {
  const fixture = buildSignedPluginPackage({ contractVersion: 3 });
  const result = await verifyDistributionPackage(verifyArgs(fixture, { developerProfile: false }));
  assert.deepEqual({ ok: result.ok, code: result.code, reason: result.reason }, {
    ok: false, code: PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED,
    reason: 'publisher_not_pretrusted',
  });
});

test('publisher ids present in any trust root are reserved from developer intake', async () => {
  const fixture = buildSignedPluginPackage({ contractVersion: 3 });
  const result = await verifyDistributionPackage(verifyArgs(fixture, {
    trustRoots: fixture.trustRoots,
  }));
  assert.deepEqual({ ok: result.ok, code: result.code, reason: result.reason }, {
    ok: false, code: PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED,
    reason: 'developer_publisher_id_reserved',
  });
});
