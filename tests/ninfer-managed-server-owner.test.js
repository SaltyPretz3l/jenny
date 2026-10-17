'use strict';

// Broker for two managed servers (row 54 Step 6): the sidecar's api_url is
// NInfer's origin only while NInfer is ready, each manager's key travels only
// to its own origin, and the ready manager's alias becomes the model.

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { DEFAULT_MANAGED_SHELL_MODEL } = require('../services/backend/backend-config');
const { buildManagedSidecarConfig, buildManagedSidecarSecrets } = require('../services/backend/managed-sidecar-lifecycle');
const { resolveManagedConfiguredModel, resolveOpenAICompatibleApiUrl } = require('../services/backend/managed-sidecar-config');
const { managedServerAlias, managedServerApiKey, ninferManagedOrigin, resolveManagedServerOwner } = require('../services/backend/managed-server-owner');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makeManager({ state, baseUrl, apiKey, alias }) {
  return { getStatus: () => ({ state, alias }), getBaseUrl: () => baseUrl, getApiKey: () => apiKey };
}

function makeService({ ninferState = 'ready', llamaState = 'ready', apiUrl = '' } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ninfer-broker-'));
  trackDirectory(userDataPath);
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    configService: { getState: () => ({ localEngines: { openaiCompatible: { port: 8033, apiUrl } } }) },
    getLlamaServerManager: () => makeManager({ state: llamaState, baseUrl: llamaState === 'stopped' ? '' : 'http://127.0.0.1:8033/v1', apiKey: 'llama-key', alias: 'gemma4:12b' }),
    getNinferManager: () => makeManager({ state: ninferState, baseUrl: ninferState === 'stopped' ? '' : 'http://127.0.0.1:8034/v1', apiKey: 'ninfer-key', alias: 'qwen3.8-27b-nvfp4' }),
  });
  service.currentEngineType = 'openai-compatible';
  return service;
}

test('a ready NInfer owns the api_url, its key and its alias; llama-server gets nothing', () => {
  const service = makeService({ llamaState: 'stopped' });
  assert.equal(resolveOpenAICompatibleApiUrl(service), 'http://127.0.0.1:8034');
  assert.equal(buildManagedSidecarConfig(service).api_url, 'http://127.0.0.1:8034');
  assert.deepEqual(buildManagedSidecarSecrets(service), { openai_compatible_api_key: 'ninfer-key' });
  assert.equal(resolveManagedConfiguredModel(service), 'qwen3.8-27b-nvfp4');
});

test('NInfer down: the llama-server path is byte-for-byte the pre-NInfer one', () => {
  const service = makeService({ ninferState: 'stopped' });
  assert.equal(buildManagedSidecarConfig(service).api_url, 'http://127.0.0.1:8033');
  assert.deepEqual(buildManagedSidecarSecrets(service), { openai_compatible_api_key: 'llama-key' });
  assert.equal(resolveManagedConfiguredModel(service), 'gemma4:12b');
  const starting = makeService({ ninferState: 'starting', llamaState: 'stopped' });
  // A NInfer that is still coming up does not take the endpoint over.
  assert.equal(buildManagedSidecarConfig(starting).api_url, 'http://127.0.0.1:8033');
  assert.deepEqual(buildManagedSidecarSecrets(starting), {});
});

test('a user-run endpoint never receives either managed key', () => {
  const service = makeService({ apiUrl: 'http://127.0.0.1:9000' });
  // NInfer ready still wins the api_url: it only serves while it is the active managed model.
  assert.equal(buildManagedSidecarConfig(service).api_url, 'http://127.0.0.1:8034');
  const custom = makeService({ ninferState: 'stopped', apiUrl: 'http://127.0.0.1:9000' });
  assert.equal(buildManagedSidecarConfig(custom).api_url, 'http://127.0.0.1:9000');
  assert.deepEqual(buildManagedSidecarSecrets(custom), {});
  assert.equal(['gemma4:12b', 'qwen3.8-27b-nvfp4'].includes(resolveManagedConfiguredModel(custom)), false);
});

test('the owner helper resolves by local origin and tolerates missing managers', () => {
  const service = { options: {
    getNinferManager: () => makeManager({ state: 'ready', baseUrl: 'http://localhost:8034/v1', apiKey: 'n', alias: 'ninfer-model' }),
    getLlamaServerManager: () => makeManager({ state: 'ready', baseUrl: 'http://127.0.0.1:8033/v1', apiKey: 'l', alias: 'llama-model' }),
  } };
  assert.equal(resolveManagedServerOwner(service, 'http://127.0.0.1:8034').kind, 'ninfer');
  assert.equal(resolveManagedServerOwner(service, 'http://127.0.0.1:8033').kind, 'llama-server');
  assert.equal(resolveManagedServerOwner(service, 'http://127.0.0.1:1'), null);
  assert.equal(managedServerAlias(service, 'http://127.0.0.1:8034'), 'ninfer-model');
  assert.equal(managedServerApiKey(service, 'http://127.0.0.1:8033'), 'l');
  assert.equal(ninferManagedOrigin(service), 'http://localhost:8034');
  assert.equal(ninferManagedOrigin({ options: {} }), '');
  assert.equal(managedServerApiKey({ options: {} }, 'http://127.0.0.1:8033'), '');
});
