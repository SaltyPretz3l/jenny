'use strict';

// Reflection's structured output (agentic memory v2, row 58 W2): the sidecar
// sends llama-server a JSON schema only when Electron says the endpoint IS the
// managed llama-server. NInfer, Ollama and a user's own endpoint never opt in.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BackendService } = require('../services/backend/backend-service');
const { DEFAULT_MANAGED_SHELL_MODEL } = require('../services/backend/backend-config');
const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-lifecycle');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('json_schema_response_format is true only for the managed llama-server', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-json-schema-flag-'));
  trackDirectory(userDataPath);
  let apiUrl = '';
  let ninferReady = false;
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    configService: { getState: () => ({ localEngines: { openaiCompatible: { port: 8033, apiUrl } } }) },
    getLlamaServerManager: () => ({ getApiKey: () => 'k', getBaseUrl: () => 'http://localhost:8033/v1',
      getStatus: () => ({ state: 'ready' }) }),
    getNinferManager: () => ({ getApiKey: () => 'n', getBaseUrl: () => 'http://127.0.0.1:8034/v1',
      getStatus: () => ({ state: ninferReady ? 'ready' : 'stopped' }) }),
  });
  const flag = () => buildManagedSidecarConfig(service).json_schema_response_format;

  service.currentEngineType = 'openai-compatible';
  assert.equal(flag(), true, 'the endpoint is the managed llama-server');
  ninferReady = true;
  assert.equal(flag(), false, 'a serving NInfer owns the endpoint');
  ninferReady = false;
  apiUrl = 'http://127.0.0.1:9000/v1';
  assert.equal(flag(), false, "a user's own endpoint");
  apiUrl = '';
  service.currentEngineType = 'ollama';
  assert.equal(flag(), false, 'Ollama gets the schema through format, not this flag');
});
