'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { CanonicalTurnEventCollector } = require('../../services/backend/canonical-turn-event-collector');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { captureRuntimeContinuationHistory } = require('../../services/backend/runtime-continuation-history');
const { createManagedContinuationBoundary } = require('../../services/backend/runtime-continuation-managed');
const { recoverPublishedRuntimeContinuations } = require('../../services/backend/runtime-continuation-recovery');
const { SessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const { TurnEventJournal } = require('../../services/backend/turn-event-journal');
const { recoverTurnEventJournal } = require('../../services/session-recovery-service');
const { CheckpointStore } = require('../../services/session-runtime/checkpoint-store');
const { buildAdmittedContinuationContext } = require('../../services/session-runtime/continuation-context');
const { stableJson } = require('../../services/session-runtime/contracts');
const { captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { RuntimeStore } = require('../../services/session-runtime/store');

const sha256 = value => createHash('sha256').update(value).digest('hex');
function pythonCanonical(value) {
  return stableJson(value).replace(/Ω/gu, '\\u03a9');
}
function encoded(value) {
  const bytes = Buffer.from(pythonCanonical(value), 'utf8');
  return { bytes: bytes.toString('base64'), sha256: sha256(bytes) };
}

function pythonSnapshots(sessionId, turnId) {
  const visible = { label: 'Ω', path: 'README.md' };
  const effective = { ...visible, _jenny_session_id: sessionId,
    _jenny_tool_call_id: 'call_1', _jenny_turn_id: turnId };
  const calls = [{ call_id: 'call_1', tool_id: 'read_file', arguments: visible,
    idempotency_key: '', coerced: false, malformed_arguments: false, argument_repairs: [] }];
  const input = { call_id: 'call_1', tool_name: 'read_file', visible_tool_arguments: visible,
    effective_tool_arguments: effective,
    injected_arg_keys: ['_jenny_session_id', '_jenny_tool_call_id', '_jenny_turn_id'],
    effective_args_fingerprint: sha256(Buffer.from(pythonCanonical(effective), 'utf8')),
    execution_context_payload: { session_id: sessionId, authority_revision: 'authority_1',
      logical_turn_id: turnId, project_id: 'general', root_id: null, root_revision: 0 } };
  return { calls, input, batchBytes: encoded({ calls }), inputBytes: encoded(input) };
}

async function publishedCrashFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-checkpoint-restart-'));
  const sessionPath = path.join(root, 'sessions.json');
  const journalPath = path.join(root, 'turn-journal.json');
  const runtimeRoot = path.join(root, 'runtime');
  const checkpointRoot = path.join(root, 'checkpoints');
  const sessionId = 'session_1';
  const turnId = 'turn_1';
  const stores = [];
  t.after(() => {
    for (const store of stores) store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sessionStore = new ElectronSessionStore(sessionPath, { writeDebounceMs: 0 });
  stores.push(sessionStore);
  sessionStore.createSessionWithId(sessionId, { title: 'Checkpoint crash' });
  const historySelector = captureRuntimeContinuationHistory({
    canonicalSessionMessages: sessionStore.getSessionMessages(sessionId),
    contextPreferences: { history_scope: 'session' }, frameOutcome: { fitsBudget: true },
    compactedHistory: { applied: false }, sessionSummary: sessionStore.getSession(sessionId),
  });
  const actorRegistry = new SessionTurnActorRegistry({ createId: () => 'stream_1' });
  const activeStreams = new Map();
  const lease = actorRegistry.reserveStart({ sessionId, store: sessionStore, activeStreams,
    prompt: 'Inspect the workspace.', logicalTurnId: turnId });
  actorRegistry.attachController(lease, { abort() {} });
  sessionStore.appendMessage(sessionId, { id: lease.identity.userMessageId, turn_id: turnId,
    role: 'user', kind: 'message', content: 'Inspect the workspace.',
    timestamp: '2026-09-10T12:00:00.000Z' });
  const journal = new TurnEventJournal(journalPath);
  const collector = new CanonicalTurnEventCollector({ store: sessionStore, sessionId,
    turnId, attemptId: lease.identity.streamId, canonicalPrimary: true, journal });
  collector.noteEvent({ event_id: `${lease.identity.streamId}:canonical:1`, turn_id: turnId,
    kind: 'reasoning_phase', status: 'streaming', payload: { canonical_seq: 1,
      canonical_event_type: 'reasoning_delta', text: 'Checking.' } });

  const route = captureRuntimeRoute({ engine_type: 'chatgpt', provider_id: 'chatgpt',
    configuration_revision: 'config:1', resource_class: 'cloud', requires_gpu: false });
  const authority = { project_id: 'general', root_path: null, root_id: null,
    root_revision: 0, device_id: null, inode: null };
  const runtimeStore = new RuntimeStore(runtimeRoot);
  const submitted = runtimeStore.submit({ idempotencyKey: 'submit_1', projectId: 'general',
    sessionId, purpose: 'chat_turn', input: { route,
      request: { prompt: 'Inspect the workspace.', attachments: [] } }, authority,
    workId: 'work_1', turnId }).record;
  const attempt = { attempt_id: 'attempt_1', stream_id: lease.identity.streamId,
    incarnation: 'runtime_incarnation_1', authority_revision: 'authority_1' };
  const work = runtimeStore.transition(submitted.work_id, { expectedRevision: submitted.revision,
    to: 'running', reason: 'dispatch', attempt }).record;
  const context = buildAdmittedContinuationContext({ work, attempt, route,
    executionContext: { ...authority, authority_revision: attempt.authority_revision } });
  const conversationStore = sessionStore.conversationStore;
  const checkpointStore = new CheckpointStore(checkpointRoot, {
    validateCanonical: (continuation, currentWork) => (
      conversationStore.resolvePendingContinuation(continuation, currentWork)
    ),
  });
  const snapshots = pythonSnapshots(sessionId, turnId);
  const boundary = createManagedContinuationBoundary({ context, checkpointStore,
    conversationStore, getCurrentWork: () => work, assertCurrent: () => true,
    assertProtocol: () => true, collector, historySelector,
    gateway: { snapshot: () => ({ active: 0, reserved: 0, quarantined: 0 }), tools: {
      validateResourceWait: () => ({ resource_class: 'filesystem', dependency_id: null }),
    } } });
  const response = await boundary.handleOperation({ api_version: '2026-08-17', schema_version: 1,
    kind: 'continuation', phase: 'checkpoint', request_id: attempt.stream_id, session_id: sessionId,
    authority_revision: attempt.authority_revision, operation_id: 'call_1',
    continuation_context: context, tool_calls: snapshots.calls,
    tool_batch_bytes: snapshots.batchBytes.bytes, tool_batch_sha256: snapshots.batchBytes.sha256,
    frozen_input: snapshots.input, frozen_input_bytes: snapshots.inputBytes.bytes,
    frozen_input_sha256: snapshots.inputBytes.sha256,
    position: { completed_iterations: 1, remaining_iterations: 7, current_iteration: 1,
      tool_call_limit: 20, tool_calls_consumed: 1, active_budget_ms_remaining: 5000,
      ordered_call_ids: ['call_1'] }, eligibility: { pending_call_index: 0,
      prior_outcome_count: 0, emitted_tool_execution_count: 0, preview_count: 0,
      approval_pending: false, mutation_started: false } });
  assert.equal(response.status, 'checkpointed');
  sessionStore.flush();

  function reopen() {
    const nextSessionStore = new ElectronSessionStore(sessionPath, { writeDebounceMs: 0 });
    stores.push(nextSessionStore);
    const nextRuntimeStore = new RuntimeStore(runtimeRoot);
    const nextJournal = new TurnEventJournal(journalPath);
    const nextConversationStore = nextSessionStore.conversationStore;
    const nextCheckpointStore = new CheckpointStore(checkpointRoot, {
      validateCanonical: (continuation, currentWork) => (
        nextConversationStore.resolvePendingContinuation(continuation, currentWork)
      ),
    });
    return { sessionStore: nextSessionStore, runtimeStore: nextRuntimeStore,
      journal: nextJournal, conversationStore: nextConversationStore,
      checkpointStore: nextCheckpointStore, actorRegistry: new SessionTurnActorRegistry(),
      activeStreams: new Map() };
  }
  return { root, sessionId, turnId, attempt, work, response, sessionStore, journal,
    runtimeStore, checkpointStore, actorRegistry, activeStreams, lease, reopen };
}

function reconcile(restarted) {
  return recoverPublishedRuntimeContinuations({ ...restarted });
}

test('restart converts a committed checkpoint orphan into a resumable paused record', async t => {
  const f = await publishedCrashFixture(t);
  assert.equal(f.sessionStore.getActiveTurn(f.sessionId).stream_id, f.attempt.stream_id);
  assert.equal(f.runtimeStore.get(f.work.work_id).status, 'running');
  const published = f.checkpointStore.read(f.response.checkpoint_ref, f.work);
  const payload = f.sessionStore.conversationStore.resolvePendingContinuation(
    published, f.work, { includePayload: true }
  );
  assert.deepEqual(payload.turnEvents.map(event => event.event_id), [
    `${f.attempt.stream_id}:canonical:1`,
  ]);

  const restarted = f.reopen();
  assert.equal(restarted.runtimeStore.get(f.work.work_id).status, 'paused');
  assert.equal(recoverTurnEventJournal(restarted).blocked, 0);
  assert.deepEqual(reconcile(restarted), { recovered: 1, blocked: 0, ordinary: 0 });

  const recovered = restarted.runtimeStore.get(f.work.work_id);
  assert.deepEqual(recovered.checkpoint_ref, f.response.checkpoint_ref);
  assert.equal(recovered.status, 'paused');
  assert.equal(restarted.sessionStore.getActiveTurn(f.sessionId), null);
  assert.equal(restarted.sessionStore.getSessionMessages(f.sessionId)
    .some(message => message.role === 'assistant'), false);
  assert.equal(restarted.checkpointStore.validate(recovered, recovered.checkpoint_ref), true);
  assert.deepEqual(reconcile(restarted), { recovered: 1, blocked: 0, ordinary: 0 });
});

test('checkpoint attachment survives a refused actor clear and a second restart retries safely', async t => {
  const f = await publishedCrashFixture(t);
  const first = f.reopen();
  recoverTurnEventJournal(first);
  const clear = first.sessionStore.clearActiveTurn.bind(first.sessionStore);
  first.sessionStore.clearActiveTurn = () => null;

  assert.deepEqual(reconcile(first), { recovered: 0, blocked: 1, ordinary: 0 });
  assert.deepEqual(first.runtimeStore.get(f.work.work_id).checkpoint_ref, f.response.checkpoint_ref);
  assert.ok(first.sessionStore.getActiveTurn(f.sessionId));
  first.sessionStore.clearActiveTurn = clear;
  first.sessionStore.flush();

  const second = f.reopen();
  recoverTurnEventJournal(second);
  assert.deepEqual(reconcile(second), { recovered: 1, blocked: 0, ordinary: 0 });
  assert.equal(second.sessionStore.getActiveTurn(f.sessionId), null);
  assert.deepEqual(second.runtimeStore.get(f.work.work_id).checkpoint_ref, f.response.checkpoint_ref);
});

test('journal evidence appearing during actor pause restores the bracket and can retry', async t => {
  const f = await publishedCrashFixture(t);
  const restarted = f.reopen();
  recoverTurnEventJournal(restarted);
  const list = restarted.journal.list.bind(restarted.journal);
  let calls = 0;
  restarted.journal.list = (...args) => {
    calls += 1;
    return calls === 1 ? [] : [{ event_id: 'late_evidence' }];
  };

  assert.deepEqual(reconcile(restarted), { recovered: 0, blocked: 1, ordinary: 0 });
  assert.equal(restarted.sessionStore.getActiveTurn(f.sessionId).stream_id, f.attempt.stream_id);
  assert.deepEqual(restarted.runtimeStore.get(f.work.work_id).checkpoint_ref, f.response.checkpoint_ref);
  assert.throws(() => restarted.actorRegistry.reserveStart({ sessionId: f.sessionId,
    store: restarted.sessionStore, activeStreams: restarted.activeStreams, prompt: 'retry' }),
  error => error.code === 'session_busy' && error.reason === 'lease_active');

  restarted.journal.list = list;
  assert.deepEqual(reconcile(restarted), { recovered: 1, blocked: 0, ordinary: 0 });
  assert.equal(restarted.sessionStore.getActiveTurn(f.sessionId), null);
});

test('restart finishes a checkpoint journal after the active bracket was already cleared', async t => {
  const f = await publishedCrashFixture(t);
  assert.ok(f.sessionStore.clearActiveTurn(f.sessionId, {
    request_id: f.turnId, stream_id: f.attempt.stream_id,
  }));
  assert.equal(f.sessionStore.flushSession(f.sessionId), true);
  const restarted = f.reopen();
  assert.equal(restarted.sessionStore.getActiveTurn(f.sessionId), null);
  assert.equal(restarted.journal.list(f.sessionId, f.turnId).length, 1);
  assert.equal(recoverTurnEventJournal(restarted).replayed, 0);
  assert.equal(restarted.journal.list(f.sessionId, f.turnId).length, 1);

  assert.deepEqual(reconcile(restarted), { recovered: 1, blocked: 0, ordinary: 0 });
  assert.deepEqual(restarted.journal.list(f.sessionId, f.turnId), []);
  const recovered = restarted.runtimeStore.get(f.work.work_id);
  assert.deepEqual(recovered.checkpoint_ref, f.response.checkpoint_ref);
  assert.equal(restarted.checkpointStore.validate(recovered, recovered.checkpoint_ref), true);
});

test('unknown journal evidence blocks checkpoint recovery and ordinary orphan terminalization', async t => {
  const f = await publishedCrashFixture(t);
  f.journal.append(f.sessionId, f.turnId, [{ event_id: 'other_stream:canonical:2',
    turn_id: f.turnId, kind: 'reasoning_phase', status: 'streaming',
    payload: { canonical_seq: 2, canonical_event_type: 'reasoning_delta', text: 'Unknown.' } }]);
  assert.ok(f.sessionStore.clearActiveTurn(f.sessionId, {
    request_id: f.turnId, stream_id: f.attempt.stream_id,
  }));
  assert.equal(f.sessionStore.flushSession(f.sessionId), true);
  const restarted = f.reopen();
  assert.equal(recoverTurnEventJournal(restarted).blocked, 0);

  assert.deepEqual(reconcile(restarted), { recovered: 0, blocked: 1, ordinary: 0 });
  assert.equal(restarted.runtimeStore.get(f.work.work_id).checkpoint_ref, null);
  assert.throws(() => restarted.actorRegistry.reserveStart({ sessionId: f.sessionId,
    store: restarted.sessionStore, activeStreams: restarted.activeStreams, prompt: 'retry' }),
  error => error.code === 'active_turn_recovery_failed'
    && error.reason === 'checkpoint_journal_attempt_mismatch');
  assert.equal(restarted.sessionStore.getSessionMessages(f.sessionId)
    .some(message => message.role === 'assistant'), false);
});

test('a late canonical effect blocks recovery without attaching the checkpoint', async t => {
  const f = await publishedCrashFixture(t);
  f.sessionStore.appendMessage(f.sessionId, { id: `tool_use_${f.attempt.stream_id}_call_1`,
    turn_id: f.turnId, role: 'assistant', kind: 'tool_use', content: 'Running read_file',
    parent_stream_id: f.attempt.stream_id, tool_call: { call_id: 'call_1',
      tool_name: 'read_file', input: { path: 'README.md' }, input_json: '{"path":"README.md"}',
      status: 'running', approval_state: 'auto', duration_ms: 0,
      parent_stream_id: f.attempt.stream_id } });
  f.sessionStore.flush();
  const restarted = f.reopen();
  recoverTurnEventJournal(restarted);

  assert.deepEqual(reconcile(restarted), { recovered: 0, blocked: 1, ordinary: 0 });
  assert.equal(restarted.runtimeStore.get(f.work.work_id).checkpoint_ref, null);
  assert.throws(() => restarted.actorRegistry.reserveStart({ sessionId: f.sessionId,
    store: restarted.sessionStore, activeStreams: restarted.activeStreams, prompt: 'retry' }),
  error => error.code === 'active_turn_recovery_failed'
    && error.reason === 'checkpoint_canonical_unavailable');
});

for (const control of ['pause', 'cancel']) test(`published interrupted settlement recovers while retaining ${control} intent`, async t => {
  const f = await publishedCrashFixture(t);
  const controlled = f.runtimeStore[control === 'pause' ? 'requestPause' : 'requestCancellation'](f.work.work_id, {
    expectedRevision: f.work.revision, expectedAttempt: f.attempt, reason: 'user' }).record;
  f.runtimeStore.transition(f.work.work_id, { expectedRevision: controlled.revision, expectedAttempt: f.attempt,
    to: 'needs_attention', reason: 'settlement_unconfirmed' });
  const first = f.reopen();
  recoverTurnEventJournal(first);
  const clear = first.sessionStore.clearActiveTurn.bind(first.sessionStore);
  first.sessionStore.clearActiveTurn = () => null;
  assert.equal(reconcile(first).blocked, 1);
  const saved = first.runtimeStore.get(f.work.work_id);
  assert.equal(saved.status, 'paused');
  assert.equal(saved.recovery.previous_status, 'needs_attention');
  assert.equal(saved.control_request.kind, control);
  assert.deepEqual(saved.checkpoint_ref, f.response.checkpoint_ref);
  first.sessionStore.clearActiveTurn = clear; first.sessionStore.flush();
  const second = f.reopen();
  recoverTurnEventJournal(second);
  assert.equal(reconcile(second).recovered, 1);
  assert.equal(second.runtimeStore.get(f.work.work_id).control_request.kind, control);
  assert.equal(second.sessionStore.getActiveTurn(f.sessionId), null);
});
