'use strict';

const crypto = require('node:crypto');
const { validate } = require('../contracts/generated-plugin-contracts');
const { stableStringify } = require('../package/canonical-metadata');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');

const CONTRACT_NAME = 'PluginDistributionStateV1';
const DISTRIBUTION_DIR = 'distribution';
const DISTRIBUTION_STATE_FILE = 'state.json';
const ZERO_DIGEST = '0'.repeat(64);
const ROLE_FIELDS = Object.freeze([
  ['root_version', 'root_digest'],
  ['timestamp_version', 'timestamp_digest'],
  ['snapshot_version', 'snapshot_digest'],
  ['targets_version', 'targets_digest'],
]);

function sha256(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function distributionStatePath(baseDir) {
  return joinPath(baseDir, DISTRIBUTION_DIR, DISTRIBUTION_STATE_FILE);
}

function createEmptyDistributionState(now, { clockEvidenceDigest = ZERO_DIGEST } = {}) {
  const catalogs = [];
  return {
    distribution_state_schema_version: 1,
    revision: 0,
    trusted_wall_clock_high_water: now,
    trusted_clock_evidence_digest: clockEvidenceDigest,
    advisory_revision: 0,
    advisory_digest: ZERO_DIGEST,
    catalogs,
    cache_entries: 0,
    cache_bytes: 0,
    cache_index_digest: sha256(catalogs),
    updated_at: now,
  };
}

function canonicalizeState(state) {
  return { ...state, catalogs: [...state.catalogs].sort((a, b) => a.catalog_id.localeCompare(b.catalog_id)) };
}

function catalogRegression(current, candidate) {
  for (const [versionField, digestField] of ROLE_FIELDS) {
    if (candidate[versionField] < current[versionField]) return `${versionField}_rollback`;
    if (candidate[versionField] === current[versionField]
      && candidate[digestField] !== current[digestField]) return `${digestField}_conflict`;
  }
  return null;
}

function findRegression(current, candidate) {
  if (Date.parse(candidate.trusted_wall_clock_high_water)
    < Date.parse(current.trusted_wall_clock_high_water)) return 'trusted_clock_rollback';
  if (candidate.advisory_revision < current.advisory_revision) return 'advisory_revision_rollback';
  if (candidate.advisory_revision === current.advisory_revision
    && candidate.advisory_digest !== current.advisory_digest) return 'advisory_digest_conflict';
  const currentCatalogs = new Map(current.catalogs.map((item) => [item.catalog_id, item]));
  const candidateCatalogs = new Set(candidate.catalogs.map((item) => item.catalog_id));
  for (const catalogId of currentCatalogs.keys()) {
    if (!candidateCatalogs.has(catalogId)) return `${catalogId}:catalog_removed`;
  }
  for (const catalog of candidate.catalogs) {
    const prior = currentCatalogs.get(catalog.catalog_id);
    if (prior) {
      const regression = catalogRegression(prior, catalog);
      if (regression) return `${catalog.catalog_id}:${regression}`;
    }
  }
  return null;
}

async function readDistributionState(facade, baseDir) {
  const read = await readJsonFile(facade, distributionStatePath(baseDir));
  if (read.status === 'missing') return { ok: false, reason: 'distribution_state_not_found' };
  if (read.status === 'corrupted') {
    return { ok: false, reason: 'distribution_state_corrupted', detail: read.error };
  }
  const validated = validate(CONTRACT_NAME, read.value);
  if (!validated.ok) return { ok: false, reason: 'distribution_state_invalid', detail: validated.error };
  return { ok: true, state: canonicalizeState(validated.value) };
}

async function writeDistributionState(facade, baseDir, state, { expectedRevision = null } = {}) {
  const validated = validate(CONTRACT_NAME, state);
  if (!validated.ok) return { ok: false, reason: 'distribution_state_invalid', detail: validated.error };
  const candidate = canonicalizeState(validated.value);
  const current = await readDistributionState(facade, baseDir);
  if (current.ok) {
    if (expectedRevision !== null && current.state.revision !== expectedRevision) {
      return { ok: false, reason: 'distribution_state_revision_conflict' };
    }
    if (candidate.revision <= current.state.revision) {
      return { ok: false, reason: 'distribution_state_revision_not_advanced' };
    }
    const regression = findRegression(current.state, candidate);
    if (regression) return { ok: false, reason: 'distribution_state_regression', detail: regression };
  } else if (current.reason !== 'distribution_state_not_found') {
    return current;
  } else if (expectedRevision !== null && expectedRevision !== -1) {
    return { ok: false, reason: 'distribution_state_revision_conflict' };
  }
  await writeJsonFileAtomic(
    facade,
    joinPath(baseDir, DISTRIBUTION_DIR),
    DISTRIBUTION_STATE_FILE,
    candidate
  );
  const verified = await readDistributionState(facade, baseDir);
  if (!verified.ok) return { ok: false, reason: 'distribution_state_post_write_failed', detail: verified };
  return { ok: true, state: verified.state };
}

module.exports = {
  CONTRACT_NAME,
  DISTRIBUTION_DIR,
  ZERO_DIGEST,
  createEmptyDistributionState,
  readDistributionState,
  writeDistributionState,
};
