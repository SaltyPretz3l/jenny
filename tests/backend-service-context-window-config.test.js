'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const {
  DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH,
  DEFAULT_MANAGED_SHELL_MODEL,
} = require('../services/backend/backend-config');
const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-lifecycle');
const { ShellConfigService } = require('../services/shell-config-service');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function createService(userDataPath, configService = null, options = {}) {
  return new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    configService,
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    ...options,
  });
}

test('managed sidecar config includes the default context length without an override', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-context-default-'));
  trackDirectory(userDataPath);
  const config = buildManagedSidecarConfig(createService(userDataPath));

  assert.equal(config.context_length, DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH);
  assert.equal(config.context_length_override, null);
});

test('managed config forwards a persisted context override only for the active Ollama model', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-context-override-'));
  trackDirectory(userDataPath);
  const configService = new ShellConfigService({ userDataPath });
  const service = createService(userDataPath, configService);
  configService.setCompactionTuning({
    modelId: DEFAULT_MANAGED_SHELL_MODEL,
    contextLength: 131072,
  });
  service._managedPendingModel = DEFAULT_MANAGED_SHELL_MODEL;

  assert.equal(buildManagedSidecarConfig(service).context_length_override, 131072);

  service.currentEngineType = 'chatgpt';
  service.currentModel = 'gpt-5.6';
  service._managedPendingModel = '';
  configService.setCompactionTuning({ modelId: 'gpt-5.6', contextLength: 65536 });
  assert.equal(buildManagedSidecarConfig(service).context_length_override, null);
});

test('managed config uses the selected llama-server profile window for openai-compatible budgeting', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-context-llama-profile-'));
  trackDirectory(userDataPath);
  const service = createService(userDataPath, null, {
    managedLlamaServerProfile: { contextSize: 131072 },
  });
  service.currentEngineType = 'openai-compatible';
  service.currentModel = 'qwen3.8:27b-q3-k-s';

  const config = buildManagedSidecarConfig(service);

  assert.equal(config.context_length, 131072);
  assert.equal(config.context_length_override, null);
});
