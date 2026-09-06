'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_TOKENS,
  REQUIRED_BINDINGS,
  RestrictedTokenService,
} = require('../../../services/plugins/restricted-host/token-service');

function authority(overrides = {}) {
  const digests = new Set(['artifact_digest', 'component_digest', 'argument_hash']);
  const integers = new Set([
    'commit_epoch', 'lifecycle_epoch', 'policy_revision', 'revocation_generation',
    'deadline_epoch_ms',
  ]);
  return Object.fromEntries(REQUIRED_BINDINGS.map((field) => [field,
    overrides[field] ?? (field === 'destination' ? ''
      : field === 'purpose' ? 'restricted_runtime'
        : digests.has(field) ? '1'.repeat(64) : integers.has(field) ? 1 : `${field}_1`)]));
}

test('atomic token ledger rejects replay, forwarding, expiry, and revocation', () => {
  let now = 10;
  let byte = 1;
  const service = new RestrictedTokenService({ now: () => now, randomBytes: () => Buffer.alloc(32, byte++) });
  const current = authority({ commit_epoch: 1, lifecycle_epoch: 2, policy_revision: 3, revocation_generation: 4 });
  const minted = service.mint(current, { lifetimeMs: 50, uses: 1 });
  assert.equal(minted.ok, true);
  assert.equal(service.consume(minted.token_id, current).ok, true);
  assert.equal(service.consume(minted.token_id, current).reason, 'token_unknown_or_replayed');

  const forwarded = service.mint(current, { lifetimeMs: 50 });
  assert.equal(service.consume(forwarded.token_id, { ...current, channel_id: 'channel_2' }).reason, 'channel_id_mismatch');
  assert.equal(service.consume(forwarded.token_id, {
    ...current, workspace_incarnation_id: 'workspace_incarnation_id_2',
  }).reason, 'workspace_incarnation_id_mismatch');
  assert.equal(service.consume(forwarded.token_id, { ...current, commit_epoch: 2 }).reason,
    'commit_epoch_mismatch');
  now = 100;
  assert.equal(service.consume(forwarded.token_id, current).reason, 'token_expired');

  now = 10;
  const revoked = service.mint(current);
  assert.equal(service.revokeInvocation(current.invocation_id), 1);
  assert.equal(service.consume(revoked.token_id, current).reason, 'token_unknown_or_replayed');

  const overuse = service.mint({ ...current, invocation_id: 'inv_overuse' }, {
    lifetimeMs: 50, uses: 2,
  });
  const overuseAuthority = { ...current, invocation_id: 'inv_overuse' };
  assert.equal(service.consume(overuse.token_id, overuseAuthority).uses_remaining, 1);
  assert.equal(service.consume(overuse.token_id, overuseAuthority).uses_remaining, 0);
  assert.equal(service.consume(overuse.token_id, overuseAuthority).reason,
    'token_unknown_or_replayed');

  const generationRevoked = service.mint({ ...current, invocation_id: 'inv_generation' });
  assert.equal(service.revokeGeneration(current.generation_id), 1);
  assert.equal(service.consume(generationRevoked.token_id, {
    ...current, invocation_id: 'inv_generation',
  }).reason, 'token_unknown_or_replayed');
});

test('mint fails closed on missing bindings and out-of-range budgets', () => {
  const service = new RestrictedTokenService();
  const missing = authority(); delete missing.argument_hash;
  assert.equal(service.mint(missing).ok, false);
  assert.equal(service.mint(authority(), { uses: 33 }).ok, false);
  assert.equal(service.mint(authority(), { lifetimeMs: 30001 }).ok, false);
});

test('the token ledger refuses nonce collisions and saturation without evicting live authority', () => {
  const collision = new RestrictedTokenService({ randomBytes: () => Buffer.alloc(32, 7) });
  assert.equal(collision.mint(authority()).ok, true);
  assert.equal(collision.mint(authority()).reason, 'token_nonce_invalid');

  let nonce = 0;
  const saturated = new RestrictedTokenService({
    randomBytes: () => {
      const value = Buffer.alloc(32);
      value.writeUInt32BE(nonce++ >>> 0, 28);
      return value;
    },
  });
  for (let index = 0; index < MAX_TOKENS; index += 1) {
    assert.equal(saturated.mint(authority({ invocation_id: `inv_${index}` })).ok, true);
  }
  assert.equal(saturated.mint(authority({ invocation_id: 'inv_overflow' })).reason,
    'token_ledger_saturated');
  assert.equal(saturated.snapshot().active_tokens, MAX_TOKENS);
});
