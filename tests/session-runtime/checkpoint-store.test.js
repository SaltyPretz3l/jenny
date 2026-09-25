'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CheckpointStore, MAX_TOTAL_BYTES, MAX_RECORDS, readPortableCheckpointSnapshot } = require('../../services/session-runtime/checkpoint-store');
const { createRuntimeStoreIO } = require('../../services/session-runtime/store');
const { stableJson } = require('../../services/session-runtime/contracts');
const { encodeContinuation } = require('../../services/session-runtime/continuation-contracts');

const CANONICAL_BYTES = 128;
const canonicalEvidence = () => ({ valid: true, bytes: CANONICAL_BYTES });
const digest = value => createHash('sha256').update(stableJson(value)).digest('hex');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-checkpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ref = name => ({ ref_id: name, revision: 1, sha256: 'a'.repeat(64) });
  const attempt = { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
    authority_revision: 'authority_1' };
  const continuation = {
    schema_version: 1, kind: 'before_tool_dispatch',
    identity: { checkpoint_id: 'checkpoint_1', work_id: 'work_1', turn_id: 'turn_1',
      request_id: 'stream_1', trace_id: null, session_id: 'session_1' },
    source_attempt: attempt,
    authority: { project_id: 'project_1', root_id: 'root_1', root_revision: 1, sha256: 'b'.repeat(64) },
    route: { route_id: 'route_1', route_revision: 'config:1', sha256: 'c'.repeat(64) },
    canonical_refs: { request_ref: ref('request_1'), message_ref: ref('message_1'),
      turn_ref: { ...ref('turn_1'), stream_id: 'stream_1', through_seq: 3 }, tool_batch_ref: ref('batch_1'),
      history_ref: ref('history_1') },
    position: { completed_iterations: 1, remaining_iterations: 7, current_iteration: 1,
      tool_call_limit: 20, tool_calls_consumed: 1, active_budget_ms_remaining: 5000,
      ordered_call_ids: ['call_1'] },
    pending_call: { call_id: 'call_1', tool_id: 'view_file', effective_args_sha256: 'd'.repeat(64),
      frozen_input_ref: ref('input_1') },
    wait: { kind: 'resource', resource_class: 'tool_operations', dependency_id: null, operation_id: 'call_1' },
    eligibility: { pending_call_index: 0, prior_outcome_count: 0, emitted_tool_execution_count: 0,
      preview_count: 0, approval_pending: false, mutation_started: false },
  };
  const work = { work_id: 'work_1', turn_id: 'turn_1', session_id: 'session_1', project_id: 'project_1',
    authority: { root_id: 'root_1', root_revision: 1 }, attempt };
  const io = { ...createRuntimeStoreIO() };
  const store = new CheckpointStore(root, { io, validateCanonical: canonicalEvidence, ...options });
  return { root, store, io, work, continuation, body: encodeContinuation(continuation).body };
}

test('immutable checkpoint publication is idempotent and restart reconstructs bounded metadata', t => {
  const f = fixture(t);
  const reference = f.store.put(f.body, f.work);
  assert.deepEqual(f.store.put(f.body, f.work), reference);
  assert.equal(f.store.snapshot().record_count, 1);
  assert.equal(f.store.snapshot().body_bytes, f.body.length + CANONICAL_BYTES);
  const restarted = new CheckpointStore(f.root, { validateCanonical: canonicalEvidence });
  assert.deepEqual(restarted.read(reference, f.work), f.continuation);
  const read = restarted.read(reference, f.work);
  read.identity.turn_id = 'corrupted_local_copy';
  assert.equal(restarted.read(reference, f.work).identity.turn_id, 'turn_1');
  const changed = structuredClone(f.continuation);
  changed.position.active_budget_ms_remaining -= 1;
  assert.throws(() => f.store.put(encodeContinuation(changed).body, f.work), /checkpoint_id_conflict/);
});

test('restart sweeps stale atomic-write temp files without blocking checkpoint use', t => {
  const f = fixture(t);
  const reference = f.store.put(f.body, f.work);
  const temp = path.join(f.store._directory(reference.checkpoint_id),
    '.runtime-deadbeefdeadbeefdeadbeef.tmp');
  fs.writeFileSync(temp, 'stale');

  const reopened = new CheckpointStore(f.root, { validateCanonical: canonicalEvidence });
  assert.equal(reopened.snapshot().read_only, false);
  assert.deepEqual(reopened.read(reference, f.work), f.continuation);
  assert.equal(fs.existsSync(temp), false);
  const next = structuredClone(f.continuation);
  next.identity.checkpoint_id = 'checkpoint_2';
  assert.deepEqual(reopened.read(reopened.put(encodeContinuation(next).body, f.work), f.work), next);
});

test('restart discards an unpublished checkpoint directory left by a crash before its first write', t => {
  const f = fixture(t);
  const reference = f.store.put(f.body, f.work);
  const published = f.store.snapshot();
  const orphans = ['checkpoint_orphan_a', 'checkpoint_orphan_b']
    .map(id => path.join(f.root, createHash('sha256').update(id).digest('hex')));
  for (const orphan of orphans) fs.mkdirSync(orphan, { mode: 0o700 });
  fs.writeFileSync(path.join(orphans[1], '.runtime-deadbeefdeadbeefdeadbeef.tmp'), 'stale');
  assert.deepEqual(readPortableCheckpointSnapshot(f.root).records.map(record => record.checkpoint_id),
    [f.continuation.identity.checkpoint_id]);
  for (const orphan of orphans) assert.equal(fs.existsSync(orphan), true);

  const reopened = new CheckpointStore(f.root, { validateCanonical: canonicalEvidence });
  assert.equal(reopened.snapshot().read_only, false);
  for (const orphan of orphans) assert.equal(fs.existsSync(orphan), false);
  assert.deepEqual(reopened.read(reference, f.work), f.continuation);
  assert.equal(reopened.snapshot().record_count, published.record_count);
  assert.equal(reopened.snapshot().body_bytes, published.body_bytes);
  const next = structuredClone(f.continuation);
  next.identity.checkpoint_id = 'checkpoint_2';
  assert.deepEqual(reopened.read(reopened.put(encodeContinuation(next).body, f.work), f.work), next);

  const invalid = path.join(f.root, createHash('sha256').update('checkpoint_orphan_c').digest('hex'));
  fs.mkdirSync(invalid, { mode: 0o700 });
  fs.writeFileSync(path.join(invalid, 'record.json'), '{"schema_version":1}');
  const blocked = new CheckpointStore(f.root, { validateCanonical: canonicalEvidence }).snapshot();
  assert.equal(blocked.read_only, true);
  assert.equal(blocked.reason, 'checkpoint_document_invalid');
  fs.rmSync(invalid, { recursive: true, force: true });

  fs.writeFileSync(path.join(f.root, createHash('sha256').update('checkpoint_orphan_d').digest('hex')), '');
  assert.equal(new CheckpointStore(f.root, { validateCanonical: canonicalEvidence }).snapshot().reason,
    'checkpoint_entry_unresolved');
  assert.throws(() => readPortableCheckpointSnapshot(f.root), /checkpoint_entry_unresolved/);
});

test('publication and every use require canonical references plus exact work and attempt authority', t => {
  let canonical = false;
  const f = fixture(t, { validateCanonical: () => canonical ? canonicalEvidence() : null });
  assert.throws(() => f.store.put(f.body, f.work), /checkpoint_canonical_unavailable/);
  assert.equal(fs.readdirSync(f.root).length, 0);
  canonical = true;
  const ref = f.store.put(f.body, f.work);
  for (const field of ['work_id', 'session_id', 'turn_id', 'project_id']) {
    assert.equal(f.store.validate({ ...f.work, [field]: 'other' }, ref), false, field);
  }
  assert.equal(f.store.validate({ ...f.work, attempt: { ...f.work.attempt, attempt_id: 'attempt_2' } }, ref), false);
  assert.equal(f.store.validate({ ...f.work, authority: { ...f.work.authority, root_revision: 2 } }, ref), false);
  canonical = false;
  assert.equal(f.store.validate(f.work, ref), false);
});

test('tampered, missing, linked and future checkpoint state is preserved and cannot authorize resume', t => {
  const f = fixture(t);
  const ref = f.store.put(f.body, f.work);
  const file = f.store._file('checkpoint_1');
  const saved = fs.readFileSync(file);
  const different = structuredClone(f.continuation);
  different.position.active_budget_ms_remaining -= 1;
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(saved),
    body: encodeContinuation(different).body.toString('base64') }));
  assert.equal(f.store.validate(f.work, ref), false);
  fs.writeFileSync(file, saved);
  const alias = path.join(f.root, 'alias.json');
  fs.linkSync(file, alias);
  assert.equal(f.store.validate(f.work, ref), false);
  fs.unlinkSync(alias);
  fs.writeFileSync(file, JSON.stringify({ schema_version: 2, future_data: 'keep' }));
  const future = new CheckpointStore(f.root, { validateCanonical: canonicalEvidence });
  assert.equal(future.snapshot().read_only, true);
  assert.equal(future.snapshot().reason, 'checkpoint_future_schema');
  assert.throws(() => future.put(f.body, f.work), /checkpoint_future_schema/);
  assert.equal(JSON.parse(fs.readFileSync(file)).future_data, 'keep');
  fs.unlinkSync(file);
  assert.equal(f.store.validate(f.work, ref), false);
});

test('capacity refusal never deletes existing recovery evidence', t => {
  const f = fixture(t);
  f.store.totalBytes = MAX_TOTAL_BYTES - f.body.length + 1;
  assert.throws(() => f.store.put(f.body, f.work), /checkpoint_body_capacity/);
  f.store.totalBytes = 0;
  for (let i = 0; i < MAX_RECORDS; i += 1) f.store.records.set(`occupied_${i}`, {});
  assert.throws(() => f.store.put(f.body, f.work), /checkpoint_record_capacity/);
  assert.equal(fs.readdirSync(f.root).length, 0);
});

test('uncertain publication remains charged after restart without automatic replay', t => {
  const f = fixture(t);
  const write = f.io.writeJsonAtomic;
  f.io.writeJsonAtomic = (file, value) => { write(file, value); throw new Error('injected_after_rename'); };
  assert.throws(() => f.store.put(f.body, f.work), /injected_after_rename/);
  assert.equal(f.store.snapshot().read_only, true);
  const restarted = new CheckpointStore(f.root, { validateCanonical: canonicalEvidence });
  assert.equal(restarted.snapshot().record_count, 1);
  assert.equal(restarted.snapshot().body_bytes, f.body.length + CANONICAL_BYTES);
  assert.deepEqual(restarted.read(restarted.put(f.body, f.work), f.work), f.continuation);
});

test('case-distinct identities cannot overwrite each other on case-insensitive filesystems', t => {
  const f = fixture(t);
  const first = f.store.put(f.body, f.work);
  const upper = structuredClone(f.continuation);
  upper.identity.checkpoint_id = 'CHECKPOINT_1';
  const second = f.store.put(encodeContinuation(upper).body, f.work);
  assert.notEqual(f.store._file(first.checkpoint_id), f.store._file(second.checkpoint_id));
  assert.deepEqual(f.store.read(first, f.work), f.continuation);
  assert.deepEqual(f.store.read(second, f.work), upper);
  assert.equal(new CheckpointStore(f.root, { validateCanonical: canonicalEvidence }).snapshot().record_count, 2);
});

test('publication refuses an unindexed destination and preserves its future data', t => {
  const f = fixture(t);
  const directory = f.store._directory('checkpoint_1');
  fs.mkdirSync(directory);
  const file = path.join(directory, 'record.json');
  fs.writeFileSync(file, '{"schema_version":2,"preserve":"future"}');
  assert.throws(() => f.store.put(f.body, f.work), { code: 'EEXIST' });
  assert.equal(JSON.parse(fs.readFileSync(file)).preserve, 'future');
});

test('live file symlink replacement cannot authorize reading a checkpoint outside its owner', t => {
  const f = fixture(t);
  const other = fixture(t);
  const ref = f.store.put(f.body, f.work);
  const file = f.store._file('checkpoint_1');
  const target = path.join(other.root, 'outside.json');
  fs.renameSync(file, target);
  try { fs.symlinkSync(target, file, 'file'); } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('File symlink creation is unavailable on this host.');
    throw error;
  }
  assert.equal(f.store.validate(f.work, ref), false);
  assert.equal(fs.existsSync(target), true);
});

test('live checkpoint directory junction replacement cannot authorize external storage', t => {
  const f = fixture(t);
  const other = fixture(t);
  const ref = f.store.put(f.body, f.work);
  const directory = f.store._directory('checkpoint_1');
  const target = path.join(other.root, 'outside');
  fs.renameSync(directory, target);
  fs.symlinkSync(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.store.validate(f.work, ref), false);
});

test('durable preparation charges canonical material before publication and restart never resumes it', t => {
  let canonical = false;
  const f = fixture(t, { validateCanonical: () => canonical ? canonicalEvidence() : null });
  const ref = f.store.begin(f.body, f.work, { canonicalBytes: CANONICAL_BYTES });
  assert.equal(f.store.snapshot().body_bytes, f.body.length + CANONICAL_BYTES);
  assert.equal(f.store.snapshot().preparing_count, 1);
  assert.equal(f.store.validate(f.work, ref), false);
  assert.throws(() => f.store.commit(ref, f.work), /checkpoint_canonical_unavailable/);
  const restarted = new CheckpointStore(f.root, { validateCanonical: canonicalEvidence });
  assert.equal(restarted.snapshot().preparing_count, 1);
  assert.equal(restarted.validate(f.work, ref), false);
  canonical = true;
  assert.deepEqual(f.store.commit(ref, f.work), ref);
  assert.equal(f.store.snapshot().preparing_count, 0);
  assert.equal(f.store.validate(f.work, ref), true);
  assert.equal(new CheckpointStore(f.root, { validateCanonical: canonicalEvidence }).validate(f.work, ref), true);
});

test('restart discovery requires one committed checkpoint with exact work authority and route', t => {
  const f = fixture(t);
  f.work.input = { route: { engine_type: 'mock', provider_id: 'mock',
    configuration_revision: 'config:1', resource_class: 'local', requires_gpu: false } };
  f.continuation.authority.sha256 = digest(f.work.authority);
  f.continuation.route.sha256 = digest(f.work.input.route);
  f.continuation.route.route_id = `route_${f.continuation.route.sha256}`;
  const body = encodeContinuation(f.continuation).body;
  const reference = f.store.begin(body, f.work, { canonicalBytes: CANONICAL_BYTES });
  assert.deepEqual(f.store.findCommittedForWork(f.work), {
    status: 'blocked', reason: 'checkpoint_preparing',
  });
  f.store.commit(reference, f.work);
  f.store.records.set('unrelated_checkpoint', { workId: 'work_other',
    reference: { source_attempt: f.work.attempt }, canonicalBytes: 2, state: 'committed' });
  const read = f.store._read.bind(f.store);
  f.store._read = checkpointId => {
    assert.notEqual(checkpointId, 'unrelated_checkpoint');
    return read(checkpointId);
  };
  const found = f.store.findCommittedForWork(f.work);
  assert.equal(found.status, 'committed');
  assert.deepEqual(found.reference, reference);
  f.store._read = read;
  f.store.records.delete('unrelated_checkpoint');

  const changedWork = structuredClone(f.work);
  changedWork.input.route.configuration_revision = 'config:2';
  assert.deepEqual(f.store.findCommittedForWork(changedWork), {
    status: 'blocked', reason: 'checkpoint_work_fence_conflict',
  });
  const duplicate = structuredClone(f.continuation);
  duplicate.identity.checkpoint_id = 'checkpoint_2';
  f.store.put(encodeContinuation(duplicate).body, f.work);
  assert.deepEqual(f.store.findCommittedForWork(f.work), {
    status: 'blocked', reason: 'checkpoint_attempt_ambiguous',
  });
});

test('material footprint cannot evade per-checkpoint or aggregate limits and cannot change at commit', t => {
  const f = fixture(t, { validateCanonical: () => ({ valid: true, bytes: CANONICAL_BYTES + 1 }) });
  assert.throws(() => f.store.begin(f.body, f.work, { canonicalBytes: 1024 * 1024 }), /checkpoint_material_capacity/);
  const ref = f.store.begin(f.body, f.work, { canonicalBytes: CANONICAL_BYTES });
  assert.throws(() => f.store.commit(ref, f.work), /checkpoint_canonical_footprint_changed/);
  assert.equal(f.store.snapshot().preparing_count, 1);
});

test('commit interrupted after its atomic write requires restart recovery before reuse', t => {
  const f = fixture(t);
  const ref = f.store.begin(f.body, f.work, { canonicalBytes: CANONICAL_BYTES });
  const write = f.io.writeJsonAtomic;
  f.io.writeJsonAtomic = (file, value) => { write(file, value); throw new Error('commit_ack_lost'); };
  assert.throws(() => f.store.commit(ref, f.work), /commit_ack_lost/);
  assert.equal(f.store.validate(f.work, ref), false);
  const restarted = new CheckpointStore(f.root, { validateCanonical: canonicalEvidence });
  assert.equal(restarted.snapshot().body_bytes, f.body.length + CANONICAL_BYTES);
  assert.equal(restarted.validate(f.work, ref), true);
});

test('unregistered material cannot authorize resume without capacity reconstruction', t => {
  const f = fixture(t);
  const observer = new CheckpointStore(f.root, { validateCanonical: canonicalEvidence });
  const ref = f.store.put(f.body, f.work);
  assert.equal(observer.validate(f.work, ref), false);
  assert.throws(() => observer.commit(ref, f.work), /checkpoint_unregistered/);
});
