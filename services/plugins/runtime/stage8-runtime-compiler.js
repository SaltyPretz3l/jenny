'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');
const { compileV5RuntimeSnapshot } = require('./stage7-runtime-compiler');
const { reverifyInstalledPackage, evaluateActivationEligibility } = require('./declarative-compiler');
const { RETIRED_CONTRIBUTION_KIND_SET } = require('./declarative-compiler-constants');

const ARRAY_FIELDS = Object.freeze([
  'full_host_descriptors', 'native_mcp_bindings', 'session_providers',
  'engine_adapters', 'hook_descriptors', 'containment_profiles', 'expected_rejections',
]);

async function compileV6RuntimeSnapshot(options = {}) {
  const { generation, pointer } = options;
  const verifiedPackages = new Map();
  if (!generation || !pointer || generation.generation_schema_version !== 6) {
    return { ok: false, reason: 'stage8_generation_required' };
  }
  if (generation.generation_id !== pointer.generation_id
    || generation.graph_hash !== pointer.generation_digest) {
    return { ok: false, reason: 'authority_snapshot_mismatch' };
  }
  const legacyEntries = [];
  for (const entry of generation.plugins.filter((item) => item.effective_state === 'active')) {
    const reverified = await reverifyInstalledPackage({
      facade: options.facade, baseDir: options.baseDir, pluginEntry: entry,
      verifyPackage: options.verifyPackage, now: options.now,
      verifiedPackages,
    });
    if (!reverified.ok) return { ok: false, reason: reverified.reason || 'package_record_unavailable' };
    if (reverified.verdict.manifest.manifest_schema_version !== 6) {
      legacyEntries.push(entry);
      continue;
    }
    const activation = evaluateActivationEligibility({
      pluginEntry: { ...entry, effective_state: 'installed_disabled' },
      verdict: reverified.verdict,
    });
    if (!activation.activation_eligible) return { ok: false, reason: activation.activation_reason_code };
    // Privileged kinds are retired and inert: no host package is ever compiled.
    if (reverified.verdict.manifest.contributions.some(
      (item) => !RETIRED_CONTRIBUTION_KIND_SET.has(item.kind)
    )) legacyEntries.push(entry);
  }
  const legacy = await compileV5RuntimeSnapshot({
    ...options,
    verifiedPackages,
    generation: { ...generation, generation_schema_version: 5, plugins: legacyEntries },
  });
  if (!legacy.ok) return legacy;
  const candidate = {
    kind: 'plugin_runtime_snapshot', runtime_schema_version: 6,
    registry_revision: pointer.revision, dependency_graph_hash: generation.graph_hash,
    commit_epoch: pointer.commit_epoch, active_generation_id: generation.generation_id,
    declarative_content: legacy.snapshot.declarative_content,
    remote_mcp_bindings: legacy.snapshot.remote_mcp_bindings,
    restricted_contributions: legacy.snapshot.restricted_contributions,
    view_contributions: legacy.snapshot.view_contributions,
    provider_descriptors: legacy.snapshot.provider_descriptors,
  };
  for (const field of ARRAY_FIELDS) candidate[field] = [];
  const checked = validate('PluginRuntimeSnapshotV6', candidate);
  if (!checked.ok) return { ok: false, reason: 'runtime_snapshot_invalid', detail: checked.error };
  return { ...legacy, snapshot: checked.value, privileged: {},
    privileged_packages: Object.freeze([]) };
}

module.exports = { ARRAY_FIELDS, compileV6RuntimeSnapshot };
