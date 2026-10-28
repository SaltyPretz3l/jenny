'use strict';

// The managed-chat hook for addressed session mail (row 59 checkpoint 4, slice S3, decisions D5-D7):
// mail joins a brand-new model turn or a failure retry, after the user row and before it in the transcript.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { startManagedSidecarChatStream } = require('../../services/backend/managed-sidecar-chat');
const { deriveManagedTurnHistory } = require('../../services/backend/managed-sidecar-chat-helpers');
const { createSessionMailStore } = require('../../services/backend/session-mail-store');
const E = require('../../services/backend/session-message-envelope');
const {
  beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization,
} = require('../../services/session-runtime/inference-protocol');
const { initializeSessionExecutionAuthority } = require('../../services/projects/application-execution-composition');
const { initializeApplicationProjects } = require('../../services/projects/application-project-scope');
const { ToolPermissionStore } = require('../../services/tools/tool-permission-store');
const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');
const F = require('../helpers/session-mail-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const PREFERENCES = {
  preferred_model: 'mock-v1', reasoning_effort: 'default', conversation_mode: 'chat', pending_question_batch: null,
  interactive_sequence_state: 'idle', interactive_round_count: 0, plan_mode: false,
};
const ACK = { schema_version: 1, producer_tools: [], context_kinds: ['session_message'], session_messages: true };

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
    logs: [],
    emit() {},
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

// A chat.send double that records the params and completes the turn; `negotiated` models the initialize ack.
function attachClient(service, { negotiated }) {
  const sent = [];
  const client = {
    process: { pid: 4242 },
    chatSend: async (params, options = {}) => {
      sent.push(params);
      options.onNotification({ method: 'chat.token', params: { request_id: params.request_id, session_id: params.session_id, delta: 'ok', role: 'assistant' } });
      options.onNotification({ method: 'chat.done', params: { request_id: params.request_id, session_id: params.session_id } });
      return { status: 'completed' };
    },
  };
  const token = beginRuntimeInferenceInitialization(client);
  completeRuntimeInferenceInitialization(client, token, {
    runtime_inference_admission_version: 1,
    ...(negotiated ? { chat_workspace_version: 1, chat_workspace_capabilities: ACK } : {}),
  });
  service.sidecarClient = client;
  return sent;
}

function setup(t, { negotiated = true, mail = 2, fresh = false } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-mail-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  t.after(() => store.dispose());
  store.createSessionWithId('sess_dest', { title: fresh ? 'New Chat' : 'Destination', preferences: { session_start_date: '2026-10-15' } });
  if (!fresh) {
    store.appendMessage('sess_dest', { id: 'u0', role: 'user', content: 'earlier question', turn_id: 'turn_0' });
    store.appendMessage('sess_dest', { id: 'a0', role: 'assistant', content: 'earlier answer', turn_id: 'turn_0' });
  }
  const mailStore = createSessionMailStore(store);
  const records = Array.from({ length: mail }, (_, i) => F.makeInbox(i + 1));
  if (records.length) {
    assert.ok(mailStore.mutate('sess_dest', ({ mail: current }) => ({
      mail: { ...current, inbox: records, next_receive_sequence: records.length + 1 },
    })).ok);
  }
  const service = createService(store, userDataPath);
  const sent = attachClient(service, { negotiated });
  const run = async (overrides = {}) => {
    const stream = await startManagedSidecarChatStream(service, {
      sessionId: 'sess_dest', prompt: 'Summarize what you know', visiblePrompt: 'Summarize what you know', attachments: [],
      runtimePreferredModel: 'mock-v1', normalizedInteractiveResponse: null, normalizedPreferences: { ...PREFERENCES }, ...overrides,
    });
    await service.activeStreams.get(stream.streamId)._pendingPromise;
    return stream;
  };
  const states = () => mailStore.read('sess_dest').mail.inbox.map((r) => r.context.state);
  return { store, mailStore, service, sent, run, states, ids: () => store.getSession('sess_dest').messages.map((m) => m.id) };
}

test('a brand-new turn admits queued mail: rows sit before the user anchor and ride the wire before the prompt', async (t) => {
  const env = setup(t);
  const stream = await env.run();
  const messages = env.store.getSession('sess_dest').messages;
  const userIndex = messages.findIndex((m) => m.id === `user_${stream.streamId}`);
  assert.deepEqual(messages.slice(2, userIndex).map((m) => m.id), [`ctx_${F.uuid(1)}`, `ctx_${F.uuid(2)}`]);
  assert.ok(messages.slice(2, userIndex).every((m) => m.role === 'context' && m.turn_id === stream.streamId));
  assert.equal(messages[userIndex].turn_id, stream.streamId);
  assert.equal(messages[userIndex].content, 'Summarize what you know');
  assert.deepEqual(env.states(), ['included', 'included']);

  assert.equal(env.sent.length, 1);
  const wire = env.sent[0].messages;
  assert.deepEqual(wire.map((m) => m.role), ['user', 'assistant', 'context', 'context', 'user']);
  assert.equal(wire[2].kind, 'session_message');
  assert.equal(wire[2].session_message.message_id, F.uuid(1));
  assert.equal(wire[2].content, 'hello 1');
  assert.equal(wire.at(-1).content, 'Summarize what you know');
  assert.equal(env.sent[0].logical_turn_id, stream.streamId);
  assert.ok(env.service.logs.every((l) => !String(l.event).startsWith('chat.session_mail_admission')), 'no admission warnings');
});

test('the second turn replays the included rows as history and admits nothing new', async (t) => {
  const env = setup(t);
  await env.run();
  env.sent.length = 0;
  await env.run({ prompt: 'And now?', visiblePrompt: 'And now?' });
  const wire = env.sent[0].messages;
  assert.deepEqual(wire.map((m) => m.role), ['user', 'assistant', 'context', 'context', 'user', 'assistant', 'user']);
  assert.deepEqual(env.states(), ['included', 'included']);
  const second = env.mailStore.read('sess_dest').mail.admission_snapshots;
  assert.equal(second.length, 1, 'no queued mail, no second snapshot');
});

test('without the negotiated capability the mail stays queued and no context row is sent', async (t) => {
  const env = setup(t, { negotiated: false });
  await env.run();
  assert.deepEqual(env.states(), ['queued', 'queued']);
  assert.deepEqual(env.sent[0].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.ok(env.ids().every((id) => !id.startsWith('ctx_')));
  assert.deepEqual(env.mailStore.read('sess_dest').mail.admission_snapshots, []);
});

test('mail never seeds the chat title: a fresh chat is titled from the human prompt', async (t) => {
  const env = setup(t, { fresh: true, mail: 1 });
  const stream = await env.run({ prompt: 'Plan my weekend trip', visiblePrompt: 'Plan my weekend trip' });
  assert.match(env.store.getSession('sess_dest').title, /Plan my weekend trip/);
  assert.ok(!/hello 1/.test(env.store.getSession('sess_dest').title));
  const messages = env.store.getSession('sess_dest').messages;
  assert.deepEqual(messages.slice(0, 2).map((m) => m.id), [`ctx_${F.uuid(1)}`, `user_${stream.streamId}`]);
  assert.deepEqual(env.sent[0].messages.map((m) => m.role), ['context', 'user']);
  assert.deepEqual(env.states(), ['included']);
});

test('a context row already in history is dropped from the wire when the capability is not negotiated', async (t) => {
  const env = setup(t, { negotiated: false, mail: 0 });
  assert.ok(env.store.appendMessage('sess_dest', E.buildIncludedRow(F.makeEnvelope(7), { turn_id: 'turn_0', timestamp: F.iso() })));
  await env.run();
  assert.deepEqual(env.sent[0].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.ok(env.ids().includes(`ctx_${F.uuid(7)}`), 'the user can still read the stored row');
});

test('an edit reuses the rows already before the anchor and admits no new mail', async (t) => {
  const env = setup(t, { mail: 1 });
  const first = await env.run();
  assert.deepEqual(env.states(), ['included']);
  // Mail that arrives later waits for a new turn when the person edits their message.
  env.mailStore.mutate('sess_dest', ({ mail }) => ({
    mail: { ...mail, inbox: [...mail.inbox, F.makeInbox(2)], next_receive_sequence: 3 },
  }));
  env.sent.length = 0;
  await env.run({ editedMessageId: `user_${first.streamId}` });
  assert.deepEqual(env.states(), ['included', 'queued']);
  assert.deepEqual(env.sent[0].messages.map((m) => m.role), ['user', 'assistant', 'context', 'user']);
  assert.equal(env.sent[0].messages[2].session_message.message_id, F.uuid(1), 'identical rows are re-sent');
  assert.equal(env.ids().filter((id) => id.startsWith('ctx_')).length, 1);
  assert.equal(env.mailStore.read('sess_dest').mail.admission_snapshots.length, 1);
});

test('a failure retry keeps the rows already before the anchor and admits what is still queued, once', async (t) => {
  const env = setup(t, { mail: 1 });
  const first = await env.run();
  env.mailStore.mutate('sess_dest', ({ mail }) => ({
    mail: { ...mail, inbox: [...mail.inbox, F.makeInbox(2)], next_receive_sequence: 3 },
  }));
  env.sent.length = 0;
  await env.run({ editedMessageId: `user_${first.streamId}`, failureRetry: true });
  assert.deepEqual(env.states(), ['included', 'included']);
  const wire = env.sent[0].messages;
  assert.deepEqual(wire.filter((m) => m.role === 'context').map((m) => m.session_message.message_id), [F.uuid(1), F.uuid(2)]);
  assert.equal(wire.at(-1).content, 'Summarize what you know');
  assert.deepEqual(env.ids().filter((id) => id.startsWith('ctx_')), [`ctx_${F.uuid(1)}`, `ctx_${F.uuid(2)}`], 'nothing duplicated');
});

// 2026-10-27 incident: Jenny's "resume" woke a linked child whose wake turn failed loading the model
// (model_busy) before admission; the person's Retry ran the turn without it and it sat above the composer.
test('a turn that failed before admission leaves its mail queued; the failure retry carries it', async (t) => {
  const env = setup(t, { mail: 1 });
  const resolveModel = env.service._resolveModel;
  env.service._resolveModel = async () => {
    throw Object.assign(new Error('Model initialization is already in progress'), { code: 'CMP-AI-0002' });
  };
  const failed = await env.run({ prompt: 'Woken by a message from Jenny', visiblePrompt: 'Woken by a message from Jenny' }).catch(() => null);
  assert.equal(env.sent.length, 0, 'the failed attempt never reached chat.send');
  assert.deepEqual(env.states(), ['queued']);
  env.service._resolveModel = resolveModel;
  const anchor = env.store.getSession('sess_dest').messages.find((m) => m.role === 'user' && m.content === 'Woken by a message from Jenny');
  assert.ok(anchor, `the wake prompt row is persisted (stream ${failed?.streamId || 'rejected'})`);
  await env.run({ prompt: anchor.content, visiblePrompt: anchor.content, editedMessageId: anchor.id, failureRetry: true });
  assert.deepEqual(env.states(), ['included']);
  const wire = env.sent[0].messages;
  assert.equal(wire.at(-2).role, 'context');
  assert.equal(wire.at(-2).content, 'hello 1');
  assert.equal(wire.at(-1).content, 'Woken by a message from Jenny');
});

test('the deterministic transcript answer is not a model turn: nothing is admitted', async (t) => {
  const env = setup(t);
  await env.run({ prompt: 'What was the first sentence you sent in this session?', visiblePrompt: 'What was the first sentence you sent in this session?' });
  assert.equal(env.sent.length, 0, 'no chat.send for a deterministic answer');
  assert.deepEqual(env.states(), ['queued', 'queued']);
  assert.ok(env.ids().every((id) => !id.startsWith('ctx_')));
});

test('a mail admission failure never fails the turn: the turn runs without mail', async (t) => {
  const env = setup(t);
  env.store.insertMessagesBefore = () => { throw new Error('store exploded'); };
  await env.run();
  assert.equal(env.sent.length, 1);
  assert.deepEqual(env.sent[0].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(env.states(), ['queued', 'queued']);
  assert.deepEqual(env.mailStore.read('sess_dest').mail.admission_snapshots, []);
  assert.ok(env.service.logs.some((l) => l.event === 'chat.session_mail_admission_failed'));
  assert.ok(env.service.logs.every((l) => !JSON.stringify(l.details || {}).includes('hello 1')), 'bodies are never logged');
});

test('a checkpoint resume keeps its captured prepared messages and only loses un-negotiated context rows', () => {
  const rows = [{ role: 'user', content: 'q' }, { role: 'context', kind: 'session_message', content: 'm', session_message: {} }, { role: 'user', content: 'p' }];
  const checkpointHistory = {
    canonicalHistoryMessages: [], compactedHistory: { applied: false, messages: [] }, preparedMessages: rows,
  };
  const base = {
    sessionId: 's', sessionMessages: [], userMessageId: 'u', sessionSummary: {}, checkpointHistory, prompt: 'p', textAttachments: [],
    skillInvocation: null, contextPreferences: { history_scope: 'session' },
  };
  const service = { options: {} };
  assert.deepEqual(deriveManagedTurnHistory(service, { ...base, sessionMessageContext: true }).preparedMessages, rows);
  assert.deepEqual(deriveManagedTurnHistory(service, { ...base, sessionMessageContext: false }).preparedMessages.map((m) => m.role), ['user', 'user']);
});
