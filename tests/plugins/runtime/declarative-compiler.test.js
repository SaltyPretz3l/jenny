'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { putContent } = require('../../../services/plugins/store/content-store');
const { writePackageRecord } = require('../../../services/plugins/store/package-record-store');
const {
  OFFICIAL_PUBLISHER_ID,
  OFFICIAL_CURRENT_KEY_ID,
  ELIGIBILITY_REASON_CODES,
  evaluateActivationEligibility,
  dedupeWorkflowToolBindings,
  compileRuntimeSnapshot,
} = require('../../../services/plugins/runtime/declarative-compiler');

const BASE = '/plugin-store';
const NOW = '2026-08-03T00:00:00Z';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function entry(overrides = {}) {
  return {
    publisher_id: OFFICIAL_PUBLISHER_ID,
    plugin_id: 'starter',
    display_name: 'Starter',
    resolved_version: '1.0.0',
    publisher_key_id: OFFICIAL_CURRENT_KEY_ID,
    artifact_digest: 'a'.repeat(64),
    desired_state: 'active',
    effective_state: 'installed_disabled',
    depends_on: [],
    ...overrides,
  };
}

function verdict(pluginEntry, contributions, contentTexts) {
  return {
    ok: true,
    publisher_id: pluginEntry.publisher_id,
    plugin_id: pluginEntry.plugin_id,
    version: pluginEntry.resolved_version,
    publisher_key_id: pluginEntry.publisher_key_id,
    archive_digest: pluginEntry.artifact_digest,
    package_record: { content_digest: pluginEntry.artifact_digest },
    manifest: { requested_permissions: [], contributions },
    declarative_content_texts: contentTexts,
  };
}

test('eligibility is wholly first-party, permissionless, dependency-free skill/prompt only', () => {
  const subject = entry();
  const contribution = { kind: 'skill', contribution_id: 'main' };
  const valid = verdict(subject, [contribution], []);
  assert.deepEqual(evaluateActivationEligibility({ pluginEntry: subject, verdict: valid }), {
    activation_eligible: true,
    activation_reason_code: 'eligible',
    contribution_kinds: ['skill'],
  });
  assert.equal(evaluateActivationEligibility({ pluginEntry: { ...subject, effective_state: 'active' }, verdict: valid }).activation_reason_code, 'already_active');
  assert.equal(evaluateActivationEligibility({ pluginEntry: subject, verdict: valid, safeMode: true }).activation_reason_code, 'safe_mode');
  assert.equal(evaluateActivationEligibility({ pluginEntry: subject, verdict: valid, storeReadOnly: true }).activation_reason_code, 'store_read_only');
  assert.equal(evaluateActivationEligibility({ pluginEntry: { ...subject, publisher_id: 'other' }, verdict: { ...valid, publisher_id: 'other' } }).activation_reason_code, 'not_first_party');
  assert.equal(evaluateActivationEligibility({ pluginEntry: { ...subject, publisher_key_id: 'f'.repeat(64) }, verdict: { ...valid, publisher_key_id: 'f'.repeat(64) } }).activation_reason_code, 'publisher_key_not_current');
  assert.equal(evaluateActivationEligibility({ pluginEntry: subject, verdict: { ...valid, manifest: { ...valid.manifest, requested_permissions: ['chat.read'] } } }).activation_reason_code, 'permissions_requested');
  assert.equal(evaluateActivationEligibility({ pluginEntry: { ...subject, depends_on: [{ publisher_id: 'a', plugin_id: 'b' }] }, verdict: valid }).activation_reason_code, 'dependencies_not_supported');
  assert.equal(evaluateActivationEligibility({ pluginEntry: subject, verdict: { ...valid, manifest: { requested_permissions: [], contributions: [] } } }).activation_reason_code, 'no_supported_contributions');
  assert.equal(evaluateActivationEligibility({ pluginEntry: subject, verdict: { ...valid, manifest: { requested_permissions: [], contributions: [contribution, { kind: 'theme', contribution_id: 'later' }] } } }).activation_reason_code, 'mixed_or_unsupported_contributions');
  assert.equal(evaluateActivationEligibility({ pluginEntry: subject, verdict: null }).activation_reason_code, 'package_record_unavailable');
  assert.equal(new Set(ELIGIBILITY_REASON_CODES).size, 11);
});

test('workflow binding deduplication retains same-named nodes from distinct plugin authorities', () => {
  const binding = (pluginId) => ({
    publisher_id: 'jenny-official', plugin_id: pluginId, workflow_id: 'workflow-main',
    node_id: 'read', tool_id: 'read_file', manifest_version: 2, descriptor_sha256: 'a'.repeat(64),
  });
  assert.deepEqual(dedupeWorkflowToolBindings([
    binding('zeta'), binding('alpha'), binding('alpha'),
  ]).map((item) => item.plugin_id), ['alpha', 'zeta']);
});

test('compiler re-verifies stored bytes and emits deterministic skill/prompt-only snapshot', async () => {
  const facade = createMemoryFsFacade();
  const stored = await putContent(facade, BASE, Buffer.from('signed archive bytes'));
  const pluginEntry = entry({ artifact_digest: stored.digest, effective_state: 'active' });
  const record = {
    package_record_schema_version: 1,
    publisher_id: pluginEntry.publisher_id,
    plugin_id: pluginEntry.plugin_id,
    content_digest: stored.digest,
    version_axes: { package_semver: '1.0.0', manifest_schema_version: 1, contribution_contract_version: 1, capability_abi_version: 1, data_schema_version: 1 },
    canonical_metadata_digest: 'c'.repeat(64),
    signature_bundle_state: { state: 'verified', publisher_id: pluginEntry.publisher_id, signing_key_id: pluginEntry.publisher_key_id, signature_algorithm: 'ed25519' },
    source_identity: { kind: 'local_package', package_path_digest: 'd'.repeat(64) },
    size_evidence: { archive_bytes: 20, entry_count: 3, uncompressed_bytes: 100 },
    risk_flags: [],
    created_at: NOW,
  };
  assert.equal((await writePackageRecord(facade, BASE, { digest: stored.digest, record })).ok, true);

  const promptText = JSON.stringify({ content_schema_version: 1, publisher_id: pluginEntry.publisher_id, plugin_id: pluginEntry.plugin_id, contribution_id: 'z-prompt', payload: { kind: 'prompt', template: 'Prompt verbatim' } }, null, 2);
  const skillText = JSON.stringify({ content_schema_version: 1, publisher_id: pluginEntry.publisher_id, plugin_id: pluginEntry.plugin_id, contribution_id: 'a-skill', payload: { kind: 'skill', instructions: 'Skill verbatim' } });
  const contributions = [
    { kind: 'prompt', contribution_id: 'z-prompt', content_sha256: sha256(promptText) },
    { kind: 'skill', contribution_id: 'a-skill', content_sha256: sha256(skillText) },
  ];
  const packageVerdict = verdict(pluginEntry, contributions, [
    { publisher_id: pluginEntry.publisher_id, plugin_id: pluginEntry.plugin_id, contribution_id: 'z-prompt', kind: 'prompt', content_digest: sha256(promptText), content_json: promptText },
    { publisher_id: pluginEntry.publisher_id, plugin_id: pluginEntry.plugin_id, contribution_id: 'a-skill', kind: 'skill', content_digest: sha256(skillText), content_json: skillText },
  ]);
  packageVerdict.package_record = record;
  const graphHash = 'e'.repeat(64);
  const compiled = await compileRuntimeSnapshot({
    facade,
    baseDir: BASE,
    generation: { generation_id: 'gen-stage4a', graph_hash: graphHash, plugins: [pluginEntry] },
    pointer: { revision: 7, commit_epoch: 11, generation_id: 'gen-stage4a', generation_digest: graphHash },
    verifyPackage: async ({ sourcePathDigest }) => {
      assert.equal(sourcePathDigest, record.source_identity.package_path_digest);
      return packageVerdict;
    },
    now: NOW,
  });
  assert.equal(compiled.ok, true, compiled.reason);
  assert.deepEqual(compiled.snapshot.declarative_content.themes, []);
  assert.deepEqual(compiled.snapshot.declarative_content.commands, []);
  assert.deepEqual(compiled.snapshot.declarative_content.mcp_descriptors, []);
  assert.equal(compiled.snapshot.declarative_content.skill_scopes[0].contribution_id, 'a-skill');
  assert.equal(compiled.snapshot.declarative_content.prompts[0].contribution_id, 'z-prompt');
  assert.deepEqual(compiled.declarative_content, [
    { content_digest: sha256(skillText), content_json: skillText },
    { content_digest: sha256(promptText), content_json: promptText },
  ]);

  packageVerdict.declarative_content_texts[0].content_json += ' ';
  const rejected = await compileRuntimeSnapshot({
    facade,
    baseDir: BASE,
    generation: { generation_id: 'gen-stage4a', graph_hash: graphHash, plugins: [pluginEntry] },
    pointer: { revision: 7, commit_epoch: 11, generation_id: 'gen-stage4a', generation_digest: graphHash },
    verifyPackage: async () => packageVerdict,
    now: NOW,
  });
  assert.equal(rejected.reason, 'declarative_content_digest_mismatch');
});
