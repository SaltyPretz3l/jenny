'use strict';

// Model Library "Unload" must stop Jenny's own llama-server (it holds the model
// and VRAM), never a server Jenny did not start, and never report an unload it
// could not confirm.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { unloadModel } = require('../services/backend/backend-runtime');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makeService({ managerStatus, managerStop } = {}) {
  const calls = [];
  const logs = [];
  const manager = managerStatus ? {
    getStatus: () => managerStatus,
    async stop() {
      calls.push('managerStop');
      return managerStop ? managerStop() : { state: 'stopped', lastError: '' };
    },
  } : null;
  const service = {
    calls,
    logs,
    defaultModel: 'qwen3:latest',
    currentModel: 'ornith:9b',
    currentEngineType: 'openai-compatible',
    currentStatus: { model: 'ornith:9b', model_loaded: true },
    _modelLifecycle: { state: 'ready', requested_model: 'ornith:9b' },
    options: { getLlamaServerManager: () => manager },
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: {
      async modelsUnload() {
        calls.push('modelsUnload');
      },
    },
    _buildManagedStatusSnapshot(overrides = {}) {
      return { model: 'ornith:9b', model_loaded: true, ...overrides };
    },
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
  };
  return service;
}

test('unload with stopManagedServer stops an owned ready llama-server before the sidecar unload', async () => {
  const service = makeService({ managerStatus: { state: 'ready', reused: false } });

  const result = await unloadModel(service, { stopManagedServer: true });

  assert.deepEqual(result, { status: 'ok', model: '' });
  assert.deepEqual(service.calls, ['managerStop', 'modelsUnload']);
  assert.equal(service.currentModel, '');
  assert.equal(service.currentStatus.model_loaded, false);
  assert.equal(service._modelLifecycle.state, 'unloaded');
  assert.equal(service.logs.some(({ level, event }) => (
    level === 'INFO' && event === 'backend.model_unload_stopped_llama_server'
  )), true);
  // ELC-2: the next lazy load relaunches llama-server; resetting to the
  // default model's engine (Ollama here) sent the GGUF id to an Ollama pull.
  assert.equal(service.currentEngineType, 'openai-compatible');
});

test('unload keeps the engine it was on, and only infers one when none is set', async () => {
  const ollama = makeService();
  ollama.currentEngineType = 'ollama';
  await unloadModel(ollama);
  assert.equal(ollama.currentEngineType, 'ollama');

  const unset = makeService();
  unset.currentEngineType = '';
  await unloadModel(unset);
  assert.equal(unset.currentEngineType, 'ollama', 'inferred from the default model qwen3:latest');
});

test('unload stops a server that is still starting', async () => {
  const service = makeService({ managerStatus: { state: 'starting', reused: false } });

  await unloadModel(service, { stopManagedServer: true });

  assert.deepEqual(service.calls, ['managerStop', 'modelsUnload']);
});

test('unload never stops a reused (external) server', async () => {
  const service = makeService({ managerStatus: { state: 'ready', reused: true } });

  await unloadModel(service, { stopManagedServer: true });

  assert.deepEqual(service.calls, ['modelsUnload']);
});

test('unload without the option behaves as before and leaves the server alone', async () => {
  const service = makeService({ managerStatus: { state: 'ready', reused: false } });

  await unloadModel(service);
  await unloadModel(service, {});

  assert.deepEqual(service.calls, ['modelsUnload', 'modelsUnload']);
});

test('unload with no running server or no manager does not stop anything', async () => {
  const down = makeService({ managerStatus: { state: 'stopped', reused: false } });
  await unloadModel(down, { stopManagedServer: true });
  assert.deepEqual(down.calls, ['modelsUnload']);

  const noManager = makeService();
  await unloadModel(noManager, { stopManagedServer: true });
  assert.deepEqual(noManager.calls, ['modelsUnload']);
});

test('an unconfirmed stop throws and leaves the loaded-model bookkeeping untouched', async () => {
  for (const managerStop of [
    async () => ({ state: 'stopped', lastError: 'stop_unconfirmed' }),
    async () => { throw new Error('stop blew up'); },
  ]) {
    const service = makeService({
      managerStatus: { state: 'ready', reused: false },
      managerStop,
    });
    const statusBefore = service.currentStatus;
    const lifecycleBefore = service._modelLifecycle;

    await assert.rejects(
      unloadModel(service, { stopManagedServer: true }),
      (error) => {
        assert.equal(error.message, 'The managed llama-server could not be confirmed stopped; the model may still be loaded.');
        assert.equal(error.error_code, 'CMP-AI-0002');
        assert.equal(error.retryable, true);
        return true;
      }
    );

    assert.deepEqual(service.calls, ['managerStop'], 'the sidecar unload is skipped');
    assert.equal(service.currentModel, 'ornith:9b');
    assert.strictEqual(service.currentStatus, statusBefore);
    assert.strictEqual(service._modelLifecycle, lifecycleBefore);
    assert.equal(service.currentEngineType, 'openai-compatible');
  }
});

test('BackendService.unloadModel passes its options through to the runtime unload', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-unload-managed-'));
  trackDirectory(userDataPath);
  const stops = [];
  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'qwen3.5:9b',
    getLlamaServerManager: () => ({
      getStatus: () => ({ state: 'ready', reused: false }),
      async stop() { stops.push('stop'); return { state: 'stopped', lastError: '' }; },
    }),
  });
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = { async modelsUnload() { return { status: 'ok', model: '' }; } };

  await service.unloadModel();
  assert.deepEqual(stops, [], 'no option, no stop (shutdown and plugin paths)');
  await service.unloadModel({ stopManagedServer: true });
  assert.deepEqual(stops, ['stop']);
});
