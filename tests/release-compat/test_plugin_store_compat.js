'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createPluginControlPlaneService } = require('../../services/plugins/plugin-control-plane-service');
const { createNodeFsFacade } = require('../../services/plugins/store/node-fs-facade');
const { putContent } = require('../../services/plugins/store/content-store');
const { writePackageRecord } = require('../../services/plugins/store/package-record-store');
const { buildGenerationRecord, readGeneration } = require('../../services/plugins/store/generation-store');
const {
  buildPointer,
  POINTER_FILE,
  PRIOR_POINTER_FILE,
} = require('../../services/plugins/store/active-pointer');
const { OFFICIAL_CURRENT_KEY_ID } = require('../../services/plugins/runtime/declarative-compiler');
const { DistributionController } = require('../../services/plugins/distribution/distribution-controller');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('../helpers/resource-cleanup');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures');
const NOW = '2026-08-02T01:00:00Z';

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function loadFixture(fixtureDir) {
  const targetRoot = createTrackedTempDir(`jenny-plugin-store-compat-${fixtureDir}-`);
  fs.cpSync(path.join(FIXTURE_ROOT, fixtureDir), targetRoot, { recursive: true });
  return targetRoot;
}

function snapshotTree(rootDir) {
  const files = new Map();
  function visit(relativeDir) {
    const absoluteDir = path.join(rootDir, relativeDir);
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else files.set(relativePath.replaceAll('\\', '/'), fs.readFileSync(path.join(rootDir, relativePath)).toString('hex'));
    }
  }
  visit('');
  return files;
}

function createService(rootDir, counters = { source: 0, verifier: 0 }, overrides = {}) {
  return {
    counters,
    service: createPluginControlPlaneService({
      facade: createNodeFsFacade({ rootDir }),
      baseDir: '',
      featureEnabled: true,
      now: () => NOW,
      readPackageBytes: async () => {
        counters.source += 1;
        return { ok: false, reason: 'must_not_read_package' };
      },
      verifyPackage: async () => {
        counters.verifier += 1;
        return { ok: false, reason: 'must_not_verify_package' };
      },
      newOperationId: () => 'release-compat-operation',
      ...overrides,
    }),
  };
}

async function assertReadOnlyAndMutationBlocked(rootDir, expectedReason, overrides = {}) {
  const before = snapshotTree(rootDir);
  const { service, counters } = createService(rootDir, undefined, overrides);
  const state = await service.getState();
  assert.equal(state.ok, true);
  assert.equal(state.stage, 8);
  assert.equal(state.read_only, true);
  assert.equal(state.store_writable, false);
  assert.equal(state.incompatibility.reason, expectedReason);

  const install = await service.installLocalPackage({});
  assert.equal(install.ok, false);
  assert.equal(install.reason, 'plugin_store_read_only');
  const uninstall = await service.uninstall({
    publisher_id: 'jenny-official',
    plugin_id: 'release-fixture',
  });
  assert.equal(uninstall.ok, false);
  assert.equal(uninstall.reason, 'plugin_store_read_only');
  assert.deepEqual(counters, { source: 0, verifier: 0 });
  service.dispose();
  assert.deepEqual(snapshotTree(rootDir), before);
}

test('release-compat: current plugin store round-trips byte-identically', async () => {
  const rootDir = loadFixture('plugin-store-v1-current');
  const before = snapshotTree(rootDir);
  const { service } = createService(rootDir);

  const state = await service.getState();
  assert.equal(state.ok, true);
  assert.equal(state.read_only, false);
  assert.equal(state.store_writable, true);
  assert.equal(state.installed_count, 1);
  assert.deepEqual(state.plugins[0], {
    publisher_id: 'jenny-official',
    plugin_id: 'release-fixture',
    effective_state: 'installed_disabled',
    desired_state: 'installed_disabled',
    display_name: 'Release Fixture',
    resolved_version: '1.0.0',
    source_kind: '',
    generation_id: 'gen-release-v1',
    contributions: [],
    activation_eligible: false,
    activation_reason_code: 'package_record_unavailable',
    contribution_kinds: [],
  });
  service.dispose();

  assert.deepEqual(snapshotTree(rootDir), before);
});

test('release-compat: pre-W11 receipts are preserved and fail closed without inferred attribution', async () => {
  const rootDir = loadFixture('plugin-store-v1-current');
  const before = snapshotTree(rootDir);
  const { service } = createService(rootDir);

  const state = await service.getState();
  assert.equal(state.ok, true);
  assert.equal(state.read_only, false);
  assert.equal(state.store_writable, true);

  for (const operationId of ['legacy-pending', 'legacy-terminal']) {
    const status = await service.getOperation({ operation_id: operationId });
    assert.equal(status.ok, false);
    assert.equal(status.reason, 'operation_receipt_corrupted');
  }
  service.dispose();

  assert.deepEqual(snapshotTree(rootDir), before);
});

test('release-compat: current V2 generation loads without startup rewriting', async () => {
  const rootDir = loadFixture('plugin-store-v2-stage4b');
  const before = snapshotTree(rootDir);
  const { service } = createService(rootDir);
  const state = await service.getState();
  assert.equal(state.read_only, false);
  assert.equal(state.store_writable, true);
  assert.equal(state.plugins[0].generation_id, 'gen-stage4b');
  assert.deepEqual(state.plugins[0].contributions.map((item) => ({
    id: item.contribution_id, desired: item.desired_enabled,
    effective: item.effective_enabled, blocked: item.blocked_reason,
  })), [
    { id: 'mcp-main', desired: false, effective: false, blocked: 'stage_forbidden' },
    { id: 'theme-main', desired: true, effective: true, blocked: 'none' },
  ]);
  service.dispose();
  assert.deepEqual(snapshotTree(rootDir), before);
});

test('release-compat: current V3 Stage 5 generation is readable without rewriting', async () => {
  const rootDir = loadFixture('plugin-store-v3-stage5');
  const before = snapshotTree(rootDir);
  const read = await readGeneration(createNodeFsFacade({ rootDir }), '', 'gen-stage5');
  assert.equal(read.ok, true);
  assert.equal(read.record.generation_schema_version, 3);
  assert.equal(read.record.plugins[0].effective_state, 'installed_disabled');
  const controller = new DistributionController({ facade: createNodeFsFacade({ rootDir }), baseDir: '',
    mintOperationId: () => 'unused', now: () => NOW, realpath: fs.promises.realpath });
  const distribution = await controller.getDistributionState();
  assert.equal(distribution.ok, true); assert.equal(distribution.persisted, false);
  assert.deepEqual(snapshotTree(rootDir), before);
});

test('release-compat: current V4 Stage 6 generation is readable without rewriting', async () => {
  const rootDir = loadFixture('plugin-store-v4-stage6');
  const before = snapshotTree(rootDir);
  const read = await readGeneration(createNodeFsFacade({ rootDir }), '', 'gen-stage6');
  assert.equal(read.ok, true);
  assert.equal(read.record.generation_schema_version, 4);
  assert.deepEqual(read.record.plugins, []);
  assert.deepEqual(snapshotTree(rootDir), before);
});

test('release-compat: current V5 Stage 7 generation is readable without rewriting', async () => {
  const rootDir = loadFixture('plugin-store-v5-stage7');
  const before = snapshotTree(rootDir);
  const read = await readGeneration(createNodeFsFacade({ rootDir }), '', 'gen-stage7');
  assert.equal(read.ok, true);
  assert.equal(read.record.generation_schema_version, 5);
  assert.deepEqual(read.record.plugins, []);
  assert.deepEqual(snapshotTree(rootDir), before);
});

test('release-compat: current V6 Stage 8 generation is readable without rewriting', async () => {
  const rootDir = loadFixture('plugin-store-v6-stage8');
  const before = snapshotTree(rootDir);
  const read = await readGeneration(createNodeFsFacade({ rootDir }), '', 'gen-stage8');
  assert.equal(read.ok, true);
  assert.equal(read.record.generation_schema_version, 6);
  assert.deepEqual(read.record.plugins, []);
  assert.deepEqual(snapshotTree(rootDir), before);
});

test('release-compat: V7 future generation schema is preserved, read-only, and unexecuted', async () => {
  const rootDir = loadFixture('plugin-store-v7-future');
  let policyInitializations = 0;
  await assertReadOnlyAndMutationBlocked(rootDir, 'generation_schema_newer', {
    managedPolicy: {
      initialize: async () => { policyInitializations += 1; return { ok: true }; },
      status: () => ({ status: 'blocked', reason: 'managed_policy_loading' }),
      guard: () => ({ ok: false, reason: 'managed_policy_loading' }),
    },
  });
  assert.equal(policyInitializations, 0);
});

test('release-compat: current V1 active state loads and rehydrates without migration', async () => {
  const rootDir = loadFixture('plugin-store-v1-stage4a-active');
  const facade = createNodeFsFacade({ rootDir });
  const bytes = Buffer.from('release package bytes');
  const stored = await putContent(facade, '', bytes);
  assert.equal(stored.digest, '578256f0db0badf7f19a0416b92e5a89d684bbe21ae44128b8f8133d76982923');
  const contentJson = JSON.stringify({
    content_schema_version: 1,
    publisher_id: 'jenny-official',
    plugin_id: 'release-fixture',
    contribution_id: 'skill-main',
    payload: { kind: 'skill', instructions: 'Release compatibility overlay.' },
  });
  const contentDigest = 'ead9166c0302cb18c06b07d722b3b2b79b3063851ea08d53ffad75ba520584e0';
  const contribution = { kind: 'skill', contribution_id: 'skill-main', content_sha256: contentDigest };
  const packageRecord = {
    package_record_schema_version: 1,
    publisher_id: 'jenny-official',
    plugin_id: 'release-fixture',
    content_digest: stored.digest,
    version_axes: {
      package_semver: '1.0.0', manifest_schema_version: 1,
      contribution_contract_version: 1, capability_abi_version: 1, data_schema_version: 1,
    },
    canonical_metadata_digest: '4'.repeat(64),
    signature_bundle_state: {
      state: 'verified', publisher_id: 'jenny-official',
      signing_key_id: OFFICIAL_CURRENT_KEY_ID, signature_algorithm: 'ed25519',
    },
    source_identity: { kind: 'local_package', package_path_digest: '5'.repeat(64) },
    size_evidence: { archive_bytes: bytes.length, entry_count: 3, uncompressed_bytes: bytes.length },
    risk_flags: [],
    created_at: NOW,
  };
  assert.equal((await writePackageRecord(facade, '', { digest: stored.digest, record: packageRecord })).ok, true);
  const verdict = {
    ok: true,
    publisher_id: 'jenny-official',
    plugin_id: 'release-fixture',
    version: '1.0.0',
    publisher_key_id: OFFICIAL_CURRENT_KEY_ID,
    archive_digest: stored.digest,
    package_record: packageRecord,
    manifest: { requested_permissions: [], contributions: [contribution] },
    declarative_content_texts: [{
      publisher_id: 'jenny-official', plugin_id: 'release-fixture',
      contribution_id: 'skill-main', kind: 'skill',
      content_digest: contentDigest, content_json: contentJson,
    }],
  };
  let runtimeState = { runtime_status: 'inactive', runtime_reason_code: 'not_initialized' };
  let applied = null;
  const runtimeCoordinator = {
    fence: () => { runtimeState = { runtime_status: 'fenced', runtime_reason_code: 'rehydration' }; },
    reconcile: async (runtime) => { applied = runtime; runtimeState = { runtime_status: 'ready', runtime_reason_code: 'ready' }; return { ok: true }; },
    unfence: () => {},
    getState: () => runtimeState,
    detach: () => {},
  };
  const counters = { source: 0, verifier: 0 };
  const before = snapshotTree(rootDir);
  const { service } = createService(rootDir, counters, {
    verifyPackage: async () => { counters.verifier += 1; return verdict; },
    runtimeCoordinator,
  });
  const state = await service.getState();
  assert.equal(state.read_only, false);
  assert.equal(state.store_writable, true);
  assert.equal(state.plugins[0].effective_state, 'active');
  assert.equal(state.plugins[0].activation_reason_code, 'already_active');
  assert.equal(state.runtime_status, 'ready');
  assert.equal(applied.snapshot.active_generation_id, 'gen-stage4a-active');
  assert.equal(applied.snapshot.declarative_content.skill_scopes.length, 1);
  assert.ok(counters.verifier >= 2, 'rehydration and advisory state both re-verify the archive');
  service.dispose();
  assert.deepEqual(snapshotTree(rootDir), before);
});

test('release-compat: pointer-loss recovery cannot republish an active V1 generation before re-verification', async () => {
  const rootDir = loadFixture('plugin-store-v1-stage4a-active');
  fs.copyFileSync(path.join(rootDir, POINTER_FILE), path.join(rootDir, PRIOR_POINTER_FILE));
  fs.rmSync(path.join(rootDir, POINTER_FILE));
  const before = snapshotTree(rootDir);
  const { service } = createService(rootDir);

  const state = await service.getState();
  assert.equal(state.ok, true);
  assert.equal(state.read_only, false);
  assert.equal(state.store_writable, false);
  assert.equal(state.pointer_status, 'missing');
  assert.equal(state.installed_count, 0);
  assert.equal(state.recovery.reason, 'candidate_reverification_failed');
  assert.equal(fs.existsSync(path.join(rootDir, POINTER_FILE)), false);
  service.dispose();
  assert.deepEqual(snapshotTree(rootDir), before);
});

test('release-compat: committed V1 transitional state remains read-only', async () => {
  const rootDir = loadFixture('plugin-store-v1-stage4a-active');
  const generation = buildGenerationRecord({
    generationId: 'gen-stage4a-transitional',
    createdAt: NOW,
    plugins: [{
      publisher_id: 'jenny-official', plugin_id: 'release-fixture', display_name: 'Release Fixture',
      resolved_version: '1.0.0', publisher_key_id: OFFICIAL_CURRENT_KEY_ID,
      artifact_digest: '5'.repeat(64), desired_state: 'active', effective_state: 'preparing', depends_on: [],
    }],
    policyGrantRef: { policy_snapshot_digest: '3'.repeat(64), policy_revision: 1, grant_set_digest: '3'.repeat(64) },
    dataSchemaRefs: [],
  });
  const generationDir = path.join(rootDir, 'generations', generation.generation_id);
  fs.mkdirSync(generationDir, { recursive: true });
  fs.writeFileSync(path.join(generationDir, 'control-plane.json'), JSON.stringify(generation, null, 2));
  const pointer = buildPointer({
    revision: 3, commitEpoch: 3, generationId: generation.generation_id,
    generationDigest: generation.graph_hash, committedAt: NOW,
  });
  fs.writeFileSync(path.join(rootDir, 'active-generation.json'), JSON.stringify(pointer, null, 2));
  await assertReadOnlyAndMutationBlocked(rootDir, 'future_stage_state_present');
});

test('release-compat: pointer loss cannot recover around a retained future generation', async () => {
  const rootDir = loadFixture('plugin-store-v7-future');
  fs.rmSync(path.join(rootDir, 'active-generation.json'));
  await assertReadOnlyAndMutationBlocked(rootDir, 'generation_schema_newer');
});
