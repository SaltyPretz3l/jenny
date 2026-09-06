const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { DEFAULT_MANAGED_SHELL_MODEL } = require('../services/backend/backend-config');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createManagedService(userDataPath, overrides = {}) {
  return new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    ...overrides,
  });
}

test('backend service preserves Ollama catalog capability metadata for managed local models', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-managed-model-capabilities-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  service.sidecarClient = {
    async modelsList(engineType) {
      assert.equal(engineType, 'ollama');
      return {
        models: [
          { id: 'gemma3:4b', capabilities: { vision: true } },
          { id: 'qwen3.5:9b', capabilities: { thinking: true } },
        ],
        available: true,
        reason: '',
        source: 'cache',
        stale: true,
        cached_at: '2026-05-06T12:00:00Z',
        expires_at: '2026-05-07T12:00:00Z',
        last_error: 'connection_error',
        daemon_version: '0.12.6',
      };
    },
  };

  const models = await service.listModelsForEngine('ollama');

  assert.equal(models.source, 'cache');
  assert.equal(models.stale, true);
  assert.equal(models.cached_at, '2026-05-06T12:00:00Z');
  assert.equal(models.expires_at, '2026-05-07T12:00:00Z');
  assert.equal(models.last_error, 'connection_error');
  assert.equal(models.daemon_version, '0.12.6');
  assert.deepEqual(models.data, [
    { id: 'gemma3:4b', engine_type: 'ollama', capabilities: { vision: true } },
    { id: 'qwen3.5:9b', engine_type: 'ollama', capabilities: { thinking: true } },
  ]);
});

test('backend service forwards and normalizes exact Ollama model inspection', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-model-inspection-'));
  trackDirectory(userDataPath);
  const service = createManagedService(userDataPath);
  service.sidecarClient = {
    async modelsList(engineType, options) {
      assert.equal(engineType, 'ollama');
      assert.deepEqual(options, { inspectModelId: 'ornith15:9b-q6-256k' });
      return {
        models: [{ id: 'ornith15:9b-q6-256k' }],
        available: true,
        model_inspection: {
          model_id: 'ornith15:9b-q6-256k',
          available: true,
          native_context_length: 262144,
          reason: '',
        },
      };
    },
  };

  const models = await service.listModelsForEngine('ollama', {
    inspectModelId: 'ornith15:9b-q6-256k',
  });

  assert.deepEqual(models.modelInspection, {
    modelId: 'ornith15:9b-q6-256k',
    available: true,
    nativeContextLength: 262144,
    reason: '',
  });
  assert.deepEqual(models.data, [
    { id: 'ornith15:9b-q6-256k', engine_type: 'ollama' },
  ]);
});

test('managed sidecar listModels keeps Ollama models visible when current engine catalog is empty', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-managed-model-fallback-catalog-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  service.currentEngineType = 'openai-compatible';
  const requestedEngines = [];
  service.sidecarClient = {
    async modelsList(engineType) {
      requestedEngines.push(engineType);
      if (engineType === 'openai-compatible') {
        return {
          models: [],
          available: false,
          reason: 'Could not query OpenAI-compatible server at http://127.0.0.1:8033: ConnectError',
        };
      }
      if (engineType === 'ollama') {
        return {
          models: [
            { id: 'gemma4-e4b-it-q6_k:latest', capabilities: { vision: true } },
            { id: 'qwen3.5:9b', capabilities: { thinking: true } },
          ],
          available: true,
          reason: '',
        };
      }
      return { models: [], available: true, reason: '' };
    },
  };

  const models = await service.listModels();

  assert.deepEqual(requestedEngines, ['openai-compatible', 'ollama']);
  assert.equal(models.available, true);
  assert.equal(models.engine_type, 'openai-compatible');
  assert.deepEqual(
    models.data.map((entry) => entry.id),
    ['gemma4-e4b-it-q6_k:latest', 'qwen3.5:9b']
  );
});

test('managed sidecar listModels surfaces Ollama fallback catalog metadata', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-managed-model-fallback-metadata-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  service.currentEngineType = 'openai-compatible';
  service.sidecarClient = {
    async modelsList(engineType) {
      if (engineType === 'openai-compatible') {
        return {
          models: [],
          available: false,
          reason: 'Could not query OpenAI-compatible server at http://127.0.0.1:8033: ConnectError',
          source: 'api',
          stale: false,
        };
      }
      if (engineType === 'ollama') {
        return {
          models: [{ id: 'qwen3.5:9b', capabilities: { thinking: true } }],
          available: true,
          reason: '',
          source: 'cache',
          stale: true,
          cached_at: '2026-05-06T12:00:00Z',
          expires_at: '2026-05-07T12:00:00Z',
          last_error: 'connection_error',
          daemon_version: '0.12.6',
        };
      }
      return { models: [], available: true, reason: '' };
    },
  };

  const models = await service.listModels();

  assert.equal(models.available, true);
  assert.equal(models.engine_type, 'openai-compatible');
  assert.equal(models.source, 'cache');
  assert.equal(models.stale, true);
  assert.equal(models.cached_at, '2026-05-06T12:00:00Z');
  assert.equal(models.expires_at, '2026-05-07T12:00:00Z');
  assert.equal(models.last_error, 'connection_error');
  assert.equal(models.daemon_version, '0.12.6');
  assert.deepEqual(models.data, [
    { id: 'qwen3.5:9b', engine_type: 'ollama', capabilities: { thinking: true } },
  ]);
});

test('managed sidecar listModels prefers available Ollama duplicates over unavailable current-engine entries', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-managed-model-fallback-duplicate-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  service.currentEngineType = 'openai-compatible';
  const requestedEngines = [];
  service.sidecarClient = {
    async modelsList(engineType) {
      requestedEngines.push(engineType);
      if (engineType === 'openai-compatible') {
        return {
          models: [
            {
              id: 'qwen3.5:9b',
              available: false,
              reason: 'Could not query OpenAI-compatible server at http://127.0.0.1:8033: ConnectError',
            },
          ],
          available: false,
          reason: 'Could not query OpenAI-compatible server at http://127.0.0.1:8033: ConnectError',
        };
      }
      if (engineType === 'ollama') {
        return {
          models: [
            { id: 'qwen3.5:9b', capabilities: { thinking: true } },
          ],
          available: true,
          reason: '',
        };
      }
      return { models: [], available: true, reason: '' };
    },
  };

  const models = await service.listModels();

  assert.deepEqual(requestedEngines, ['openai-compatible', 'ollama']);
  assert.equal(models.available, true);
  assert.equal(models.primary_available, false);
  assert.deepEqual(models.data, [
    { id: 'qwen3.5:9b', engine_type: 'ollama', capabilities: { thinking: true } },
  ]);
});

test('managed sidecar listModels uses requested engine when startup fell back to mock', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-managed-model-mock-fallback-catalog-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  service.currentEngineType = 'mock';
  service._lastEngineFallback = {
    requested_engine: 'openai-compatible',
    reason: 'OpenAI-compatible server is not reachable at http://127.0.0.1:8033/v1',
  };
  const requestedEngines = [];
  service.sidecarClient = {
    async modelsList(engineType) {
      requestedEngines.push(engineType);
      if (engineType === 'openai-compatible') {
        return {
          models: [],
          available: false,
          reason: 'Could not query OpenAI-compatible server at http://127.0.0.1:8033: ConnectError',
        };
      }
      if (engineType === 'ollama') {
        return {
          models: [
            { id: 'gemma4-e4b-it-q6_k:latest', capabilities: { vision: true } },
            { id: 'qwen3.5:9b', capabilities: { thinking: true } },
          ],
          available: true,
          reason: '',
        };
      }
      return { models: ['mock-v1', 'mock-v2'], available: true, reason: '' };
    },
  };

  const models = await service.listModels();

  assert.deepEqual(requestedEngines, ['openai-compatible', 'ollama']);
  assert.equal(models.available, true);
  assert.equal(models.engine_type, 'openai-compatible');
  assert.deepEqual(
    models.data.map((entry) => entry.id),
    ['gemma4-e4b-it-q6_k:latest', 'qwen3.5:9b']
  );
});

test('managed sidecar listModels merges Ollama models when the requested engine catalog is non-empty', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-managed-model-unified-catalog-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  service.currentEngineType = 'mock';
  service._lastEngineFallback = {
    requested_engine: 'chatgpt',
    reason: 'ChatGPT engine initialization failed',
  };
  const requestedEngines = [];
  service.sidecarClient = {
    async modelsList(engineType) {
      requestedEngines.push(engineType);
      if (engineType === 'chatgpt') {
        return {
          models: ['mock-v1', 'mock-v2'],
          available: true,
          reason: '',
        };
      }
      if (engineType === 'ollama') {
        return {
          models: [
            { id: 'muse-glimmer:30b-iq2-xs' },
            { id: 'qwen3.6:27b-q2-k-xl' },
            { id: 'qwen3.5-defiant-fable:9b-q8-0' },
          ],
          available: true,
          reason: '',
        };
      }
      return { models: [], available: true, reason: '' };
    },
  };
  service.providerIntegrationRegistry = {
    appendModelEntries(entries, { engineType } = {}) {
      if (engineType !== 'chatgpt' || entries.some((entry) => entry.id === 'gpt-5.6-sol')) {
        return entries;
      }
      return [...entries, { id: 'gpt-5.6-sol', provider: 'chatgpt' }];
    },
  };

  const models = await service.listModels();

  assert.deepEqual(requestedEngines, ['chatgpt', 'ollama']);
  assert.equal(models.available, true);
  assert.equal(models.primary_available, true);
  assert.equal(models.engine_type, 'chatgpt');
  assert.deepEqual(
    models.data.map((entry) => entry.id),
    [
      'mock-v1',
      'mock-v2',
      'gpt-5.6-sol',
      'muse-glimmer:30b-iq2-xs',
      'qwen3.6:27b-q2-k-xl',
      'qwen3.5-defiant-fable:9b-q8-0',
    ]
  );
  assert.equal(models.data.find((entry) => entry.id === 'gpt-5.6-sol').engine_type, 'chatgpt');
  assert.equal(models.data.find((entry) => entry.id === 'muse-glimmer:30b-iq2-xs').engine_type, 'ollama');
});

test('managed sidecar listModels appends configured Codex CLI models to picker catalog', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-managed-model-codex-cli-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath, {
    configService: {
      getState() {
        return {
          codexCli: {
            enabled: true,
            commandPath: 'codex',
            models: ['gpt-5.5'],
            requestTimeoutSeconds: 600,
          },
        };
      },
    },
  });
  service.currentEngineType = 'codex-cli';
  service.sidecarClient = {
    async modelsList(engineType) {
      assert.equal(engineType, 'codex-cli');
      return {
        models: ['codex-cli/default'],
        available: true,
        reason: '',
      };
    },
  };

  const models = await service.listModelsForEngine('codex-cli');

  assert.equal(models.engine_type, 'codex-cli');
  assert.deepEqual(
    models.data.map((entry) => entry.id),
    ['codex-cli/default', 'codex-cli/gpt-5.5']
  );
});
