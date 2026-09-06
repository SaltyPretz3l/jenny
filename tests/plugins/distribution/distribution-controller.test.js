'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { MemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { getReceipt } = require('../../../services/plugins/store/operation-receipts');
const { DISTRIBUTION_GENERATION_SCHEMA_VERSIONS, DistributionController } = require('../../../services/plugins/distribution/distribution-controller');
const { buildSignedPluginPackage } = require('../../helpers/plugins/zip-fixture-builder');
const { digest } = require('../../../services/plugins/distribution/source-intake');
const { readCommittedState } = require('../../../services/plugins/lifecycle/commit-sequence');
const { exportAuditLog } = require('../../../services/plugins/lifecycle/audit-export');
test('distribution quarantine and rollback schema admission includes V6', () => {
  assert.deepEqual([...DISTRIBUTION_GENERATION_SCHEMA_VERSIONS], [3, 4, 5, 6]);
});
test('controller is direct-only, creates a pending receipt before work, and settles a check once', async () => {
  const fs = new MemoryFsFacade(); const controller = new DistributionController({ facade: fs, baseDir: 's', mintOperationId: () => 'op1', now: () => '2026-08-04T00:00:00Z', realpath: async (value) => value });
  const request = { operation_schema_version: 1, client_request_id: 'request1', operation: { kind: 'check', target: { publisher_id: 'acme', plugin_id: 'widget' } } };
  const result = await controller.startDistributionOperation(request, { check: async () => {
    const receipt = await getReceipt(fs, 's', 'op1'); assert.equal(receipt.receipt.status, 'pending'); return { ok: true, update_available: true }; } });
  assert.equal(result.status, 'checked'); assert.equal((await getReceipt(fs, 's', 'op1')).receipt.status, 'committed');
  assert.equal(Object.hasOwn(controller, 'ipc'), false);
});
test('detached operations can be awaited internally and disposal aborts then settles them', async () => {
  const fs = new MemoryFsFacade();
  const controller = new DistributionController({
    facade: fs, baseDir: 's', mintOperationId: () => 'detached1',
    now: () => '2026-08-04T00:00:00Z', realpath: async (value) => value,
  });
  let aborted = false;
  const started = await controller.startDistributionOperation({
    operation_schema_version: 1,
    client_request_id: 'detached_request',
    operation: { kind: 'check', target: { publisher_id: 'acme', plugin_id: 'widget' } },
  }, {
    detached: true,
    check: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => {
      aborted = true;
      resolve({ ok: false, reason: 'test_abort' });
    }, { once: true })),
  });
  assert.deepEqual(started, { ok: true, operation_id: 'detached1', status: 'pending' });
  const settled = controller.waitForOperation('detached1');
  await controller.dispose();
  assert.equal(aborted, true);
  assert.equal((await settled).reason, 'test_abort');
  assert.equal((await getReceipt(fs, 's', 'detached1')).receipt.status, 'failed');
});
test('offline mirror selection stores a real root but returns no path', async () => {
  const controller = new DistributionController({ facade: new MemoryFsFacade(), baseDir: 's', mintOperationId: () => 'op', now: () => '2026-08-04T00:00:00Z', realpath: async () => 'C:\\real-mirror' });
  const result = await controller.selectOfflineMirror({ sourceId: 'mirror', rootPath: 'C:\\chosen' });
  assert.deepEqual(result, { ok: true, source_id: 'mirror', revision: 1 });
});
test('update operations resolve a versioned catalog target without a locator in the frozen request', async () => {
  const controller = new DistributionController({ facade: new MemoryFsFacade(), baseDir: 's', mintOperationId: () => 'op', now: () => '2026-08-04T00:00:00Z', realpath: async (value) => value });
  const acquired = await controller._acquire('op', { operation: { kind: 'update', target: { publisher_id: 'acme', plugin_id: 'widget' } } }, {
    updateSourceKind: 'signed_catalog', sourceId: 'stable', acquireCatalogTarget: async (input) => {
      assert.equal(input.kind, 'signed_catalog'); assert.equal(input.sourceId, 'stable');
      return { ok: true, bytes: Buffer.from('package'), target_path_digest: 'a'.repeat(64), tuf_root_digest: 'b'.repeat(64) };
    },
  }, new AbortController().signal);
  assert.equal(acquired.ok, true); assert.deepEqual(acquired.sourceIdentity, { kind: 'signed_catalog', catalog_id: 'stable',
    target_path_digest: 'a'.repeat(64), tuf_root_digest: 'b'.repeat(64) });
});

test('update operations can consume the already selected local package without a path on the request', async () => {
  const controller = new DistributionController({
    facade: new MemoryFsFacade(), baseDir: 's', mintOperationId: () => 'op',
    now: () => '2026-08-04T00:00:00Z', realpath: async (value) => value,
  });
  const selected = {
    ok: true,
    bytes: Buffer.from('signed-update'),
    sourcePathDigest: 'c'.repeat(64),
  };
  const acquired = await controller._acquire('op', {
    operation: { kind: 'update', target: { publisher_id: 'acme', plugin_id: 'widget' } },
  }, {
    updateSourceKind: 'local_package',
    readLocalPackage: async () => selected,
  }, new AbortController().signal);
  assert.deepEqual(acquired, {
    ok: true,
    bytes: selected.bytes,
    sourceIdentity: { kind: 'local_package', package_path_digest: selected.sourcePathDigest },
  });
});

test('Stage 5 install, update, and exact rollback retain their audit attribution', async () => {
  const fs = new MemoryFsFacade(); const fixture = buildSignedPluginPackage({ contractVersion: 3 });
  const updateFixture = buildSignedPluginPackage({ contractVersion: 3, version: '1.1.0' });
  const locator = 'C:\\selected\\plugin.zip';
  const updateLocator = 'C:\\selected\\plugin-update.zip';
  const operationIds = ['install1', 'update1', 'rollback1'];
  const committedEvents = [];
  const controller = new DistributionController({ facade: fs, baseDir: 's', mintOperationId: () => operationIds.shift(),
    now: () => '2026-08-04T00:00:00Z', realpath: async (value) => value,
    onCommitted: (result) => committedEvents.push(result) });
  const d = (value) => value.repeat(64); const advisorySnapshot = { revision: 1, advisories: [], revoked_artifacts: [], revoked_keys: [] };
  const pending = await controller.startDistributionOperation({ operation_schema_version: 1, client_request_id: 'request_install', operation: {
    kind: 'install', source_kind: 'local_package', source_locator: locator, target: { publisher_id: 'acme-labs', plugin_id: 'widgets' } } }, {
    readLocalPackage: async () => fixture.bytes, trustRoots: fixture.trustRoots,
    publisherTrustDigest: d('1'), tufRootDigest: d('0'), advisoryDigest: d('2'), sourcePolicyDigest: d('3'), contractLockDigest: d('4'),
    advisorySnapshot, sourceTrust: { source_trust_schema_version: 1, publisher_id: 'acme-labs',
      publisher_trust_root: { status: 'established', current_key_id: fixture.keyId, established_at: '2026-08-04T00:00:00Z' },
      key_rotation_evidence: [], source: { kind: 'local_package', package_path_digest: digest(locator), sbom_exempt: false } },
    policyGrantRef: { policy_snapshot_digest: d('5'), policy_revision: 1, grant_set_digest: d('6'), network_consent_digest: d('7') },
    detached: true,
  });
  assert.equal(pending.status, 'pending');
  const result = await controller.waitForOperation(pending.operation_id);
  assert.equal(result.ok, true, result.reason); assert.equal(result.installed_but_incompatible, false);
  assert.deepEqual(committedEvents.map((event) => event.generation_id), [result.generation_id]);
  const state = await readCommittedState(fs, 's'); assert.equal(state.generation.generation_schema_version, 3);
  assert.equal(state.generation.plugins[0].effective_state, 'installed_disabled');

  const updated = await controller.startDistributionOperation({ operation_schema_version: 1, client_request_id: 'request_update', operation: {
    kind: 'update', target: { publisher_id: 'acme-labs', plugin_id: 'widgets' },
    expected_generation_id: state.generation.generation_id } }, {
    updateSourceKind: 'local_package',
    readLocalPackage: async () => ({ ok: true, bytes: updateFixture.bytes,
      sourcePathDigest: digest(updateLocator) }),
    trustRoots: updateFixture.trustRoots,
    publisherTrustDigest: d('1'), tufRootDigest: d('0'), advisoryDigest: d('2'), sourcePolicyDigest: d('3'), contractLockDigest: d('4'),
    advisorySnapshot,
    sourceTrust: { source_trust_schema_version: 1, publisher_id: 'acme-labs',
      publisher_trust_root: { status: 'established', current_key_id: updateFixture.keyId, established_at: '2026-08-04T00:00:00Z' },
      key_rotation_evidence: [], source: { kind: 'local_package', package_path_digest: digest(updateLocator), sbom_exempt: false } },
    policyGrantRef: { policy_snapshot_digest: d('5'), policy_revision: 1, grant_set_digest: d('6'), network_consent_digest: d('7') },
  });
  assert.equal(updated.ok, true, updated.reason);
  const updatedState = await readCommittedState(fs, 's');
  assert.equal(updatedState.generation.plugins[0].resolved_version, '1.1.0');

  const rolled = await controller.startDistributionOperation({ operation_schema_version: 1, client_request_id: 'request_rollback', operation: {
    kind: 'rollback', target_generation_id: state.generation.generation_id, expected_generation_id: updatedState.generation.generation_id } }, {
    validateTrust: async () => true, validatePolicy: async () => true, validateAdvisories: async () => true, validateRollbackData: async () => true,
  });
  assert.equal(rolled.ok, true, rolled.reason); assert.notEqual(rolled.generation_id, state.generation.generation_id);
  assert.deepEqual(committedEvents.map((event) => event.generation_id),
    [result.generation_id, updated.generation_id, rolled.generation_id]);
  const rolledState = await readCommittedState(fs, 's'); assert.equal(rolledState.pointer.commit_epoch, state.pointer.commit_epoch + 2);
  assert.equal(rolledState.generation.plugins[0].data_snapshot_digest, state.generation.plugins[0].data_snapshot_digest);
  const audit = await exportAuditLog(fs, 's', { now: '2026-08-04T00:00:00Z' });
  assert.equal(audit.ok, true, audit.reason);
  assert.deepEqual(audit.document.entries.map((entry) => entry.action), ['install', 'update', 'rollback']);
});

test('Stage 6 install and rollback preserve the closed V4 restricted-component graph', async () => {
  const componentBytes = Buffer.from([0, 97, 115, 109, 10, 0, 1, 0]);
  const fixture = buildSignedPluginPackage({
    contractVersion: 4,
    requestedPermissions: [],
    contributions: [{
      kind: 'restricted_compute', contribution_id: 'compute', name: 'Compute',
      content_path: 'content/compute.json', component_path: 'components/compute.wasm',
      component_bytes: componentBytes,
      content: {
        content_schema_version: 4, publisher_id: 'acme-labs', plugin_id: 'widgets',
        contribution_id: 'compute',
        payload: {
          kind: 'restricted_compute', description: 'Bounded compute',
          input_schema_json: '{"type":"object"}',
          output_schema_json: '{"type":"object"}', timeout_ms: 1000,
          capabilities: ['control.cancelled'], network_origins: [],
        },
      },
    }],
  });
  const fs = new MemoryFsFacade();
  const operationIds = ['stage6_install', 'stage6_rollback'];
  const now = '2026-08-05T00:00:00Z';
  const controller = new DistributionController({
    facade: fs, baseDir: 's', mintOperationId: () => operationIds.shift(),
    now: () => now, realpath: async (value) => value,
  });
  const d = (value) => value.repeat(64);
  const locator = 'C:\\selected\\restricted.zip';
  const installed = await controller.startDistributionOperation({
    operation_schema_version: 1, client_request_id: 'stage6_install_request',
    operation: {
      kind: 'install', source_kind: 'local_package', source_locator: locator,
      target: { publisher_id: 'acme-labs', plugin_id: 'widgets' },
    },
  }, {
    readLocalPackage: async () => fixture.bytes,
    trustRoots: fixture.trustRoots,
    publisherTrustDigest: d('1'), tufRootDigest: d('0'), advisoryDigest: d('2'),
    sourcePolicyDigest: d('3'), contractLockDigest: d('4'),
    advisorySnapshot: { revision: 1, advisories: [], revoked_artifacts: [], revoked_keys: [] },
    sourceTrust: {
      source_trust_schema_version: 1, publisher_id: 'acme-labs',
      publisher_trust_root: {
        status: 'established', current_key_id: fixture.keyId, established_at: now,
      },
      key_rotation_evidence: [],
      source: {
        kind: 'local_package', package_path_digest: digest(locator), sbom_exempt: false,
      },
    },
    policyGrantRefV4: {
      policy_snapshot_digest: d('5'), policy_revision: 1, grant_set_digest: d('6'),
      network_consent_digest: d('7'), restricted_runtime_policy_digest: d('8'),
    },
  });
  assert.equal(installed.ok, true, installed.reason);
  const state = await readCommittedState(fs, 's');
  assert.equal(state.generation.generation_schema_version, 4);
  assert.deepEqual(state.generation.plugins[0].restricted_module_digests,
    [fixture.manifest.contributions[0].component_sha256]);

  const rolled = await controller.startDistributionOperation({
    operation_schema_version: 1, client_request_id: 'stage6_rollback_request',
    operation: {
      kind: 'rollback', target_generation_id: state.generation.generation_id,
      expected_generation_id: state.generation.generation_id,
    },
  }, {
    validateTrust: async () => true, validatePolicy: async () => true,
    validateAdvisories: async () => true, validateRollbackData: async () => true,
  });
  assert.equal(rolled.ok, true, rolled.reason);
  const rolledState = await readCommittedState(fs, 's');
  assert.equal(rolledState.generation.generation_schema_version, 4);
  assert.deepEqual(rolledState.generation.plugins[0].restricted_module_digests,
    state.generation.plugins[0].restricted_module_digests);
});

test('Stage 5 install rejects a valid package acquired from a different source than its trust evidence', async () => {
  const fs = new MemoryFsFacade(); const fixture = buildSignedPluginPackage({ contractVersion: 3 }); const d = (value) => value.repeat(64);
  const controller = new DistributionController({ facade: fs, baseDir: 's', mintOperationId: () => 'source_mismatch', now: () => '2026-08-04T00:00:00Z', realpath: async (value) => value });
  const result = await controller.startDistributionOperation({ operation_schema_version: 1, client_request_id: 'source_mismatch_request', operation: {
    kind: 'install', source_kind: 'local_package', source_locator: 'C:\\selected\\actual.zip', target: { publisher_id: 'acme-labs', plugin_id: 'widgets' } } }, {
    readLocalPackage: async () => fixture.bytes, trustRoots: fixture.trustRoots,
    publisherTrustDigest: d('1'), tufRootDigest: d('0'), advisoryDigest: d('2'), sourcePolicyDigest: d('3'), contractLockDigest: d('4'),
    advisorySnapshot: { revision: 1, advisories: [], revoked_artifacts: [], revoked_keys: [] },
    sourceTrust: { source_trust_schema_version: 1, publisher_id: 'acme-labs',
      publisher_trust_root: { status: 'established', current_key_id: fixture.keyId, established_at: '2026-08-04T00:00:00Z' },
      key_rotation_evidence: [], source: { kind: 'local_package', package_path_digest: digest('C:\\selected\\different.zip'), sbom_exempt: false } },
    policyGrantRef: { policy_snapshot_digest: d('5'), policy_revision: 1, grant_set_digest: d('6'), network_consent_digest: d('7') },
  });
  assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'source_trust_invalid' });
});
test('two concurrent identical requests run one operation and the second joins it', async () => {
  const fs = new MemoryFsFacade();
  let minted = 0;
  const controller = new DistributionController({
    facade: fs, baseDir: 's', mintOperationId: () => `race${++minted}`,
    now: () => '2026-08-04T00:00:00Z', realpath: async (value) => value,
  });
  const request = { operation_schema_version: 1, client_request_id: 'race_request',
    operation: { kind: 'check', target: { publisher_id: 'acme', plugin_id: 'widget' } } };
  let checks = 0;
  const check = async () => { checks += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { ok: true, update_available: false }; };
  const [first, second] = await Promise.all([
    controller.startDistributionOperation(request, { check }),
    controller.startDistributionOperation(request, { check }),
  ]);
  assert.equal(checks, 1, 'the check must run once');
  assert.equal(first.operation_id, second.operation_id);
  assert.equal(first.status, 'checked');
  assert.equal(second.status, 'checked');
});
