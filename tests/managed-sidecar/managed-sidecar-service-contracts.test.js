const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../../services/backend/backend-service');
const { DEFAULT_MANAGED_SHELL_MODEL } = require('../../services/backend/backend-config');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { SessionShadowStore } = require('../../services/backend/session-shadow-store');
const { TurnEventJournal } = require('../../services/backend/turn-event-journal');
const { createFakeSafeStorage } = require('../helpers/fake-safe-storage');
const { collectServiceLogs } = require('../helpers/backend-service-helpers');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('../helpers/resource-cleanup');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
  markManagedSidecarReady,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');
const {
  startManagedSidecarChatStream,
} = require('../../services/backend/managed-sidecar-chat');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createManagedBackend(t, options = {}) {
  const userDataPath = options.userDataPath
    || createTrackedTempDir('jenny-managed-contracts-');
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
    ...options,
  });
  t.after(() => service.dispose());
  markManagedSidecarReady(service);
  service._resolveModel = async (preferredModel = '') => preferredModel || 'mock-v1';
  return { service, userDataPath };
}

function installCompletedChat(service, capture, answer = 'Managed completion.') {
  service.sidecarClient = {
    connected: true,
    dispose() {},
    async chatSend(params, { onNotification }) {
      capture?.(params);
      onNotification({ method: 'chat.token', params: { delta: answer } });
      onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };
}

async function startAndSettle(service, payload) {
  const stream = await service.startChatStream(payload);
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  return stream;
}

test('managed deleteSession structurally cancels an active turn and settles pending tools', async (t) => {
  const { service } = createManagedBackend(t);
  const sessionId = 'managed_delete_active_turn';
  service.sessionStore.createSessionWithId(sessionId, { title: 'Delete active turn' });
  const lease = service.sessionTurnActors.reserveStart({
    sessionId,
    store: service.sessionStore,
    activeStreams: service.activeStreams,
    prompt: 'hello',
    path: 'managed',
  });
  const controller = new AbortController();
  controller.traceId = lease.identity.streamId;
  service.sessionTurnActors.attachController(lease, controller);
  controller.signal.addEventListener('abort', () => {
    service.sessionTurnActors.release(lease, { status: 'cancelled' });
  }, { once: true });
  let approvalResolution = null;
  service.pendingToolApprovals.set('approval_managed_delete', {
    streamId: lease.identity.streamId,
    resolve(approved, reason) { approvalResolution = { approved, reason }; },
  });
  const cancelledStreams = [];
  service.toolExecutor = {
    cancelPendingForStream(streamId) { cancelledStreams.push(streamId); },
  };

  const deleted = await service.deleteSession(sessionId);

  assert.deepEqual(deleted, {
    object: 'session',
    id: sessionId,
    deleted: true,
    cleanup_status: 'complete',
    cleanup_errors: [],
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason.cancel_reason, 'session_delete');
  assert.deepEqual(approvalResolution, { approved: false, reason: 'cancelled' });
  assert.equal(service.pendingToolApprovals.size, 0);
  assert.deepEqual(cancelledStreams, [lease.identity.streamId]);
  assert.equal(service.activeStreams.has(lease.identity.streamId), false);
});

test('managed deletion durably flushes the deleted summary and linked-session scrubs', async (t) => {
  const userDataPath = createTrackedTempDir('jenny-managed-delete-durable-');
  const { service } = createManagedBackend(t, { userDataPath });
  const targetId = 'managed_durable_target';
  const linkedId = 'managed_durable_linked';
  service.sessionStore.createSessionWithId(targetId, { title: 'Delete me' });
  service.sessionStore.createSessionWithId(linkedId, { title: 'Linked' });
  service.sessionStore.updateSession(linkedId, { linked_session_ids: [targetId] });
  service.shadowStore.upsertSession(targetId, { title: 'Delete me' });
  service.shadowStore.upsertSession(linkedId, {
    title: 'Linked',
    linked_session_ids: [targetId],
  });
  service.sessionStore.flush();
  service.shadowStore.flush();

  const deleted = await service.deleteSession(targetId);

  assert.equal(deleted.cleanup_status, 'complete');
  assert.equal(service.sessionStore.hasPendingWrites(), false);
  assert.equal(service.shadowStore.hasPendingWrites(), false);
  const reopenedCanonical = new ElectronSessionStore(
    path.join(userDataPath, 'sessions.json'),
    { writeDebounceMs: 0 }
  );
  const reopenedShadow = new SessionShadowStore(
    path.join(userDataPath, 'session-shadow.json'),
    { writeDebounceMs: 0 }
  );
  t.after(() => reopenedCanonical.dispose());
  t.after(() => reopenedShadow.dispose());
  assert.equal(reopenedCanonical.getSession(targetId), null);
  assert.equal(reopenedShadow.getSession(targetId), null);
  assert.deepEqual(reopenedCanonical.getSession(linkedId).linked_session_ids, []);
  assert.deepEqual(reopenedShadow.getSession(linkedId).linked_session_ids, []);
});

test('managed delete journal cleanup treats an empty immediate flush as durable success', async (t) => {
  const userDataPath = createTrackedTempDir('jenny-managed-delete-journal-');
  const { service } = createManagedBackend(t, { userDataPath });
  const sessionId = 'managed_immediate_journal';
  service.sessionStore.createSessionWithId(sessionId, { title: 'Journal cleanup' });
  service.turnEventJournal.dispose();
  service.turnEventJournal = new TurnEventJournal(
    path.join(userDataPath, 'turn-event-journal-immediate.json'),
    { writeDebounceMs: 0 }
  );
  service.turnEventJournal.append(sessionId, 'turn_1', [{
    event_id: 'event_1',
    kind: 'chat_token',
    payload: { delta: 'x' },
  }]);

  const deleted = await service.deleteSession(sessionId);

  assert.equal(deleted.cleanup_status, 'complete');
  assert.equal(service.turnEventJournal.listAll()[sessionId], undefined);
  assert.equal(service.turnEventJournal.flush(), true);
});

test('B1 managed: provider failure durably preserves partial plain text exactly once', async (t) => {
  const { service } = createManagedBackend(t);
  const events = [];
  service.on('chat-stream', (event) => events.push(event));
  const created = await service.createSession({ title: 'Managed partial failure' });
  service.sidecarClient = {
    connected: true,
    dispose() {},
    async chatSend(_params, { onNotification }) {
      onNotification({ method: 'chat.token', params: { delta: 'Partial answer' } });
      throw new Error('provider disconnected');
    },
  };

  const stream = await startAndSettle(service, {
    sessionId: created.data.id,
    prompt: 'stream then fail',
  });
  const messages = await service.getSessionMessages(created.data.id);
  const assistantRows = messages.data.filter((message) => message.role === 'assistant');

  assert.equal(assistantRows.length, 1);
  assert.equal(assistantRows[0].id, `assistant_${stream.streamId}`);
  assert.equal(assistantRows[0].content, 'Partial answer');
  assert.equal(assistantRows[0].status, 'runtime_error');
  assert.equal(assistantRows[0].terminal_status, 'runtime_error');
  assert.equal(assistantRows[0].question_batch, undefined);
  assert.equal(messages.active_turn, null);
  assert.equal(events.filter((event) => event.type === 'error').length, 1);
});

test('managed per-turn personality opt-out suppresses injection without changing stored opt-in', async (t) => {
  const personalityText = '## Personality\n\nDo not leak per-turn suppression text.';
  let compileCalls = 0;
  const { service } = createManagedBackend(t, {
    personalityWorkspace: {
      async getCompiledContext() {
        compileCalls += 1;
        return personalityText;
      },
    },
  });
  const created = await service.createSession({
    title: 'Stored personality opt-in',
    preferences: { context_preferences: { include_personality: true } },
  });
  const setStoredPreferences = service.sessionStore.setSessionPreferences.bind(service.sessionStore);
  const getStoredSession = service.sessionStore.getSession.bind(service.sessionStore);
  service.sessionStore.setSessionPreferences = (sessionId, preferences = {}) => {
    const storedContextPreferences = getStoredSession(sessionId)?.context_preferences;
    return setStoredPreferences(sessionId, {
      ...preferences,
      context_preferences: storedContextPreferences,
    });
  };
  service.sessionStore.getSession = (sessionId) => {
    const stored = getStoredSession(sessionId);
    return stored && sessionId === created.data.id
      ? {
          ...stored,
          context_preferences: {
            ...stored.context_preferences,
            include_personality: false,
          },
        }
      : stored;
  };
  let outgoingRequest = null;
  installCompletedChat(service, (params) => { outgoingRequest = params; });

  await startAndSettle(service, {
    sessionId: created.data.id,
    prompt: 'Plain managed prompt',
    contextPreferences: { include_personality: false },
  });

  service.sessionStore.getSession = getStoredSession;
  assert.equal(compileCalls, 0);
  assert.equal(
    service.sessionStore.getSession(created.data.id).context_preferences.include_personality,
    true
  );
  assert.equal(outgoingRequest.messages.at(-1).content, 'Plain managed prompt');
  assert.equal(JSON.stringify(outgoingRequest).includes(personalityText), false);
});

test('managed personality compiler failure completes with a redacted structured warning', async (t) => {
  const sensitiveCompilerDetail = 'C:\\Users\\private\\PERSONALITY.md secret phrase';
  const { service } = createManagedBackend(t, {
    personalityWorkspace: {
      async getCompiledContext() {
        const error = new Error(sensitiveCompilerDetail);
        error.code = 'PERSONALITY_WORKSPACE_FUTURE_SCHEMA';
        throw error;
      },
    },
  });
  const logs = collectServiceLogs(service);
  const created = await service.createSession({ title: 'Compiler failure' });
  let outgoingRequest = null;
  installCompletedChat(service, (params) => { outgoingRequest = params; }, 'Still completed.');

  const stream = await startAndSettle(service, {
    sessionId: created.data.id,
    prompt: 'Continue without personality',
  });

  const warning = logs.find((entry) => entry.event === 'chat.personality_compile_failed');
  assert.equal(warning.level, 'WARN');
  assert.equal(warning.details.sessionId, created.data.id);
  assert.equal(warning.details.streamId, stream.streamId);
  assert.equal(warning.details.errorCode, 'PERSONALITY_WORKSPACE_FUTURE_SCHEMA');
  assert.equal(warning.details.errorName, 'Error');
  assert.equal(JSON.stringify(outgoingRequest).includes(sensitiveCompilerDetail), false);
  assert.equal(JSON.stringify(logs).includes(sensitiveCompilerDetail), false);
  assert.deepEqual(outgoingRequest.context_blocks || [], []);
  const messages = await service.getSessionMessages(created.data.id);
  assert.equal(messages.data.at(-1).content, 'Still completed.');
});

test('managed send auto-applies persisted model and reasoning preferences', async (t) => {
  const { service } = createManagedBackend(t);
  const created = await service.createSession({
    title: 'Managed runtime preferences',
    preferences: {
      preferred_model: 'qwen3.8:9b',
      // qwen3.8 is the Ollama family that accepts a graded level (CMP-AI-0005 self-heals others).
      reasoning_effort: 'high',
    },
  });
  const resolvedModels = [];
  service._resolveModel = async (preferredModel) => {
    resolvedModels.push(preferredModel);
    return preferredModel;
  };
  let outgoingRequest = null;
  installCompletedChat(service, (params) => { outgoingRequest = params; });
  const stored = service.sessionStore.getSession(created.data.id);

  await startAndSettle(service, {
    sessionId: created.data.id,
    prompt: 'Use stored runtime preferences',
    preferredModel: stored.preferred_model,
    reasoningEffort: stored.reasoning_effort,
  });

  assert.deepEqual(resolvedModels, ['qwen3.8:9b']);
  assert.equal(outgoingRequest.reasoning_effort, 'high');
  const messages = await service.getSessionMessages(created.data.id);
  assert.equal(messages.data.at(-1).model_used, 'qwen3.8:9b');
  const persisted = service.sessionStore.getSession(created.data.id);
  assert.equal(persisted.preferred_model, 'qwen3.8:9b');
  assert.equal(persisted.reasoning_effort, 'high');
});

test('managed createSession preserves plan mode through listSessions round-trip', async (t) => {
  const { service } = createManagedBackend(t);
  const created = await service.createSession({
    title: 'Managed plan session',
    preferences: { preferred_model: 'mock-v1', plan_mode: true },
  });

  assert.equal(created.data.plan_mode, true);
  assert.equal(service.sessionStore.getSession(created.data.id).plan_mode, true);
  const listed = await service.listSessions();
  const summary = listed.data.find((entry) => entry.id === created.data.id);
  assert.equal(summary.plan_mode, true);
});

test('managed user-message persistence keeps attachment metadata but excludes extracted bodies', async (t) => {
  const { service } = createManagedBackend(t);
  const created = await service.createSession({ title: 'Managed attachment metadata' });
  let outgoingRequest = null;
  installCompletedChat(service, (params) => { outgoingRequest = params; });
  const attachments = [{
    id: 'attachment_managed_1',
    displayName: 'notes.txt',
    promptName: 'notes.txt',
    extension: '.txt',
    sizeBytes: 42,
    text: 'private extracted managed text',
  }];

  const stream = await startAndSettle(service, {
    sessionId: created.data.id,
    prompt: 'Use my managed file',
    attachments,
  });
  const messages = await service.getSessionMessages(created.data.id);
  const userMessage = messages.data.find((message) => message.id === `user_${stream.streamId}`);

  assert.deepEqual(userMessage.attachments, [{
    id: 'attachment_managed_1',
    kind: 'text',
    displayName: 'notes.txt',
    promptName: 'notes.txt',
    extension: '.txt',
    sizeBytes: 42,
    truncated: false,
  }]);
  assert.equal(userMessage.text, undefined);
  assert.equal(JSON.stringify(userMessage).includes('private extracted managed text'), false);
  assert.match(outgoingRequest.messages.at(-1).content, /Attached files:/);
});

test('managed backend status snapshot exposes exact context-length metadata', async (t) => {
  const { service } = createManagedBackend(t);
  service.currentModel = 'managed-context-model';
  service.currentEngineType = 'ollama';
  service.currentStatus = service._buildManagedStatusSnapshot({
    model: 'managed-context-model',
    model_loaded: true,
    engine: 'ollama',
    native_context_length: 262144,
    configured_context_length: 131072,
    effective_context_length: 65536,
  });

  const status = await service.refreshStatusSnapshot();

  assert.equal(status.native_context_length, 262144);
  assert.equal(status.configured_context_length, 131072);
  assert.equal(status.effective_context_length, 65536);
});

test('managed sidecar model-resolution failure rejects the turn without leaking active state', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_preflight_no_model';
  service.currentModel = '';
  service.sessionStore.createSessionWithId(sessionId, {});
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service._resolveModel = async () => {
    throw new Error('No model is available for managed chat.');
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'send with no managed model',
    runtimePreferredModel: '',
    normalizedPreferences: { preferred_model: '' },
  }));
  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const errors = service.emittedEvents.filter(
    (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0].payload.message, /No model is available for managed chat\./);
  assert.equal(service.activeStreams.size, 0);
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
});

test('managed sidecar first send lazy-loads and resolves the shell default model', async (t) => {
  const service = new BackendService({
    userDataPath: createTrackedTempDir('jenny-managed-default-model-'),
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
  t.after(() => service.stop());
  markManagedSidecarReady(service);
  const logs = collectServiceLogs(service);
  service.currentModel = '';
  service.listModels = async () => ({ active_model: '', data: [] });
  const modelLoads = [];
  service.loadModel = async (model) => {
    modelLoads.push(model);
    return { status: 'loaded', model };
  };
  service.sidecarClient = {
    connected: true,
    dispose() {},
    async chatSend(_params, { onNotification }) {
      onNotification({ method: 'chat.token', params: { delta: 'Default loaded.' } });
      onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };
  const created = await service.createSession({ title: 'Lazy default' });

  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Use the shell default model',
  });
  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.deepEqual(modelLoads, [DEFAULT_MANAGED_SHELL_MODEL]);
  assert.equal(service.currentModel, DEFAULT_MANAGED_SHELL_MODEL);
  const messages = await service.getSessionMessages(created.data.id);
  assert.equal(messages.data.at(-1).model_used, DEFAULT_MANAGED_SHELL_MODEL);
  const started = logs.find(
    (entry) => entry.event === 'backend.model_lazy_load_started'
  );
  assert.equal(started.level, 'INFO');
  assert.deepEqual(started.details, {
    requestedModel: DEFAULT_MANAGED_SHELL_MODEL,
    reason: 'shell_default_model',
  });
});
