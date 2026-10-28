'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');

function route(provider = 'ollama', resourceClass = 'local') {
  return captureRuntimeRoute({ engine_type: provider, provider_id: provider,
    configuration_revision: 'config-1', resource_class: resourceClass,
    requires_gpu: resourceClass === 'local' });
}

test('local serialization and independent cloud providers preserve per-session exclusion', () => {
  const lanes = new RuntimeLaneAdmission();
  const local = route();
  const cloud = route('chatgpt', 'cloud');
  const other = route('codex-cli', 'cloud');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'a', route: local }).status, 'granted');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'b', route: local }).reason, 'lane_capacity');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'a', route: cloud }).reason, 'session_busy');
  for (const sessionId of ['b', 'c']) {
    assert.equal(lanes.tryAcquireTurn({ sessionId, route: cloud }).status, 'granted');
  }
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'd', route: cloud }).status, 'waiting');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'd', route: other }).status, 'granted');
});

test('a priority turn takes one extra slot per lane; ordinary turns never borrow it', () => {
  const lanes = new RuntimeLaneAdmission();
  const local = route();
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'worker', route: local }).status, 'granted');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'other', route: local }).reason, 'lane_capacity');
  const primary = lanes.tryAcquireTurn({ sessionId: 'jenny', route: local, priority: true });
  assert.equal(primary.status, 'granted', 'the primary runs beside the worker');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'jenny2', route: local, priority: true }).reason, 'lane_capacity',
    'one priority slot per lane');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'other', route: local }).reason, 'lane_capacity',
    'the worker slot is still taken');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'jenny', route: local, priority: true }).reason, 'session_busy');
  assert.equal(lanes.snapshot().active_leases, 2);
  // Generation stays serialized: the inference lane has no priority slot.
  assert.equal(lanes.tryAcquireInference({ ownerId: 'w', route: local }).status, 'granted');
  assert.equal(lanes.tryAcquireInference({ ownerId: 'j', route: local }).reason, 'lane_capacity');
  // The primary alone never blocks an ordinary turn, and a priority turn cannot exceed the downstream capacity.
  assert.equal(lanes.release(primary.lease, { producerSettled: true }), true);
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'jenny', route: local, priority: true }).status, 'granted');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'other', route: local }).reason, 'lane_capacity',
    'the worker still holds the ordinary slot');
  const tight = new RuntimeLaneAdmission({ maxRunnableTurns: 1 });
  assert.equal(tight.tryAcquireTurn({ sessionId: 'worker', route: local }).status, 'granted');
  assert.equal(tight.tryAcquireTurn({ sessionId: 'jenny', route: local, priority: true }).reason, 'downstream_capacity');
  // Two priority sessions never add up to two extra slots: the first takes the single extra slot, the
  // second an ordinary slot, and the third turn (priority or not) waits.
  const two = new RuntimeLaneAdmission();
  assert.equal(two.tryAcquireTurn({ sessionId: 'p1', route: local, priority: true }).status, 'granted');
  assert.equal(two.tryAcquireTurn({ sessionId: 'p2', route: local, priority: true }).status, 'granted');
  assert.equal(two.tryAcquireTurn({ sessionId: 'p3', route: local, priority: true }).reason, 'lane_capacity');
  assert.equal(two.tryAcquireTurn({ sessionId: 'o1', route: local }).reason, 'lane_capacity');
  assert.equal(two.snapshot().active_leases, 2);
});

test('inference limits are independent from runnable turns and bounded by downstream capacity', () => {
  const lanes = new RuntimeLaneAdmission({ maxInferenceRequests: 5 });
  const cloud = route('chatgpt', 'cloud');
  lanes.tryAcquireTurn({ sessionId: 'a', route: cloud });
  for (let index = 0; index < 4; index += 1) {
    assert.equal(lanes.tryAcquireInference({ ownerId: `request-${index}`, route: cloud }).status, 'granted');
  }
  assert.equal(lanes.tryAcquireInference({ ownerId: 'over', route: cloud }).reason, 'lane_capacity');
  assert.equal(lanes.tryAcquireInference({ ownerId: 'local', route: route() }).status, 'granted');
  assert.equal(lanes.tryAcquireInference({ ownerId: 'other', route: route('codex-cli', 'cloud') }).reason,
    'downstream_capacity');
  assert.equal(lanes.snapshot().active_leases, 6);
});

test('cancellation and uncertain cleanup keep capacity until actual producer settlement', () => {
  const lanes = new RuntimeLaneAdmission();
  const local = route();
  const controller = new AbortController();
  const { lease } = lanes.tryAcquireTurn({ sessionId: 'a', route: local, signal: controller.signal });
  controller.abort();
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'b', route: local }).status, 'waiting');
  assert.equal(lanes.release(lease), false);
  assert.equal(lanes.snapshot().quarantined, 1);
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'a', route: route('chatgpt', 'cloud') }).reason, 'session_busy');
  assert.equal(lanes.confirmCleanup({ ...lease }), false);
  assert.equal(lanes.confirmCleanup(lease), true);
  assert.equal(lanes.confirmCleanup(lease), false);
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'b', route: local }).status, 'granted');
  assert.deepEqual(lanes.tryAcquireTurn({ sessionId: 'c', route: local, signal: controller.signal }),
    { status: 'rejected', reason: 'cancelled' });
});

test('waiting refusals identify the leases that consume each capacity boundary', () => {
  const local = route();
  const cloud = route('chatgpt', 'cloud');
  const otherCloud = route('codex-cli', 'cloud');
  const sessionLanes = new RuntimeLaneAdmission({ limits: { local: { runnable_turns: 2 } } });
  sessionLanes.tryAcquireTurn({ sessionId: 'shared', route: local });
  const sessionBusy = sessionLanes.tryAcquireTurn({ sessionId: 'shared', route: cloud });
  assert.deepEqual(sessionBusy, { status: 'waiting', reason: 'session_busy',
    blockers: [{ session_id: 'shared', quarantined_at: null }] });
  assert.equal(Object.isFrozen(sessionBusy.blockers), true);
  assert.equal(Object.isFrozen(sessionBusy.blockers[0]), true);

  const downstreamLanes = new RuntimeLaneAdmission({ maxRunnableTurns: 2,
    limits: { local: { runnable_turns: 2 }, cloud: { runnable_turns: 2 } } });
  downstreamLanes.tryAcquireTurn({ sessionId: 'local', route: local });
  downstreamLanes.tryAcquireTurn({ sessionId: 'cloud', route: cloud });
  assert.deepEqual(downstreamLanes.tryAcquireTurn({ sessionId: 'other', route: otherCloud }).blockers,
    [{ session_id: 'local', quarantined_at: null },
      { session_id: 'cloud', quarantined_at: null }]);

  const laneLanes = new RuntimeLaneAdmission();
  laneLanes.tryAcquireTurn({ sessionId: 'local', route: local });
  assert.deepEqual(laneLanes.tryAcquireTurn({ sessionId: 'other', route: local }), {
    status: 'waiting', reason: 'lane_capacity',
    blockers: [{ session_id: 'local', quarantined_at: null }],
  });
});

test('a quarantined lease is timestamped once and exposes that timestamp to blockers', () => {
  let now = 100;
  const lanes = new RuntimeLaneAdmission({ now: () => now });
  const local = route();
  const { lease } = lanes.tryAcquireTurn({ sessionId: 'shared', route: local });
  assert.equal(lanes.release(lease, { producerSettled: false }), false);
  now = 200;
  assert.equal(lanes.release(lease, { producerSettled: false }), false);
  assert.deepEqual(lanes.tryAcquireTurn({ sessionId: 'shared', route: route('chatgpt', 'cloud') }), {
    status: 'waiting', reason: 'session_busy',
    blockers: [{ session_id: 'shared', quarantined_at: 100 }],
  });
});

test('lowering limits does not release active work and stale tokens cannot release new leases', () => {
  let nextId = 0;
  const lanes = new RuntimeLaneAdmission({ createId: () => String(++nextId), limits: { local: { runnable_turns: 2 } } });
  const local = route();
  const first = lanes.tryAcquireTurn({ sessionId: 'a', route: local }).lease;
  const second = lanes.tryAcquireTurn({ sessionId: 'b', route: local }).lease;
  lanes.setLimits({ local: { runnable_turns: 1 } });
  assert.equal(lanes.snapshot().active_leases, 2);
  lanes.release(first, { producerSettled: true });
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'c', route: local }).status, 'waiting');
  lanes.release(second, { producerSettled: true });
  nextId = 0;
  const replacement = lanes.tryAcquireTurn({ sessionId: 'c', route: local }).lease;
  assert.equal(replacement.id, first.id);
  assert.equal(lanes.release(first, { producerSettled: true }), false);
  assert.equal(lanes.snapshot().active_leases, 1);
});

test('routes require trusted capture and cloud metadata cannot request the local GPU', () => {
  const lanes = new RuntimeLaneAdmission();
  const trusted = route();
  assert.throws(() => lanes.tryAcquireTurn({ sessionId: 'a', route: { ...trusted } }), /untrusted/);
  assert.throws(() => captureRuntimeRoute({ ...trusted, resource_class: 'cloud' }), /invalid/);
  assert.throws(() => captureRuntimeRoute({ ...trusted, endpoint_hostname: 'localhost' }), /invalid/);
  const snapshot = lanes.snapshot();
  snapshot.configured.local.runnable_turns = 16;
  assert.equal(lanes.snapshot().configured.local.runnable_turns, 1);
});

test('an inference waiter names the chat whose generation holds the lane', () => {
  const lanes = new RuntimeLaneAdmission();
  const local = route();
  assert.equal(lanes.tryAcquireInference({ ownerId: 'work_beta', sessionId: 'sess_beta', route: local }).status, 'granted');
  const waiting = lanes.tryAcquireInference({ ownerId: 'work_jenny', sessionId: 'sess_jenny', route: local });
  assert.equal(waiting.reason, 'lane_capacity');
  assert.deepEqual(waiting.blockers.map(blocker => blocker.session_id), ['sess_beta']);
  // An auxiliary owner without a chat, or a malformed id, still blocks but names nobody.
  const aux = new RuntimeLaneAdmission();
  aux.tryAcquireInference({ ownerId: 'aux_compaction', sessionId: 'bad id!', route: local });
  assert.deepEqual(aux.tryAcquireInference({ ownerId: 'w', route: local }).blockers.map(b => b.session_id), [null]);
  // The session id never turns an inference lease into a turn: the same chat's turn is not session_busy.
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'sess_beta', route: local }).status, 'granted');
});

test('queued inference re-admits are granted oldest first; stale waiters expire', () => {
  let now = 1_000;
  const lanes = new RuntimeLaneAdmission({ now: () => now });
  const local = route();
  const held = lanes.tryAcquireInference({ ownerId: 'woken', route: local, queue: true });
  assert.equal(held.status, 'granted');
  // The primary polls while the woken chat generates.
  assert.equal(lanes.tryAcquireInference({ ownerId: 'primary', route: local, queue: true }).reason, 'lane_capacity');
  lanes.release(held.lease, { producerSettled: true });
  // The woken chat's tool finished in milliseconds: it must not cut in front of the waiting primary.
  const cutIn = lanes.tryAcquireInference({ ownerId: 'woken', route: local, queue: true });
  assert.equal(cutIn.status, 'waiting');
  assert.equal(cutIn.queued, true, 'held back by the queue, not by a holder');
  now += 500;
  const primary = lanes.tryAcquireInference({ ownerId: 'primary', route: local, queue: true });
  assert.equal(primary.status, 'granted');
  lanes.release(primary.lease, { producerSettled: true });
  assert.equal(lanes.tryAcquireInference({ ownerId: 'woken', route: local, queue: true }).status, 'granted');
});

test('the inference queue ignores unqueued callers, expired waiters and forgotten owners', () => {
  let now = 1_000;
  const lanes = new RuntimeLaneAdmission({ now: () => now });
  const local = route();
  const acquire = (ownerId, queue = true) => lanes.tryAcquireInference({ ownerId, route: local, queue });
  const held = acquire('a', false);
  assert.equal(acquire('b').status, 'waiting');
  lanes.release(held.lease, { producerSettled: true });
  // A turn start (unqueued) is not held behind the poller.
  const start = acquire('c', false);
  assert.equal(start.status, 'granted');
  lanes.release(start.lease, { producerSettled: true });
  // 'b' stopped polling (its turn was cancelled): after the TTL it no longer holds the queue.
  now += 3_001;
  const next = acquire('d');
  assert.equal(next.status, 'granted');
  lanes.release(next.lease, { producerSettled: true });
  // A closed gateway forgets its waiter at once.
  const held2 = acquire('x', false);
  assert.equal(acquire('f').status, 'waiting');
  lanes.release(held2.lease, { producerSettled: true });
  assert.equal(acquire('g').status, 'waiting', "'f' is still ahead");
  lanes.forgetInferenceWaiter('f');
  assert.equal(acquire('g').status, 'granted');
});
