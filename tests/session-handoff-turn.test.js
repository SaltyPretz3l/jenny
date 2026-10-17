'use strict';

// The turn plumbing of a linked chat (row 59 checkpoint 5a-1, slice S3): the handoff-only preparation
// turn (chat.send field, one-tool restriction, trusted execution binding), the first turn's fail-closed
// handoff row, the internal request fields, and the chat.done turn-boundary completion chain.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const { prepareLocalEngineChatRequest } = require('../services/backend/local-engine-requests');
const { deriveManagedTurnHistory, managedToolPreferenceInput } = require('../services/backend/managed-sidecar-chat-helpers');
const { getTrustedExecutionBinding } = require('../services/backend/session-execution-authority');
const { createManagedChatStreamRuntime } = require('../services/backend/chat-stream-managed-runtime');
const { settleManagedAssistantCompletion } = require('../services/backend/chat-stream-managed-terminal-settlement');
const { normalizeCompletion } = require('../services/backend/chat-stream-stop-detail');
const { buildTerminalMessageExtras, completionEventFields, patchLastSegmentDiscardedDrafts } = require('../services/backend/chat-stream-discarded-drafts');
const H = require('../services/backend/session-handoff-context');
const { createSessionMailStore } = require('../services/backend/session-mail-store');
const {
  beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization,
} = require('../services/session-runtime/inference-protocol');
const { initializeSessionExecutionAuthority } = require('../services/projects/application-execution-composition');
const { initializeApplicationProjects } = require('../services/projects/application-project-scope');
const { ToolPermissionStore } = require('../services/tools/tool-permission-store');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');
const F = require('./helpers/session-mail-fixtures');
const { createAdapterHarness, request: adapterRequest } = require('./helpers/session-runtime-chat-adapter-harness');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const HEX = 'cd34'.repeat(16);
const PROPOSAL = `proposal_${HEX}`;
const ATTEMPT = '1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e';
const BODY = 'Background: fix the billing export. Key file: export.js';
const PREPARATION = { proposal_id: PROPOSAL, attempt_id: ATTEMPT };
const HANDOFF = () => H.buildSessionHandoff({
  proposalId: PROPOSAL, sourceSessionId: 'sess_src', sourceSessionIncarnation: 'inc_src', body: BODY,
});
const PREFERENCES = {
  preferred_model: 'mock-v1', reasoning_effort: 'default', conversation_mode: 'chat', pending_question_batch: null,
  interactive_sequence_state: 'idle', interactive_round_count: 0, plan_mode: false,
};
const BOTH = {
  schema_version: 1, producer_tools: ['propose_session', 'complete_session_handoff'],
  context_kinds: ['session_message', 'session_handoff'], session_messages: true,
};
const MAIL_ONLY = { schema_version: 1, producer_tools: [], context_kinds: ['session_message'], session_messages: true };

function createService(store, userDataPath, featureFlags = {}) {
  const service = {
    activeStreams: new Map(),
    pendingToolApprovals: new Map(),
    currentModel: 'mock-v1',
    currentStatus: { effective_context_length: 32768 },
    personalityWorkspace: null,
    attachmentAssetStore: null,
    sidecarClient: null,
    sessionStore: store,
    featureFlags,
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
  return service;
}

// A chat.send double that records the params, lets a test script the notifications, and completes the turn.
function attachClient(service, { ack, script }) {
  const sent = [];
  const client = {
    process: { pid: 4242 },
    chatSend: async (params, options = {}) => {
      sent.push({ params, options });
      if (script) await script(params, options);
      else {
        options.onNotification({ method: 'chat.token', params: { request_id: params.request_id, session_id: params.session_id, delta: 'ok', role: 'assistant' } });
        options.onNotification({ method: 'chat.done', params: { request_id: params.request_id, session_id: params.session_id } });
      }
      return { status: 'completed' };
    },
  };
  const token = beginRuntimeInferenceInitialization(client);
  completeRuntimeInferenceInitialization(client, token, {
    runtime_inference_admission_version: 1,
    ...(ack ? { chat_workspace_version: 1, chat_workspace_capabilities: ack } : {}),
  });
  service.sidecarClient = client;
  return sent;
}

function setup(t, { ack = BOTH, script, flags, lockdown = false, mail = 0 } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-handoff-turn-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  t.after(() => store.dispose());
  store.createSessionWithId('sess_child', { title: 'New Chat', preferences: { session_start_date: '2026-10-15' } });
  if (lockdown) store.updateSession('sess_child', { lockdown: true });
  const mailStore = createSessionMailStore(store);
  const records = Array.from({ length: mail }, (_, i) => F.makeInbox(i + 1));
  if (records.length) {
    assert.ok(mailStore.mutate('sess_child', ({ mail: current }) => ({
      mail: { ...current, inbox: records, next_receive_sequence: records.length + 1 },
    })).ok);
  }
  const service = createService(store, userDataPath, flags);
  const sent = attachClient(service, { ack, script });
  const run = async (overrides = {}) => {
    const stream = await startManagedSidecarChatStream(service, {
      sessionId: 'sess_child', prompt: 'Fix the export', visiblePrompt: 'Fix the export', attachments: [],
      runtimePreferredModel: 'mock-v1', normalizedInteractiveResponse: null, normalizedPreferences: { ...PREFERENCES }, ...overrides,
    });
    await service.activeStreams.get(stream.streamId)._pendingPromise;
    return stream;
  };
  const rowIds = () => store.getSession('sess_child').messages.map((m) => m.id);
  return { store, service, sent, run, rowIds };
}

// ---------- the request fields ----------

test('prepareLocalEngineChatRequest carries both internal fields, closed, and refuses malformed ones', async () => {
  const base = { sessionId: 'sess_x', prompt: 'p', preferredModel: 'm' };
  const service = { sessionStore: {} };
  const preparation = await prepareLocalEngineChatRequest(service, { ...base, sessionHandoffPreparation: PREPARATION });
  assert.deepEqual(preparation.sessionHandoffPreparation, PREPARATION);
  assert.equal('sessionHandoff' in preparation, false);
  const first = await prepareLocalEngineChatRequest(service, { ...base, sessionHandoff: HANDOFF() });
  assert.deepEqual(first.sessionHandoff, HANDOFF());
  assert.equal('sessionHandoffPreparation' in first, false);
  const plain = await prepareLocalEngineChatRequest(service, base);
  assert.equal('sessionHandoff' in plain || 'sessionHandoffPreparation' in plain, false);
  for (const bad of [
    { sessionHandoffPreparation: { ...PREPARATION, extra: 1 } }, { sessionHandoffPreparation: 'x' },
    { sessionHandoffPreparation: { proposal_id: PROPOSAL, attempt_id: 'nope' } },
    { sessionHandoff: { ...HANDOFF(), body: 'forged' } }, { sessionHandoff: {} }, { sessionHandoff: 'text' },
    { sessionHandoffPreparation: PREPARATION, sessionHandoff: HANDOFF() },
  ]) {
    await assert.rejects(prepareLocalEngineChatRequest(service, { ...base, ...bad }),
      (error) => error.code === 'session_handoff_invalid' && error.retryable === false, JSON.stringify(Object.keys(bad)));
  }
});

test('do_it_here is a decision choice that rides the durable continuation request', async () => {
  const decision = { proposal_id: PROPOSAL, decision_id: F.uuid(1), accepted_revision: 2, choice: 'do_it_here' };
  const request = await prepareLocalEngineChatRequest({ sessionStore: {} }, { sessionId: 's', prompt: 'p', proposalDecision: decision });
  assert.deepEqual(request.proposalDecision, decision);
  const unknown = await prepareLocalEngineChatRequest({ sessionStore: {} }, { sessionId: 's', prompt: 'p', proposalDecision: { ...decision, choice: 'new_session' } });
  assert.equal('proposalDecision' in unknown, false, 'only the three decision choices are admitted');
});

// ---------- the preparation turn ----------

test('a preparation turn sends handoff_preparation and exactly the one-tool restriction', async (t) => {
  const env = setup(t);
  await env.run({ sessionHandoffPreparation: PREPARATION });
  const { params } = env.sent[0];
  assert.deepEqual(params.handoff_preparation, PREPARATION);
  assert.deepEqual(params.tool_preferences, {
    enabled_tools: ['complete_session_handoff'], disabled_tools: [], disabled_tool_families: [],
  });
  assert.equal('session_handoff' in params, false);
});

test('an ordinary turn never carries handoff_preparation or the one-tool restriction', async (t) => {
  const env = setup(t);
  await env.run();
  const { params } = env.sent[0];
  assert.equal('handoff_preparation' in params, false);
  assert.equal(params.tool_preferences?.enabled_tools?.includes('complete_session_handoff') ?? false, false);
});

test('the preparation restriction ignores a requested tool preference and survives offline lockdown', async (t) => {
  const env = setup(t, { flags: { session_offline_lockdown: true }, lockdown: true });
  env.service.currentEngineType = 'ollama'; // the resolved engine must be local under lockdown
  await env.run({
    sessionHandoffPreparation: PREPARATION,
    runtimePreferredEngineType: 'ollama',
    toolPreferences: { disabled_tools: ['complete_session_handoff'], enabled_tools: ['read_file', 'run_command'] },
  });
  const { params } = env.sent[0];
  assert.deepEqual(params.tool_preferences.enabled_tools, ['complete_session_handoff']);
  assert.ok(params.tool_preferences.disabled_tools.length > 0, 'lockdown still denies every network-possible tool');
  assert.equal(params.tool_preferences.disabled_tools.includes('complete_session_handoff'), false);
  assert.equal(params.session_offline_lockdown, true);
});

test('managedToolPreferenceInput only replaces the preference input for a preparation turn', () => {
  assert.deepEqual(managedToolPreferenceInput({ disabled_tools: ['read_file'] }), { disabled_tools: ['read_file'] });
  assert.equal(managedToolPreferenceInput(undefined), undefined);
  assert.deepEqual(managedToolPreferenceInput({ disabled_tools: ['read_file'] }, { handoffPreparation: PREPARATION }),
    { enabled_tools: ['complete_session_handoff'], disabled_tools: [], disabled_tool_families: [] });
});

test('the live runtime operation check of a preparation turn refuses every resource operation', async (t) => {
  const outcomes = {};
  const env = setup(t, {
    script: async (params, options) => {
      const op = (name) => options.onRuntimeOperation({
        api_version: '2026-10-15', schema_version: 1, phase: 'check', request_id: params.request_id,
        session_id: params.session_id, authority_revision: params.execution_context.authority_revision,
        operation_id: `op_${name}`, tool_name: name, arguments: {},
      });
      outcomes[params.handoff_preparation ? 'prep' : 'plain'] = ['read_file', 'complete_session_handoff'].map((name) => op(name));
      options.onNotification({ method: 'chat.done', params: { request_id: params.request_id, session_id: params.session_id } });
    },
  });
  await env.run({ sessionHandoffPreparation: PREPARATION });
  for (const outcome of outcomes.prep) {
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.error.reason, 'handoff_preparation_only');
  }
  await env.run();
  assert.ok(outcomes.plain.every((outcome) => outcome.error?.reason !== 'handoff_preparation_only'), 'an ordinary turn is not restricted');
});

test('the runtime adapter captures the preparation into the trusted binding and keeps it in the durable input', async (t) => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  const prepared = await adapter.prepareImmediate(adapterRequest(sessionId, { sessionHandoffPreparation: PREPARATION }), {},
    { workId: 'work-prep', turnId: 'turn-prep' });
  t.after(() => adapter.discard(prepared));
  assert.deepEqual(prepared.trusted.handoffPreparation, { proposalId: PROPOSAL, attemptId: ATTEMPT });
  assert.deepEqual(prepared.input.request.sessionHandoffPreparation, PREPARATION);
  assert.deepEqual(getTrustedExecutionBinding(prepared.binding).handoffPreparation, { proposalId: PROPOSAL, attemptId: ATTEMPT });
  // An ordinary turn on the same adapter carries nothing.
  const plain = await adapter.prepareImmediate(adapterRequest(sessionId, {}), {}, { workId: 'work-plain', turnId: 'turn-plain' });
  t.after(() => adapter.discard(plain));
  assert.equal(plain.trusted.handoffPreparation, null);
  assert.equal('sessionHandoffPreparation' in plain.input.request, false);
  assert.ok(service.sessionExecutionAuthority);
});

// ---------- the first turn ----------

test('a first turn with a handoff inserts the row before the user anchor and sends it before the prompt', async (t) => {
  const env = setup(t);
  const stream = await env.run({ sessionHandoff: HANDOFF() });
  assert.deepEqual(env.rowIds().slice(0, 2), [`ctxh_${HEX}`, `user_${stream.streamId}`]);
  const stored = env.store.getSession('sess_child').messages[0];
  assert.equal(stored.role, 'context');
  assert.equal(stored.kind, 'session_handoff');
  assert.equal(stored.content, BODY);
  assert.equal(stored.turn_id, stream.streamId);
  assert.equal(env.store.getSession('sess_child').messages[1].turn_id, stream.streamId);
  const wire = env.sent[0].params.messages;
  assert.deepEqual(wire.map((m) => m.role), ['context', 'user']);
  assert.deepEqual(wire[0], { role: 'context', kind: 'session_handoff', content: BODY, session_handoff: HANDOFF() });
  assert.equal(wire[1].content, 'Fix the export');
  assert.equal('handoff_preparation' in env.sent[0].params, false);
  assert.ok(env.service.logs.every((log) => !String(log.event).startsWith('chat.session_handoff')), 'no admission warnings');
  assert.ok(env.service.logs.every((log) => !JSON.stringify(log.details || {}).includes(BODY)), 'the Background is never logged');
});

test('the handoff row precedes queued session mail and both ride the wire in order', async (t) => {
  const env = setup(t, { mail: 1 });
  const stream = await env.run({ sessionHandoff: HANDOFF() });
  assert.deepEqual(env.rowIds().slice(0, 3), [`ctxh_${HEX}`, `ctx_${F.uuid(1)}`, `user_${stream.streamId}`]);
  assert.deepEqual(env.sent[0].params.messages.map((m) => m.kind || m.role), ['session_handoff', 'session_message', 'user']);
});

test('without a handoff the turn is ordinary: no row, no extra wire message (an empty Background sends no row)', async (t) => {
  const env = setup(t);
  await env.run();
  assert.deepEqual(env.sent[0].params.messages.map((m) => m.role), ['user']);
  assert.ok(env.rowIds().every((id) => !id.startsWith('ctxh_')));
});

test('not negotiated: the first turn fails with a coded error and chat.send is never called', async (t) => {
  const env = setup(t, { ack: MAIL_ONLY });
  await env.run({ sessionHandoff: HANDOFF() });
  assert.equal(env.sent.length, 0, 'the turn never runs without its Background');
  assert.ok(env.rowIds().every((id) => !id.startsWith('ctxh_')));
  const failure = env.service.events.map((e) => e.payload).find((p) => p?.type === 'error');
  assert.ok(failure, 'the failure is visible');
  assert.equal(failure.error_code || failure.code, 'session_handoff_not_negotiated');
  assert.equal(failure.retryable, false);
  const assistant = env.store.getSession('sess_child').messages.filter((m) => m.role === 'assistant');
  assert.equal(assistant.every((m) => m.status !== 'completed'), true);
});

test('a sidecar that acknowledged nothing also fails the first turn closed', async (t) => {
  const env = setup(t, { ack: null });
  await env.run({ sessionHandoff: HANDOFF() });
  assert.equal(env.sent.length, 0);
  assert.equal(env.service.events.map((e) => e.payload).some((p) => p?.type === 'error'), true);
});

test('an insert failure fails the first turn closed', async (t) => {
  const env = setup(t);
  env.store.insertMessagesBefore = () => null;
  await env.run({ sessionHandoff: HANDOFF() });
  assert.equal(env.sent.length, 0);
  const failure = env.service.events.map((e) => e.payload).find((p) => p?.type === 'error');
  assert.equal(failure.error_code || failure.code, 'session_handoff_insert_failed');
});

test('a flush failure fails the first turn closed and leaves no row behind', async (t) => {
  const env = setup(t);
  const flush = env.store.flushSession.bind(env.store);
  // Only the flush that would make the handoff row durable fails; the turn bookkeeping flushes normally.
  env.store.flushSession = (id) => (env.store.getSession(id).messages.some((m) => m.kind === 'session_handoff') ? false : flush(id));
  await env.run({ sessionHandoff: HANDOFF() });
  assert.equal(env.sent.length, 0);
  assert.ok(env.rowIds().every((id) => !id.startsWith('ctxh_')));
  const failure = env.service.events.map((e) => e.payload).find((p) => p?.type === 'error');
  assert.equal(failure.error_code || failure.code, 'session_handoff_unflushed');
});

test('a failure retry reuses the row before the anchor (idempotent by id) and the wire still carries it', async (t) => {
  const env = setup(t);
  const first = await env.run({ sessionHandoff: HANDOFF() });
  env.sent.length = 0;
  await env.run({ sessionHandoff: HANDOFF(), editedMessageId: `user_${first.streamId}`, failureRetry: true });
  assert.equal(env.rowIds().filter((id) => id.startsWith('ctxh_')).length, 1, 'no duplicate row');
  assert.ok(env.sent[0].params.messages.some((m) => m.kind === 'session_handoff'));
});

test('a retry whose row is gone fails closed instead of running without the Background', async (t) => {
  const env = setup(t);
  const first = await env.run({ sessionHandoff: HANDOFF() });
  const kept = env.store.getSession('sess_child').messages.filter((m) => m.kind !== 'session_handoff');
  env.store.updateSession('sess_child', { messages: kept, message_count: kept.length });
  env.sent.length = 0;
  await env.run({ sessionHandoff: HANDOFF(), editedMessageId: `user_${first.streamId}`, failureRetry: true });
  assert.equal(env.sent.length, 0);
});

test('later turns replay the handoff row as history while it stays negotiated, and drop it when it is not', async (t) => {
  const env = setup(t);
  await env.run({ sessionHandoff: HANDOFF() });
  env.sent.length = 0;
  await env.run({ prompt: 'And then?', visiblePrompt: 'And then?' });
  assert.deepEqual(env.sent[0].params.messages.map((m) => m.kind || m.role), ['session_handoff', 'user', 'assistant', 'user']);
  // A restarted sidecar that no longer acknowledges the kind: the user can still read the row; the wire drops it.
  const token = beginRuntimeInferenceInitialization(env.service.sidecarClient);
  completeRuntimeInferenceInitialization(env.service.sidecarClient, token, { runtime_inference_admission_version: 1 });
  env.sent.length = 0;
  await env.run({ prompt: 'Once more', visiblePrompt: 'Once more' });
  assert.deepEqual(env.sent[0].params.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.ok(env.rowIds().includes(`ctxh_${HEX}`));
});

test('a checkpoint resume keeps captured handoff rows only for the kinds still negotiated', () => {
  const mail = { role: 'context', kind: 'session_message', content: 'm', session_message: {} };
  const handoffRow = { role: 'context', kind: 'session_handoff', content: BODY, session_handoff: HANDOFF() };
  const rows = [{ role: 'user', content: 'q' }, mail, handoffRow, { role: 'user', content: 'p' }];
  const checkpointHistory = { canonicalHistoryMessages: [], compactedHistory: { applied: false, messages: [] }, preparedMessages: rows };
  const base = {
    sessionId: 's', sessionMessages: [], userMessageId: 'u', sessionSummary: {}, checkpointHistory, prompt: 'p', textAttachments: [],
    skillInvocation: null, contextPreferences: { history_scope: 'session' },
  };
  const service = { options: {} };
  const kinds = (wireKinds) => deriveManagedTurnHistory(service, { ...base, wireKinds }).preparedMessages.map((m) => m.kind || m.role);
  assert.deepEqual(kinds({ sessionMessages: true, sessionHandoff: true }), ['user', 'session_message', 'session_handoff', 'user']);
  assert.deepEqual(kinds({ sessionMessages: true, sessionHandoff: false }), ['user', 'session_message', 'user']);
  assert.deepEqual(kinds({ sessionMessages: false, sessionHandoff: true }), ['user', 'session_handoff', 'user']);
  assert.deepEqual(kinds({ sessionMessages: false, sessionHandoff: false }), ['user', 'user']);
  // The legacy flag pair keeps working for existing callers.
  assert.deepEqual(deriveManagedTurnHistory(service, { ...base, sessionMessageContext: true }).preparedMessages.map((m) => m.kind || m.role),
    ['user', 'session_message', 'user']);
});

// ---------- the chat.done turn-boundary completion chain ----------

const OFFER = `proposal_${'ef56'.repeat(16)}`;

test('normalizeCompletion is a closed pair: a known reason and a proposal id, or nothing', () => {
  assert.deepEqual(normalizeCompletion({ completion_reason: 'awaiting_proposal', proposal_id: OFFER }), { reason: 'awaiting_proposal', proposalId: OFFER });
  assert.deepEqual(normalizeCompletion({ completion_reason: 'session_handoff_completed', proposal_id: PROPOSAL }),
    { reason: 'session_handoff_completed', proposalId: PROPOSAL });
  for (const bad of [undefined, null, {}, { completion_reason: 'awaiting_proposal' }, { proposal_id: OFFER },
    { completion_reason: 'tool_cap', proposal_id: OFFER }, { completion_reason: 'awaiting_proposal', proposal_id: 'proposal_x' },
    { completion_reason: 'awaiting_proposal', proposal_id: OFFER.toUpperCase() }, { completion_reason: 7, proposal_id: OFFER }]) {
    assert.equal(normalizeCompletion(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(completionEventFields(null), {});
  assert.deepEqual(completionEventFields({ reason: 'awaiting_proposal', proposalId: OFFER }), { completionReason: 'awaiting_proposal', proposalId: OFFER });
  assert.deepEqual(buildTerminalMessageExtras({ completion: { reason: 'awaiting_proposal', proposalId: OFFER } }),
    { completion_reason: 'awaiting_proposal', completion_proposal_id: OFFER });
  assert.deepEqual(buildTerminalMessageExtras({}), {});
});

function runtimeService(persisted, events, extra = {}) {
  return {
    featureFlags: {},
    emit(name, payload) { events.push({ name, payload }); },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) { persisted.push(message); return message; },
      setSessionPreferences() {},
      getActiveTurn() { return null; },
      setActiveTurn() {},
      touchActiveTurn() {},
      clearActiveTurn() {},
      getSessionMessages() { return []; },
      ...extra,
    },
  };
}

function boundaryRuntime(service, suffix, withLease = false) {
  return createManagedChatStreamRuntime({
    service,
    resolvedSessionId: `session_${suffix}`,
    streamId: `stream_${suffix}`,
    normalizedPreferences: {},
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: `user_${suffix}`,
    ...(withLease ? {
      turnLease: {
        identity: {
          sessionId: `session_${suffix}`, sessionIncarnation: 'inc_1', generation: 1,
          turnId: `turn_${suffix}`, streamId: `stream_${suffix}`, userMessageId: `user_${suffix}`,
        },
        store: { getSessionMessages: () => [], commitTerminal() {} },
      },
    } : {}),
  });
}

const DEPS = { toolContext: {}, handleToolNotification() {} };
const completeEvent = (events) => events.find((e) => e.name === 'chat-stream' && e.payload?.type === 'complete')?.payload;

test('chat.done completion fields reach the complete event and the assistant terminal message', async () => {
  const persisted = [];
  const events = [];
  const runtime = boundaryRuntime(runtimeService(persisted, events), 'text');
  runtime.handleNotification({ method: 'chat.token', params: { delta: 'Here is my offer.' } }, DEPS);
  runtime.handleNotification({ method: 'chat.done', params: {
    stop_reason: 'end_turn', completion_reason: 'awaiting_proposal', proposal_id: OFFER } }, DEPS);
  await runtime.settleTerminalResult({ status: 'completed' });
  const complete = completeEvent(events);
  assert.equal(complete.completionReason, 'awaiting_proposal');
  assert.equal(complete.proposalId, OFFER);
  assert.equal(Object.hasOwn(complete, 'resumableStop'), false, 'not a Resume stop');
  assert.equal(persisted[0].completion_reason, 'awaiting_proposal');
  assert.equal(persisted[0].completion_proposal_id, OFFER);
  assert.equal(Object.hasOwn(persisted[0], 'resumable_stop'), false);
});

test('a boundary turn with no visible text completes: no failure, no synthetic tool-work text, no empty bubble', async () => {
  for (const reason of ['awaiting_proposal', 'session_handoff_completed']) {
    const persisted = [];
    const events = [];
    const runtime = boundaryRuntime(runtimeService(persisted, events), reason);
    runtime.handleNotification({ method: 'tool.executing', params: { tool_call_id: 'call_1', tool_name: 'propose_session' } }, DEPS);
    runtime.handleNotification({ method: 'chat.done', params: {
      stop_reason: 'end_turn', response_text: '', completion_reason: reason, proposal_id: OFFER } }, DEPS);
    await runtime.settleTerminalResult({ status: 'completed' });
    const complete = completeEvent(events);
    assert.ok(complete, `${reason}: a complete event`);
    assert.equal(complete.completionReason, reason);
    assert.equal(complete.proposalId, OFFER);
    assert.equal(complete.content, '', 'no fallback text was synthesized');
    assert.equal(events.some((e) => e.payload?.type === 'error'), false, 'no failure event');
    assert.equal(persisted.length, 0, 'no empty assistant message and no failure row');
  }
});

test('an ordinary empty completion is still a failure (the exemption is only for the two boundary reasons)', async () => {
  const persisted = [];
  const events = [];
  const runtime = boundaryRuntime(runtimeService(persisted, events), 'plain');
  runtime.handleNotification({ method: 'chat.done', params: { stop_reason: 'end_turn', response_text: '' } }, DEPS);
  await assert.rejects(runtime.settleTerminalResult({ status: 'completed' }), /no visible assistant text/i);
  // A reason without its proposal id, or an unknown reason, is not a boundary.
  for (const params of [{ completion_reason: 'awaiting_proposal' }, { completion_reason: 'tool_cap', proposal_id: OFFER }]) {
    const other = boundaryRuntime(runtimeService([], []), `x${Object.keys(params).length}${params.completion_reason}`);
    other.handleNotification({ method: 'chat.done', params: { stop_reason: 'end_turn', response_text: '', ...params } }, DEPS);
    await assert.rejects(other.settleTerminalResult({ status: 'completed' }), /no visible assistant text/i);
  }
});

test('the coordinator path settles the same fields: message extras, renderer payload and the empty-text turn', async () => {
  const requests = [];
  const events = [];
  const service = runtimeService([], events);
  service.terminalCoordinator = { async settle(request) {
    requests.push(request);
    return { ok: true, visibleTerminal: true, durableTerminal: true, persistedMessageIds: [] };
  } };
  const withText = boundaryRuntime(service, 'coord_text', true);
  withText.handleNotification({ method: 'chat.token', params: { delta: 'Here is my offer.' } }, DEPS);
  withText.handleNotification({ method: 'chat.done', params: { stop_reason: 'end_turn', completion_reason: 'awaiting_proposal', proposal_id: OFFER } }, DEPS);
  await withText.settleTerminalResult({ status: 'completed' });
  assert.equal(requests[0].messages[0].completion_reason, 'awaiting_proposal');
  assert.equal(requests[0].messages[0].completion_proposal_id, OFFER);
  assert.equal(requests[0].terminal.rendererPayload.completionReason, 'awaiting_proposal');
  assert.equal(requests[0].terminal.rendererPayload.proposalId, OFFER);

  const empty = boundaryRuntime(service, 'coord_empty', true);
  empty.handleNotification({ method: 'chat.done', params: { stop_reason: 'end_turn', response_text: '', completion_reason: 'session_handoff_completed', proposal_id: PROPOSAL } }, DEPS);
  await empty.settleTerminalResult({ status: 'completed' });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.length, 0, 'no assistant message for an empty boundary turn');
  assert.equal(requests[1].terminal.rendererPayload.completionReason, 'session_handoff_completed');
  assert.equal(requests[1].terminal.rendererPayload.proposalId, PROPOSAL);
  assert.equal(requests[1].terminal.rendererPayload.content, '');
});

test('settleManagedAssistantCompletion omits the fields when the turn had no boundary', async () => {
  const requests = [];
  const slice = { phases: [], visibleSegments: [], toolSteps: [] };
  const ctx = {
    service: { terminalCoordinator: { async settle(request) { requests.push(request); return { ok: true, visibleTerminal: true, durableTerminal: true }; } } },
    turnLease: { identity: { sessionId: 's', sessionIncarnation: 'i', generation: 1, turnId: 't', streamId: 'st', userMessageId: 'u' },
      store: { getSessionMessages: () => [], commitTerminal() {} } },
    streamId: 'st', resolvedSessionId: 's', assistantBaseMessageId: 'assistant_st', assistantText: 'Done.', currentSegmentText: 'Done.',
    textSegmentIndex: 0, hasPersistedSegments: false, persistedTextSegmentIds: [], refusedTextSegments: [], reasoningEntries: [], model: 'm',
    normalizedPreferences: {}, normalizedInteractiveResponse: null, exchangeTitle: '', eventBase: {}, turnUsage: null, unfinishedToolRepairs: [],
    turnEventCollector: { retargetCapturedEvents: () => 0 }, transcriptCollector: { slice, completeCurrentPhase() {}, resetSlice() {} },
    visibleCompletionEmitted: false, terminalPersistRefused: false, onVisibleCompletion() {}, streamSawBatch: false, userMessagePersisted: true,
  };
  await settleManagedAssistantCompletion(ctx);
  assert.equal(Object.hasOwn(requests[0].messages[0], 'completion_reason'), false);
  assert.equal(Object.hasOwn(requests[0].terminal.rendererPayload, 'completionReason'), false);
  assert.equal(Object.hasOwn(requests[0].terminal.rendererPayload, 'proposalId'), false);
});

test('a segmented turn whose final slice is empty carries the completion on its last text segment', () => {
  const updates = [];
  const store = {
    getSessionMessages: () => [{ id: 'seg0', content: 'Looking.' }, { id: 'seg1', content: '' }],
    updateMessage: (sessionId, id, patch) => updates.push({ sessionId, id, patch }),
  };
  patchLastSegmentDiscardedDrafts(store, 's', ['seg0', 'seg1'], null, { reason: 'awaiting_proposal', proposalId: OFFER });
  assert.deepEqual(updates, [{ sessionId: 's', id: 'seg0', patch: { completion_reason: 'awaiting_proposal', completion_proposal_id: OFFER } }]);
  updates.length = 0;
  patchLastSegmentDiscardedDrafts(store, 's', ['seg0'], null, null);
  assert.deepEqual(updates, [], 'nothing to patch without drafts or a completion');
  patchLastSegmentDiscardedDrafts(store, 's', ['seg0'], { count: 1, latest_reason: 'retry' }, { reason: 'awaiting_proposal', proposalId: OFFER });
  assert.deepEqual(Object.keys(updates[0].patch).sort(), ['completion_proposal_id', 'completion_reason', 'discarded_drafts']);
});