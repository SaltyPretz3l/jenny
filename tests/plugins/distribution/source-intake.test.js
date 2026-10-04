'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const sourceIntake = require('../../../services/plugins/distribution/source-intake');
const { sourceTrustMatches } = sourceIntake;
test('source trust binds a local package identity to its authorized locator', () => {
  const d = (value) => value.repeat(64);
  assert.equal(sourceTrustMatches({ kind: 'local_package', package_path_digest: d('a') },
    { kind: 'local_package', package_path_digest: d('a'), sbom_exempt: true }), true);
  assert.equal(sourceTrustMatches({ kind: 'local_package', package_path_digest: d('a') },
    { kind: 'local_package', package_path_digest: d('b'), sbom_exempt: true }), false);
});
test('catalog and offline mirror identities never match a trust record and their helpers are gone', () => {
  const d = (value) => value.repeat(64);
  assert.equal(sourceTrustMatches({ kind: 'signed_catalog', catalog_id: 'stable', tuf_root_digest: d('c'), target_path_digest: d('d') },
    { kind: 'signed_catalog', catalog_id: 'stable', tuf_root_digest: d('c'), sbom_attested: true }), false);
  assert.equal(sourceTrustMatches({ kind: 'offline_mirror', mirror_id: 'mirror', tuf_root_digest: d('c'), target_path_digest: d('d') },
    { kind: 'offline_mirror', mirror_id: 'mirror', tuf_root_digest: d('c'), sbom_attested: true }), false);
  assert.equal(Object.hasOwn(sourceIntake, 'normalizeOfflineRoot'), false);
  assert.equal(Object.hasOwn(sourceIntake, 'publicSourceIdentity'), false);
});
