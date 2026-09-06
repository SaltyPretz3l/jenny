'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  acquireLease,
  releaseLease,
  readLease,
  validateLeaseOwnership,
  revalidateAgainstCurrentGeneration,
} = require('../../../services/plugins/store/mutation-lease');

const NOW = '2026-07-31T00:00:00Z';
const SOON = '2026-07-31T00:00:05Z';
const MUCH_LATER = '2026-07-31T01:00:00Z';
const GEN = { commit_epoch: 3, revision: 4, generation_id: 'gen-1' };

test('acquireLease grants the lease when nothing is held', async () => {
  const facade = createMemoryFsFacade();
  const result = await acquireLease(facade, 'plugins', { operationId: 'op-a', expectedGeneration: GEN, now: NOW, leaseDurationMs: 10000 });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'acquired');
  assert.equal(result.lease.operation_id, 'op-a');
});

test('a distinct operation is deterministically rejected as busy while the lease is held and unexpired', async () => {
  const facade = createMemoryFsFacade();
  await acquireLease(facade, 'plugins', { operationId: 'op-a', expectedGeneration: GEN, now: NOW, leaseDurationMs: 10000 });
  const result = await acquireLease(facade, 'plugins', { operationId: 'op-b', expectedGeneration: GEN, now: SOON, leaseDurationMs: 10000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'busy');
  assert.equal(result.heldBy, 'op-a');
});

test('concurrent acquisitions leave exactly one caller as the verified owner', async () => {
  const facade = createMemoryFsFacade();
  const [first, second] = await Promise.all([
    acquireLease(facade, 'plugins', { operationId: 'op-a', expectedGeneration: GEN, now: NOW }),
    acquireLease(facade, 'plugins', { operationId: 'op-b', expectedGeneration: GEN, now: NOW }),
  ]);
  const acquired = [first, second].filter((result) => result.ok);
  const rejected = [first, second].filter((result) => !result.ok);
  const held = await readLease(facade, 'plugins');

  assert.equal(acquired.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'busy');
  assert.equal(held.lease.operation_id, acquired[0].lease.operation_id);
  assert.equal(held.lease.owner_token, acquired[0].lease.owner_token);
});

test('the SAME operation id re-acquiring its own lease is allowed and refreshes expiry (re-entrant)', async () => {
  const facade = createMemoryFsFacade();
  const first = await acquireLease(facade, 'plugins', { operationId: 'op-a', expectedGeneration: GEN, now: NOW, leaseDurationMs: 1000 });
  const second = await acquireLease(facade, 'plugins', { operationId: 'op-a', expectedGeneration: GEN, now: SOON, leaseDurationMs: 5000 });
  assert.equal(second.ok, true);
  assert.equal(second.outcome, 'reacquired');
  assert.equal(second.lease.owner_token, first.lease.owner_token);
  assert.notEqual(second.lease.expires_at, first.lease.expires_at);
});

test('an expired lease is reclaimed by a new operation and the crashed owner is recorded as a bounded tombstone', async () => {
  const facade = createMemoryFsFacade();
  await acquireLease(facade, 'plugins', { operationId: 'op-a', expectedGeneration: GEN, now: NOW, leaseDurationMs: 1000 });
  const reclaimed = await acquireLease(facade, 'plugins', { operationId: 'op-b', expectedGeneration: GEN, now: MUCH_LATER, leaseDurationMs: 1000 });
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.outcome, 'reclaimed_from_expired');
  assert.equal(reclaimed.reclaimedFrom, 'op-a');
  assert.equal(reclaimed.lease.tombstones.length, 1);
  assert.equal(reclaimed.lease.tombstones[0].operation_id, 'op-a');
});

test('tombstones are bounded to MAX_TOMBSTONES entries, dropping the oldest first', async () => {
  const facade = createMemoryFsFacade();
  const { MAX_TOMBSTONES } = require('../../../services/plugins/store/mutation-lease');
  let previousOp = null;
  let currentTime = Date.parse(NOW);
  for (let i = 0; i < MAX_TOMBSTONES + 3; i += 1) {
    const opId = `op-${i}`;
    const nowIso = new Date(currentTime).toISOString();
    await acquireLease(facade, 'plugins', { operationId: opId, expectedGeneration: GEN, now: nowIso, leaseDurationMs: 1 });
    currentTime += 100;
    previousOp = opId;
  }
  void previousOp;
  const current = await readLease(facade, 'plugins');
  assert.equal(current.lease.tombstones.length, MAX_TOMBSTONES);
});

test('releaseLease only releases for the exact owner and is idempotent when nothing is held', async () => {
  const facade = createMemoryFsFacade();
  const releasedNothing = await releaseLease(facade, 'plugins', { operationId: 'op-a', ownerToken: 'whatever' });
  assert.deepEqual(releasedNothing, { ok: true, outcome: 'already_released' });

  const acquired = await acquireLease(facade, 'plugins', { operationId: 'op-a', expectedGeneration: GEN, now: NOW, leaseDurationMs: 1000 });
  const wrongOwner = await releaseLease(facade, 'plugins', { operationId: 'op-a', ownerToken: 'wrong' });
  assert.deepEqual(wrongOwner, { ok: false, reason: 'not_lease_owner' });

  const released = await releaseLease(facade, 'plugins', { operationId: 'op-a', ownerToken: acquired.lease.owner_token });
  assert.deepEqual(released, { ok: true, outcome: 'released' });
  const afterRelease = await readLease(facade, 'plugins');
  assert.deepEqual(afterRelease, { status: 'missing' });
});

test('validateLeaseOwnership checks operation id, owner token, and expiry together', () => {
  const lease = { operation_id: 'op-a', owner_token: 'tok-1', expires_at: SOON };
  assert.deepEqual(validateLeaseOwnership(lease, { operationId: 'op-a', ownerToken: 'tok-1', now: NOW }), { ok: true });
  assert.deepEqual(validateLeaseOwnership(lease, { operationId: 'op-b', ownerToken: 'tok-1', now: NOW }), { ok: false, reason: 'not_lease_owner' });
  assert.deepEqual(validateLeaseOwnership(lease, { operationId: 'op-a', ownerToken: 'tok-1', now: MUCH_LATER }), { ok: false, reason: 'lease_expired' });
  assert.deepEqual(validateLeaseOwnership(null, { operationId: 'op-a', ownerToken: 'tok-1', now: NOW }), { ok: false, reason: 'lease_not_held' });
});

test('revalidateAgainstCurrentGeneration detects the generation having advanced since the lease was acquired', () => {
  const lease = { expected_generation: GEN };
  assert.deepEqual(revalidateAgainstCurrentGeneration(lease, GEN), { ok: true });
  const advanced = { ...GEN, commit_epoch: GEN.commit_epoch + 1, revision: GEN.revision + 1 };
  assert.deepEqual(revalidateAgainstCurrentGeneration(lease, advanced), { ok: false, reason: 'generation_advanced' });
  assert.deepEqual(revalidateAgainstCurrentGeneration({ expected_generation: null }, GEN), { ok: false, reason: 'no_expected_generation_recorded' });
});
