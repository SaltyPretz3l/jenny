'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');
const {
  compareUtf8Identity,
  evaluateActivationEligibility,
  reverifyInstalledPackage,
  compileV4RuntimeSnapshot,
} = require('./declarative-compiler');
const { RETIRED_CONTRIBUTION_KIND_SET } = require('./declarative-compiler-constants');
const { compileStage7Contributions } = require('../view/contribution-compiler');

const STAGE7_KINDS = new Set([
  'setup_scene', 'panel', 'artifact_renderer', 'provider_descriptor',
]);

function fail(reason, detail = null) { return { ok: false, reason, detail }; }

async function compileV5RuntimeSnapshot({
  facade, baseDir, generation, pointer, verifyPackage, now,
  lifecycleEpoch = 0, workspaceIncarnationId = 'workspace_default',
  verifiedPackages = new Map(),
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
      facade, baseDir, pluginEntry: entry, verifyPackage, now, verifiedPackages,
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
    // Retired kinds (setup_scene, provider_descriptor) stay inert: only the
    // remaining view kinds reach the Stage 7 compiler.
    const live = (manifestVersion === 6 ? v6Stage7 : reverified.verdict.manifest.contributions)
      .filter((item) => !RETIRED_CONTRIBUTION_KIND_SET.has(item.kind));
    if (live.length === 0) continue;
    const verdict = {
      ...reverified.verdict,
      manifest: { ...reverified.verdict.manifest, manifest_schema_version: 5, contributions: live },
      declarative_content_texts: (reverified.verdict.declarative_content_texts || []).filter(
        (item) => live.some((contribution) => contribution.contribution_id === item.contribution_id)
      ),
    };
    stage7Packages.push({ entry, verdict });
  }

  const legacy = await compileV4RuntimeSnapshot({
    facade, baseDir,
    generation: { ...generation, generation_schema_version: 4, plugins: legacyEntries },
    pointer, verifyPackage, now, lifecycleEpoch, workspaceIncarnationId, verifiedPackages,
  });
  if (!legacy.ok) return legacy;

  const viewContributions = [];
  const viewDescriptors = [];
  const viewAssets = new Map();
  for (const { entry, verdict } of stage7Packages) {
    const compiled = compileStage7Contributions({
      manifest: verdict.manifest,
      contentTexts: verdict.declarative_content_texts,
      artifactDigest: entry.artifact_digest,
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
    for (const asset of verdict.view_asset_bytes || []) {
      viewAssets.set(`${entry.artifact_digest}/${asset.path}`, Object.freeze(asset));
    }
  }
  viewContributions.sort(compareUtf8Identity);
  viewDescriptors.sort(compareUtf8Identity);
  const snapshot = validate('PluginRuntimeSnapshotV5', {
    kind: 'plugin_runtime_snapshot', runtime_schema_version: 5,
    registry_revision: pointer.revision, dependency_graph_hash: generation.graph_hash,
    commit_epoch: pointer.commit_epoch, active_generation_id: generation.generation_id,
    declarative_content: legacy.snapshot.declarative_content,
    remote_mcp_bindings: legacy.snapshot.remote_mcp_bindings,
    restricted_contributions: legacy.snapshot.restricted_contributions,
    view_contributions: viewContributions,
    // Provider descriptors are retired (ChatGPT runs from core); the frozen V5
    // snapshot contract keeps the empty array.
    provider_descriptors: [],
  });
  if (!snapshot.ok) return fail('runtime_snapshot_invalid', snapshot.error);
  return {
    ...legacy,
    snapshot: snapshot.value,
    view_descriptors: Object.freeze(viewDescriptors),
    provider_descriptors: Object.freeze([]),
    view_assets: viewAssets,
  };
}

module.exports = { compileV5RuntimeSnapshot };
