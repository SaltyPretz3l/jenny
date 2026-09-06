'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { buildSignedPluginPackage } = require('../../helpers/plugins/zip-fixture-builder');
const { verifyDistributionPackage } = require('../../../services/plugins/package/distribution-package-intake');
const { verifyLocalPackage } = require('../../../services/plugins/package/local-package-intake');
test('distribution intake opts into V3 while the production local wrapper remains V1/V2 only', async () => {
  const fixture = buildSignedPluginPackage({ contractVersion: 3, dataSchemaVersion: 2,
    extraEntries: { 'META-JENNY/migrations.json': JSON.stringify({ migrations_schema_version: 1, migrations: [{ from_version: 1, to_version: 2, executorTier: 'declarative', steps: [] }] }) } });
  const distributed = await verifyDistributionPackage({ bytes: fixture.bytes,
    sourceIdentity: { kind: 'https_url', url_digest: 'b'.repeat(64) }, trustRoots: fixture.trustRoots,
    verificationCacheKey: 'c'.repeat(64), now: '2026-08-04T00:00:00Z' });
  assert.equal(distributed.ok, true); assert.equal(distributed.package_record.package_record_schema_version, 3);
  assert.equal(distributed.data_schema_version, 2); assert.ok(distributed.migration_descriptor_bytes);
  assert.deepEqual(distributed.package_metadata, {
    sbom_present: false, build_provenance_present: false,
  });
  const local = await verifyLocalPackage({ bytes: fixture.bytes, sourcePathDigest: fixture.sourcePathDigest,
    trustRoots: fixture.trustRoots, now: '2026-08-04T00:00:00Z' });
  assert.equal(local.ok, false);
});

test('distribution intake exposes signed procurement metadata presence without its contents', async () => {
  const fixture = buildSignedPluginPackage({
    contractVersion: 3,
    extraEntries: {
      'META-JENNY/sbom.json': JSON.stringify({ bomFormat: 'CycloneDX' }),
      'META-JENNY/provenance.json': JSON.stringify({ builder: 'test' }),
    },
  });
  const verified = await verifyDistributionPackage({ bytes: fixture.bytes,
    sourceIdentity: { kind: 'local_package', package_path_digest: fixture.sourcePathDigest },
    trustRoots: fixture.trustRoots, verificationCacheKey: 'e'.repeat(64),
    now: '2026-08-05T00:00:00Z' });
  assert.equal(verified.ok, true, verified.reason);
  assert.deepEqual(verified.package_metadata, {
    sbom_present: true, build_provenance_present: true,
  });
  assert.equal(JSON.stringify(verified).includes('CycloneDX'), false);
});

function restrictedContribution(overrides = {}) {
  return {
    kind: 'restricted_compute', contribution_id: 'compute', name: 'Compute',
    content_path: 'content/compute.json', component_path: 'components/compute.wasm',
    component_bytes: Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0a, 0x00, 0x01, 0x00]),
    content: {
      content_schema_version: 4, publisher_id: 'acme-labs', plugin_id: 'widgets',
      contribution_id: 'compute',
      payload: {
        kind: 'restricted_compute', description: 'Bounded compute',
        input_schema_json: '{"type":"object"}', output_schema_json: '{"type":"object"}',
        timeout_ms: 1000, capabilities: ['control.cancelled'], network_origins: [],
      },
    },
    ...overrides,
  };
}

async function verifyV4(fixture) {
  return verifyDistributionPackage({
    bytes: fixture.bytes,
    sourceIdentity: { kind: 'local_package', package_path_digest: fixture.sourcePathDigest },
    trustRoots: fixture.trustRoots,
    verificationCacheKey: 'd'.repeat(64),
    now: '2026-08-05T00:00:00Z',
  });
}

test('signed V4 intake captures exact restricted component bytes and rejects digest/shape drift', async () => {
  const validFixture = buildSignedPluginPackage({
    contractVersion: 4,
    contributions: [restrictedContribution()],
  });
  const valid = await verifyV4(validFixture);
  assert.equal(valid.ok, true, valid.reason);
  assert.equal(valid.manifest.manifest_schema_version, 4);
  assert.equal(valid.restricted_component_bytes.length, 1);
  assert.equal(valid.restricted_component_bytes[0].component_digest,
    valid.manifest.contributions[0].component_sha256);

  const badDigest = buildSignedPluginPackage({
    contractVersion: 4,
    contributions: [restrictedContribution()],
    manifestMutator: (manifest) => {
      manifest.contributions[0].component_sha256 = 'f'.repeat(64);
      return manifest;
    },
  });
  assert.equal((await verifyV4(badDigest)).reason, 'restricted_component_digest_mismatch');

  const tooMany = buildSignedPluginPackage({
    contractVersion: 4,
    contributions: [
      restrictedContribution(),
      restrictedContribution({
        contribution_id: 'compute_two', content_path: 'content/compute-two.json',
        component_path: 'components/compute-two.wasm',
        content: {
          ...restrictedContribution().content,
          contribution_id: 'compute_two',
        },
      }),
    ],
  });
  assert.equal((await verifyV4(tooMany)).reason, 'plugin_manifest_invalid');
});
