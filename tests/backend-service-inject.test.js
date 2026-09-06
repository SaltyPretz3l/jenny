const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');
const {
  waitForChatStreamEvent,
  collectServiceLogs,
} = require('./helpers/backend-service-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function markManagedSidecarReady(service) {
  service.sidecarManager.process = { pid: 4242 };
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  // These suites must never touch a real local Ollama runtime (same contract
  // as tests/helpers/managed-sidecar-runtime-helpers.js). Without this stub
  // the managed chat path live-probes/starts Ollama on the host: ~10s per
  // affected test on a quiet machine, and unbounded retry/probe timer chains
  // under full-suite load -- the process then outlives its per-file watchdog
  // (root cause of the 2026-07-20 backend-service-inject timeouts once the
  // sequential lane overlapped the parallel pool).
  service.ollamaManager.ensureRunning = async () => ({
    ready: true,
    started: false,
    external: false,
    skipped: true,
  });
  service.ollamaManager.start = async () => ({ started: false, external: false, skipped: true });
  service.ollamaManager.stop = async () => {};
}

test('backend service forwards memory policy without request-time recall', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-context-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });
  markManagedSidecarReady(service);
  const created = await service.createSession({
    title: 'Memory Context Session',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'user_memory_context_1',
    role: 'user',
    content: 'I prefer tea over coffee.',
    timestamp: '2026-03-16T00:05:00.000Z',
  });

  const completed = new Promise((resolve) => {
    service.on('chat-stream', (event) => {
      if (event.type === 'complete') {
        resolve(event);
      }
    });
  });
  const capturedRequests = [];
  service._resolveModel = async () => 'mock-v1';
  service.sidecarClient = {
    async request(method, params) {
      capturedRequests.push({ method, params });
      if (method === 'memory.recall') {
        return {
          memories: [
            {
              title: 'Preference: tea',
              lesson_text: 'The user prefers tea over coffee.',
              lesson_kind: 'preference',
              confidence: 0.95,
              source_excerpt: 'I prefer tea over coffee',
              content_fingerprint: 'preference:the-user-prefers-tea-over-coffee',
            },
          ],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
    async chatSend(params, { onNotification }) {
      capturedRequests.push({ method: 'chat.send', params });
      onNotification({
        method: 'chat.token',
        params: { request_id: params.request_id, session_id: params.session_id, delta: 'Hello ' },
      });
      onNotification({
        method: 'chat.token',
        params: { request_id: params.request_id, session_id: params.session_id, delta: 'again' },
      });
      onNotification({
        method: 'chat.done',
        params: { request_id: params.request_id, session_id: params.session_id },
      });
      return { status: 'completed' };
    },
  };

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Should I have that this afternoon?',
  });
  await completed;

  const recallRequest = capturedRequests.find((entry) => entry.method === 'memory.recall');
  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.equal(recallRequest, undefined);
  assert.ok(chatSendRequest);
  assert.deepEqual(chatSendRequest.params.memory_policy, {
    enabled: true,
    include_response_style: true,
  });
  assert.equal(chatSendRequest.params.learning_context, undefined);
});

test('backend service records managed phase percentiles from summary and provider diagnostics', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-phase-percentiles-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });
  markManagedSidecarReady(service);
  const created = await service.createSession({
    title: 'Phase Percentiles Session',
  });
  const completed = waitForChatStreamEvent(service, (event) => event.type === 'complete');
  const capturedRequests = [];
  service._resolveModel = async () => 'mock-v1';
  service.sidecarClient = {
    async chatSend(params, { onNotification }) {
      capturedRequests.push({ method: 'chat.send', params });
      onNotification({
        method: 'chat.token',
        params: { request_id: params.request_id, session_id: params.session_id, delta: 'Measured' },
      });
      onNotification({
        method: 'chat.done',
        params: { request_id: params.request_id, session_id: params.session_id },
      });
      return { status: 'completed' };
    },
    async harnessTurnDiagnostic(params) {
      capturedRequests.push({ method: 'harness.turn_diagnostic', params });
      return {
        provider_diagnostics: {
          time_to_provider_request_start_ms: 14,
          time_to_first_chunk_ms: 80,
          time_to_first_visible_token_ms: 105,
        },
      };
    },
  };

  const startedAt = Date.now() - 24;
  const optimisticAt = Date.now() - 9;
  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Please measure this plain turn.',
    contextPreferences: {
      history_scope: 'session',
      include_personality: false,
      include_memory: false,
      include_git_context: false,
    },
    clientTiming: {
      send_started_at_ms: startedAt,
      optimistic_rendered_at_ms: optimisticAt,
      local_render_latency_ms: optimisticAt - startedAt,
    },
  });
  const pending = service.activeStreams.get(stream.streamId)?._pendingPromise;
  await completed;
  await pending;

  const snapshot = await service.getPhasePercentilesSnapshot();
  assert.equal(snapshot.phases.click_to_optimistic_render.count, 1);
  assert.equal(snapshot.phases.context_assembly_elapsed_no_memory_git.count, 1);
  assert.equal(snapshot.phases.sidecar_request_sent_to_provider_request_start.p50, 14);
  assert.equal(snapshot.phases.provider_request_start_to_first_chunk.p50, 80);
  assert.equal(snapshot.phases.first_chunk_to_first_visible_token.p50, 25);
  assert.equal(snapshot.phases.completion_to_terminal_persist.count, 1);
  assert.ok(capturedRequests.some((entry) => entry.method === 'harness.turn_diagnostic'));
});

test('backend service delegates all memory kinds to sidecar recall', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-new-kinds-context-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });
  markManagedSidecarReady(service);
  const created = await service.createSession({
    title: 'Memory New Kinds Context Session',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'user_memory_new_kinds_context_1',
    role: 'user',
    content: 'Every morning I stretch and make tea with Alex while we plan the garden.',
    timestamp: '2026-03-18T00:05:00.000Z',
  });

  const completed = new Promise((resolve) => {
    service.on('chat-stream', (event) => {
      if (event.type === 'complete') {
        resolve(event);
      }
    });
  });
  const capturedRequests = [];
  service._resolveModel = async () => 'mock-v1';
  service.sidecarClient = {
    async request(method, params) {
      capturedRequests.push({ method, params });
      if (method === 'memory.recall') {
        return {
          memories: [
            {
              title: 'Routine: morning tea',
              lesson_text: "The user's morning routine includes stretching and tea.",
              lesson_kind: 'routine',
              confidence: 0.9,
              source_excerpt: 'Every morning I stretch and make tea',
              content_fingerprint: 'routine:the-user-s-morning-routine-includes-stretching-and-tea',
            },
            {
              title: 'Goal: finish the garden',
              lesson_text: "The user's goal is to finish the garden this spring.",
              lesson_kind: 'goal',
              confidence: 0.92,
              source_excerpt: 'finish the garden',
              content_fingerprint: 'goal:the-user-s-goal-is-to-finish-the-garden-this-spring',
            },
            {
              title: 'Important person: Alex (friend)',
              lesson_text: "The user's friend is Alex.",
              lesson_kind: 'important_person',
              confidence: 0.89,
              source_excerpt: 'Alex',
              content_fingerprint: 'important_person:the-user-s-friend-is-alex',
            },
          ],
        };
      }
      if (method === 'memory.recall_recent') {
        return { memories: [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
    async chatSend(params, { onNotification }) {
      capturedRequests.push({ method: 'chat.send', params });
      onNotification({
        method: 'chat.token',
        params: { request_id: params.request_id, session_id: params.session_id, delta: 'Okay' },
      });
      onNotification({
        method: 'chat.done',
        params: { request_id: params.request_id, session_id: params.session_id },
      });
      return { status: 'completed' };
    },
  };

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'What should I keep in mind for Saturday?',
  });
  await completed;

  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.ok(chatSendRequest);
  assert.equal(capturedRequests.some((entry) => entry.method === 'memory.recall'), false);
  assert.equal(chatSendRequest.params.memory_policy.enabled, true);
  assert.equal(chatSendRequest.params.learning_context, undefined);
});

test('backend service does not inject unsupported commitment memories into managed sidecar learning_context', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-commitment-filter-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });
  markManagedSidecarReady(service);
  const created = await service.createSession({
    title: 'Memory Commitment Filter Session',
  });

  const completed = new Promise((resolve) => {
    service.on('chat-stream', (event) => {
      if (event.type === 'complete') {
        resolve(event);
      }
    });
  });
  const capturedRequests = [];
  service._resolveModel = async () => 'mock-v1';
  service.sidecarClient = {
    async request(method, params) {
      capturedRequests.push({ method, params });
      if (method === 'memory.recall') {
        return {
          memories: [
            {
              title: 'Commitment: school pickup',
              lesson_text: 'Pick up Sam from school at 3 PM.',
              lesson_kind: 'commitment',
              confidence: 0.95,
              source_excerpt: 'Pick up Sam from school at 3 PM',
              content_fingerprint: 'commitment:pick-up-sam-from-school-at-3-pm',
            },
          ],
        };
      }
      if (method === 'memory.recall_recent') {
        return { memories: [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
    async chatSend(params, { onNotification }) {
      capturedRequests.push({ method: 'chat.send', params });
      onNotification({
        method: 'chat.token',
        params: { request_id: params.request_id, session_id: params.session_id, delta: 'Okay' },
      });
      onNotification({
        method: 'chat.done',
        params: { request_id: params.request_id, session_id: params.session_id },
      });
      return { status: 'completed' };
    },
  };

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'What should I do later today?',
  });
  await completed;

  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.ok(chatSendRequest);
  assert.equal(
    Object.prototype.hasOwnProperty.call(chatSendRequest.params, 'learning_context'),
    false
  );
});

test('backend service skips managed memory recall when context preferences disable memory injection', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-disabled-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });
  markManagedSidecarReady(service);
  const logs = collectServiceLogs(service);
  const created = await service.createSession({
    title: 'Memory Disabled Session',
    preferences: {
      context_preferences: {
        include_memory: false,
      },
    },
  });

  const completed = new Promise((resolve) => {
    service.on('chat-stream', (event) => {
      if (event.type === 'complete') {
        resolve(event);
      }
    });
  });
  const capturedRequests = [];
  service._resolveModel = async () => 'mock-v1';
  service.sidecarClient = {
    async request(method) {
      capturedRequests.push({ method });
      throw new Error(`Unexpected method: ${method}`);
    },
    async chatSend(params, { onNotification }) {
      capturedRequests.push({ method: 'chat.send', params });
      onNotification({
        method: 'chat.token',
        params: { request_id: params.request_id, session_id: params.session_id, delta: 'Okay' },
      });
      onNotification({
        method: 'chat.done',
        params: { request_id: params.request_id, session_id: params.session_id },
      });
      return { status: 'completed' };
    },
  };

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Should I have tea this afternoon?',
  });
  await completed;

  assert.equal(capturedRequests.some((entry) => entry.method === 'memory.recall'), false);
  assert.equal(capturedRequests.some((entry) => entry.method === 'memory.recall_recent'), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      capturedRequests.find((entry) => entry.method === 'chat.send').params,
      'learning_context'
    ),
    false
  );
  assert.equal(
    logs.some(
      (entry) =>
        entry.event === 'memory.recall_skipped'
        && entry.details?.reason === 'context_preferences_include_memory_disabled'
    ),
    true
  );
});

test('backend service skips personality system injection when context preferences disable personality context', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-personality-disabled-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
    personalityWorkspace: {
      getCompiledContext: async () => '## SOUL\n\nBe warm and focused.',
    },
  });
  markManagedSidecarReady(service);
  const created = await service.createSession({
    title: 'Personality Disabled Session',
    preferences: {
      context_preferences: {
        include_personality: false,
      },
    },
  });

  const completed = new Promise((resolve) => {
    service.on('chat-stream', (event) => {
      if (event.type === 'complete') {
        resolve(event);
      }
    });
  });
  const capturedRequests = [];
  service._resolveModel = async () => 'mock-v1';
  service.sidecarClient = {
    async request(method, params) {
      capturedRequests.push({ method, params });
      if (method === 'memory.recall') {
        return { memories: [] };
      }
      if (method === 'memory.recall_recent') {
        return { memories: [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
    async chatSend(params, { onNotification }) {
      capturedRequests.push({ method: 'chat.send', params });
      onNotification({
        method: 'chat.token',
        params: { request_id: params.request_id, session_id: params.session_id, delta: 'Okay' },
      });
      onNotification({
        method: 'chat.done',
        params: { request_id: params.request_id, session_id: params.session_id },
      });
      return { status: 'completed' };
    },
  };

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'How should we proceed?',
  });
  await completed;

  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.ok(chatSendRequest);
  assert.equal(chatSendRequest.params.messages[0].role, 'user');
  assert.equal(chatSendRequest.params.messages[0].content, 'How should we proceed?');
  // messages[0] alone cannot prove suppression: personality rides in typed
  // context_blocks / system content, which this test never looked at. Scan the
  // whole request for the compiled SOUL text instead.
  const serializedRequest = JSON.stringify(chatSendRequest);
  assert.ok(serializedRequest.length > 200, 'guard against scanning a trivially empty request');
  assert.equal(
    serializedRequest.includes('Be warm and focused'),
    false,
    'no part of the request may carry personality when include_personality is false'
  );
});

test('backend service logs managed-sidecar performance diagnostics and forwards debug overrides', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-turn-diagnostics-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'gemma4-e4b-it-q6_k:latest',
  });
  markManagedSidecarReady(service);
  const logs = collectServiceLogs(service);
  const created = await service.createSession({
    title: 'Turn Diagnostics Session',
    preferences: { plan_mode: true },
  });

  const completed = new Promise((resolve) => {
    service.on('chat-stream', (event) => {
      if (event.type === 'complete') {
        resolve(event);
      }
    });
  });
  const capturedRequests = [];
  service._resolveModel = async () => 'gemma4-e4b-it-q6_k:latest';
  service.sidecarClient = {
    async request(method) {
      capturedRequests.push({ method });
      throw new Error(`Unexpected method: ${method}`);
    },
    async chatSend(params, { onNotification }) {
      capturedRequests.push({ method: 'chat.send', params });
      onNotification({
        method: 'chat.token',
        params: { request_id: params.request_id, session_id: params.session_id, delta: 'Measured.' },
      });
      onNotification({
        method: 'chat.done',
        params: { request_id: params.request_id, session_id: params.session_id },
      });
      return { status: 'completed' };
    },
  };

  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Measure a fresh turn.',
    preferredModel: 'gemma4-e4b-it-q6_k:latest',
    planMode: true,
    debugOptions: {
      disableThinking: true,
      leanContext: true,
      plainChatMode: true,
    },
  });
  const pending = service.activeStreams.get(stream.streamId)?._pendingPromise;
  await completed;
  await pending;

  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.ok(chatSendRequest);
  assert.equal(chatSendRequest.params.mode, 'chat');
  assert.equal(chatSendRequest.params.plan_mode, false);
  assert.equal(service.sessionStore.getSession(created.data.id).plan_mode, true);
  assert.deepEqual(chatSendRequest.params.debug_options, {
    disable_thinking: true,
    lean_context: true,
    plain_chat_mode: true,
  });
  assert.equal(capturedRequests.some((entry) => entry.method === 'memory.recall'), false);
  assert.equal(capturedRequests.some((entry) => entry.method === 'memory.recall_recent'), false);
  assert.equal(chatSendRequest.params.messages.length, 1);
  assert.equal(chatSendRequest.params.messages[0].role, 'user');

  const summaryLog = logs.find((entry) => entry.event === 'chat.performance_turn_summary');
  assert.ok(summaryLog);
  assert.equal(summaryLog.details.mode, 'chat');
  assert.equal(summaryLog.details.history_scope, 'fresh');
  assert.equal(summaryLog.details.include_personality, false);
  assert.equal(summaryLog.details.include_memory, false);
  assert.equal(summaryLog.details.include_git_context, false);
  assert.equal(summaryLog.details.message_count, 1);
  assert.equal(summaryLog.details.system_message_count, 0);

  const contributionLog = logs.find((entry) => entry.event === 'chat.prompt_contributions');
  assert.ok(contributionLog);
  assert.equal(contributionLog.details.contributions.base_history.message_count, 0);
  assert.equal(contributionLog.details.contributions.current_user_prompt.message_count, 1);
  assert.ok(contributionLog.details.contributions.current_user_prompt.approx_tokens > 0);

  const eventNames = logs.map((entry) => entry.event);
  assert.ok(eventNames.includes('chat.context_assembly_started'));
  assert.ok(eventNames.includes('chat.context_assembly_completed'));
  assert.ok(eventNames.includes('chat.sidecar_request_sent'));
  assert.ok(eventNames.includes('chat.sidecar_request_settled'));
  assert.ok(
    eventNames.indexOf('chat.context_assembly_started')
      < eventNames.indexOf('chat.context_assembly_completed')
  );
  assert.ok(
    eventNames.indexOf('chat.context_assembly_completed')
      < eventNames.indexOf('chat.sidecar_request_sent')
  );
  assert.ok(
    eventNames.indexOf('chat.sidecar_request_sent')
      < eventNames.indexOf('chat.sidecar_request_settled')
  );

  const contextCompletedLog = logs.find((entry) => entry.event === 'chat.context_assembly_completed');
  assert.equal(contextCompletedLog.details.included_personality, false);
  assert.equal(contextCompletedLog.details.included_memory, false);
  assert.equal(contextCompletedLog.details.included_git_context, false);
});

test('backend service keeps managed sends free of companion mode framing (retired) with personality and plan mode intact', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-companion-managed-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
    personalityWorkspace: {
      getCompiledContext: async () => '## SOUL\n\nBe warm and focused.',
    },
    configService: {
      getState() {
        return {
          companion: {
            mode: 'coach',
          },
        };
      },
    },
  });
  markManagedSidecarReady(service);
  const created = await service.createSession({
    title: 'Companion Managed Session',
  });

  const completed = new Promise((resolve) => {
    service.on('chat-stream', (event) => {
      if (event.type === 'complete') {
        resolve(event);
      }
    });
  });
  const capturedRequests = [];
  service._resolveModel = async () => 'mock-v1';
  service.sidecarClient = {
    async request(method, params) {
      capturedRequests.push({ method, params });
      if (method === 'memory.recall' || method === 'memory.recall_recent') {
        return { memories: [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
    async chatSend(params, { onNotification }) {
      capturedRequests.push({ method: 'chat.send', params });
      onNotification({
        method: 'chat.token',
        params: { request_id: params.request_id, session_id: params.session_id, delta: 'Okay' },
      });
      onNotification({
        method: 'chat.done',
        params: { request_id: params.request_id, session_id: params.session_id },
      });
      return { status: 'completed' };
    },
  };

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Help me choose what to do next.',
    planMode: true,
  });
  await completed;

  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.ok(chatSendRequest);
  assert.deepEqual(chatSendRequest.params.context_blocks, [
    { kind: 'personality', content: '## SOUL\n\nBe warm and focused.' },
  ]);
  assert.equal(chatSendRequest.params.messages[0].role, 'user');
  assert.equal(chatSendRequest.params.messages[0].content, 'Help me choose what to do next.');
  assert.equal(chatSendRequest.params.messages.some((message) => message.role === 'system'), false);
  // Companion modes are retired: a persisted mode in shell config must not
  // inject framing into the send anymore.
  const promptInputs = [
    ...chatSendRequest.params.messages,
    ...chatSendRequest.params.context_blocks,
  ];
  for (const input of promptInputs) {
    assert.doesNotMatch(String(input.content || ''), /Active companion mode/);
    assert.doesNotMatch(String(input.content || ''), /Plan mode is enabled/);
  }
  assert.equal(chatSendRequest.params.plan_mode, true);
});

test('backend service injects recalled tool-strategy memories without adding recent tool-strategy recall', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-tool-strategy-context-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });
  markManagedSidecarReady(service);
  const created = await service.createSession({
    title: 'Memory Tool Strategy Context Session',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'user_memory_tool_strategy_context_1',
    role: 'user',
    content: 'Prefer apply_patch for small edits.',
    timestamp: '2026-03-16T00:05:00.000Z',
    client_message_id: 'user_memory_tool_strategy_context_1',
  });

  const capturedRequests = [];
  let completeResolve;
  const completed = new Promise((resolve) => {
    completeResolve = resolve;
  });
  service._resolveModel = async () => 'mock-v1';
  service.sidecarClient = {
    async request(method, params) {
      capturedRequests.push({ method, params });
      if (method === 'memory.recall') {
        return {
          memories: [
            {
              title: 'Tool strategy: prefer ripgrep',
              lesson_text: 'For repository text search tasks, prefer rg/ripgrep when it is available.',
              lesson_kind: 'tool_strategy',
              confidence: 0.9,
              source_excerpt: 'Prefer rg',
              content_fingerprint: 'tool_strategy:for-repository-text-search-tasks-prefer-rg-ripgrep-when-it-is-available',
            },
          ],
        };
      }
      if (method === 'memory.recall_recent') {
        return { memories: [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
    async chatSend(params, { onNotification }) {
      capturedRequests.push({ method: 'chat.send', params });
      onNotification({
        method: 'chat.token',
        params: { request_id: params.request_id, session_id: params.session_id, delta: 'Hello ' },
      });
      onNotification({
        method: 'chat.done',
        params: { request_id: params.request_id, session_id: params.session_id },
      });
      completeResolve();
      return { status: 'completed' };
    },
  };

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'What should I use to search repository text?',
  });
  await completed;

  const recentRecallRequests = capturedRequests.filter((entry) => entry.method === 'memory.recall_recent');
  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.ok(chatSendRequest);
  assert.equal(recentRecallRequests.length, 0);
  assert.deepEqual(chatSendRequest.params.memory_policy, {
    enabled: true,
    include_response_style: true,
  });
  assert.equal(chatSendRequest.params.learning_context, undefined);
});

test('backend service injects working-preference and project-context memories through lexical recall only', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-batch-d-context-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });
  markManagedSidecarReady(service);
  const created = await service.createSession({
    title: 'Memory Batch D Context Session',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'user_memory_batch_d_context_1',
    role: 'user',
    content: 'Please diagnose the root cause before proposing fixes.',
    timestamp: '2026-03-17T00:05:00.000Z',
  });

  const capturedRequests = [];
  let completeResolve;
  const completed = new Promise((resolve) => {
    completeResolve = resolve;
  });
  service._resolveModel = async () => 'mock-v1';
  service.sidecarClient = {
    async request(method, params) {
      capturedRequests.push({ method, params });
      if (method === 'memory.recall') {
        return {
          memories: [
            {
              title: 'Working preference: diagnose root cause first',
              lesson_text: 'Diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.',
              lesson_kind: 'working_preference',
              confidence: 0.94,
              source_excerpt: 'diagnose the root cause before proposing fixes',
              content_fingerprint: 'working_preference:diagnose-root-cause-first',
            },
            {
              title: 'Project context: workspace has no git metadata',
              lesson_text: 'This workspace has no .git metadata, so branch and status information are unavailable.',
              lesson_kind: 'project_context',
              confidence: 0.95,
              source_excerpt: 'workspace has no .git metadata',
              content_fingerprint: 'project_context:workspace-has-no-git-metadata',
            },
          ],
        };
      }
      if (method === 'memory.recall_recent') {
        return { memories: [] };
      }
      throw new Error(`Unexpected method: ${method}`);
    },
    async chatSend(params, { onNotification }) {
      capturedRequests.push({ method: 'chat.send', params });
      onNotification({
        method: 'chat.token',
        params: { request_id: params.request_id, session_id: params.session_id, delta: 'Hello ' },
      });
      onNotification({
        method: 'chat.done',
        params: { request_id: params.request_id, session_id: params.session_id },
      });
      completeResolve();
      return { status: 'completed' };
    },
  };

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Can you check git status and debug this failure?',
  });
  await completed;

  const recentRecallRequests = capturedRequests.filter((entry) => entry.method === 'memory.recall_recent');
  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.ok(chatSendRequest);
  assert.equal(recentRecallRequests.length, 0);
  assert.equal(capturedRequests.some((entry) => entry.method === 'memory.recall'), false);
  assert.equal(chatSendRequest.params.memory_policy.enabled, true);
  assert.equal(chatSendRequest.params.learning_context, undefined);
});
