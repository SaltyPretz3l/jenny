'use strict';

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');

function refuse(reason) {
  return { ok: false, code: PLUGIN_ERROR_CODES.POLICY_BLOCKED, reason, retryable: false };
}

function evaluateInvocationAuthority({ binding, runtimeBinding, contribution, invocation,
  current, policy = {} } = {}) {
  if (!binding || !runtimeBinding || !contribution || !invocation || !current) {
    return refuse('remote_invocation_context_invalid');
  }
  if (policy.stage5_enabled !== true) return refuse('stage5_production_exposure_forbidden');
  if (current.lifecycle_state !== 'active' || current.activation_scope !== 'stage5_remote_mcp') {
    return refuse('remote_descriptor_inactive');
  }
  if (current.publisher_id !== binding.publisher_id || current.plugin_id !== binding.plugin_id
    || current.generation_id !== binding.generation_id
    || current.artifact_digest !== binding.artifact_digest
    || current.commit_epoch !== binding.commit_epoch) return refuse('remote_generation_stale');
  if (runtimeBinding.binding_digest !== binding.binding_digest
    || runtimeBinding.descriptor_digest !== binding.descriptor_digest
    || runtimeBinding.endpoint_origin_digest !== binding.endpoint_origin_digest) {
    return refuse('remote_binding_stale');
  }
  if (invocation.binding_digest !== binding.binding_digest
    || invocation.descriptor_digest !== binding.descriptor_digest
    || invocation.namespaced_name !== contribution.namespaced_name) {
    return refuse('remote_invocation_stale');
  }
  if (policy.consent_digest !== binding.consent_digest || policy.consent_granted !== true) {
    return refuse('remote_consent_required');
  }
  if (policy.advisory_status !== 'clear') return refuse('remote_advisory_blocked');
  if (!['none', 'required'].includes(policy.authorization)) {
    return refuse('remote_authorization_policy_invalid');
  }
  if (policy.revoked_artifact_digests?.has(binding.artifact_digest)
    || policy.revoked_descriptor_digests?.has(binding.descriptor_digest)) {
    return refuse('remote_authority_revoked');
  }
  return { ok: true };
}

module.exports = { evaluateInvocationAuthority };
