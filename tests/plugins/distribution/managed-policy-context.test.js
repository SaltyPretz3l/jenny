'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createProductionDistributionContextFactory,
  digest,
} = require('../../../services/plugins/distribution/production-context');
const {
  currentPolicyReference,
} = require('../../../services/plugins/distribution/distribution-controller');
const { putContent } = require('../../../services/plugins/store/content-store');
const { writePackageRecord } = require('../../../services/plugins/store/package-record-store');
const { createSeededFacade } = require('../../helpers/plugins/memory-fs-facade');
const { verifiedPackageVerdict } = require('../../helpers/plugins/durability-scenario');

function factory(status) {
  return createProductionDistributionContextFactory({
    managedPolicy: { status: () => status },
  });
}

const target = { publisher_id: 'acme', plugin_id: 'widget' };

async function managedContext(statusRef, tokenRef = { revision: 4, policy_digest: 'a'.repeat(64) },
  request = { operation: { kind: 'install', source_kind: 'local_package',
    source_locator: 'selected.zip', target: { publisher_id: 'trusted', plugin_id: 'widget' } } }) {
  const facade = require('../../helpers/plugins/memory-fs-facade').createSeededFacade;
  const create = createProductionDistributionContextFactory({
    facade: await facade(),
    trustRootsProvider: async () => ({ ok: true, value: {
      trust_roots_schema_version: 1, revision: 1, publishers: [],
    } }),
    contractLockDigest: 'b'.repeat(64),
    managedPolicy: {
      status: () => statusRef.current,
      capture: () => ({ ...tokenRef }),
      isCurrent: (token) => token.revision === tokenRef.revision
        && token.policy_digest === tokenRef.policy_digest,
      policyGrantRef: (reference) => ({ ...reference,
        policy_revision: tokenRef.revision, policy_snapshot_digest: tokenRef.policy_digest }),
    },
  });
  return create(request);
}

test('malformed managed state blocks distribution mutations without touching a source', async () => {
  const create = factory({ status: 'blocked', reason: 'managed_policy_signature_invalid' });
  assert.deepEqual(await create({ operation: { kind: 'install', source_kind: 'local_package', target } }), {
    ok: false, reason: 'managed_policy_signature_invalid',
  });
});

test('managed installation, update ring, source, and publisher ceilings are terminal', async () => {
  const base = { status: 'active', installation: 'allow_inactive', update_ring: 'stable',
    allowed_source_kinds: ['signed_catalog'], allowed_publishers: ['trusted'] };
  assert.equal((await factory({ ...base, installation: 'deny' })({
    operation: { kind: 'install', source_kind: 'signed_catalog', target },
  })).reason, 'managed_policy_installation_denied');
  assert.equal((await factory({ ...base, update_ring: 'frozen' })({
    operation: { kind: 'update', source_kind: 'signed_catalog', target },
  })).reason, 'managed_policy_update_ring_frozen');
  assert.equal((await factory(base)({
    operation: { kind: 'install', source_kind: 'local_package', target },
  })).reason, 'managed_policy_source_denied');
  assert.equal((await factory(base)({
    operation: { kind: 'install', source_kind: 'signed_catalog', target },
  })).reason, 'managed_policy_publisher_denied');
});

test('read-only catalog refresh remains available for security metadata', async () => {
  const create = factory({ status: 'blocked', reason: 'managed_policy_source_partial' });
  assert.equal((await create({ operation: { kind: 'catalog_refresh', catalog_id: 'stable' } })).reason,
    'publisher_trust_unavailable');
});

test('rollback and quarantine choose the current policy ref rather than historical authority', () => {
  const old = { policy_revision: 1 };
  const current = { policy_revision: 9 };
  assert.equal(currentPolicyReference({ policyGrantRefV6: current }, 6, old), current);
  assert.equal(currentPolicyReference({}, 6, old), old);
  assert.deepEqual(currentPolicyReference({
    currentPolicyReference: (_version, fallback) => ({ ...fallback, policy_revision: 11 }),
  }, 6, old), { policy_revision: 11 });
});

test('candidate policy enforces source fingerprint, publisher, and procurement evidence', async () => {
  const sourceIdentity = { kind: 'local_package', package_path_digest: 'c'.repeat(64) };
  const statusRef = { current: {
    status: 'active', installation: 'allow_inactive', update_ring: 'stable',
    allowed_source_kinds: ['local_package'], allowed_publishers: ['trusted'],
    managed_source_fingerprints: [digest(sourceIdentity)], require_sbom: true,
    require_build_provenance: true,
  } };
  const built = await managedContext(statusRef);
  assert.equal(built.ok, true, built.reason);
  const validate = built.value.validateManagedCandidate;
  assert.equal(validate({ sourceIdentity, verified: { publisher_id: 'trusted',
    package_metadata: { sbom_present: true, build_provenance_present: true } } }).ok, true);
  assert.equal(validate({ sourceIdentity: { kind: 'signed_catalog', catalog_id: 'stable',
    tuf_target_path: 'acme/widget' }, verified: { publisher_id: 'trusted', package_metadata: {
      sbom_present: true, build_provenance_present: true,
    } } }).reason, 'managed_policy_source_denied');
  assert.equal(validate({ sourceIdentity: { ...sourceIdentity, package_path_digest: 'd'.repeat(64) },
    verified: { publisher_id: 'trusted', package_metadata: {
      sbom_present: true, build_provenance_present: true,
    } } }).reason, 'managed_policy_source_fingerprint_denied');
  assert.equal(validate({ sourceIdentity, verified: { publisher_id: 'other',
    package_metadata: { sbom_present: true, build_provenance_present: true } } }).reason,
  'managed_policy_publisher_denied');
  assert.equal(validate({ sourceIdentity, verified: { publisher_id: 'trusted',
    package_metadata: { sbom_present: false, build_provenance_present: true } } }).reason,
  'managed_policy_sbom_required');
  assert.equal(validate({ sourceIdentity, verified: { publisher_id: 'trusted',
    package_metadata: { sbom_present: true, build_provenance_present: false } } }).reason,
  'managed_policy_build_provenance_required');
});

test('frozen update request still enforces the actual selected package source kind', async () => {
  const statusRef = { current: {
    status: 'active', installation: 'allow_inactive', update_ring: 'stable',
    allowed_source_kinds: ['signed_catalog'], allowed_publishers: ['trusted'],
    managed_source_fingerprints: [], require_sbom: false, require_build_provenance: false,
  } };
  const built = await managedContext(statusRef, undefined, { operation: {
    kind: 'update', target: { publisher_id: 'trusted', plugin_id: 'widget' },
  } });
  assert.equal(built.ok, true, built.reason);
  assert.equal(built.value.validateManagedCandidate({
    sourceIdentity: { kind: 'local_package', package_path_digest: 'c'.repeat(64) },
    verified: { publisher_id: 'trusted', package_metadata: {} },
  }).reason, 'managed_policy_source_denied');
});

test('an in-flight mutation is stale after any managed policy revision change', async () => {
  const statusRef = { current: {
    status: 'active', installation: 'allow_inactive', update_ring: 'stable',
    allowed_source_kinds: ['local_package'], allowed_publishers: [],
    managed_source_fingerprints: [], require_sbom: false, require_build_provenance: false,
  } };
  const tokenRef = { revision: 4, policy_digest: 'a'.repeat(64) };
  const built = await managedContext(statusRef, tokenRef);
  assert.equal(built.value.assertManagedPolicyCurrent().ok, true);
  tokenRef.revision = 5;
  assert.equal(built.value.assertManagedPolicyCurrent().reason,
    'managed_policy_authority_stale');
});

test('rollback revalidates each historical package against its actual current source policy', async () => {
  const facade = await createSeededFacade();
  const bytes = Buffer.from('historical managed package');
  const verdict = verifiedPackageVerdict({ packageBytes: bytes, publisherId: 'trusted',
    pluginId: 'widget' });
  verdict.archive_digest = verdict.package_record.content_digest;
  verdict.package_metadata = { sbom_present: true, build_provenance_present: true };
  const stored = await putContent(facade, '', bytes);
  assert.equal(stored.ok, true);
  assert.equal((await writePackageRecord(facade, '', {
    digest: stored.digest, record: verdict.package_record,
  })).ok, true);
  const statusRef = { current: {
    status: 'active', installation: 'allow_inactive', update_ring: 'stable',
    allowed_source_kinds: ['signed_catalog'], allowed_publishers: ['trusted'],
    managed_source_fingerprints: [], require_sbom: true, require_build_provenance: true,
  } };
  const token = { revision: 8, policy_digest: '8'.repeat(64) };
  const create = createProductionDistributionContextFactory({
    facade,
    trustRootsProvider: async () => ({ ok: true, value: {
      trust_roots_schema_version: 1, revision: 1, publishers: [],
    } }),
    verifyPackage: async () => verdict,
    contractLockDigest: 'b'.repeat(64),
    managedPolicy: {
      status: () => statusRef.current,
      capture: () => token,
      isCurrent: (candidate) => candidate === token,
      policyGrantRef: (reference) => reference,
    },
  });
  const built = await create({ operation: { kind: 'rollback' } });
  assert.equal(built.ok, true, built.reason);
  const generation = { plugins: [{
    publisher_id: 'trusted', plugin_id: 'widget', display_name: 'Plugin widget',
    resolved_version: '1.0.0', publisher_key_id: verdict.publisher_key_id,
    artifact_digest: stored.digest, desired_state: 'installed_disabled',
    effective_state: 'installed_disabled', depends_on: [],
  }] };
  assert.equal(await built.value.validatePolicy(generation), false);
  statusRef.current = { ...statusRef.current, allowed_source_kinds: ['local_package'],
    managed_source_fingerprints: [digest(verdict.package_record.source_identity)] };
  assert.equal(await built.value.validatePolicy(generation), true);
});
