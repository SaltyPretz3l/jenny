const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const {
  startManagedSidecarChatStream,
} = require('../../services/backend/managed-sidecar-chat');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createManagedChatServiceStub(store) {
  return {
    activeStreams: new Map(),
    pendingToolApprovals: new Map(),
    currentModel: 'mock-v1',
    personalityWorkspace: null,
    attachmentAssetStore: null,
    sidecarClient: null,
    sessionStore: store,
    emit() {},
    _emitServiceLog() {},
    async _resolveModel() {
      return 'mock-v1';
    },
    async recallApprovedMemories() {
      return { memories: [] };
    },
    async recallRecentApprovedMemories() {
      return { memories: [] };
    },
    async setSessionPreferences(sessionId, preferences) {
      store.setSessionPreferences(sessionId, preferences);
    },
    async renameSession(sessionId, title) {
      store.renameSession(sessionId, title);
    },
    async _restartManagedSidecar() {},
  };
}

test('managed sidecar chat forwards session_start_date and persists tool search metadata for reload', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-resume-meta-'));
  trackDirectory(userDataPath);

  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  store.createSessionWithId('sess_resume_meta', {
    title: 'Resume Metadata',
    preferences: {
      session_start_date: '2026-03-27',
    },
  });

  const service = createManagedChatServiceStub(store);
  const captured = {};
  service.sidecarClient = {
    chatSend: async (params, options = {}) => {
      captured.params = params;
      options.onNotification({
        method: 'tool.executing',
        params: {
          request_id: params.request_id,
          session_id: params.session_id,
          tool_name: 'tool_search',
          tool_call_id: 'call_tool_search_1',
          tool_input: { query: 'git commit' },
        },
      });
      options.onNotification({
        method: 'tool.result',
        params: {
          request_id: params.request_id,
          session_id: params.session_id,
          tool_name: 'tool_search',
          tool_call_id: 'call_tool_search_1',
          tool_input: { query: 'git commit' },
          success: true,
          output: 'Found 1 tool(s):\n- mcp__git__commit: Commit changes',
          metadata: {
            kind: 'tool_search_result',
            discovered_tools: ['mcp__git__commit'],
            read_snapshot: {
              path: 'notes.txt',
              scope: 'full',
              size_bytes: 6,
              mtime_ns: 123,
              sha256: 'abc123',
            },
          },
        },
      });
      options.onNotification({
        method: 'chat.token',
        params: {
          request_id: params.request_id,
          session_id: params.session_id,
          delta: 'Done.',
          role: 'assistant',
        },
      });
      options.onNotification({
        method: 'chat.done',
        params: {
          request_id: params.request_id,
          session_id: params.session_id,
          usage: {
            input_tokens: 8,
            output_tokens: 4,
            total_tokens: 12,
            provider: 'mock',
            model: 'mock-v1',
          },
        },
      });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'sess_resume_meta',
    prompt: 'Find the git commit tool',
    visiblePrompt: 'Find the git commit tool',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });
  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const reloaded = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const toolUseMessage = reloaded.getSessionMessages(stream.sessionId).find(
    (message) => message.kind === 'tool_use'
  );
  const toolResultMessage = reloaded.getSessionMessages(stream.sessionId).find(
    (message) => message.kind === 'tool_result'
  );

  assert.equal(captured.params.session_start_date, '2026-03-27');
  assert.ok(toolUseMessage);
  assert.deepEqual(toolUseMessage.tool_call.input, {
    query: 'git commit',
  });
  assert.ok(toolResultMessage);
  assert.deepEqual(toolResultMessage.tool_result.metadata, {
    kind: 'tool_search_result',
    discovered_tools: ['mcp__git__commit'],
    late_events: [],
    read_snapshot: {
      path: 'notes.txt',
      scope: 'full',
      size_bytes: 6,
      mtime_ns: 123,
      sha256: 'abc123',
    },
  });
});

test('managed sidecar chat recovers an orphaned active_turn before starting a fresh actor-owned turn', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-resume-active-turn-'));
  trackDirectory(userDataPath);

  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  store.createSessionWithId('sess_resume_turn', {
    title: 'Resume Turn',
  });
  store.appendMessage('sess_resume_turn', {
    id: 'user_prev',
    role: 'user',
    content: 'Continue the interrupted task',
    client_message_id: 'user_prev',
  });
  store.setActiveTurn('sess_resume_turn', {
    request_id: 'req_prev',
    stream_id: 'stream_prev',
    user_message_id: 'user_prev',
    started_at: '2026-04-09T10:00:00.000Z',
    last_event_at: '2026-04-09T10:00:30.000Z',
    status: 'streaming',
  });

  const service = createManagedChatServiceStub(store);
  const captured = {};
  let resolveChatSend;
  service.sidecarClient = {
    chatSend: async (params, options = {}) => {
      captured.params = params;
      captured.activeTurnDuringSend = store.getActiveTurn(params.session_id);
      options.onNotification({
        method: 'chat.token',
        params: {
          request_id: params.request_id,
          session_id: params.session_id,
          delta: 'Recovered cleanly.',
          role: 'assistant',
        },
      });
      options.onNotification({
        method: 'chat.done',
        params: {
          request_id: params.request_id,
          session_id: params.session_id,
        },
      });
      return new Promise((resolve) => {
        resolveChatSend = resolve;
      });
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'sess_resume_turn',
    prompt: 'Finish the interrupted work',
    visiblePrompt: 'Finish the interrupted work',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const controller = service.activeStreams.get(stream.streamId);
  const resumeMessages = captured.params.messages.filter(
    (message) => message.role === 'user'
  );
  assert.equal(resumeMessages[0].content, 'Continue the interrupted task');
  assert.equal(
    resumeMessages.some((message) => /Resume the interrupted turn/i.test(message.content)),
    false
  );
  assert.deepEqual(captured.activeTurnDuringSend, {
    request_id: stream.streamId,
    stream_id: stream.streamId,
    turn_id: stream.streamId,
    session_incarnation: captured.activeTurnDuringSend.session_incarnation,
    generation: 1,
    trace_id: stream.streamId,
    user_message_id: `user_${stream.streamId}`,
    started_at: captured.activeTurnDuringSend.started_at,
    last_event_at: captured.activeTurnDuringSend.last_event_at,
    status: 'awaiting_assistant',
  });

  resolveChatSend({ status: 'completed' });
  await controller._pendingPromise;

  assert.equal(store.getActiveTurn('sess_resume_turn'), null);
});
