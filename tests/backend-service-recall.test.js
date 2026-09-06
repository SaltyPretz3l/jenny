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

test('backend service recalls approved memories through the managed sidecar request path', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-recall-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  const captured = [];
  service.sidecarManager = {
    getStatus() {
      return { phase: 'ready' };
    },
  };
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
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
    },
  };

  const result = await service.recallApprovedMemories('tea please', 3);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'memory.recall');
  assert.equal(captured[0].params.query, 'tea please');
  assert.equal(captured[0].params.limit, 3);
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].lesson_kind, 'preference');
});

test('backend service recalls recent approved memories by lesson kind through the managed sidecar request path', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-recall-recent-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  const captured = [];
  service.sidecarManager = {
    getStatus() {
      return { phase: 'ready' };
    },
  };
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
      return {
        memories: [
          {
            title: 'Response style: concise',
            lesson_text: 'Use concise answers unless the user asks for more detail.',
            lesson_kind: 'response_style',
            confidence: 0.93,
            source_excerpt: 'be concise',
            content_fingerprint: `sha256:${'a'.repeat(64)}`,
          },
        ],
        next_cursor: '1',
      };
    },
  };

  const result = await service.recallRecentApprovedMemories('response_style', 2);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'memory.recall_recent');
  assert.equal(captured[0].params.lesson_kind, 'response_style');
  assert.equal(captured[0].params.limit, 2);
  assert.equal(result.memories.length, 1);
  assert.equal(result.memories[0].lesson_kind, 'response_style');
});

test('backend service lists approved memories through the managed sidecar request path', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-list-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  const captured = [];
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
      if (params.cursor === '1') {
        return {
          memories: [
            {
              id: 2,
              title: 'Preference: tea',
              lesson_text: 'The user prefers tea.',
              lesson_kind: 'preference',
              confidence: 0.9,
              source_excerpt: 'tea',
              content_fingerprint: `sha256:${'b'.repeat(64)}`,
            },
          ],
          next_cursor: null,
        };
      }
      return {
        memories: [
          {
            id: 1,
            title: 'Response style: concise',
            lesson_text: 'Use concise answers unless the user asks for more detail.',
            lesson_kind: 'response_style',
            confidence: 0.93,
            source_excerpt: 'be concise',
            content_fingerprint: `sha256:${'a'.repeat(64)}`,
          },
        ],
        next_cursor: '1',
      };
    },
  };

  const result = await service.listApprovedMemories();

  assert.equal(captured.length, 2);
  assert.equal(captured[0].method, 'memory.list');
  assert.equal(captured[0].params.cursor, null);
  assert.equal(captured[0].params.limit, 250);
  assert.equal(captured[1].params.cursor, '1');
  assert.equal(result.memories.length, 2);
  assert.equal(result.memories[0].lesson_kind, 'response_style');
});

test('backend service lists pending memories through the managed sidecar request path', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-pending-list-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  const captured = [];
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
      return {
        candidates: [
          {
            session_id: 'session-2',
            title: 'Goal: finish the garden',
            lesson_text: "The user's goal is to finish the garden.",
            lesson_kind: 'goal',
            confidence: 0.91,
            source_excerpt: 'finish the garden',
            content_fingerprint: 'goal:the-user-s-goal-is-to-finish-the-garden',
          },
        ],
      };
    },
  };

  const result = await service.listPendingMemories();

  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'memory.pending.list');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].lesson_kind, 'goal');
});

test('backend service updates approved memories through the managed sidecar request path', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-update-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  const captured = [];
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
      return {
        updated: true,
        memory: {
          id: 7,
          title: 'Preference: green tea',
          lesson_text: 'The user prefers green tea over coffee.',
          lesson_kind: 'preference',
          confidence: 0.95,
          source_excerpt: 'I prefer tea over coffee',
          content_fingerprint: 'preference:the-user-prefers-green-tea-over-coffee',
        },
      };
    },
  };

  const result = await service.updateApprovedMemory(7, {
    title: 'Preference: green tea',
    lesson_text: 'The user prefers green tea over coffee.',
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'memory.update');
  assert.equal(captured[0].params.memory_id, 7);
  assert.equal(captured[0].params.patch.title, 'Preference: green tea');
  assert.equal(result.updated, true);
  assert.equal(result.memory.lesson_kind, 'preference');
});

test('backend service deletes approved memories through the managed sidecar request path', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-delete-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  const captured = [];
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
      return {
        deleted: true,
        memory_id: 9,
      };
    },
  };

  const result = await service.deleteApprovedMemory(9);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'memory.delete');
  assert.equal(captured[0].params.memory_id, 9);
  assert.deepEqual(result, { deleted: true, memory_id: 9 });
});

test('backend service deletes pending memories through the managed sidecar request path', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-pending-delete-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  const captured = [];
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
      return {
        deleted: true,
      };
    },
  };

  const result = await service.deletePendingMemory('session-3', 'Goal:School-Pickup');

  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'memory.pending.delete');
  assert.equal(captured[0].params.session_id, 'session-3');
  assert.equal(captured[0].params.content_fingerprint, 'goal:school-pickup');
  assert.deepEqual(result, { deleted: true });
});

test('backend service inspects the harness through the managed sidecar request path', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-harness-inspect-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  const captured = [];
  service.sidecarManager = {
    getStatus() {
      return { phase: 'ready' };
    },
  };
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
      return {
        generated_at: '2026-04-03T00:00:00.000Z',
        sections: ['tools'],
        tools: {
          items: [
            {
              name: 'inspect_harness',
              enabled: true,
              use_count: 0,
            },
          ],
        },
      };
    },
  };

  const result = await service.inspectHarness({
    sections: ['tools'],
    include_recent_history: false,
  });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'harness.inspect');
  assert.deepEqual(captured[0].params.sections, ['tools']);
  assert.equal(captured[0].params.include_recent_history, false);
  assert.equal(result.tools.items[0].name, 'inspect_harness');
});

test('backend service returns an empty harness snapshot when sidecar is not ready', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-harness-inspect-not-ready-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  const captured = [];
  service.sidecarManager = {
    getStatus() {
      return { phase: 'starting' };
    },
  };
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
      return {};
    },
  };

  const result = await service.inspectHarness({
    sections: ['runtime'],
  });

  assert.equal(captured.length, 0);
  assert.deepEqual(result.sections, []);
  assert.deepEqual(result.runtime, {});
});

test('backend service forwards the existing memory status RPC in managed mode', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-status-'));
  trackDirectory(userDataPath);
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });
  const captured = [];
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
      return {
        available: true,
        counts: { approved: 3, pending: 1 },
        degraded_reasons: [],
      };
    },
  };

  const status = await service.getMemoryStatus();

  assert.equal(captured[0].method, 'memory.status');
  assert.equal(typeof captured[0].params.accept_version, 'string');
  assert.notEqual(captured[0].params.accept_version, '');
  assert.equal(status.counts.approved, 3);
});

test('backend service bounds a managed memory status request failure', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-status-failure-'));
  trackDirectory(userDataPath);
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });
  const logs = collectServiceLogs(service);
  service.sidecarClient = { async request() { throw new Error('C:/secret/private-sidecar.log'); } };

  const status = await service.getMemoryStatus();

  assert.equal(status.available, false);
  assert.deepEqual(status.degraded_reasons, ['sidecar_request_failed']);
  assert.equal(logs.some((entry) => entry.event === 'memory.status_unavailable'
    && entry.details?.reason === 'sidecar_request_failed'), true);
  assert.doesNotMatch(JSON.stringify(logs), /secret|private-sidecar/i);
});

test('backend service leaves recall query construction to sidecar', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-query-'));
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
    title: 'Recall Query Session',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'assistant_1',
    role: 'assistant',
    content: 'Assistant context should not be used.',
    timestamp: '2026-03-16T00:00:00.000Z',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'user_1',
    role: 'user',
    content: 'Older plain user note',
    timestamp: '2026-03-16T00:01:00.000Z',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'toolish_1',
    role: 'user',
    kind: 'tool_result',
    content: 'Tool-shaped user content should be ignored.',
    timestamp: '2026-03-16T00:02:00.000Z',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'user_2',
    role: 'user',
    content: 'I prefer tea over coffee.',
    timestamp: '2026-03-16T00:03:00.000Z',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'user_3',
    role: 'user',
    content: 'Green tea works well.',
    timestamp: '2026-03-16T00:04:00.000Z',
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
    prompt: 'Should I have that this afternoon?',
  });
  await completed;

  const recallRequest = capturedRequests.find((entry) => entry.method === 'memory.recall');
  assert.equal(recallRequest, undefined);
  const chatRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.equal(chatRequest.params.memory_policy.enabled, true);
});

test('backend service sends one memory policy when the prompt duplicates history', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-query-duplicate-'));
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
    title: 'Recall Query Duplicate Session',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'user_dup_1',
    role: 'user',
    content: 'I prefer tea over coffee.',
    timestamp: '2026-03-16T00:01:00.000Z',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'user_dup_2',
    role: 'user',
    content: 'Should I have that this afternoon?',
    timestamp: '2026-03-16T00:02:00.000Z',
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
    prompt: 'Should I have that this afternoon?',
  });
  await completed;

  const recallRequest = capturedRequests.find((entry) => entry.method === 'memory.recall');
  assert.equal(recallRequest, undefined);
  const chatRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.deepEqual(chatRequest.params.memory_policy, {
    enabled: true,
    include_response_style: true,
  });
});
