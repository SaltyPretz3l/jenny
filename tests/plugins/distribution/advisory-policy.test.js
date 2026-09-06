'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { evaluateAdvisories, admitCandidate } = require('../../../services/plugins/distribution/advisory-policy');
const candidate = { publisher_id: 'acme', plugin_id: 'widget', version: '1.2.0', artifact_digest: 'a'.repeat(64), publisher_key_id: 'b'.repeat(64) };
test('quarantine outranks block and warn, and warn needs main-owned confirmation', async () => {
  const snapshot = { revision: 1, advisories: [
    { advisory_id: 'w', publisher_id: 'acme', plugin_id: 'widget', version_range: '*', action: 'warn' },
    { advisory_id: 'b', publisher_id: 'acme', plugin_id: 'widget', version_range: '*', action: 'block' },
    { advisory_id: 'q', publisher_id: 'acme', plugin_id: 'widget', version_range: '*', action: 'quarantine' }], revoked_artifacts: [], revoked_keys: [] };
  assert.equal(evaluateAdvisories(snapshot, candidate).action, 'quarantine');
  const warn = { revision: 1, advisories: [snapshot.advisories[0]], revoked_artifacts: [], revoked_keys: [] };
  assert.equal((await admitCandidate(warn, candidate)).reason, 'advisory_warning_not_confirmed');
  assert.equal((await admitCandidate(warn, candidate, { confirmWarning: async () => true })).ok, true);
});
test('malformed revocation lists fail closed instead of being silently filtered', () => {
  assert.equal(evaluateAdvisories({ revision: 1, advisories: [], revoked_artifacts: ['not-a-digest'], revoked_keys: [] }, candidate).reason,
    'advisory_snapshot_invalid');
  assert.equal(evaluateAdvisories({ revision: 1, advisories: [], revoked_artifacts: [], revoked_keys: 'bad' }, candidate).reason,
    'advisory_snapshot_invalid');
});
