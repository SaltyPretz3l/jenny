'use strict';

const semver = require('semver');
const { isValidDigest } = require('../store/content-store');

const PRECEDENCE = Object.freeze({ none: 0, warn: 1, block: 2, quarantine: 3 });
function normalizeAdvisories(snapshot) {
  if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
    || !Array.isArray(snapshot.advisories) || snapshot.advisories.length > 10000
    || !Array.isArray(snapshot.revoked_artifacts) || snapshot.revoked_artifacts.length > 10000
    || !snapshot.revoked_artifacts.every(isValidDigest)
    || !Array.isArray(snapshot.revoked_keys) || snapshot.revoked_keys.length > 10000
    || !snapshot.revoked_keys.every(isValidDigest)) return { ok: false, reason: 'advisory_snapshot_invalid' };
  const rows = [];
  for (const row of snapshot.advisories) {
    if (!row || !Object.hasOwn(PRECEDENCE, row.action) || typeof row.publisher_id !== 'string'
      || typeof row.plugin_id !== 'string' || !semver.validRange(row.version_range, { includePrerelease: true })) {
      return { ok: false, reason: 'advisory_snapshot_invalid' };
    }
    rows.push({ ...row });
  }
  return { ok: true, snapshot: { ...snapshot, advisories: rows },
    revoked_artifacts: new Set(snapshot.revoked_artifacts),
    revoked_keys: new Set(snapshot.revoked_keys) };
}
function evaluateAdvisories(snapshot, candidate) {
  const checked = normalizeAdvisories(snapshot); if (!checked.ok) return checked;
  let action = 'none'; const matched = [];
  for (const row of checked.snapshot.advisories) {
    if (row.publisher_id === candidate.publisher_id && row.plugin_id === candidate.plugin_id
      && semver.satisfies(candidate.version, row.version_range, { includePrerelease: true })) {
      matched.push(row.advisory_id || 'advisory'); if (PRECEDENCE[row.action] > PRECEDENCE[action]) action = row.action;
    }
  }
  if (checked.revoked_artifacts.has(candidate.artifact_digest)) action = 'quarantine';
  if (checked.revoked_keys.has(candidate.publisher_key_id)) action = 'quarantine';
  return { ok: true, action, matched: matched.sort(),
    revoked_artifacts: checked.revoked_artifacts, revoked_keys: checked.revoked_keys,
    revoked: action === 'quarantine'
      && (checked.revoked_artifacts.has(candidate.artifact_digest) || checked.revoked_keys.has(candidate.publisher_key_id)) };
}
async function admitCandidate(snapshot, candidate, { confirmWarning = null } = {}) {
  const result = evaluateAdvisories(snapshot, candidate); if (!result.ok) return result;
  if (result.action === 'warn') {
    if (typeof confirmWarning !== 'function' || await confirmWarning({ candidate, advisory_ids: result.matched }) !== true) {
      return { ok: false, reason: 'advisory_warning_not_confirmed' };
    }
  }
  return result.action === 'block' || result.action === 'quarantine'
    ? { ok: false, reason: `advisory_${result.action}`, advisory_ids: result.matched }
    : { ok: true, warning_confirmed: result.action === 'warn', advisory_ids: result.matched };
}
module.exports = { normalizeAdvisories, evaluateAdvisories, admitCandidate };
