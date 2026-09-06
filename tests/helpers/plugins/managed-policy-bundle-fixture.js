'use strict';

// Shared signed-bundle fixture for the managed-policy suites.
//
// This used to live in `tests/plugins/policy/managed-policy-bundle.test.js` and
// be pulled in with `require('./managed-policy-bundle.test')`. Requiring a test
// file for its exports also runs its `test()` registrations in the importer's
// process, so managed-policy-service.test.js registered 11 tests instead of 8 --
// the bundle file's 3 cases ran a second time under the wrong file's name and
// per-file attribution. Fixtures belong in a helper; test files export nothing.

const crypto = require('node:crypto');
const { stableStringify } = require('../../../services/plugins/package/canonical-metadata');

const NOW = '2026-08-10T12:00:00.000Z';

function signedBundle(overrides = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  const policy = {
    policy_schema_version: 1,
    revision: 1,
    issued_at: '2026-08-10T11:00:00.000Z',
    expires_at: '2026-09-10T11:00:00.000Z',
    privileged_execution: 'deny',
    installation: 'allow_inactive',
    update_ring: 'stable',
    allowed_source_kinds: ['local_package', 'signed_catalog', 'offline_mirror'],
    allowed_publishers: [],
    procurement: { require_sbom: true, require_build_provenance: true },
    audit_max_entries: 500,
    managed_source_fingerprints: [],
    ...overrides,
  };
  const signature = crypto.sign(null, Buffer.from(stableStringify(policy), 'utf8'), privateKey);
  return Buffer.from(JSON.stringify({
    managed_policy_bundle_version: 1,
    policy,
    signature: {
      algorithm: 'ed25519',
      key_id: crypto.createHash('sha256').update(publicDer).digest('hex'),
      public_key_spki_base64: publicDer.toString('base64'),
      signature_base64: signature.toString('base64'),
    },
  }));
}

module.exports = { signedBundle, NOW };
