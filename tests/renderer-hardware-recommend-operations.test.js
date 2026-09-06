'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createOperationCoordinator } = require('../renderer/features/setup-scenes/hardware-recommend-operations');

test('hardware operation coordinator is exclusive and generation-fenced', () => {
  const coordinator = createOperationCoordinator();
  const generation = coordinator.mount();
  assert.equal(coordinator.acquire(), true);
  assert.equal(coordinator.acquire(), false);
  assert.equal(coordinator.isLocked(), true);
  coordinator.release(generation);
  assert.equal(coordinator.acquire(), true);
  coordinator.dispose();
  assert.equal(coordinator.isStale(generation), true);
  coordinator.mount();
  coordinator.acquire();
  coordinator.release(generation);
  assert.equal(coordinator.isLocked(), true, 'a stale continuation cannot release a newer lock');
  assert.equal(coordinator.acquire(), false);
});

test('model completion awaits persistence and ignores late settlement after disposal', async () => {
  let releasePersist;
  let completed = 0;
  let failures = 0;
  const coordinator = createOperationCoordinator({
    persistModelStep: () => new Promise((resolve) => { releasePersist = resolve; }),
    onPersistenceFailure: () => { failures += 1; },
    onModelComplete: () => { completed += 1; },
  });
  coordinator.mount();
  const pending = coordinator.completeModel(true, 'ready');
  coordinator.dispose();
  releasePersist();
  await pending;

  assert.equal(completed, 0);
  assert.equal(failures, 0);
});

test('model completion keeps the scene open when persistence rejects', async () => {
  let completed = 0;
  let failures = 0;
  const coordinator = createOperationCoordinator({
    persistModelStep: async () => { throw new Error('write failed'); },
    onPersistenceFailure: () => { failures += 1; },
    onModelComplete: () => { completed += 1; },
  });
  coordinator.mount();
  await coordinator.completeModel(true);

  assert.equal(completed, 0);
  assert.equal(failures, 1);
});
