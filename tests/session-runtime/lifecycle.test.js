'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');
const { SessionRuntimeService } = require('../../services/session-runtime/service');
const { RuntimeStore, createRuntimeStoreIO } = require('../../services/session-runtime/store');
const { ResourceBroker, capacityResource } = require('../../services/session-runtime/resource-broker');
const { waitForCleanup } = require('../../services/session-runtime/lifecycle');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, { enabled = true, provePausedCleanup = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sequence = 0;
  const io = { ...createRuntimeStoreIO() };
  const store = new RuntimeStore(root, { io, createId: prefix => `${prefix}_${++sequence}` });
  const lanes = new RuntimeLaneAdmission();
  const route = captureRuntimeRoute({ engine_type: 'mock', provider_id: 'mock',
    configuration_revision: 'config_1', resource_class: 'local', requires_gpu: false });
  const claims = new Map();
  const preparations = [];
  const producers = [];
  const cancellations = [];
  const discarded = [];
  const attention = [];
  const scheduler = new SessionRuntimeScheduler({ store, lanes, enabled,
    createId: () => `runtime_${++sequence}`,
    resolveRoute: () => route,
    validateWork() {},
    prepareCanonical(work) { preparations.push(work.work_id); },
    claimCanonical(work) {
      const claim = { streamId: `stream_${++sequence}`, authorityRevision: `authority_${sequence}`,
        assertCurrent() {}, rollbackBeforeStart() { claims.delete(work.work_id); return true; } };
      claims.set(work.work_id, claim);
      return claim;
    },
    startProducer(context) {
      const waiting = deferred();
      producers.push({ ...context, waiting });
      return waiting.promise;
    },
    cancelProducer(work, reason, options) { cancellations.push({ work, reason, options }); return true; },
    discardPending(work) { discarded.push(work.work_id); return true; },
    provePausedCleanup: () => provePausedCleanup,
    validateCheckpoint: () => true,
    onAttention: event => attention.push(event),
  });
  const runtime = new SessionRuntimeService({ store, scheduler,
    chatAdapter: { prepareImmediate() {} } });
  function submit(sessionId = 'session_1') {
    return store.submit({ idempotencyKey: `submit_${++sequence}`, projectId: 'project_1',
      sessionId, purpose: 'chat', input: { prompt: 'hello' },
      authority: { project_id: 'project_1', root_path: null, root_id: null,
        root_revision: 0, device_id: null, inode: null } }).record;
  }
  return { store, io, lanes, scheduler, runtime, submit, claims, preparations,
    producers, cancellations, discarded, attention };
}

test('cancellation before producer start rolls back its actor and durably settles cancelled', async t => {
  const h = fixture(t);
  const work = h.submit();
  const started = h.scheduler.tryDispatch(work.work_id);
  const report = h.runtime.cancel(work.work_id, { reason: 'user stop' });
  assert.equal(report.status, 'requested');
  assert.equal(report.persisted, true);
  assert.equal(report.cleanup_confirmed, false);
  assert.equal(h.store.get(work.work_id).control_request.reason, 'user stop');
  assert.equal((await started.completion).status, 'cancelled');
  assert.deepEqual(await report.settlement, {
    status: 'cancelled', work_id: work.work_id, cleanup_confirmed: true,
  });
  assert.equal(h.producers.length, 0);
  assert.equal(h.claims.size, 0);
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.equal(h.store.get(work.work_id).status, 'cancelled');
});

test('stream cancellation closes admission while the exact attempt remains valid for settlement', async t => {
  const h = fixture(t);
  const work = h.submit();
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  const producer = h.producers[0];
  producer.assertCurrent();
  const report = h.runtime.noteStreamCancellation(started.stream_id, 'approval cancelled');
  assert.equal(report.status, 'requested');
  assert.deepEqual(h.cancellations.at(-1).options, { abort: false });
  assert.throws(() => producer.assertCurrent(), /runtime_cancellation_requested/);
  assert.equal(producer.assertSettlementCurrent().work_id, work.work_id);
  producer.waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  assert.equal((await started.completion).status, 'cancelled');
  assert.equal(h.store.get(work.work_id).status, 'cancelled');
  assert.equal((await report.settlement).cleanup_confirmed, true);
});

test('a published pause settles its checkpoint before cancellation terminalizes the attempt', async t => {
  const h = fixture(t, { provePausedCleanup: true });
  const work = h.submit();
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  const running = h.store.get(work.work_id);
  const checkpointRef = { schema_version: 1, checkpoint_id: 'checkpoint_cancelled_pause',
    sha256: 'b'.repeat(64), bytes: 20, source_attempt: running.attempt };
  const report = h.runtime.cancel(work.work_id, { reason: 'cancel after publish' });
  h.producers[0].waiting.resolve({ status: 'paused', producerSettled: true,
    canonicalSettled: true, checkpointSettled: true, checkpointRef });
  assert.equal((await started.completion).status, 'cancelled');
  const cancelled = h.store.get(work.work_id);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.checkpoint_ref, checkpointRef);
  assert.equal(cancelled.transition.from, 'paused');
  assert.equal((await report.settlement).cleanup_confirmed, true);
  assert.equal(h.lanes.snapshot().active_leases, 0);
});

test('failed cancellation persistence keeps the in-memory fence and quarantines cleanup', async t => {
  const h = fixture(t);
  const work = h.submit();
  const started = h.scheduler.tryDispatch(work.work_id);
  const write = h.io.writeJsonAtomic;
  h.io.writeJsonAtomic = (filePath, value) => {
    if (value?.record?.control_request?.kind === 'cancel') throw new Error('disk unavailable');
    return write(filePath, value);
  };
  const report = h.runtime.cancel(work.work_id, { reason: 'durable stop' });
  assert.equal(report.status, 'requested');
  assert.equal(report.persisted, false);
  assert.equal(h.scheduler.cancellationFences.has(work.work_id), true);
  assert.equal((await started.completion).status, 'needs_attention');
  assert.equal(h.producers.length, 0);
  assert.equal(h.lanes.snapshot().quarantined, 1);
  assert.equal(h.attention.some(event => event.reason === 'write_failed'), true);
});

// B3D-4: the fence alone never settles a record (the test above pins that a
// fence with no persisted intent quarantines). When the durable cancel write
// failed but the store is writable again by the time the producer settles,
// settlement persists the intent and the entry ends `cancelled` with its lane
// released instead of parking in needs_attention forever.
test('a fenced cancellation whose durable write failed is persisted at settlement', async t => {
  const h = fixture(t);
  const work = h.submit();
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  assert.equal(h.producers.length, 1);
  const write = h.io.writeJsonAtomic;
  h.io.writeJsonAtomic = (filePath, value) => {
    if (value?.record?.control_request?.kind === 'cancel') throw new Error('disk unavailable');
    return write(filePath, value);
  };
  const report = h.runtime.cancel(work.work_id, { reason: 'durable stop' });
  assert.equal(report.status, 'requested');
  assert.equal(report.persisted, false);
  assert.equal(h.cancellations.length, 1);
  assert.equal(h.scheduler.cancellationFences.has(work.work_id), true);
  // Nothing landed, so the store did not latch read-only (B3D-3).
  assert.equal(h.store.getStatus().read_only, false);

  h.io.writeJsonAtomic = write;
  h.producers[0].waiting.resolve({ status: 'cancelled', producerSettled: true, canonicalSettled: true });
  assert.equal((await started.completion).status, 'cancelled');
  const settled = h.store.get(work.work_id);
  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.control_request.kind, 'cancel');
  assert.equal(settled.control_request.reason, 'durable stop');
  assert.equal(h.scheduler.cancellationFences.has(work.work_id), false);
  assert.equal(h.scheduler.active.size, 0);
  assert.equal(h.lanes.snapshot().quarantined, 0);
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.equal((await report.settlement).cleanup_confirmed, true);
});

test('unconfirmed producer cleanup keeps session cancellation timed out and capacity quarantined', async t => {
  const h = fixture(t);
  const work = h.submit('session_uncertain');
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  const cancellation = h.runtime.cancelSessionAndWait('session_uncertain', {
    reason: 'session deleted', timeoutMs: 20,
  });
  h.producers[0].waiting.resolve({ status: 'cancelled',
    producerSettled: false, canonicalSettled: true });
  assert.equal((await started.completion).status, 'needs_attention');
  assert.deepEqual(await cancellation, {
    ok: false, reason: 'runtime_cleanup_timeout', timedOut: true,
  });
  assert.equal(h.scheduler.active.size, 1);
  assert.equal(h.lanes.snapshot().quarantined, 1);
  assert.equal(h.runtime.hasSessionWork('session_uncertain'), true);
});

test('a terminal record still reports cleanup unconfirmed while its admitted entry owns capacity', async t => {
  const h = fixture(t);
  const work = h.submit();
  const started = h.scheduler.tryDispatch(work.work_id);
  const running = h.store.get(work.work_id);
  h.store.transition(work.work_id, { expectedRevision: running.revision,
    expectedAttempt: running.attempt, to: 'cancelled', reason: 'external terminal record' });
  const report = h.runtime.cancel(work.work_id, { reason: 'repeat cancellation' });
  assert.equal(report.status, 'cancelled');
  assert.equal(report.cleanup_confirmed, false);
  assert.ok(report.settlement instanceof Promise);
  assert.equal(h.lanes.snapshot().active_leases, 1);
  assert.equal((await started.completion).status, 'needs_attention');
  assert.equal(h.lanes.snapshot().quarantined, 1);
});

test('attempted paused work terminalizes only with composed checkpoint and actor cleanup proof', t => {
  for (const proven of [false, true]) {
    const h = fixture(t, { provePausedCleanup: proven });
    const pending = h.submit(`session_${proven}`);
    const attempt = { attempt_id: `attempt_${proven}`, stream_id: `stream_${proven}`,
      incarnation: `host_${proven}`, authority_revision: `authority_${proven}` };
    const running = h.store.transition(pending.work_id, { expectedRevision: pending.revision,
      to: 'running', reason: 'fixture', attempt }).record;
    const checkpointRef = { schema_version: 1, checkpoint_id: `checkpoint_${proven}`,
      sha256: 'a'.repeat(64), bytes: 10, source_attempt: attempt };
    const paused = h.store.transition(running.work_id, { expectedRevision: running.revision,
      expectedAttempt: attempt, to: 'paused', reason: 'checkpoint', checkpointRef }).record;
    const report = h.runtime.cancel(paused.work_id, { reason: 'cancel paused' });
    assert.equal(report.cleanup_confirmed, proven);
    assert.equal(report.status, proven ? 'cancelled' : 'requested');
    assert.equal(h.store.get(paused.work_id).status, proven ? 'cancelled' : 'paused');
  }
});

test('pending lifecycle mutations never hydrate terminal work bodies', async t => {
  const h = fixture(t);
  const terminal = h.submit('session_summary_scan');
  h.store.transition(terminal.work_id, { expectedRevision: terminal.revision,
    to: 'cancelled', reason: 'fixture terminal' });
  const pending = h.submit('session_summary_scan');
  const originalGet = h.store.get.bind(h.store);
  const loaded = [];
  h.store.get = workId => { loaded.push(workId); return originalGet(workId); };

  assert.deepEqual(h.runtime.pausePending({ sessionId: 'session_summary_scan' }), { paused: 1 });
  assert.deepEqual(await h.runtime.cancelSessionAndWait('session_summary_scan', {
    reason: 'session cleanup', timeoutMs: 100,
  }), { ok: true });

  assert.equal(loaded.includes(terminal.work_id), false);
  assert.equal(loaded.includes(pending.work_id), true);
  assert.equal(h.store.get(pending.work_id).status, 'cancelled');
});

test('shutdown closing is stricter than feature OFF and reopen never resumes paused work', async t => {
  const h = fixture(t, { enabled: false });
  const immediate = h.submit('session_immediate');
  const started = h.scheduler.tryDispatch(immediate.work_id, { immediate: true });
  assert.equal(started.status, 'started');
  await Promise.resolve();
  h.producers[0].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  await started.completion;

  const queued = h.submit('session_queued');
  assert.throws(() => h.runtime.beginShutdown({ timeoutMs: 0 }),
    /session_runtime_drain_timeout_invalid/);
  assert.equal(h.scheduler.closing, false);
  const shutdown = h.runtime.beginShutdown({ reason: 'service stop', timeoutMs: 100 });
  assert.equal(shutdown.requested, true);
  assert.equal(h.store.get(queued.work_id).status, 'paused');
  assert.equal(h.preparations.includes(queued.work_id), false);
  assert.deepEqual(await shutdown.completion, { ok: true });

  const refused = h.submit('session_refused');
  assert.deepEqual(h.scheduler.tryDispatch(refused.work_id, { immediate: true }),
    { status: 'rejected', reason: 'runtime_closing' });
  assert.equal(h.store.get(refused.work_id).status, 'paused');
  assert.deepEqual(h.runtime.reopenAfterShutdown(), { ok: true });
  h.scheduler.setEnabled(true);
  h.scheduler.pump();
  assert.equal(h.producers.length, 1);
  assert.equal(h.store.get(queued.work_id).status, 'paused');
  assert.equal(h.store.get(refused.work_id).status, 'paused');
});

test('service closing refuses immediate and resume requests before adapter preparation', async () => {
  let immediatePrepared = false;
  let resumePrepared = false;
  const runtime = new SessionRuntimeService({ store: {},
    scheduler: { closing: true, lanes: {} },
    chatAdapter: {
      async prepareImmediate() { immediatePrepared = true; },
      prepareResume() { resumePrepared = true; },
    } });
  await assert.rejects(runtime.startImmediate({}), error => (
    error.code === 'session_busy' && error.reason === 'runtime_closing'
  ));
  assert.deepEqual(runtime.resume('work_1', 1), {
    status: 'rejected', reason: 'runtime_closing',
  });
  assert.equal(immediatePrepared, false);
  assert.equal(resumePrepared, false);
});

test('shutdown and reopen retain shared resource quarantine until exact cleanup', async t => {
  const h = fixture(t);
  const broker = new ResourceBroker();
  h.runtime.resourceBroker = broker;
  const lease = await broker.acquire({ ownerId: 'tool_1',
    resources: [capacityResource('tool_operations')] });
  const shutdown = h.runtime.beginShutdown({ timeoutMs: 20 });
  broker.release(lease, { producerSettled: false });
  assert.deepEqual(await shutdown.completion, {
    ok: false, reason: 'runtime_cleanup_timeout', timedOut: true,
  });
  assert.deepEqual(h.runtime.reopenAfterShutdown(), {
    ok: false, reason: 'runtime_cleanup_unconfirmed',
  });
  assert.equal(broker.confirmCleanup(lease), true);
  assert.deepEqual(h.runtime.reopenAfterShutdown(), { ok: true });
});


// B3D-1: a producer that threw (or returned an unproven outcome) kept the
// runtime unconfirmed forever, so every later backend start refused to
// reopen. The backend restart is the process-tree proof the producer could
// not give: the reclaim retires the entry, confirms its quarantine, and the
// runtime reopens.
test('backend-restart reclaim retires abandoned producers and quarantine so the runtime reopens', async t => {
  const h = fixture(t);
  const broker = new ResourceBroker();
  h.runtime.resourceBroker = broker;
  const work = h.submit('session_abandoned');
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  const lease = await broker.acquire({ ownerId: 'tool_1',
    resources: [capacityResource('tool_operations')] });
  const shutdown = h.runtime.beginShutdown({ timeoutMs: 20 });
  h.producers[0].waiting.resolve({ status: 'failed', producerSettled: false, canonicalSettled: false });
  broker.release(lease, { producerSettled: false });
  assert.equal((await started.completion).status, 'needs_attention');
  assert.deepEqual(await shutdown.completion, {
    ok: false, reason: 'runtime_cleanup_timeout', timedOut: true,
  });
  assert.deepEqual(h.runtime.reopenAfterShutdown(), {
    ok: false, reason: 'runtime_cleanup_unconfirmed',
  });

  const report = h.runtime.reclaimAbandonedAfterBackendRestart({ reason: 'backend_restart' });
  assert.deepEqual(report, {
    reclaimed: [{ work_id: work.work_id, session_id: 'session_abandoned', status: 'cancelled' }],
    retained: [], resources_confirmed: 1,
  });
  assert.equal(h.store.get(work.work_id).status, 'cancelled');
  assert.equal(h.scheduler.active.size, 0);
  assert.equal(h.lanes.snapshot().quarantined, 0);
  assert.equal(broker.snapshot().quarantined_count, 0);
  assert.deepEqual(h.runtime.reopenAfterShutdown(), { ok: true });
  assert.equal(h.runtime.hasSessionWork('session_abandoned'), false);
  assert.equal(h.scheduler.tryDispatch(h.submit('session_next').work_id).status, 'started');
});

test('active pause persists intent while retaining the lane until proven checkpoint settlement', async t => {
  const h = fixture(t);
  const work = h.submit();
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  const running = h.store.get(work.work_id);
  const report = h.runtime.pause(work.work_id, { expectedRevision: running.revision });
  assert.equal(report.status, 'requested');
  assert.equal(h.store.get(work.work_id).status, 'running');
  assert.equal(h.store.get(work.work_id).control_request.kind, 'pause');
  assert.equal(h.lanes.snapshot().active_leases, 1);
  assert.equal(h.cancellations.length, 0);
  h.producers[0].assertCurrent();
  assert.equal(h.runtime.pause(work.work_id, { expectedRevision: running.revision }).reason, 'revision_conflict');
  const checkpointRef = { schema_version: 1, checkpoint_id: 'checkpoint_explicit_pause',
    sha256: 'b'.repeat(64), bytes: 20, source_attempt: running.attempt };
  h.producers[0].waiting.resolve({ status: 'paused', producerSettled: true,
    canonicalSettled: true, checkpointSettled: true, checkpointRef });
  assert.equal((await started.completion).status, 'paused');
  const paused = h.store.get(work.work_id);
  assert.equal(paused.control_request.kind, 'pause');
  assert.equal(h.lanes.snapshot().active_leases, 0);
  h.scheduler.pump();
  assert.equal(h.producers.length, 1);
  assert.throws(() => h.store.transition(work.work_id, {
    expectedRevision: paused.revision, to: 'pending', reason: 'automatic_resume',
  }), /pause_requested/);
  const resumed = h.scheduler.resume(work.work_id, paused.revision);
  assert.equal(resumed.status, 'accepted');
  assert.equal(h.store.get(work.work_id).control_request, null);
  await Promise.resolve();
  assert.equal(h.producers.length, 2);
  h.producers[1].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  await h.scheduler.active.get(work.work_id).completion;
});

test('cancellation supersedes persisted pause and prevents later pause or resume', async t => {
  const h = fixture(t);
  const work = h.submit();
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  let current = h.store.get(work.work_id);
  h.runtime.pause(work.work_id, { expectedRevision: current.revision });
  const cancelled = h.runtime.cancel(work.work_id, { reason: 'cancel wins' });
  assert.equal(cancelled.persisted, true);
  current = h.store.get(work.work_id);
  assert.equal(current.control_request.kind, 'cancel');
  assert.throws(() => h.runtime.pause(work.work_id, { expectedRevision: current.revision }), /cancellation_requested/);
  h.producers[0].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  assert.equal((await started.completion).status, 'cancelled');
});

test('pause persistence failure cannot claim pause or release a running lane', async t => {
  const h = fixture(t);
  const work = h.submit();
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  const current = h.store.get(work.work_id);
  const write = h.io.writeJsonAtomic;
  h.io.writeJsonAtomic = (file, value) => {
    if (value?.record?.control_request?.kind === 'pause') throw new Error('disk unavailable');
    return write(file, value);
  };
  assert.throws(() => h.runtime.pause(work.work_id, { expectedRevision: current.revision }), { code: 'write_failed' });
  assert.equal(h.lanes.snapshot().active_leases, 1);
  assert.equal(h.store.get(work.work_id).status, 'running');
  assert.equal(h.store.get(work.work_id).control_request, null);
  // The pause write never landed, so the store stays writable and the turn
  // that was never paused settles normally once its producer finishes.
  h.io.writeJsonAtomic = write;
  h.producers[0].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  assert.equal((await started.completion).status, 'completed');
  assert.equal(h.store.get(work.work_id).status, 'completed');
  assert.equal(h.lanes.snapshot().quarantined, 0);
  assert.equal(h.lanes.snapshot().active_leases, 0);
});


for (const succeeds of [false, true]) test(`paused owner release keeps cancellation fenced until proof (success=${succeeds})`, async t => {
  const h = fixture(t);
  const work = h.submit();
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  const running = h.store.get(work.work_id);
  const checkpointRef = { schema_version: 1, checkpoint_id: 'checkpoint_owner_release',
    sha256: 'b'.repeat(64), bytes: 20, source_attempt: running.attempt };
  h.producers[0].waiting.resolve({ status: 'paused', producerSettled: true,
    canonicalSettled: true, checkpointSettled: true, checkpointRef });
  assert.equal((await started.completion).status, 'paused');
  const release = deferred();
  h.scheduler.provePausedCleanup = () => release.promise;
  const report = h.runtime.cancel(work.work_id, { reason: 'owner release' });
  assert.equal(report.status, 'requested');
  assert.equal(report.cleanup_confirmed, false);
  assert.equal(h.store.get(work.work_id).status, 'paused');
  assert.equal(h.scheduler.cancellationFences.has(work.work_id), true);
  assert.equal(h.scheduler.cleanupPromises().length, 1);
  assert.equal(h.runtime.cancel(work.work_id).settlement, report.settlement);
  release.resolve(succeeds);
  assert.equal((await report.settlement).cleanup_confirmed, succeeds);
  assert.equal(h.store.get(work.work_id).status, succeeds ? 'cancelled' : 'paused');
  assert.equal(h.scheduler.cancellationFences.has(work.work_id), !succeeds);
});

test('waitForCleanup tolerates a rejecting waiter and keeps draining', async () => {
  let checks = 0;
  const rejecting = () => [Promise.reject(new Error('waiter_failed'))];
  assert.deepEqual(await waitForCleanup(() => ++checks >= 3, { timeoutMs: 1000, waiters: rejecting }), { ok: true });
  assert.equal(checks, 3);
  assert.deepEqual(await waitForCleanup(() => false, { timeoutMs: 40, waiters: rejecting }),
    { ok: false, reason: 'runtime_cleanup_timeout', timedOut: true });
});

test('waitForCleanup keeps timers alive when waiters keep handing back rejected promises', async () => {
  let cleaned = false;
  setTimeout(() => { cleaned = true; }, 5);
  let calls = 0;
  const result = await waitForCleanup(() => cleaned, {
    timeoutMs: 1000,
    // A fresh rejected promise on every poll is the worst case: each one settles at once.
    waiters: () => { calls += 1; return [Promise.reject(new Error(`waiter ${calls}`))]; },
  });
  assert.deepEqual(result, { ok: true });
  assert.ok(calls < 200, `the loop must yield between polls (polled ${calls} times)`);
});
