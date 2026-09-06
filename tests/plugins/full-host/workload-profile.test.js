'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_PROFILE,
  nativeWorkloadProfile,
  selectWorkloadProfile,
} = require('../../../services/plugins/full-host/workload-profile');

const OFFICIAL_KEY = '7ed60652328f0fbbdb7417c97a9fbd4f2f54ef223af774e9d83ddf213a1291f5';

test('only the exact current-key official Windows x64 identity receives gpu_image_v1', () => {
  const identity = {
    publisher_id: 'jenny-official',
    plugin_id: 'local-image-generation',
    publisher_key_id: OFFICIAL_KEY,
    contribution_id: 'local_image_generation',
  };
  const selected = selectWorkloadProfile({ identity, platform: 'win32', architecture: 'x64' });
  assert.equal(selected.ok, true);
  assert.equal(selected.official_binding, true);
  assert.equal(selected.profile.profile_id, 'gpu_image_v1');
  assert.equal(selected.profile.active_process_limit, 192);
  assert.equal(selected.profile.process_memory_hard_bytes, 32 * 1024 ** 3);
  assert.equal(selected.profile.job_memory_hard_bytes, 48 * 1024 ** 3);
  assert.equal(selected.profile.cpu_hard_cap_percent, 90);
  assert.equal(selected.profile.forced_termination_proof_ms, 30_000);
  assert.equal(nativeWorkloadProfile(selected, identity).plugin_id, identity.plugin_id);
  assert.equal(Object.hasOwn(nativeWorkloadProfile(selected, identity), 'retained_data_budget_bytes'), false);

  for (const mutation of [
    { plugin_id: 'lookalike' },
    { publisher_key_id: 'f'.repeat(64) },
    { contribution_id: 'other' },
  ]) {
    const fallback = selectWorkloadProfile({ identity: { ...identity, ...mutation },
      platform: 'win32', architecture: 'x64' });
    assert.equal(fallback.profile.profile_id, DEFAULT_PROFILE.profile_id);
    assert.equal(fallback.official_binding, false);
  }
  assert.equal(selectWorkloadProfile({ identity, platform: 'darwin', architecture: 'x64' })
    .profile.profile_id, DEFAULT_PROFILE.profile_id);
});

test('the existing full-host workload profile remains byte-for-byte at Stage 8 defaults', () => {
  assert.deepEqual(DEFAULT_PROFILE, {
    profile_id: 'default_full_host_v1',
    active_process_limit: 16,
    process_memory_hard_bytes: 2_147_483_648,
    job_memory_hard_bytes: 2_147_483_648,
    cpu_hard_cap_percent: 75,
    provisioning_deadline_ms: 600_000,
    host_absolute_lease_ms: 3_600_000,
    retained_data_budget_bytes: 10_737_418_240,
    transient_data_budget_bytes: 10_737_418_240,
    forced_termination_proof_ms: 10_000,
    minimum_free_disk_bytes: 0,
    minimum_total_vram_bytes: 0,
    minimum_free_vram_bytes: 0,
    exclusive_gpu: false,
  });
});
