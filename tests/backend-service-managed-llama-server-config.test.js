const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

// Managed llama-server <-> sidecar config seams: the per-launch api key is
// brokered only to the endpoint that shares the managed server's local origin,
// and only that endpoint takes the server's alias as its model.
const { BackendService } = require('../services/backend/backend-service');
const { DEFAULT_MANAGED_SHELL_MODEL } = require('../services/backend/backend-config');
const {
  buildManagedSidecarConfig,
  buildManagedSidecarSecrets,
} = require('../services/backend/managed-sidecar-lifecycle');
const { resolveManagedConfiguredModel } = require('../services/backend/managed-sidecar-config');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar brokers the managed llama-server key only for openai-compatible', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-llama-key-'));
  let openaiCompatApiUrl = '';
  trackDirectory(userDataPath);
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    configService: {
      getState: () => ({ localEngines: { openaiCompatible: { port: 8033, apiUrl: openaiCompatApiUrl } } }),
    },
    getLlamaServerManager: () => ({
      getApiKey: () => 'abc',
      getBaseUrl: () => 'http://localhost:8033/v1',
    }),
  });

  service.currentEngineType = 'openai-compatible';
  // Default configured port 8033 -> api_url http://127.0.0.1:8033; the managed
  // server reports localhost:8033 — same local origin, key travels.
  assert.equal(buildManagedSidecarConfig(service).api_url, 'http://127.0.0.1:8033');
  assert.deepEqual(buildManagedSidecarSecrets(service), {
    openai_compatible_api_key: 'abc',
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      buildManagedSidecarConfig(service),
      'openai_compatible_api_key'
    ),
    false
  );

  service.currentEngineType = 'ollama';
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      buildManagedSidecarSecrets(service),
      'openai_compatible_api_key'
    ),
    false
  );

  service.currentEngineType = 'openai-compatible';
  service.options.getLlamaServerManager = () => ({ getApiKey: () => '', getBaseUrl: () => 'http://127.0.0.1:8033/v1' });
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      buildManagedSidecarSecrets(service),
      'openai_compatible_api_key'
    ),
    false
  );

  // A key must never be handed to an endpoint that is not the managed server:
  // here the sidecar targets port 8033 but the managed server sits on 9000.
  service.options.getLlamaServerManager = () => ({ getApiKey: () => 'abc', getBaseUrl: () => 'http://127.0.0.1:9000/v1' });
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      buildManagedSidecarSecrets(service),
      'openai_compatible_api_key'
    ),
    false,
    'endpoint on another port never receives the managed key'
  );

  service.options.getLlamaServerManager = () => null;
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      buildManagedSidecarSecrets(service),
      'openai_compatible_api_key'
    ),
    false
  );

  // An explicit user-run endpoint wins over the configured port and is not
  // the managed server, even though the managed server is up on 8033.
  service.options.getLlamaServerManager = () => ({ getApiKey: () => 'abc', getBaseUrl: () => 'http://127.0.0.1:8033/v1' });
  openaiCompatApiUrl = 'http://127.0.0.1:9000/v1';
  assert.equal(buildManagedSidecarConfig(service).api_url, 'http://127.0.0.1:9000/v1');
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      buildManagedSidecarSecrets(service),
      'openai_compatible_api_key'
    ),
    false,
    'explicit foreign endpoint never receives the managed key'
  );
});

test('resolveManagedConfiguredModel uses a ready llama-server alias only for the managed origin', () => {
  const resolve = (status, apiUrl = '') => resolveManagedConfiguredModel({
    currentEngineType: 'openai-compatible',
    currentModel: 'configured-model',
    configService: { getState: () => ({ localEngines: { openaiCompatible: { port: 8033, apiUrl } } }) },
    options: { getLlamaServerManager: () => ({
      getStatus: () => status,
      getBaseUrl: () => 'http://127.0.0.1:8033',
    }) },
  });
  assert.deepEqual([
    resolve({ state: 'ready', alias: 'managed-alias' }),
    resolve({ state: 'ready', alias: 'managed-alias' }, 'http://localhost:8033/v1'),
    resolve({ state: 'stopped', alias: 'managed-alias' }),
    resolve({ state: 'ready', alias: '' }),
    // The user's own endpoint keeps its configured model even while the
    // managed server is up.
    resolve({ state: 'ready', alias: 'managed-alias' }, 'http://127.0.0.1:9000/v1'),
  ], ['managed-alias', 'managed-alias', 'configured-model', 'configured-model', 'configured-model']);
});

test('per-model context override supports local engines and wins over the managed profile window', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-context-llama-override-'));
  trackDirectory(userDataPath);
  const model = 'qwen3.8:27b-q3-k-s';
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    configService: {
      getState: () => ({
        compactionTuning: { contextLengthByModel: { [model]: 65_536 } },
        localEngines: { openaiCompatible: { port: 8033, apiUrl: '' } },
      }),
    },
    managedLlamaServerProfile: { contextSize: 131_072 },
  });
  service.currentEngineType = 'openai-compatible';
  service.currentModel = model;

  let config = buildManagedSidecarConfig(service);

  assert.equal(config.context_length_override, 65_536);
  assert.equal(config.context_length, 65_536);

  service.currentEngineType = 'ollama';
  config = buildManagedSidecarConfig(service);
  assert.equal(config.context_length_override, 65_536);

  service.currentEngineType = 'chatgpt';
  config = buildManagedSidecarConfig(service);
  assert.equal(config.context_length_override, null);
});

// The drawer stores the override under the model-list tag, but a ready managed
// server reports itself under stripLatestTag(tag). Without the ':latest' retry
// the sidecar budgets the profile window against a server launched with -c.
test('a :latest override still resolves through the managed alias the server reports', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-context-latest-alias-'));
  trackDirectory(userDataPath);
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    configService: {
      getState: () => ({
        compactionTuning: { contextLengthByModel: { 'gemma3:latest': 65_536 } },
        localEngines: { openaiCompatible: { port: 8033, apiUrl: '' } },
      }),
    },
    managedLlamaServerProfile: { contextSize: 131_072 },
    getLlamaServerManager: () => ({
      getStatus: () => ({ state: 'ready', alias: 'gemma3' }),
      getBaseUrl: () => 'http://127.0.0.1:8033',
    }),
  });
  service.currentEngineType = 'openai-compatible';
  service.currentModel = 'gemma3:latest';

  const config = buildManagedSidecarConfig(service);

  assert.equal(config.model, 'gemma3');
  assert.equal(config.context_length_override, 65_536);
  assert.equal(config.context_length, 65_536);
});
