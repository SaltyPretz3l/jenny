'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRuntimeToolStatusMap,
  registerAuxiliaryIpcHandlers,
} = require('../services/auxiliary-ipc-handlers');
const { getBridgeChannel } = require('../services/ipc-contract');
const { CONTEXT_LENGTH_STEPS } = require('../services/shell-config-compaction-tuning');

describe('auxiliary IPC tool normalization', () => {
  test('normalizes legacy tool status aliases with canonical tool ids', () => {
    const statusMap = normalizeRuntimeToolStatusMap({
      Read: {
        available: true,
        reason: 'ready',
        display_name: 'Read File',
        source_kind: 'builtin',
        tool_family: 'filesystem',
      },
    });

    assert.equal(statusMap.Read, undefined);
    assert.deepEqual(statusMap.read_file, {
      available: true,
      reason: 'ready',
      displayName: 'Read File',
      sourceKind: 'builtin',
      toolFamily: 'filesystem',
    });
  });
});

test('auxiliary IPC registers Jenny status diagnostics handler', async () => {
  const handlers = new Map();
  const backendService = {
    async getJennyStatus(options) {
      return { facade: 'jenny_status', options };
    },
  };

  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    personalityWorkspace: {},
    artifactService: {},
    backendService,
    getProactiveStatePayload: () => ({}),
    shellConfigService: {
      getState: () => ({}),
    },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions: () => [],
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch: () => ({}),
    dialog: {},
    getMainWindow: () => null,
    chooseWorkspaceRoot: async () => null,
    clearWorkspaceRoot: () => null,
    prepareAttachmentEntries: () => ({ accepted: [], rejected: [] }),
    attachmentAssetStore: null,
    processRef: { cwd: () => process.cwd() },
    os: {},
    isChildPath: () => false,
    clipboard: { writeText() {} },
    log: () => null,
    getMainLifecycle: () => null,
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
    speechService: null,
  });

  assert.equal(handlers.has('diagnostics:jenny-status'), true);
  const payload = await handlers.get('diagnostics:jenny-status')({}, { sessionId: 'session-a' });

  assert.deepEqual(payload, {
    facade: 'jenny_status',
    options: { sessionId: 'session-a' },
  });
});

test('auxiliary IPC delegates edit-and-regenerate as one backend command', async () => {
  const calls = [];
  const handlers = registerMinimalHandlers({
    backendService: {
      async editAndRegenerate(payload) {
        calls.push(payload);
        return {
          streamId: 'stream-edit-1',
          sessionId: payload.sessionId,
          identity: { userMessageId: payload.editedMessageId },
        };
      },
    },
  });
  const payload = {
    sessionId: 'session-a',
    editedMessageId: 'user-1',
    prompt: 'edited prompt',
  };

  const result = await handlers.get('chat:edit-and-regenerate')({}, payload);

  assert.deepEqual(calls, [payload]);
  assert.deepEqual(result, {
    streamId: 'stream-edit-1',
    sessionId: 'session-a',
    identity: { userMessageId: 'user-1' },
  });
});

test('auxiliary IPC exposes bounded interactive/export usage reads and the atomic clear mutation', async () => {
  const calls = [];
  const handlers = registerMinimalHandlers({
    usageHistory: {
      getSnapshot(payload) {
        calls.push({ mode: 'interactive', payload });
        return { available: true, recent_turns: [{ stream_id: 'interactive' }] };
      },
      getExportRows(payload) {
        calls.push({ mode: 'export', payload });
        return { ok: true, scope: payload.scope, rows: [{ stream_id: 'export' }] };
      },
      clearHistory() {
        return { ok: true, cleared_turn_count: 3, durable: true };
      },
    },
  });

  assert.equal(handlers.has('usage:clear-history'), true);
  assert.equal(handlers.has('usage:get-snapshot'), true);
  assert.equal(handlers.has('cost:get-session'), false);
  assert.equal(handlers.has('cost:get-cumulative'), false);
  assert.deepEqual(await handlers.get('usage:clear-history')({}), {
    ok: true,
    cleared_turn_count: 3,
    durable: true,
  });
  assert.deepEqual(await handlers.get('usage:get-snapshot')({}, {
    mode: 'interactive', sessionId: 'session-a', limit: 999,
  }), { available: true, recent_turns: [{ stream_id: 'interactive' }] });
  assert.deepEqual(await handlers.get('usage:get-snapshot')({}, {
    mode: 'export', scope: 'today', sessionId: 'session-a',
  }), { ok: true, scope: 'today', rows: [{ stream_id: 'export' }] });
  const malformed = await handlers.get('usage:get-snapshot')({}, { mode: 'export', scope: 'filtered' });
  assert.equal(malformed.ok, false);
  assert.deepEqual(malformed.rows, []);
  const unknownMode = await handlers.get('usage:get-snapshot')({}, { mode: 'filtered' });
  assert.equal(unknownMode.ok, false);
  assert.equal(unknownMode.scope, 'invalid');
  assert.deepEqual(unknownMode.rows, []);
  assert.deepEqual(calls, [
    { mode: 'interactive', payload: { sessionId: 'session-a', limit: 200 } },
    { mode: 'export', payload: { sessionId: 'session-a', scope: 'today', limit: 500 } },
  ]);
});

test('chat start IPC rejects malformed identity before backend admission', async () => {
  let backendCalls = 0;
  const logs = [];
  const handlers = registerMinimalHandlers({
    backendService: {
      async startChatStream() {
        backendCalls += 1;
        return {};
      },
    },
    log: (level, event, fields) => logs.push({ level, event, fields }),
  });

  assert.throws(
    () => handlers.get('chat:start-stream')({}, {
      sessionId: 'session-a', prompt: 'private prompt', traceId: { token: 'secret-value' },
    }),
    (error) => error.code === 'CMP-CHAT-0001' && error.path === '$.traceId'
  );
  assert.equal(backendCalls, 0);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('private prompt'), false);
  assert.equal(serialized.includes('secret-value'), false);
  assert.equal(logs.some((entry) => entry.event === 'chat.ipc_payload_rejected'), true);
});

test('auxiliary IPC delegates unsaved reply retry/discard payloads unchanged', async () => {
  const calls = [];
  const handlers = registerMinimalHandlers({
    backendService: {
      async retryUnsavedReply(payload) {
        calls.push(['retry', payload]);
        return { ok: true, durable: true, reason: null, message: { id: payload.messageId } };
      },
      async discardUnsavedReply(payload) {
        calls.push(['discard', payload]);
        return { ok: true, durable: true, reason: null, removedMessageId: payload.messageId };
      },
    },
  });
  const payload = {
    sessionId: 'session-a', messageId: 'assistant-1', artifactId: 'repair-1',
  };

  const retryResult = await handlers.get('chat:retry-unsaved-reply')({}, payload);
  const discardResult = await handlers.get('chat:discard-unsaved-reply')({}, payload);

  assert.deepEqual(calls, [['retry', payload], ['discard', payload]]);
  assert.deepEqual(retryResult, {
    ok: true, durable: true, reason: null, message: { id: 'assistant-1' },
  });
  assert.deepEqual(discardResult, {
    ok: true, durable: true, reason: null, removedMessageId: 'assistant-1',
  });
});

test('compaction tuning IPC exposes common context steps and preserves the service result shape', async () => {
  const calls = [];
  const tuning = {
    ratioByModel: { 'ornith:9b': 0.7 },
    contextLengthByModel: { 'ornith:9b': 131072 },
    customPrompt: 'Keep tool evidence.',
  };
  const handlers = registerMinimalHandlers({
    shellConfigService: {
      getCompactionTuning: () => tuning,
    },
    modelTuningService: {
      update: (payload) => {
        calls.push(payload);
        return { status: 'applied', state: { ...tuning, contextLengthSteps: CONTEXT_LENGTH_STEPS } };
      },
    },
  });

  const read = await handlers.get('compaction:get-tuning')({});
  const written = await handlers.get('compaction:set-tuning')({}, {
    modelId: 'ornith:9b', contextLength: 131072,
  });

  assert.deepEqual(read.contextLengthByModel, { 'ornith:9b': 131072 });
  assert.deepEqual(read.contextLengthSteps, [4096, 8192, 16384, 32768, 65536, 131072, 262144]);
  assert.equal(written.status, 'applied');
  assert.deepEqual(written.state, read);
  assert.deepEqual(calls, [{ modelId: 'ornith:9b', contextLength: 131072 }]);
});

test('model and compaction mutations fail closed when the tuning service is unavailable', async () => {
  const tuning = { ratioByModel: {}, contextLengthByModel: {}, customPrompt: '' };
  const handlers = registerMinimalHandlers({
    shellConfigService: {
      getModelTuning: () => ({ streamInactivitySecondsByModel: {} }),
      getCompactionTuning: () => tuning,
    },
  });
  const modelResult = await handlers.get('model-tuning:update')({}, {
    modelId: 'gemma3:latest', streamInactivitySeconds: 60,
  });
  const compactionResult = await handlers.get('compaction:set-tuning')({}, {
    modelId: 'gemma3:latest', ratio: 0.8,
  });
  assert.equal(modelResult.reason, 'model_tuning_service_unavailable');
  assert.equal(compactionResult.reason, 'model_tuning_service_unavailable');
  assert.deepEqual(compactionResult.state.ratioByModel, {});
});

test('tuning IPC contains service and config exceptions behind bounded results', async () => {
  const handlers = registerMinimalHandlers({
    shellConfigService: {
      getModelTuning: () => { throw new Error('secret model config path'); },
      getCompactionTuning: () => { throw new Error('secret compaction config path'); },
    },
    modelTuningService: {
      getState: () => { throw new Error('secret service state'); },
      update: async () => { throw new Error('secret service update'); },
    },
  });
  assert.deepEqual(await handlers.get('model-tuning:get-state')({}), {});
  const modelResult = await handlers.get('model-tuning:update')({}, { modelId: 'x' });
  const compactionResult = await handlers.get('compaction:set-tuning')({}, { customPrompt: 'x' });
  assert.equal(modelResult.reason, 'request_failed');
  assert.deepEqual(modelResult.state, {});
  assert.equal(compactionResult.reason, 'request_failed');
  assert.deepEqual(compactionResult.state.ratioByModel, {});
});

test('managed engine settings log applied and flag-disabled writes without paths', async () => {
  const channel = getBridgeChannel('engines.updateSettings', 'invoke');
  const handlers = new Map();
  const updates = [];
  const logs = [];
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle(name, handler) { handlers.set(name, handler); } },
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload: () => ({}),
    shellConfigService: {
      getState: () => ({ featureOverrides: {} }),
      getLocalEngines: () => ({}),
      updateManagedLlamaServer: (managed) => updates.push(managed),
    },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions: () => [],
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch: () => ({}),
    dialog: {},
    getMainWindow: () => null,
    chooseWorkspaceRoot: async () => null,
    clearWorkspaceRoot: () => null,
    prepareAttachmentEntries: () => ({ accepted: [], rejected: [] }),
    attachmentAssetStore: null,
    processRef: { cwd: () => process.cwd(), env: {} },
    os: {},
    isChildPath: () => false,
    clipboard: { writeText() {} },
    log: (...args) => logs.push(args),
    getMainLifecycle: () => null,
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
    speechService: null,
  });
  const managed = { perModel: { 'b-key': {}, 'a-key': {} }, libraryRoots: ['G:\\x'] };

  await handlers.get(channel)({}, { managed });

  assert.deepEqual(updates, [managed]);
  assert.deepEqual(logs, [[
    'INFO', 'engines.managed_updated', { keys: ['a-key', 'b-key'], roots: 1 },
  ]]);

  const disabledHandlers = new Map();
  const disabledUpdates = [];
  const disabledLogs = [];
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle(name, handler) { disabledHandlers.set(name, handler); } },
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload: () => ({}),
    shellConfigService: {
      getState: () => ({ featureOverrides: {} }),
      getLocalEngines: () => ({}),
      updateManagedLlamaServer: (value) => disabledUpdates.push(value),
    },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions: () => [],
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch: () => ({}),
    dialog: {},
    getMainWindow: () => null,
    chooseWorkspaceRoot: async () => null,
    clearWorkspaceRoot: () => null,
    prepareAttachmentEntries: () => ({ accepted: [], rejected: [] }),
    attachmentAssetStore: null,
    processRef: { cwd: () => process.cwd(), env: { JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '0' } },
    os: {},
    isChildPath: () => false,
    clipboard: { writeText() {} },
    log: (...args) => disabledLogs.push(args),
    getMainLifecycle: () => null,
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
    speechService: null,
  });

  await disabledHandlers.get(channel)({}, { managed });

  assert.deepEqual(disabledUpdates, []);
  assert.deepEqual(disabledLogs, [[
    'WARN', 'engines.managed_dropped_flag_off', { keys: ['a-key', 'b-key'], roots: 1 },
  ]]);
});

function registerMinimalHandlers(overrides = {}) {
  const handlers = new Map();
  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload: () => ({}),
    shellConfigService: { getState: () => ({}) },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions: () => [],
    offlineIntelligenceService: {},
    dialog: {},
    getMainWindow: () => null,
    chooseWorkspaceRoot: async () => null,
    clearWorkspaceRoot: () => null,
    prepareAttachmentEntries: () => ({ accepted: [], rejected: [] }),
    attachmentAssetStore: null,
    processRef: { cwd: () => process.cwd() },
    os: {},
    isChildPath: () => false,
    clipboard: { writeText() {} },
    log: () => null,
    getMainLifecycle: () => null,
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
    ...overrides,
  });
  return handlers;
}

test('auxiliary IPC exposes the structured memory status snapshot', async () => {
  const expected = { available: true, counts: { approved: 2, pending: 1 } };
  const handlers = registerMinimalHandlers({
    backendService: { async getMemoryStatus() { return expected; } },
  });

  assert.deepEqual(await handlers.get('memory:status')({}), expected);
});

test('setup.saveEndpoint forwards the candidate to the main-owned setup service', async () => {
  const calls = [];
  const expected = {
    setup_complete: false,
    setup_state: { steps: { endpoint: 'done' } },
    endpoint_result: { ok: true, code: 'ok' },
  };
  const handlers = registerMinimalHandlers({
    setupService: {
      async saveEndpoint(payload) {
        calls.push(payload);
        return expected;
      },
    },
  });
  const payload = { engineType: 'vllm', apiUrl: 'http://127.0.0.1:8000/v1' };

  assert.deepEqual(await handlers.get('setup:save-endpoint')({}, payload), expected);
  assert.deepEqual(calls, [payload]);
});

test('setup cancellation fallbacks preserve the additive structured contract', async () => {
  const handlers = registerMinimalHandlers({
    setupService: null,
    ollamaInstallService: null,
  });
  const expected = {
    cancelled: false,
    termination_confirmed: false,
    request_id: 'request-1',
    status: 'unavailable',
    code: 'setup_unavailable',
    error_code: 'CMP-SETUP-0004',
  };

  assert.deepEqual(await handlers.get('setup:cancel-ollama-pull')({}, { requestId: 'request-1' }), expected);
  assert.deepEqual(await handlers.get('setup:cancel-ollama-install')({}, { request_id: 'request-1' }), expected);
});

test('mcpAuth handlers fall back to unavailable shapes when mcpDiscoveryService is absent', async () => {
  const handlers = registerMinimalHandlers({ mcpDiscoveryService: null });

  const status = await handlers.get('mcp-auth:get-status')({});
  assert.deepEqual(status, {
    loaded: false,
    store: { status: 'unavailable', recoveryTitle: '', recoveryHint: '' },
    servers: [],
  });

  const setResult = await handlers.get('mcp-auth:set')({}, { serverName: 'x', value: 'y' });
  assert.deepEqual(setResult, {
    ok: false,
    error: { code: 'unavailable', message: 'MCP auth is unavailable.' },
  });

  const deleteResult = await handlers.get('mcp-auth:delete')({}, { serverName: 'x' });
  assert.deepEqual(deleteResult, {
    ok: false,
    error: { code: 'unavailable', message: 'MCP auth is unavailable.' },
  });
});

test('mcpAuth handlers delegate to mcpDiscoveryService when present', async () => {
  const calls = [];
  const mcpDiscoveryService = {
    getMcpAuthStatus: async () => ({ loaded: true, store: { status: 'ready' }, servers: [] }),
    setMcpAuthToken: async (payload) => {
      calls.push(['set', payload]);
      return { ok: true };
    },
    deleteMcpAuthToken: async (payload) => {
      calls.push(['delete', payload]);
      return { ok: true };
    },
  };
  const handlers = registerMinimalHandlers({ mcpDiscoveryService });

  assert.deepEqual(await handlers.get('mcp-auth:get-status')({}), {
    loaded: true,
    store: { status: 'ready' },
    servers: [],
  });
  await handlers.get('mcp-auth:set')({}, { serverName: 'bearer_server', value: 'secret' });
  await handlers.get('mcp-auth:delete')({}, { serverName: 'bearer_server' });
  assert.deepEqual(calls, [
    ['set', { serverName: 'bearer_server', value: 'secret' }],
    ['delete', { serverName: 'bearer_server' }],
  ]);
});

test('auxiliary IPC exposes window state and returns updated maximize state from controls', async () => {
  const handlers = new Map();
  const calls = [];
  let maximized = false;
  const mainWindow = {
    isDestroyed: () => false,
    isMaximized: () => maximized,
    isMinimized: () => false,
    minimize() {
      calls.push('minimize');
    },
    maximize() {
      calls.push('maximize');
      maximized = true;
    },
    unmaximize() {
      calls.push('unmaximize');
      maximized = false;
    },
    close() {
      calls.push('close');
    },
    webContents: {
      reloadIgnoringCache() {
        calls.push('reload');
      },
      toggleDevTools() {
        calls.push('toggle-devtools');
      },
    },
  };

  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload: () => ({}),
    shellConfigService: {
      getState: () => ({}),
    },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions: () => [],
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch: () => ({}),
    dialog: {},
    getMainWindow: () => mainWindow,
    getWindowState: () => ({ ok: true, maximized, minimized: false }),
    chooseWorkspaceRoot: async () => null,
    clearWorkspaceRoot: () => null,
    prepareAttachmentEntries: () => ({ accepted: [], rejected: [] }),
    attachmentAssetStore: null,
    processRef: { cwd: () => process.cwd() },
    os: {},
    isChildPath: () => false,
    clipboard: { writeText() {} },
    log: () => null,
    getMainLifecycle: () => null,
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
    speechService: null,
  });

  assert.deepEqual(await handlers.get('window:get-state')({}), {
    ok: true,
    maximized: false,
    minimized: false,
  });
  assert.deepEqual(await handlers.get('window:control')({}, 'maximize'), {
    ok: true,
    maximized: true,
    minimized: false,
  });
  assert.deepEqual(await handlers.get('window:control')({}, 'maximize'), {
    ok: true,
    maximized: false,
    minimized: false,
  });
  assert.deepEqual(calls, ['maximize', 'unmaximize']);
});

test('windowControl close authorizes the exit guard BEFORE closing (no native re-prompt)', async () => {
  const order = [];
  const mainWindow = {
    isDestroyed: () => false,
    isMaximized: () => false,
    isMinimized: () => false,
    minimize() {},
    maximize() {},
    unmaximize() {},
    close() { order.push('close'); },
    webContents: { reloadIgnoringCache() {}, toggleDevTools() {} },
  };
  const windowExitGuard = {
    authorizeNextClose() { order.push('authorize'); },
    resolvePreflight() { return { ok: true }; },
  };
  const handlers = registerMinimalHandlers({
    getMainWindow: () => mainWindow,
    getWindowState: () => ({ ok: true, maximized: false, minimized: false }),
    windowExitGuard,
  });

  await handlers.get('window:control')({}, 'close');

  // The renderer has already run the dirty preflight before invoking; the guard
  // must be told to bypass its native 'close' interceptor, and that bypass must
  // be set BEFORE mainWindow.close() fires the 'close' event.
  assert.deepEqual(order, ['authorize', 'close']);
});

test('windowControl close on an already-destroyed window latches nothing (no stale bypass)', async () => {
  // Code-review Low: authorizeNextClose() sets a one-shot bypass immediately
  // before close(); if the window is already destroyed, close() never fires a
  // 'close' event to consume it, so the flag would silently authorize the NEXT
  // genuine native close to skip the dirty prompt.
  const order = [];
  const mainWindow = {
    isDestroyed: () => true,
    isMaximized: () => false,
    isMinimized: () => false,
    minimize() {},
    maximize() {},
    unmaximize() {},
    close() { order.push('close'); },
    webContents: { reloadIgnoringCache() {}, toggleDevTools() {} },
  };
  const windowExitGuard = {
    authorizeNextClose() { order.push('authorize'); },
    resolvePreflight() { return { ok: true }; },
  };
  const handlers = registerMinimalHandlers({
    getMainWindow: () => mainWindow,
    getWindowState: () => ({ ok: true, maximized: false, minimized: false }),
    windowExitGuard,
  });

  await handlers.get('window:control')({}, 'close');

  assert.deepEqual(order, [], 'neither the bypass latch nor close() runs against a destroyed window');
});

test('windowControl exposes the native exit-preflight reply handler bound to the guard', async () => {
  const resolved = [];
  const windowExitGuard = {
    authorizeNextClose() {},
    resolvePreflight(payload) {
      resolved.push(payload);
      return { ok: true, proceed: payload.proceed === true };
    },
  };
  const handlers = registerMinimalHandlers({
    getMainWindow: () => ({ isDestroyed: () => false, close() {} }),
    getWindowState: () => ({ ok: true, maximized: false, minimized: false }),
    windowExitGuard,
  });

  assert.equal(handlers.has('window:exit-preflight-respond'), true);
  const result = await handlers.get('window:exit-preflight-respond')(
    {},
    { requestId: 'win-exit-1', proceed: true }
  );
  assert.deepEqual(result, { ok: true, proceed: true });
  assert.deepEqual(resolved, [{ requestId: 'win-exit-1', proceed: true }]);
});

test('auxiliary IPC registers Codex CLI engine handlers', async () => {
  const handlers = new Map();
  const sent = [];
  const backendService = {
    getCodexCliState() {
      return { enabled: true, status: 'ready', provider: 'codex-cli' };
    },
    openCodexCliLoginTerminal() {
      return { ok: true, code: 'login_terminal_opened', command: 'codex login' };
    },
    refreshCodexCliState() {
      return { enabled: true, status: 'ready', provider: 'codex-cli', refreshed: true };
    },
  };

  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    personalityWorkspace: {},
    artifactService: {},
    backendService,
    getProactiveStatePayload: () => ({}),
    shellConfigService: {
      getState: () => ({}),
    },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions: () => [],
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch: () => ({}),
    dialog: {},
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: {
        send(channel, payload) {
          sent.push({ channel, payload });
        },
      },
    }),
    chooseWorkspaceRoot: async () => null,
    clearWorkspaceRoot: () => null,
    prepareAttachmentEntries: () => ({ accepted: [], rejected: [] }),
    attachmentAssetStore: null,
    processRef: { cwd: () => process.cwd() },
    os: {},
    isChildPath: () => false,
    clipboard: { writeText() {} },
    log: () => null,
    getMainLifecycle: () => null,
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
    speechService: null,
  });

  assert.equal(handlers.has('codex-cli:get-state'), true);
  assert.equal(handlers.has('codex-cli:open-login-terminal'), true);
  assert.equal(handlers.has('codex-cli:refresh'), true);
  assert.equal(handlers.has('diagnostics-frontier:get-state'), false);

  assert.deepEqual(await handlers.get('codex-cli:get-state')({}), {
    enabled: true,
    status: 'ready',
    provider: 'codex-cli',
  });
  assert.deepEqual(await handlers.get('codex-cli:open-login-terminal')({}), {
    ok: true,
    code: 'login_terminal_opened',
    command: 'codex login',
  });
  assert.deepEqual(await handlers.get('codex-cli:refresh')({}), {
    enabled: true,
    status: 'ready',
    provider: 'codex-cli',
    refreshed: true,
  });
});

function registerWithAttachmentDeps({ workspaceRoot, preparedCalls }) {
  const handlers = new Map();
  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload: () => ({}),
    shellConfigService: {
      getState: () => ({ toolsWorkspaceRoot: workspaceRoot }),
    },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions: () => [],
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch: () => ({}),
    dialog: {},
    getMainWindow: () => null,
    chooseWorkspaceRoot: async () => null,
    clearWorkspaceRoot: () => null,
    prepareAttachmentEntries: (paths) => {
      preparedCalls.push(paths);
      return {
        accepted: paths.map((p) => ({ path: p, displayName: p })),
        rejected: [],
      };
    },
    attachmentAssetStore: null,
    processRef: { cwd: () => process.cwd() },
    os: {},
    isChildPath: (root, candidate) =>
      Boolean(root) && String(candidate || '').startsWith(`${root}/`),
    clipboard: { writeText() {} },
    log: () => null,
    getMainLifecycle: () => null,
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
    speechService: null,
  });
  return handlers;
}

test('attachments:prepare rejects out-of-root drops with a visible reason instead of silently filtering', async () => {
  const preparedCalls = [];
  const handlers = registerWithAttachmentDeps({
    workspaceRoot: 'C:/workspace',
    preparedCalls,
  });

  const result = await handlers.get('attachments:prepare')({}, [
    'C:/workspace/notes.md',
    'D:/outside/secrets.txt',
  ]);

  assert.deepEqual(preparedCalls, [['C:/workspace/notes.md']]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].path, /secrets\.txt$/);
  assert.match(result.rejected[0].reason, /outside the tools workspace root/i);
});

test('attachments:prepare rejects every drop with guidance when no workspace root is configured', async () => {
  const preparedCalls = [];
  const handlers = registerWithAttachmentDeps({
    workspaceRoot: '',
    preparedCalls,
  });

  const result = await handlers.get('attachments:prepare')({}, [
    'C:/workspace/notes.md',
  ]);

  assert.deepEqual(preparedCalls, [[]]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /set a tools workspace root/i);
});

test('attachments:prepare accepts an image outside the workspace root while rejecting adjacent text', async () => {
  const preparedCalls = [];
  const handlers = registerWithAttachmentDeps({
    workspaceRoot: 'C:/workspace',
    preparedCalls,
  });

  const result = await handlers.get('attachments:prepare')({}, [
    'D:/outside/capture.png',
    'D:/outside/notes.txt',
  ]);

  assert.deepEqual(preparedCalls, [['D:/outside/capture.png']]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].path, 'D:/outside/capture.png');
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].path, /notes\.txt$/);
  assert.match(result.rejected[0].reason, /outside the tools workspace root/i);
});

test('attachments:prepare accepts an image without a workspace root while rejecting text with guidance', async () => {
  const preparedCalls = [];
  const handlers = registerWithAttachmentDeps({
    workspaceRoot: '',
    preparedCalls,
  });

  const result = await handlers.get('attachments:prepare')({}, [
    'D:/outside/capture.png',
    'D:/outside/notes.txt',
  ]);

  assert.deepEqual(preparedCalls, [['D:/outside/capture.png']]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].path, 'D:/outside/capture.png');
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].path, /notes\.txt$/);
  assert.match(result.rejected[0].reason, /set a tools workspace root/i);
});

test('attachments:pick offers image extensions without audio extensions', async () => {
  const handlers = new Map();
  let dialogOptions = null;
  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload: () => ({}),
    shellConfigService: { getState: () => ({ toolsWorkspaceRoot: '' }) },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions: () => [],
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch: () => ({}),
    dialog: {
      async showOpenDialog(_window, options) {
        dialogOptions = options;
        return { canceled: true, filePaths: [] };
      },
    },
    getMainWindow: () => null,
    chooseWorkspaceRoot: async () => null,
    clearWorkspaceRoot: () => null,
    prepareAttachmentEntries: () => ({ accepted: [], rejected: [] }),
    attachmentAssetStore: null,
    processRef: { cwd: () => process.cwd() },
    os: {},
    isChildPath: () => false,
    clipboard: { writeText() {} },
    log: () => null,
    getMainLifecycle: () => null,
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
    speechService: null,
  });

  await handlers.get('attachments:pick')({});

  const extensions = dialogOptions.filters.find(
    (filter) => filter.name === 'Supported attachments'
  ).extensions;
  assert.equal(extensions.includes('png'), true);
  assert.equal(extensions.includes('mp3'), false);
  assert.equal(extensions.includes('wav'), false);
});

test('tools permission handlers expose saved decisions and remove them through the store', async () => {
  const calls = [];
  const refreshes = [];
  const handlers = registerMinimalHandlers({
    backendService: { refreshManagedConfig: async (reason) => { refreshes.push(reason); } },
    toolPermissionStore: {
      getAllPolicies: () => ({ read_file: 'auto', write_file: 'auto' }),
      listStoredDecisions: () => ({
        policies: { write_file: 'auto' },
        rules: [{ id: 'always-allow:write_file:abc', decision: 'auto', reason: 'r', match: { tool_id: 'write_file', path_prefix: 'docs/a.md' } }],
      }),
      consumeBlanketRuleRetiredNotice: () => false,
      clearPolicy: (name) => { calls.push(['clear', name]); return { cleared: true, toolName: name }; },
      removeRule: (id) => { calls.push(['remove', id]); return { removed: true, ruleId: id }; },
    },
  });

  const permissions = await handlers.get('tools:get-permissions')({});
  assert.deepEqual(permissions.saved.policies, { write_file: 'auto' });
  assert.equal(permissions.saved.rules[0].match.path_prefix, 'docs/a.md');
  assert.deepEqual(
    await handlers.get('tools:clear-permission')({}, 'write_file'),
    { cleared: true, toolName: 'write_file' },
  );
  assert.deepEqual(
    await handlers.get('tools:remove-permission-rule')({}, 'always-allow:write_file:abc'),
    { removed: true, ruleId: 'always-allow:write_file:abc' },
  );
  assert.deepEqual(calls, [['clear', 'write_file'], ['remove', 'always-allow:write_file:abc']]);
  assert.deepEqual(refreshes, ['tool_permission_updated', 'tool_permission_updated']);
});
