'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { hasDurableProof } = require('../../services/backend/conversation-store-port');
const { exportSession } = require('../../services/backend/session-export-import');
const { migrateStorePayload } = require('../../services/backend/session-store-migrations');
const { RuntimeContinuationCoordinator } = require('../../services/backend/runtime-continuation-coordinator');
const { buildPreparedContinuationPrefix } = require('../../services/backend/chat-stream-reasoning');
const { fingerprintRuntimeHistory } = require('../../services/backend/runtime-continuation-records');
const { CheckpointStore } = require('../../services/session-runtime/checkpoint-store');
const { buildAdmittedContinuationContext } = require('../../services/session-runtime/continuation-context');
const { captureRuntimeRoute } = require('../../services/session-runtime/lanes');

const { stableJson, hash, setup, toolCalls, work, frozenInput, frozenInputBytes, frozenInputSha256, toolBatchBytes, toolBatchSha256, proposal, continuation, attempt, USER_MESSAGE_ID } = require('../helpers/canonical-continuation-fixture');

test('schema 21 initializes the hidden header without replacing existing future data', () => {
  const future = { schema_version: 2, opaque: { keep: true } };
  const migrated = migrateStorePayload({ schema_version: 20, sessions: {
    legacy: { project_id: 'general' }, future: { project_id: 'general', runtime_continuations: future },
  } });
  assert.equal(migrated.schema_version, 22);
  assert.deepEqual(migrated.sessions.legacy.runtime_continuations,
    { schema_version: 1, entries: [] });
  assert.deepEqual(migrated.sessions.future.runtime_continuations, future);
});

test('publishes and reloads a bounded canonical continuation without transcript copies', (t) => {
  const state = setup(t, { includeSafePrefix: false });
  const port = state.store.conversationStore;
  const candidate = port.preparePendingContinuation('session_1', proposal('checkpoint_1', 0), work());
  assert.ok(candidate.encodedArtifactBytes > 0);
  assert.equal(candidate.canonicalRefs.request_ref.sha256, work().submission_hash);

  const published = port.publishPendingContinuation(candidate);
  assert.equal(hasDurableProof(published), true);
  assert.equal(published.value.encodedArtifactBytes, candidate.encodedArtifactBytes);
  const resolved = port.resolvePendingContinuation(continuation(candidate), work(), {
    includePayload: true,
  });
  assert.equal(resolved.valid, true);
  assert.equal(resolved.bytes, candidate.encodedArtifactBytes);
  assert.deepEqual(resolved.toolBatch.calls, toolCalls());
  assert.equal(resolved.toolBatchBytes, toolBatchBytes());
  assert.deepEqual(resolved.frozenFirstInput.effective_tool_arguments,
    frozenInput().effective_tool_arguments);
  assert.equal(resolved.frozenInputBytes, frozenInputBytes());
  assert.deepEqual(resolved.historySelector, proposal('checkpoint_1', 0).history_selector);
  assert.equal(resolved.userMessageId, USER_MESSAGE_ID);
  assert.deepEqual(resolved.canonicalHistoryMessages, []);
  assert.deepEqual(resolved.turnMessages.map(message => message.id), [USER_MESSAGE_ID]);
  assert.deepEqual(resolved.turnEvents, []);
  assert.equal(resolved.compactionSnapshot, null);
  assert.deepEqual(resolved.recoveryFence, { sessionId: 'session_1', turnId: 'turn_1',
    userMessageId: USER_MESSAGE_ID, streamId: 'stream_1',
    sessionIncarnation: state.incarnation, generation: 1 });
  assert.deepEqual(Object.keys(resolved.canonicalRefs).sort(),
    ['history_ref', 'message_ref', 'request_ref', 'tool_batch_ref', 'turn_ref']);
  const exactFrozenJson = Buffer.from(resolved.frozenInputBytes, 'base64').toString('utf8');
  assert.match(exactFrozenJson, /"ratio":1\.0/u);
  assert.match(exactFrozenJson, /\\u03a9/u);
  const exactBatchJson = Buffer.from(resolved.toolBatchBytes, 'base64').toString('utf8');
  assert.match(exactBatchJson, /"ratio":1\.0/u);
  assert.match(exactBatchJson, /\\u03a9/u);
  assert.equal(Object.hasOwn(resolved, 'messages'), false);
  state.store.updateSession('session_1', {
    runtime_continuations: { schema_version: 1, entries: [] },
  });
  assert.equal(state.store.getSession('session_1').runtime_continuations.entries.length, 1);
  assert.equal(Object.hasOwn(JSON.parse(exportSession(state.store, 'session_1')).session,
    'runtime_continuations'), false);

  state.store.flush();
  const reopened = new ElectronSessionStore(state.file);
  assert.deepEqual(reopened.conversationStore.resolvePendingContinuation(
    continuation(candidate), work()), { valid: true, bytes: candidate.encodedArtifactBytes });
});

test('trusted hydration returns the validated event-only assistant prefix', (t) => {
  const state = setup(t);
  const port = state.store.conversationStore;
  const candidate = port.preparePendingContinuation('session_1',
    proposal('checkpoint_events', 2), work());
  assert.equal(hasDurableProof(port.publishPendingContinuation(candidate)), true);

  const resolved = port.resolvePendingContinuation(continuation(candidate), work(), {
    includePayload: true,
  });
  assert.deepEqual(resolved.turnEvents.map(event => event.kind), [
    'reasoning_phase', 'assistant_text_segment',
  ]);
  assert.deepEqual(resolved.turnEvents.map(event => event.event_id), [
    'stream_1:canonical:1', 'stream_1:canonical:2',
  ]);
});

test('trusted hydration returns the validated pre-turn history and selected turn rows only', (t) => {
  const state = setup(t, { includeSafePrefix: false });
  state.store.appendMessage('session_1', { id: 'prior_1', turn_id: 'prior_turn',
    role: 'assistant', kind: 'message', content: 'Earlier context.' });
  const session = state.store.getSession('session_1');
  const prior = session.messages.find(message => message.id === 'prior_1');
  const current = session.messages.find(message => message.id === USER_MESSAGE_ID);
  state.store._updateSessionRecord('session_1', { messages: [prior, current] });
  const normalizedPrior = state.store.getSession('session_1').messages[0];
  const selected = proposal('checkpoint_history', 0);
  selected.history_selector.canonical_cutoff = { boundary_message_id: normalizedPrior.id,
    boundary_message_count: 1, sha256: fingerprintRuntimeHistory([normalizedPrior]) };
  const port = state.store.conversationStore;
  const candidate = port.preparePendingContinuation('session_1', selected, work());
  assert.equal(hasDurableProof(port.publishPendingContinuation(candidate)), true);

  const resolved = port.resolvePendingContinuation(continuation(candidate), work(), { includePayload: true });
  assert.deepEqual(resolved.canonicalHistoryMessages.map(message => message.id), ['prior_1']);
  assert.deepEqual(resolved.turnMessages.map(message => message.id), [USER_MESSAGE_ID]);
  assert.equal(resolved.compactionSnapshot, null);
});

test('publish is CAS guarded while later turn generations do not invalidate a published artifact', (t) => {
  const { store } = setup(t);
  const port = store.conversationStore;
  const stale = port.preparePendingContinuation('session_1', proposal('checkpoint_stale'), work());
  store.renameSession('session_1', 'Changed while preparing');
  const refused = port.publishPendingContinuation(stale);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'runtime_continuation_publish_stale');

  const candidate = port.preparePendingContinuation('session_1', proposal(), work());
  assert.equal(port.publishPendingContinuation(candidate).ok, true);
  store.updateSession('session_1', { turn_generation: 2 });
  assert.equal(port.resolvePendingContinuation(continuation(candidate), work()).valid, true);
});

test('rejects pending-batch execution evidence during prepare and later resolution', (t) => {
  const first = setup(t);
  first.store.appendMessage('session_1', {
    id: 'tool_use_stream_1_call_1', turn_id: 'turn_1', role: 'assistant',
    kind: 'tool_use', content: 'Running read_file', parent_stream_id: 'stream_1',
    tool_call: { call_id: 'call_1', tool_name: 'read_file', input: {}, input_json: '{}',
      status: 'running', approval_state: 'auto', duration_ms: 0, parent_stream_id: 'stream_1' },
  });
  assert.throws(() => first.store.conversationStore.preparePendingContinuation(
    'session_1', proposal(), work()), /runtime_continuation_effect_already_started/);

  const second = setup(t);
  const candidate = second.store.conversationStore.preparePendingContinuation(
    'session_1', proposal(), work());
  assert.equal(second.store.conversationStore.publishPendingContinuation(candidate).ok, true);
  second.store.appendTurnEvents('session_1', [{
    event_id: 'stream_1:canonical:3', turn_id: 'turn_1', kind: 'tool_result',
    status: 'completed', primary_message_id: 'tool_result_stream_1_call_1',
    source_message_ids: ['tool_result_stream_1_call_1'], tool_call_id: 'call_1',
    payload: { canonical_seq: 3, canonical_event_type: 'tool_execution_completed',
      tool_name: 'read_file' },
  }], { durable: true });
  assert.deepEqual(second.store.conversationStore.resolvePendingContinuation(
    continuation(candidate), work()), { valid: false, bytes: 0 });
});

test('session incarnation and canonical content changes invalidate resolution', (t) => {
  const { store } = setup(t);
  const port = store.conversationStore;
  const candidate = port.preparePendingContinuation('session_1', proposal(), work());
  assert.equal(port.publishPendingContinuation(candidate).ok, true);
  store.updateMessage('session_1', USER_MESSAGE_ID, { content: 'Edited request' });
  assert.deepEqual(port.resolvePendingContinuation(continuation(candidate), work()),
    { valid: false, bytes: 0 });
  store.updateSession('session_1', { session_incarnation: 'incarnation_replaced' });
  assert.deepEqual(port.resolvePendingContinuation(continuation(candidate), work()),
    { valid: false, bytes: 0 });
});

test('refuses a continuation when the logical turn contains another attempt event slice', (t) => {
  const { store } = setup(t);
  store.appendTurnEvents('session_1', [{
    event_id: 'stream_previous:canonical:1', turn_id: 'turn_1',
    kind: 'tool_executing', status: 'running', primary_message_id: 'old_tool_row',
    source_message_ids: ['old_tool_row'], tool_call_id: 'old_call',
    payload: { canonical_seq: 1, canonical_event_type: 'tool_execution_started',
      tool_name: 'read_file', tool_input: { path: 'old.txt' } },
  }], { durable: true });
  assert.throws(() => store.conversationStore.preparePendingContinuation(
    'session_1', proposal(), work()), /canonical_turn_attempt_ambiguous/);
});

test('second attempt checkpoint carries the A+B canonical prefix for C hydration', (t) => {
  const { store, incarnation } = setup(t, { includeSafePrefix: false });
  const port = store.conversationStore;
  store.appendMessage('session_1', { id: 'assistant_stream_1', turn_id: 'turn_1',
    role: 'assistant', kind: 'message', content: 'Prefix A.', parent_stream_id: 'stream_1' });
  store.appendTurnEvents('session_1', [{ event_id: 'stream_1:canonical:1', turn_id: 'turn_1',
    kind: 'assistant_text_segment', primary_message_id: 'assistant_stream_1',
    source_message_ids: ['assistant_stream_1'], tool_call_id: '',
    payload: { canonical_seq: 1, canonical_event_type: 'assistant_text_completed',
      canonical_part_id: 'part_a', text: 'Prefix A.' } }], { durable: true });
  const first = port.preparePendingContinuation('session_1', proposal('checkpoint_a', 1), work());
  assert.equal(port.publishPendingContinuation(first).ok, true);

  const attemptB = { ...attempt, attempt_id: 'attempt_2', stream_id: 'stream_2',
    authority_revision: 'authority_revision_2' };
  store.setActiveTurn('session_1', { request_id: 'stream_2', stream_id: 'stream_2',
    turn_id: 'turn_1', session_incarnation: incarnation, generation: 2,
    user_message_id: USER_MESSAGE_ID, started_at: '2026-09-10T12:01:00.000Z',
    last_event_at: '2026-09-10T12:01:01.000Z', status: 'streaming' });
  store.appendMessage('session_1', { id: 'assistant_stream_2', turn_id: 'turn_1',
    role: 'assistant', kind: 'message', content: 'Prefix B.', parent_stream_id: 'stream_2' });
  store.appendTurnEvents('session_1', [{ event_id: 'stream_2:canonical:1', turn_id: 'turn_1',
    kind: 'assistant_text_segment', primary_message_id: 'assistant_stream_2',
    source_message_ids: ['assistant_stream_2'], tool_call_id: '',
    payload: { canonical_seq: 1, canonical_event_type: 'assistant_text_completed',
      canonical_part_id: 'part_b', text: 'Prefix B.' } }], { durable: true });
  const workB = { ...work(), attempt: attemptB };
  const secondProposal = { ...proposal('checkpoint_b', 1), source_attempt: attemptB,
    stream_id: attemptB.stream_id };
  const second = port.preparePendingContinuation('session_1', secondProposal, workB);
  assert.equal(port.publishPendingContinuation(second).ok, true);
  const resolved = port.resolvePendingContinuation(continuation(second, attemptB), workB,
    { includePayload: true });
  assert.equal(resolved.valid, true);
  assert.deepEqual(resolved.turnMessages.map(row => row.id),
    [USER_MESSAGE_ID, 'assistant_stream_1', 'assistant_stream_2']);
  assert.deepEqual(resolved.turnEvents.map(event => event.event_id),
    ['stream_1:canonical:1', 'stream_2:canonical:1']);
  assert.deepEqual(buildPreparedContinuationPrefix(
    resolved.turnMessages.filter(row => row.id !== USER_MESSAGE_ID), resolved.turnEvents
  ), [{ role: 'assistant', content: 'Prefix A.' }, { role: 'assistant', content: 'Prefix B.' }]);
  assert.equal(port.removePendingContinuation('session_1', 'checkpoint_a', attempt).reason,
    'runtime_continuation_dependency_active');
});

test('future and malformed headers survive ordinary writes while continuation operations fail closed', (t) => {
  const { store } = setup(t);
  const future = { schema_version: 2, entries: [], opaque: { keep: true } };
  store._updateSessionRecord('session_1', { runtime_continuations: future });
  store.renameSession('session_1', 'Future preserved');
  assert.deepEqual(store.getSession('session_1').runtime_continuations, future);
  assert.throws(() => store.conversationStore.preparePendingContinuation(
    'session_1', proposal(), work()), /runtime_continuation/);

  const malformed = { schema_version: 1, entries: 'retain-me' };
  store._updateSessionRecord('session_1', { runtime_continuations: malformed });
  store.renameSession('session_1', 'Malformed preserved');
  assert.deepEqual(store.getSession('session_1').runtime_continuations, malformed);
  assert.throws(() => store.conversationStore.preparePendingContinuation(
    'session_1', proposal(), work()), /runtime_continuation/);
});

test('coordinates actual canonical publication with a durable checkpoint reservation', (t) => {
  const state = setup(t);
  const runtimeWork = work();
  const route = runtimeWork.input.route;
  const context = buildAdmittedContinuationContext({ work: runtimeWork, route,
    attempt, executionContext: { ...runtimeWork.authority,
      authority_revision: attempt.authority_revision } });
  const conversationStore = state.store.conversationStore;
  let prepared = null;
  const observingStore = {
    preparePendingContinuation(...args) {
      prepared = conversationStore.preparePendingContinuation(...args);
      return prepared;
    },
    publishPendingContinuation(...args) {
      return conversationStore.publishPendingContinuation(...args);
    },
  };
  const checkpointRoot = path.join(state.root, 'checkpoints');
  const validateCanonical = (value, suppliedWork) => (
    conversationStore.resolvePendingContinuation(value, suppliedWork)
  );
  const checkpointStore = new CheckpointStore(checkpointRoot, { validateCanonical });
  const coordinator = new RuntimeContinuationCoordinator({ conversationStore: observingStore, checkpointStore,
    context, getCurrentWork: () => runtimeWork, assertCurrent: () => true });
  const checkpointRef = coordinator.publish({ proposal: proposal('checkpoint_1', 0),
    position: { completed_iterations: 1, remaining_iterations: 7, current_iteration: 1,
      tool_call_limit: 20, tool_calls_consumed: 2, active_budget_ms_remaining: 5000,
      ordered_call_ids: ['call_1', 'call_2'] },
    wait: { kind: 'resource', resource_class: 'tool_operations', dependency_id: null,
      operation_id: 'call_1' },
    eligibility: { pending_call_index: 0, prior_outcome_count: 0,
      emitted_tool_execution_count: 0, preview_count: 0, approval_pending: false,
      mutation_started: false } });

  assert.ok(prepared);
  assert.deepEqual(Object.keys(prepared).sort(), [
    'canonicalRefs', 'checkpointId', 'encodedArtifactBytes', 'entry',
    'expectedDirtyEpoch', 'expectedSessionIncarnation', 'expectedTurnGeneration',
    'frozenInputRef', 'sessionId', 'sourceAttempt', 'workId',
  ]);
  assert.equal(checkpointStore.validate(runtimeWork, checkpointRef), true);
  assert.deepEqual(conversationStore.resolvePendingContinuation(
    checkpointStore.read(checkpointRef, runtimeWork), runtimeWork),
  { valid: true, bytes: prepared.encodedArtifactBytes });

  state.store.flush();
  const reopenedSessions = new ElectronSessionStore(state.file);
  const reopenedCheckpoints = new CheckpointStore(checkpointRoot, {
    validateCanonical: (value, suppliedWork) => (
      reopenedSessions.conversationStore.resolvePendingContinuation(value, suppliedWork)
    ),
  });
  assert.equal(reopenedCheckpoints.validate(runtimeWork, checkpointRef), true);
});

test('retains up to twenty paused-work artifacts and refuses the next without eviction', (t) => {
  const { store } = setup(t);
  const port = store.conversationStore;
  const candidates = [];
  for (let index = 0; index < 20; index += 1) {
    const candidate = port.preparePendingContinuation(
      'session_1', proposal(`checkpoint_${index}`), work());
    assert.equal(port.publishPendingContinuation(candidate).ok, true);
    candidates.push(candidate);
  }
  const overflow = port.preparePendingContinuation('session_1', proposal('checkpoint_20'), work());
  const refused = port.publishPendingContinuation(overflow);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'runtime_continuation_capacity');
  assert.equal(store.getSession('session_1').runtime_continuations.entries.length, 20);

  const removed = port.removePendingContinuation('session_1', 'checkpoint_0', attempt);
  assert.equal(hasDurableProof(removed), true);
  assert.equal(store.getSession('session_1').runtime_continuations.entries.length, 19);
  assert.equal(port.removePendingContinuation('session_1', 'checkpoint_0', attempt).ok, true);
  assert.equal(port.resolvePendingContinuation(continuation(candidates[0]), work()).valid, false);
});


test('decision artifact retains exact application approval projection and refuses changed consent evidence', t => {
  const state = setup(t);
  const port = state.store.conversationStore;
  const decision = { kind: 'approval', decision_id: 'decision_1', call_id: 'call_1', execution_started: false };
  const event = { event_id: 'turn_1:tool_use:7:stream_1', turn_id: 'turn_1',
    kind: 'tool_use', status: 'pending_approval', tool_call_id: 'call_1',
    payload: { approval_id: 'approval_session_1_stream_1_call_1', parent_stream_id: 'stream_1',
      tool_name: 'read_file', input: toolCalls()[0].arguments } };
  state.store.appendTurnEvents('session_1', [event, {
    event_id: 'stream_1:approval:requested:call_1', turn_id: 'turn_1',
    kind: 'approval_requested', status: 'approval_pending', tool_call_id: 'call_1',
    payload: { canonical_seq: 3, tool_name: 'read_file', approval_state: 'pending' },
  }], { durable: true });
  const input = { ...proposal('checkpoint_decision', 3), decision, projection_event_ids: [event.event_id] };
  const candidate = port.preparePendingContinuation('session_1', input, work());
  assert.equal(candidate.entry.schema_version, 2);
  assert.deepEqual(candidate.entry.body.decision, decision);
  assert.ok(candidate.entry.body.turn_selector.ordered_event_ids.includes(event.event_id));
  assert.equal(hasDurableProof(port.publishPendingContinuation(candidate)), true);
  const checkpoint = { ...continuation(candidate), decision };
  assert.equal(port.resolvePendingContinuation(checkpoint, work(), { includePayload: true }).valid, true);
  const reloaded = new ElectronSessionStore(state.file);
  assert.equal(reloaded.conversationStore.resolvePendingContinuation(checkpoint, work()).valid, true);
  assert.equal(port.resolvePendingContinuation({ ...checkpoint, decision: { ...decision, decision_id: 'forged' } }, work()).valid, false);
  const session = state.store.getSession('session_1');
  const changed = structuredClone(session.turn_events);
  changed.find(item => item.event_id === event.event_id).payload.input = { path: 'changed.txt' };
  state.store.updateSession('session_1', { turn_events: changed });
  assert.equal(port.resolvePendingContinuation(checkpoint, work()).valid, false);
});


for (const location of ['effective_tool_arguments', 'execution_context_payload', 'completed_result']) {
  test(`decision publication rejects canonical mutation state in ${location}`, t => {
    const { store } = setup(t);
    const input = { ...proposal(), decision: { kind: 'approval', decision_id: 'decision_1',
      call_id: 'call_1', execution_started: false } };
    if (location === 'completed_result') {
      store.appendTurnEvents('session_1', [{ event_id: 'stream_1:canonical:3', turn_id: 'turn_1',
        kind: 'tool_result', tool_call_id: 'completed', payload: { canonical_seq: 3,
          tool_name: 'write_file', success: true, metadata: { workspace_change_set: { id: 'change_1' } } } }], { durable: true });
      input.through_seq = 3;
    } else {
      input.frozen_input[location]._jenny_change_set_id = 'change_1';
      input.frozen_input_bytes = Buffer.from(stableJson(input.frozen_input)).toString('base64');
      input.frozen_input_sha256 = createHash('sha256').update(Buffer.from(input.frozen_input_bytes, 'base64')).digest('hex');
    }
    assert.throws(() => store.conversationStore.preparePendingContinuation('session_1', input, work()),
      { code: 'runtime_decision_mutation_state_unsupported' });
    assert.equal(store.getSession('session_1').runtime_continuations.entries.length, 0);
  });
}

test('decision canonical material bound applies before publication and during rehydration', t => {
  const { store } = setup(t);
  const input = { ...proposal(), decision: { kind: 'approval', decision_id: 'decision_1',
    call_id: 'call_1', execution_started: false } };
  const port = store.conversationStore;
  const candidate = port.preparePendingContinuation('session_1', input, work());
  assert.equal(hasDurableProof(port.publishPendingContinuation(candidate)), true);
  const checkpoint = { ...continuation(candidate), decision: input.decision };
  const events = structuredClone(store.getSession('session_1').turn_events);
  events[0].payload.text = 'x'.repeat(1024 * 1024);
  store.updateSession('session_1', { turn_events: events });
  assert.throws(() => port.preparePendingContinuation('session_1', { ...input, checkpoint_id: 'checkpoint_large' }, work()),
    { code: 'runtime_decision_prefix_capacity' });
  assert.equal(port.resolvePendingContinuation(checkpoint, work(), { includePayload: true }).valid, false);
});
