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

function fixture(t, { provePausedCleanup = () => false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-cancellation-settlement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sequence = 0;
  const store = new RuntimeStore(root, { io: createRuntimeStoreIO(),
    createId: prefix => `${prefix}_${++sequence}` });
  const lanes = new RuntimeLaneAdmission();
  const route = captureRuntimeRoute({ engine_type: 'mock', provider_id: 'mock',
    configuration_revision: 'config_1', resource_class: 'local', requires_gpu: false });
  const producers = [];
  const attention = [];
  const scheduler = new SessionRuntimeScheduler({ store, lanes,
    createId: () => `runtime_${++sequence}`,
    resolveRoute: () => route,
    validateWork() {},
    claimCanonical() {
      return { streamId: `stream_${++sequence}`, authorityRevision: `authority_${sequence}`,
        assertCurrent() {}, rollbackBeforeStart() { return true; } };
    },
    startProducer(context) {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      producers.push({ ...context, resolve });
      return promise;
    },
    cancelProducer() { return true; },
    discardPending() { return true; },
    provePausedCleanup,
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
  return { store, lanes, scheduler, runtime, producers, attention, submit };
}

async function start(h, sessionId) {
  const work = h.submit(sessionId);
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  return { work: h.store.get(work.work_id), started, producer: h.producers[0] };
}

function pauseOutcome(work, suffix) {
  return { status: 'paused', producerSettled: true, canonicalSettled: true,
    checkpointSettled: true, checkpointRef: { schema_version: 1,
      checkpoint_id: `checkpoint_${suffix}`, sha256: 'a'.repeat(64), bytes: 10,
      source_attempt: work.attempt } };
}

test('same-kind scheduler cancellation is idempotent across caller reasons', async t => {
  const h = fixture(t);
  const { work, started, producer } = await start(h);
  const first = h.scheduler.requestCancellation(work.work_id, {
    expectedRevision: work.revision, reason: 'user', abort: true,
  });
  const saved = h.store.get(work.work_id);
  const second = h.scheduler.requestCancellation(work.work_id, {
    expectedRevision: saved.revision, reason: 'session_deleted', abort: true,
  });

  assert.equal(first.persisted, true);
  assert.equal(second.status, 'requested');
  assert.equal(second.persisted, true);
  assert.equal(h.store.get(work.work_id).control_request.reason, 'user');
  assert.deepEqual(h.attention, []);

  producer.resolve({ status: 'cancelled', producerSettled: true, canonicalSettled: true });
  await started.completion;
});

test('session deletion re-drives a differently-reasoned paused cancellation', async t => {
  const proofs = [false, true];
  const h = fixture(t, { provePausedCleanup: () => proofs.shift() });
  const { work, started, producer } = await start(h, 'session_delete');
  const first = h.runtime.cancel(work.work_id, { reason: 'user' });
  producer.resolve(pauseOutcome(work, 'delete'));
  await started.completion;
  assert.equal((await first.settlement).cleanup_confirmed, false);

  assert.deepEqual(await h.runtime.cancelSessionAndWait('session_delete', {
    reason: 'session_deleted', timeoutMs: 1000,
  }), { ok: true });
  assert.equal(h.store.get(work.work_id).status, 'cancelled');
  assert.equal(h.store.get(work.work_id).control_request.reason, 'user');
  assert.equal(h.scheduler.hasSessionCancellationFence('session_delete'), false);
});

test('checkpoint pause settles a pending cancellation before shutdown', async t => {
  const h = fixture(t, { provePausedCleanup: () => true });
  const { work, started, producer } = await start(h, 'session_proven');
  const cancellation = h.runtime.cancel(work.work_id, { reason: 'user' });
  producer.resolve(pauseOutcome(work, 'proven'));
  await started.completion;

  assert.equal((await cancellation.settlement).cleanup_confirmed, true);
  assert.equal(h.store.get(work.work_id).status, 'cancelled');
  assert.equal(h.scheduler.hasSessionCancellationFence('session_proven'), false);
  assert.deepEqual(await h.runtime.beginShutdown({ timeoutMs: 1000 }).completion, { ok: true });
});

test('durable unprovable paused cancellation permits shutdown and guarded reopen', async t => {
  let proofAttempts = 0;
  const h = fixture(t, { provePausedCleanup: () => { proofAttempts += 1; return false; } });
  const { work, started, producer } = await start(h, 'session_unproven');
  const cancellation = h.runtime.cancel(work.work_id, { reason: 'user' });
  producer.resolve(pauseOutcome(work, 'unproven'));
  await started.completion;

  assert.equal((await cancellation.settlement).cleanup_confirmed, false);
  assert.equal(proofAttempts, 1);
  assert.equal(h.store.get(work.work_id).status, 'paused');
  assert.equal(h.store.get(work.work_id).control_request.kind, 'cancel');
  assert.deepEqual(await h.runtime.beginShutdown({ timeoutMs: 1000 }).completion, { ok: true });
  assert.equal(proofAttempts, 2);
  assert.deepEqual(h.runtime.reopenAfterShutdown(), { ok: true });
  assert.equal(h.scheduler.hasSessionCancellationFence('session_unproven'), true);
  const producerCount = h.producers.length;
  h.scheduler.pump();
  assert.equal(h.producers.length, producerCount);
  assert.equal(h.store.get(work.work_id).status, 'paused');
});
