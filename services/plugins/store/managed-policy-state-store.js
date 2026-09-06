'use strict';

const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');

const DIRECTORY = 'managed-policy';
const FILE_NAME = 'state-v1.json';
const DIGEST_RE = /^[0-9a-f]{64}$/;
const STATUS = new Set(['unmanaged', 'active', 'blocked']);
const REASON_RE = /^[a-z][a-z0-9_]{0,63}$/;

function statePath(baseDir) { return joinPath(baseDir, DIRECTORY, FILE_NAME); }

function validateManagedPolicyState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = [
    'managed_policy_state_schema_version', 'effective_revision', 'source_revision_high_water',
    'source_policy_digest_high_water', 'current_policy_digest', 'source_kind',
    'source_fingerprint', 'status', 'reason', 'privileged_execution', 'installation',
    'update_ring', 'allowed_source_kinds', 'allowed_publishers', 'require_sbom',
    'require_build_provenance', 'managed_source_fingerprints', 'audit_max_entries',
    'accepted_at', 'observed_at',
  ];
  if (Object.keys(value).sort().join('\0') !== expected.sort().join('\0')) return false;
  const nullableDigest = (item) => item === null || DIGEST_RE.test(item);
  const nullableTimestamp = (item) => item === null
    || (typeof item === 'string' && Number.isFinite(Date.parse(item)));
  return value.managed_policy_state_schema_version === 1
    && Number.isSafeInteger(value.effective_revision) && value.effective_revision >= 0
    && Number.isSafeInteger(value.source_revision_high_water)
    && value.source_revision_high_water >= 0
    && nullableDigest(value.source_policy_digest_high_water)
    && nullableDigest(value.current_policy_digest)
    && (value.source_kind === null || /^[a-z][a-z0-9_]{0,63}$/.test(value.source_kind))
    && nullableDigest(value.source_fingerprint)
    && STATUS.has(value.status)
    && REASON_RE.test(value.reason)
    && ['allow', 'deny'].includes(value.privileged_execution)
    && ['allow_inactive', 'deny'].includes(value.installation)
    && ['stable', 'preview', 'frozen'].includes(value.update_ring)
    && Array.isArray(value.allowed_source_kinds) && value.allowed_source_kinds.length <= 32
    && value.allowed_source_kinds.every((item) => typeof item === 'string' && item.length <= 64)
    && Array.isArray(value.allowed_publishers) && value.allowed_publishers.length <= 32
    && value.allowed_publishers.every((item) => typeof item === 'string' && item.length <= 64)
    && typeof value.require_sbom === 'boolean'
    && typeof value.require_build_provenance === 'boolean'
    && Array.isArray(value.managed_source_fingerprints)
    && value.managed_source_fingerprints.length <= 32
    && value.managed_source_fingerprints.every((item) => DIGEST_RE.test(item))
    && Number.isSafeInteger(value.audit_max_entries)
    && value.audit_max_entries >= 1 && value.audit_max_entries <= 1000
    && nullableTimestamp(value.accepted_at) && nullableTimestamp(value.observed_at);
}

async function readManagedPolicyState(facade, baseDir = '') {
  const read = await readJsonFile(facade, statePath(baseDir));
  if (read.status === 'missing') return { ok: false, reason: 'managed_policy_state_missing' };
  if (read.status !== 'ok' || !validateManagedPolicyState(read.value)) {
    return { ok: false, reason: 'managed_policy_state_corrupt' };
  }
  return { ok: true, state: Object.freeze({ ...read.value }) };
}

async function writeManagedPolicyState(facade, baseDir, state) {
  if (!validateManagedPolicyState(state)) {
    return { ok: false, reason: 'managed_policy_state_invalid' };
  }
  try {
    await writeJsonFileAtomic(facade, joinPath(baseDir, DIRECTORY), FILE_NAME, state);
    return readManagedPolicyState(facade, baseDir);
  } catch (_error) {
    return { ok: false, reason: 'managed_policy_state_write_failed' };
  }
}

module.exports = {
  DIRECTORY,
  FILE_NAME,
  statePath,
  readManagedPolicyState,
  writeManagedPolicyState,
};
