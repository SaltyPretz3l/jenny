'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createProductionDistributionContextFactory,
} = require('../../../services/plugins/distribution/production-context');
const { runCommitSequence } = require('../../../services/plugins/lifecycle/commit-sequence');
const { recordDigest } = require('../../../services/plugins/distribution/distribution-recovery');
const { putContent } = require('../../../services/plugins/store/content-store');
const { putDataSnapshot } = require('../../../services/plugins/store/data-snapshot-store');
const { writeDataState } = require('../../../services/plugins/store/data-state-store');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { writePackageRecord } = require('../../../services/plugins/store/package-record-store');
const { verifiedPackageVerdict } = require('../../helpers/plugins/durability-scenario');

const BASE_DIR = 'store';
const NOW = '2026-08-23T00:00:00Z';
const hex = (value) => value.repeat(64);

async function seedInstalledPlugin({ data, dataSchemaVersion = 1, manifest }) {
  const facade = createMemoryFsFacade();
  const bytes = Buffer.from('installed plugin package');
  const content = await putContent(facade, BASE_DIR, bytes);
  const verdict = verifiedPackageVerdict({ packageBytes: bytes, publisherId: 'acme',
    pluginId: 'widget', now: NOW });
  verdict.archive_digest = content.digest;
  verdict.data_schema_version = dataSchemaVersion;
  verdict.package_record.version_axes.data_schema_version = dataSchemaVersion;
  verdict.manifest = manifest || {
    manifest_schema_version: 3, requested_permissions: [], dependencies: [], contributions: [],
  };
  assert.equal((await writePackageRecord(facade, BASE_DIR, {
    digest: content.digest, record: verdict.package_record,
  })).ok, true);
  const snapshot = await putDataSnapshot(facade, BASE_DIR, {
    publisherId: 'acme', pluginId: 'widget', generationId: 'generation-current',
    bytes: Buffer.from(JSON.stringify(data)), createdAt: NOW, evidentiary: false,
  });
  assert.equal(snapshot.ok, true, snapshot.reason);
  const plugin = {
    publisher_id: 'acme', plugin_id: 'widget', display_name: 'Widget',
    resolved_version: '1.0.0', publisher_key_id: verdict.publisher_key_id,
    artifact_digest: content.digest, package_record_digest: recordDigest(verdict.package_record),
    source_trust_digest: hex('1'), advisory_snapshot_digest: hex('2'),
    data_snapshot_digest: snapshot.digest, desired_state: 'installed_disabled',
    effective_state: 'installed_disabled', remote_binding_digests: [],
  };
  const committed = await runCommitSequence(facade, BASE_DIR, {
    operationId: 'seed-current', requestFingerprint: hex('3'), lifecycleEpoch: 0,
    generationId: 'generation-current', createdAt: NOW, plugins: [plugin],
    policyGrantRef: { policy_snapshot_digest: hex('4'), policy_revision: 1,
      grant_set_digest: hex('5'), network_consent_digest: hex('6') },
    dataSchemaRefs: [], now: NOW, generationSchemaVersion: 3,
    lockDigest: hex('7'), distributionStateDigest: hex('8'),
  });
  assert.equal(committed.ok, true, committed.reason);
  assert.equal((await writeDataState(facade, BASE_DIR, {
    publisher_id: 'acme', plugin_id: 'widget', data_domain_id: 'widget_data',
    data_schema_version: dataSchemaVersion, data_generation_id: 'generation-current',
    migration_executor_tier: 'declarative',
    mutation_watermark: { sequence: 2, recorded_at: NOW }, rollback_barrier: { kind: 'none' },
    snapshot_references: [{ operation_id: 'seed-current', generation_id: 'generation-current',
      created_at: NOW }],
  })).ok, true);
  return { facade, plugin, snapshot, verdict };
}

function trustRoots(verdict) {
  return { ok: true, value: { trust_roots_schema_version: 1, revision: 1, publishers: [] },
    publishers: new Map([['acme', { current_key_id: verdict.publisher_key_id, established_at: NOW,
      keys: [{ key_id: verdict.publisher_key_id, status: 'active' }] }]]) };
}

function factoryFor(seed) {
  return createProductionDistributionContextFactory({
    facade: seed.facade, baseDir: BASE_DIR, trustRootsProvider: async () => trustRoots(seed.verdict),
    readLocalPackage: async () => ({ ok: false }), contractLockDigest: hex('9'),
    verifyPackage: async () => seed.verdict, now: () => NOW,
  });
}

test('V6 preserved mixed contributions omit missing executable digests', async () => {
  const executableDigest = hex('a');
  const seed = await seedInstalledPlugin({ data: {}, manifest: {
    manifest_schema_version: 6, requested_permissions: ['runtime.full_host'], dependencies: [],
    contributions: [
      { kind: 'skill', content_sha256: hex('b') },
      { kind: 'session_provider', content_sha256: hex('c'), executable_sha256: executableDigest },
    ],
  } });
  const context = await factoryFor(seed)({ operation: { kind: 'install' } });
  assert.equal(context.ok, true, context.reason);
  const promoted = await context.value.promotePreservedPlugin({
    plugin: seed.plugin, generationId: 'generation-promoted',
    advisoryDigest: hex('d'), generationSchemaVersion: 6,
  });
  assert.equal(promoted.ok, true, promoted.reason);
  assert.deepEqual(promoted.plugin.executable_object_digests, [executableDigest]);
});
