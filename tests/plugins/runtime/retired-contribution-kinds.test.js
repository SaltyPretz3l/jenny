'use strict';

// Stage 4 plugin retirement: contribution kinds whose runtime tiers are being
// deleted must stay inert for already-installed packages, must be refused for
// new installs, and must be refused on enable, while disable and uninstall of a
// leftover package keep working.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { PLUGIN_ERROR_CODES } = require('../../../services/backend/error-codes');
const { putContent } = require('../../../services/plugins/store/content-store');
const { writePackageRecord } = require('../../../services/plugins/store/package-record-store');
const {
  OFFICIAL_PUBLISHER_ID,
  OFFICIAL_CURRENT_KEY_ID,
  compileCurrentRuntimeSnapshot,
} = require('../../../services/plugins/runtime/declarative-compiler');
const {
  RETIRED_CONTRIBUTION_KINDS,
  declaresRetiredKind,
} = require('../../../services/plugins/runtime/declarative-compiler-constants');
const {
  EMPTY_POLICY_GRANT_REF,
  createPluginControlPlaneService,
  defaultRequireConsent,
} = require('../../../services/plugins/plugin-control-plane-service');
const { installPackage } = require('../../../services/plugins/lifecycle/install-operation');
const { unmanagedPolicyGrantRef } = require('../../../services/plugins/policy-grant-ref');
const {
  createProductionDistributionContextFactory,
} = require('../../../services/plugins/distribution/production-context');
const { createSeededFacade } = require('../../helpers/plugins/memory-fs-facade');
const { verifiedPackageVerdict } = require('../../helpers/plugins/durability-scenario');

const BASE = '/plugin-store';
const NOW = '2026-10-02T00:00:00Z';
const GRAPH = 'e'.repeat(64);
const PUBLISHER = OFFICIAL_PUBLISHER_ID;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function retiredContribution(kind, id) {
  return { kind, contribution_id: id, name: id, content_sha256: 'f'.repeat(64) };
}

function skillContent(pluginId, id, kind = 'skill') {
  const text = JSON.stringify({
    content_schema_version: 1, publisher_id: PUBLISHER, plugin_id: pluginId, contribution_id: id,
    payload: kind === 'skill' ? { kind, instructions: 'Skill verbatim' } : { kind, template: 'Prompt verbatim' },
  });
  return {
    contribution: { kind, contribution_id: id, content_sha256: sha256(text) },
    text: { publisher_id: PUBLISHER, plugin_id: pluginId, contribution_id: id, kind,
      content_digest: sha256(text), content_json: text },
  };
}

async function seedPlugin(facade, verdicts, {
  pluginId, manifestVersion = 1, retired = [], live = [], permissions = [], remoteDigests,
}) {
  const bytes = Buffer.from(`archive:${pluginId}`);
  const stored = await putContent(facade, BASE, bytes);
  const entry = {
    publisher_id: PUBLISHER, plugin_id: pluginId, display_name: pluginId, resolved_version: '1.0.0',
    publisher_key_id: OFFICIAL_CURRENT_KEY_ID, artifact_digest: stored.digest,
    desired_state: 'active', effective_state: 'active', depends_on: [],
    ...(remoteDigests ? { remote_binding_digests: remoteDigests } : {}),
  };
  const record = {
    package_record_schema_version: 1, publisher_id: PUBLISHER, plugin_id: pluginId,
    content_digest: stored.digest,
    version_axes: { package_semver: '1.0.0', manifest_schema_version: manifestVersion,
      contribution_contract_version: 1, capability_abi_version: 1, data_schema_version: 1 },
    canonical_metadata_digest: 'c'.repeat(64),
    signature_bundle_state: { state: 'verified', publisher_id: PUBLISHER,
      signing_key_id: OFFICIAL_CURRENT_KEY_ID, signature_algorithm: 'ed25519' },
    source_identity: { kind: 'local_package', package_path_digest: 'd'.repeat(64) },
    size_evidence: { archive_bytes: bytes.length, entry_count: 3, uncompressed_bytes: 100 },
    risk_flags: [], created_at: NOW,
  };
  assert.equal((await writePackageRecord(facade, BASE, { digest: stored.digest, record })).ok, true);
  const built = live.map((item) => skillContent(pluginId, item.id, item.kind));
  verdicts.set(stored.digest, {
    ok: true, publisher_id: PUBLISHER, plugin_id: pluginId, version: '1.0.0',
    publisher_key_id: OFFICIAL_CURRENT_KEY_ID, archive_digest: stored.digest, package_record: record,
    manifest: {
      manifest_schema_version: manifestVersion, publisher_id: PUBLISHER, plugin_id: pluginId,
      requested_permissions: permissions,
      contributions: [...built.map((item) => item.contribution),
        ...retired.map((item) => retiredContribution(item.kind, item.id))],
    },
    declarative_contents: [], declarative_content_texts: built.map((item) => item.text),
    full_host_contents: [], restricted_component_bytes: [],
  });
  return entry;
}

async function compile(schemaVersion, seedList, extra = {}) {
  const facade = createMemoryFsFacade();
  const verdicts = new Map();
  const plugins = [];
  for (const spec of seedList) plugins.push(await seedPlugin(facade, verdicts, spec));
  const generation = { generation_schema_version: schemaVersion, generation_id: `gen-${schemaVersion}`,
    graph_hash: GRAPH, policy_grant_ref: { policy_revision: 1 }, plugins };
  const pointer = { revision: 3, commit_epoch: 4, generation_id: generation.generation_id,
    generation_digest: GRAPH };
  return compileCurrentRuntimeSnapshot({
    facade, baseDir: BASE, generation, pointer, now: NOW,
    verifyPackage: async ({ bytes }) => verdicts.get(sha256(bytes)),
    ...extra,
  });
}

const liveSkill = [{ id: 'live-skill', kind: 'skill' }, { id: 'live-prompt', kind: 'prompt' }];
const liveIds = (snapshot) => snapshot.declarative_content.map((item) => item.contribution_id).sort();

test('retired kind set is the exact frozen closure and the helper reads a manifest', () => {
  assert.deepEqual([...RETIRED_CONTRIBUTION_KINDS].sort(), [
    'command', 'engine_adapter', 'hook', 'mcp_descriptor', 'native_mcp', 'provider_descriptor',
    'restricted_compute', 'restricted_formatter', 'restricted_renderer', 'restricted_transform',
    'session_provider', 'setup_scene', 'workflow',
  ]);
  assert.equal(Object.isFrozen(RETIRED_CONTRIBUTION_KINDS), true);
  assert.equal(declaresRetiredKind({ contributions: [{ kind: 'skill' }, { kind: 'hook' }] }), true);
  assert.equal(declaresRetiredKind({ contributions: [{ kind: 'skill' }, { kind: 'panel' }] }), false);
  assert.equal(declaresRetiredKind(undefined), false);
});

test('schema 3 compile ignores mcp_descriptor and never needs the remote MCP runtime', async () => {
  const compiled = await compile(3, [{
    pluginId: 'remote-plugin', manifestVersion: 3, permissions: ['network.remote_mcp'],
    retired: [{ kind: 'mcp_descriptor', id: 'remote' }], live: liveSkill, remoteDigests: ['a'.repeat(64)],
  }]);
  assert.equal(compiled.ok, true, compiled.reason);
  assert.deepEqual(compiled.snapshot.remote_mcp_bindings, []);
  assert.deepEqual(liveIds(compiled.snapshot), ['live-prompt', 'live-skill']);
});

test('schema 4 compile emits no restricted contribution while sibling skills still compile', async () => {
  const compiled = await compile(4, [
    { pluginId: 'wasm-plugin', manifestVersion: 4, retired: [
      { kind: 'restricted_transform', id: 'xf' }, { kind: 'restricted_compute', id: 'cp' }] },
    { pluginId: 'skills-plugin', live: liveSkill },
  ]);
  assert.equal(compiled.ok, true, compiled.reason);
  assert.deepEqual(compiled.snapshot.restricted_contributions, []);
  assert.deepEqual(compiled.snapshot.remote_mcp_bindings, []);
  assert.deepEqual(liveIds(compiled.snapshot), ['live-prompt', 'live-skill']);
});

test('schema 5 compile drops provider_descriptor and setup_scene without failing the generation', async () => {
  const compiled = await compile(5, [
    { pluginId: 'provider-plugin', manifestVersion: 5, permissions: ['ui.view'], retired: [
      { kind: 'provider_descriptor', id: 'prov' }, { kind: 'setup_scene', id: 'scene' }] },
    { pluginId: 'skills-plugin', live: liveSkill },
  ]);
  assert.equal(compiled.ok, true, compiled.reason);
  assert.deepEqual(compiled.snapshot.provider_descriptors, []);
  assert.deepEqual(compiled.snapshot.view_contributions, []);
  assert.deepEqual(liveIds(compiled.snapshot), ['live-prompt', 'live-skill']);
});

test('schema 6 compile never calls compilePrivileged and keeps same-plugin skills', async () => {
  let privilegedCalls = 0;
  const compiled = await compile(6, [
    { pluginId: 'host-plugin', manifestVersion: 6, retired: [
      { kind: 'native_mcp', id: 'nm' }, { kind: 'hook', id: 'hk' },
      { kind: 'session_provider', id: 'sp' }, { kind: 'engine_adapter', id: 'ea' }] },
    { pluginId: 'mixed-plugin', manifestVersion: 6, retired: [{ kind: 'native_mcp', id: 'nm2' }],
      live: liveSkill },
  ], { compilePrivileged: async () => { privilegedCalls += 1; return { ok: true }; } });
  assert.equal(compiled.ok, true, compiled.reason);
  assert.equal(privilegedCalls, 0);
  assert.deepEqual(compiled.snapshot.native_mcp_bindings, []);
  assert.deepEqual(compiled.snapshot.hook_descriptors, []);
  assert.deepEqual(liveIds(compiled.snapshot), ['live-prompt', 'live-skill']);
  const noParticipant = await compile(6, [{ pluginId: 'host-only', manifestVersion: 6,
    retired: [{ kind: 'engine_adapter', id: 'ea' }] }]);
  assert.equal(noParticipant.ok, true, noParticipant.reason);
});

async function candidateContext() {
  const facade = await createSeededFacade();
  const create = createProductionDistributionContextFactory({
    facade,
    trustRootsProvider: async () => ({ ok: true, value: {
      trust_roots_schema_version: 1, revision: 1, publishers: [] } }),
    contractLockDigest: 'b'.repeat(64),
  });
  const built = await create({ operation: { kind: 'install', source_kind: 'local_package',
    source_locator: 'selected.zip', target: { publisher_id: 'acme', plugin_id: 'widget' } } });
  assert.equal(built.ok, true, built.reason);
  return built.value;
}

test('install candidate declaring a retired kind is refused; skill and prompt packages pass', async () => {
  const validate = (await candidateContext()).validateManagedCandidate;
  const sourceIdentity = { kind: 'local_package', package_path_digest: 'c'.repeat(64) };
  for (const kind of RETIRED_CONTRIBUTION_KINDS) {
    const verified = { publisher_id: 'acme', manifest: { contributions: [
      { kind: 'skill' }, { kind }] } };
    assert.deepEqual(validate({ sourceIdentity, verified }),
      { ok: false, reason: 'contribution_kind_retired' }, kind);
  }
  assert.equal(validate({ sourceIdentity, verified: { publisher_id: 'acme', manifest: {
    contributions: [{ kind: 'skill' }, { kind: 'prompt' }, { kind: 'panel' }] } } }).ok, true);
});

test('rollback policy revalidation does not trip over an installed retired-kind package', async () => {
  const facade = await createSeededFacade();
  const bytes = Buffer.from('historical retired package');
  const verdict = verifiedPackageVerdict({ packageBytes: bytes, publisherId: 'acme',
    pluginId: 'widget' });
  verdict.archive_digest = verdict.package_record.content_digest;
  verdict.manifest = { contributions: [{ kind: 'mcp_descriptor' }] };
  const stored = await putContent(facade, '', bytes);
  assert.equal((await writePackageRecord(facade, '', {
    digest: stored.digest, record: verdict.package_record })).ok, true);
  const create = createProductionDistributionContextFactory({
    facade,
    trustRootsProvider: async () => ({ ok: true, value: {
      trust_roots_schema_version: 1, revision: 1, publishers: [] } }),
    verifyPackage: async () => verdict,
    contractLockDigest: 'b'.repeat(64),
  });
  const built = await create({ operation: { kind: 'rollback' } });
  assert.equal(built.ok, true, built.reason);
  assert.equal(await built.value.validatePolicy({ plugins: [{
    publisher_id: 'acme', plugin_id: 'widget', display_name: 'Plugin widget',
    resolved_version: '1.0.0', publisher_key_id: verdict.publisher_key_id,
    artifact_digest: stored.digest, desired_state: 'installed_disabled',
    effective_state: 'installed_disabled', depends_on: [] }] }), true);
});

// A leftover package is one installed before stage 4 with a retired `command`
// contribution. The service now refuses that install, so the leftover is seeded
// through the lifecycle install operation directly (as stage 3 installed it),
// enabled while the verifier reports the skill-only form, then the verifier is
// swapped back to the full retired form.
function leftoverService() {
  const bytes = Buffer.from('signed first-party archive fixture:leftover');
  const digest = sha256(bytes);
  const skill = skillContent('leftover', 'skill-leftover');
  const base = {
    ok: true, publisher_id: PUBLISHER, plugin_id: 'leftover', display_name: 'Leftover',
    version: '1.0.0', publisher_key_id: OFFICIAL_CURRENT_KEY_ID, archive_digest: digest,
    package_record: {
      package_record_schema_version: 1, publisher_id: PUBLISHER, plugin_id: 'leftover',
      content_digest: digest,
      version_axes: { package_semver: '1.0.0', manifest_schema_version: 2,
        contribution_contract_version: 2, capability_abi_version: 1, data_schema_version: 1 },
      canonical_metadata_digest: 'b'.repeat(64),
      signature_bundle_state: { state: 'verified', publisher_id: PUBLISHER,
        signing_key_id: OFFICIAL_CURRENT_KEY_ID, signature_algorithm: 'ed25519' },
      source_identity: { kind: 'local_package', package_path_digest: 'c'.repeat(64) },
      size_evidence: { archive_bytes: bytes.length, entry_count: 3, uncompressed_bytes: bytes.length },
      risk_flags: [], created_at: NOW },
    declarative_contents: [JSON.parse(skill.text.content_json)],
    declarative_content_texts: [skill.text],
  };
  const withKinds = (contributions) => ({ ...base,
    manifest: { manifest_schema_version: 2, requested_permissions: [], contributions } });
  const clean = withKinds([skill.contribution]);
  const retired = withKinds([skill.contribution, retiredContribution('command', 'cmd')]);
  const ref = { current: retired };
  let operationIndex = 0;
  const facade = createMemoryFsFacade();
  const service = createPluginControlPlaneService({
    facade, baseDir: '', now: () => NOW, featureEnabled: true,
    safeMode: { active: false, source: 'none' },
    verifyPackage: async () => ref.current,
    readPackageBytes: async () => ({ ok: true, bytes,
      sourcePathDigest: base.package_record.source_identity.package_path_digest }),
    runtimeCoordinator: {
      fence: () => {}, unfence: () => {},
      getState: () => ({ runtime_status: 'ready', runtime_reason_code: 'ready' }),
      prepare: async () => ({ ok: true, rollback: async () => ({ ok: true }),
        reconcile: async () => ({ ok: true }), commit: async () => ({ ok: true }) }),
      reconcile: async () => ({ ok: true }), detach: () => {},
    },
    newOperationId: () => `op-retired-${++operationIndex}`,
  });
  const identity = { publisher_id: PUBLISHER, plugin_id: 'leftover' };
  const seedLeftover = () => installPackage(facade, '', {
    packageBytes: bytes,
    sourcePathDigest: base.package_record.source_identity.package_path_digest,
    verifyPackage: async () => retired,
    requireConsent: defaultRequireConsent,
    newOperationId: () => 'op-retired-seed',
    clientRequestId: 'seed-leftover',
    safeMode: { active: false, source: 'none' },
    now: NOW,
    generationId: 'gen-op-retired-seed',
    policyGrantRef: unmanagedPolicyGrantRef(EMPTY_POLICY_GRANT_REF),
    dataSchemaRefs: [],
  });
  return { service, ref, clean, retired, identity, seedLeftover };
}

async function activeLeftover() {
  const harness = leftoverService();
  const seeded = await harness.seedLeftover();
  assert.equal(seeded.ok, true, seeded.reason);
  harness.ref.current = harness.clean;
  assert.equal((await harness.service.enable(harness.identity)).ok, true);
  harness.ref.current = harness.retired;
  return harness;
}

test('a leftover package with a retired kind lists inert, disables, then refuses re-enable', async () => {
  const { service, identity, ref, clean } = await activeLeftover();
  const listed = (await service.getState()).plugins[0];
  assert.equal(listed.effective_state, 'active');
  const command = listed.contributions.find((item) => item.kind === 'command');
  assert.equal(command.effective_enabled, false);
  assert.equal(listed.contributions.find((item) => item.kind === 'skill').effective_enabled, true);
  assert.equal((await service.disable(identity)).ok, true);
  const refused = await service.enable(identity);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
  assert.equal(refused.reason, 'contribution_kind_retired');
  const disabled = (await service.getState()).plugins[0];
  assert.equal(disabled.effective_state, 'installed_disabled');
  assert.equal(disabled.activation_eligible, false);
  assert.equal(disabled.activation_reason_code, 'mixed_or_unsupported_contributions');
  ref.current = clean;
  assert.equal((await service.enable(identity)).ok, true);
  service.dispose();
});

test('a leftover package with a retired kind can be uninstalled while active', async () => {
  const { service, identity } = await activeLeftover();
  const result = await service.uninstall(identity);
  assert.equal(result.ok, true, result.reason);
  assert.equal((await service.getState()).plugins.length, 0);
  service.dispose();
});

test('a local install of a package declaring a retired kind is refused before any write', async () => {
  const harness = leftoverService();
  const result = await harness.service.installLocalPackage({});
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
  assert.equal(result.reason, 'contribution_kind_retired');
  assert.equal((await harness.service.getState({})).plugins.length, 0);
});
