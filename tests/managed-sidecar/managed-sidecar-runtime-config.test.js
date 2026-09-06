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
  createManagedServiceWithConfig,
} = require('../helpers/managed-sidecar-runtime-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar refreshManagedConfig forwards no archived provider secrets', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-no-cloud-secrets-'));
  trackDirectory(userDataPath);

  const service = createManagedServiceWithConfig(userDataPath, {
    getState() {
      return {};
    },
  });
  service.providerIntegrationRegistry = {
    getManagedConfigPatch() {
      return {};
    },
    getManagedSecretsPatch() {
      return {
        openai_api_key: 'stale-openai-secret',
        anthropic_api_key: 'stale-anthropic-secret',
        gemini_api_key: 'stale-gemini-secret',
      };
    },
  };

  await service.start();

  const originalInitialize = service.sidecarClient.initialize.bind(service.sidecarClient);
  const capturedSecrets = [];
  service.sidecarClient.initialize = async (payload) => {
    capturedSecrets.push(payload?.secrets);
    return originalInitialize(payload);
  };

  await service.refreshManagedConfig('archived_provider_secrets_ignored');

  assert.deepEqual(capturedSecrets, [{}]);

  await service.stop();
});

test('managed sidecar refreshManagedConfig forwards hidden image read config', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-image-read-config-'));
  trackDirectory(userDataPath);

  const configState = {
    toolsWorkspaceRoot: '',
    tools: { web: false, mermaid: false, imageRead: false, pythonRuntime: false },
  };
  const configService = {
    getState() {
      return { ...configState };
    },
  };
  const service = createManagedServiceWithConfig(userDataPath, configService);

  await service.start();

  const originalInitialize = service.sidecarClient.initialize.bind(service.sidecarClient);
  const capturedFlags = [];
  service.sidecarClient.initialize = async (payload) => {
    capturedFlags.push(payload?.config?.tools_image_read_enabled === true);
    return originalInitialize(payload);
  };

  configState.tools = { ...configState.tools, imageRead: true };
  await service.refreshManagedConfig('tools_image_read_enabled_updated');

  configState.tools = { ...configState.tools, imageRead: false };
  await service.refreshManagedConfig('tools_image_read_enabled_updated');

  assert.deepEqual(capturedFlags.slice(-2), [true, false]);

  await service.stop();
});

// The Mermaid preference is retired: the flag is forwarded as force-enabled and
// a stale persisted `tools.mermaid` value must not turn it off.
test('managed sidecar refreshManagedConfig forwards mermaid tool config as force-enabled', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-mermaid-config-'));
  trackDirectory(userDataPath);

  const configState = {
    toolsWorkspaceRoot: '',
    tools: { web: false, mermaid: false, imageRead: false, pythonRuntime: false },
  };
  const configService = {
    getState() {
      return { ...configState };
    },
  };
  const service = createManagedServiceWithConfig(userDataPath, configService);

  await service.start();

  const originalInitialize = service.sidecarClient.initialize.bind(service.sidecarClient);
  const capturedFlags = [];
  service.sidecarClient.initialize = async (payload) => {
    capturedFlags.push(payload?.config?.tools_mermaid_enabled === true);
    return originalInitialize(payload);
  };

  configState.tools = { ...configState.tools, mermaid: true };
  await service.refreshManagedConfig('feature_settings_updated');

  configState.tools = { ...configState.tools, mermaid: false };
  await service.refreshManagedConfig('feature_settings_updated');

  assert.deepEqual(capturedFlags.slice(-2), [true, true]);

  await service.stop();
});

test('managed sidecar refreshManagedConfig forwards default-off subagent tool config', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-subagent-config-'));
  trackDirectory(userDataPath);

  const configState = {
    toolsWorkspaceRoot: '',
    toolsSubagentsEnabled: false,
  };
  const configService = {
    getState() {
      return { ...configState };
    },
  };
  const service = createManagedServiceWithConfig(userDataPath, configService);

  await service.start();

  const originalInitialize = service.sidecarClient.initialize.bind(service.sidecarClient);
  const capturedFlags = [];
  service.sidecarClient.initialize = async (payload) => {
    capturedFlags.push(payload?.config?.tools_subagents_enabled === true);
    return originalInitialize(payload);
  };

  configState.toolsSubagentsEnabled = true;
  await service.refreshManagedConfig('tools_subagents_enabled_updated');

  configState.toolsSubagentsEnabled = false;
  await service.refreshManagedConfig('tools_subagents_enabled_updated');

  assert.deepEqual(capturedFlags.slice(-2), [true, false]);

  await service.stop();
});

test('managed sidecar refreshManagedConfig forwards rich file tool config', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-rich-files-config-'));
  trackDirectory(userDataPath);

  const configState = {
    toolsWorkspaceRoot: '',
    tools: {
      richFiles: false,
    },
  };
  const configService = {
    getState() {
      return { ...configState, tools: { ...configState.tools } };
    },
  };
  const service = createManagedServiceWithConfig(userDataPath, configService);

  await service.start();

  const originalInitialize = service.sidecarClient.initialize.bind(service.sidecarClient);
  const capturedFlags = [];
  service.sidecarClient.initialize = async (payload) => {
    capturedFlags.push(payload?.config?.tools_rich_files_enabled === true);
    return originalInitialize(payload);
  };

  configState.tools.richFiles = true;
  await service.refreshManagedConfig('tools_rich_files_enabled_updated');

  configState.tools.richFiles = false;
  await service.refreshManagedConfig('tools_rich_files_enabled_updated');

  assert.deepEqual(capturedFlags.slice(-2), [true, false]);

  await service.stop();
});

test('managed sidecar refreshManagedConfig forwards hidden Batch 1 config fields', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-batch1-config-'));
  trackDirectory(userDataPath);

  const configState = {
    toolsWorkspaceRoot: '',
    tools: { web: false, mermaid: false, imageRead: false, pythonRuntime: false },
    maxToolsPerTurn: 11,
    maxLoopIterations: 12,
    maxLoopWallSeconds: 300,
    maxBudgetUsd: 10.5,
    maxInlinePayloadBytes: 48_000,
    modelTuning: { streamInactivitySecondsByModel: { 'mock-v1': 60 } },
    diagnosticsLogLevel: 'warning',
    diagnosticsCaptureMode: 'sanitized_snippets',
  };
  const configService = {
    getState() {
      return { ...configState };
    },
  };
  const service = createManagedServiceWithConfig(userDataPath, configService);

  await service.start();

  const originalInitialize = service.sidecarClient.initialize.bind(service.sidecarClient);
  const capturedConfigs = [];
  service.sidecarClient.initialize = async (payload) => {
    capturedConfigs.push({
      max_tools_per_turn: payload?.config?.max_tools_per_turn,
      max_loop_iterations: payload?.config?.max_loop_iterations,
      max_loop_wall_seconds: payload?.config?.max_loop_wall_seconds,
      max_budget_usd: payload?.config?.max_budget_usd,
      max_inline_payload_bytes: payload?.config?.max_inline_payload_bytes,
      chunk_inactivity_seconds: payload?.config?.chunk_inactivity_seconds,
      diagnostics_log_level: payload?.config?.diagnostics_log_level,
      diagnostics_capture_mode: payload?.config?.diagnostics_capture_mode,
    });
    return originalInitialize(payload);
  };

  configState.maxToolsPerTurn = 7;
  configState.maxLoopIterations = 10;
  configState.maxLoopWallSeconds = 900;
  configState.maxBudgetUsd = 2.25;
  configState.maxInlinePayloadBytes = 12_000;
  configState.modelTuning = { streamInactivitySecondsByModel: { 'mock-v1': 180 } };
  configState.diagnosticsLogLevel = 'error';
  configState.diagnosticsCaptureMode = 'redacted';
  await service.refreshManagedConfig('batch1_hidden_config_updated');

  assert.deepEqual(capturedConfigs, [{
    max_tools_per_turn: 7,
    max_loop_iterations: 10,
    max_loop_wall_seconds: 900,
    max_budget_usd: 2.25,
    max_inline_payload_bytes: 12_000,
    chunk_inactivity_seconds: 180,
    diagnostics_log_level: 'error',
    diagnostics_capture_mode: 'redacted',
  }]);

  await service.stop();
});

/* ── buildManagedSidecarConfig: localEngines.vllm → api_url ── */

const {
  buildManagedSidecarConfig,
  buildManagedSidecarSecrets,
} = require('../../services/backend/managed-sidecar-lifecycle');

function makeFakeService({ engineType, model, localEngines, configState, secureStore }) {
  return {
    currentEngineType: engineType,
    currentModel: model || '',
    defaultModel: model || '',
    options: { userDataPath: os.tmpdir() },
    personalityWorkspace: { workspacePath: '' },
    featureFlags: {},
    providerIntegrationRegistry: { getManagedConfigPatch: () => ({}) },
    skillsService: null,
    secureStore: secureStore || null,
    configService: {
      getState: () => ({
        ...(configState || {}),
        localEngines: localEngines || configState?.localEngines || {},
      }),
    },
    _emitServiceLog: () => {},
  };
}

test('buildManagedSidecarConfig emits api_url for vllm when localEngines.vllm.port set', () => {
  const fake = makeFakeService({
    engineType: 'vllm',
    model: 'Qwen/Qwen3.6-35B-A3B',
    localEngines: { vllm: { port: 8077 } },
  });
  const config = buildManagedSidecarConfig(fake);
  assert.equal(config.engine_type, 'vllm');
  assert.equal(config.api_url, 'http://127.0.0.1:8077');
});

test('buildManagedSidecarConfig forwards Phase 10 resource discipline caps', () => {
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    configState: {
      maxChatLoopIterations: 7,
      maxTaskLoopIterations: 29,
      maxSubAgentLoopIterations: 9,
      maxSubAgentConcurrency: 3,
      maxCloudSubAgentConcurrency: 2,
      maxWebToolCallsPerTurn: 3,
      maxToolCallsPerSession: 80,
    },
  });
  const config = buildManagedSidecarConfig(fake);

  assert.equal(config.max_chat_loop_iterations, 7);
  assert.equal(config.max_task_loop_iterations, 29);
  assert.equal(config.max_sub_agent_loop_iterations, 9);
  assert.equal(config.max_sub_agent_concurrency, 3);
  assert.equal(config.max_cloud_sub_agent_concurrency, 2);
  assert.equal(config.max_web_tool_calls_per_turn, 3);
  assert.equal(config.max_tool_calls_per_session, 80);
  // 2026-08-30: local working-time default raised to 1800 seconds.
  assert.equal(config.max_loop_wall_seconds, 1_800);
});

test('buildManagedSidecarConfig defaults active sub-agent capacity to one', () => {
  const config = buildManagedSidecarConfig(makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    configState: {},
  }));

  assert.equal(config.max_sub_agent_concurrency, 1);
  assert.equal(config.max_cloud_sub_agent_concurrency, 3);
});

test('buildManagedSidecarConfig omits api_url for vllm when port missing', () => {
  const fake = makeFakeService({
    engineType: 'vllm',
    model: 'Qwen/Qwen3.6-35B-A3B',
    localEngines: {},
  });
  const config = buildManagedSidecarConfig(fake);
  assert.equal(config.engine_type, 'vllm');
  assert.equal(config.api_url, undefined);
});

test('buildManagedSidecarConfig does not emit api_url for ollama', () => {
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    localEngines: { vllm: { port: 8077 } },
  });
  const config = buildManagedSidecarConfig(fake);
  assert.equal(config.engine_type, 'ollama');
  assert.equal(config.api_url, undefined);
});

test('buildManagedSidecarConfig does not emit api_url for mock engine', () => {
  const fake = makeFakeService({
    engineType: 'mock',
    model: 'mock-v1',
    localEngines: { vllm: { port: 8077 } },
  });
  const config = buildManagedSidecarConfig(fake);
  assert.equal(config.engine_type, 'mock');
  assert.equal(config.api_url, undefined);
});

test('buildManagedSidecarConfig emits api_url for openai-compatible from port', () => {
  const fake = makeFakeService({
    engineType: 'openai-compatible',
    model: 'Qwen/Qwen3.6-35B-A3B',
    localEngines: { openaiCompatible: { port: 8033 } },
  });
  const config = buildManagedSidecarConfig(fake);
  assert.equal(config.engine_type, 'openai-compatible');
  assert.equal(config.api_url, 'http://127.0.0.1:8033');
});

test('buildManagedSidecarConfig prefers explicit apiUrl for openai-compatible', () => {
  const fake = makeFakeService({
    engineType: 'openai-compatible',
    model: 'Qwen/Qwen3.6-35B-A3B',
    localEngines: {
      openaiCompatible: { port: 8033, apiUrl: 'http://127.0.0.1:9100/v1' },
    },
  });
  const config = buildManagedSidecarConfig(fake);
  assert.equal(config.engine_type, 'openai-compatible');
  assert.equal(config.api_url, 'http://127.0.0.1:9100/v1');
});

test('buildManagedSidecarConfig omits api_url for openai-compatible when state empty', () => {
  const fake = makeFakeService({
    engineType: 'openai-compatible',
    model: 'Qwen/Qwen3.6-35B-A3B',
    localEngines: {},
  });
  const config = buildManagedSidecarConfig(fake);
  assert.equal(config.engine_type, 'openai-compatible');
  assert.equal(config.api_url, undefined);
});

test('managed sidecar sends Sentry DSN through secrets while config carries only consent', () => {
  const dsn = 'https://public@o123.ingest.sentry.io/456';
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    configState: {
      telemetry: {
        crashReportingOptIn: true,
      },
    },
    secureStore: {
      getSentryDsn: () => dsn,
    },
  });

  const config = buildManagedSidecarConfig(fake);
  const secrets = buildManagedSidecarSecrets(fake);

  assert.equal(config.crash_reporting_opt_in, true);
  assert.equal(config.telemetry_dsn, undefined);
  assert.equal(secrets.telemetry_dsn, dsn);
  assert.doesNotMatch(JSON.stringify(config), /ingest\.sentry\.io/);
});

test('managed sidecar omits Sentry DSN secrets when crash reporting is disabled', () => {
  let readCount = 0;
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    configState: {
      telemetry: {
        crashReportingOptIn: false,
      },
    },
    secureStore: {
      getSentryDsn: () => {
        readCount += 1;
        return 'https://public@o123.ingest.sentry.io/456';
      },
    },
  });

  const config = buildManagedSidecarConfig(fake);
  const secrets = buildManagedSidecarSecrets(fake);

  assert.equal(config.crash_reporting_opt_in, false);
  assert.deepEqual(secrets, {});
  assert.equal(readCount, 0);
});

test('managed sidecar treats canonical telemetry opt-out as authoritative over legacy fields', () => {
  let readCount = 0;
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    configState: {
      crashReportingOptIn: true,
      crash_reporting_opt_in: true,
      telemetry: {
        crashReportingOptIn: false,
      },
    },
    secureStore: {
      getSentryDsn: () => {
        readCount += 1;
        return 'https://public@o123.ingest.sentry.io/456';
      },
    },
  });

  const config = buildManagedSidecarConfig(fake);
  const secrets = buildManagedSidecarSecrets(fake);

  assert.equal(config.crash_reporting_opt_in, false);
  assert.deepEqual(secrets, {});
  assert.equal(readCount, 0);
});

test('managed sidecar omits Sentry DSN secrets when credential status lookup fails', () => {
  const logs = [];
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    configState: {
      telemetry: {
        crashReportingOptIn: true,
      },
    },
    secureStore: {
      getSentryDsn: () => {
        throw new Error('safeStorage is not ready');
      },
      getStatus: () => {
        throw new Error('status probe failed');
      },
    },
  });
  fake._emitServiceLog = (level, event, details) => logs.push({ level, event, details });

  assert.deepEqual(buildManagedSidecarSecrets(fake), {});
  assert.deepEqual(logs, [
    {
      level: 'WARN',
      event: 'telemetry.dsn_read_failed',
      details: {
        errorName: 'Error',
        credentialStore: null,
      },
    },
  ]);
});

/* ── Multi-provider web search: getConfiguredTools* getters + config wiring ── */

const {
  getConfiguredToolsWebSearchProvider,
  getConfiguredToolsWebSearchProviderKeys,
  getConfiguredToolsWebSearxngUrl,
} = require('../../services/backend/managed-sidecar-config');

test('getConfiguredToolsWebSearchProvider defaults to duckduckgo when unset', () => {
  const fake = makeFakeService({ engineType: 'ollama', model: 'qwen3.5:9b', configState: {} });
  assert.equal(getConfiguredToolsWebSearchProvider(fake), 'duckduckgo');
});

test('getConfiguredToolsWebSearchProvider reads the configured provider', () => {
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    configState: { webSearch: { provider: 'brave' } },
  });
  assert.equal(getConfiguredToolsWebSearchProvider(fake), 'brave');
});

test('getConfiguredToolsWebSearxngUrl returns null when unset and the trimmed url when configured', () => {
  const unset = makeFakeService({ engineType: 'ollama', model: 'qwen3.5:9b', configState: {} });
  assert.equal(getConfiguredToolsWebSearxngUrl(unset), null);

  const configured = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    configState: { webSearch: { searxngUrl: '  http://127.0.0.1:8080  ' } },
  });
  assert.equal(getConfiguredToolsWebSearxngUrl(configured), 'http://127.0.0.1:8080');
});

test('getConfiguredToolsWebSearchProviderKeys returns null when no secure store is present', () => {
  const fake = makeFakeService({ engineType: 'ollama', model: 'qwen3.5:9b', configState: {} });
  assert.equal(getConfiguredToolsWebSearchProviderKeys(fake), null);
});

test('getConfiguredToolsWebSearchProviderKeys returns null when the secure store has no configured keys', () => {
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    configState: {},
    secureStore: {
      getWebSearchProviderKey: () => '',
    },
  });
  assert.equal(getConfiguredToolsWebSearchProviderKeys(fake), null);
});

test('getConfiguredToolsWebSearchProviderKeys returns only non-empty configured provider keys', () => {
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    configState: {},
    secureStore: {
      getWebSearchProviderKey: (keyId) => {
        if (keyId === 'brave') {
          return 'brave-secret';
        }
        if (keyId === 'tavily') {
          return '';
        }
        return '';
      },
    },
  });
  assert.deepEqual(getConfiguredToolsWebSearchProviderKeys(fake), { brave: 'brave-secret' });
});

test('getConfiguredToolsWebSearchProviderKeys logs a WARN and skips a key id whose read throws', () => {
  const logs = [];
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    configState: {},
    secureStore: {
      getWebSearchProviderKey: (keyId) => {
        if (keyId === 'brave') {
          throw new Error('safeStorage is not ready');
        }
        if (keyId === 'tavily') {
          return 'tavily-secret';
        }
        return '';
      },
    },
  });
  fake._emitServiceLog = (level, event, details) => logs.push({ level, event, details });

  assert.deepEqual(getConfiguredToolsWebSearchProviderKeys(fake), { tavily: 'tavily-secret' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].event, 'web_search.provider_key_read_failed');
  assert.equal(logs[0].details.keyId, 'brave');
});

test('buildManagedSidecarConfig carries tools_web_search_provider, tools_web_searxng_url, and tools_web_search_provider_keys', () => {
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    configState: {
      webSearch: {
        provider: 'searxng',
        searxngUrl: 'http://127.0.0.1:8080',
      },
    },
    secureStore: {
      getWebSearchProviderKey: (keyId) => (keyId === 'serper' ? 'serper-secret' : ''),
    },
  });

  const config = buildManagedSidecarConfig(fake);

  assert.equal(config.tools_web_search_provider, 'searxng');
  assert.equal(config.tools_web_searxng_url, 'http://127.0.0.1:8080');
  assert.deepEqual(config.tools_web_search_provider_keys, { serper: 'serper-secret' });
});

test('buildManagedSidecarConfig defaults web search fields when nothing is configured', () => {
  const fake = makeFakeService({ engineType: 'ollama', model: 'qwen3.5:9b', configState: {} });

  const config = buildManagedSidecarConfig(fake);

  assert.equal(config.tools_web_search_provider, 'duckduckgo');
  assert.equal(config.tools_web_searxng_url, null);
  assert.equal(config.tools_web_search_provider_keys, null);
});
