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

async function createToolPreferenceService(title, tempPrefix) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
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
    title,
    preferences: {
      context_preferences: {
        include_memory: false,
      },
    },
  });

  const capturedRequests = [];
  const completed = new Promise((resolve) => {
    service.on('chat-stream', (event) => {
      if (event.type === 'complete') {
        resolve(event);
      }
    });
  });

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
        params: { request_id: params.request_id, session_id: params.session_id, delta: 'Done' },
      });
      onNotification({
        method: 'chat.done',
        params: { request_id: params.request_id, session_id: params.session_id },
      });
      return { status: 'completed' };
    },
  };

  return { created, service, capturedRequests, completed };
}

test('backend service omits tool_preferences when toolPreferences are absent', async () => {
  const { created, service, capturedRequests, completed } = await createToolPreferenceService(
    'Tool Preferences Absent Session',
    'jenny-shell-userdata-tool-prefs-absent-'
  );

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'No tool preferences for this turn.',
  });
  await completed;

  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.ok(chatSendRequest);
  assert.equal(Object.prototype.hasOwnProperty.call(chatSendRequest.params, 'tool_preferences'), false);
});

test('backend service forwards known false toolPreferences toggles and ignores unknown keys', async () => {
  const { created, service, capturedRequests, completed } = await createToolPreferenceService(
    'Tool Preferences Known False Session',
    'jenny-shell-userdata-tool-prefs-known-false-'
  );

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Disable web tools for this turn.',
    toolPreferences: {
      web_search: false,
      unknown_toggle: false,
      Bash: 'nope',
    },
  });
  await completed;

  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.ok(chatSendRequest);
  assert.deepEqual(chatSendRequest.params.tool_preferences, {
    enabled_tools: [],
    disabled_tools: ['fetch_url', 'web_search'],
  });
});

test('backend service omits tool_preferences when toolPreferences payload has no known boolean toggles', async () => {
  const { created, service, capturedRequests, completed } = await createToolPreferenceService(
    'Tool Preferences Invalid Session',
    'jenny-shell-userdata-tool-prefs-invalid-'
  );

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Invalid tool preference payload.',
    toolPreferences: {
      web_search: 'false',
      Bash: 1,
      unknown_toggle: true,
    },
  });
  await completed;

  const chatSendRequest = capturedRequests.find((entry) => entry.method === 'chat.send');
  assert.ok(chatSendRequest);
  assert.equal(Object.prototype.hasOwnProperty.call(chatSendRequest.params, 'tool_preferences'), false);
});
