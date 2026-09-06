'use strict';

const SUPPORTED_PROFILES = Object.freeze({
  win32: 'windows_job_supervised_v1',
  darwin: 'posix_group_supervised_v1',
});

function selectContainmentProfile({ platform = process.platform, supervisorCapabilities = [] } = {}) {
  const profile = SUPPORTED_PROFILES[platform];
  if (!profile) return { ok: false, reason: 'containment_platform_unsupported' };
  const capabilities = new Set(Array.isArray(supervisorCapabilities) ? supervisorCapabilities : []);
  const required = platform === 'win32'
    ? ['suspended_launch', 'identity_locked_image', 'job_kill_on_close', 'tree_empty_proof',
      'hard_process_limit', 'hard_memory_limit', 'hard_cpu_limit']
    : ['identity_locked_image', 'process_group_kill', 'tree_empty_proof'];
  const missing = required.filter((item) => !capabilities.has(item));
  return missing.length
    ? { ok: false, reason: 'containment_capability_missing', missing }
    : { ok: true, profile, required };
}

module.exports = { selectContainmentProfile };
