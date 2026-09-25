'use strict';

const { createHash } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stableJson } = require('../../services/session-runtime/contracts');
const { captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { buildAdmittedContinuationContext } = require('../../services/session-runtime/continuation-context');
const { createManagedContinuationBoundary } = require('../../services/backend/runtime-continuation-managed');

function fixture({ separateSettlementFence = false, waitResources = null, decisionWait = false, onPublicationFailure = null } = {}) {
  const route = captureRuntimeRoute({ engine_type: 'chatgpt', provider_id: 'chatgpt',
    configuration_revision: 'config:1', resource_class: 'cloud', requires_gpu: false });
  const authority = { project_id: 'general', root_path: null, root_id: null,
    root_revision: 0, device_id: null, inode: null };
  const attempt = { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
    authority_revision: 'authority_1' };
  const work = { work_id: 'work_1', turn_id: 'turn_1', session_id: 'session_1', project_id: 'general',
    authority, attempt, input: { route }, status: 'running', revision: 3, submission_hash: 'd'.repeat(64) };
  const context = buildAdmittedContinuationContext({ work, route, attempt,
    executionContext: { ...authority, authority_revision: 'authority_1' } });
  const ref = ref_id => ({ ref_id, revision: 1, sha256: 'a'.repeat(64) });
  const canonicalRefs = { request_ref: ref('work_1'), message_ref: ref('message_1'), history_ref: ref('history_1'),
    turn_ref: { ...ref('turn_1'), stream_id: 'stream_1', through_seq: 0 }, tool_batch_ref: ref('batch_1') };
  const commit = { ok: true, applied: true, durable: true, reason: null,
    commitEpoch: 3, dirtyEpoch: 3, durableEpoch: 3, value: null };
  const state = { current: true, protocol: true, checkpointValid: true, clearDurable: true,
    active: 0, reserved: 0, quarantined: 0, events: [], releaseBlocked: false,
    settlementCurrent: true, canonicalWrites: 0 };
  const collector = { sessionId: 'session_1', turnId: 'turn_1', attemptId: 'stream_1',
    canonicalPrimary: true, capturedEvents: [], flushJournalEvents() {},
    journal: { flush: () => true, clear(sessionId, turnId, options) {
      assert.deepEqual(options.commitResult, commit);
      state.events.push('journal_clear');
      return { ok: state.clearDurable, durable: state.clearDurable };
    } } };
  const lease = { identity: { sessionId: 'session_1', turnId: 'turn_1', streamId: 'stream_1' }, released: false };
  const actorRegistry = { pauseForCheckpoint(target, options) {
    assert.equal(target, lease);
    if (state.releaseBlocked) return { released: false };
    if (options.settleJournal() !== true) return { released: false };
    state.events.push('actor_release');
    target.released = true;
    return { released: true };
  } };
  const checkpointStore = { begin(body) {
    const document = JSON.parse(body.toString('utf8'));
    return { schema_version: 1, checkpoint_id: document.identity.checkpoint_id,
      sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length, source_attempt: attempt };
  }, commit: reference => reference, validate: () => state.checkpointValid };
  const controller = new AbortController();
  const boundary = createManagedContinuationBoundary({ context, signal: decisionWait ? controller.signal : null, checkpointStore, collector, onPublicationFailure,
    conversationStore: { appendTurnEvents: () => { state.canonicalWrites += 1; return commit; },
      preparePendingContinuation: () => ({ canonicalRefs, frozenInputRef: ref('input_1'), encodedArtifactBytes: 512 }),
      publishPendingContinuation: () => commit }, getCurrentWork: () => work,
    assertCurrent: () => state.current, assertProtocol: () => state.protocol,
    ...(separateSettlementFence ? { assertSettlementCurrent: () => state.settlementCurrent } : {}),
    gateway: { snapshot: () => state,
      tools: { validateResourceWait: () => ({ resource_class: 'tool_operations', dependency_id: null }),
        getWaitResources: id => { assert.equal(id, 'call_1'); return waitResources; } } },
    historySelector: { schema_version: 1, history_scope: 'session', compaction_ref: null,
      canonical_cutoff: { boundary_message_id: null, boundary_message_count: 0, sha256: 'a'.repeat(64) } } });
  const params = { api_version: '2026-08-17', schema_version: 1, kind: 'continuation', phase: 'checkpoint',
    request_id: 'stream_1', session_id: 'session_1', authority_revision: 'authority_1', operation_id: 'call_1',
    continuation_context: context, tool_calls: [{ call_id: 'call_1', tool_id: 'read_file' }],
    tool_batch_bytes: 'e30=', tool_batch_sha256: 'a'.repeat(64), frozen_input_bytes: 'e30=',
    frozen_input_sha256: 'a'.repeat(64), frozen_input: { call_id: 'call_1', tool_name: 'read_file',
      visible_tool_arguments: {}, effective_args_fingerprint: 'a'.repeat(64) },
    position: { completed_iterations: 1, remaining_iterations: 7, current_iteration: 1,
      tool_call_limit: 20, tool_calls_consumed: 1, active_budget_ms_remaining: 5000, ordered_call_ids: ['call_1'] },
    eligibility: { pending_call_index: 0, prior_outcome_count: 0, emitted_tool_execution_count: 0,
      preview_count: 0, approval_pending: false, mutation_started: false } };
  const releaseArgs = { actorRegistry, lease, pendingToolApprovals: new Map(), pendingUserQuestions: new Map() };
  async function publish() {
    const response = await boundary.handleOperation(params);
    assert.equal(response.status, 'checkpointed');
    return { request_id: 'stream_1', status: 'paused', checkpoint_ref: response.checkpoint_ref };
  }
  return { state, collector, boundary, lease, params, releaseArgs, publish, work, controller };
}

test('managed boundary forwards publication diagnostics without releasing the actor', async () => {
  const diagnostics = [];
  const f = fixture({ onPublicationFailure: detail => diagnostics.push(detail) });
  f.collector.capturedEvents.push({ kind: 'unsupported', turn_id: 'turn_1' });
  assert.equal((await f.boundary.handleOperation(f.params)).reason, 'runtime_continuation_publication_failed');
  assert.deepEqual(diagnostics, [{ stage: 'canonical_prefix', error_code: 'runtime_continuation_prefix_ineligible' }]);
  assert.equal(f.lease.released, false);
});

test('publication retains actor ownership until matched worker cleanup and all owners prove settlement', async () => {
  const f = fixture();
  const reply = await f.publish();
  assert.equal(f.lease.released, false);
  assert.deepEqual(f.state.events, []);
  const settled = f.boundary.settlePause(reply, f.releaseArgs);
  assert.equal(settled.checkpointSettled, true);
  assert.equal(settled.producerSettled, true);
  assert.equal(settled.canonicalSettled, true);
  assert.deepEqual(f.state.events, ['journal_clear', 'actor_release']);
  assert.equal(f.boundary.settlePause(reply, f.releaseArgs), settled);
  assert.equal(f.state.events.length, 2);
});

test('only the private proved pause carries broker-owned eligibility descriptors', async () => {
  const waitResources = Object.freeze([Object.freeze({ type: 'capacity', key: 'tool_operations', units: 1 })]);
  const f = fixture({ waitResources });
  const reply = await f.publish();
  assert.equal(Object.hasOwn(reply, 'waitResources'), false);
  const settled = f.boundary.settlePause(reply, f.releaseArgs);
  assert.equal(settled.waitResources, waitResources);
  assert.equal(settled.checkpointSettled, true);
});

test('forged, stale, unnegotiated or physically unsettled pause cannot clear evidence or release actor', async () => {
  for (const mutate of [
    (f, reply) => { reply.request_id = 'old_stream'; },
    (f, reply) => { reply.checkpoint_ref.sha256 = 'b'.repeat(64); },
    (f, reply) => { reply.extra = true; },
    f => { f.state.protocol = false; },
    f => { f.state.current = false; },
    f => { f.state.active = 1; },
    f => { f.state.reserved = 1; },
    f => { f.state.quarantined = 1; },
    f => { f.state.checkpointValid = false; },
    f => { f.collector.capturedEvents.push({ kind: 'tool_executing' }); },
    f => { f.releaseArgs.pendingToolApprovals.set('approval', { streamId: 'stream_1' }); },
    f => { f.lease.consumedContinuation = {}; },
  ]) {
    const f = fixture();
    const reply = structuredClone(await f.publish());
    mutate(f, reply);
    assert.throws(() => f.boundary.settlePause(reply, f.releaseArgs));
    assert.equal(f.lease.released, false);
    assert.deepEqual(f.state.events, []);
  }
});

test('failed journal or canonical release does not claim a completed pause', async () => {
  const f = fixture();
  const reply = await f.publish();
  f.state.clearDurable = false;
  assert.throws(() => f.boundary.settlePause(reply, f.releaseArgs), /canonical_pause_unconfirmed/);
  assert.deepEqual(f.state.events, ['journal_clear']);
  assert.equal(f.lease.released, false);
  f.state.clearDurable = true;
  f.state.releaseBlocked = true;
  assert.throws(() => f.boundary.settlePause(reply, f.releaseArgs), /canonical_pause_unconfirmed/);
  assert.equal(f.lease.released, false);
});

test('unsolicited paused response fails closed and ordinary terminal responses remain with their owner', () => {
  const f = fixture();
  assert.throws(() => f.boundary.settlePause({ status: 'paused', request_id: 'stream_1' }, f.releaseArgs));
  assert.equal(f.boundary.settlePause({ status: 'completed' }, f.releaseArgs), null);
  assert.deepEqual(f.state.events, []);
});

test('revoked admission can settle an already-published checkpoint only through its exact settlement fence', async () => {
  const f = fixture({ separateSettlementFence: true });
  const reply = await f.publish();
  f.state.current = false;
  f.state.settlementCurrent = false;
  assert.throws(() => f.boundary.settlePause(reply, f.releaseArgs), /pause_fence_conflict/);
  assert.equal(f.lease.released, false);
  assert.deepEqual(f.state.events, []);
  f.state.settlementCurrent = true;
  const settled = f.boundary.settlePause(reply, f.releaseArgs);
  assert.equal(settled.canonicalSettled, true);
  assert.equal(f.lease.released, true);
  assert.deepEqual(f.state.events, ['journal_clear', 'actor_release']);
});

test('a settlement-only fence cannot authorize a new checkpoint publication', async () => {
  const f = fixture({ separateSettlementFence: true });
  f.state.current = false;
  await assert.rejects(() => f.publish());
  assert.equal(f.state.canonicalWrites, 0);
  assert.equal(f.lease.released, false);
  assert.deepEqual(f.state.events, []);
});


test('decision publication requires invalidated waiter and exact completed outcome proof', async () => {
  const f = fixture({ decisionWait: true });
  const decision = { kind: 'approval', decision_id: 'decision_1', call_id: 'call_1', execution_started: false };
  Object.assign(f.params, { phase: 'decision_checkpoint', decision, prior_checkpoint_ref: null,
    prior_effect_count: 0, completed_effect_refs: [{ call_id: 'done_1', tool_id: 'list_dir', success: false,
      result_sha256: createHash('sha256').update('failed listing').digest('hex') }] });
  f.params.eligibility.prior_outcome_count = 1;
  f.params.tool_calls[0].arguments = { path: 'file.txt' };
  f.collector.capturedEvents.push({ event_id: 'stream_1:canonical:1', turn_id: 'turn_1',
    kind: 'tool_result', tool_call_id: 'done_1', payload: { canonical_seq: 1,
      tool_name: 'list_dir', success: false, tool_output_summary: 'failed listing' } },
  { event_id: 'stream_1:approval:requested:call_1', turn_id: 'turn_1', kind: 'approval_requested',
    tool_call_id: 'call_1', payload: { canonical_seq: 2, tool_name: 'read_file', approval_state: 'pending' } },
  { event_id: 'turn_1:tool_use:1:stream_1', turn_id: 'turn_1', kind: 'tool_use', status: 'pending_approval',
    tool_call_id: 'call_1', payload: { approval_id: 'approval_session_1_stream_1_call_1',
      parent_stream_id: 'stream_1', tool_name: 'read_file', input: { path: 'file.txt' } } });
  f.work.control_request = { kind: 'pause' };
  let invalidated = false;
  f.boundary.decisionControl.offer(decision, () => { invalidated = true; return true; });
  assert.equal(f.boundary.decisionControl.requestPause(), true);
  assert.equal(invalidated, true);
  const reply = await f.publish();
  assert.equal(f.lease.released, false);
  assert.equal(f.boundary.settlePause(reply, f.releaseArgs).status, 'paused');
});

test('decision publication rejects a payload without the request-owned suspended waiter', async () => {
  const f = fixture({ decisionWait: true });
  Object.assign(f.params, { phase: 'decision_checkpoint',
    decision: { kind: 'approval', decision_id: 'decision_1', call_id: 'call_1', execution_started: false },
    prior_checkpoint_ref: null, prior_effect_count: 0, completed_effect_refs: [] });
  f.work.control_request = { kind: 'pause' };
  const result = await f.boundary.handleOperation(f.params);
  assert.equal(result.status, 'rejected');
  assert.equal(f.state.canonicalWrites, 0);
  assert.equal(f.lease.released, false);
});


test('pause settlement accepts the standard Python API version and rejects changed or extra wire fields', async () => {
  const f = fixture();
  const reply = await f.publish();
  assert.throws(() => f.boundary.settlePause({ ...reply, api_version: 'future' }, f.releaseArgs), /pause_reply_invalid/);
  assert.throws(() => f.boundary.settlePause({ ...reply, api_version: '2026-08-17', unexpected: true }, f.releaseArgs), /pause_reply_invalid/);
  assert.equal(f.lease.released, false);
  assert.equal(f.boundary.settlePause({ ...reply, api_version: '2026-08-17' }, f.releaseArgs).status, 'paused');
});
