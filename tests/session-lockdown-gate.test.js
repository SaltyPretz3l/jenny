'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const manifest = require('../services/tools/tool-manifest.json');
const {
  startManagedSidecarChatStream,
} = require('../services/backend/managed-sidecar-chat');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const {
  LOCKDOWN_REMOTE_ENGINE,
  TOOL_NETWORK_CLASSIFICATION,
  applySessionLockdownToToolPreferences,
  assertSessionLockdownAllowsEngine,
  isSessionOfflineLockdownActive,
  isToolAvailableDuringSessionLockdown,
  resolveSessionLockdownRequest,
} = require('../services/backend/session-lockdown-gate');

test('lockdown classification covers every manifest tool exactly once', () => {
  const manifestNames = manifest.tools.map((tool) => tool.name).sort();
  const classifiedNames = Object.keys(TOOL_NETWORK_CLASSIFICATION).sort();

  assert.equal(manifestNames.length, 51);
  assert.deepEqual(classifiedNames, manifestNames);
  assert.equal(TOOL_NETWORK_CLASSIFICATION.task_board, 'none');
  assert.equal(Object.values(TOOL_NETWORK_CLASSIFICATION).every(
    (classification) => classification === 'none' || classification === 'possible'
  ), true);
});

test('lockdown is fail-closed for unknown tools and shell-capable builtins', () => {
  for (const toolName of [
    'future_unclassified_tool', 'run_command', 'python_execute', 'monitor', 'lsp',
  ]) {
    assert.equal(isToolAvailableDuringSessionLockdown(toolName, true), false);
    assert.equal(isToolAvailableDuringSessionLockdown(toolName, false), true);
  }
});

test('lockdown tool preferences deny network-capable tools without widening composer preferences', () => {
  const locked = applySessionLockdownToToolPreferences({
    enabled_tools: ['read_file', 'web_search', 'future_unclassified_tool'],
    disabled_tools: ['write_file'],
    disabled_tool_families: ['background'],
  }, true);

  assert.deepEqual(locked.enabled_tools, ['read_file']);
  assert.equal(locked.disabled_tools.includes('web_search'), true);
  assert.equal(locked.disabled_tools.includes('fetch_url'), true);
  assert.equal(locked.disabled_tools.includes('run_command'), true);
  assert.equal(locked.disabled_tools.includes('python_execute'), true);
  assert.deepEqual(locked.disabled_tool_families, ['background']);
  assert.deepEqual(
    applySessionLockdownToToolPreferences(null, false),
    null
  );
});

test('feature rollback makes a persisted lockdown preference inert', () => {
  assert.equal(isSessionOfflineLockdownActive(
    { session_offline_lockdown: true }, { lockdown: true }
  ), true);
  assert.equal(isSessionOfflineLockdownActive(
    { session_offline_lockdown: false }, { lockdown: true }
  ), false);
  assert.equal(isSessionOfflineLockdownActive(
    { session_offline_lockdown: true }, { lockdown: 'true' }
  ), false);
});

test('remote engines refuse before dispatch while local engines remain available', () => {
  for (const engineType of ['ollama', 'vllm', 'mock', 'replay']) {
    assert.equal(assertSessionLockdownAllowsEngine({
      active: true, engineType,
    }), undefined);
  }
  assert.equal(assertSessionLockdownAllowsEngine({
    active: true,
    engineType: 'openai-compatible',
    openAiCompatibleApiUrl: 'http://127.0.0.1:8080',
  }), undefined);
  assert.equal(assertSessionLockdownAllowsEngine({
    active: true,
    engineType: 'openai-compatible',
    openAiCompatibleApiUrl: 'http://[::1]:8080',
  }), undefined);
  for (const engine of [
    { engineType: 'chatgpt' },
    { engineType: 'codex-cli' },
    { engineType: 'openai-compatible', openAiCompatibleApiUrl: 'https://api.example.test/v1' },
    { engineType: 'openai-compatible', openAiCompatibleApiUrl: 'https://127.attacker.test/v1' },
  ]) {
    assert.throws(
      () => assertSessionLockdownAllowsEngine({ active: true, ...engine }),
      (error) => error?.code === LOCKDOWN_REMOTE_ENGINE
        && error?.retryable === false
        && error?.user_visible === true
    );
  }
  assert.equal(assertSessionLockdownAllowsEngine({
    active: false,
    engineType: 'chatgpt',
  }), undefined);
});

test('a requested local-looking model cannot hide the running remote engine', () => {
  const buildService = (apiUrl) => ({
    currentEngineType: 'openai-compatible',
    featureFlags: { session_offline_lockdown: true },
    configService: { getState: () => ({ localEngines: { openaiCompatible: { apiUrl } } }) },
  });
  const request = { requestedEngine: '', requestedModel: 'qwen2.5-coder:14b' };

  assert.throws(
    () => resolveSessionLockdownRequest(buildService('https://api.openai.com/v1'),
      { lockdown: true }, request, null),
    (error) => error?.code === LOCKDOWN_REMOTE_ENGINE
  );
  assert.doesNotThrow(() => resolveSessionLockdownRequest(
    buildService('http://127.0.0.1:8080'), { lockdown: true }, request, null
  ));
});

test('engine admission consults catalog hints and the configured pin, and re-checks the resolved engine', () => {
  const buildService = ({ hints = [], pin = 'ollama', apiUrl = 'http://127.0.0.1:8080' } = {}) => ({
    currentEngineType: 'ollama',
    featureFlags: { session_offline_lockdown: true },
    _modelEngineHints: new Map(hints),
    configService: { getState: () => ({ preferredEngineType: pin, localEngines: { openaiCompatible: { apiUrl } } }) },
  });
  const request = { requestedEngine: '', requestedModel: 'qwen2.5-coder:14b' };
  const isRefusal = (error) => error?.code === LOCKDOWN_REMOTE_ENGINE;

  // The catalog's provenance hint routes this local-looking model to a remote engine.
  assert.throws(() => resolveSessionLockdownRequest(
    buildService({ hints: [['qwen2.5-coder:14b', 'chatgpt']] }), { lockdown: true }, request, null
  ), isRefusal);
  // The configured openai-compatible pin points at a remote endpoint.
  assert.throws(() => resolveSessionLockdownRequest(
    buildService({ pin: 'openai-compatible', apiUrl: 'https://api.example.test/v1' }), { lockdown: true }, request, null
  ), isRefusal);
  // Local everywhere admits; the post-resolution re-check catches an engine switch.
  const service = buildService();
  const admitted = resolveSessionLockdownRequest(service, { lockdown: true }, request, null);
  assert.equal(admitted.active, true);
  assert.equal(admitted.assertResolvedEngine(), undefined);
  service.currentEngineType = 'chatgpt';
  assert.throws(() => admitted.assertResolvedEngine(), isRefusal);
});

async function settleManagedStream(service, request) {
  const stream = await startManagedSidecarChatStream(service, request);
  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;
  return stream;
}

test('request assembly isolates locked and unlocked tool offers in one process', async () => {
  const captured = [];
  const service = createManagedChatServiceStub({
    featureFlags: { session_offline_lockdown: true },
  });
  // A real BackendService always carries an engine type; the resolved-engine
  // re-check fails closed on an empty one.
  service.currentEngineType = 'ollama';
  service.setSessionPreferences = async (sessionId, preferences) =>
    service.sessionStore.setSessionPreferences(sessionId, preferences);
  service.sidecarClient = {
    async chatSend(params, options = {}) {
      captured.push(params);
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };
  const toolPreferences = { web_search: true, file_tools: true };

  await settleManagedStream(service, buildManagedChatRequest({
    sessionId: 'session-locked-tools',
    normalizedPreferences: { lockdown: true },
    toolPreferences,
  }));
  await settleManagedStream(service, buildManagedChatRequest({
    sessionId: 'session-unlocked-tools',
    normalizedPreferences: { lockdown: false },
    toolPreferences,
  }));

  assert.equal(captured[0].session_offline_lockdown, true);
  assert.equal(captured[0].tool_preferences.enabled_tools.includes('read_file'), true);
  assert.equal(captured[0].tool_preferences.enabled_tools.includes('web_search'), false);
  assert.equal(captured[0].tool_preferences.enabled_tools.includes('fetch_url'), false);
  assert.equal(captured[0].tool_preferences.disabled_tools.includes('web_search'), true);
  assert.equal(captured[0].tool_preferences.disabled_tools.includes('fetch_url'), true);
  assert.equal(captured[1].session_offline_lockdown, false);
  assert.equal(captured[1].tool_preferences.enabled_tools.includes('read_file'), true);
  assert.equal(captured[1].tool_preferences.enabled_tools.includes('web_search'), true);
  assert.equal(captured[1].tool_preferences.enabled_tools.includes('fetch_url'), true);
});

test('managed remote refusal happens before sidecar dispatch and locked local send proceeds', async () => {
  let sidecarCalls = 0;
  let modelResolutionCalls = 0;
  const service = createManagedChatServiceStub({
    featureFlags: { session_offline_lockdown: true },
  });
  service.setSessionPreferences = async (sessionId, preferences) =>
    service.sessionStore.setSessionPreferences(sessionId, preferences);
  service.currentEngineType = 'mock';
  service._resolveModel = async () => {
    modelResolutionCalls += 1;
    return 'test-model';
  };
  service.sidecarClient = {
    async chatSend(_params, options = {}) {
      sidecarCalls += 1;
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  await settleManagedStream(service, buildManagedChatRequest({
    sessionId: 'session-locked-engine',
    runtimePreferredEngineType: 'codex-cli',
    normalizedPreferences: { lockdown: true },
  }));
  const refusal = service.emittedEvents.find(
    (entry) => entry.eventName === 'chat-stream'
      && entry.payload?.error_code === LOCKDOWN_REMOTE_ENGINE
  );
  assert.equal(sidecarCalls, 0);
  assert.equal(modelResolutionCalls, 0);
  assert.equal(refusal.payload.status, 'runtime_error');
  assert.equal(refusal.payload.retryable, false);

  await settleManagedStream(service, buildManagedChatRequest({
    sessionId: 'session-locked-engine',
    runtimePreferredEngineType: 'mock',
    normalizedPreferences: { lockdown: true },
  }));
  assert.equal(sidecarCalls, 1);
  assert.equal(modelResolutionCalls, 1);

  await settleManagedStream(service, buildManagedChatRequest({
    sessionId: 'session-locked-engine',
    runtimePreferredModel: 'gpt-5.2',
    normalizedPreferences: { lockdown: true },
  }));
  assert.equal(sidecarCalls, 1);
  assert.equal(modelResolutionCalls, 1);
});

test('flag off keeps persisted lockdown inert at request assembly and engine dispatch', async () => {
  const captured = [];
  const service = createManagedChatServiceStub({
    featureFlags: { session_offline_lockdown: false },
  });
  service.setSessionPreferences = async (sessionId, preferences) =>
    service.sessionStore.setSessionPreferences(sessionId, preferences);
  service.sidecarClient = {
    async chatSend(params, options = {}) {
      captured.push(params);
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  await settleManagedStream(service, buildManagedChatRequest({
    sessionId: 'session-lockdown-rollback',
    runtimePreferredEngineType: 'codex-cli',
    normalizedPreferences: { lockdown: true },
    toolPreferences: { web_search: true, Bash: true },
  }));

  assert.equal(captured.length, 1);
  assert.equal(captured[0].session_offline_lockdown, false);
  assert.equal(captured[0].tool_preferences.enabled_tools.includes('web_search'), true);
  assert.equal(captured[0].tool_preferences.enabled_tools.includes('fetch_url'), true);
  assert.equal(captured[0].tool_preferences.enabled_tools.includes('run_command'), true);
});
