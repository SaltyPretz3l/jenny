'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectContainmentProfile } = require(
  '../../../services/plugins/full-host/containment-profile'
);

test('Windows admission requires identity, tree, process, memory, and CPU enforcement', () => {
  const capabilities = ['suspended_launch', 'identity_locked_image', 'job_kill_on_close',
    'tree_empty_proof', 'hard_process_limit', 'hard_memory_limit', 'hard_cpu_limit'];
  assert.deepEqual(selectContainmentProfile({ platform: 'win32', supervisorCapabilities: capabilities }),
    { ok: true, profile: 'windows_job_supervised_v1', required: capabilities });
  const missing = selectContainmentProfile({ platform: 'win32',
    supervisorCapabilities: capabilities.filter((item) => item !== 'hard_memory_limit') });
  assert.deepEqual(missing, { ok: false, reason: 'containment_capability_missing',
    missing: ['hard_memory_limit'] });
});

test('unproved platforms fail closed', () => {
  assert.deepEqual(selectContainmentProfile({ platform: 'linux', supervisorCapabilities: [] }),
    { ok: false, reason: 'containment_platform_unsupported' });
});
