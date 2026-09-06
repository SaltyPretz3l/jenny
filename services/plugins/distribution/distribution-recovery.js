'use strict';

const crypto = require('node:crypto');
const { validate } = require('../contracts/generated-plugin-contracts');
const { stableStringify } = require('../package/canonical-metadata');
const { getContent } = require('../store/content-store');
const { readPackageRecord } = require('../store/package-record-store');
const { getEvidence } = require('../store/distribution-evidence-store');
const { getDataSnapshot } = require('../store/data-snapshot-store');
const { readDataState } = require('../store/data-state-store');
const { pruneExpiredPartials } = require('../store/package-cache');
const { pruneArtifactLeases } = require('../store/artifact-lease-store');
const { pruneTerminalOperationRecords } = require('../store/distribution-operation-store');
const { recoverStore } = require('../lifecycle/recovery');
const { stagingRootDir, stagingDir, isValidOperationId } = require('../paths/store-paths');

function recordDigest(value) { return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex'); }
async function validateV3Generation(facade, baseDir, generation, {
  validateTrust = null, validatePolicy = null, validateAdvisories = null,
} = {}) {
  if (![3, 4, 5, 6].includes(generation.generation_schema_version)) return { ok: true };
  const lock = await getEvidence(facade, baseDir, 'lock', generation.lock_digest); if (!lock.ok) return { ok: false, reason: 'lock_evidence_invalid' };
  const checkedLock = validate('PluginLockV1', lock.value); if (!checkedLock.ok) return { ok: false, reason: 'lock_evidence_invalid' };
  const pluginById = new Map(generation.plugins.map((plugin) => [`${plugin.publisher_id}/${plugin.plugin_id}`, plugin]));
  if (checkedLock.value.nodes.length !== generation.plugins.length || checkedLock.value.nodes.some((node) => {
    const plugin = pluginById.get(`${node.publisher_id}/${node.plugin_id}`);
    return !plugin || plugin.resolved_version !== node.resolved_version || plugin.artifact_digest !== node.artifact_digest
      || plugin.publisher_key_id !== node.publisher_key_id;
  })) return { ok: false, reason: 'lock_generation_mismatch' };
  const distribution = await getEvidence(facade, baseDir, 'catalog', generation.distribution_state_digest);
  if (!distribution.ok) return { ok: false, reason: 'distribution_evidence_invalid' };
  const degradedDataState = [];
  for (const plugin of generation.plugins) {
    const content = await getContent(facade, baseDir, plugin.artifact_digest); if (!content.ok) return { ok: false, reason: 'artifact_invalid' };
    for (const digest of plugin.executable_object_digests || []) {
      if (!(await getContent(facade, baseDir, digest)).ok) {
        return { ok: false, reason: 'executable_object_invalid' };
      }
    }
    const packageRecord = await readPackageRecord(facade, baseDir, plugin.artifact_digest);
    if (!packageRecord.ok || recordDigest(packageRecord.record) !== plugin.package_record_digest) return { ok: false, reason: 'package_record_invalid' };
    if (!(await getEvidence(facade, baseDir, 'source_trust', plugin.source_trust_digest)).ok) return { ok: false, reason: 'source_trust_invalid' };
    if (!(await getEvidence(facade, baseDir, 'advisory', plugin.advisory_snapshot_digest)).ok) return { ok: false, reason: 'advisory_evidence_invalid' };
    const snapshot = await getDataSnapshot(facade, baseDir, { publisherId: plugin.publisher_id, pluginId: plugin.plugin_id, digest: plugin.data_snapshot_digest });
    if (!snapshot.ok) return { ok: false, reason: 'data_snapshot_invalid' };
    const dataState = await readDataState(facade, baseDir, { publisherId: plugin.publisher_id, pluginId: plugin.plugin_id });
    if (!dataState.ok || dataState.state.data_generation_id !== generation.generation_id) {
      degradedDataState.push(`${plugin.publisher_id}/${plugin.plugin_id}`);
    }
  }
  if (typeof validateTrust === 'function' && await validateTrust(generation) !== true) return { ok: false, reason: 'current_trust_rejected' };
  if (typeof validatePolicy === 'function' && await validatePolicy(generation) !== true) return { ok: false, reason: 'current_policy_rejected' };
  if (typeof validateAdvisories === 'function' && await validateAdvisories(generation) !== true) return { ok: false, reason: 'current_advisory_rejected' };
  return { ok: true, degraded_data_state: degradedDataState };
}
async function recoverDistribution(facade, baseDir, {
  now, safetyIncrement = 1, validateTrust = null, validatePolicy = null, validateAdvisories = null,
} = {}) {
  await pruneExpiredPartials(facade, baseDir, now);
  await pruneArtifactLeases(facade, baseDir, now);
  await pruneTerminalOperationRecords(facade, baseDir, now);
  for (const operationId of await facade.list(stagingRootDir(baseDir))) {
    if (!isValidOperationId(operationId)) continue;
    const staging = stagingDir(baseDir, operationId);
    if (staging.ok) await facade.removeTree(staging.path);
  }
  const recovered = await recoverStore(facade, baseDir, { now, safetyIncrement,
    validateCandidate: ({ generation }) => validateV3Generation(facade, baseDir, generation, { validateTrust, validatePolicy, validateAdvisories }) });
  const classification = recovered.classification === 'consistent' ? 'committed'
    : recovered.classification === 'recovered' ? 'safely_recoverable'
      : recovered.classification === 'plugins_disabled_required' ? 'plugins-disabled-required' : 'indeterminate';
  return { ...recovered, distribution_classification: classification };
}
module.exports = { recordDigest, validateV3Generation, recoverDistribution };
