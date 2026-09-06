'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  listModelsForEngine,
  loadModel,
} = require('../services/backend/backend-runtime');

function makeManagedSwitchService({ activeStreams = new Map(), unloadError = null } = {}) {
  const calls = [];
  const logs = [];
  const manager = {
    async ensureRunning() {
      calls.push('ensureRunning');
      return { state: 'ready' };
    },
  };
  const service = {
    activeStreams,
    calls,
    logs,
    currentEngineType: 'ollama',
    currentModel: 'previous:12b',
    options: { getLlamaServerManager: () => manager },
    providerIntegrationRegistry: null,
    sidecarClient: {
      async modelsUnload() {
        calls.push('modelsUnload');
        if (unloadError) throw unloadError;
      },
    },
    configService: {
      getState: () => ({ preferredEngineType: 'openai-compatible' }),
      getLocalEngines: () => ({
        openaiCompatible: {
          managed: {
            enabled: true,
            profileId: 'balanced',
            perModel: {
              'next-12b': {
                engine: 'llama-server',
                modelPath: 'G:\\models\\next.gguf',
              },
            },
          },
        },
      }),
    },
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
    async _initializeManagedSidecar() {
      calls.push('initialize');
    },
    async refreshStatusSnapshot() {},
  };
  return service;
}

test('timed-out Ollama unload aborts a managed switch before llama-server starts', async () => {
  const unloadError = Object.assign(new Error('timed out'), {
    error_code: 'CMP-SIDECAR-0001',
  });
  const service = makeManagedSwitchService({ unloadError });

  await assert.rejects(
    loadModel(service, { model: 'next:12b', engine_type: 'openai-compatible' }),
    (error) => {
      assert.match(
        error.message,
        /previous:12b.*could not be confirmed evicted.*aborted so the GPU is not double-loaded/i
      );
      assert.equal(error.error_code, 'CMP-AI-0002');
      assert.equal(error.category, 'engine_switch_aborted');
      return true;
    }
  );

  assert.deepEqual(service.calls, ['modelsUnload']);
  assert.equal(service.logs.some(({ event }) => event === 'backend.engine_switch_unload_failed'), true);
});

test('active chat stream refuses a models.load switch that excludes no stream', async () => {
  const service = makeManagedSwitchService({ activeStreams: new Map([['stream-1', {}]]) });

  await assert.rejects(
    loadModel(service, { model: 'next:12b', engine_type: 'openai-compatible' }),
    (error) => {
      assert.match(error.message, /stop the active response before switching engines/i);
      assert.equal(error.error_code, 'CMP-AI-0002');
      assert.equal(error.category, 'model_busy');
      return true;
    }
  );

  assert.deepEqual(service.calls, []);
  assert.deepEqual(service.logs.filter(({ event }) => (
    event === 'backend.engine_switch_refused_stream_active'
  )), [{
    level: 'WARN',
    event: 'backend.engine_switch_refused_stream_active',
    details: { active_stream_count: 1, model: 'next:12b' },
  }]);
});

test('chat-path load is not refused by its own in-flight stream', async () => {
  const service = makeManagedSwitchService({ activeStreams: new Map([['stream-1', {}]]) });

  await loadModel(
    service,
    { model: 'next:12b', engine_type: 'openai-compatible' },
    { ownStreamId: 'stream-1' }
  );

  assert.deepEqual(service.calls, ['modelsUnload', 'ensureRunning', 'initialize']);
  assert.equal(service.logs.some(({ event }) => (
    event === 'backend.engine_switch_refused_stream_active'
  )), false);
});

// Excluding your own stream must not excuse somebody else's: session A streaming on
// Ollama while session B resolves a llama-server model is the same GPU double-load.
test('chat-path load is still refused by a stream from another session', async () => {
  const service = makeManagedSwitchService({
    activeStreams: new Map([['stream-1', {}], ['stream-2', {}]]),
  });

  await assert.rejects(
    loadModel(
      service,
      { model: 'next:12b', engine_type: 'openai-compatible' },
      { ownStreamId: 'stream-2' }
    ),
    (error) => {
      assert.match(error.message, /stop the active response before switching engines/i);
      return true;
    }
  );

  assert.deepEqual(service.calls, []);
  assert.deepEqual(service.logs.filter(({ event }) => (
    event === 'backend.engine_switch_refused_stream_active'
  )), [{
    level: 'WARN',
    event: 'backend.engine_switch_refused_stream_active',
    details: { active_stream_count: 1, model: 'next:12b' },
  }]);
});

// The sidecar's OWN 30s unload timeout returns data with no error_code and no
// category, so it arrives as CMP-SIDECAR-0005/'rpc'. Slice 2 raised the Electron
// budget to 35s precisely to make this the expected shape; request_dispatch.py now
// stamps category so the abort can see it.
test('sidecar-side unload timeout aborts the switch', async () => {
  const unloadError = Object.assign(new Error('models.unload failed'), {
    error_code: 'CMP-SIDECAR-0005',
    category: 'timeout',
  });
  const service = makeManagedSwitchService({ unloadError });

  await assert.rejects(
    loadModel(service, { model: 'next:12b', engine_type: 'openai-compatible' }),
    /could not be confirmed evicted/i
  );

  assert.deepEqual(service.calls, ['modelsUnload']);
});

test('concurrent engine-specific model lists share one sidecar request and result', async () => {
  let releaseRequest;
  let listCalls = 0;
  const service = {
    currentModel: 'current:latest',
    providerIntegrationRegistry: null,
    sidecarClient: {
      async modelsList() {
        listCalls += 1;
        await new Promise((resolve) => { releaseRequest = resolve; });
        return { models: [{ id: 'current:latest' }] };
      },
    },
  };

  const firstPromise = listModelsForEngine(service, 'ollama');
  const secondPromise = listModelsForEngine(service, 'ollama');
  assert.equal(listCalls, 1);
  releaseRequest();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.strictEqual(first, second);
  assert.equal(listCalls, 1);
});

test('rejected engine-specific model list is cleared and retried', async () => {
  let listCalls = 0;
  const service = {
    currentModel: 'current:latest',
    providerIntegrationRegistry: null,
    sidecarClient: {
      async modelsList() {
        listCalls += 1;
        if (listCalls === 1) throw new Error('catalog unavailable');
        return { models: [{ id: 'current:latest' }] };
      },
    },
  };

  await assert.rejects(listModelsForEngine(service, 'ollama'), /catalog unavailable/);
  const result = await listModelsForEngine(service, 'ollama');

  assert.equal(listCalls, 2);
  assert.deepEqual(result.data, [{ id: 'current:latest', engine_type: 'ollama' }]);

  // Contrast: the retry's SUCCESS is cached, so a third call inside the TTL is
  // served without touching the bridge. Without this the test passes even with
  // the whole TTL/in-flight block deleted -- a rejection that was never cached
  // is indistinguishable from a cache that does not exist.
  const cached = await listModelsForEngine(service, 'ollama');
  assert.equal(listCalls, 2);
  assert.strictEqual(cached, result);
});
