'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FakeStore,
  createRegistry,
  reserve,
} = require('./helpers/session-turn-actor-harness');

test('paused runtime cleanup accepts only the exact idle deletion owner', async () => {
  const store = new FakeStore({ s1: {}, s2: {} });
  const registry = createRegistry();
  const idleDeletion = registry.beginDeletion('s1');

  assert.equal(registry.provePausedRuntimeCleanup('s1', idleDeletion), true);
  assert.equal(registry.provePausedRuntimeCleanup('s1', { ...idleDeletion }), false);
  assert.equal(registry.provePausedRuntimeCleanup('s2', idleDeletion), false);

  const lease = reserve(registry, store, 's2');
  const activeDeletion = registry.beginDeletion('s2');
  assert.equal(registry.provePausedRuntimeCleanup('s2', activeDeletion), false);
  registry.release(lease, { status: 'cancelled' });
  assert.equal((await registry.awaitQuiescence(activeDeletion, { timeoutMs: 50 })).ok, true);
  assert.equal(registry.provePausedRuntimeCleanup('s2', activeDeletion), false,
    'a deletion that owned a live lease is never substituted for paused-work cleanup proof');

  assert.equal(registry.rollbackDeletion(activeDeletion), true);
  assert.equal(registry.rollbackDeletion(idleDeletion), true);
});
