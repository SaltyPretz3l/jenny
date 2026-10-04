'use strict';

// Purely declarative runtime compiler.

const { validate } = require('../contracts/generated-plugin-contracts');
const { getContent, sha256Hex } = require('../store/content-store');
const { readPackageRecord } = require('../store/package-record-store');
const { readSettingsState } = require('../store/settings-state-store');
const { RESTRICTED_KIND_SET } = require('../package/restricted-content-validator');
const {
  OFFICIAL_PUBLISHER_ID, SUPPORTED_KINDS, SUPPORTED_KIND_SET, STAGE4B_KINDS,
  STAGE4B_KIND_SET, STAGE5_KINDS, STAGE5_KIND_SET, SNAPSHOT_ARRAY_BY_KIND,
  EMPTY_DECLARATIVE_CONTENT, ELIGIBILITY_REASON_CODES, RETIRED_CONTRIBUTION_KIND_SET,
  declaresRetiredKind,
} = require('./declarative-compiler-constants');

const { OFFICIAL_CURRENT_KEY_ID, STAGE7_KINDS, evaluateStage7Eligibility } = require('./stage7-eligibility');

function fail(reason, detail = null) {
  return { ok: false, reason, detail };
}

function compareUtf8Identity(left, right) {
  for (const key of ['publisher_id', 'plugin_id', 'contribution_id']) {
    const compared = Buffer.compare(Buffer.from(String(left[key] || ''), 'utf8'), Buffer.from(String(right[key] || ''), 'utf8'));
    if (compared !== 0) return compared;
  }
  return 0;
}

function eligibility(reasonCode, contributionKinds = []) {
  return {
    activation_eligible: reasonCode === 'eligible',
    activation_reason_code: reasonCode,
    contribution_kinds: [...new Set(contributionKinds)]
      .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))),
  };
}

function evaluateActivationEligibility({ pluginEntry, verdict, safeMode = false, storeReadOnly = false }) {
  const kinds = Array.isArray(verdict?.manifest?.contributions)
    ? verdict.manifest.contributions.map((item) => String(item?.kind || ''))
    : [];
  if (safeMode) return eligibility('safe_mode', kinds);
  if (storeReadOnly) return eligibility('store_read_only', kinds);
  if (!verdict || verdict.ok !== true) return eligibility('package_record_unavailable', kinds);
  const manifestVersion = verdict.manifest?.manifest_schema_version;
  if (manifestVersion === 6) {
    if (kinds.length === 0) return eligibility('no_supported_contributions', kinds);
    if (pluginEntry?.effective_state === 'active') return eligibility('already_active', kinds);
    return eligibility('eligible', kinds);
  }
  if (manifestVersion === 5) {
    return evaluateStage7Eligibility({ pluginEntry, verdict, kinds, eligibility });
  }
  if (manifestVersion === 4) {
    const requested = new Set(verdict.manifest.requested_permissions || []);
    if (requested.size !== (verdict.manifest.requested_permissions || []).length
      || [...requested].some((permission) => ![
        'network.restricted_runtime', 'secret.brokered_use',
      ].includes(permission))) {
      return eligibility('permissions_requested', kinds);
    }
    if (kinds.length === 0) return eligibility('no_supported_contributions', kinds);
    if (kinds.some((kind) => !RESTRICTED_KIND_SET.has(kind))) {
      return eligibility('mixed_or_unsupported_contributions', kinds);
    }
    if (pluginEntry?.effective_state === 'active') return eligibility('already_active', kinds);
    return eligibility('eligible', kinds);
  }
  if (manifestVersion === 3) {
    const requested = verdict.manifest.requested_permissions || [];
    const hasRemote = kinds.includes('mcp_descriptor');
    if ((hasRemote && (requested.length !== 1 || requested[0] !== 'network.remote_mcp'))
      || (!hasRemote && requested.length > 0)) {
      return eligibility('permissions_requested', kinds);
    }
    if (kinds.length === 0) return eligibility('no_supported_contributions', kinds);
    if (kinds.some((kind) => !STAGE5_KIND_SET.has(kind))) {
      return eligibility('mixed_or_unsupported_contributions', kinds);
    }
    if (pluginEntry?.effective_state === 'active') return eligibility('already_active', kinds);
    return eligibility('eligible', kinds);
  }
  if (pluginEntry?.publisher_id !== OFFICIAL_PUBLISHER_ID || verdict.publisher_id !== OFFICIAL_PUBLISHER_ID) {
    return eligibility('not_first_party', kinds);
  }
  if (pluginEntry?.publisher_key_id !== OFFICIAL_CURRENT_KEY_ID || verdict.publisher_key_id !== OFFICIAL_CURRENT_KEY_ID) {
    return eligibility('publisher_key_not_current', kinds);
  }
  if (Array.isArray(verdict.manifest?.requested_permissions) && verdict.manifest.requested_permissions.length > 0) {
    return eligibility('permissions_requested', kinds);
  }
  if (Array.isArray(pluginEntry?.depends_on) && pluginEntry.depends_on.length > 0) {
    return eligibility('dependencies_not_supported', kinds);
  }
  if (kinds.length === 0) return eligibility('no_supported_contributions', kinds);
  const permittedKinds = manifestVersion === 2 ? STAGE4B_KIND_SET : SUPPORTED_KIND_SET;
  if (kinds.some((kind) => !permittedKinds.has(kind))) {
    return eligibility('mixed_or_unsupported_contributions', kinds);
  }
  if (pluginEntry?.effective_state === 'active') return eligibility('already_active', kinds);
  return eligibility('eligible', kinds);
}

function verdictMatchesEntry(verdict, entry, packageRecord) {
  const recordSigningKey = packageRecord?.package_record_schema_version === 3
    ? packageRecord.signing_key_id
    : packageRecord?.signature_bundle_state?.signing_key_id;
  return Boolean(
    verdict?.ok === true
    && verdict.publisher_id === entry.publisher_id
    && verdict.plugin_id === entry.plugin_id
    && verdict.version === entry.resolved_version
    && verdict.publisher_key_id === entry.publisher_key_id
    && verdict.archive_digest === entry.artifact_digest
    && packageRecord?.content_digest === entry.artifact_digest
    && packageRecord?.publisher_id === entry.publisher_id
    && packageRecord?.plugin_id === entry.plugin_id
    && recordSigningKey === entry.publisher_key_id
    && verdict.package_record?.content_digest === entry.artifact_digest
  );
}

async function reverifyInstalledPackage({
  facade, baseDir, pluginEntry, verifyPackage, now, verifiedPackages,
}) {
  if (!pluginEntry || typeof verifyPackage !== 'function') return fail('package_record_unavailable');
  const cached = verifiedPackages?.get(pluginEntry.artifact_digest);
  if (cached) {
    // Reuse archive verification, but still bind it to each projected entry.
    return verdictMatchesEntry(cached.verdict, pluginEntry, cached.package_record)
      ? cached : fail('package_record_unavailable');
  }
  const [content, packageRecord] = await Promise.all([
    getContent(facade, baseDir, pluginEntry.artifact_digest),
    readPackageRecord(facade, baseDir, pluginEntry.artifact_digest),
  ]);
  if (!content.ok || !packageRecord.ok) return fail('package_record_unavailable');
  const sourcePathDigest = packageRecord.record.source_identity?.package_path_digest;
  let verdict;
  try {
    verdict = await verifyPackage({
      bytes: content.bytes,
      sourcePathDigest,
      sourceIdentity: packageRecord.record.source_identity,
      packageRecord: packageRecord.record,
      now,
    });
  } catch (_error) {
    return fail('package_record_unavailable');
  }
  if (!verdictMatchesEntry(verdict, pluginEntry, packageRecord.record)) {
    return fail('package_record_unavailable');
  }
  const result = { ok: true, verdict, package_record: packageRecord.record };
  verifiedPackages?.set(pluginEntry.artifact_digest, result);
  return result;
}

function buildContributionDescriptor(entry, contribution) {
  return {
    publisher_id: entry.publisher_id,
    plugin_id: entry.plugin_id,
    contribution_id: contribution.contribution_id,
    artifact_digest: entry.artifact_digest,
    content_digest: contribution.content_sha256,
    content_schema_version: contribution.content_schema_version || 1,
  };
}

function validateExactContent(verdict, contribution) {
  const texts = Array.isArray(verdict.declarative_content_texts) ? verdict.declarative_content_texts : [];
  const match = texts.find((item) => (
    item.publisher_id === verdict.publisher_id
    && item.plugin_id === verdict.plugin_id
    && item.contribution_id === contribution.contribution_id
    && item.kind === contribution.kind
  ));
  if (!match || typeof match.content_json !== 'string') return fail('declarative_content_missing');
  if (sha256Hex(Buffer.from(match.content_json, 'utf8')) !== contribution.content_sha256) {
    return fail('declarative_content_digest_mismatch');
  }
  return { ok: true, content_json: match.content_json };
}

async function compileRuntimeSnapshot({ facade, baseDir, generation, pointer, verifyPackage, now }) {
  if (!generation || !pointer) return fail('authority_snapshot_unavailable');
  if (generation.generation_id !== pointer.generation_id || generation.graph_hash !== pointer.generation_digest) {
    return fail('authority_snapshot_mismatch');
  }

  const declarativeContent = {
    skill_scopes: [], prompts: [], themes: [], settings_schemas: [], commands: [], workflows: [], mcp_descriptors: [],
  };
  const contentEnvelope = [];
  const settingsEnvelope = [];
  const settingsStates = [];
  const activeEntries = generation.plugins.filter((entry) => entry.effective_state === 'active');
  for (const entry of activeEntries) {
    const reverified = await reverifyInstalledPackage({ facade, baseDir, pluginEntry: entry, verifyPackage, now });
    if (!reverified.ok) return fail(reverified.reason, { publisher_id: entry.publisher_id, plugin_id: entry.plugin_id });
    const gate = evaluateActivationEligibility({
      pluginEntry: { ...entry, effective_state: 'installed_disabled' },
      verdict: reverified.verdict,
    });
    if (!gate.activation_eligible) {
      return fail(gate.activation_reason_code, { publisher_id: entry.publisher_id, plugin_id: entry.plugin_id });
    }
    for (const contribution of reverified.verdict.manifest.contributions) {
      const contributionState = Array.isArray(entry.contributions)
        ? entry.contributions.find((item) => item.contribution_id === contribution.contribution_id)
        : null;
      const isV2 = reverified.verdict.manifest.manifest_schema_version === 2;
      if (isV2 && (!contributionState || contributionState.effective_enabled !== true)) continue;
      if (RETIRED_CONTRIBUTION_KIND_SET.has(contribution.kind)) continue;
      const exact = validateExactContent(reverified.verdict, contribution);
      if (!exact.ok) return fail(exact.reason, { contribution_id: contribution.contribution_id });
      const parsed = JSON.parse(exact.content_json);
      const descriptor = buildContributionDescriptor(entry, {
        ...contribution,
        content_schema_version: parsed.content_schema_version,
      });
      declarativeContent[SNAPSHOT_ARRAY_BY_KIND[contribution.kind]].push(descriptor);
      contentEnvelope.push({
        publisher_id: entry.publisher_id,
        plugin_id: entry.plugin_id,
        contribution_id: contribution.contribution_id,
        content_digest: contribution.content_sha256,
        content_json: exact.content_json,
      });
      if (contribution.kind === 'settings_schema' && contributionState?.settings_ref?.kind === 'state') {
        const state = await readSettingsState(facade, baseDir, {
          publisherId: entry.publisher_id,
          pluginId: entry.plugin_id,
          contributionId: contribution.contribution_id,
          digest: contributionState.settings_ref.digest,
        });
        if (!state.ok || state.state.revision !== contributionState.settings_ref.revision) {
          return fail('settings_state_unavailable', { contribution_id: contribution.contribution_id });
        }
        settingsStates.push({
          publisher_id: entry.publisher_id,
          plugin_id: entry.plugin_id,
          contribution_id: contribution.contribution_id,
          state_digest: contributionState.settings_ref.digest,
          revision: contributionState.settings_ref.revision,
        });
        settingsEnvelope.push({
          state_digest: contributionState.settings_ref.digest,
          state_json: JSON.stringify(state.state),
        });
      }
    }
  }
  for (const value of Object.values(declarativeContent)) value.sort(compareUtf8Identity);
  contentEnvelope.sort(compareUtf8Identity);
  settingsEnvelope.sort((left, right) => Buffer.compare(
    Buffer.from(left.state_digest, 'utf8'), Buffer.from(right.state_digest, 'utf8')
  ));

  const snapshotCandidate = {
    kind: 'plugin_runtime_snapshot',
    ...(generation.generation_schema_version === 2 ? { runtime_schema_version: 2 } : {}),
    registry_revision: pointer.revision,
    dependency_graph_hash: generation.graph_hash,
    commit_epoch: pointer.commit_epoch,
    active_generation_id: generation.generation_id,
    declarative_content: declarativeContent,
    ...(generation.generation_schema_version === 2 ? {
      workflow_tool_bindings: [],
      settings_states: settingsStates,
    } : {}),
  };
  const snapshotContract = generation.generation_schema_version === 2
    ? 'PluginRuntimeSnapshotV2' : 'PluginRuntimeSnapshotV1';
  if (generation.generation_schema_version !== 2) {
    for (const items of Object.values(declarativeContent)) {
      for (const item of items) delete item.content_schema_version;
    }
  }
  const validated = validate(snapshotContract, snapshotCandidate);
  if (!validated.ok) return fail('runtime_snapshot_invalid', validated.error);
  return {
    ok: true,
    snapshot: validated.value,
    declarative_content: [
      ...contentEnvelope.map(({ content_digest, content_json }) => ({ content_digest, content_json })),
      ...settingsEnvelope,
    ],
    contribution_evidence: contentEnvelope,
  };
}

async function compileV3RuntimeSnapshot({
  facade, baseDir, generation, pointer, verifyPackage, now,
}) {
  if (!generation || !pointer) return fail('authority_snapshot_unavailable');
  if (generation.generation_id !== pointer.generation_id
    || generation.graph_hash !== pointer.generation_digest) {
    return fail('authority_snapshot_mismatch');
  }
  const declarativeContent = [];
  const contentEnvelope = [];
  const activeEntries = generation.plugins.filter((entry) => entry.effective_state === 'active');
  for (const entry of activeEntries) {
    const reverified = await reverifyInstalledPackage({
      facade, baseDir, pluginEntry: entry, verifyPackage, now,
    });
    if (!reverified.ok) return fail(reverified.reason || 'package_record_unavailable');
    const activation = evaluateActivationEligibility({
      pluginEntry: { ...entry, effective_state: 'installed_disabled' },
      verdict: reverified.verdict,
    });
    if (!activation.activation_eligible) return fail(activation.activation_reason_code);
    for (const contribution of reverified.verdict.manifest.contributions) {
      if (RETIRED_CONTRIBUTION_KIND_SET.has(contribution.kind)) continue;
      const exact = validateExactContent(reverified.verdict, contribution);
      if (!exact.ok) return fail(exact.reason, { contribution_id: contribution.contribution_id });
      const parsed = JSON.parse(exact.content_json);
      declarativeContent.push(buildContributionDescriptor(entry, {
        ...contribution,
        content_schema_version: parsed.content_schema_version,
      }));
      contentEnvelope.push({
        publisher_id: entry.publisher_id,
        plugin_id: entry.plugin_id,
        contribution_id: contribution.contribution_id,
        content_digest: contribution.content_sha256,
        content_json: exact.content_json,
      });
    }
  }
  declarativeContent.sort(compareUtf8Identity);
  contentEnvelope.sort(compareUtf8Identity);
  const snapshot = validate('PluginRuntimeSnapshotV3', {
    kind: 'plugin_runtime_snapshot',
    runtime_schema_version: 3,
    registry_revision: pointer.revision,
    dependency_graph_hash: generation.graph_hash,
    commit_epoch: pointer.commit_epoch,
    active_generation_id: generation.generation_id,
    declarative_content: declarativeContent,
    remote_mcp_bindings: [],
  });
  if (!snapshot.ok) return fail('runtime_snapshot_invalid', snapshot.error);
  return {
    ok: true,
    snapshot: snapshot.value,
    declarative_content: contentEnvelope.map(({ content_digest, content_json }) => ({
      content_digest, content_json,
    })),
    contribution_evidence: contentEnvelope,
  };
}

async function compileV4RuntimeSnapshot({
  facade, baseDir, generation, pointer, verifyPackage, now, verifiedPackages = new Map(),
}) {
  if (!generation || !pointer) return fail('authority_snapshot_unavailable');
  if (generation.generation_id !== pointer.generation_id
    || generation.graph_hash !== pointer.generation_digest) {
    return fail('authority_snapshot_mismatch');
  }
  const declarativeContent = [];
  const contentEnvelope = [];
  const activeEntries = generation.plugins.filter((entry) => entry.effective_state === 'active');
  for (const entry of activeEntries) {
    const reverified = await reverifyInstalledPackage({
      facade, baseDir, pluginEntry: entry, verifyPackage, now, verifiedPackages,
    });
    if (!reverified.ok) return fail(reverified.reason || 'package_record_unavailable');
    const activation = evaluateActivationEligibility({
      pluginEntry: { ...entry, effective_state: 'installed_disabled' },
      verdict: reverified.verdict,
    });
    if (!activation.activation_eligible) return fail(activation.activation_reason_code);
    for (const contribution of reverified.verdict.manifest.contributions) {
      if (RETIRED_CONTRIBUTION_KIND_SET.has(contribution.kind)
        || contribution.kind === 'panel' || contribution.kind === 'artifact_renderer') continue;
      const exact = validateExactContent(reverified.verdict, contribution);
      if (!exact.ok) return fail(exact.reason, { contribution_id: contribution.contribution_id });
      const parsed = JSON.parse(exact.content_json);
      declarativeContent.push(buildContributionDescriptor(entry, {
        ...contribution,
        content_schema_version: parsed.content_schema_version,
      }));
      contentEnvelope.push({
        publisher_id: entry.publisher_id,
        plugin_id: entry.plugin_id,
        contribution_id: contribution.contribution_id,
        content_digest: contribution.content_sha256,
        content_json: exact.content_json,
      });
    }
  }
  declarativeContent.sort(compareUtf8Identity);
  contentEnvelope.sort(compareUtf8Identity);
  const snapshot = validate('PluginRuntimeSnapshotV4', {
    kind: 'plugin_runtime_snapshot',
    runtime_schema_version: 4,
    registry_revision: pointer.revision,
    dependency_graph_hash: generation.graph_hash,
    commit_epoch: pointer.commit_epoch,
    active_generation_id: generation.generation_id,
    declarative_content: declarativeContent,
    remote_mcp_bindings: [],
    restricted_contributions: [],
  });
  if (!snapshot.ok) return fail('runtime_snapshot_invalid', snapshot.error);
  return {
    ok: true,
    snapshot: snapshot.value,
    declarative_content: contentEnvelope.map(({ content_digest, content_json }) => ({
      content_digest, content_json,
    })),
    contribution_evidence: contentEnvelope,
    restricted_descriptors: Object.freeze([]),
    restricted_components: new Map(),
  };
}

async function compileCurrentRuntimeSnapshot(options) {
  const version = options?.generation?.generation_schema_version;
  if (version === 6) {
    const { compileV6RuntimeSnapshot } = require('./stage8-runtime-compiler');
    return compileV6RuntimeSnapshot(options);
  }
  if (version === 5) {
    const { compileV5RuntimeSnapshot } = require('./stage7-runtime-compiler');
    return compileV5RuntimeSnapshot(options);
  }
  if (version === 4) return compileV4RuntimeSnapshot(options);
  if (version === 3) return compileV3RuntimeSnapshot(options);
  return compileRuntimeSnapshot(options);
}

module.exports = {
  OFFICIAL_PUBLISHER_ID,
  OFFICIAL_CURRENT_KEY_ID,
  SUPPORTED_KINDS,
  STAGE4B_KINDS,
  STAGE5_KINDS,
  STAGE7_KINDS,
  EMPTY_DECLARATIVE_CONTENT,
  ELIGIBILITY_REASON_CODES,
  declaresRetiredKind,
  compareUtf8Identity,
  evaluateActivationEligibility,
  reverifyInstalledPackage,
  compileRuntimeSnapshot,
  compileV3RuntimeSnapshot,
  compileV4RuntimeSnapshot,
  compileCurrentRuntimeSnapshot,
};
