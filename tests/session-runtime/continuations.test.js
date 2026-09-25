'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuntimeStore, createRuntimeStoreIO } = require('../../services/session-runtime/store');
const { normalizeCheckpointRef, validateWorkRecord, MAX_CHECKPOINT_BYTES } = require('../../services/session-runtime/contracts');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');

function reference(attempt) {
  return { schema_version: 1, checkpoint_id: 'checkpoint_1', sha256: 'a'.repeat(64),
    bytes: 100, source_attempt: { ...attempt } };
}

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-continuation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sequence = 0;
  const io = { ...createRuntimeStoreIO() };
  const store = new RuntimeStore(root, { io, createId: prefix => `${prefix}_${++sequence}` });
  const work = store.submit({ idempotencyKey: 'send_1', projectId: 'project_1', sessionId: 'session_1',
    purpose: 'chat', input: { prompt: 'hello' }, authority: { project_id: 'project_1',
      root_path: null, root_id: null, root_revision: 0, device_id: null, inode: null } }).record;
  const route = captureRuntimeRoute({ engine_type: 'mock', provider_id: 'mock',
    configuration_revision: 'config_1', resource_class: 'local', requires_gpu: false });
  const lanes = new RuntimeLaneAdmission();
  const attention = [];
  let claims = 0;
  const scheduler = new SessionRuntimeScheduler({ store, lanes,
    createId: () => `id_${++sequence}`, resolveRoute: () => route, validateWork() {},
    claimCanonical: () => { claims += 1; return { streamId: `stream_${++sequence}`,
      authorityRevision: `authority_${sequence}`, assertCurrent() {}, rollbackBeforeStart: () => true }; },
    startProducer: ({ attempt }) => ({ status: 'paused', producerSettled: true,
      canonicalSettled: true, checkpointSettled: true, checkpointRef: reference(attempt) }),
    validateCheckpoint: () => true, onAttention: event => attention.push(event), ...overrides });
  return { root, io, store, work, lanes, scheduler, attention, claims: () => claims };
}

test('checkpoint references are closed, bounded and carry the complete source attempt fence', t => {
  const setup = fixture(t);
  const attempt = { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
    authority_revision: 'authority_1' };
  assert.deepEqual(normalizeCheckpointRef(reference(attempt)), reference(attempt));
  for (const changed of [{ bytes: true }, { bytes: MAX_CHECKPOINT_BYTES + 1 }, { schema_version: 2 },
    { sha256: 'bad' }, { credentials: 'forbidden' }, { source_attempt: { attempt_id: 'attempt_1' } }]) {
    assert.equal(normalizeCheckpointRef({ ...reference(attempt), ...changed }), undefined);
  }
  const legacy = { ...setup.work };
  delete legacy.checkpoint_ref;
  assert.equal(validateWorkRecord(legacy).record.checkpoint_ref, null);
  assert.equal(validateWorkRecord({ ...legacy, unknown_future_field: true }).ok, false);
  assert.equal(validateWorkRecord({ ...legacy, schema_version: 2 }).reason, 'future_schema');
  assert.equal(validateWorkRecord({ ...legacy, checkpoint_ref: reference(attempt) }).ok, false);
});

test('only a fully proven checkpoint suspension durably pauses and releases the turn lane', async t => {
  const setup = fixture(t);
  const start = setup.scheduler.tryDispatch(setup.work.work_id);
  const admitted = setup.store.get(setup.work.work_id);
  assert.equal((await start.completion).status, 'paused');
  const paused = setup.store.get(setup.work.work_id);
  assert.deepEqual(paused.checkpoint_ref, reference(admitted.attempt));
  assert.equal(setup.lanes.snapshot().active_leases, 0);
  assert.equal(setup.scheduler.active.size, 0);
  assert.equal(new RuntimeStore(setup.root).get(setup.work.work_id).status, 'paused');
  setup.scheduler.validateCheckpoint = () => false;
  assert.equal(setup.scheduler.resume(paused.work_id, paused.revision).status, 'accepted');
  const validationFailed = setup.store.get(paused.work_id);
  assert.equal(validationFailed.status, 'paused');
  assert.equal(setup.claims(), 1);
  assert.equal(setup.lanes.snapshot().active_leases, 0);
  assert.equal(setup.attention.at(-1).reason, 'runtime_checkpoint_required');
  setup.scheduler.validateCheckpoint = () => true;
  setup.scheduler.startProducer = () => ({ status: 'completed', producerSettled: true, canonicalSettled: true });
  assert.equal(setup.scheduler.resume(paused.work_id, validationFailed.revision).status, 'accepted');
  const resumed = setup.store.get(paused.work_id);
  assert.equal(resumed.turn_id, paused.turn_id);
  assert.notEqual(resumed.attempt.attempt_id, paused.attempt.attempt_id);
  assert.notEqual(resumed.attempt.stream_id, paused.attempt.stream_id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(setup.store.get(paused.work_id).status, 'completed');
});

test('missing cleanup, absent checkpoint owner and mismatched fences quarantine suspension', async t => {
  for (const fault of ['producer', 'canonical', 'checkpoint', 'owner', 'fence']) {
    const setup = fixture(t, {
      validateCheckpoint: fault === 'owner' ? null : () => true,
      startProducer: ({ attempt }) => ({ status: 'paused', producerSettled: fault !== 'producer',
        canonicalSettled: fault !== 'canonical', checkpointSettled: fault !== 'checkpoint',
        checkpointRef: reference(fault === 'fence' ? { ...attempt, stream_id: 'stale_stream' } : attempt) }),
    });
    const result = await setup.scheduler.tryDispatch(setup.work.work_id).completion;
    assert.equal(result.status, 'needs_attention', fault);
    assert.equal(setup.lanes.snapshot().active_leases, 1, fault);
    assert.equal(setup.store.get(setup.work.work_id).checkpoint_ref, null);
  }
});

test('a failed durable suspension commit never releases physical admission', async t => {
  const setup = fixture(t);
  const original = setup.io.writeJsonAtomic;
  setup.io.writeJsonAtomic = (file, value) => {
    if (value?.record?.status === 'paused') throw new Error('injected checkpoint transition failure');
    return original(file, value);
  };
  assert.equal((await setup.scheduler.tryDispatch(setup.work.work_id).completion).status, 'needs_attention');
  assert.equal(setup.lanes.snapshot().active_leases, 1);
});

test('store rejects a reference from another attempt and restart cannot replay unchecked running work', t => {
  const setup = fixture(t);
  const attempt = { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
    authority_revision: 'authority_1' };
  const running = setup.store.transition(setup.work.work_id, { expectedRevision: 1,
    to: 'running', reason: 'admitted', attempt }).record;
  assert.throws(() => setup.store.transition(running.work_id, { expectedRevision: running.revision,
    expectedAttempt: attempt, to: 'paused', reason: 'checkpoint',
    checkpointRef: reference({ ...attempt, authority_revision: 'other_authority' }) }), /checkpoint_fence_conflict/);
  const recovered = new RuntimeStore(setup.root);
  setup.scheduler.store = recovered;
  const paused = recovered.get(running.work_id);
  assert.equal(paused.status, 'paused');
  assert.equal(setup.scheduler.resume(paused.work_id, paused.revision).reason, 'runtime_checkpoint_required');
  assert.equal(setup.claims(), 0);
});

test('restart after resume cannot replay the previous attempt checkpoint', async t => {
  const setup = fixture(t);
  await setup.scheduler.tryDispatch(setup.work.work_id).completion;
  const paused = setup.store.get(setup.work.work_id);
  const pending = setup.store.transition(paused.work_id, { expectedRevision: paused.revision,
    to: 'pending', reason: 'explicit_resume' }).record;
  const attempt = { ...paused.attempt, attempt_id: 'attempt_B', stream_id: 'stream_B' };
  setup.store.transition(pending.work_id, { expectedRevision: pending.revision, to: 'running',
    reason: 'resumed_attempt', attempt });
  setup.scheduler.store = new RuntimeStore(setup.root);
  const interrupted = setup.scheduler.store.get(paused.work_id);
  assert.equal(interrupted.checkpoint_ref.source_attempt.attempt_id, paused.attempt.attempt_id);
  assert.equal(interrupted.attempt.attempt_id, 'attempt_B');
  assert.equal(setup.scheduler.resume(interrupted.work_id, interrupted.revision).reason, 'runtime_checkpoint_required');
  assert.equal(setup.claims(), 1);
});

test('queued resume revalidates checkpoint existence before allocating another actor', async t => {
  const setup = fixture(t);
  await setup.scheduler.tryDispatch(setup.work.work_id).completion;
  const paused = setup.store.get(setup.work.work_id);
  const route = setup.scheduler.resolveRoute(paused);
  const held = setup.lanes.tryAcquireTurn({ sessionId: 'other_session', route });
  let checkpointValidations = 0;
  setup.scheduler.validateCheckpoint = () => { checkpointValidations += 1; return false; };
  assert.equal(setup.scheduler.resume(paused.work_id, paused.revision).status, 'accepted');
  assert.equal(setup.store.get(paused.work_id).status, 'pending');
  assert.equal(checkpointValidations, 0);
  assert.equal(setup.claims(), 1);
  setup.lanes.release(held.lease, { producerSettled: true });
  setup.scheduler.pump();
  assert.equal(checkpointValidations, 1);
  assert.equal(setup.store.get(paused.work_id).status, 'paused');
  assert.equal(setup.claims(), 1);
});

test('idempotent pause retries reject changed and malformed checkpoint content', async t => {
  const setup = fixture(t);
  await setup.scheduler.tryDispatch(setup.work.work_id).completion;
  const paused = setup.store.get(setup.work.work_id);
  const repeat = { expectedRevision: paused.revision - 1, to: 'paused',
    reason: paused.transition.reason, transitionId: paused.transition.transition_id,
    expectedAttempt: paused.attempt, checkpointRef: paused.checkpoint_ref };
  assert.equal(setup.store.transition(paused.work_id, repeat).changed, false);
  for (const checkpointRef of [{ ...paused.checkpoint_ref, checkpoint_id: 'checkpoint_other' },
    { ...paused.checkpoint_ref, bytes: true }, null]) {
    assert.throws(() => setup.store.transition(paused.work_id, { ...repeat, checkpointRef }), /transition_id_conflict/);
  }
});
