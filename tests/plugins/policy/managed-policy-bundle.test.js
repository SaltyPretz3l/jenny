'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  verifyManagedPolicyBundle,
} = require('../../../services/plugins/policy/managed-policy-bundle');

const { signedBundle, NOW } = require('../../helpers/plugins/managed-policy-bundle-fixture');

test('strictly verifies a signed administrative policy in its own key domain', () => {
  const result = verifyManagedPolicyBundle(signedBundle(), { now: () => NOW });
  assert.equal(result.ok, true);
  assert.equal(result.policy.privileged_execution, 'deny');
  assert.match(result.policy_digest, /^[0-9a-f]{64}$/);
  assert.match(result.key_id, /^[0-9a-f]{64}$/);
});

test('rejects tampering, future formats, stale policy, and extra fields', () => {
  const tampered = JSON.parse(signedBundle().toString('utf8'));
  tampered.policy.privileged_execution = 'allow';
  assert.equal(verifyManagedPolicyBundle(Buffer.from(JSON.stringify(tampered)), { now: () => NOW }).reason,
    'managed_policy_signature_invalid');
  const future = JSON.parse(signedBundle().toString('utf8'));
  future.managed_policy_bundle_version = 2;
  assert.equal(verifyManagedPolicyBundle(Buffer.from(JSON.stringify(future)), { now: () => NOW }).reason,
    'managed_policy_bundle_version_unsupported');
  assert.equal(verifyManagedPolicyBundle(signedBundle({ expires_at: '2026-08-10T11:30:00.000Z' }), { now: () => NOW }).reason,
    'managed_policy_stale');
  const extra = JSON.parse(signedBundle().toString('utf8'));
  extra.policy.unknown = true;
  assert.equal(verifyManagedPolicyBundle(Buffer.from(JSON.stringify(extra)), { now: () => NOW }).reason,
    'managed_policy_payload_malformed');
});

test('rejects malformed keys, signatures, publisher/source lists, and bounds', () => {
  const keyMismatch = JSON.parse(signedBundle().toString('utf8'));
  keyMismatch.signature.key_id = '0'.repeat(64);
  assert.equal(verifyManagedPolicyBundle(Buffer.from(JSON.stringify(keyMismatch)), { now: () => NOW }).reason,
    'managed_policy_key_binding_invalid');
  assert.equal(verifyManagedPolicyBundle(signedBundle({ allowed_source_kinds: ['developer_link'] }), { now: () => NOW }).reason,
    'managed_policy_sources_invalid');
  assert.equal(verifyManagedPolicyBundle(signedBundle({ audit_max_entries: 1001 }), { now: () => NOW }).reason,
    'managed_policy_audit_bound_invalid');
});
