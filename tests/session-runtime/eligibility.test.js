'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ResourceBroker, capacityResource, filesystemResource } = require('../../services/session-runtime/resource-broker');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');
const { RuntimeEligibilityCoordinator } = require('../../services/session-runtime/eligibility');

const resources = [capacityResource('tests')];
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(t, options = {}) {
  const broker = new ResourceBroker();
  const works = new Map();
  const calls = [];
  const attention = [];
  const coordinator = new RuntimeEligibilityCoordinator({ broker, incarnation: 'current',
    getWork: id => works.get(id), enabled: true,
    resume: (id, revision) => { calls.push([id, revision]); return { status: 'accepted' }; },
    onAttention: event => attention.push(event), ...options });
  t.after(() => coordinator.dispose());
  function add(id, sequence = works.size + 1, sessionId = 'session_1') {
    const attempt = { attempt_id: `${id}_attempt`, stream_id: `${id}_stream`,
      incarnation: 'current', authority_revision: 'scope_1' };
    const work = { work_id: id, session_id: sessionId, revision: 4, submission_sequence: sequence,
      status: 'paused', control_request: null, attempt,
      transition: { reason: 'checkpoint_suspended' },
      checkpoint_ref: { checkpoint_id: `${id}_checkpoint`, source_attempt: { ...attempt } } };
    works.set(id, work);
    return work;
  }
  return { broker, coordinator, works, calls, attention, add,
    enable: value => coordinator.setEnabled(value) };
}

test('live checkpoint waits own no leases and resume once after confirmed resource cleanup', async t => {
  const h = harness(t);
  h.add('waiting');
  const held = h.broker.tryAcquire({ ownerId: 'producer', resources });
  assert.equal(h.coordinator.track('waiting', resources).status, 'tracked');
  await tick();
  assert.deepEqual(h.calls, []);
  assert.equal(h.broker.snapshot().waiter_count, 0);
  assert.equal(h.broker.snapshot().lease_count, 1);
  h.broker.release(held.lease, { producerSettled: false });
  await tick();
  assert.deepEqual(h.calls, []);
  h.broker.confirmCleanup(held.lease);
  await tick();
  assert.deepEqual(h.calls, [['waiting', 4]]);
  h.coordinator.wake();
  await tick();
  assert.deepEqual(h.calls, [['waiting', 4]]);
  assert.equal(h.coordinator.snapshot().wait_count, 0);
});

test('revision, cancellation, incarnation and explicit pause changes invalidate automatic eligibility', async t => {
  const h = harness(t);
  const changed = h.add('changed');
  const cancelled = h.add('cancelled');
  const paused = h.add('paused');
  const restarted = h.add('restarted');
  restarted.attempt.incarnation = 'previous';
  restarted.checkpoint_ref.source_attempt.incarnation = 'previous';
  assert.equal(h.coordinator.track('restarted', resources).reason, 'runtime_wait_not_live');
  for (const id of ['changed', 'cancelled', 'paused']) h.coordinator.track(id, resources);
  changed.revision += 1;
  cancelled.control_request = { kind: 'cancel' };
  paused.transition.reason = 'explicit_pause';
  await tick();
  assert.deepEqual(h.calls, []);
  assert.equal(h.coordinator.snapshot().wait_count, 0);
});

test('OFF and disposal discard automatic eligibility without resuming on re-enable', async t => {
  const h = harness(t);
  h.add('one');
  h.coordinator.track('one', resources);
  h.enable(false);
  await tick();
  h.enable(true);
  h.coordinator.wake();
  await tick();
  assert.deepEqual(h.calls, []);
  h.coordinator.track('one', resources);
  h.coordinator.dispose();
  await tick();
  assert.deepEqual(h.calls, []);
  assert.equal(h.coordinator.track('one', resources).reason, 'runtime_eligibility_disabled');
});

test('session and stream cancellation clear only their owned live waits', t => {
  const h = harness(t);
  const first = h.add('first', 1, 'session_first');
  const second = h.add('second', 2, 'session_second');
  const third = h.add('third', 3, 'session_third');
  h.coordinator.track(first.work_id, resources);
  h.coordinator.track(second.work_id, resources);
  h.coordinator.track(third.work_id, resources);

  assert.equal(h.coordinator.clearSession('session_first'), 1);
  assert.equal(h.coordinator.forgetStream(second.attempt.stream_id), 1);
  assert.equal(h.coordinator.snapshot().wait_count, 1);
  assert.equal(h.coordinator.forget(third.work_id), true);
  assert.equal(h.coordinator.snapshot().wait_count, 0);
});

test('an idle blocked wait cannot survive OFF then ON without an intervening resource signal', async t => {
  const h = harness(t);
  h.add('one');
  const held = h.broker.tryAcquire({ ownerId: 'producer', resources });
  h.coordinator.track('one', resources);
  await tick();
  assert.equal(h.coordinator.snapshot().wait_count, 1);
  h.enable(false);
  assert.equal(h.coordinator.snapshot().wait_count, 0);
  await tick();
  h.enable(true);
  h.broker.release(held.lease, { producerSettled: true });
  await tick();
  assert.deepEqual(h.calls, []);
});

test('bounded waits retain submission order and skip unavailable resources', async t => {
  const h = harness(t, { maxWaits: 2 });
  h.add('second', 2);
  h.add('first', 1);
  h.add('overflow', 3);
  const held = h.broker.tryAcquire({ ownerId: 'producer', resources });
  h.coordinator.track('second', [capacityResource('tool_operations')]);
  h.coordinator.track('first', resources);
  assert.equal(h.coordinator.track('overflow', resources).reason, 'runtime_wait_capacity');
  await tick();
  assert.deepEqual(h.calls, [['second', 4]]);
  h.broker.release(held.lease, { producerSettled: true });
  await tick();
  assert.deepEqual(h.calls, [['second', 4], ['first', 4]]);
});

test('retryable provider gates wait for a later wake without spinning or retaining workers', async t => {
  let tries = 0;
  const h = harness(t, { resume: () => {
    tries += 1;
    if (tries === 1) throw Object.assign(new Error('provider_busy'), { retryable: true });
    return { status: 'accepted' };
  } });
  h.add('one');
  h.coordinator.track('one', resources);
  await tick();
  assert.equal(tries, 1);
  assert.equal(h.coordinator.snapshot().wait_count, 1);
  assert.equal(h.broker.snapshot().lease_count, 0);
  await tick();
  assert.equal(tries, 1);
  h.coordinator.wake();
  await tick();
  assert.equal(tries, 2);
  assert.equal(h.coordinator.snapshot().wait_count, 0);
});

test('filesystem waits preserve application-branded identities without trusting copied path objects', async t => {
  const h = harness(t);
  h.add('one');
  const identity = new PhysicalPathResolver().resolve(__dirname);
  const paths = [filesystemResource(identity)];
  const held = h.broker.tryAcquire({ ownerId: 'writer', resources: paths });
  assert.equal(h.coordinator.track('one', paths).status, 'tracked');
  await tick();
  assert.deepEqual(h.calls, []);
  h.broker.release(held.lease, { producerSettled: true });
  await tick();
  assert.deepEqual(h.calls, [['one', 4]]);
  h.add('forged');
  assert.throws(() => h.coordinator.track('forged', [filesystemResource({ ...identity })]),
    /Filesystem resource identity is invalid/u);
});


test('admission tokens remain bounded and cleanup does not retain historical sessions', t => {
  const h = harness(t, { maxWaits: 2 });
  for (let index = 0; index < 300; index += 1) {
    const sessionId = `session_${index}`;
    const token = h.coordinator.captureAdmission(sessionId);
    assert.equal(h.coordinator.snapshot().admission_count, 1);
    if (index % 2 === 0) h.coordinator.clearSession(sessionId);
    assert.equal(h.coordinator.releaseAdmission(token), index % 2 !== 0);
    assert.equal(h.coordinator.releaseAdmission(token), false);
    assert.equal(h.coordinator.snapshot().admission_count, 0);
    assert.equal(h.coordinator.admissions.size, 0);
  }
  const first = h.coordinator.captureAdmission('first');
  const second = h.coordinator.captureAdmission('second');
  const overflow = h.coordinator.captureAdmission('overflow');
  assert.equal(h.coordinator.snapshot().admission_count, 2);
  assert.equal(h.coordinator.releaseAdmission(overflow), false);
  h.coordinator.releaseAdmission(first);
  h.coordinator.releaseAdmission(second);
  assert.equal(h.coordinator.snapshot().admission_count, 0);
});


test('dependency waits retain no broker resources and resume once only after readiness', async t => {
  let ready = false;
  const h = harness(t, { dependencyReady: (work, child) => {
    assert.equal(work.work_id, 'parent'); assert.equal(child, 'child'); return ready;
  } });
  h.add('parent');
  assert.equal(h.coordinator.track('parent', [{ type: 'dependency', work_id: 'child' }]).status, 'tracked');
  await tick();
  assert.deepEqual(h.calls, []);
  assert.equal(h.broker.snapshot().lease_count, 0);
  ready = true;
  h.coordinator.wake();
  await tick();
  assert.deepEqual(h.calls, [['parent', 4]]);
  h.coordinator.wake();
  await tick();
  assert.equal(h.calls.length, 1);
});

test('dependency waits obey OFF, explicit pause and before-checkpoint admission invalidation', async t => {
  const h = harness(t, { dependencyReady: () => false });
  h.add('parent');
  const token = h.coordinator.captureAdmission('session_1');
  h.coordinator.clearSession('session_1');
  const dependency = [{ type: 'dependency', work_id: 'child' }];
  assert.equal(h.coordinator.track('parent', dependency, { admission: token }).reason, 'runtime_wait_controlled');
  assert.equal(h.coordinator.track('parent', dependency).status, 'tracked');
  h.enable(false);
  h.enable(true);
  h.coordinator.dependencyReady = () => true;
  h.coordinator.wake();
  await tick();
  assert.deepEqual(h.calls, []);
  h.works.get('parent').control_request = { kind: 'pause' };
  assert.equal(h.coordinator.track('parent', dependency).reason, 'runtime_wait_not_live');
});
