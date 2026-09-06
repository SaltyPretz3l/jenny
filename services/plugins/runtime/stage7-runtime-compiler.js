'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');
const {
  OFFICIAL_CURRENT_KEY_ID,
  compareUtf8Identity,
  evaluateActivationEligibility,
  reverifyInstalledPackage,
  compileV4RuntimeSnapshot,
} = require('./declarative-compiler');
const { compileStage7Contributions } = require('../view/contribution-compiler');
const { compileProviderDescriptor } = require('../provider/provider-descriptor-compiler');

const STAGE7_KINDS = new Set([
  'setup_scene', 'panel', 'artifact_renderer', 'provider_descriptor',
]);

function fail(reason, detail = null) { return { ok: false, reason, detail }; }

async function compileV5RuntimeSnapshot({
  facade, baseDir, generation, pointer, verifyPackage, now, remoteMcpRuntime,
  lifecycleEpoch = 0, workspaceIncarnationId = 'workspace_default',
}) {
  if (!generation || !pointer || generation.generation_schema_version !== 5) {
    return fail('stage7_generation_required');
  }
  if (generation.generation_id !== pointer.generation_id
    || generation.graph_hash !== pointer.generation_digest) return fail('authority_snapshot_mismatch');

  const legacyEntries = [];
  const stage7Packages = [];
  for (const entry of generation.plugins.filter((item) => item.effective_state === 'active')) {
    const reverified = await reverifyInstalledPackage({
      facade, baseDir, pluginEntry: entry, verifyPackage, now,
    });
    if (!reverified.ok) return fail(reverified.reason || 'package_record_unavailable');
    const manifestVersion = reverified.verdict.manifest.manifest_schema_version;
    const v6Stage7 = manifestVersion === 6
      ? reverified.verdict.manifest.contributions.filter(
        (item) => STAGE7_KINDS.has(item.kind)
      ) : [];
    if (manifestVersion !== 5 && v6Stage7.length === 0) {
      legacyEntries.push(entry);
      continue;
    }
    const activation = evaluateActivationEligibility({
      pluginEntry: { ...entry, effective_state: 'installed_disabled' }, verdict: reverified.verdict,
    });
    if (!activation.activation_eligible) return fail(activation.activation_reason_code);
    if (manifestVersion === 6) legacyEntries.push(entry);
    const verdict = manifestVersion === 6 ? {
      ...reverified.verdict,
      manifest: { ...reverified.verdict.manifest, manifest_schema_version: 5,
        contributions: v6Stage7 },
      declarative_content_texts: reverified.verdict.declarative_content_texts.filter(
        (item) => v6Stage7.some(
          (contribution) => contribution.contribution_id === item.contribution_id
        )
      ),
    } : reverified.verdict;
    stage7Packages.push({ entry, verdict });
  }

  const legacy = await compileV4RuntimeSnapshot({
    facade, baseDir,
    generation: { ...generation, generation_schema_version: 4, plugins: legacyEntries },
    pointer, verifyPackage, now, remoteMcpRuntime, lifecycleEpoch, workspaceIncarnationId,
  });
  if (!legacy.ok) return legacy;

  const viewContributions = [];
  const providerDescriptors = [];
  const viewDescriptors = [];
  const providerEvidence = [];
  const providerValues = [];
  const viewAssets = new Map();
  for (const { entry, verdict } of stage7Packages) {
    const compiled = compileStage7Contributions({
      manifest: verdict.manifest,
      contentTexts: verdict.declarative_content_texts,
      artifactDigest: entry.artifact_digest,
      publisherKeyId: entry.publisher_key_id,
      officialKeyId: OFFICIAL_CURRENT_KEY_ID,
    });
    if (!compiled.ok) return compiled;
    for (const view of compiled.views) {
      const descriptor = Object.freeze({
        ...view,
        generation_id: generation.generation_id,
        commit_epoch: pointer.commit_epoch,
        lifecycle_epoch: lifecycleEpoch,
      });
      viewDescriptors.push(descriptor);
      viewContributions.push({
        publisher_id: view.publisher_id, plugin_id: view.plugin_id,
        contribution_id: view.contribution_id, kind: view.kind,
        artifact_digest: view.artifact_digest, content_digest: view.content_digest,
        entry_path: view.content.entry_path, entry_digest: view.content.entry_sha256,
      });
    }
    for (const provider of compiled.providers) {
      const providerValue = compileProviderDescriptor(provider.descriptor, {
        generation_id: generation.generation_id,
        commit_epoch: pointer.commit_epoch,
        artifact_digest: provider.artifact_digest,
        descriptor_digest: provider.content_digest,
      });
      if (!providerValue.ok) return providerValue;
      providerValues.push(providerValue.descriptor);
      providerDescriptors.push({
        publisher_id: provider.publisher_id, plugin_id: provider.plugin_id,
        contribution_id: provider.contribution_id,
        provider_id: provider.descriptor.provider_id,
        engine_type: provider.descriptor.engine_type,
        artifact_digest: provider.artifact_digest,
        descriptor_digest: provider.content_digest,
      });
      providerEvidence.push({
        content_digest: provider.content_digest,
        content_json: provider.content_json,
      });
    }
    for (const asset of verdict.view_asset_bytes || []) {
      viewAssets.set(`${entry.artifact_digest}/${asset.path}`, Object.freeze(asset));
    }
  }
  viewContributions.sort(compareUtf8Identity);
  providerDescriptors.sort(compareUtf8Identity);
  viewDescriptors.sort(compareUtf8Identity);
  const snapshot = validate('PluginRuntimeSnapshotV5', {
    kind: 'plugin_runtime_snapshot', runtime_schema_version: 5,
    registry_revision: pointer.revision, dependency_graph_hash: generation.graph_hash,
    commit_epoch: pointer.commit_epoch, active_generation_id: generation.generation_id,
    declarative_content: legacy.snapshot.declarative_content,
    remote_mcp_bindings: legacy.snapshot.remote_mcp_bindings,
    restricted_contributions: legacy.snapshot.restricted_contributions,
    view_contributions: viewContributions, provider_descriptors: providerDescriptors,
  });
  if (!snapshot.ok) return fail('runtime_snapshot_invalid', snapshot.error);
  return {
    ...legacy,
    snapshot: snapshot.value,
    declarative_content: [...legacy.declarative_content, ...providerEvidence],
    view_descriptors: Object.freeze(viewDescriptors),
    provider_descriptors: Object.freeze(providerDescriptors),
    provider_descriptor_values: Object.freeze(providerValues),
    view_assets: viewAssets,
  };
}

module.exports = { compileV5RuntimeSnapshot };
