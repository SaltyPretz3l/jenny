'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ERROR_GPU_BUSY,
  ERROR_STALE_LEASE,
  EXCLUSIVE_GPU_STATE_EVENT,
  ExclusiveGpuCoordinator,
  STATE_CHAT_RESIDENT,
  STATE_PRIVILEGED_RESIDENT,
  STATE_TRANSITIONING,
} = require('../services/backend/exclusive-gpu-coordinator');

const OWNER = Object.freeze({
  kind: 'plugin',
  publisher_id: 'jenny-official',
  plugin_id: 'local-image-generation',
  operation_id: 'operation-1',
});

function coordinator() {
  let counter = 0;
  return new ExclusiveGpuCoordinator({
    leaseIdFactory: () => `lease-${++counter}`,
  });
}

test('starts chat-resident and acquires one identity-bound exclusive lease', async () => {
  const value = coordinator();
  const events = [];
  value.on(EXCLUSIVE_GPU_STATE_EVENT, (event) => events.push(event));

  assert.deepEqual(value.getState(), { state: STATE_CHAT_RESIDENT, leaseId: null });
  const lease = await value.acquireExclusiveLease({ owner: OWNER });
  assert.deepEqual(lease, { leaseId: 'lease-1' });
  assert.deepEqual(value.getState(), { state: STATE_TRANSITIONING, leaseId: 'lease-1' });
  assert.deepEqual(events, [{ state: STATE_TRANSITIONING, leaseId: 'lease-1' }]);
});

test('a second workload is rejected while the lease is held', async () => {
  const value = coordinator();
  await value.acquireExclusiveLease({ owner: OWNER });
  await assert.rejects(
    value.acquireExclusiveLease({ owner: { ...OWNER, operation_id: 'operation-2' } }),
    (error) => error.code === ERROR_GPU_BUSY,
  );
});

test('promotion, assertion, and release all require exact owner identity', async () => {
  const value = coordinator();
  const { leaseId } = await value.acquireExclusiveLease({ owner: OWNER });
  assert.equal(value.markPrivilegedResident(leaseId, OWNER).state, STATE_PRIVILEGED_RESIDENT);
  assert.equal(value.assertLease(leaseId, OWNER), true);
  assert.throws(
    () => value.assertLease(leaseId, { ...OWNER, operation_id: 'stale-operation' }),
    (error) => error.code === ERROR_STALE_LEASE,
  );
  assert.equal(value.releaseLease(leaseId, { ...OWNER, operation_id: 'stale-operation' }), false);
  assert.equal(value.getState().state, STATE_PRIVILEGED_RESIDENT);
  assert.equal(value.releaseLease(leaseId, OWNER), true);
  assert.deepEqual(value.getState(), { state: STATE_CHAT_RESIDENT, leaseId: null });
});

test('state events preserve the lease and stale release is a no-op', async () => {
  const value = coordinator();
  const events = [];
  value.on(EXCLUSIVE_GPU_STATE_EVENT, (event) => events.push(event));
  const { leaseId } = await value.acquireExclusiveLease({ owner: OWNER });
  value.markPrivilegedResident(leaseId, OWNER);
  const before = events.length;

  assert.equal(value.releaseLease('stale-lease', OWNER), false);
  assert.equal(events.length, before);
  assert.deepEqual(value.getState(), { state: STATE_PRIVILEGED_RESIDENT, leaseId });
  assert.deepEqual(events.map((event) => event.state), [
    STATE_TRANSITIONING, STATE_PRIVILEGED_RESIDENT,
  ]);
});

test('invalid owner identities fail before a lease is allocated', async () => {
  const value = coordinator();
  await assert.rejects(
    value.acquireExclusiveLease({ owner: { kind: 'plugin' } }),
    (error) => error.code === ERROR_STALE_LEASE,
  );
  assert.deepEqual(value.getState(), { state: STATE_CHAT_RESIDENT, leaseId: null });
});

test('dispose clears state and refuses later acquisition', async () => {
  const value = coordinator();
  await value.acquireExclusiveLease({ owner: OWNER });
  value.dispose();
  assert.deepEqual(value.getState(), { state: STATE_CHAT_RESIDENT, leaseId: null });
  await assert.rejects(
    value.acquireExclusiveLease({ owner: OWNER }),
    (error) => error.code === ERROR_GPU_BUSY,
  );
});
