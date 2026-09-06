'use strict';

const crypto = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../services/plugins/store/fs-facade');
const {
  createPluginControlPlaneService,
} = require('../../services/plugins/plugin-control-plane-service');
const {
  OFFICIAL_CURRENT_KEY_ID,
  OFFICIAL_PUBLISHER_ID,
} = require('../../services/plugins/runtime/declarative-compiler');

const NOW = '2026-07-31T00:00:00Z';
const SAFE_MODE_OFF = Object.freeze({ active: false, source: 'none' });

function createOfficialSkillFixture(pluginId = 'starter', contractVersion = 1) {
  const contributionId = `skill-${pluginId}`;
  const bytes = Buffer.from(`signed first-party archive fixture:${pluginId}`);
  const archiveDigest = crypto.createHash('sha256').update(bytes).digest('hex');
  const contentJson = JSON.stringify({
    content_schema_version: contractVersion,
    publisher_id: OFFICIAL_PUBLISHER_ID,
    plugin_id: pluginId,
    contribution_id: contributionId,
    payload: { kind: 'skill', instructions: 'Use the verified overlay verbatim.' },
  });
  const contentDigest = crypto.createHash('sha256').update(contentJson).digest('hex');
  const contribution = {
    kind: 'skill',
    contribution_id: contributionId,
    content_sha256: contentDigest,
  };
  const record = {
    package_record_schema_version: 1,
    publisher_id: OFFICIAL_PUBLISHER_ID,
    plugin_id: pluginId,
    content_digest: archiveDigest,
    version_axes: {
      package_semver: '1.0.0',
      manifest_schema_version: contractVersion,
      contribution_contract_version: contractVersion,
      capability_abi_version: 1,
      data_schema_version: 1,
    },
    canonical_metadata_digest: 'b'.repeat(64),
    signature_bundle_state: {
      state: 'verified',
      publisher_id: OFFICIAL_PUBLISHER_ID,
      signing_key_id: OFFICIAL_CURRENT_KEY_ID,
      signature_algorithm: 'ed25519',
    },
    source_identity: { kind: 'local_package', package_path_digest: 'c'.repeat(64) },
    size_evidence: {
      archive_bytes: bytes.length,
      entry_count: 3,
      uncompressed_bytes: bytes.length,
    },
    risk_flags: [],
    created_at: NOW,
  };
  const verdict = {
    ok: true,
    publisher_id: OFFICIAL_PUBLISHER_ID,
    plugin_id: pluginId,
    display_name: 'Jenny Starter',
    version: '1.0.0',
    publisher_key_id: OFFICIAL_CURRENT_KEY_ID,
    archive_digest: archiveDigest,
    descriptor: { contributions: [contribution] },
    manifest: {
      manifest_schema_version: contractVersion,
      requested_permissions: [],
      contributions: [contribution],
    },
    declarative_contents: [JSON.parse(contentJson)],
    declarative_content_texts: [{
      publisher_id: OFFICIAL_PUBLISHER_ID,
      plugin_id: pluginId,
      contribution_id: contributionId,
      kind: 'skill',
      content_digest: contentDigest,
      content_json: contentJson,
    }],
    package_record: record,
  };
  return { bytes, verdict };
}

function createRuntimeCoordinator() {
  return {
    fence: () => {},
    unfence: () => {},
    getState: () => ({ runtime_status: 'ready', runtime_reason_code: 'ready' }),
    prepare: async () => ({
      ok: true,
      rollback: async () => ({ ok: true }),
      reconcile: async () => ({ ok: true }),
      commit: async () => ({ ok: true }),
    }),
    reconcile: async () => ({ ok: true }),
    detach: () => {},
  };
}

test('managed privileged denial still permits ordinary V2 declarative activation', async () => {
  const fixture = createOfficialSkillFixture('stage4b-service', 2);
  let operationIndex = 0;
  const service = createPluginControlPlaneService({
    facade: createMemoryFsFacade(),
    baseDir: '',
    now: () => NOW,
    featureEnabled: true,
    safeMode: SAFE_MODE_OFF,
    verifyPackage: async () => fixture.verdict,
    readPackageBytes: async () => ({
      ok: true,
      bytes: fixture.bytes,
      sourcePathDigest: fixture.verdict.package_record.source_identity.package_path_digest,
    }),
    runtimeCoordinator: createRuntimeCoordinator(),
    managedPolicy: {
      initialize: async () => ({ ok: true }),
      status: () => ({ status: 'active', reason: 'managed_policy_privileged_denied',
        privileged_execution: 'deny', installation: 'allow_inactive',
        allowed_source_kinds: ['local_package'], allowed_publishers: [],
        managed_source_fingerprints: [], require_sbom: false,
        require_build_provenance: false }),
      capture: () => ({ revision: 1, policy_digest: 'd'.repeat(64) }),
      isCurrent: (token) => token?.revision === 1,
      guard: () => ({ ok: false, reason: 'managed_policy_privileged_denied' }),
      policyGrantRef: (reference) => ({ ...reference, policy_revision: 1,
        policy_snapshot_digest: 'd'.repeat(64) }),
      withCurrentPolicy: (_token, operation) => operation(),
    },
    newOperationId: () => `op-v2-${++operationIndex}`,
  });

  assert.equal((await service.installLocalPackage({})).ok, true);
  assert.equal((await service.enable({
    publisher_id: OFFICIAL_PUBLISHER_ID,
    plugin_id: 'stage4b-service',
  })).ok, true);
  const state = await service.getState();
  assert.equal(state.plugins[0].effective_state, 'active');
  assert.equal(state.plugins[0].contributions[0].effective_enabled, true);
  service.dispose();
});

test('eligible first-party skill package enables, disables, and actively uninstalls', async () => {
  const fixture = createOfficialSkillFixture();
  const events = [];
  const hookEvents = [];
  let runtimeStatus = { runtime_status: 'inactive', runtime_reason_code: 'not_initialized' };
  const runtimeCoordinator = {
    fence: (reason) => {
      events.push(`fence:${reason}`);
      runtimeStatus = { runtime_status: 'fenced', runtime_reason_code: reason };
    },
    unfence: () => {
      events.push('unfence');
      runtimeStatus = { runtime_status: 'ready', runtime_reason_code: 'ready' };
    },
    getState: () => runtimeStatus,
    prepare: async ({ compiled }) => ({
      ok: true,
      attestation: {
        participant_kind: 'sidecar',
        registry_revision: compiled.snapshot.registry_revision,
      },
      rollback: async () => ({ ok: true }),
      reconcile: async () => ({ ok: true }),
      commit: async () => ({ ok: true }),
    }),
    reconcile: async () => ({ ok: true }),
    detach: () => {},
  };
  let operationIndex = 0;
  const service = createPluginControlPlaneService({
    facade: createMemoryFsFacade(),
    baseDir: '',
    now: () => NOW,
    featureEnabled: true,
    safeMode: SAFE_MODE_OFF,
    verifyPackage: async () => fixture.verdict,
    readPackageBytes: async () => ({
      ok: true,
      bytes: fixture.bytes,
      sourcePathDigest: fixture.verdict.package_record.source_identity.package_path_digest,
    }),
    runtimeCoordinator,
    privilegedRuntime: {
      enqueueHook: async (event) => {
        hookEvents.push(event);
        return { ok: true };
      },
    },
    newOperationId: () => `op-${++operationIndex}`,
  });

  assert.equal((await service.installLocalPackage({})).ok, true);
  assert.equal((await service.getState()).plugins[0].activation_reason_code, 'eligible');

  const rejected = await service.enable({
    publisherId: OFFICIAL_PUBLISHER_ID,
    plugin_id: 'starter',
  });
  assert.equal(rejected.reason, 'activation_payload_field_not_permitted');
  assert.equal((await service.enable({
    publisher_id: OFFICIAL_PUBLISHER_ID,
    plugin_id: 'starter',
  })).ok, true);
  let state = await service.getState();
  assert.equal(state.plugins[0].effective_state, 'active');
  assert.equal(state.plugins[0].activation_reason_code, 'already_active');

  assert.equal((await service.disable({
    publisher_id: OFFICIAL_PUBLISHER_ID,
    plugin_id: 'starter',
  })).ok, true);
  state = await service.getState();
  assert.equal(state.plugins[0].effective_state, 'installed_disabled');
  assert.equal(state.plugins[0].activation_reason_code, 'eligible');

  assert.equal((await service.enable({
    publisher_id: OFFICIAL_PUBLISHER_ID,
    plugin_id: 'starter',
  })).ok, true);
  assert.equal((await service.uninstall({
    publisher_id: OFFICIAL_PUBLISHER_ID,
    plugin_id: 'starter',
  })).ok, true);
  assert.equal((await service.getState()).installed_count, 0);
  assert.deepEqual(events, [
    'fence:enable', 'unfence', 'fence:disable', 'unfence',
    'fence:enable', 'unfence', 'fence:uninstall', 'unfence',
  ]);
  assert.deepEqual(hookEvents.map((event) => event.event), [
    'plugin.updated', 'plugin.enabled', 'plugin.disabled',
    'plugin.enabled', 'plugin.uninstalled',
  ]);
  assert.equal(hookEvents.every((event) => /^[a-f0-9]{64}$/.test(event.event_id)), true);
});

test('concurrent activations serialize before authority capture and preserve both updates', async () => {
  const fixtures = [createOfficialSkillFixture('alpha'), createOfficialSkillFixture('beta')];
  const byDigest = new Map(fixtures.map((fixture) => [fixture.verdict.archive_digest, fixture.verdict]));
  const sources = fixtures.slice();
  let releaseFirstPrepare;
  let markFirstPrepare;
  const firstPrepareStarted = new Promise((resolve) => { markFirstPrepare = resolve; });
  let prepareCalls = 0;
  const preparedContributionCounts = [];
  const runtimeCoordinator = {
    fence: () => {},
    unfence: () => {},
    getState: () => ({ runtime_status: 'ready', runtime_reason_code: 'ready' }),
    prepare: async ({ compiled }) => {
      prepareCalls += 1;
      preparedContributionCounts.push(compiled.snapshot.declarative_content.skill_scopes.length);
      if (prepareCalls === 1) {
        markFirstPrepare();
        await new Promise((resolve) => { releaseFirstPrepare = resolve; });
      }
      return {
        ok: true,
        rollback: async () => ({ ok: true }),
        reconcile: async () => ({ ok: true }),
        commit: async () => ({ ok: true }),
      };
    },
    reconcile: async () => ({ ok: true }),
    detach: () => {},
  };
  let operationIndex = 0;
  const service = createPluginControlPlaneService({
    facade: createMemoryFsFacade(),
    baseDir: '',
    now: () => NOW,
    featureEnabled: true,
    safeMode: SAFE_MODE_OFF,
    verifyPackage: async ({ bytes }) => byDigest.get(crypto.createHash('sha256').update(bytes).digest('hex')),
    readPackageBytes: async () => {
      const fixture = sources.shift();
      return {
        ok: true,
        bytes: fixture.bytes,
        sourcePathDigest: fixture.verdict.package_record.source_identity.package_path_digest,
      };
    },
    runtimeCoordinator,
    newOperationId: () => `op-concurrent-${++operationIndex}`,
  });

  assert.equal((await service.installLocalPackage({})).ok, true);
  assert.equal((await service.installLocalPackage({})).ok, true);
  const alpha = service.enable({ publisher_id: OFFICIAL_PUBLISHER_ID, plugin_id: 'alpha' });
  await firstPrepareStarted;
  const beta = service.enable({ publisher_id: OFFICIAL_PUBLISHER_ID, plugin_id: 'beta' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepareCalls, 1, 'the second mutation must not capture a stale authority snapshot');
  releaseFirstPrepare();
  assert.equal((await alpha).ok, true);
  assert.equal((await beta).ok, true);

  const state = await service.getState();
  assert.deepEqual(state.plugins.map((entry) => [entry.plugin_id, entry.effective_state]), [
    ['alpha', 'active'],
    ['beta', 'active'],
  ]);
  assert.deepEqual(preparedContributionCounts, [1, 2]);
  service.dispose();
});
