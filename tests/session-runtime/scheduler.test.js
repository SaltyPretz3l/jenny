'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuntimeStore, createRuntimeStoreIO } = require('../../services/session-runtime/store');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-scheduler-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sequence = 0;
  const store = new RuntimeStore(root, { io: { ...createRuntimeStoreIO() },
    createId: prefix => `${prefix}-${++sequence}` });
  const lanes = new RuntimeLaneAdmission();
  const producerCalls = [];
  const claims = [];
  const preparations = [];
  const canonical = new Map();
  const attention = [];
  const local = captureRuntimeRoute({ engine_type: 'ollama', provider_id: 'ollama',
    configuration_revision: 'config-1', resource_class: 'local', requires_gpu: true });
  const cloud = captureRuntimeRoute({ engine_type: 'chatgpt', provider_id: 'chatgpt',
    configuration_revision: 'config-1', resource_class: 'cloud', requires_gpu: false });
  const scheduler = new SessionRuntimeScheduler({ store, lanes,
    createId: () => `runtime-${++sequence}`,
    resolveRoute: work => work.input.cloud ? cloud : local,
    validateWork: () => {},
    prepareCanonical: work => { preparations.push(work.work_id); },
    claimCanonical: work => {
      claims.push(work.work_id);
      const claim = { streamId: `stream-${++sequence}`, authorityRevision: 'authority-1',
        rollbackBeforeStart: () => { canonical.delete(work.session_id); return true; },
        assertCurrent: () => assert.equal(canonical.get(work.session_id), claim) };
      canonical.set(work.session_id, claim);
      return claim;
    },
    startProducer: context => {
      // This port stands for the existing managed producer, which owns canonical
      // terminal persistence and physical cleanup before returning its proof.
      assert.equal(store.get(context.work.work_id).status, 'running');
      const waiting = deferred();
      producerCalls.push({ ...context, waiting });
      return waiting.promise;
    },
    onAttention: event => attention.push(event), ...overrides });
  function submit(sessionId, cloudRequest = false) {
    return store.submit({ idempotencyKey: `submit-${++sequence}`, sessionId,
      projectId: 'project_general', purpose: 'chat', input: { cloud: cloudRequest, prompt: 'hello' },
      authority: { project_id: 'project_general', root_path: null, root_id: null,
        root_revision: 0, device_id: null, inode: null } }).record;
  }
  return { store, lanes, scheduler, submit, producerCalls, claims, preparations, canonical, attention };
}

test('pending work uses no actor or producer and FIFO skips blocked lanes', async t => {
  const h = harness(t);
  const a = h.submit('a');
  const b = h.submit('b');
  const c = h.submit('c', true);
  const d = h.submit('d', true);
  const e = h.submit('e', true);
  assert.equal(h.claims.length, 0);
  assert.equal(h.producerCalls.length, 0);
  const results = h.scheduler.pump();
  assert.deepEqual(results.map(result => result.status), ['started', 'waiting', 'started', 'started', 'waiting']);
  assert.deepEqual(h.preparations, [a.work_id, c.work_id, d.work_id]);
  await Promise.resolve();
  assert.deepEqual(h.producerCalls.map(call => call.work.work_id), [a.work_id, c.work_id, d.work_id]);
  const first = h.producerCalls[0];
  first.waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  await results[0].completion;
  await Promise.resolve();
  assert.equal(h.store.get(b.work_id).status, 'running');
  assert.equal(h.store.get(e.work_id).status, 'pending');
  h.scheduler.setEnabled(false);
  for (const call of h.producerCalls.slice(1)) {
    call.waiting.resolve({ status: 'cancelled', producerSettled: true, canonicalSettled: true });
  }
  await Promise.all(results.filter(result => result.completion).map(result => result.completion));
  await Promise.resolve();
});

test('canonical admission races never start a producer or consume the turn lane', t => {
  const h = harness(t, { claimCanonical: () => {
    const error = new Error('busy'); error.code = 'session_busy'; throw error;
  } });
  const work = h.submit('a');
  assert.equal(h.scheduler.tryDispatch(work.work_id).reason, 'session_busy');
  assert.equal(h.store.get(work.work_id).status, 'pending');
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.equal(h.producerCalls.length, 0);
});

test('retryable proven no-claim failure releases the lane for the next attempt', async t => {
  const h = harness(t);
  const claimCanonical = h.scheduler.claimCanonical;
  const error = Object.assign(new Error('recovery failed'), {
    code: 'active_turn_recovery_failed', retryable: true, claimState: 'not_claimed',
  });
  h.scheduler.claimCanonical = () => {
    h.scheduler.claimCanonical = claimCanonical;
    throw error;
  };
  const work = h.submit('a');

  assert.deepEqual(h.scheduler.tryDispatch(work.work_id), {
    status: 'waiting', reason: 'active_turn_recovery_failed',
  });
  assert.equal(h.store.get(work.work_id).status, 'pending');
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.equal(h.lanes.snapshot().quarantined, 0);

  const started = h.scheduler.tryDispatch(work.work_id);
  assert.equal(started.status, 'started');
  await Promise.resolve();
  h.producerCalls[0].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  await started.completion;
});

test('non-retryable proven no-claim failure pauses through admission handling with clean lanes', t => {
  const error = Object.assign(new Error('invalid active turn'), {
    code: 'invalid_active_turn', claimState: 'not_claimed',
  });
  const h = harness(t, { claimCanonical: () => { throw error; } });
  const work = h.submit('a');

  assert.deepEqual(h.scheduler.tryDispatch(work.work_id), {
    status: 'rejected', reason: 'admission_revalidation_failed',
  });
  assert.equal(h.store.get(work.work_id).status, 'paused');
  assert.equal(h.store.get(work.work_id).transition.reason, 'admission_revalidation_failed');
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.equal(h.lanes.snapshot().quarantined, 0);
  assert.equal(h.attention.length, 1);
});

test('uncertain canonical claim failure remains paused with quarantined capacity', t => {
  const error = Object.assign(new Error('claim outcome unknown'), { code: 'invalid_active_turn' });
  const h = harness(t, { claimCanonical: () => { throw error; } });
  const work = h.submit('a');

  assert.deepEqual(h.scheduler.tryDispatch(work.work_id), {
    status: 'rejected', reason: 'canonical_claim_failed',
  });
  assert.equal(h.store.get(work.work_id).status, 'paused');
  assert.equal(h.store.get(work.work_id).transition.reason, 'canonical_claim_uncertain');
  assert.equal(h.lanes.snapshot().active_leases, 1);
  assert.equal(h.lanes.snapshot().quarantined, 1);
  assert.equal(h.attention.length, 1);
});

test('canonical preparation failure releases its unstarted lane and pauses for attention', t => {
  const h = harness(t, { prepareCanonical: () => { throw new Error('checkpoint corrupt'); } });
  const work = h.submit('a');
  const result = h.scheduler.tryDispatch(work.work_id);
  assert.deepEqual(result, { status: 'rejected', reason: 'admission_revalidation_failed' });
  assert.equal(h.store.get(work.work_id).status, 'paused');
  assert.equal(h.claims.length, 0);
  assert.equal(h.producerCalls.length, 0);
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.equal(h.lanes.snapshot().quarantined, 0);
  assert.equal(h.attention.length, 1);
});

test('OFF pauses queued work, preserves active capacity, and ON needs explicit resume', async t => {
  const h = harness(t);
  const a = h.submit('a');
  const b = h.submit('b');
  const started = h.scheduler.tryDispatch(a.work_id);
  await Promise.resolve();
  h.scheduler.setEnabled(false);
  assert.equal(h.store.get(b.work_id).status, 'paused');
  assert.equal(h.scheduler.resume(b.work_id, h.store.get(b.work_id).revision).reason, 'runtime_disabled');
  assert.equal(h.lanes.snapshot().active_leases, 1);
  h.producerCalls[0].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  await started.completion;
  h.scheduler.setEnabled(true);
  h.scheduler.pump();
  assert.equal(h.store.get(b.work_id).status, 'paused');
  h.scheduler.resume(b.work_id, h.store.get(b.work_id).revision);
  await Promise.resolve();
  assert.equal(h.store.get(b.work_id).status, 'running');
  h.scheduler.setEnabled(false);
  h.producerCalls[1].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  await Promise.resolve();
});

test('unknown producer failure preserves durable attention and quarantined capacity', async t => {
  const h = harness(t);
  const work = h.submit('a');
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  h.producerCalls[0].waiting.reject(new Error('transport disappeared'));
  assert.equal((await started.completion).status, 'needs_attention');
  assert.equal(h.store.get(work.work_id).status, 'needs_attention');
  assert.equal(h.lanes.snapshot().quarantined, 1);
  assert.equal(h.scheduler.hasPendingOrAdmittedWork(), true);
  assert.equal(h.scheduler.tryDispatch(h.submit('b').work_id).status, 'waiting');
});

// B3D-1: an unproven outcome parks the entry in `active` with its lane
// quarantined, and nothing ever retires it. A backend restart is the
// process-tree proof the producer could not give, so the runtime reclaims
// such entries instead of refusing to reopen on every later backend start.
test('backend-restart reclaim retires an abandoned unproven producer and frees its lane', async t => {
  const h = harness(t);
  const work = h.submit('a');
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  const attempt = h.producerCalls[0].attempt;
  h.producerCalls[0].waiting.reject(new Error('sidecar exited'));
  assert.equal((await started.completion).status, 'needs_attention');
  assert.equal(h.lanes.snapshot().quarantined, 1);
  const cleanup = h.scheduler.cleanupPromises();
  assert.equal(cleanup.length, 1);

  const report = h.scheduler.reclaimAbandoned({ reason: 'backend_restart' });
  assert.deepEqual(report, { reclaimed: [{ work_id: work.work_id, session_id: 'a', status: 'failed' }],
    retained: [] });
  assert.equal(h.store.get(work.work_id).status, 'failed');
  assert.equal(h.store.get(work.work_id).transition.reason, 'backend_restart');
  assert.equal(h.scheduler.active.size, 0);
  assert.equal(h.lanes.snapshot().quarantined, 0);
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.deepEqual(await cleanup[0], { status: 'failed', work_id: work.work_id, cleanup_confirmed: true });
  assert.equal(h.scheduler.hasPendingOrAdmittedWork(), false);
  // Late proof from the retired attempt is stale, never a second settlement.
  assert.deepEqual(await h.scheduler.confirmLateSettlement({ workId: work.work_id, attempt,
    outcome: { status: 'failed', producerSettled: true, canonicalSettled: true } }),
  { status: 'rejected', reason: 'runtime_attempt_stale' });
  assert.equal(h.scheduler.tryDispatch(h.submit('b').work_id).status, 'started');
});

test('backend-restart reclaim leaves a producer that has not returned alone', async t => {
  const h = harness(t);
  const work = h.submit('a');
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();

  const report = h.scheduler.reclaimAbandoned({ reason: 'backend_restart' });
  assert.deepEqual(report, { reclaimed: [],
    retained: [{ work_id: work.work_id, reason: 'runtime_producer_pending' }] });
  assert.equal(h.scheduler.active.size, 1);
  assert.equal(h.store.get(work.work_id).status, 'running');
  h.producerCalls[0].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  assert.equal((await started.completion).status, 'completed');
});

test('attempt-fenced late cleanup persists terminal evidence before releasing quarantined capacity', async t => {
  const h = harness(t);
  const work = h.submit('a');
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  const attempt = h.producerCalls[0].attempt;
  h.producerCalls[0].waiting.resolve({
    status: 'cancelled', producerSettled: false, canonicalSettled: true,
  });
  assert.equal((await started.completion).status, 'needs_attention');
  assert.equal(h.store.get(work.work_id).status, 'needs_attention');
  assert.equal(h.lanes.snapshot().quarantined, 1);

  const stale = await h.scheduler.confirmLateSettlement({
    workId: work.work_id, attempt: { ...attempt, attempt_id: 'stale-attempt' },
    outcome: { status: 'cancelled', producerSettled: true, canonicalSettled: true },
  });
  assert.deepEqual(stale, { status: 'rejected', reason: 'runtime_attempt_stale' });
  assert.equal(h.store.get(work.work_id).status, 'needs_attention');
  assert.equal(h.lanes.snapshot().quarantined, 1);

  const settled = await h.scheduler.confirmLateSettlement({
    workId: work.work_id, attempt,
    outcome: { status: 'cancelled', producerSettled: true, canonicalSettled: true },
  });
  assert.equal(settled.status, 'cancelled');
  assert.equal(h.store.get(work.work_id).status, 'cancelled');
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.equal(h.scheduler.hasPendingOrAdmittedWork(), false);

  const duplicate = await h.scheduler.confirmLateSettlement({
    workId: work.work_id, attempt,
    outcome: { status: 'cancelled', producerSettled: true, canonicalSettled: true },
  });
  assert.deepEqual(duplicate, { status: 'rejected', reason: 'runtime_attempt_stale' });
});

test('late terminal persistence failure keeps the turn quarantined', async t => {
  const h = harness(t);
  const work = h.submit('a');
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  const attempt = h.producerCalls[0].attempt;
  h.producerCalls[0].waiting.resolve({
    status: 'failed', producerSettled: false, canonicalSettled: true,
  });
  await started.completion;
  const write = h.store.io.writeJsonAtomic;
  h.store.io.writeJsonAtomic = (filePath, value) => {
    if (filePath === h.store.journalPath && value.record.status === 'failed') {
      throw new Error('disk unavailable at late settlement');
    }
    return write(filePath, value);
  };
  const result = await h.scheduler.confirmLateSettlement({
    workId: work.work_id, attempt,
    outcome: { status: 'failed', producerSettled: true, canonicalSettled: true },
  });
  assert.equal(result.status, 'needs_attention');
  assert.equal(h.store.get(work.work_id).status, 'needs_attention');
  assert.equal(h.lanes.snapshot().quarantined, 1);
  assert.equal(h.scheduler.hasPendingOrAdmittedWork(), true);
});

test('revocation between durable admission and producer start rolls back without dispatch', async t => {
  let revoked = false;
  const h = harness(t, { validateWork: () => { if (revoked) throw new Error('authority_changed'); } });
  const work = h.submit('a');
  const started = h.scheduler.tryDispatch(work.work_id);
  revoked = true;
  assert.equal((await started.completion).status, 'failed');
  assert.equal(h.producerCalls.length, 0);
  assert.equal(h.canonical.size, 0);
  assert.equal(h.lanes.snapshot().active_leases, 0);
});

test('explicit immediate Send still uses scoped lane admission while OFF', async t => {
  const h = harness(t, { enabled: false });
  const queued = h.submit('queued');
  assert.equal(h.scheduler.tryDispatch(queued.work_id).reason, 'runtime_disabled');
  assert.equal(h.store.get(queued.work_id).status, 'paused');
  const work = h.submit('a');
  const started = h.scheduler.tryDispatch(work.work_id, { immediate: true });
  await Promise.resolve();
  const refused = h.submit('b');
  assert.equal(h.scheduler.tryDispatch(refused.work_id, { immediate: true }).reason, 'lane_capacity');
  assert.equal(h.store.get(refused.work_id).status, 'paused');
  h.producerCalls[0].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  await started.completion;
  h.scheduler.setEnabled(true);
  h.scheduler.pump();
  assert.equal(h.producerCalls.length, 1);
  assert.equal(h.store.get(refused.work_id).status, 'paused');
  assert.equal(h.store.get(queued.work_id).status, 'paused');
});

test('temporary admission refusal leaves durable work pending without acquiring a lane', t => {
  const h = harness(t, { validateWork: () => {
    const error = new Error('GPU unavailable'); error.retryable = true; error.code = 'gpu_busy_plugin'; throw error;
  } });
  const work = h.submit('a');
  assert.equal(h.scheduler.tryDispatch(work.work_id).reason, 'gpu_busy_plugin');
  assert.equal(h.store.get(work.work_id).status, 'pending');
  assert.equal(h.claims.length, 0);
  assert.equal(h.lanes.snapshot().active_leases, 0);
});

test('failed durable running transition rolls back the canonical claim before any producer starts', t => {
  const h = harness(t);
  const work = h.submit('a');
  const write = h.store.io.writeJsonAtomic;
  h.store.io.writeJsonAtomic = (filePath, value) => {
    if (filePath === h.store.journalPath && value.record.status === 'running') {
      throw new Error('disk unavailable at admission');
    }
    return write(filePath, value);
  };
  const result = h.scheduler.tryDispatch(work.work_id);
  assert.equal(result.reason, 'canonical_claim_failed');
  // The journal never landed, so nothing changed on disk or in memory: the
  // store stays writable and the work is still pending for a later dispatch.
  assert.equal(h.store.getStatus().read_only, false);
  assert.equal(h.store.get(work.work_id).status, 'pending');
  assert.equal(h.canonical.size, 0);
  assert.equal(h.producerCalls.length, 0);
  assert.equal(h.lanes.snapshot().active_leases, 0);
  h.store.io.writeJsonAtomic = write;
  assert.equal(h.scheduler.tryDispatch(work.work_id).status, 'started');
});

test('terminal persistence failure retains capacity even after a producer reports settlement', async t => {
  const h = harness(t);
  const work = h.submit('a');
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  const write = h.store.io.writeJsonAtomic;
  h.store.io.writeJsonAtomic = (filePath, value) => {
    if (filePath === h.store.journalPath && value.record.status === 'completed') {
      throw new Error('disk unavailable at settlement');
    }
    return write(filePath, value);
  };
  h.producerCalls[0].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  assert.equal((await started.completion).status, 'needs_attention');
  // The failed journal write latches nothing (memory still matches disk), but
  // an outcome that never persisted still quarantines the lane it held.
  assert.equal(h.store.getStatus().read_only, false);
  assert.equal(h.store.get(work.work_id).status, 'running');
  assert.equal(h.lanes.snapshot().quarantined, 1);
  assert.equal(h.scheduler.hasPendingOrAdmittedWork(), true);
});

test('stale producer callbacks cannot mutate a newer durable state', async t => {
  const h = harness(t);
  const work = h.submit('a');
  const started = h.scheduler.tryDispatch(work.work_id);
  await Promise.resolve();
  const running = h.store.get(work.work_id);
  h.store.transition(work.work_id, { expectedRevision: running.revision,
    expectedAttempt: running.attempt, to: 'paused', reason: 'external_safe_pause' });
  assert.throws(() => h.producerCalls[0].assertCurrent(), /runtime_attempt_stale/);
  h.producerCalls[0].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  assert.equal((await started.completion).status, 'needs_attention');
  assert.equal(h.store.get(work.work_id).status, 'paused');
  assert.equal(h.lanes.snapshot().quarantined, 1);
});


test('live pause notification follows durable intent and never releases admission itself', async t => {
  let notified = 0;
  let h;
  h = harness(t, { pauseProducer(work) {
    notified += 1;
    assert.equal(h.store.get(work.work_id).control_request.kind, 'pause');
    assert.equal(h.store.get(work.work_id).revision, work.revision);
    assert.equal(h.lanes.snapshot().active_leases, 1);
  } });
  const submitted = h.submit('pause-decision');
  const [started] = h.scheduler.pump();
  await Promise.resolve();
  const active = h.store.get(submitted.work_id);
  assert.equal(h.scheduler.requestPause(active.work_id, { expectedRevision: active.revision - 1 }).reason, 'revision_conflict');
  assert.equal(notified, 0);
  assert.equal(h.scheduler.requestPause(active.work_id, { expectedRevision: active.revision }).status, 'requested');
  assert.equal(notified, 1);
  assert.equal(h.store.get(active.work_id).status, 'running');
  assert.equal(h.lanes.snapshot().active_leases, 1);
  h.producerCalls[0].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  await started.completion;
  assert.equal(h.lanes.snapshot().active_leases, 0);
});

test('explicit resume under retryable admission pressure waits instead of refusing', async t => {
  let pressure = true;
  const h = harness(t, { validateWork: () => {
    if (pressure) throw Object.assign(new Error('runtime_transcript_cache_pressure'), {
      code: 'runtime_transcript_cache_pressure', retryable: true });
  } });
  const a = h.submit('a');
  h.scheduler.setEnabled(false);
  assert.equal(h.store.get(a.work_id).status, 'paused');
  h.scheduler.setEnabled(true);
  assert.deepEqual(h.scheduler.resume(a.work_id, h.store.get(a.work_id).revision), { status: 'accepted' });
  assert.equal(h.store.get(a.work_id).status, 'pending');
  assert.equal(h.producerCalls.length, 0);
  assert.equal(h.attention.length, 0);
  pressure = false;
  assert.equal(h.scheduler.notifyLaneAvailability(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.store.get(a.work_id).status, 'running');
  h.scheduler.setEnabled(false);
  h.producerCalls[0].waiting.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  await Promise.resolve();
});

test('explicit resume still refuses work whose admission failure is not retryable', t => {
  const h = harness(t, { validateWork: () => { throw new Error('session_runtime_context_unavailable'); } });
  const a = h.submit('a');
  h.scheduler.setEnabled(false);
  h.scheduler.setEnabled(true);
  assert.throws(() => h.scheduler.resume(a.work_id, h.store.get(a.work_id).revision),
    { message: 'session_runtime_context_unavailable' });
  assert.equal(h.store.get(a.work_id).status, 'paused');
});
