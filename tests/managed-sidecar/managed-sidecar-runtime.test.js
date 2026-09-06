const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const {
  waitForChatStreamEvent,
  createManagedService,
  createManagedServiceWithConfig,
} = require('../helpers/managed-sidecar-runtime-helpers');
const { buildManagedSidecarConfig } = require('../../services/backend/managed-sidecar-lifecycle');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar config forwards explicit electron-owned state paths for harness inspection', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-harness-config-'));
  trackDirectory(userDataPath);

  const configState = {
    toolsWorkspaceRoot: '',
    tools: { web: false, mermaid: false, pythonRuntime: false },
  };
  const configService = {
    getState() {
      return { ...configState };
    },
  };
  const service = createManagedServiceWithConfig(userDataPath, configService);

  const payload = buildManagedSidecarConfig(service);

  assert.equal(payload.electron_state_root, userDataPath);
  assert.equal(payload.electron_shell_config_path, path.join(userDataPath, 'shell-config.json'));
  assert.equal(payload.electron_sessions_path, path.join(userDataPath, 'sessions.json'));
  assert.equal(payload.electron_tool_permissions_path, path.join(userDataPath, 'tool-permissions.json'));
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'electron_shell_config_path'), true);
});

test('managed sidecar refreshManagedConfig updates web tool availability from shell config', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-web-tools-'));
  trackDirectory(userDataPath);

  const configState = {
    toolsWorkspaceRoot: '',
    tools: { web: false, mermaid: false, pythonRuntime: false },
  };
  const configService = {
    getState() {
      return { ...configState };
    },
  };
  const service = createManagedServiceWithConfig(userDataPath, configService);

  await service.start();

  assert.ok(Array.isArray(service.currentStatus.tools_available));
  assert.equal(service.currentStatus.tools_status.web_search.available, false);
  assert.equal(service.currentStatus.tools_status.web_search.reason, 'config disabled');
  assert.equal(service.currentStatus.tools_available.includes('web_search'), false);
  assert.equal(service.currentStatus.tools_available.includes('fetch_url'), false);

  configState.tools = { ...configState.tools, web: true };
  await service.refreshManagedConfig('tools_web_enabled_updated');

  assert.equal(service.currentStatus.tools_status.web_search.available, true);
  assert.equal(service.currentStatus.tools_status.fetch_url.available, true);
  assert.equal(service.currentStatus.tools_available.includes('web_search'), true);
  assert.equal(service.currentStatus.tools_available.includes('fetch_url'), true);

  configState.tools = { ...configState.tools, web: false };
  await service.refreshManagedConfig('tools_web_enabled_updated');

  assert.equal(service.currentStatus.tools_status.web_search.available, false);
  assert.equal(service.currentStatus.tools_status.fetch_url.available, false);
  assert.equal(service.currentStatus.tools_available.includes('web_search'), false);
  assert.equal(service.currentStatus.tools_available.includes('fetch_url'), false);

  await service.stop();
});

// Mermaid generation is forced on and hidden from config; a stale persisted
// `tools.mermaid` value must never gate the tool.
test('managed sidecar keeps mermaid tool availability forced on across shell config refreshes', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-mermaid-tools-'));
  trackDirectory(userDataPath);

  const configState = {
    toolsWorkspaceRoot: '',
    tools: { web: false, mermaid: false, pythonRuntime: false },
  };
  const configService = {
    getState() {
      return { ...configState };
    },
  };
  const service = createManagedServiceWithConfig(userDataPath, configService);

  await service.start();

  assert.ok(Array.isArray(service.currentStatus.tools_available));
  assert.equal(service.currentStatus.tools_status.mermaid_generate.available, true);
  assert.equal(service.currentStatus.tools_status.mermaid_generate.reason, null);
  assert.equal(service.currentStatus.tools_available.includes('mermaid_generate'), true);

  configState.tools = { ...configState.tools, mermaid: true };
  await service.refreshManagedConfig('feature_settings_updated');

  assert.equal(service.currentStatus.tools_status.mermaid_generate.available, true);
  assert.equal(service.currentStatus.tools_available.includes('mermaid_generate'), true);

  configState.tools = { ...configState.tools, mermaid: false };
  await service.refreshManagedConfig('feature_settings_updated');

  assert.equal(service.currentStatus.tools_status.mermaid_generate.available, true);
  assert.equal(service.currentStatus.tools_available.includes('mermaid_generate'), true);

  await service.stop();
});

test('managed sidecar refreshManagedConfig updates python runtime tool availability from shell config', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-python-tools-'));
  trackDirectory(userDataPath);

  const configState = {
    toolsWorkspaceRoot: '',
    tools: { web: false, mermaid: false, pythonRuntime: false },
  };
  const configService = {
    getState() {
      return { ...configState };
    },
  };
  const service = createManagedServiceWithConfig(userDataPath, configService);

  await service.start();

  assert.ok(Array.isArray(service.currentStatus.tools_available));
  assert.equal(service.currentStatus.tools_status.python_execute.available, false);
  assert.equal(service.currentStatus.tools_available.includes('python_execute'), false);

  configState.tools = { ...configState.tools, pythonRuntime: true };
  await service.refreshManagedConfig('tools_python_runtime_enabled_updated');

  assert.equal(
    service.currentStatus.tools_status.python_execute.available,
    process.platform === 'win32'
  );
  assert.equal(
    service.currentStatus.tools_available.includes('python_execute'),
    process.platform === 'win32'
  );

  configState.tools = { ...configState.tools, pythonRuntime: false };
  await service.refreshManagedConfig('tools_python_runtime_enabled_updated');

  assert.equal(service.currentStatus.tools_available.includes('python_execute'), false);

  await service.stop();
});

test('managed sidecar emits a web_search tool call for current-info requests when web tools are enabled', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-web-regression-'));
  trackDirectory(userDataPath);
  const prompt = 'Inspect the harness and tell me what the weather is in Nashville today.';

  const configState = {
    toolsWorkspaceRoot: '',
    tools: { web: true, mermaid: false, pythonRuntime: false },
  };
  const configService = {
    getState() {
      return { ...configState };
    },
  };
  const service = createManagedServiceWithConfig(userDataPath, configService, {
    defaultModel: 'qwen3.5:9b',
  });
  await service.start();
  const chatSendCalls = [];
  const originalChatSend = service.sidecarClient.chatSend.bind(service.sidecarClient);
  service.sidecarClient.chatSend = async (params, options = {}) => {
    chatSendCalls.push(params);
    return originalChatSend(params, options);
  };

  const created = await service.createSession({
    title: 'Weather Regression',
    preferences: {
      preferred_model: 'qwen3.5:9b',
    },
  });

  const completed = waitForChatStreamEvent(service, (event) => event.type === 'complete');
  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt,
    preferredModel: 'qwen3.5:9b',
  });
  await completed;

  assert.equal(chatSendCalls.length, 1);
  assert.equal(chatSendCalls[0].mode, 'assist');
  const messages = await service.getSessionMessages(stream.sessionId);
  const toolUseMessage = messages.data.find(
    (message) => message.kind === 'tool_use' && message.tool_call?.tool_name === 'web_search'
  );
  assert.ok(toolUseMessage);
  assert.equal(toolUseMessage.tool_call.input.query, prompt);

  await service.stop();
});

test('managed sidecar reports the exact web-search unavailability reason when web tools are disabled', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-web-reason-'));
  trackDirectory(userDataPath);
  const prompt = 'Inspect the harness and tell me what the weather is in Nashville today.';

  const configState = {
    toolsWorkspaceRoot: '',
    tools: { web: false, mermaid: false, pythonRuntime: false },
  };
  const configService = {
    getState() {
      return { ...configState };
    },
  };
  const service = createManagedServiceWithConfig(userDataPath, configService, {
    defaultModel: 'qwen3.5:9b',
  });
  await service.start();
  const chatSendCalls = [];
  const originalChatSend = service.sidecarClient.chatSend.bind(service.sidecarClient);
  service.sidecarClient.chatSend = async (params, options = {}) => {
    chatSendCalls.push(params);
    return originalChatSend(params, options);
  };

  const created = await service.createSession({
    title: 'Weather Disabled',
    preferences: {
      preferred_model: 'qwen3.5:9b',
    },
  });

  const completed = waitForChatStreamEvent(service, (event) => event.type === 'complete');
  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt,
    preferredModel: 'qwen3.5:9b',
  });
  const done = await completed;
  assert.equal(chatSendCalls.length, 1);
  assert.equal(chatSendCalls[0].mode, 'assist');
  assert.match(done.content, /web_search is unavailable for this request: config disabled/i);

  const messages = await service.getSessionMessages(stream.sessionId);
  assert.equal(
    messages.data.some((message) => message.kind === 'tool_use' && message.tool_call?.tool_name === 'web_search'),
    false
  );

  await service.stop();
});

test('managed sidecar runtime keeps chat, approvals, and reload on the JSON-RPC path only', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-sidecar-'));
  trackDirectory(userDataPath);
  const reasoningModel = 'Qwen/Qwen3.5-7B';

  const service = createManagedService(userDataPath);
  await service.start();

  assert.equal(service.getBackendStatus().baseUrl, 'stdio://sidecar');

  const models = await service.listModels();
  assert.equal(models.available, true);
  assert.deepEqual(
    models.data.map((entry) => entry.id),
    ['mock-v1', 'mock-v2', 'qwen3.5:9b', 'llama3.2']
  );
  assert.deepEqual(
    models.data.map((entry) => entry.engine_type),
    ['mock', 'mock', 'ollama', 'ollama']
  );
  const chatSendCalls = [];
  const originalChatSend = service.sidecarClient.chatSend.bind(service.sidecarClient);
  service.sidecarClient.chatSend = async (params, options = {}) => {
    chatSendCalls.push(params);
    return originalChatSend(params, options);
  };
  const approvalEvents = [];
  service.on('chat-stream', (event) => {
    if (event.type === 'tool_approval_needed') {
      approvalEvents.push(event);
    }
  });

  const created = await service.createSession({
    title: 'Managed Sidecar Session',
    preferences: {
      preferred_model: reasoningModel,
      reasoning_effort: 'medium',
      plan_mode: true,
    },
  });

  const completed = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete'
  );

  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Please write a note after approval',
    preferredModel: reasoningModel,
    reasoningEffort: 'medium',
    planMode: true,
  });

  const result = await completed;
  assert.equal(chatSendCalls.length, 1);
  assert.equal(chatSendCalls[0].plan_mode, true);
  assert.equal(approvalEvents.length, 0);
  assert.equal(result.streamId, stream.streamId);
  assert.match(result.content, /Hello from the sidecar/);
  assert.match(result.content, /medium effort/);

  const messages = await service.getSessionMessages(stream.sessionId);
  assert.equal(messages.data.some((message) => message.id === `user_${stream.streamId}`), true);
  assert.equal(messages.data.some((message) => message.id === `assistant_${stream.streamId}`), true);
  assert.equal(messages.data.some((message) => message.kind === 'tool_use'), true);
  assert.equal(messages.data.some((message) => message.kind === 'tool_result'), true);
  const toolUseMessage = messages.data.find((message) => message.kind === 'tool_use');
  assert.ok(toolUseMessage);
  assert.deepEqual(toolUseMessage.tool_call.input, {
    path: 'notes.md',
    content: 'approved content',
  });
  const toolResultMessage = messages.data.find((message) => message.kind === 'tool_result');
  assert.ok(toolResultMessage);
  assert.equal(toolResultMessage.tool_result.is_error, true);
  assert.equal(toolResultMessage.tool_result.error_code, 'CMP-MODE-0002');
  assert.equal(toolResultMessage.tool_result.metadata.read_only_blocked, true);

  const sessions = await service.listSessions();
  const managedSession = sessions.data.find((session) => session.id === stream.sessionId);
  assert.ok(managedSession);
  assert.equal(managedSession.plan_mode, true);
  assert.equal(managedSession.preferred_model, reasoningModel);
  assert.equal(managedSession.reasoning_effort, 'medium');

  await service.stop();

  const restarted = createManagedService(userDataPath);
  await restarted.start();

  const authState = restarted.getAuthState();
  assert.equal(authState.authenticated, true);
  assert.equal(authState.user.email, 'local@jenny.local');

  const restoredMessages = await restarted.getSessionMessages(stream.sessionId);
  assert.equal(restoredMessages.data.length, 4, 'exactly the four seeded messages are restored (no duplication or loss)');
  assert.equal(
    restoredMessages.data.some((message) => message.kind === 'tool_use'),
    true
  );
  assert.equal(
    restoredMessages.data.some((message) => message.kind === 'tool_result'),
    true
  );
  assert.equal(
    restoredMessages.data.some((message) => message.id === `assistant_${stream.streamId}`),
    true
  );

  await restarted.stop();
});

test('managed sidecar runtime routes image attachments through the vision chat path and persists safe metadata', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-vision-'));
  trackDirectory(userDataPath);
  const imagePath = path.join(userDataPath, 'capture.png');
  fs.writeFileSync(imagePath, 'fake-image');

  const service = createManagedService(userDataPath);
  // Path-faithful managed-store stub: image validation is fail-closed, so the
  // store must vouch for exactly the asset this test created and nothing else.
  service.attachmentAssetStore = {
    resolveManagedAssetRealPath(assetPath, { kind } = {}) {
      return kind === 'image' && assetPath === imagePath ? imagePath : null;
    },
    isManagedAssetPath(assetPath) {
      return assetPath === imagePath;
    },
  };
  await service.start();
  const originalChatSend = service.sidecarClient.chatSend.bind(service.sidecarClient);
  let capturedChatSend = null;
  service.sidecarClient.chatSend = (params, options) => {
    capturedChatSend = params;
    return originalChatSend(params, options);
  };

  const completed = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete'
  );

  const created = await service.createSession({
    title: 'Plan preference retained for image chat',
    preferences: { plan_mode: true },
  });
  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Describe the attached screenshot.',
    planMode: true,
    attachments: [{
      id: 'image_1',
      kind: 'image',
      displayName: 'capture.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      width: 640,
      height: 360,
      assetPath: imagePath,
      sourceKind: 'capture',
      bytes: [1, 2, 3],
    }],
  });

  const result = await completed;
  assert.equal(result.streamId, stream.streamId);
  assert.match(result.content, /Vision analysis complete/i);
  // vision_unified_turn (default-on) runs image turns through the normal tool loop,
  // so plan mode stays on the wire; the flag-off legacy path is pinned in
  // managed-sidecar-chat-image-attachments.test.js.
  assert.equal(capturedChatSend.plan_mode, true);
  assert.equal(service.sessionStore.getSession(stream.sessionId).plan_mode, true);

  const messages = await service.getSessionMessages(stream.sessionId);
  assert.deepEqual(messages.data[0].attachments, [{
    id: 'image_1',
    kind: 'image',
    displayName: 'capture.png',
    mimeType: 'image/png',
    sizeBytes: 2048,
    width: 640,
    height: 360,
    assetPath: imagePath,
    sourceKind: 'capture',
  }]);
  assert.doesNotMatch(JSON.stringify(messages.data[0]), /bytes/);

  await service.stop();
});

test('managed vLLM vision turns forward image attachments instead of failing at the engine gate', async () => {
  // JCA-006: Electron carried a stale mock/ollama-only allowlist for image
  // attachments even though the sidecar's vision path is engine-generic and
  // vllm_engine detects per-model vision support. A supported vLLM vision
  // workflow must reach chat.send; model-level capability rejection stays
  // with the sidecar.
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-vllm-vision-'));
  trackDirectory(userDataPath);
  const imagePath = path.join(userDataPath, 'capture.png');
  fs.writeFileSync(imagePath, 'fake-image');

  const service = createManagedService(userDataPath);
  // Path-faithful managed-store stub: image validation is fail-closed, so the
  // store must vouch for exactly the asset this test created and nothing else.
  service.attachmentAssetStore = {
    resolveManagedAssetRealPath(assetPath, { kind } = {}) {
      return kind === 'image' && assetPath === imagePath ? imagePath : null;
    },
    isManagedAssetPath(assetPath) {
      return assetPath === imagePath;
    },
  };
  await service.start();

  const completed = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete'
  );

  const stream = await service.startChatStream({
    prompt: 'Describe the attached screenshot.',
    preferredModel: 'Qwen/Qwen3.5-9B', // HF-style id -> engineType 'vllm'
    attachments: [{
      id: 'image_1',
      kind: 'image',
      displayName: 'capture.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      width: 640,
      height: 360,
      assetPath: imagePath,
      sourceKind: 'capture',
      bytes: [1, 2, 3],
    }],
  });

  const result = await completed;
  assert.equal(result.streamId, stream.streamId);
  assert.match(result.content, /Vision analysis complete/i,
    'the attachment reached chat.send instead of the stale engine-gate error');

  await service.stop();
});

test('managed sidecar session deletion prunes unreferenced image assets', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-vision-prune-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  const pruneCalls = [];
  service.attachmentAssetStore = {
    pruneAssetPaths(candidatePaths, referencedPaths) {
      pruneCalls.push({ candidatePaths, referencedPaths });
      return { deletedCount: 1, deletedPaths: candidatePaths };
    },
  };

  const first = await service.createSession({ title: 'First' });
  const second = await service.createSession({ title: 'Second' });
  service.sessionStore.appendMessage(first.data.id, {
    id: 'user_image_1',
    role: 'user',
    content: 'Image one',
    attachments: [{
      id: 'image_1',
      kind: 'image',
      displayName: 'image-1.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      width: 10,
      height: 10,
      assetPath: 'C:/captures/image-1.png',
      sourceKind: 'file',
    }],
  });
  service.sessionStore.appendMessage(second.data.id, {
    id: 'user_image_2',
    role: 'user',
    content: 'Image two',
    attachments: [{
      id: 'image_2',
      kind: 'image',
      displayName: 'image-2.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      width: 10,
      height: 10,
      assetPath: 'C:/captures/image-2.png',
      sourceKind: 'file',
    }],
  });

  await service.deleteSession(first.data.id);

  assert.deepEqual(pruneCalls, [{
    candidatePaths: ['C:/captures/image-1.png'],
    referencedPaths: ['C:/captures/image-2.png'],
  }]);
});

test('managed sidecar runtime marks denied approval requests in the local transcript', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-denied-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  const created = await service.createSession({
    title: 'Denied Session',
  });

  const approvalNeeded = waitForChatStreamEvent(
    service,
    (event) => event.type === 'tool_approval_needed'
  );
  const denied = waitForChatStreamEvent(
    service,
    (event) => event.type === 'tool_use' && event.status === 'denied'
  );
  // Wait for the denied terminal itself rather than guessing how long it takes.
  // The fixed 50ms below used to be racing this event's ARRIVAL, so a slow child
  // response failed a correct run; now it only bounds the duplicate window, which
  // is what it was meant to do.
  const deniedTerminal = waitForChatStreamEvent(
    service,
    (event) => event.type === 'error' && event.status === 'denied'
  );
  const errorEvents = [];
  const captureError = (event) => {
    if (event.type === 'error') {
      errorEvents.push(event);
    }
  };
  service.on('chat-stream', captureError);

  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Please write a note but deny it',
  });

  const approval = await approvalNeeded;
  assert.equal(service.denyToolCall(approval.callId), true);

  const deniedEvent = await denied;
  assert.equal(deniedEvent.streamId, stream.streamId);
  await deniedTerminal;
  // Now that the terminal has landed, give a duplicate a chance to show up.
  await new Promise((resolve) => setTimeout(resolve, 50));
  service.off('chat-stream', captureError);
  // SP-20 containment: the fake sidecar ends this turn with an overall
  // {status: 'denied'} RPC result once the tool call is denied, so the turn
  // must now reach the renderer as exactly one denied terminal (previously
  // silent -- see tests/managed-sidecar/managed-sidecar-denied-terminal.test.js
  // for the focused regression coverage).
  assert.equal(errorEvents.length, 1, 'the denied terminal must reach the renderer exactly once');
  assert.equal(errorEvents[0].status, 'denied');

  const messages = await service.getSessionMessages(stream.sessionId);
  const toolUseMessageId = `tool_use_${stream.streamId}_${approval.callId}`;
  const deniedToolUse = messages.data.find(
    (message) => message.id === toolUseMessageId
  );
  assert.ok(deniedToolUse);
  assert.equal(deniedToolUse.tool_call.approval_state, 'denied');
  assert.equal(deniedToolUse.tool_call.status, 'denied');

  await service.stop();
});

test('managed sidecar runtime exposes durable assistant state before type: complete', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-delay-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  const created = await service.createSession({
    title: 'New Chat',
  });

  const completed = waitForChatStreamEvent(service, (event) => event.type === 'complete');

  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Wait for delay',
  });

  const completeEvent = await completed;
  const messagesAtComplete = service.sessionStore.getSessionMessages(created.data.id);
  const assistant = messagesAtComplete.find((message) => message.id === `assistant_${stream.streamId}`);

  assert.equal(completeEvent.durability?.state, 'saved');
  assert.ok(assistant, 'the canonical assistant row must exist when complete is emitted');
  assert.equal(assistant.content, completeEvent.content);
  assert.equal(service.sessionStore.getActiveTurn(created.data.id), null);

  await service.stop();
});
