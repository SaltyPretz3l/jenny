'use strict';

// Linked-child terminal reports end to end (row 59 checkpoint 5b-1, slice B2): a real managed
// chat turn on a child chat (fake sidecar client, real session store, real terminal coordinator,
// real mail stores and messaging service) reserves its report before inference, settles, converts
// the reservation into ONE pending outbox report with the deterministic id and delivers it to the
// parent's inbox. Restarts, replays, refusals and the exclusions are covered at the same seams.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const { admitTurnContextRows } = require('../services/backend/managed-sidecar-chat-helpers');
const { TerminalCoordinator } = require('../services/backend/chat-stream-terminal-coordinator');
const { TerminalRepairStore } = require('../services/backend/terminal-repair-store');
const { ensureSessionTurnActorRegistry } = require('../services/backend/session-turn-actor');
const { createSessionMailStore } = require('../services/backend/session-mail-store');
const { createChatProposalStore } = require('../services/backend/chat-proposal-store');
const { reportMessageId, reportOperationId } = require('../services/backend/session-report-records');
const { createChatMessagingService } = require('../services/chat-messaging-wiring');
const {
  beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization,
} = require('../services/session-runtime/inference-protocol');
const { initializeSessionExecutionAuthority } = require('../services/projects/application-execution-composition');
const { initializeApplicationProjects } = require('../services/projects/application-project-scope');
const { ToolPermissionStore } = require('../services/tools/tool-permission-store');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');
const F = require('./helpers/session-mail-fixtures');
const { makeGit } = require('./helpers/chat-proposal-records-fixture');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const PREFERENCES = {
  preferred_model: 'mock-v1', reasoning_effort: 'default', conversation_mode: 'chat', pending_question_batch: null,
  interactive_sequence_state: 'idle', interactive_round_count: 0, plan_mode: false,
};
const ACK = { schema_version: 1, producer_tools: [], context_kinds: ['session_message'], session_messages: true };
const ATTEMPT = '1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e';
const CHILD = 'sess_child';
const PARENT = 'sess_parent';

function createService(store, userDataPath) {
  const service = {
    activeStreams: new Map(),
    pendingToolApprovals: new Map(),
    currentModel: 'mock-v1',
    currentStatus: { effective_context_length: 32768 },
    personalityWorkspace: null,
    attachmentAssetStore: null,
    sidecarClient: null,
    sessionStore: store,
    featureFlags: {},
    events: [],
    logs: [],
    emit(name, payload) { this.events.push({ name, payload }); },
    _emitServiceLog(level, event, details) { this.logs.push({ level, event, details }); },
    async _resolveModel() { return 'mock-v1'; },
    async recallApprovedMemories() { return { memories: [] }; },
    async setSessionPreferences(sessionId, preferences) { store.setSessionPreferences(sessionId, preferences); },
    async renameSession(sessionId, title) { store.renameSession(sessionId, title); },
    async _restartManagedSidecar() {},
  };
  service.toolPermissionStore = new ToolPermissionStore(path.join(userDataPath, 'tool-permissions.json'));
  initializeApplicationProjects(service, { userDataPath });
  initializeSessionExecutionAuthority(service);
  service.sessionTurnActors = ensureSessionTurnActorRegistry(service);
  service.conversationStore = store.conversationStore;
  service.terminalCoordinator = new TerminalCoordinator({
    actorRegistry: service.sessionTurnActors,
    repairStore: new TerminalRepairStore(path.join(userDataPath, 'terminal-repairs.json')),
    emitTerminal(payload) { service.emit('chat-stream', payload); return true; },
  });
  return service;
}

// The default scripted turn: one token and chat.done. `script` replaces it.
function attachClient(service, script) {
  const sent = [];
  const client = {
    process: { pid: 4242 },
    chatSend: async (params, options = {}) => {
      sent.push({ params, options });
      const note = (method, extra = {}) => options.onNotification({ method, params: { request_id: params.request_id, session_id: params.session_id, ...extra } });
      if (script) await script({ params, options, note });
      else {
        note('chat.token', { delta: 'All done.', role: 'assistant' });
        note('chat.done');
      }
      return { status: 'completed' };
    },
  };
  const token = beginRuntimeInferenceInitialization(client);
  completeRuntimeInferenceInitialization(client, token, {
    runtime_inference_admission_version: 1, chat_workspace_version: 1, chat_workspace_capabilities: ACK,
  });
  service.sidecarClient = client;
  return sent;
}

function setup(t, { script, reporting = true, parent = 'present' } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-linked-report-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  t.after(() => store.dispose());
  const preferences = { session_start_date: '2026-10-15' };
  const parentRecord = store.createSessionWithId(PARENT, { title: 'Parent chat', preferences });
  const parentIncarnation = store.getSession(PARENT).session_incarnation;
  store.createSessionWithId(CHILD, {
    title: 'Child chat',
    preferences,
    spawnedFrom: F.makeSpawnedFrom({ parent_session_id: PARENT, parent_session_incarnation: parentIncarnation }),
  });
  assert.ok(parentRecord);
  const mailStore = createSessionMailStore(store);
  assert.ok(mailStore.mutate(CHILD, ({ mail }) => ({ mail: { ...mail, reporting_enabled: reporting } })).ok);
  const service = createService(store, userDataPath);
  const sent = attachClient(service, script);
  service.chatMessages = createChatMessagingService({
    backendService: { sessionStore: store }, scheduleReconcile: false, serviceOptions: { notifierOptions: { intervalMs: 0 } },
  });
  t.after(() => service.chatMessages.dispose());
  if (parent === 'archived') store.setSessionMeta(PARENT, { archived_at: new Date().toISOString() });
  if (parent === 'missing') store.deleteSession(PARENT);
  const run = async (overrides = {}) => {
    const stream = await startManagedSidecarChatStream(service, {
      sessionId: CHILD, prompt: 'Fix the export', visiblePrompt: 'Fix the export', attachments: [],
      runtimePreferredModel: 'mock-v1', normalizedInteractiveResponse: null, normalizedPreferences: { ...PREFERENCES }, ...overrides,
    });
    await service.activeStreams.get(stream.streamId)._pendingPromise;
    // The conversion runs outside the terminal critical path (a deferred task).
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    return stream;
  };
  return {
    store, service, sent, run, mailStore, parentIncarnation,
    child: () => mailStore.read(CHILD).mail,
    parentMail: () => mailStore.read(PARENT).mail,
    childRows: () => store.getSession(CHILD).messages,
  };
}

const reportIdOf = (env, stream) => reportMessageId(CHILD, env.store.getSession(CHILD).session_incarnation, stream.streamId);

// ---------- completed ----------

test('a completed child turn reserves, converts to ONE deterministic report and delivers it to the parent inbox', async (t) => {
  const reservedAtSend = [];
  const env = setup(t, { script: async ({ note }) => {
    reservedAtSend.push(env.child().report_reservations.length);
    note('chat.token', { delta: 'All done. The export is fixed.', role: 'assistant' });
    note('chat.done');
  } });
  const stream = await env.run();
  assert.deepEqual(reservedAtSend, [1], 'the slot is reserved before inference starts');
  const id = reportIdOf(env, stream);
  const mail = env.child();
  assert.equal(mail.report_reservations.length, 0, 'the reservation is consumed');
  assert.equal(mail.outbox.length, 1);
  const [record] = mail.outbox;
  assert.equal(record.envelope.message_id, id);
  assert.equal(record.operation_id, reportOperationId(id));
  assert.equal(record.envelope.kind, 'terminal_report');
  assert.equal(record.envelope.source_turn_id, stream.streamId);
  assert.equal(record.envelope.report.outcome, 'completed');
  assert.equal(record.envelope.body, 'All done. The export is fixed.');
  assert.equal(record.authorization_id, null);
  assert.equal(record.state, 'delivered');
  const inbox = env.parentMail().inbox;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].envelope.message_id, id);
  assert.equal(inbox[0].envelope.destination_session_incarnation, env.parentIncarnation);
  const assistant = env.childRows().filter((row) => row.role === 'assistant');
  assert.equal(assistant.at(-1).terminal_report_message_id, id, 'the marker rides the terminal assistant row');
  assert.ok(env.service.logs.every((log) => !JSON.stringify(log.details || {}).includes('export is fixed')), 'bodies are never logged');
});

test('a replayed settle and a second convert still leave exactly one report', async (t) => {
  const env = setup(t);
  const stream = await env.run();
  assert.equal(env.child().outbox.length, 1);
  const again = await env.service.chatMessages.convertReport({
    sessionId: CHILD, turnId: stream.streamId, outcome: 'completed', body: 'All done.', clipped: false, errorCode: null,
  });
  assert.equal(again.ok, true);
  assert.equal(again.converted, false, 'no reservation left: nothing converted');
  assert.equal(env.child().outbox.length, 1);
  assert.equal(env.parentMail().inbox.length, 1);
});

// ---------- failed ----------

test('a failed child turn reports failed with the visible partial answer', async (t) => {
  const env = setup(t, { script: async ({ note }) => {
    note('chat.token', { delta: 'I started to look at the export but', role: 'assistant' });
    throw Object.assign(new Error('The engine fell over.'), { code: 'CMP-ENGINE-0001', retryable: false });
  } });
  const stream = await env.run();
  const [record] = env.child().outbox;
  assert.equal(record.envelope.message_id, reportIdOf(env, stream));
  assert.equal(record.envelope.report.outcome, 'failed');
  assert.match(record.envelope.body, /I started to look at the export but/);
  assert.equal(record.envelope.report.error_code, 'CMP-ENGINE-0001');
  assert.equal(env.child().report_reservations.length, 0);
  assert.equal(env.parentMail().inbox.length, 1);
});

test('a failed turn with no answer reports the synthesized line', async (t) => {
  const env = setup(t, { script: async () => { throw Object.assign(new Error('Nope.'), { retryable: false }); } });
  await env.run();
  const [record] = env.child().outbox;
  assert.equal(record.envelope.report.outcome, 'failed');
  assert.equal(record.envelope.body, 'The turn failed before it produced an answer.');
  assert.equal(record.envelope.report.error_code, null);
});

// ---------- awaiting a decision ----------

test('awaiting_proposal reports awaiting_decision with the proposal title', async (t) => {
  const proposal = makeGit(1, { summary: 'Commit the billing export' });
  let env;
  env = setup(t, { script: async ({ note }) => {
    note('chat.token', { delta: 'Here is my offer.', role: 'assistant' });
    note('chat.done', { completion_reason: 'awaiting_proposal', proposal_id: proposal.proposal_id });
  } });
  assert.ok(createChatProposalStore(env.store).mutate(CHILD, ({ records }) => ({ records: [...records, proposal] })).ok);
  await env.run();
  const [record] = env.child().outbox;
  assert.equal(record.envelope.report.outcome, 'awaiting_decision');
  assert.equal(record.envelope.body, 'Waiting for a decision: Commit the billing export');
  assert.equal(env.parentMail().inbox.length, 1);
});

test('awaiting_proposal with no readable proposal falls back to the plain waiting line', async (t) => {
  const env = setup(t, { script: async ({ note }) => {
    note('chat.token', { delta: 'Offer.', role: 'assistant' });
    note('chat.done', { completion_reason: 'awaiting_proposal', proposal_id: `proposal_${'ef56'.repeat(16)}` });
  } });
  await env.run();
  assert.equal(env.child().outbox[0].envelope.body, 'Waiting for a decision.');
});

// ---------- exclusions ----------

test('an unlinked chat is a byte-for-byte no-op: no mail write, no report', async (t) => {
  const env = setup(t);
  env.store.createSessionWithId('sess_plain', { title: 'Plain', preferences: { session_start_date: '2026-10-15' } });
  const before = JSON.stringify(env.store.getSession('sess_plain').session_mail);
  const revision = env.store.getSession('sess_plain').coordination_revision;
  const stream = await startManagedSidecarChatStream(env.service, {
    sessionId: 'sess_plain', prompt: 'Hi', visiblePrompt: 'Hi', attachments: [], runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null, normalizedPreferences: { ...PREFERENCES },
  });
  await env.service.activeStreams.get(stream.streamId)._pendingPromise;
  const after = env.store.getSession('sess_plain');
  assert.equal(JSON.stringify(after.session_mail), before);
  assert.equal(after.coordination_revision, revision);
  assert.equal(after.messages.some((row) => 'terminal_report_message_id' in row), false);
});

test('a linked child with reporting off writes no mail either', async (t) => {
  const env = setup(t, { reporting: false });
  const before = JSON.stringify(env.store.getSession(CHILD).session_mail);
  await env.run();
  assert.equal(JSON.stringify(env.store.getSession(CHILD).session_mail), before);
  assert.equal(env.parentMail().inbox.length, 0);
});

test('a handoff preparation turn never reserves and never reports', async (t) => {
  const reserved = [];
  const env = setup(t, { script: async ({ note }) => {
    reserved.push(env.child().report_reservations.length);
    note('chat.token', { delta: 'Prepared.', role: 'assistant' });
    note('chat.done');
  } });
  await env.run({ sessionHandoffPreparation: { proposal_id: `proposal_${'cd34'.repeat(16)}`, attempt_id: ATTEMPT } });
  assert.deepEqual(reserved, [0]);
  assert.equal(env.child().outbox.length, 0);
  assert.equal(env.parentMail().inbox.length, 0);
});

test('a checkpoint resume reuses its turn id and reserves no second slot (the new turn reserved exactly once)', async (t) => {
  const env = setup(t);
  const identity = { turnId: 'turn_resume_1' };
  const admit = (extra = {}) => admitTurnContextRows(env.service, {
    sessionId: CHILD, turnId: identity.turnId, userMessageId: 'user_x', preparedMessages: [], lease: null,
    previousKinds: { sessionMessages: true, sessionHandoff: false }, brandNew: true, ...extra,
  });
  admit();
  assert.equal(env.child().report_reservations.length, 1);
  admit({ resumed: true, brandNew: false });
  assert.equal(env.child().report_reservations.length, 1, 'idempotent by turn id');
  const second = { turnId: 'turn_resume_2' };
  identity.turnId = second.turnId;
  admit({ resumed: true, brandNew: false });
  assert.equal(env.child().report_reservations.length, 1, 'a resume never reserves');
  admit();
  assert.equal(env.child().report_reservations.length, 2, 'a new turn identity does');
});

// ---------- refusal and disabling ----------

test('a full outbox refuses the turn before inference: visible failed turn, prompt kept, nothing reserved', async (t) => {
  const env = setup(t);
  const filler = Array.from({ length: 128 }, (_, i) => F.makeOutbox(i + 1));
  assert.ok(env.mailStore.mutate(CHILD, ({ mail }) => ({ mail: { ...mail, outbox: filler } })).ok);
  await env.run();
  assert.equal(env.sent.length, 0, 'inference never started');
  assert.equal(env.child().report_reservations.length, 0);
  assert.equal(env.child().outbox.length, 128, 'the failed turn converts nothing');
  const failure = env.service.events.map((e) => e.payload).find((p) => p?.type === 'error');
  assert.ok(failure, 'the failure is visible');
  assert.equal(failure.error_code || failure.code, 'CMP-MESSAGE-0008');
  assert.equal(failure.retryable, false);
  const rows = env.childRows();
  assert.ok(rows.some((row) => row.role === 'user' && row.content === 'Fix the export'), 'the prompt is kept');
  assert.equal(rows.some((row) => 'terminal_report_message_id' in row), false);
  assert.equal(env.parentMail().inbox.length, 0);
});

test('a deleted parent disables reporting and the turn proceeds', async (t) => {
  const env = setup(t, { parent: 'missing' });
  await env.run();
  assert.equal(env.sent.length, 1, 'the turn ran');
  const mail = env.child();
  assert.equal(mail.reporting_enabled, false);
  assert.equal(mail.report_reservations.length, 0);
  assert.equal(mail.outbox.length, 0);
});

test('an archived parent still gets a reservation; delivery fails visibly with recipient_archived and Retry works after restore', async (t) => {
  const env = setup(t, { parent: 'archived' });
  const stream = await env.run();
  const [record] = env.child().outbox;
  assert.equal(record.envelope.message_id, reportIdOf(env, stream));
  assert.equal(record.state, 'failed');
  assert.equal(record.last_error.reason, 'recipient_archived');
  assert.equal(record.last_error.retryable, true);
  assert.equal(env.parentMail().inbox.length, 0);
  env.store.setSessionMeta(PARENT, { archived_at: null });
  const retried = await env.service.chatMessages.retry({ schema_version: 1, operation_id: record.operation_id });
  assert.equal(retried.ok, true);
  assert.equal(env.child().outbox[0].state, 'delivered');
  assert.equal(env.parentMail().inbox.length, 1);
});

// ---------- restart repair ----------

function strandReservation(env, turnId) {
  const reservation = F.makeReservation(1, {
    turn_id: turnId, parent_session_id: PARENT, parent_session_incarnation: env.parentIncarnation,
  });
  assert.ok(env.mailStore.mutate(CHILD, ({ mail }) => ({ mail: { ...mail, report_reservations: [reservation] } })).ok);
  return reservation;
}

test('restart with a reservation and a marker converts it once from the terminal row', async (t) => {
  const env = setup(t);
  const turnId = 'turn_orphan_1';
  strandReservation(env, turnId);
  const id = reportMessageId(CHILD, env.store.getSession(CHILD).session_incarnation, turnId);
  env.store.appendMessage(CHILD, { id: 'user_orphan', role: 'user', content: 'Q', turn_id: turnId });
  env.store.appendMessage(CHILD, {
    id: 'assistant_orphan', role: 'assistant', content: 'The finished answer.', parent_stream_id: turnId, terminal_report_message_id: id,
  });
  env.service.chatMessages.reconcileOnStartup();
  env.service.chatMessages.reconcileOnStartup(); // a second restart changes nothing
  const outbox = env.child().outbox;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].envelope.message_id, id);
  assert.equal(outbox[0].envelope.report.outcome, 'completed');
  assert.equal(outbox[0].envelope.body, 'The finished answer.');
  assert.equal(outbox[0].state, 'delivered');
  assert.equal(env.child().report_reservations.length, 0);
  assert.equal(env.parentMail().inbox.length, 1);
});

test('restart with an active_turn reservation reports an interrupted failure; a turn that never started is released', async (t) => {
  const env = setup(t);
  strandReservation(env, 'turn_dead_1');
  env.store.appendMessage(CHILD, { id: 'user_dead', role: 'user', content: 'Q', turn_id: 'turn_dead_1' });
  env.service.chatMessages.reconcileOnStartup();
  const [record] = env.child().outbox;
  assert.equal(record.envelope.report.outcome, 'failed');
  assert.equal(record.envelope.body, 'The turn was interrupted before it could finish.');
  assert.equal(env.parentMail().inbox.length, 1);
  // A reservation whose turn left no trace at all is released, with no report.
  const never = F.makeReservation(2, { turn_id: 'turn_never', parent_session_id: PARENT, parent_session_incarnation: env.parentIncarnation });
  assert.ok(env.mailStore.mutate(CHILD, ({ mail }) => ({ mail: { ...mail, report_reservations: [never] } })).ok);
  env.service.chatMessages.reconcileOnStartup();
  assert.equal(env.child().report_reservations.length, 0);
  assert.equal(env.child().outbox.length, 1);
});
