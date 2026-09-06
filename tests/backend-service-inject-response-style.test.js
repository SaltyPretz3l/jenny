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
  collectServiceLogs,
} = require('./helpers/backend-service-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function markManagedSidecarReady(service) {
  service.sidecarManager.process = { pid: 4242 };
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  // These suites must never touch a real local Ollama runtime (same contract
  // as tests/helpers/managed-sidecar-runtime-helpers.js). Mock-model chats
  // skip the Ollama preflight today, but a single non-mock (or empty) model
  // name in a future test would live-probe/start Ollama on the host — the
  // 2026-07-20 backend-service-inject regression.
  service.ollamaManager.ensureRunning = async () => ({
    ready: true,
    started: false,
    external: false,
    skipped: true,
  });
  service.ollamaManager.start = async () => ({ started: false, external: false, skipped: true });
  service.ollamaManager.stop = async () => {};
}

test('backend service forwards sidecar-owned recall and response-style policy', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-combined-context-'));
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
    title: 'Memory Combined Context Session',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'user_memory_context_combo_1',
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
            {
              title: 'Response style: concise',
              lesson_text: 'Use concise answers unless the user asks for more detail.',
              lesson_kind: 'response_style',
              confidence: 0.93,
              source_excerpt: 'be concise',
              content_fingerprint: 'response_style:use-concise-answers-unless-the-user-asks-for-more-detail',
            },
          ],
        };
      }
      if (method === 'memory.recall_recent') {
        return {
          memories: [
            {
              title: 'Response style: concise',
              lesson_text: 'Use concise answers unless the user asks for more detail.',
              lesson_kind: 'response_style',
              confidence: 0.93,
              source_excerpt: 'be concise',
              content_fingerprint: 'response_style:use-concise-answers-unless-the-user-asks-for-more-detail',
            },
            {
              title: 'Response style: step-by-step',
              lesson_text: 'Explain things step by step when helping the user.',
              lesson_kind: 'response_style',
              confidence: 0.91,
              source_excerpt: 'step by step',
              content_fingerprint: 'response_style:explain-things-step-by-step-when-helping-the-user',
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
  const recentRecallRequest = capturedRequests.find((entry) => entry.method === 'memory.recall_recent');
  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.equal(recallRequest, undefined);
  assert.equal(recentRecallRequest, undefined);
  assert.ok(chatSendRequest);
  assert.deepEqual(chatSendRequest.params.memory_policy, {
    enabled: true,
    include_response_style: true,
  });
  assert.equal(chatSendRequest.params.learning_context, undefined);
});

test('backend service skips recent response-style recall when the active prompt already carries style instructions', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-explicit-style-'));
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
    title: 'Memory Explicit Style Session',
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
    prompt: 'Please be concise and answer this directly.',
  });
  await completed;

  assert.equal(capturedRequests.some((entry) => entry.method === 'memory.recall_recent'), false);
  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.equal(chatSendRequest.params.memory_policy.include_response_style, false);
  assert.equal(logs.some((entry) => entry.event === 'memory.recall_recent_skipped'), false);
});

test('backend service has no optional memory RPC timeout on the chat critical path', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-timeout-logging-'));
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
    title: 'Memory Timeout Logging Session',
  });

  const completed = new Promise((resolve) => {
    service.on('chat-stream', (event) => {
      if (event.type === 'complete') {
        resolve(event);
      }
    });
  });
  service._resolveModel = async () => 'mock-v1';
  let chatSendParams;
  let memoryRpcCount = 0;
  service.sidecarClient = {
    async request(method) {
      if (method === 'memory.recall' || method === 'memory.recall_recent') {
        memoryRpcCount += 1;
      }
      throw new Error(`Unexpected method: ${method}`);
    },
    async chatSend(params, { onNotification }) {
      chatSendParams = params;
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
    prompt: 'How should we proceed today?',
  });
  await completed;

  assert.equal(memoryRpcCount, 0);
  assert.equal(chatSendParams.memory_policy.enabled, true);
  assert.equal(logs.some((entry) => entry.event === 'memory.recall_failed'), false);
});
