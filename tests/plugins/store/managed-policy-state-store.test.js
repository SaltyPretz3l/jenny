'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSeededFacade } = require('../../helpers/plugins/memory-fs-facade');
const {
  statePath,
  readManagedPolicyState,
  writeManagedPolicyState,
} = require('../../../services/plugins/store/managed-policy-state-store');

function record() {
  return {
    managed_policy_state_schema_version: 1,
    effective_revision: 3,
    source_revision_high_water: 8,
    source_policy_digest_high_water: 'a'.repeat(64),
    current_policy_digest: 'a'.repeat(64),
    source_kind: 'windows_machine_policy',
    source_fingerprint: 'b'.repeat(64),
    status: 'active',
    reason: 'managed_policy_active',
    privileged_execution: 'allow',
    installation: 'allow_inactive',
    update_ring: 'stable',
    allowed_source_kinds: ['signed_catalog'],
    allowed_publishers: [],
    require_sbom: true,
    require_build_provenance: true,
    managed_source_fingerprints: [],
    audit_max_entries: 500,
    accepted_at: '2026-08-10T12:00:00.000Z',
    observed_at: '2026-08-10T12:00:00.000Z',
  };
}

test('atomically persists and reopens pathless managed-policy high-water state', async () => {
  const facade = await createSeededFacade();
  assert.equal((await readManagedPolicyState(facade, '')).reason, 'managed_policy_state_missing');
  const written = await writeManagedPolicyState(facade, '', record());
  assert.equal(written.ok, true);
  assert.deepEqual((await readManagedPolicyState(facade, '')).state, record());
  assert.equal(JSON.stringify(written.state).includes('\\'), false);
});

test('corruption is not treated as policy absence', async () => {
  const facade = await createSeededFacade({ [statePath('')]: '{broken' });
  assert.deepEqual(await readManagedPolicyState(facade, ''), {
    ok: false, reason: 'managed_policy_state_corrupt',
  });
  const invalid = { ...record(), source_revision_high_water: -1 };
  assert.deepEqual(await writeManagedPolicyState(facade, '', invalid), {
    ok: false, reason: 'managed_policy_state_invalid',
  });
});
