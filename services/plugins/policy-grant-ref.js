'use strict';

// Generations keep their frozen `policy_grant_ref` shape. Managed (enterprise)
// policy was retired on 2026-10-02, so every install is "unmanaged": snapshot
// digest all zeros, revision 0, privileged execution allowed. This reproduces,
// byte for byte, the reference the retired managed-policy service produced for
// an unmanaged install, so stored and newly written generations stay uniform.

const crypto = require('node:crypto');

const ZERO_DIGEST = '0'.repeat(64);
const UNMANAGED_PRIVILEGED_EXECUTION = 'allow';

function digestOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function unmanagedPolicyGrantRef(base = {}) {
  const policyDigest = ZERO_DIGEST;
  const revision = 0;
  const reference = { ...base, policy_snapshot_digest: policyDigest, policy_revision: revision };
  if (Object.hasOwn(base, 'privileged_runtime_policy_digest')) {
    reference.privileged_runtime_policy_digest = digestOf({
      policyDigest, revision, privileged_execution: UNMANAGED_PRIVILEGED_EXECUTION,
    });
  }
  if (Object.hasOwn(base, 'secret_delivery_policy_digest')) {
    reference.secret_delivery_policy_digest = digestOf({
      policyDigest, revision, secret_delivery: UNMANAGED_PRIVILEGED_EXECUTION,
    });
  }
  if (Object.hasOwn(base, 'hook_policy_digest')) {
    reference.hook_policy_digest = digestOf({
      policyDigest, revision, hooks: UNMANAGED_PRIVILEGED_EXECUTION,
    });
  }
  return reference;
}

// The policy reference a mutation carries forward from the committed generation.
function policyGrantRefForMutation(generation, fallback) {
  const current = generation?.policy_grant_ref;
  return current && typeof current === 'object' ? current : fallback;
}

module.exports = { ZERO_DIGEST, unmanagedPolicyGrantRef, policyGrantRefForMutation };
