'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMemoryFsFacade } = require('../../services/plugins/store/fs-facade');
const { createProductionDistributionContextFactory } = require('../../services/plugins/distribution/production-context');
const { isV3PluginEntry,
  promotionPreservesAuthority } = require('../../services/plugins/distribution/distribution-controller');
const { runCommitSequence } = require('../../services/plugins/lifecycle/commit-sequence');
const { createStage5ControlPlane,
  selectedPackageRequest } = require('../../services/plugins/stage5-control-plane');
const { putContent } = require('../../services/plugins/store/content-store');
const { getDataSnapshot } = require('../../services/plugins/store/data-snapshot-store');
const { getEvidence } = require('../../services/plugins/store/distribution-evidence-store');
const { writePackageRecord } = require('../../services/plugins/store/package-record-store');

test('production distribution context only admits local packages', async () => {
  const facade = createMemoryFsFacade();
  const roots = { ok: true, value: { trust_roots_schema_version: 1, publishers: [] },
    publishers: new Map() };
  const factory = createProductionDistributionContextFactory({
    facade, baseDir: 'store', trustRootsProvider: async () => roots,
    readLocalPackage: async () => ({ ok: false }), contractLockDigest: 'a'.repeat(64),
  });
  const local = await factory({ operation: { source_kind: 'local_package' } }, {
    localPackage: { ok: true, bytes: Buffer.from('package'), sourcePathDigest: 'b'.repeat(64) },
  });
  assert.equal(local.ok, true);
  assert.equal(local.value.detached, true);
  assert.equal((await local.value.readLocalPackage()).sourcePathDigest, 'b'.repeat(64));
  const remote = await factory({ operation: { source_kind: 'https_url' } });
  assert.equal(remote.ok, false);
  assert.equal(remote.reason, 'distribution_source_retired');
  for (const retired of ['signed_catalog', 'offline_mirror']) {
    const refused = await factory({ operation: { source_kind: retired } });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'distribution_source_retired');
  }
});

test('production distribution promotes a preserved V2 plugin into immutable V3 evidence', async () => {
  const facade = createMemoryFsFacade();
  const now = '2026-08-05T00:00:00Z';
  const keyId = 'f'.repeat(64);
  const stored = await putContent(facade, 'store', Buffer.from('legacy signed package'));
  const plugin = {
    publisher_id: 'jenny-official', plugin_id: 'legacy', display_name: 'Legacy',
    resolved_version: '1.0.0', publisher_key_id: keyId, artifact_digest: stored.digest,
    desired_state: 'active', effective_state: 'active', depends_on: [], contributions: [],
  };
  const packageRecord = {
    package_record_schema_version: 1,
    publisher_id: plugin.publisher_id,
    plugin_id: plugin.plugin_id,
    content_digest: stored.digest,
    version_axes: { package_semver: '1.0.0', manifest_schema_version: 2,
      contribution_contract_version: 2, capability_abi_version: 1, data_schema_version: 1 },
    canonical_metadata_digest: 'a'.repeat(64),
    signature_bundle_state: { state: 'verified', publisher_id: plugin.publisher_id,
      signing_key_id: keyId, signature_algorithm: 'ed25519' },
    source_identity: { kind: 'local_package', package_path_digest: 'b'.repeat(64) },
    size_evidence: { archive_bytes: 21, entry_count: 3, uncompressed_bytes: 21 },
    risk_flags: [], created_at: now,
  };
  assert.equal((await writePackageRecord(facade, 'store', {
    digest: stored.digest, record: packageRecord,
  })).ok, true);
  assert.equal((await runCommitSequence(facade, 'store', {
    operationId: 'legacy_commit', requestFingerprint: 'c'.repeat(64), lifecycleEpoch: 0,
    generationId: 'legacy_generation', createdAt: now, now,
    plugins: [plugin], generationSchemaVersion: 2,
    policyGrantRef: { policy_snapshot_digest: 'd'.repeat(64), policy_revision: 1,
      grant_set_digest: 'e'.repeat(64) }, dataSchemaRefs: [],
  })).ok, true);
  const roots = { ok: true, value: { trust_roots_schema_version: 1 }, publishers: new Map([[
    plugin.publisher_id,
    { current_key_id: keyId, established_at: now,
      keys: [{ key_id: keyId, status: 'active' }] },
  ]]) };
  const verdict = {
    ok: true, publisher_id: plugin.publisher_id, plugin_id: plugin.plugin_id,
    version: plugin.resolved_version, publisher_key_id: keyId,
    archive_digest: stored.digest, package_record: packageRecord,
    manifest: { manifest_schema_version: 2, requested_permissions: [], dependencies: [], contributions: [] },
  };
  const factory = createProductionDistributionContextFactory({
    facade, baseDir: 'store', trustRootsProvider: async () => roots,
    readLocalPackage: async () => ({ ok: false }), contractLockDigest: '1'.repeat(64),
    verifyPackage: async () => verdict, now: () => now,
  });
  const context = await factory({ operation: { source_kind: 'local_package' } });
  assert.equal(context.ok, true, context.reason);
  const promoted = await context.value.promotePreservedPlugin({
    plugin, generationId: 'promoted_generation', advisoryDigest: '2'.repeat(64),
  });
  assert.equal(promoted.ok, true, promoted.reason);
  assert.equal(isV3PluginEntry(promoted.plugin), true);
  assert.equal(promotionPreservesAuthority(plugin, promoted.plugin), true);
  assert.equal((await getEvidence(facade, 'store', 'source_trust',
    promoted.plugin.source_trust_digest)).ok, true);
  assert.equal((await getDataSnapshot(facade, 'store', {
    publisherId: plugin.publisher_id, pluginId: plugin.plugin_id,
    digest: promoted.plugin.data_snapshot_digest,
  })).bytes.toString('utf8'), '{}');
  assert.equal(promotionPreservesAuthority(plugin, {
    ...promoted.plugin, resolved_version: '9.0.0',
  }), false);
});

test('Stage 5 control plane derives local package authority in Electron', async () => {
  let observedRequest = null;
  let observedInternal = null;
  const service = createStage5ControlPlane({
    facade: createMemoryFsFacade(),
    distributionController: {
      async startDistributionOperation(request) {
        observedRequest = request;
        return { ok: true, operation_id: 'distribution_1', status: 'pending' };
      },
    },
    selectLocalPackage: async () => ({
      ok: true, bytes: Buffer.from('signed'), sourcePathDigest: 'c'.repeat(64),
    }),
    inspectLocalPackage: async () => ({
      ok: true, publisher_id: 'acme-labs', plugin_id: 'remote-tools',
    }),
    createDistributionContext: async (_request, internal) => {
      observedInternal = internal;
      return { ok: true, value: {} };
    },
  });
  const result = await service.startDistributionOperation({ client_request_id: 'install_1' });
  assert.equal(result.ok, true);
  assert.deepEqual(observedRequest.operation.target, {
    publisher_id: 'acme-labs', plugin_id: 'remote-tools',
  });
  assert.equal(observedRequest.operation.source_locator, 'electron_native_picker');
  assert.equal(observedInternal.localPackage.sourcePathDigest, 'c'.repeat(64));
  assert.equal((await service.startDistributionOperation({
    client_request_id: 'install_2', source_locator: 'C:\\secret',
  })).reason, 'distribution_request_invalid');
  service.dispose();
});

test('local package selection routes a newer installed identity through update authority', () => {
  const committed = {
    pointer: { generation_id: 'generation-current' },
    generation: {
      generation_id: 'generation-current',
      plugins: [{
        publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription',
        resolved_version: '1.0.0',
      }],
    },
  };
  const selected = selectedPackageRequest({
    inspected: {
      publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription', version: '1.0.1',
    },
    committed,
    clientRequestId: 'update_1',
  });
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.request.operation, {
    kind: 'update',
    target: { publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription' },
    expected_generation_id: 'generation-current',
  });
  assert.equal(selectedPackageRequest({
    inspected: {
      publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription', version: '1.0.0',
    },
    committed,
    clientRequestId: 'same_1',
  }).reason, 'selected_package_version_not_higher');
  assert.equal(selectedPackageRequest({
    inspected: {
      publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription', version: '0.9.0',
    },
    committed,
    clientRequestId: 'lower_1',
  }).reason, 'selected_package_downgrade_requires_consent');
});

test('Stage 5 control plane exposes no plugin MCP or OAuth surface', () => {
  const service = createStage5ControlPlane({
    facade: createMemoryFsFacade(),
    distributionController: { async dispose() {} },
  });
  for (const retired of ['setNetworkConsent', 'beginRemoteMcpAuthorization',
    'revokeRemoteMcpAuthorization', 'executeRemoteTool']) {
    assert.equal(retired in service, false, retired);
  }
  service.dispose();
});
