'use strict';

// 2026-09-22: with llama-server as the engine, sidecar initialize waited
// ~8.8 s on Ollama's GPU discovery it never uses. Only an openai-compatible
// endpoint that is known and not Ollama's own origin skips that wait.

const test = require('node:test');
const assert = require('node:assert/strict');

const { startBackendService } = require('../services/backend/local-engine-lifecycle');

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function makeService({ engine, openaiCompatible = { port: 8033, apiUrl: '' } }) {
  const calls = [];
  const logs = [];
  const ollamaGate = deferred();
  const sidecarStatus = { phase: 'ready', pid: 41, baseUrl: 'http://127.0.0.1:8765' };
  const service = {
    activeStreams: new Map(),
    calls,
    logs,
    ollamaGate,
    configService: { getState: () => ({ localEngines: { openaiCompatible } }) },
    currentEngineType: engine,
    currentModel: '',
    defaultModel: '',
    ollamaManager: {
      _host: '127.0.0.1',
      _port: 11434,
      async start() {
        calls.push('ollama:start');
        await ollamaGate.promise;
        calls.push('ollama:settled');
        return { started: true };
      },
    },
    sidecarManager: {
      isStopping: false,
      getStatus: () => sidecarStatus,
      async start() { calls.push('sidecar:start'); return sidecarStatus; },
    },
    emit() {},
    _emitServiceLog(level, event, details) { logs.push([level, event, details]); },
    async _initializeManagedSidecar() { calls.push('sidecar:initialize'); },
    _autoLoadDefaultModel() { calls.push('model:autoLoad'); },
    async refreshStatusSnapshot() {},
    async restoreAuthState() {},
    _schedulePendingSessionMigrations() {},
  };
  return service;
}

test('a llama-server engine initializes without waiting on a slow Ollama start', async () => {
  const service = makeService({ engine: 'openai-compatible' });
  const progress = [];

  await startBackendService(service, { onProgress: (phase) => progress.push(phase) });

  assert.ok(service.calls.includes('ollama:start'), 'Ollama still starts for its own models');
  assert.ok(service.calls.includes('sidecar:initialize'));
  assert.equal(service.calls.includes('ollama:settled'), false);
  assert.equal(progress.includes('ollama_ready'), false);
  assert.ok(service.logs.some(([level, event]) => level === 'INFO' && event === 'ollama.startup_join_skipped'));
  service.ollamaGate.resolve();
});

for (const [label, engine, openaiCompatible] of [
  ['the Ollama engine', 'ollama', undefined],
  ['an openai-compatible endpoint on Ollama /v1', 'openai-compatible', { port: 8033, apiUrl: 'http://localhost:11434/v1' }],
]) {
  test(`${label} still joins the Ollama start before initialize`, async () => {
    const service = makeService({ engine, openaiCompatible });
    const progress = [];
    const starting = startBackendService(service, { onProgress: (phase) => progress.push(phase) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.calls.includes('sidecar:initialize'), false);

    service.ollamaGate.resolve();
    await starting;
    assert.ok(service.calls.indexOf('ollama:settled') < service.calls.indexOf('sidecar:initialize'));
    assert.ok(progress.includes('ollama_ready'));
  });
}
