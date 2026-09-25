'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { deleteSessionWithQuiescence } = require('../../services/backend/backend-session-delete-lifecycle');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');
const { SessionRuntimeService } = require('../../services/session-runtime/service');
const { RuntimeStore } = require('../../services/session-runtime/store');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, { cancellationTimeoutMs = 25, allowDeletionPausedCleanup = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lifecycle-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sequence = 0;
  const events = [];
  const producers = [];
  const cleanupProofs = [];
  const deletionHandle = Object.freeze({ sessionId: 'session_1', deletionId: 'deletion_1' });
  const store = new RuntimeStore(root, { createId: prefix => `${prefix}_${++sequence}` });
  const lanes = new RuntimeLaneAdmission();
  const route = captureRuntimeRoute({ engine_type: 'mock', provider_id: 'mock',
    configuration_revision: 'config_1', resource_class: 'local', requires_gpu: false });
  const scheduler = new SessionRuntimeScheduler({
    store,
    lanes,
    enabled: true,
    createId: () => `runtime_${++sequence}`,
    resolveRoute: () => route,
    validateWork() {},
    prepareCanonical() {},
    claimCanonical() {
      return {
        streamId: `stream_${++sequence}`,
        authorityRevision: `authority_${sequence}`,
        assertCurrent() {},
        rollbackBeforeStart() { events.push('canonical:rollback'); return true; },
      };
    },
    startProducer(context) {
      const waiting = deferred();
      producers.push({ context, waiting });
      events.push('producer:start');
      return waiting.promise.then((outcome) => {
        events.push('producer:settled');
        return outcome;
      });
    },
    cancelProducer() { events.push('producer:cancel'); return true; },
    discardPending() { events.push('queued:discard'); return true; },
    provePausedCleanup(work, options) {
      cleanupProofs.push({ work, options });
      return allowDeletionPausedCleanup && options?.deletionHandle === deletionHandle;
    },
  });
  const runtime = new SessionRuntimeService({
    store,
    scheduler,
    chatAdapter: { prepareImmediate() {} },
  });
  let session = { id: 'session_1', updated_at: 'current' };
  const sessionStore = {
    getSession: () => session,
    deleteSession() { events.push('session:delete'); session = null; return true; },
  };
  const sessionTurnActors = {
    beginDeletion() { events.push('actor:begin'); return deletionHandle; },
    async awaitQuiescence() { events.push('actor:quiesced'); return { ok: true }; },
    async commitDeletion(_handle, mutation) {
      events.push('actor:commit');
      const result = await mutation();
      return { ok: result?.deleted === true, result };
    },
    rollbackDeletion() { events.push('actor:rollback'); return true; },
  };
  const runtimePort = {
    hasSessionWork: sessionId => runtime.hasSessionWork(sessionId),
    cancelSessionAndWait(sessionId, options) {
      events.push('runtime:cancel');
      return runtime.cancelSessionAndWait(sessionId, {
        ...options,
        timeoutMs: cancellationTimeoutMs,
      });
    },
  };
  const backend = {
    sessionRuntime: runtimePort,
    sessionStore,
    sessionTurnActors,
    cancelChatStream: () => false,
    _emitServiceLog() {},
  };
  function submit() {
    return store.submit({
      idempotencyKey: `submit_${++sequence}`,
      projectId: 'project_1',
      sessionId: 'session_1',
      purpose: 'chat',
      input: { prompt: 'hello' },
      authority: { project_id: 'project_1', root_path: null, root_id: null,
        root_revision: 0, device_id: null, inode: null },
    }).record;
  }
  return { backend, cleanupProofs, deletionHandle, events, lanes, producers, runtime,
    scheduler, store, submit, session: () => session };
}

test('queued runtime work is durably cancelled before session deletion commits', async t => {
  const h = fixture(t);
  const work = h.submit();

  const result = await deleteSessionWithQuiescence(h.backend, 'session_1');

  assert.equal(result.deleted, true);
  assert.equal(h.store.get(work.work_id).status, 'cancelled');
  assert.equal(h.session(), null);
  assert.ok(h.events.indexOf('queued:discard') < h.events.indexOf('actor:commit'));
  assert.ok(h.events.indexOf('runtime:cancel') < h.events.indexOf('actor:commit'));
});

test('paused checkpoint deletion uses only its exact actor deletion owner as cleanup proof', async t => {
  const h = fixture(t, { allowDeletionPausedCleanup: true });
  const pending = h.submit();
  const attempt = { attempt_id: 'attempt_paused', stream_id: 'stream_paused',
    incarnation: 'host_paused', authority_revision: 'authority_paused' };
  const running = h.store.transition(pending.work_id, { expectedRevision: pending.revision,
    to: 'running', reason: 'fixture', attempt }).record;
  const checkpointRef = { schema_version: 1, checkpoint_id: 'checkpoint_paused',
    sha256: 'a'.repeat(64), bytes: 10, source_attempt: attempt };
  h.store.transition(running.work_id, { expectedRevision: running.revision,
    expectedAttempt: attempt, to: 'paused', reason: 'checkpoint', checkpointRef });

  const result = await deleteSessionWithQuiescence(h.backend, 'session_1');

  assert.equal(result.deleted, true);
  assert.equal(h.store.get(pending.work_id).status, 'cancelled');
  assert.equal(h.cleanupProofs.length, 1);
  assert.equal(h.cleanupProofs[0].options.deletionHandle, h.deletionHandle);
  assert.deepEqual(h.store.get(pending.work_id).checkpoint_ref, checkpointRef);
});

test('running work holds deletion until producer and canonical cleanup are proven', async t => {
  const h = fixture(t);
  const work = h.submit();
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  assert.equal(h.producers.length, 1);

  let deletionSettled = false;
  const deleting = deleteSessionWithQuiescence(h.backend, 'session_1').then((result) => {
    deletionSettled = true;
    return result;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deletionSettled, false);
  assert.equal(h.events.includes('actor:commit'), false);

  h.producers[0].waiting.resolve({
    status: 'cancelled', producerSettled: true, canonicalSettled: true,
  });
  const [result, outcome] = await Promise.all([deleting, started.completion]);

  assert.equal(result.deleted, true);
  assert.equal(outcome.status, 'cancelled');
  assert.equal(h.store.get(work.work_id).status, 'cancelled');
  assert.ok(h.events.indexOf('producer:settled') < h.events.indexOf('actor:commit'));
  assert.equal(h.lanes.snapshot().active_leases, 0);
});

test('unknown canonical cleanup refuses deletion and rolls the actor back', async t => {
  const h = fixture(t, { cancellationTimeoutMs: 10 });
  const work = h.submit();
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();

  const deleting = deleteSessionWithQuiescence(h.backend, 'session_1');
  h.producers[0].waiting.resolve({
    status: 'cancelled', producerSettled: true, canonicalSettled: false,
  });
  assert.equal((await started.completion).status, 'needs_attention');
  const result = await deleting;

  assert.equal(result.deleted, false);
  assert.equal(result.reason, 'runtime_cleanup_timeout');
  assert.notEqual(h.session(), null);
  assert.equal(h.events.includes('actor:commit'), false);
  assert.equal(h.events.at(-1), 'actor:rollback');
  assert.equal(h.store.get(work.work_id).status, 'needs_attention');
  assert.equal(h.lanes.snapshot().quarantined, 1);
});
