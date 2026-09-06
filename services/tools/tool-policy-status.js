'use strict';

const crypto = require('node:crypto');

const { normalizePolicySnapshot } = require('./tool-policy-evaluator');

function emptyToolPolicyStatusFields() {
  return {
    kind: 'policy',
    version: 0,
    legacy_policy_count: 0,
    rule_count: 0,
    snapshot_id: '',
    hooks: {
      enabled: false,
      registered_count: 0,
    },
  };
}

function buildUnavailableToolPolicyStatus(error, redactor) {
  return {
    available: false,
    error: redactPolicyStatusError(error, redactor),
    ...emptyToolPolicyStatusFields(),
  };
}

function buildToolPolicyStatusFacet(permissionStore, redactor = null) {
  if (!permissionStore || typeof permissionStore.getSnapshot !== 'function') {
    return buildUnavailableToolPolicyStatus(
      new Error('Tool permission store is unavailable.'),
      redactor
    );
  }

  try {
    const snapshot = normalizePolicySnapshot(permissionStore.getSnapshot());
    return {
      available: true,
      kind: 'policy',
      version: Number(snapshot.version) || 1,
      legacy_policy_count: Object.keys(snapshot.legacy_policies || {}).length,
      rule_count: Array.isArray(snapshot.rules) ? snapshot.rules.length : 0,
      snapshot_id: buildPolicySnapshotId(snapshot),
      hooks: {
        enabled: false,
        registered_count: 0,
      },
    };
  } catch (error) {
    return buildUnavailableToolPolicyStatus(error, redactor);
  }
}

function buildPolicySnapshotId(snapshot) {
  const payload = JSON.stringify(stableClone(snapshot));
  return `policy_${crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 16)}`;
}

function stableClone(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stableClone(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = stableClone(value[key]);
  }
  return out;
}

function redactPolicyStatusError(error, redactor) {
  if (redactor && typeof redactor.error === 'function') {
    return redactor.error(error);
  }
  const rawMessage = error && typeof error === 'object' ? error.message : error;
  return String(rawMessage || 'Tool permission store is unavailable.').slice(0, 240);
}

module.exports = {
  buildToolPolicyStatusFacet,
};
