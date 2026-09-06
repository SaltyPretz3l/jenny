'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMemoryFsFacade } = require('../../services/plugins/store/fs-facade');
const {
  DistributionController,
} = require('../../services/plugins/distribution/distribution-controller');
const { digest } = require('../../services/plugins/distribution/source-intake');
const {
  verifyDistributionPackage,
} = require('../../services/plugins/package/distribution-package-intake');
const {
  createPluginControlPlaneService,
} = require('../../services/plugins/plugin-control-plane-service');
const { readCommittedState } = require('../../services/plugins/lifecycle/commit-sequence');
const { readAuditLog } = require('../../services/plugins/lifecycle/audit-log');
const {
  Stage6RuntimeAuthority,
  createStage6RuntimeCoordinator,
} = require('../../services/plugins/restricted-host/stage6-runtime-authority');
const { buildSignedPluginPackage } = require('../helpers/plugins/zip-fixture-builder');

const NOW = '2026-08-05T00:00:00Z';

function restrictedFixture() {
  return buildSignedPluginPackage({
    contractVersion: 4,
    contributions: [{
      kind: 'restricted_compute', contribution_id: 'compute', name: 'Compute',
      content_path: 'content/compute.json', component_path: 'components/compute.wasm',
      component_bytes: Buffer.from([0, 97, 115, 109, 10, 0, 1, 0]),
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
}

test('signed V4 generation enables and disables through the real activation transaction', async () => {
  const facade = createMemoryFsFacade();
  const fixture = restrictedFixture();
  const locator = 'C:\\selected\\restricted.zip';
  const d = (value) => value.repeat(64);
  const policyGrantRef = {
    policy_snapshot_digest: d('5'), policy_revision: 1, grant_set_digest: d('6'),
    network_consent_digest: d('7'), restricted_runtime_policy_digest: d('8'),
  };
  const distribution = new DistributionController({
    facade, baseDir: 'store', mintOperationId: () => 'install_stage6',
    now: () => NOW, realpath: async (value) => value,
  });
  const installed = await distribution.startDistributionOperation({
    operation_schema_version: 1, client_request_id: 'install_stage6_request',
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
        status: 'established', current_key_id: fixture.keyId, established_at: NOW,
      },
      key_rotation_evidence: [],
      source: {
        kind: 'local_package', package_path_digest: digest(locator), sbom_exempt: false,
      },
    },
    policyGrantRefV4: policyGrantRef,
  });
  assert.equal(installed.ok, true, installed.reason);

  const verifyPackage = (args) => verifyDistributionPackage({
    bytes: args.bytes,
    sourceIdentity: args.packageRecord.source_identity,
    trustRoots: fixture.trustRoots,
    verificationCacheKey: args.packageRecord.verification_cache_key,
    now: args.now,
  });
  const sidecarSnapshots = [];
  const sidecarCoordinator = {
    fence: () => {}, unfence: () => {}, detach: () => {},
    getState: () => ({ runtime_status: 'ready', runtime_reason_code: 'ready' }),
    prepare: async ({ compiled }) => {
      sidecarSnapshots.push(compiled.snapshot);
      return {
        ok: true, rollback: async () => ({ ok: true }),
        reconcile: async () => ({ ok: true }), commit: async () => ({ ok: true }),
      };
    },
    reconcile: async () => ({ ok: true }),
  };
  const revoked = [];
  const authority = new Stage6RuntimeAuthority();
  authority.bindInvocationController({
    invoke: async (_descriptor, args) => ({ ok: true, value: { echoed: args } }),
    revokeGeneration: async (generationId) => { revoked.push(generationId); },
    dispose: async () => {},
  });
  const runtimeCoordinator = createStage6RuntimeCoordinator({
    runtimeCoordinator: sidecarCoordinator,
    restrictedAuthority: authority,
  });
  let operation = 0;
  const service = createPluginControlPlaneService({
    facade, baseDir: 'store', verifyPackage, runtimeCoordinator,
    now: () => NOW, featureEnabled: true,
    safeMode: { active: false, source: 'none' },
    requireConsent: async () => ({ ok: true }),
    newOperationId: () => `${++operation}_stage6`,
  });
  const target = { publisher_id: 'acme-labs', plugin_id: 'widgets' };

  const enabled = await service.enable(target);
  assert.equal(enabled.ok, true, enabled.reason);
  assert.equal(authority.snapshot().active_contributions, 1);
  assert.equal(sidecarSnapshots.at(-1).restricted_contributions.length, 1);
  assert.deepEqual(await authority.execute(
    'plugin:acme-labs:widgets:compute', { value: 21 }
  ), { ok: true, value: { echoed: { value: 21 } } });

  const disabled = await service.disable(target);
  assert.equal(disabled.ok, true, disabled.reason);
  assert.equal(authority.snapshot().active_contributions, 0);
  assert.equal(sidecarSnapshots.at(-1).restricted_contributions.length, 0);
  assert.deepEqual(revoked, ['g_install_stage6', 'gen-1_stage6']);

  const reenabled = await service.enable(target);
  assert.equal(reenabled.ok, true, reenabled.reason);
  assert.equal(authority.snapshot().active_contributions, 1);
  const quarantined = await service.quarantineRestrictedRuntime(target);
  assert.equal(quarantined.ok, true, quarantined.reason);
  assert.equal(authority.snapshot().active_contributions, 0);
  const committed = await readCommittedState(facade, 'store');
  assert.equal(committed.generation.plugins[0].effective_state, 'quarantined');
  const audit = await readAuditLog(facade, 'store');
  assert.deepEqual(audit.events.at(-1).actor, { kind: 'system', component: 'supervisor' });
  assert.deepEqual(revoked, [
    'g_install_stage6', 'gen-1_stage6', 'gen-2_stage6', 'gen-3_stage6',
  ]);
  const uninstalled = await service.uninstall(target);
  assert.equal(uninstalled.ok, true, uninstalled.reason);
  assert.equal((await readCommittedState(facade, 'store')).generation.plugins.length, 0);
  service.dispose();
  await authority.dispose();
});
