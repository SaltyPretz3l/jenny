'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { RuntimeEligibilityCoordinator } = require('../../services/session-runtime/eligibility');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { ResourceBroker, capacityResource } = require('../../services/session-runtime/resource-broker');
const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');
const { SessionRuntimeService } = require('../../services/session-runtime/service');
const { RuntimeApplicationService } = require('../../services/session-runtime/application-service');
const { RuntimeStore } = require('../../services/session-runtime/store');

const WAIT_RESOURCES = Object.freeze([capacityResource('tests')]);
const tick = () => new Promise(resolve => setImmediate(resolve));

async function waitFor(check, message) {
  for (let index = 0; index < 50; index += 1) {
    const value = check();
    if (value) return value;
    await tick();
  }
  throw new Error(message);
}

function fixture(t, { uncertainPause = false, deferredFirstPause = false,
  retryResumeOnce = false, maxRunnableTurns = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-eligibility-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sequence = 0;
  const store = new RuntimeStore(root, { createId: prefix => `${prefix}_${++sequence}` });
  let scheduler;
  let coordinator;
  const lanes = new RuntimeLaneAdmission({ maxRunnableTurns,
    createId: () => `lane_${++sequence}`, onChange: () => {
      scheduler?.notifyLaneAvailability();
      coordinator?.wake();
    } });
  const broker = new ResourceBroker({ createId: () => `resource_${++sequence}` });
  const route = captureRuntimeRoute({ engine_type: 'mock', provider_id: 'mock',
    configuration_revision: 'config_1', resource_class: 'local', requires_gpu: false });
  const starts = [];
  const canonicalPreparations = [];
  const claims = [];
  const resumePreparations = [];
  const attention = [];
  let checkpointValidations = 0;
  let finishFirstPause = null;
  let resumeAttempts = 0;
  const perWorkStarts = new Map();
  scheduler = new SessionRuntimeScheduler({
    store, lanes, enabled: true, createId: () => `runtime_${++sequence}`,
    resolveRoute: () => route,
    validateWork() {},
    prepareCanonical(work) { canonicalPreparations.push(work.work_id); },
    claimCanonical(work) {
      const claim = { streamId: `stream_${++sequence}`, authorityRevision: `authority_${sequence}`,
        assertCurrent() {}, rollbackBeforeStart: () => true };
      claims.push({ workId: work.work_id, claim });
      return claim;
    },
    startProducer({ work, attempt }) {
      const count = (perWorkStarts.get(work.work_id) || 0) + 1;
      perWorkStarts.set(work.work_id, count);
      starts.push({ workId: work.work_id, attempt });
      if (count > 1) {
        return { status: 'completed', producerSettled: true, canonicalSettled: true };
      }
      const outcome = { status: 'paused', producerSettled: !uncertainPause,
        canonicalSettled: true, checkpointSettled: true,
        checkpointRef: { schema_version: 1, checkpoint_id: `checkpoint_${work.work_id}`,
          sha256: 'a'.repeat(64), bytes: 10, source_attempt: attempt },
        waitResources: WAIT_RESOURCES };
      if (!deferredFirstPause) return outcome;
      return new Promise(resolve => { finishFirstPause = () => resolve(outcome); });
    },
    discardPending() { return true; },
    provePausedCleanup: () => true,
    validateCheckpoint: () => { checkpointValidations += 1; return true; },
    captureEligibility: sessionId => coordinator?.captureAdmission(sessionId),
    releaseEligibility: admission => coordinator?.releaseAdmission(admission),
    onSuspended: ({ work, waitResources, admission }) => coordinator
      .track(work.work_id, waitResources, { admission }),
    onAttention: event => attention.push(event),
  });
  const chatAdapter = {
    prepareImmediate() {},
    prepareResume(work) {
      resumePreparations.push(work.work_id);
      resumeAttempts += 1;
      if (retryResumeOnce && resumeAttempts === 1) {
        throw Object.assign(new Error('provider gate busy'), { retryable: true });
      }
      return { workId: work.work_id };
    },
    register() {}, discard() {},
  };
  let runtime;
  coordinator = new RuntimeEligibilityCoordinator({
    broker, incarnation: scheduler.incarnation, getWork: workId => store.get(workId),
    resume: (workId, revision) => runtime.resume(workId, revision),
    enabled: true, canDispatch: () => !scheduler.closing,
    onAttention: event => attention.push(event),
  });
  runtime = new SessionRuntimeService({ store, scheduler, chatAdapter,
    resourceBroker: broker, eligibilityCoordinator: coordinator });
  t.after(() => coordinator.dispose());

  function submit(sessionId = `session_${sequence + 1}`) {
    return store.submit({ idempotencyKey: `submit_${++sequence}`, projectId: 'project_1',
      sessionId, purpose: 'chat', input: { route },
      authority: { project_id: 'project_1', root_path: null, root_id: null,
        root_revision: 0, device_id: null, inode: null } }).record;
  }
  function begin(sessionId) {
    const work = submit(sessionId);
    const dispatched = scheduler.tryDispatch(work.work_id);
    assert.equal(dispatched.status, 'started');
    return { work, dispatched };
  }
  async function suspend(sessionId) {
    const { work, dispatched } = begin(sessionId);
    assert.equal((await dispatched.completion).status, uncertainPause ? 'needs_attention' : 'paused');
    await tick();
    return { workId: work.work_id, sourceAttempt: starts[0].attempt };
  }
  function holdResources() {
    const held = broker.tryAcquire({ ownerId: `holder_${++sequence}`, resources: WAIT_RESOURCES });
    assert.equal(held.status, 'granted');
    return held.lease;
  }
  return { attention, begin, broker, canonicalPreparations,
    checkpointValidations: () => checkpointValidations, claims, coordinator,
    finishFirstPause: () => finishFirstPause?.(), holdResources, lanes, route, runtime,
    scheduler, starts, store, submit, suspend, resumePreparations };
}

test('confirmed resource suspension releases its lane and resumes exactly once after fresh admission', async t => {
  const h = fixture(t);
  const resourceLease = h.holdResources();
  const suspended = await h.suspend('session_waiting');
  assert.equal(h.store.get(suspended.workId).status, 'paused');
  assert.equal(h.coordinator.snapshot().wait_count, 1);
  assert.equal(h.lanes.snapshot().active_leases, 0);
  const checkpointBaseline = h.checkpointValidations();

  const laneBlocker = h.lanes.tryAcquireTurn({ sessionId: 'session_blocker', route: h.route });
  assert.equal(laneBlocker.status, 'granted');
  h.broker.release(resourceLease, { producerSettled: true });
  await tick();
  assert.equal(h.store.get(suspended.workId).status, 'pending');
  assert.equal(h.resumePreparations.length, 1);
  assert.equal(h.canonicalPreparations.length, 1,
    'checkpoint and canonical preparation stay behind the granted turn lane');
  assert.equal(h.checkpointValidations(), checkpointBaseline);
  assert.equal(h.claims.length, 1);
  assert.equal(h.starts.length, 1);

  const inference = h.lanes.tryAcquireInference({ ownerId: 'unrelated_inference', route: h.route });
  assert.equal(inference.status, 'granted');
  await tick();
  h.lanes.release(inference.lease, { producerSettled: true });
  await tick();
  assert.equal(h.checkpointValidations(), checkpointBaseline);
  assert.equal(h.canonicalPreparations.length, 1);
  assert.equal(h.starts.length, 1);

  h.lanes.release(laneBlocker.lease, { producerSettled: true });
  await waitFor(() => h.store.get(suspended.workId).status === 'completed',
    'resource-eligible work did not complete its fresh attempt');
  assert.equal(h.starts.length, 2);
  assert.notEqual(h.starts[1].attempt.attempt_id, suspended.sourceAttempt.attempt_id);
  assert.notEqual(h.starts[1].attempt.stream_id, suspended.sourceAttempt.stream_id);
  assert.equal(h.checkpointValidations(), checkpointBaseline + 1);
  h.coordinator.wake();
  await tick();
  assert.equal(h.starts.length, 2);
});

test('raising configured lane capacity wakes pending automatic work without an external pump', async t => {
  const h = fixture(t, { maxRunnableTurns: 2 });
  const resourceLease = h.holdResources();
  const suspended = await h.suspend('session_capacity');
  const blocker = h.lanes.tryAcquireTurn({ sessionId: 'session_blocker', route: h.route });
  h.broker.release(resourceLease, { producerSettled: true });
  await tick();
  assert.equal(h.store.get(suspended.workId).status, 'pending');

  h.lanes.setLimits({ local: { runnable_turns: 2 } });
  await waitFor(() => h.store.get(suspended.workId).status === 'completed',
    'increased lane capacity did not wake pending work');
  assert.equal(h.starts.length, 2);
  h.lanes.release(blocker.lease, { producerSettled: true });
});

test('retryable automatic admission waits for a later lane signal without spinning', async t => {
  const h = fixture(t, { retryResumeOnce: true });
  const resourceLease = h.holdResources();
  const suspended = await h.suspend('session_retryable');
  h.broker.release(resourceLease, { producerSettled: true });
  await tick();
  assert.equal(h.store.get(suspended.workId).status, 'paused');
  assert.equal(h.coordinator.snapshot().wait_count, 1);
  assert.equal(h.resumePreparations.length, 1);
  await tick();
  assert.equal(h.resumePreparations.length, 1, 'retryable gates do not spin');

  const inference = h.lanes.tryAcquireInference({ ownerId: 'retry_signal', route: h.route });
  await waitFor(() => h.store.get(suspended.workId).status === 'completed',
    'later lane availability did not retry admission');
  assert.equal(h.resumePreparations.length, 2);
  assert.equal(h.starts.length, 2);
  h.lanes.release(inference.lease, { producerSettled: true });
});

test('controls issued before a running attempt pauses invalidate its late eligibility', async t => {
  for (const action of ['off', 'session_pause', 'global_pause', 'cancel']) {
    const h = fixture(t, { deferredFirstPause: true });
    const resourceLease = h.holdResources();
    const { work, dispatched } = h.begin(`session_late_${action}`);
    await tick();
    if (action === 'off') { h.runtime.setEnabled(false); h.runtime.setEnabled(true); }
    if (action === 'session_pause') h.runtime.pausePending({ sessionId: work.session_id });
    if (action === 'global_pause') h.runtime.pausePending();
    if (action === 'cancel') h.runtime.cancel(work.work_id, { reason: 'cancel active' });
    h.finishFirstPause();
    const outcome = await dispatched.completion;
    assert.equal(outcome.status, action === 'cancel' ? 'cancelled' : 'paused');
    assert.equal(h.coordinator.snapshot().wait_count, 0,
      `${action} allowed a pre-control attempt to register late eligibility`);
    h.broker.release(resourceLease, { producerSettled: true });
    await tick();
    assert.equal(h.starts.length, 1, `${action} resumed a pre-control attempt`);
  }
});

test('an already-free resource schedules the same fresh resume without retaining a worker', async t => {
  const h = fixture(t);
  const suspended = await h.suspend('session_free');
  await waitFor(() => h.store.get(suspended.workId).status === 'completed',
    'already-free eligibility did not resume');
  assert.equal(h.starts.length, 2);
  assert.equal(h.coordinator.snapshot().wait_count, 0);
  assert.equal(h.broker.snapshot().waiter_count, 0);
  assert.equal(h.broker.snapshot().lease_count, 0);
});

test('cancellation, stream cancellation, OFF, session pause, shutdown and restart discard live waits', async t => {
  for (const action of ['cancel', 'stream', 'off', 'pause', 'shutdown', 'restart']) {
    const h = fixture(t);
    const resourceLease = h.holdResources();
    const suspended = await h.suspend(`session_${action}`);
    let shutdown = null;
    if (action === 'cancel') h.runtime.cancel(suspended.workId, { reason: 'test cancel' });
    if (action === 'stream') {
      h.runtime.noteStreamCancellation(suspended.sourceAttempt.stream_id, 'late stream cancel');
    }
    if (action === 'off') {
      h.runtime.setEnabled(false);
      h.runtime.setEnabled(true);
    }
    if (action === 'pause') h.runtime.pausePending({ sessionId: `session_${action}` });
    if (action === 'shutdown') shutdown = h.runtime.beginShutdown({ timeoutMs: 100 });
    if (action === 'restart') {
      h.coordinator.dispose();
      const restarted = new RuntimeEligibilityCoordinator({ broker: h.broker,
        incarnation: 'restart_incarnation', getWork: workId => h.store.get(workId),
        resume: () => { throw new Error('restart must not discover waits'); } });
      t.after(() => restarted.dispose());
    }
    assert.equal(h.coordinator.snapshot().wait_count, 0, `${action} retained automatic eligibility`);
    h.broker.release(resourceLease, { producerSettled: true });
    if (shutdown) assert.deepEqual(await shutdown.completion, { ok: true });
    await tick();
    assert.equal(h.starts.length, 1, `${action} automatically resumed paused work`);
  }
});

test('a refused explicit resume preserves the live resource wakeup', async t => {
  const h = fixture(t, { retryResumeOnce: true });
  const resourceLease = h.holdResources();
  const { workId } = await h.suspend('session_refused_resume');
  const before = h.store.get(workId);
  const app = new RuntimeApplicationService({ getRuntime: () => h.runtime });
  const result = app.resume({ work_id: workId, expected_revision: before.revision });
  assert.equal(result.ok, false);
  assert.deepEqual(h.store.get(workId), before);
  assert.equal(h.coordinator.snapshot().wait_count, 1);

  h.broker.release(resourceLease, { producerSettled: true });
  await waitFor(() => h.store.get(workId).status === 'completed',
    'refused explicit resume stranded the original automatic resource wait');
  assert.equal(h.starts.length, 2);
  assert.equal(h.resumePreparations.length, 2);
  assert.equal(h.coordinator.snapshot().wait_count, 0);
});

test('stale service controls preserve automatic eligibility', async t => {
  for (const action of ['pause', 'resume']) {
    const h = fixture(t);
    const resourceLease = h.holdResources();
    const { workId } = await h.suspend(`session_stale_${action}`);
    const before = h.store.get(workId);
    if (action === 'pause') {
      assert.equal(h.runtime.pause(workId, { expectedRevision: before.revision - 1 }).reason, 'revision_conflict');
    } else {
      assert.throws(() => h.runtime.resume(workId, before.revision - 1), { code: 'revision_conflict' });
    }
    assert.deepEqual(h.store.get(workId), before);
    assert.equal(h.coordinator.snapshot().wait_count, 1);
    h.broker.release(resourceLease, { producerSettled: true });
    await waitFor(() => h.store.get(workId).status === 'completed', `${action} stranded live work`);
    assert.equal(h.starts.length, 2);
  }
});

test('explicit resume consumes automatic eligibility before waiting for its lane', async t => {
  const h = fixture(t);
  const resourceLease = h.holdResources();
  const suspended = await h.suspend('session_explicit');
  const laneBlocker = h.lanes.tryAcquireTurn({ sessionId: 'session_blocker', route: h.route });
  const paused = h.store.get(suspended.workId);
  assert.equal(h.runtime.resume(suspended.workId, paused.revision).status, 'accepted');
  assert.equal(h.coordinator.snapshot().wait_count, 0);
  h.broker.release(resourceLease, { producerSettled: true });
  await tick();
  assert.equal(h.starts.length, 1);
  h.lanes.release(laneBlocker.lease, { producerSettled: true });
  await waitFor(() => h.store.get(suspended.workId).status === 'completed',
    'explicitly resumed work did not start after lane release');
  assert.equal(h.starts.length, 2);
});

test('unconfirmed producer cleanup quarantines capacity and never creates eligibility', async t => {
  const h = fixture(t, { uncertainPause: true });
  const resourceLease = h.holdResources();
  const suspended = await h.suspend('session_uncertain');
  assert.equal(h.store.get(suspended.workId).status, 'needs_attention');
  assert.equal(h.lanes.snapshot().quarantined, 1);
  assert.equal(h.coordinator.snapshot().wait_count, 0);
  h.broker.release(resourceLease, { producerSettled: true });
  await tick();
  assert.equal(h.starts.length, 1);
});


test('distinct session pauses and completed attempts release every live admission', async t => {
  const h = fixture(t, { deferredFirstPause: true });
  for (let index = 0; index < 12; index += 1) {
    const held = h.holdResources();
    const { work, dispatched } = h.begin(`session_cleanup_${index}`);
    await tick();
    assert.equal(h.coordinator.snapshot().admission_count, 1);
    if (index % 2 === 0) h.runtime.pausePending({ sessionId: work.session_id });
    h.finishFirstPause();
    assert.equal((await dispatched.completion).status, 'paused');
    assert.equal(h.coordinator.snapshot().admission_count, 0);
    h.broker.release(held, { producerSettled: true });
    await tick();
    assert.equal(h.store.get(work.work_id).status, index % 2 === 0 ? 'paused' : 'completed');
    assert.equal(h.coordinator.snapshot().admission_count, 0);
    assert.equal(h.coordinator.admissions.size, 0, 'historical session IDs were retained');
  }
});

test('final canonical busy claims and rollbacks do not schedule their own pump', async t => {
  for (const afterClaim of [false, true]) {
    const h = fixture(t);
    let blocked = true;
    let attempts = 0;
    let rollbacks = 0;
    let claimed = false;
    const claim = h.scheduler.claimCanonical;
    h.scheduler.claimCanonical = (...args) => {
      attempts += 1;
      // Bound a regression even if recursive microtasks would starve the timer queue.
      if (attempts > 10) h.scheduler.enabled = false;
      if (blocked && !afterClaim) throw Object.assign(new Error('busy'), { code: 'session_busy' });
      const result = claim(...args);
      claimed = true;
      return { ...result, rollbackBeforeStart() { rollbacks += 1; return true; } };
    };
    h.scheduler.validateWork = () => {
      if (blocked && afterClaim && claimed) {
        claimed = false;
        throw Object.assign(new Error('busy'), { code: 'session_busy' });
      }
    };
    const work = h.submit(`session_busy_${afterClaim}`);
    assert.equal(h.scheduler.tryDispatch(work.work_id).reason, 'session_busy');
    await tick();
    await tick();
    assert.equal(attempts, 1, 'lane acquire/release retried its own failed canonical claim');
    assert.equal(rollbacks, afterClaim ? 1 : 0);
    assert.equal(h.store.get(work.work_id).status, 'pending');
    assert.equal(h.lanes.snapshot().active_leases, 0);
    assert.equal(h.starts.length, 0);
    const external = h.lanes.tryAcquireTurn({ sessionId: 'external', route: h.route });
    await tick();
    assert.equal(attempts, 1);
    blocked = false;
    h.lanes.release(external.lease, { producerSettled: true });
    await waitFor(() => h.store.get(work.work_id).status === 'completed',
      'confirmed external release did not wake the pending canonical claim');
    assert.equal(h.starts.length, 2);
  }
});
