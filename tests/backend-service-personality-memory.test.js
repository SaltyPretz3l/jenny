const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const {
  MAX_DISMISSED_MEMORY_FINGERPRINTS,
} = require('../services/backend/backend-service');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
  trackPort,
} = require('./helpers/resource-cleanup');
const {
  waitForChatStreamEvent,
  collectServiceLogs,
  createMockToolExecutor,
} = require('./helpers/backend-service-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createBackendService(options) {
  return new BackendService({
    safeStorage: createFakeSafeStorage(),
    isSafeStorageReady: () => true,
    ...options,
  });
}

test('backend service suggests memories through the managed sidecar request path', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-managed-'));
  trackDirectory(userDataPath);

  const service = createBackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  const created = await service.createSession({
    title: 'Memory Session',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'user_memory_1',
    role: 'user',
    content: 'I prefer tea over coffee.',
    timestamp: new Date().toISOString(),
  });

  const captured = [];
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
      return {
        suggestions: [
          {
            title: 'Preference: tea over coffee',
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

  const result = await service.suggestMemoriesForSession(created.data.id);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'memory.suggest');
  assert.equal(captured[0].params.session_id, created.data.id);
  assert.equal(captured[0].params.messages[0].content, 'I prefer tea over coffee.');
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].lesson_kind, 'preference');
});

test('backend service forwards tool-strategy suggestions through the managed sidecar request path', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-managed-tool-strategy-'));
  trackDirectory(userDataPath);

  const service = createBackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  const created = await service.createSession({
    title: 'Memory Tool Strategy Session',
  });
  service.sessionStore.appendMessage(created.data.id, {
    id: 'user_memory_tool_strategy_1',
    role: 'user',
    content: 'Prefer rg when searching this repo.',
    timestamp: '2026-03-16T00:00:00.000Z',
    client_message_id: 'user_memory_tool_strategy_1',
  });

  const captured = [];
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
      return {
        suggestions: [
          {
            title: 'Tool strategy: use apply_patch',
            lesson_text: 'Prefer apply_patch for small manual file edits when practical.',
            lesson_kind: 'tool_strategy',
            confidence: 0.89,
            source_excerpt: 'Prefer apply_patch',
            content_fingerprint: 'tool_strategy:prefer-apply-patch-for-small-manual-file-edits-when-practical',
          },
        ],
      };
    },
  };

  const result = await service.suggestMemoriesForSession(created.data.id);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'memory.suggest');
  assert.equal(captured[0].params.session_id, created.data.id);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].lesson_kind, 'tool_strategy');
});

test('backend service filters dismissed fingerprints from memory suggestions', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-dismiss-'));
  trackDirectory(userDataPath);

  const service = createBackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  service.sidecarClient = {
    async request() {
      return {
        suggestions: [
          {
            title: 'Preference: dark mode',
            lesson_text: 'The user prefers dark mode.',
            lesson_kind: 'preference',
            confidence: 0.95,
            source_excerpt: 'I prefer dark mode',
            content_fingerprint: 'preference:the-user-prefers-dark-mode',
          },
        ],
      };
    },
  };

  const created = await service.createSession({ title: 'Dismiss Test Session' });
  const sessionId = created.data.id;

  // Before dismissal, suggestion is returned
  const before = await service.suggestMemoriesForSession(sessionId);
  assert.equal(before.suggestions.length, 1);

  // After dismissal, the same fingerprint is filtered out
  service.dismissMemorySuggestion('preference:the-user-prefers-dark-mode');
  const after = await service.suggestMemoriesForSession(sessionId);
  assert.equal(after.suggestions.length, 0);

  // Verify helper
  assert.equal(service.isMemorySuggestionDismissed('preference:the-user-prefers-dark-mode'), true);
  assert.equal(service.isMemorySuggestionDismissed('preference:other'), false);
});

test('backend service bounds memory suggestion requests to recent plain user messages', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-window-'));
  trackDirectory(userDataPath);

  const service = createBackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  const created = await service.createSession({ title: 'Suggestion Window Session' });
  const sessionId = created.data.id;
  service.sessionStore.appendMessage(sessionId, {
    id: 'user_old',
    role: 'user',
    content: 'old preference',
    timestamp: '2026-03-01T00:00:00.000Z',
  });
  service.sessionStore.appendMessage(sessionId, {
    id: 'assistant_old',
    role: 'assistant',
    content: 'old reply',
    timestamp: '2026-03-01T00:00:01.000Z',
  });
  service.sessionStore.appendMessage(sessionId, {
    id: 'user_two',
    role: 'user',
    content: 'recent second',
    timestamp: '2026-03-01T00:00:02.000Z',
  });
  service.sessionStore.appendMessage(sessionId, {
    id: 'tool_result_1',
    role: 'assistant',
    kind: 'tool_result',
    content: 'tool output',
    timestamp: '2026-03-01T00:00:03.000Z',
  });
  service.sessionStore.appendMessage(sessionId, {
    id: 'user_three',
    role: 'user',
    content: 'recent third',
    timestamp: '2026-03-01T00:00:04.000Z',
  });
  service.sessionStore.appendMessage(sessionId, {
    id: 'user_four',
    role: 'user',
    content: 'recent fourth',
    timestamp: '2026-03-01T00:00:05.000Z',
  });

  const captured = [];
  service.sidecarClient = {
    async request(method, params) {
      captured.push({ method, params });
      return { suggestions: [] };
    },
  };

  await service.suggestMemoriesForSession(sessionId);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].method, 'memory.suggest');
  assert.deepEqual(
    captured[0].params.messages.map((entry) => entry.content),
    ['recent second', 'recent third', 'recent fourth']
  );
});

test('backend service caps dismissed memory fingerprints and refreshes recency on repeat dismissals', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-memory-cap-'));
  trackDirectory(userDataPath);

  const service = createBackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });

  for (let index = 0; index < MAX_DISMISSED_MEMORY_FINGERPRINTS; index += 1) {
    service.dismissMemorySuggestion(`fingerprint-${index}`);
  }

  service.dismissMemorySuggestion('fingerprint-0');
  service.dismissMemorySuggestion(`fingerprint-${MAX_DISMISSED_MEMORY_FINGERPRINTS}`);

  assert.equal(
    service._dismissedMemoryFingerprints.size,
    MAX_DISMISSED_MEMORY_FINGERPRINTS
  );
  assert.equal(service.isMemorySuggestionDismissed('fingerprint-0'), true);
  assert.equal(service.isMemorySuggestionDismissed('fingerprint-1'), false);

  service.sidecarClient = {
    async request() {
      return {
        suggestions: [
          {
            title: 'Old fingerprint',
            lesson_text: 'Should be filtered.',
            lesson_kind: 'preference',
            confidence: 0.9,
            source_excerpt: 'old',
            content_fingerprint: 'fingerprint-0',
          },
          {
            title: 'Evicted fingerprint',
            lesson_text: 'Should remain visible.',
            lesson_kind: 'preference',
            confidence: 0.8,
            source_excerpt: 'evicted',
            content_fingerprint: 'fingerprint-1',
          },
        ],
      };
    },
  };

  const created = await service.createSession({ title: 'Cap Test Session' });
  const result = await service.suggestMemoriesForSession(created.data.id);

  assert.deepEqual(
    result.suggestions.map((entry) => entry.content_fingerprint),
    ['fingerprint-1']
  );
});
