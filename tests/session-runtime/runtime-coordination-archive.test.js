'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { RuntimeContinuationCoordinator } = require('../../services/backend/runtime-continuation-coordinator');
const { fingerprintRuntimeHistory, stableJson } = require('../../services/backend/runtime-continuation-records');
const { createArchive } = require('../../services/data-lifecycle/archive-service');
const { collectDataInventory } = require('../../services/data-lifecycle/data-inventory');
const { createOfflineRuntimeArchivePort } = require('../../services/data-lifecycle/runtime-coordination-archive');
const { collectRuntimeArchiveEntries } = require('../../services/data-lifecycle/runtime-archive');
const { promotePendingRestore, stageRestore } = require('../../services/data-lifecycle/restore-service');
const { RootRunBudgetStore } = require('../../services/session-runtime/budgets');
const { CheckpointStore } = require('../../services/session-runtime/checkpoint-store');
const { buildAdmittedContinuationContext } = require('../../services/session-runtime/continuation-context');
const { captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { SessionRuntimeService } = require('../../services/session-runtime/service');
const { RuntimeStore } = require('../../services/session-runtime/store');

const ATTEMPT = Object.freeze({ attempt_id: 'attempt_coord', stream_id: 'stream_coord',
  incarnation: 'incarnation_coord', authority_revision: 'authority_coord' });
const AUTHORITY = Object.freeze({ project_id: 'general', root_path: null, root_id: null,
  root_revision: 0, device_id: null, inode: null });

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-coordination-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function digest(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function toolCall() {
  return { call_id: 'call_coord', tool_id: 'read_file', arguments: { path: 'alpha.txt' },
    idempotency_key: '', coerced: false, malformed_arguments: false, argument_repairs: [] };
}

function frozenInput() {
  const effective = { path: 'alpha.txt', _jenny_session_id: 'sess_coord',
    _jenny_turn_id: 'turn_coord', _jenny_tool_call_id: 'call_coord' };
  return { call_id: 'call_coord', tool_name: 'read_file', visible_tool_arguments: { path: 'alpha.txt' },
    effective_tool_arguments: effective,
    injected_arg_keys: ['_jenny_session_id', '_jenny_tool_call_id', '_jenny_turn_id'],
    effective_args_fingerprint: digest(effective), execution_context_payload: {
      session_id: 'sess_coord', logical_turn_id: 'turn_coord', authority_revision: 'authority_coord',
      project_id: 'general', root_id: null, root_revision: 0,
    } };
}

function exactBytes(value) {
  return Buffer.from(stableJson(value), 'utf8').toString('base64');
}

function proposal() {
  const frozen = frozenInput();
  const batch = { calls: [toolCall()] };
  const frozenBytes = exactBytes(frozen);
  const batchBytes = exactBytes(batch);
  return { checkpoint_id: 'checkpoint_coord', source_attempt: ATTEMPT,
    stream_id: ATTEMPT.stream_id, through_seq: 0, tool_calls: batch.calls,
    frozen_input: frozen, frozen_input_bytes: frozenBytes,
    frozen_input_sha256: crypto.createHash('sha256').update(Buffer.from(frozenBytes, 'base64')).digest('hex'),
    tool_batch_bytes: batchBytes,
    tool_batch_sha256: crypto.createHash('sha256').update(Buffer.from(batchBytes, 'base64')).digest('hex'),
    history_selector: { schema_version: 1, history_scope: 'session',
      canonical_cutoff: { boundary_message_id: null, boundary_message_count: 0,
        sha256: fingerprintRuntimeHistory([]) }, compaction_ref: null } };
}

function createPausedContinuation(profile, approvalBundle = false) {
  const sessions = new ElectronSessionStore(path.join(profile, 'sessions.json'));
  sessions.createSessionWithId('sess_coord', { title: 'Portable continuation' });
  const incarnation = sessions.getSession('sess_coord').session_incarnation;
  sessions.updateSession('sess_coord', { turn_generation: 1 });
  sessions.setActiveTurn('sess_coord', { request_id: 'stream_coord', stream_id: 'stream_coord',
    turn_id: 'turn_coord', session_incarnation: incarnation, generation: 1, user_message_id: 'user_coord',
    started_at: '2026-09-10T12:00:00.000Z', last_event_at: '2026-09-10T12:00:01.000Z', status: 'streaming' });
  sessions.appendMessage('sess_coord', { id: 'user_coord', turn_id: 'turn_coord', role: 'user',
    kind: 'message', content: 'Inspect alpha.', timestamp: '2026-09-10T12:00:00.000Z' });
  const runtimeStore = new RuntimeStore(path.join(profile, 'session-runtime'));
  const route = captureRuntimeRoute({ engine_type: 'chatgpt', provider_id: 'chatgpt',
    configuration_revision: 'config:1', resource_class: 'cloud', requires_gpu: false });
  const submitted = runtimeStore.submit({ idempotencyKey: 'submit_coord', projectId: 'general',
    sessionId: 'sess_coord', purpose: 'chat', input: { route }, authority: AUTHORITY,
    workId: 'work_coord', turnId: 'turn_coord' }).record;
  const running = runtimeStore.transition(submitted.work_id, { expectedRevision: submitted.revision,
    to: 'running', reason: 'Started.', transitionId: 'transition_coord', attempt: ATTEMPT }).record;
  const conversationStore = sessions.conversationStore;
  const checkpointStore = new CheckpointStore(path.join(profile, 'session-runtime-checkpoints'), {
    validateCanonical: (continuation, work) => conversationStore.resolvePendingContinuation(continuation, work),
  });
  const context = buildAdmittedContinuationContext({ work: running, route, attempt: ATTEMPT,
    executionContext: { ...AUTHORITY, authority_revision: ATTEMPT.authority_revision } });
  const coordinator = new RuntimeContinuationCoordinator({ conversationStore, checkpointStore, context,
    getCurrentWork: () => runtimeStore.get('work_coord'), assertCurrent: () => true,
    validateDecision: approvalBundle ? () => ({ valid: true }) : null });
  const captured = proposal();
  const decision = { kind: 'approval', call_id: 'call_coord', decision_id: 'decision_coord', execution_started: false };
  if (approvalBundle) {
    const later = { ...toolCall(), call_id: 'call_later', arguments: { path: 'beta.txt' } };
    captured.tool_calls.push(later);
    captured.tool_batch_bytes = exactBytes({ calls: captured.tool_calls });
    captured.tool_batch_sha256 = digest({ calls: captured.tool_calls });
    const frozen = { ...frozenInput(), call_id: later.call_id, visible_tool_arguments: later.arguments,
      effective_tool_arguments: later.arguments, injected_arg_keys: [], effective_args_fingerprint: digest(later.arguments) };
    const inputs = [captured.frozen_input_bytes, exactBytes(frozen)].map(bytes => ({ frozen_input_bytes: bytes,
      frozen_input_sha256: crypto.createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex') }));
    captured.approval_inputs_bytes = exactBytes({ schema_version: 1, inputs });
    captured.approval_inputs_sha256 = digest({ schema_version: 1, inputs });
    captured.decision = decision;
  }
  const checkpointRef = coordinator.publish({ proposal: captured,
    ...(approvalBundle ? { decisionProgress: { decision, completed_effect_refs: [], prior_effect_count: 0, prior_checkpoint_ref: null } } : {}),
    position: { completed_iterations: 1, remaining_iterations: 2, current_iteration: 1,
      tool_call_limit: 8, tool_calls_consumed: captured.tool_calls.length, active_budget_ms_remaining: 5000,
      ordered_call_ids: captured.tool_calls.map(call => call.call_id) },
    wait: { kind: approvalBundle ? 'explicit_pause' : 'resource', resource_class: approvalBundle ? null : 'tool_operations', dependency_id: null,
      operation_id: 'call_coord' },
    eligibility: { pending_call_index: 0, prior_outcome_count: 0,
      emitted_tool_execution_count: 0, preview_count: 0, approval_pending: false,
      mutation_started: false } });
  runtimeStore.transition('work_coord', { expectedRevision: running.revision, to: 'paused',
    reason: 'Resource wait.', transitionId: 'transition_paused', expectedAttempt: ATTEMPT,
    checkpointRef });
  const budgetStore = new RootRunBudgetStore(path.join(profile, 'session-runtime-budgets'), {
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  });
  budgetStore.create({ rootRunId: 'root_run_coord', authorityFingerprint: 'b'.repeat(64),
    allowedProviderIds: ['chatgpt'], limits: {
      inference_requests: 10, input_tokens: 10_000, output_tokens: 10_000,
    } });
  budgetStore.reserve({ rootRunId: 'root_run_coord', workId: 'work_coord',
    attemptId: ATTEMPT.attempt_id, operationId: 'inference:coord', providerId: 'chatgpt',
    maxima: { inference_requests: 1, input_tokens: 100, output_tokens: 100 } });
  const lanes = { snapshot: () => ({ active_leases: 0, quarantined: 0 }) };
  const resourceBroker = { snapshot: () => ({ lease_count: 0, waiter_count: 0, quarantined_count: 0 }) };
  const runtime = new SessionRuntimeService({ store: runtimeStore,
    scheduler: { lanes, hasPendingOrAdmittedWork: () => true },
    chatAdapter: { prepareImmediate() {} }, resourceBroker, checkpointStore, budgetStore, conversationStore });
  sessions.flush();
  return { sessions, runtime, runtimeStore };
}

for (const approvalBundle of [false, true]) test(`portable archive restores paused coordination evidence (approval bundle=${approvalBundle})`, async (t) => {
  const root = tempRoot(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(source);
  fs.mkdirSync(destination);
  const { sessions, runtime } = createPausedContinuation(source, approvalBundle);
  const originalEntries = structuredClone(sessions.getSession('sess_coord').runtime_continuations);
  const inventory = collectDataInventory({ userDataPath: source, sessionStore: sessions,
    runtimeArchivePort: runtime });
  const coordination = inventory.entries.find(entry => entry.logicalPath === 'runtime/runtime-coordination.json');
  assert.equal(coordination.category, 'runtime_coordination');
  const archive = await createArchive({ destinationRoot: path.join(root, 'archives'),
    archiveName: 'Coordination.jenny-archive', encrypted: false, entries: inventory.entries });

  await stageRestore({ archivePath: archive.archivePath, userDataPath: destination });
  assert.equal((await promotePendingRestore({ userDataPath: destination })).status, 'promoted');
  const restoredSessions = new ElectronSessionStore(path.join(destination, 'sessions.json'));
  const restoredRuntime = new RuntimeStore(path.join(destination, 'session-runtime'));
  const restoredWork = restoredRuntime.get('work_coord');
  const restoredBudgets = new RootRunBudgetStore(path.join(destination, 'session-runtime-budgets'));
  const restoredCheckpoints = new CheckpointStore(path.join(destination, 'session-runtime-checkpoints'), {
    validateCanonical: (continuation, work) => (
      restoredSessions.conversationStore.resolvePendingContinuation(continuation, work)
    ),
  });

  assert.equal(restoredWork.status, 'paused');
  assert.equal(restoredWork.authority.root_revision, 1);
  assert.equal(restoredBudgets.inspect('root_run_coord').unresolved_reservation_count, 1);
  assert.deepEqual(restoredSessions.getSession('sess_coord').runtime_continuations, originalEntries);
  assert.equal(restoredCheckpoints.validate(restoredWork, restoredWork.checkpoint_ref), false);
  assert.equal(restoredRuntime.listReadyCandidates().length, 0);
  const rearchive = collectDataInventory({ userDataPath: destination, sessionStore: restoredSessions,
    runtimeArchivePort: createOfflineRuntimeArchivePort({ userDataPath: destination,
      sessionStore: restoredSessions }) });
  assert.equal(rearchive.entries.some(entry => (
    entry.logicalPath === 'runtime/runtime-coordination.json'
  )), true, 'inert source evidence survives archive, restore and archive again');
  sessions.dispose();
  restoredSessions.dispose();
});

test('completed resumed work archives its retained source-attempt checkpoint evidence', (t) => {
  const profile = path.join(tempRoot(t), 'source');
  fs.mkdirSync(profile);
  const { sessions, runtime, runtimeStore } = createPausedContinuation(profile);
  const paused = runtimeStore.get('work_coord');
  const attemptB = { ...ATTEMPT, attempt_id: 'attempt_coord_b', stream_id: 'stream_coord_b',
    authority_revision: 'authority_coord_b' };
  const resumed = runtimeStore.transition(paused.work_id, { expectedRevision: paused.revision,
    to: 'running', reason: 'Resumed.', transitionId: 'transition_resumed_b',
    attempt: attemptB }).record;
  sessions.appendMessage('sess_coord', { id: 'assistant_stream_coord_b', turn_id: 'turn_coord',
    role: 'assistant', kind: 'message', content: 'Completed after resume.',
    parent_stream_id: attemptB.stream_id, timestamp: '2026-09-10T12:02:00.000Z' });
  sessions.appendTurnEvents('sess_coord', [
    { event_id: `${attemptB.stream_id}:canonical:1`, turn_id: 'turn_coord',
      kind: 'reasoning_phase', status: 'completed', primary_message_id: 'assistant_stream_coord_b',
      source_message_ids: ['assistant_stream_coord_b'], tool_call_id: '',
      payload: { canonical_seq: 1, canonical_event_type: 'reasoning_completed' } },
    { event_id: `${attemptB.stream_id}:canonical:2`, turn_id: 'turn_coord',
      kind: 'assistant_text_segment', status: 'completed', primary_message_id: 'assistant_stream_coord_b',
      source_message_ids: ['assistant_stream_coord_b'], tool_call_id: '', payload: { canonical_seq: 2,
        canonical_event_type: 'assistant_text_completed', canonical_part_id: 'part_resumed_b',
        text: 'Completed after resume.' } },
  ], { durable: true });
  runtimeStore.transition(resumed.work_id, { expectedRevision: resumed.revision,
    to: 'completed', reason: 'Completed.', transitionId: 'transition_completed_b',
    expectedAttempt: attemptB });

  const captured = runtime.capturePortableState();
  assert.equal(captured.checkpoints.records.length, 1);
  assert.equal(captured.canonical_sessions.sessions[0]
    .runtime_continuations.entries[0].body.source_attempt.attempt_id, ATTEMPT.attempt_id);
  assert.equal(collectDataInventory({ userDataPath: profile, sessionStore: sessions,
    runtimeArchivePort: runtime }).entries.some(entry => (
    entry.logicalPath === 'runtime/runtime-coordination.json'
  )), true);
  sessions.dispose();
});

test('live capture allows queued evidence but rejects physical and quarantined resources', (t) => {
  const profile = path.join(tempRoot(t), 'source');
  fs.mkdirSync(profile);
  const { sessions, runtime } = createPausedContinuation(profile);
  assert.equal(runtime.capturePortableState().checkpoints.records.length, 1);
  runtime.lanes.snapshot = () => ({ active_leases: 1, quarantined: 1 });
  assert.throws(() => runtime.capturePortableState(), { code: 'runtime_archive_busy' });
  sessions.dispose();
});

test('offline uninstall capture reads durable owner records without recovery stores or silent omission', (t) => {
  const profile = path.join(tempRoot(t), 'source');
  fs.mkdirSync(profile);
  const { sessions } = createPausedContinuation(profile);
  const offline = createOfflineRuntimeArchivePort({ userDataPath: profile, sessionStore: sessions });

  const captured = offline.capturePortableState();
  assert.equal(captured.checkpoints.records.length, 1);
  assert.equal(captured.root_run_budgets.records.length, 1);
  assert.equal(captured.canonical_sessions.sessions.length, 1);
  assert.throws(() => collectRuntimeArchiveEntries(profile), {
    reason: 'runtime_coordination_port_required',
  });
  assert.equal(collectRuntimeArchiveEntries(profile, { runtimeArchivePort: offline })
    .some(entry => entry.logicalPath === 'runtime/runtime-coordination.json'), true);
  sessions.dispose();
});

test('restore rejects incomplete coordination crosslinks before creating destination state', async (t) => {
  const root = tempRoot(t);
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(source);
  const { sessions, runtime } = createPausedContinuation(source);
  const coordination = collectDataInventory({ userDataPath: source, sessionStore: sessions,
    runtimeArchivePort: runtime }).entries.find(entry => (
    entry.logicalPath === 'runtime/runtime-coordination.json'
  ));
  const archive = await createArchive({ destinationRoot: path.join(root, 'archives'),
    archiveName: 'Incomplete-coordination.jenny-archive', encrypted: false, entries: [coordination] });

  await stageRestore({ archivePath: archive.archivePath, userDataPath: destination });
  await assert.rejects(promotePendingRestore({ userDataPath: destination }), {
    reason: 'runtime_coordination_ledger_missing',
  });
  assert.equal(fs.existsSync(path.join(destination, 'session-runtime-checkpoints')), false);
  assert.equal(fs.existsSync(path.join(destination, 'session-runtime-budgets')), false);
  assert.equal(fs.existsSync(path.join(destination, 'sessions')), false);
  sessions.dispose();
});
