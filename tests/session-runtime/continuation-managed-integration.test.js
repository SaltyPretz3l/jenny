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
const { hydrateRuntimeContinuation } = require('../../services/backend/runtime-continuation-resume');
const { SessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const { TurnEventJournal } = require('../../services/backend/turn-event-journal');
const { CheckpointStore } = require('../../services/session-runtime/checkpoint-store');
const { buildAdmittedContinuationContext } = require('../../services/session-runtime/continuation-context');
const { stableJson } = require('../../services/session-runtime/contracts');
const { captureRuntimeRoute } = require('../../services/session-runtime/lanes');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Mirrors Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)
// for this deliberately narrow fixture, including Python's retained integral float.
function pythonCanonical(value) {
  return stableJson(value)
    .replace(/Ω/gu, '\\u03a9')
    .replace(/"ratio":1(?=[,}])/gu, '"ratio":1.0');
}

function encodedPython(value) {
  const bytes = Buffer.from(pythonCanonical(value), 'utf8');
  return { bytes: bytes.toString('base64'), sha256: sha256(bytes) };
}

function pythonSnapshots({ sessionId, turnId }) {
  const visible = { label: 'Ω', path: 'README.md', ratio: 1 };
  const effective = { ...visible, _jenny_session_id: sessionId,
    _jenny_tool_call_id: 'call_1', _jenny_turn_id: turnId };
  const toolCalls = [{ call_id: 'call_1', tool_id: 'read_file', arguments: visible,
    idempotency_key: '', coerced: false, malformed_arguments: false, argument_repairs: [] }];
  const frozenInput = { call_id: 'call_1', tool_name: 'read_file', visible_tool_arguments: visible,
    effective_tool_arguments: effective,
    injected_arg_keys: ['_jenny_session_id', '_jenny_tool_call_id', '_jenny_turn_id'],
    effective_args_fingerprint: sha256(Buffer.from(pythonCanonical(effective), 'utf8')),
    execution_context_payload: { session_id: sessionId, authority_revision: 'authority_1',
      logical_turn_id: turnId, project_id: 'general', root_id: null, root_revision: 0 } };
  return { toolCalls, frozenInput, batch: encodedPython({ calls: toolCalls }),
    input: encodedPython(frozenInput) };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-continuation-managed-integration-'));
  const sessionPath = path.join(root, 'sessions.json');
  const checkpointRoot = path.join(root, 'checkpoints');
  const sessionId = 'session_1';
  const turnId = 'turn_1';
  const store = new ElectronSessionStore(sessionPath, { writeDebounceMs: 0 });
  const reopened = [];
  t.after(() => {
    for (const item of reopened) item.dispose();
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.createSessionWithId(sessionId, { title: 'Continuation integration' });
  const historySelector = captureRuntimeContinuationHistory({
    canonicalSessionMessages: store.getSessionMessages(sessionId),
    contextPreferences: { history_scope: 'session' },
    frameOutcome: { fitsBudget: true }, compactedHistory: { applied: false },
    sessionSummary: store.getSession(sessionId),
  });
  const activeStreams = new Map();
  const actorRegistry = new SessionTurnActorRegistry({ createId: () => 'physical_1' });
  const lease = actorRegistry.reserveStart({ sessionId, store, activeStreams,
    prompt: 'Inspect the workspace.', logicalTurnId: turnId });
  const streamId = lease.identity.streamId;
  const controller = { abort() {} };
  assert.equal(actorRegistry.attachController(lease, controller), true);
  store.appendMessage(sessionId, { id: lease.identity.userMessageId, turn_id: turnId,
    role: 'user', kind: 'message', content: 'Inspect the workspace.',
    timestamp: '2026-09-10T12:00:00.000Z' });
  const journal = new TurnEventJournal(path.join(root, 'turn-journal.json'));
  const collector = new CanonicalTurnEventCollector({ store, sessionId, turnId,
    attemptId: streamId, canonicalPrimary: true, journal });
  collector.noteEvent({ event_id: `${streamId}:canonical:1`, turn_id: turnId,
    kind: 'reasoning_phase', status: 'streaming', payload: { canonical_seq: 1,
      canonical_event_type: 'reasoning_delta', text: 'Checking the workspace.' } });

  const route = captureRuntimeRoute({ engine_type: 'chatgpt', provider_id: 'chatgpt',
    configuration_revision: 'config:1', resource_class: 'cloud', requires_gpu: false });
  const authority = { project_id: 'general', root_path: null, root_id: null,
    root_revision: 0, device_id: null, inode: null };
  const attempt = { attempt_id: 'attempt_1', stream_id: streamId,
    incarnation: 'runtime_incarnation_1', authority_revision: 'authority_1' };
  const work = { work_id: 'work_1', turn_id: turnId, session_id: sessionId,
    project_id: 'general', authority, attempt,
    input: { route, request: { prompt: 'Inspect the workspace.', attachments: [] } }, status: 'running',
    revision: 3, submission_hash: 'd'.repeat(64) };
  const executionContext = { ...authority, authority_revision: attempt.authority_revision };
  const context = buildAdmittedContinuationContext({ work, attempt, route, executionContext });
  const state = { current: true, work, resources: { active: 0, reserved: 0, quarantined: 0 } };
  const conversationStore = store.conversationStore;
  const canonicalValidation = (continuation, currentWork) => (
    conversationStore.resolvePendingContinuation(continuation, currentWork)
  );
  const checkpointStore = new CheckpointStore(checkpointRoot, {
    validateCanonical: canonicalValidation,
  });
  const snapshots = pythonSnapshots({ sessionId, turnId });
  const gateway = { snapshot: () => ({ ...state.resources }), tools: {
    validateResourceWait(operationId, toolId, visibleArguments) {
      assert.equal(operationId, 'call_1');
      assert.equal(toolId, 'read_file');
      assert.deepEqual(visibleArguments, snapshots.frozenInput.visible_tool_arguments);
      return { resource_class: 'filesystem', dependency_id: null };
    },
  } };
  const boundary = createManagedContinuationBoundary({ context, checkpointStore,
    conversationStore, getCurrentWork: () => state.work, assertCurrent: () => state.current,
    assertProtocol: () => true, gateway, collector, historySelector });
  const params = { api_version: '2026-08-17', schema_version: 1, kind: 'continuation',
    phase: 'checkpoint', request_id: streamId, session_id: sessionId,
    authority_revision: attempt.authority_revision, operation_id: 'call_1',
    continuation_context: context, tool_calls: snapshots.toolCalls,
    tool_batch_bytes: snapshots.batch.bytes, tool_batch_sha256: snapshots.batch.sha256,
    frozen_input: snapshots.frozenInput, frozen_input_bytes: snapshots.input.bytes,
    frozen_input_sha256: snapshots.input.sha256,
    position: { completed_iterations: 1, remaining_iterations: 7, current_iteration: 1,
      tool_call_limit: 20, tool_calls_consumed: 1, active_budget_ms_remaining: 5000,
      ordered_call_ids: ['call_1'] }, eligibility: { pending_call_index: 0,
      prior_outcome_count: 0, emitted_tool_execution_count: 0, preview_count: 0,
      approval_pending: false, mutation_started: false } };
  const releaseArgs = { actorRegistry, lease, pendingToolApprovals: new Map(), pendingUserQuestions: new Map() };

  async function publish() {
    const response = await boundary.handleOperation(params);
    assert.equal(response.status, 'checkpointed');
    return { request_id: streamId, status: 'paused', checkpoint_ref: response.checkpoint_ref };
  }
  function reopen() {
    store.flush();
    const nextStore = new ElectronSessionStore(sessionPath, { writeDebounceMs: 0 });
    reopened.push(nextStore);
    const nextCheckpointStore = new CheckpointStore(checkpointRoot, {
      validateCanonical: (continuation, currentWork) => (
        nextStore.conversationStore.resolvePendingContinuation(continuation, currentWork)
      ),
    });
    return { store: nextStore, checkpointStore: nextCheckpointStore };
  }
  return { root, store, checkpointStore, collector, journal, state, work, attempt, params, gateway,
    actorRegistry, activeStreams, lease, streamId, turnId, boundary, releaseArgs, publish, reopen };
}

function assertActorRetained(f) {
  assert.equal(f.lease.released, false);
  assert.equal(f.activeStreams.has(f.streamId), true);
  assert.equal(f.store.getActiveTurn('session_1').stream_id, f.streamId);
}

test('real checkpoint hydration pins source A before fresh B and preserves original Python bytes', async t => {
  const f = fixture(t);
  f.collector.noteEvent({ event_id: `${f.streamId}:canonical:2`, turn_id: f.turnId,
    kind: 'assistant_text_segment', primary_message_id: `assistant_${f.turnId}`,
    payload: { canonical_seq: 2, canonical_event_type: 'text_part_completed',
      canonical_part_id: 'text_1', text: 'Use the previously computed value X.' } });
  const reply = await f.publish();
  f.boundary.settlePause(reply, f.releaseArgs);
  const source = { ...f.work, status: 'paused', checkpoint_ref: reply.checkpoint_ref };
  const hydrated = hydrateRuntimeContinuation({ work: source, checkpointStore: f.checkpointStore,
    conversationStore: f.store.conversationStore, assertCurrent: () => f.state.current });
  f.store.appendMessage('session_1', { id: 'later_user', turn_id: 'later_turn', role: 'user',
    content: 'A later unrelated conversation.', timestamp: '2026-09-10T13:00:00Z' });
  assert.deepEqual(hydrated.buildMessages().filter(row => row.role === 'user'), [
    { role: 'user', content: 'Inspect the workspace.' },
  ]);
  assert.deepEqual(hydrated.buildMessages().filter(row => row.role === 'assistant'), [
    { role: 'assistant', content: 'Use the previously computed value X.' },
  ], 'saved text survives even before a canonical assistant row is materialized');
  const registry = new SessionTurnActorRegistry({ createId: () => 'physical_2' });
  const lease = registry.reserveStart({ sessionId: 'session_1', store: f.store,
    activeStreams: f.activeStreams, checkpointResume: hydrated.reserveIdentity(source) });
  const fresh = { ...source, status: 'running', attempt: { ...source.attempt,
    attempt_id: 'attempt_2', stream_id: lease.identity.streamId, authority_revision: 'authority_2' } };
  const route = captureRuntimeRoute(source.input.route);
  const context = buildAdmittedContinuationContext({ work: fresh, attempt: fresh.attempt, route,
    executionContext: { ...fresh.authority, authority_revision: 'authority_2' } });
  const fields = hydrated.buildResumeFields({ work: fresh, context });
  assert.equal(fields.resolved_source_attempt.attempt_id, 'attempt_1');
  assert.match(Buffer.from(fields.frozen_input_bytes, 'base64').toString(), /"ratio":1\.0/u);
  assert.match(Buffer.from(fields.tool_batch_bytes, 'base64').toString(), /\\u03a9/u);
  assert.equal(f.store.getSessionMessages('session_1').filter(row => row.id === hydrated.userMessageId).length, 1);
  assert.equal(f.store.getSessionMessages('session_1').some(row => row.id === 'later_user'), true);
  registry.release(lease, { status: 'cancelled' });
});

test('hydration rechecks canonical changes before actor admission and rejects a substituted source attempt', async t => {
  const f = fixture(t);
  const reply = await f.publish();
  f.boundary.settlePause(reply, f.releaseArgs);
  const source = { ...f.work, status: 'paused', checkpoint_ref: reply.checkpoint_ref };
  const options = { work: source, checkpointStore: f.checkpointStore,
    conversationStore: f.store.conversationStore, assertCurrent: () => f.state.current };
  const hydrated = hydrateRuntimeContinuation(options);
  assert.throws(() => hydrated.reserveIdentity({ ...source,
    attempt: { ...source.attempt, stream_id: 'other_stream' } }), /source_changed/u);
  assert.throws(() => hydrateRuntimeContinuation({ ...options, work: { ...source,
    attempt: { ...source.attempt, attempt_id: 'attempt_2' } } }), /source_mismatch/u);
  f.store.updateMessage('session_1', hydrated.userMessageId, { content: 'Edited after waiting.' });
  assert.throws(() => hydrated.reserveIdentity(source));
  assert.equal(f.store.getActiveTurn('session_1'), null);
});

test('real owners retain publication, then settle one restart-valid paused checkpoint', async t => {
  const f = fixture(t);
  const reply = await f.publish();

  assertActorRetained(f);
  assert.equal(f.journal.list('session_1', f.turnId).length, 1);
  assert.equal(f.store.getSessionMessages('session_1').length, 1);
  assert.equal(f.checkpointStore.validate(f.work, reply.checkpoint_ref), true);
  const published = f.checkpointStore.read(reply.checkpoint_ref, f.work);
  assert.equal(published.canonical_refs.history_ref.sha256.length, 64);

  const settled = f.boundary.settlePause(reply, f.releaseArgs);
  assert.deepEqual({ status: settled.status, producer: settled.producerSettled,
    canonical: settled.canonicalSettled, checkpoint: settled.checkpointSettled },
  { status: 'paused', producer: true, canonical: true, checkpoint: true });
  assert.equal(f.lease.released, true);
  assert.equal(f.activeStreams.has(f.streamId), false);
  assert.equal(f.store.getActiveTurn('session_1'), null);
  assert.deepEqual(f.journal.list('session_1', f.turnId), []);
  const session = f.store.getSession('session_1');
  assert.equal(session.messages.length, 1);
  assert.deepEqual(session.turn_events.map(event => event.kind), ['reasoning_phase']);
  assert.equal(session.turn_events.some(event => event.status === 'completed'), false);
  assert.equal(session.runtime_continuations.entries.length, 1);
  assert.equal(f.checkpointStore.validate(f.work, reply.checkpoint_ref), true);

  const restarted = f.reopen();
  assert.equal(restarted.store.getSessionMessages('session_1').length, 1);
  assert.equal(restarted.checkpointStore.validate(f.work, reply.checkpoint_ref), true);
  assert.deepEqual(restarted.checkpointStore.read(reply.checkpoint_ref, f.work).canonical_refs,
    published.canonical_refs);
});

test('journal clear failure retains every owner and the same pause can retry', async t => {
  const f = fixture(t);
  const reply = await f.publish();
  const clear = f.journal.clear.bind(f.journal);
  let failClear = true;
  f.journal.clear = (...args) => failClear
    ? { ok: false, cleared: false, durable: false, reason: 'injected' }
    : clear(...args);

  assert.throws(() => f.boundary.settlePause(reply, f.releaseArgs), /canonical_pause_unconfirmed/);
  assertActorRetained(f);
  assert.equal(f.journal.list('session_1', f.turnId).length, 1);
  failClear = false;
  assert.equal(f.boundary.settlePause(reply, f.releaseArgs).status, 'paused');
  assert.equal(f.lease.released, true);
  assert.deepEqual(f.journal.list('session_1', f.turnId), []);
});

test('canonical active-turn clear refusal does not clear the journal or release ownership', async t => {
  const f = fixture(t);
  const reply = await f.publish();
  const clearActiveTurn = f.store.clearActiveTurn.bind(f.store);
  let journalClearCalls = 0;
  const clearJournal = f.journal.clear.bind(f.journal);
  f.journal.clear = (...args) => { journalClearCalls += 1; return clearJournal(...args); };
  f.store.clearActiveTurn = () => false;

  assert.throws(() => f.boundary.settlePause(reply, f.releaseArgs), /canonical_pause_unconfirmed/);
  assertActorRetained(f);
  assert.equal(journalClearCalls, 0);
  assert.equal(f.journal.list('session_1', f.turnId).length, 1);
  f.store.clearActiveTurn = clearActiveTurn;
  assert.equal(f.boundary.settlePause(reply, f.releaseArgs).status, 'paused');
  assert.equal(journalClearCalls, 1);
});

test('changed collector or a late tool effect cannot settle the published pause', async t => {
  await t.test('collector change', async t2 => {
    const f = fixture(t2);
    const reply = await f.publish();
    f.collector.noteEvent({ event_id: `${f.streamId}:canonical:2`, turn_id: f.turnId,
      kind: 'reasoning_phase', status: 'streaming', payload: { canonical_seq: 2,
        canonical_event_type: 'reasoning_delta', text: 'Late reasoning.' } });
    assert.throws(() => f.boundary.settlePause(reply, f.releaseArgs), /checkpoint_unavailable/);
    assertActorRetained(f);
  });
  await t.test('late tool effect', async t2 => {
    const f = fixture(t2);
    const reply = await f.publish();
    f.store.appendMessage('session_1', { id: `tool_use_${f.streamId}_call_1`, turn_id: f.turnId,
      role: 'assistant', kind: 'tool_use', content: 'Running read_file',
      parent_stream_id: f.streamId, tool_call: { call_id: 'call_1', tool_name: 'read_file',
        input: { path: 'README.md' }, input_json: '{"path":"README.md"}', status: 'running',
        approval_state: 'auto', duration_ms: 0, parent_stream_id: f.streamId } });
    assert.throws(() => f.boundary.settlePause(reply, f.releaseArgs), /checkpoint_unavailable/);
    assertActorRetained(f);
  });
});

test('a stale current attempt cannot turn a published checkpoint into a successful pause', async t => {
  const f = fixture(t);
  const reply = await f.publish();
  f.state.work = { ...f.work, attempt: { ...f.attempt, attempt_id: 'attempt_replaced' } };
  assert.throws(() => f.boundary.settlePause(reply, f.releaseArgs), /checkpoint_unavailable/);
  assertActorRetained(f);
  assert.equal(f.checkpointStore.validate(f.state.work, reply.checkpoint_ref), false);
});


test('explicit pause persists through real canonical owners and releases only after cleanup', async t => {
  const f = fixture(t);
  f.params.phase = 'pause_probe';
  f.state.work.control_request = { kind: 'pause', reason: 'user_pause', requested_at: new Date().toISOString() };
  f.gateway.tools.validateResourceWait = () => { throw new Error('explicit pause has no resource wait'); };
  const reply = await f.publish();
  assertActorRetained(f);
  f.state.resources.active = 1;
  assert.throws(() => f.boundary.settlePause(reply, f.releaseArgs), /cleanup_unconfirmed/);
  assertActorRetained(f);
  f.state.resources.active = 0;
  const settled = f.boundary.settlePause(reply, f.releaseArgs);
  assert.equal(settled.status, 'paused');
  assert.equal(Object.hasOwn(settled, 'waitResources'), false);
  assert.equal(f.lease.released, true);
  const source = { ...f.work, status: 'paused', checkpoint_ref: reply.checkpoint_ref };
  const reopened = f.reopen();
  assert.equal(reopened.checkpointStore.validate(source, reply.checkpoint_ref), true);
  const hydrated = hydrateRuntimeContinuation({ work: source, checkpointStore: reopened.checkpointStore,
    conversationStore: reopened.store.conversationStore, assertCurrent: () => true });
  assert.ok(hydrated.reserveIdentity(source));
  assert.equal(hydrated.buildMessages().some(row => row.content === 'Inspect the workspace.'), true);
});

for (const phase of ['checkpoint', 'pause_probe']) test(`announced pending tool can ${phase} without execution`, async t => {
  const f = fixture(t);
  if (phase === 'pause_probe') f.state.work.control_request = { kind: 'pause' };
  f.params.phase = phase;
  f.collector.noteEvent({ event_id: `${f.streamId}:canonical:2`, turn_id: f.turnId,
    kind: 'tool_use', status: 'pending', tool_call_id: 'call_1', payload: { canonical_seq: 2,
      canonical_event_type: 'tool_call_requested', tool_name: 'read_file',
      tool_input: f.params.tool_calls[0].arguments } });
  const result = await f.boundary.handleOperation(f.params);
  assert.equal(result.status, 'checkpointed', JSON.stringify(result));
});

test('application preamble and reasoning projections retain exact IDs through checkpoint hydration', async t => {
  const f = fixture(t);
  for (const [kind, payload] of [['assistant_text_segment', { text: 'Inspecting the file.' }],
    ['reasoning_phase', { entries: [{ text: 'Internal reasoning', type: 'text' }] }]]) {
    f.collector.noteEvent({ event_id: `${f.streamId}:${kind}:live:0`, turn_id: f.turnId,
      kind, status: 'completed', payload });
  }
  const result = await f.boundary.handleOperation(f.params);
  assert.equal(result.status, 'checkpointed', JSON.stringify(result));
  const source = { ...f.state.work, status: 'paused', checkpoint_ref: result.checkpoint_ref };
  const hydration = hydrateRuntimeContinuation({ work: source, checkpointStore: f.checkpointStore,
    conversationStore: f.store.conversationStore, assertCurrent: () => true });
  assert.equal(hydration.buildMessages().filter(row => row.content === 'Inspecting the file.').length, 1);
  assert.equal(hydration.buildMessages().some(row => row.content === 'Internal reasoning'), false);
});
