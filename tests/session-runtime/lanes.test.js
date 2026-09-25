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
