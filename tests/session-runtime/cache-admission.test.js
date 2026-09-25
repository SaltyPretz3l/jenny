'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAdapterHarness } = require('../helpers/session-runtime-chat-adapter-harness');
const { initializeSessionRuntimeComposition } = require('../../services/session-runtime/composition');
const { ensureSessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const { retainManagedRuntimeController } = require('../../services/backend/chat-lifecycle-contracts');

const tick = () => new Promise(resolve => setImmediate(resolve));

async function waitFor(check, message) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(typeof message === 'function' ? message() : message);
}

function fixture(t) {
  const h = createAdapterHarness(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-cache-admission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = [];
  h.service._emitServiceLog = (...args) => logs.push(args);
  h.service.options = { userDataPath: root };
  h.service.featureFlags.session_runtime = true;
  h.service.turnEventJournal = { list: () => [] };
  const actors = ensureSessionTurnActorRegistry(h.service);
  const runtime = initializeSessionRuntimeComposition(h.service);
  const starts = [];
  h.service._startManagedSidecarChatStream = async request => {
    starts.push(request);
    const lease = request.turnLease;
    const controller = new AbortController();
    actors.attachController(lease, controller);
    controller._runtimeCompletion = Promise.resolve({ status: 'completed',
      producerSettled: true, canonicalSettled: true });
    actors.release(lease, { status: 'completed' });
    return retainManagedRuntimeController({ sessionId: h.sessionId, streamId: lease.identity.streamId }, controller);
  };
  const canonical = h.service.sessionStore;
  const pressureId = canonical.createSession({ title: 'Pressure source' }).id;
  function dirty({ debounce = false, known = false } = {}) {
    const backend = canonical._backend;
    const record = canonical.getSession(pressureId);
    record.messages.push({ role: 'assistant', content: 'retained dirty content' });
    record.title = 'Dirty source';
    if (debounce) {
      backend._getOrCreateSessionStore(pressureId)._writeDebounceMs = 15;
      backend._indexStore._writeDebounceMs = 15;
    }
    backend.upsertSession(pressureId, record, { persist: debounce });
    if (known) {
      backend._transcriptCache.limitBytes = 1;
      backend._transcriptCache.measure(pressureId, backend._loadedSessions.get(pressureId));
    }
    assert.equal(canonical.getTranscriptCachePressure().backpressured, true);
  }
  const submit = () => runtime.submit({ sessionId: h.sessionId, prompt: 'hello' }, { idempotencyKey: 'send_1' });
  return { ...h, runtime, actors, canonical, pressureId, dirty, submit, starts, logs };
}

for (const known of [false, true]) test(`cache pressure (${known ? 'known bytes' : 'unknown dirty bytes'}) queues without actor/history allocation and flush wakes`, async t => {
  const h = fixture(t);
  h.dirty({ known });
  const get = h.canonical.getSession;
  h.canonical.getSession = () => { throw new Error('pending transcript hydration'); };
  const work = await h.submit();
  await tick();
  assert.equal(h.runtime.store.get(work.work_id).status, 'pending');
  assert.equal(h.starts.length, 0);
  assert.equal(h.actors._actors.size, 0);
  assert.equal(h.runtime.lanes.snapshot().active_leases, 0);
  h.canonical.getSession = get;
  assert.equal(h.canonical.flushSession(h.pressureId), true);
  await waitFor(() => h.runtime.store.get(work.work_id).status === 'completed', () => JSON.stringify({ status: h.runtime.store.get(work.work_id).status, pressure: h.canonical.getTranscriptCachePressure(), logs: h.logs }));
  assert.equal(h.starts.length, 1);
  assert.equal(h.canonical.getSession(h.pressureId).messages.at(-1).content, 'retained dirty content');
});

test('automatic debounced write completion wakes queued admission', async t => {
  const h = fixture(t);
  h.dirty({ debounce: true });
  const work = await h.submit();
  assert.equal(h.starts.length, 0);
  await waitFor(() => h.runtime.store.get(work.work_id).status === 'completed', 'debounced completion did not wake');
  assert.equal(h.starts.length, 1);
});

for (const control of ['off', 'closing', 'pause']) test(`cache flush does not reopen ${control} work`, async t => {
  const h = fixture(t);
  h.dirty();
  const work = await h.submit();
  await tick();
  if (control === 'off') h.runtime.setEnabled(false);
  else if (control === 'closing') h.runtime.beginShutdown();
  else h.runtime.pausePending({ sessionId: h.sessionId });
  h.canonical.flushSession(h.pressureId);
  await tick();
  if (control === 'off') h.runtime.setEnabled(true);
  await tick();
  assert.equal(h.starts.length, 0);
  assert.equal(h.runtime.store.get(work.work_id).status, 'paused');
});

test('active producers keep authority and capacity when another transcript becomes dirty', async t => {
  const h = fixture(t);
  let resolve;
  h.service._startManagedSidecarChatStream = async request => {
    h.starts.push(request);
    const controller = new AbortController();
    h.actors.attachController(request.turnLease, controller);
    controller._runtimeCompletion = new Promise(done => { resolve = done; });
    return retainManagedRuntimeController({ sessionId: h.sessionId,
      streamId: request.turnLease.identity.streamId }, controller);
  };
  const work = await h.submit();
  await waitFor(() => h.starts.length === 1, 'producer did not start');
  h.dirty();
  const request = h.starts[0];
  assert.doesNotThrow(() => request.runtimeAssertCurrent());
  const lane = h.runtime.lanes.snapshot().lanes[0];
  assert.equal(lane.turns, 1);
  assert.equal(lane.inference_requests, 1);
  h.actors.release(request.turnLease, { status: 'completed' });
  resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  await waitFor(() => h.runtime.store.get(work.work_id).status === 'completed', 'active producer did not settle');
});


for (const owner of ['session', 'index']) test(`failed ${owner} debounce cannot release pressure before durable retry`, async t => {
  const h = fixture(t);
  const fileStore = owner === 'session' ? h.canonical._backend._getOrCreateSessionStore(h.pressureId)
    : h.canonical._backend._indexStore;
  const write = fileStore._writeNowAsync;
  let failed = false;
  fileStore._logDebouncedWriteFailure = () => {};
  fileStore._writeNowAsync = async () => { failed = true; throw new Error('injected disk failure'); };
  h.dirty({ debounce: true });
  const work = await h.submit();
  await waitFor(() => failed && !fileStore.hasPendingWrite(), 'failure did not settle');
  await tick();
  assert.equal(h.canonical.getTranscriptCachePressure().backpressured, true);
  assert.equal(h.runtime.store.get(work.work_id).status, 'pending');
  assert.equal(h.starts.length, 0);
  fileStore._writeNowAsync = write;
  assert.equal(h.canonical.flushSession(h.pressureId), true);
  await waitFor(() => h.runtime.store.get(work.work_id).status === 'completed', 'durable retry did not wake');
});

test('cancelled deletion work cannot reopen after pressure relief', async t => {
  const h = fixture(t);
  h.dirty();
  const work = await h.submit();
  await tick();
  assert.equal((await h.runtime.cancelSessionAndWait(h.sessionId)).ok, true);
  h.canonical.deleteSession(h.sessionId);
  h.canonical.flushSession(h.pressureId);
  await tick();
  assert.equal(h.starts.length, 0);
  assert.equal(h.runtime.store.get(work.work_id).status, 'cancelled');
});

test('disposal removes cache observers and queued notifications cannot dispatch', async t => {
  const h = fixture(t);
  h.dirty();
  const work = await h.submit();
  await tick();
  h.canonical.flushSession(h.pressureId);
  h.canonical.dispose();
  await tick();
  assert.equal(h.canonical._backend._cacheAvailabilityListeners.size, 0);
  assert.equal(h.starts.length, 0);
  assert.equal(h.runtime.store.get(work.work_id).status, 'pending');
});


test('flush alone retries a paused resource continuation whose earlier wake hit cache pressure', async t => {
  const { capacityResource } = require('../../services/session-runtime/resource-broker');
  const { assertRuntimeTranscriptAdmission } = require('../../services/backend/chat-turn-admission');
  const h = fixture(t);
  const runtime = h.runtime;
  const resource = capacityResource('tests');
  const blocker = await runtime.resourceBroker.acquire({ ownerId: 'occupied_test', resources: [resource] });
  const work = runtime.store.submit({ idempotencyKey: 'saved', projectId: 'project_general',
    sessionId: h.sessionId, purpose: 'chat', input: { prompt: 'saved' },
    authority: h.service.projectAuthority.captureSession(h.sessionId) }).record;
  const attempt = { attempt_id: 'saved_attempt', stream_id: 'saved_stream',
    incarnation: runtime.scheduler.incarnation, authority_revision: 'saved_authority' };
  const running = runtime.store.transition(work.work_id, { expectedRevision: work.revision,
    to: 'running', reason: 'admitted', attempt }).record;
  const paused = runtime.store.transition(work.work_id, { expectedRevision: running.revision,
    expectedAttempt: attempt, to: 'paused', reason: 'checkpoint_suspended', checkpointRef: {
      schema_version: 1, checkpoint_id: 'saved_checkpoint', sha256: 'a'.repeat(64), bytes: 10,
      source_attempt: attempt,
    } }).record;
  const coordinator = runtime.eligibilityCoordinator;
  const admission = coordinator.captureAdmission(h.sessionId);
  assert.equal(coordinator.track(paused.work_id, [resource], { admission }).status, 'tracked');
  coordinator.releaseAdmission(admission);
  let attempts = 0;
  let resumed = 0;
  // Checkpoint restoration has its own real-owner suites. This controlled port
  // isolates the production composition's cache signal and retained wait retry.
  coordinator.resume = () => {
    attempts += 1;
    assertRuntimeTranscriptAdmission(h.service);
    resumed += 1;
    return { status: 'accepted' };
  };
  h.dirty();
  runtime.resourceBroker.release(blocker, { producerSettled: true });
  await tick();
  assert.ok(attempts >= 1);
  const beforeFlush = attempts;
  await tick();
  assert.equal(attempts, beforeFlush, 'pressure retries must not spin');
  assert.equal(resumed, 0);
  assert.equal(coordinator.snapshot().wait_count, 1);
  h.canonical.flushSession(h.pressureId);
  await waitFor(() => resumed === 1, 'cache relief did not wake retained eligibility');
  await tick();
  assert.equal(attempts, beforeFlush + 1);
  assert.equal(coordinator.snapshot().wait_count, 0);
});
