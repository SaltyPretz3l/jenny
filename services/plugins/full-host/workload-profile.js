'use strict';

const crypto = require('node:crypto');

const workloadProfiles = require('../../../config/plugins/workload-profiles-v1.json');
const officialBindings = require('../../../config/plugins/official-workload-bindings-v1.json');

const NATIVE_ENFORCED_FIELDS = Object.freeze([
  'active_process_limit',
  'process_memory_hard_bytes',
  'job_memory_hard_bytes',
  'cpu_hard_cap_percent',
  'forced_termination_proof_ms',
]);

// These are release-qualification and plugin-preflight requirements. A trusted
// full host has ambient access, so they are not native Job Object containment.
// The official package builder checks their parity with the signed runtime
// manifest; measured 80%-of-cap peaks remain an owner qualification gate.
const QUALIFICATION_FIELDS = Object.freeze([
  'provisioning_deadline_ms',
  'retained_data_budget_bytes',
  'transient_data_budget_bytes',
  'minimum_free_disk_bytes',
  'minimum_total_vram_bytes',
  'minimum_free_vram_bytes',
]);
const HOST_LIFECYCLE_FIELDS = Object.freeze(['host_absolute_lease_ms']);
const INTEGER_FIELDS = Object.freeze([
  ...NATIVE_ENFORCED_FIELDS, ...HOST_LIFECYCLE_FIELDS, ...QUALIFICATION_FIELDS,
]);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stable(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(stable(value), 'utf8').digest('hex');
}

function normalizeProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const profileId = String(value.profile_id || '').trim();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(profileId)) return null;
  const profile = { profile_id: profileId };
  for (const field of INTEGER_FIELDS) {
    const parsed = Number(value[field]);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
    profile[field] = parsed;
  }
  if (profile.active_process_limit < 1 || profile.active_process_limit > 1024
    || profile.process_memory_hard_bytes < 1 || profile.job_memory_hard_bytes < 1
    || profile.job_memory_hard_bytes < profile.process_memory_hard_bytes
    || profile.cpu_hard_cap_percent < 1 || profile.cpu_hard_cap_percent > 100
    || profile.forced_termination_proof_ms < 1000
    || profile.forced_termination_proof_ms > 60000) return null;
  profile.exclusive_gpu = value.exclusive_gpu === true;
  return Object.freeze(profile);
}

function loadProfiles() {
  if (workloadProfiles?.workload_profiles_schema_version !== 1
    || workloadProfiles?.frozen !== true || !Array.isArray(workloadProfiles.profiles)) {
    throw new Error('plugin_workload_profiles_invalid');
  }
  const profiles = new Map();
  for (const raw of workloadProfiles.profiles) {
    const profile = normalizeProfile(raw);
    if (!profile || profiles.has(profile.profile_id)) {
      throw new Error('plugin_workload_profiles_invalid');
    }
    profiles.set(profile.profile_id, profile);
  }
  const defaultProfile = profiles.get(workloadProfiles.default_profile_id);
  if (!defaultProfile || defaultProfile.profile_id !== 'default_full_host_v1') {
    throw new Error('plugin_default_workload_profile_invalid');
  }
  return profiles;
}

const PROFILES = loadProfiles();
const DEFAULT_PROFILE = PROFILES.get(workloadProfiles.default_profile_id);

function bindingMatches(binding, identity, platform, architecture) {
  return binding?.publisher_id === identity?.publisher_id
    && binding?.plugin_id === identity?.plugin_id
    && binding?.publisher_key_id === identity?.publisher_key_id
    && binding?.contribution_id === identity?.contribution_id
    && binding?.platform === platform
    && binding?.architecture === architecture;
}

function selectWorkloadProfile({ identity = {}, platform = process.platform,
  architecture = process.arch } = {}) {
  const binding = officialBindings?.official_workload_bindings_schema_version === 1
    && officialBindings?.frozen === true && Array.isArray(officialBindings.bindings)
    ? officialBindings.bindings.find((candidate) => (
      bindingMatches(candidate, identity, platform, architecture)
    )) : null;
  const selected = binding ? PROFILES.get(binding.profile_id) : DEFAULT_PROFILE;
  if (!selected) return { ok: false, reason: 'workload_profile_unavailable' };
  return {
    ok: true,
    profile: selected,
    profile_digest: digest(selected),
    official_binding: Boolean(binding),
  };
}

function nativeWorkloadProfile(selection, identity = {}) {
  if (!selection?.ok || !selection.profile) return null;
  const profile = selection.profile;
  return {
    workload_profile_schema_version: 1,
    profile_id: profile.profile_id,
    profile_digest: selection.profile_digest,
    publisher_id: String(identity.publisher_id || ''),
    plugin_id: String(identity.plugin_id || ''),
    contribution_id: String(identity.contribution_id || ''),
    active_process_limit: profile.active_process_limit,
    process_memory_hard_bytes: profile.process_memory_hard_bytes,
    job_memory_hard_bytes: profile.job_memory_hard_bytes,
    cpu_hard_cap_percent: profile.cpu_hard_cap_percent,
    forced_termination_proof_ms: profile.forced_termination_proof_ms,
  };
}

module.exports = {
  DEFAULT_PROFILE,
  INTEGER_FIELDS,
  PROFILES,
  digest,
  nativeWorkloadProfile,
  selectWorkloadProfile,
};
