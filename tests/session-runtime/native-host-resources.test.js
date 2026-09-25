'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createHostResourceAdmission,
} = require('../../services/plugins/full-host/host-resource-admission');
const {
  ResourceBroker,
  capacityResource,
} = require('../../services/session-runtime/resource-broker');

function setup(limit = 1) {
  let leaseId = 0;
  const broker = new ResourceBroker({
    limits: { native_processes: limit },
    createId: () => `lease-${++leaseId}`,
  });
  const resources = createHostResourceAdmission({
    resourceAdmissionProvider: () => ({ broker }),
  });
  return { broker, resources };
}

function request(overrides = {}) {
  return {
    sessionId: 'session-1',
    sessionEpoch: 1,
    identity: { publisher_id: 'publisher', plugin_id: 'plugin', contribution_id: 'host' },
    validate: () => true,
    ...overrides,
  };
}

test('native host admission is nonblocking and holds no partial waiter at capacity', () => {
  const { broker, resources } = setup();
  const held = broker.tryAcquire({
    ownerId: 'existing-host',
    resources: [capacityResource('native_processes')],
  });
  assert.equal(held.status, 'granted');

  const blocked = resources.tryStart(request());
  assert.deepEqual({ ok: blocked.ok, reason: blocked.reason, retryable: blocked.retryable,
    no_start: blocked.no_start }, {
    ok: false,
    reason: 'native_host_resource_capacity',
    retryable: true,
    no_start: true,
  });
  assert.equal(broker.snapshot().waiter_count, 0);
  assert.equal(broker.snapshot().lease_count, 1);
  broker.release(held.lease, { producerSettled: true });
});

test('attempted host capacity stays quarantined until exact complete native proof', () => {
  const { broker, resources } = setup();
  const admitted = resources.tryStart(request());
  assert.equal(admitted.ok, true);
  assert.equal(resources.markAttempted(admitted.handle), true);
  resources.quarantine(admitted.handle, 'native_start_timeout');
  assert.equal(broker.snapshot().quarantined_count, 1);

  resources.settleTermination({ sessionId: 'session-1', sessionEpoch: 2,
    proof: { terminated: true, tree_empty: true, output_readers_terminated: true } });
  assert.equal(broker.snapshot().lease_count, 1, 'another epoch cannot release the lease');

  const oldBinary = resources.settleTermination({ sessionId: 'session-1', sessionEpoch: 1,
    proof: { terminated: true, tree_empty: true } });
  assert.equal(oldBinary.cleanup, 'uncertain');
  assert.equal(broker.snapshot().lease_count, 1);

  const completed = resources.settleTermination({ sessionId: 'session-1', sessionEpoch: 1,
    proof: { terminated: true, tree_empty: true, output_readers_terminated: true } });
  assert.equal(completed.cleanup, 'confirmed');
  assert.equal(broker.snapshot().lease_count, 0);
  assert.deepEqual(resources.snapshot(), { active: 0, quarantined: 0 });
});

test('positive no-start evidence releases admission before producer dispatch', () => {
  const { broker, resources } = setup();
  const admitted = resources.tryStart(request());
  const cleanup = resources.settleNoStart(admitted.handle, 'authority_stale_before_spawn');
  assert.equal(cleanup.cleanup, 'confirmed');
  assert.equal(cleanup.producer_started, false);
  assert.equal(broker.snapshot().lease_count, 0);
});

test('declared unavailable provider fails closed without minting a lease', () => {
  const resources = createHostResourceAdmission({ resourceAdmissionProvider: () => ({}) });
  const rejected = resources.tryStart(request());
  assert.equal(rejected.reason, 'native_host_resource_unavailable');
  assert.equal(rejected.no_start, true);
  assert.equal(rejected.resource_cleanup.cleanup, 'confirmed');
});

test('the long-lived supervisor consumes one native slot and reduces the reported host limit', () => {
  const { broker, resources } = setup(2);
  assert.equal(resources.effectiveHostLimit(2), 1);
  const admitted = resources.trySupervisorStart({ validate: () => true });
  assert.equal(admitted.ok, true);
  assert.equal(resources.markSupervisorAttempted(admitted.handle), true);
  assert.equal(resources.markSupervisorSpawned(admitted.handle), true);
  assert.equal(broker.snapshot().capacity.native_processes, 1);

  const host = resources.tryStart(request());
  assert.equal(host.ok, true);
  const blocked = resources.tryStart(request({ sessionId: 'session-2' }));
  assert.equal(blocked.reason, 'native_host_resource_capacity');
  assert.equal(broker.snapshot().waiter_count, 0);
});

test('supervisor cleanup releases only after process and output streams close', () => {
  const { broker, resources } = setup(2);
  const supervisor = resources.trySupervisorStart({ validate: () => true });
  resources.markSupervisorAttempted(supervisor.handle);
  resources.markSupervisorSpawned(supervisor.handle);
  const host = resources.tryStart(request());
  resources.markAttempted(host.handle);
  resources.quarantine(host.handle, 'supervisor_lost');
  resources.quarantineSupervisor(supervisor.handle, 'supervisor_lost');

  const uncertain = resources.settleSupervisorClose(supervisor.handle, {
    processClosed: true, outputReadersTerminated: false, sessions: [
      { session_id: 'session-1', session_epoch: 1 },
    ],
  });
  assert.equal(uncertain.cleanup, 'uncertain');
  assert.equal(broker.snapshot().lease_count, 2);
  const confirmed = resources.settleSupervisorClose(supervisor.handle, {
    processClosed: true, outputReadersTerminated: true, sessions: [
      { session_id: 'session-1', session_epoch: 1 },
    ],
  });
  assert.equal(confirmed.cleanup, 'confirmed');
  assert.equal(broker.snapshot().lease_count, 1);

  const prior = resources.applyPriorSupervisorProof({ sessionId: 'session-1', sessionEpoch: 1,
    proof: { known: true, reaped: true, tree_empty: true,
      output_readers_terminated: false } });
  assert.equal(prior.output_readers_terminated, true);
  assert.equal(prior.previous_supervisor_terminated, true);
  resources.settleTermination({ sessionId: 'session-1', sessionEpoch: 1, proof: prior });
  assert.equal(broker.snapshot().lease_count, 0);
});

test('a synchronous supervisor spawn failure is trusted no-start evidence', () => {
  const { broker, resources } = setup(2);
  const admitted = resources.trySupervisorStart({ validate: () => true });
  resources.markSupervisorAttempted(admitted.handle);
  const cleanup = resources.settleSupervisorNoStart(admitted.handle, 'supervisor_spawn_failed');
  assert.equal(cleanup.cleanup, 'confirmed');
  assert.equal(cleanup.producer_started, false);
  assert.equal(broker.snapshot().lease_count, 0);
});
