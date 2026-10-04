'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ZERO_DIGEST, unmanagedPolicyGrantRef, policyGrantRefForMutation,
} = require('../../services/plugins/policy-grant-ref');

// The literals below were captured from the retired managed-policy service
// (unmanaged state: zero digest, revision 0, privileged execution allowed) and
// pin that the stored policy_grant_ref shape is unchanged by the retirement.
test('unmanaged policy grant ref keeps the zero snapshot and revision 0', () => {
  const base = { policy_snapshot_digest: 'f'.repeat(64), policy_revision: 3, grant_set_digest: ZERO_DIGEST };
  assert.deepEqual(unmanagedPolicyGrantRef(base), {
    policy_snapshot_digest: ZERO_DIGEST, policy_revision: 0, grant_set_digest: ZERO_DIGEST,
  });
  assert.equal(base.policy_revision, 3, 'the input reference is never mutated');
});

test('unmanaged policy grant ref rehashes only the stage 8 digests that are present', () => {
  const ref = unmanagedPolicyGrantRef({
    privileged_runtime_policy_digest: '1'.repeat(64),
    secret_delivery_policy_digest: '2'.repeat(64),
    hook_policy_digest: '3'.repeat(64),
  });
  assert.equal(ref.privileged_runtime_policy_digest,
    'df3f529ce12aa23ffcab088e0a3255a769cc01da51b2681d60a27f6e3592ee14');
  assert.equal(ref.secret_delivery_policy_digest,
    '63f21cd764df7eee12991c44223dba8119481990ac18cd37de07aab571da1183');
  assert.equal(ref.hook_policy_digest,
    '6c77989e1915069e76f9a87355bf24c921c23f785904396549ff25a4646e0c74');
  assert.deepEqual(Object.keys(unmanagedPolicyGrantRef({ grant_set_digest: ZERO_DIGEST })).sort(),
    ['grant_set_digest', 'policy_revision', 'policy_snapshot_digest']);
});

test('a mutation carries the committed generation reference, else the fallback', () => {
  const fallback = { policy_snapshot_digest: ZERO_DIGEST, policy_revision: 0 };
  const stored = { policy_snapshot_digest: 'a'.repeat(64), policy_revision: 2 };
  assert.equal(policyGrantRefForMutation({ policy_grant_ref: stored }, fallback), stored);
  assert.equal(policyGrantRefForMutation({}, fallback), fallback);
  assert.equal(policyGrantRefForMutation(null, fallback), fallback);
});
