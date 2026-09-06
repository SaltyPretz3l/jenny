'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateInvocationAuthority } = require('../../../services/plugins/remote-mcp/invocation-authority');
const { remoteBinding } = require('../../helpers/plugins/remote-mcp-fixtures');

function context() {
  const binding = remoteBinding();
  const contribution = { namespaced_name: 'plugin:remote:server:tool:search:abc' };
  return { binding, runtimeBinding: binding, contribution,
    invocation: { binding_digest: binding.binding_digest,
      descriptor_digest: binding.descriptor_digest, namespaced_name: contribution.namespaced_name },
    current: { publisher_id: binding.publisher_id, plugin_id: binding.plugin_id,
      generation_id: binding.generation_id, artifact_digest: binding.artifact_digest,
      commit_epoch: binding.commit_epoch, lifecycle_state: 'active',
      activation_scope: 'stage5_remote_mcp' },
    policy: { stage5_enabled: true, consent_granted: true,
      consent_digest: binding.consent_digest, advisory_status: 'clear',
      authorization: 'none',
      revoked_artifact_digests: new Set(), revoked_descriptor_digests: new Set() } };
}

test('authority requires every current generation, binding, consent, and advisory proof', () => {
  assert.equal(evaluateInvocationAuthority(context()).ok, true);
  for (const [path, value, reason] of [
    ['current.commit_epoch', 4, 'remote_generation_stale'],
    ['invocation.binding_digest', '9'.repeat(64), 'remote_invocation_stale'],
    ['policy.consent_granted', false, 'remote_consent_required'],
    ['policy.advisory_status', 'blocked', 'remote_advisory_blocked'],
    ['policy.authorization', 'invalid', 'remote_authorization_policy_invalid'],
    ['policy.stage5_enabled', false, 'stage5_production_exposure_forbidden'],
    ['current.activation_scope', 'first_party_skill_prompt', 'remote_descriptor_inactive'],
  ]) {
    const input = context();
    const [owner, key] = path.split('.'); input[owner][key] = value;
    assert.equal(evaluateInvocationAuthority(input).reason, reason);
  }
});

test('artifact and descriptor revocation invalidate authority per call', () => {
  const artifact = context();
  artifact.policy.revoked_artifact_digests.add(artifact.binding.artifact_digest);
  assert.equal(evaluateInvocationAuthority(artifact).reason, 'remote_authority_revoked');
  const descriptor = context();
  descriptor.policy.revoked_descriptor_digests.add(descriptor.binding.descriptor_digest);
  assert.equal(evaluateInvocationAuthority(descriptor).reason, 'remote_authority_revoked');
});
