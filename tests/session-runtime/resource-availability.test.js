'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResourceBroker, capacityResource } = require('../../services/session-runtime/resource-broker');

const resources = [capacityResource('tests')];

test('availability hints allocate nothing and only confirmed cleanup wakes observers', async () => {
  const broker = new ResourceBroker();
  let notifications = 0;
  broker.onAvailabilityChange(() => { notifications += 1; });
  assert.equal(broker.canAcquire(resources), true);
  assert.equal(broker.snapshot().lease_count, 0);
  assert.equal(broker.snapshot().waiter_count, 0);
  const held = broker.tryAcquire({ ownerId: 'running', resources });
  assert.equal(held.status, 'granted');
  assert.equal(broker.canAcquire(resources), false);
  broker.release(held.lease, { producerSettled: false });
  await Promise.resolve();
  assert.equal(notifications, 0);
  assert.equal(broker.canAcquire(resources), false);
  assert.equal(broker.confirmCleanup(held.lease), true);
  assert.equal(notifications, 0);
  await Promise.resolve();
  assert.equal(notifications, 1);
  assert.equal(broker.canAcquire(resources), true);
  assert.equal(broker.confirmCleanup(held.lease), false);
  await Promise.resolve();
  assert.equal(notifications, 1);
});

test('existing waiters get capacity before observers and callbacks cannot undo cleanup', async () => {
  const broker = new ResourceBroker();
  const first = broker.tryAcquire({ ownerId: 'first', resources });
  const waiting = broker.acquire({ ownerId: 'queued', resources });
  const observed = [];
  broker.onAvailabilityChange(() => { throw new Error('broken observer'); });
  broker.onAvailabilityChange(() => observed.push(broker.canAcquire(resources)));
  broker.release(first.lease, { producerSettled: true });
  const next = await waiting;
  assert.deepEqual(observed, [false]);
  assert.equal(broker.snapshot().lease_count, 1);
  broker.release(next, { producerSettled: true });
  await Promise.resolve();
  assert.deepEqual(observed, [false, true]);
});

test('availability notifications coalesce, dispose, and bound observer retention', async () => {
  const broker = new ResourceBroker();
  let calls = 0;
  const remove = broker.onAvailabilityChange(() => { calls += 1; });
  const first = broker.tryAcquire({ ownerId: 'one', resources: [capacityResource('tool_operations')] });
  const second = broker.tryAcquire({ ownerId: 'two', resources: [capacityResource('tool_operations')] });
  broker.release(first.lease, { producerSettled: true });
  broker.release(second.lease, { producerSettled: true });
  await Promise.resolve();
  assert.equal(calls, 1);
  const third = broker.tryAcquire({ ownerId: 'three', resources });
  broker.release(third.lease, { producerSettled: true });
  assert.equal(remove(), true);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.throws(() => broker.onAvailabilityChange(null), /resource_observer_invalid/u);
  const removers = Array.from({ length: 8 }, () => broker.onAvailabilityChange(() => {}));
  assert.throws(() => broker.onAvailabilityChange(() => {}), /resource_observer_capacity/u);
  removers.forEach(dispose => dispose());
  assert.doesNotThrow(() => broker.onAvailabilityChange(() => {})());
});

test('an available probe cannot authorize acquisition after intervening work', () => {
  const broker = new ResourceBroker();
  assert.equal(broker.canAcquire(resources), true);
  const winner = broker.tryAcquire({ ownerId: 'winner', resources });
  assert.equal(broker.tryAcquire({ ownerId: 'later', resources }).status, 'waiting');
  assert.equal(broker.snapshot().lease_count, 1);
  broker.release(winner.lease, { producerSettled: true });
});
