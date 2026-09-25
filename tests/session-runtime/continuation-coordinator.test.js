'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuntimeContinuationCoordinator } = require('../../services/backend/runtime-continuation-coordinator');
const { CheckpointStore } = require('../../services/session-runtime/checkpoint-store');
const { createRuntimeStoreIO } = require('../../services/session-runtime/store');
const { captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { buildAdmittedContinuationContext } = require('../../services/session-runtime/continuation-context');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-continuation-transaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const route = captureRuntimeRoute({ engine_type: 'chatgpt', provider_id: 'chatgpt',
    configuration_revision: 'config:1', resource_class: 'cloud', requires_gpu: false });
  const authority = { project_id: 'project_1', root_path: null, root_id: null,
    root_revision: 0, device_id: null, inode: null };
  const attempt = { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
    authority_revision: 'authority_1' };
  const work = { work_id: 'work_1', turn_id: 'turn_1', session_id: 'session_1', project_id: 'project_1',
    status: 'running', revision: 3, submission_hash: 'e'.repeat(64), authority, attempt, input: { route } };
  const context = buildAdmittedContinuationContext({ work, route, attempt,
    executionContext: { ...authority, authority_revision: 'authority_1' } });
  const ref = ref_id => ({ ref_id, revision: 1, sha256: 'a'.repeat(64) });
  const candidate = { canonicalRefs: { request_ref: ref('work_1'), message_ref: ref('message_1'),
    turn_ref: { ...ref('turn_1'), stream_id: 'stream_1', through_seq: 3 }, tool_batch_ref: ref('batch_1'),
    history_ref: ref('history_1') },
  frozenInputRef: ref('input_1'), encodedArtifactBytes: 512 };
  const state = { current: true, published: false, durable: true, work, events: [] };
  const validateCanonical = () => ({ valid: state.published && state.durable, bytes: 512 });
  const io = { ...createRuntimeStoreIO() };
  const store = new CheckpointStore(root, { io, validateCanonical });
  const conversationStore = {
    preparePendingContinuation(sessionId, proposal, suppliedWork) {
      state.events.push('prepare');
      assert.equal(sessionId, work.session_id);
      assert.equal(proposal.checkpoint_id, 'checkpoint_1');
      assert.deepEqual(suppliedWork, work);
      return candidate;
    },
    publishPendingContinuation(value, options) {
      state.events.push('publish');
      assert.equal(value, candidate);
      assert.deepEqual(options, { durable: true });
      assert.equal(store.snapshot().preparing_count, 1);
      assert.ok(store.snapshot().body_bytes > candidate.encodedArtifactBytes);
      state.published = true;
      return { ok: state.durable, applied: true, durable: state.durable, reason: null,
        commitEpoch: 4, dirtyEpoch: 4, durableEpoch: state.durable ? 4 : 3, value: null };
    },
  };
  const coordinator = new RuntimeContinuationCoordinator({ conversationStore, checkpointStore: store,
    context, getCurrentWork: () => state.work, assertCurrent: () => state.current });
  const input = { proposal: { checkpoint_id: 'checkpoint_1', source_attempt: attempt, stream_id: 'stream_1',
    tool_calls: [{ call_id: 'call_1', tool_id: 'view_file' }],
    frozen_input: { effective_args_fingerprint: 'd'.repeat(64) } },
  position: { completed_iterations: 1, remaining_iterations: 7, current_iteration: 1,
    tool_call_limit: 20, tool_calls_consumed: 1, active_budget_ms_remaining: 5000, ordered_call_ids: ['call_1'] },
  wait: { kind: 'resource', resource_class: 'tool_operations', dependency_id: null, operation_id: 'call_1' },
  eligibility: { pending_call_index: 0, prior_outcome_count: 0, emitted_tool_execution_count: 0,
    preview_count: 0, approval_pending: false, mutation_started: false } };
  return { root, store, io, coordinator, conversationStore, state, input, candidate, validateCanonical };
}

test('publication reserves capacity first and returns only a committed reference after canonical durability', t => {
  const f = fixture(t);
  const ref = f.coordinator.publish(f.input);
  assert.deepEqual(f.state.events, ['prepare', 'publish']);
  assert.equal(f.store.snapshot().preparing_count, 0);
  assert.equal(f.store.validate(f.state.work, ref), true);
  assert.equal(Object.hasOwn(ref, 'producerSettled'), false);
  const restarted = new CheckpointStore(f.root, { validateCanonical: f.validateCanonical });
  assert.equal(restarted.validate(f.state.work, ref), true);
});

test('capacity and invalid continuation refusal cannot write canonical material', t => {
  const f = fixture(t);
  f.candidate.encodedArtifactBytes = 1024 * 1024;
  assert.throws(() => f.coordinator.publish(f.input), /checkpoint_material_capacity/);
  assert.equal(f.state.published, false);
  assert.equal(f.store.snapshot().record_count, 0);
  f.candidate.encodedArtifactBytes = 512;
  f.input.position.ordered_call_ids = ['swapped_call'];
  assert.throws(() => f.coordinator.publish(f.input), /runtime_continuation_batch_conflict/);
  assert.equal(f.state.published, false);
});

test('failed canonical durability retains preparing evidence and charge across restart', t => {
  const f = fixture(t);
  f.state.durable = false;
  assert.throws(() => f.coordinator.publish(f.input), /canonical_not_durable/);
  const before = f.store.snapshot();
  assert.equal(before.preparing_count, 1);
  const restarted = new CheckpointStore(f.root, { validateCanonical: f.validateCanonical });
  assert.equal(restarted.snapshot().body_bytes, before.body_bytes);
  const ref = [...restarted.records.values()][0].reference;
  assert.equal(restarted.validate(f.state.work, ref), false);
});

test('lost attempt after canonical publication cannot commit or release the retained checkpoint', t => {
  const f = fixture(t);
  const publish = f.conversationStore.publishPendingContinuation;
  f.conversationStore.publishPendingContinuation = (...args) => {
    const result = publish(...args);
    f.state.current = false;
    return result;
  };
  assert.throws(() => f.coordinator.publish(f.input), /attempt_unavailable/);
  assert.equal(f.state.published, true);
  assert.equal(f.store.snapshot().preparing_count, 1);
});

test('failure after committed replacement never fabricates a successful callback', t => {
  const f = fixture(t);
  const write = f.io.writeJsonAtomic;
  f.io.writeJsonAtomic = (file, value) => {
    write(file, value);
    if (value.state === 'committed') throw new Error('injected_after_commit');
  };
  assert.throws(() => f.coordinator.publish(f.input), /injected_after_commit/);
  assert.equal(f.store.snapshot().read_only, true);
  const restarted = new CheckpointStore(f.root, { validateCanonical: f.validateCanonical });
  const ref = [...restarted.records.values()][0].reference;
  assert.equal(restarted.validate(f.state.work, ref), true);
  assert.equal(f.state.work.status, 'running');
});

test('captured provider, project, attempt and work revision are reasserted between persistence owners', t => {
  for (const mutate of [
    f => { f.state.work.input.route = { ...f.state.work.input.route, configuration_revision: 'new' }; },
    f => { f.state.work.authority.root_revision += 1; },
    f => { f.state.work.attempt.attempt_id = 'another_attempt'; },
    f => { f.state.work.status = 'cancelled'; },
  ]) {
    const f = fixture(t);
    mutate(f);
    assert.throws(() => f.coordinator.publish(f.input), /work_fence_conflict/);
    assert.equal(f.state.events.length, 0);
  }
  const f = fixture(t);
  const prepare = f.conversationStore.preparePendingContinuation;
  f.conversationStore.preparePendingContinuation = (...args) => {
    const result = prepare(...args);
    f.state.work.revision += 1;
    return result;
  };
  assert.throws(() => f.coordinator.publish(f.input), /work_fence_conflict/);
  assert.equal(f.state.published, false);
  assert.equal(f.store.snapshot().record_count, 0);
});


test('dependency checkpoint requires independent durable proof and preserves completed spawn references', t => {
  const f = fixture(t);
  const input = structuredClone(f.input);
  input.proposal.tool_calls[0].tool_id = 'session_wait';
  input.position.current_iteration = 2;
  input.position.completed_iterations = 2;
  input.position.tool_calls_consumed = 2;
  input.eligibility.prior_outcome_count = 1;
  input.eligibility.emitted_tool_execution_count = 1;
  input.wait = { kind: 'dependency', operation_id: 'call_1', resource_class: null, dependency_id: 'child_1' };
  input.completedSpawnRefs = [{ call_id: 'spawn_1', child_work_id: 'child_1', result_sha256: 'f'.repeat(64) }];
  assert.throws(() => f.coordinator.publish(input), /runtime_continuation_dependency_unproven/);
  assert.equal(f.state.published, false);
  f.coordinator.validateDependency = value => {
    assert.deepEqual(value.completedSpawnRefs, input.completedSpawnRefs);
    assert.equal(value.wait.dependency_id, 'child_1');
    return true;
  };
  const reference = f.coordinator.publish(input);
  assert.deepEqual(f.store.read(reference, f.state.work).completed_spawn_refs, input.completedSpawnRefs);
  assert.equal(f.store.read(reference, f.state.work).kind, 'before_dependency_wait');
});


test('decision rechecks preserve the captured input bundle at every publication boundary', t => {
  const f = fixture(t);
  const decision = { kind: 'approval', call_id: 'call_1', decision_id: 'decision_1', execution_started: false };
  f.input.proposal.decision = decision;
  f.input.proposal.approval_inputs_bytes = 'captured_bundle';
  f.candidate.approvalInputsRef = { ref_id: 'approval_inputs_1', revision: 1, sha256: 'b'.repeat(64) };
  f.input.decisionProgress = { decision, completed_effect_refs: [], prior_effect_count: 0, prior_checkpoint_ref: null };
  f.input.wait = { ...f.input.wait, kind: 'explicit_pause', resource_class: null };
  let rechecks = 0;
  f.coordinator.validateDecision = value => {
    rechecks++;
    assert.deepEqual(value.frozen_input, f.input.proposal.frozen_input);
    assert.equal(value.approval_inputs_bytes, 'captured_bundle');
    return { valid: true };
  };
  const reference = f.coordinator.publish(f.input);
  assert.equal(rechecks, 5);
  const checkpoint = f.store.read(reference, f.state.work);
  assert.equal(checkpoint.schema_version, 4);
  assert.deepEqual(checkpoint.approval_inputs_ref, f.candidate.approvalInputsRef);
});
