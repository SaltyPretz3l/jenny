'use strict';

/* Provider identity and the chat.send field (row 59 checkpoint 6): live metrics
 * are requested only from the managed NInfer that names v0.9.1, only with the
 * counter on, and only over a negotiated protocol. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { SidecarClient } = require('../services/backend/sidecar-client');
const { inferencePerformanceRequestField, resolveProviderIdentity } = require('../services/performance/provider-identity');

function managers({ ninfer = {}, llama = {} } = {}) {
  const make = (baseUrl, status) => ({ getBaseUrl: () => baseUrl, getStatus: () => status });
  return {
    ninferManager: make('http://127.0.0.1:8034/v1', { state: 'ready', runtimeLabel: '0.9.1', ...ninfer }),
    llamaManager: make('http://127.0.0.1:8080/v1', { state: 'ready', runtimeLabel: 'build 10683', ...llama }),
  };
}
async function serviceWith({ ninferManager, llamaManager, showCounter = true, negotiated = true, intake } = {}) {
  const client = new SidecarClient();
  client.process = {};
  if (negotiated) {
    client.request = async () => ({ runtime_inference_admission_version: 1, inference_performance_version: 1 });
    await client.initialize();
  }
  return {
    sidecarClient: client,
    options: { getNinferManager: () => ninferManager, getLlamaServerManager: () => llamaManager },
    configService: { getState: () => ({ performanceTelemetry: { schemaVersion: 1, showCounter, gpuWarningsEnabled: true } }) },
    inferenceIntake: intake,
  };
}
const ninferService = (ninferManager) => ({ options: { getNinferManager: () => ninferManager } });

test('the managed NInfer on v0.9.1 is live-capable; other versions and states are not', () => {
  const { ninferManager, llamaManager } = managers();
  const service = { options: { getNinferManager: () => ninferManager, getLlamaServerManager: () => llamaManager } };
  assert.deepEqual(resolveProviderIdentity({ service, apiUrl: 'http://127.0.0.1:8034' }), { provider_kind: 'ninfer', live_capable: true });
  for (const label of ['v0.9.1', ' 0.9.1 ']) {
    const m = managers({ ninfer: { runtimeLabel: label } });
    assert.equal(resolveProviderIdentity({ service: ninferService(m.ninferManager), apiUrl: 'http://127.0.0.1:8034' }).live_capable, true, label);
  }
  for (const runtimeLabel of ['0.9.0', '0.9.10', '0.9.1-rc1', '1.0.0', '', undefined, 'bundled']) {
    const m = managers({ ninfer: { runtimeLabel } });
    const result = resolveProviderIdentity({ service: ninferService(m.ninferManager), apiUrl: 'http://127.0.0.1:8034' });
    assert.deepEqual(result, { provider_kind: 'ninfer', live_capable: false }, String(runtimeLabel));
  }
  const starting = managers({ ninfer: { state: 'starting' } });
  assert.equal(resolveProviderIdentity({ service: ninferService(starting.ninferManager), apiUrl: 'http://127.0.0.1:8034' }).live_capable, false);
});

test('an explicit ninferManager argument is the version source', () => {
  const { ninferManager } = managers({ ninfer: { runtimeLabel: '0.8.0' } });
  const other = managers({ ninfer: { runtimeLabel: '0.9.1' } }).ninferManager;
  const service = ninferService(ninferManager);
  assert.equal(resolveProviderIdentity({ service, apiUrl: 'http://127.0.0.1:8034' }).live_capable, false);
  assert.equal(resolveProviderIdentity({ service, apiUrl: 'http://127.0.0.1:8034', ninferManager: other }).live_capable, true);
});

test('llama-server, Ollama, user-run and unknown endpoints are never live-capable', () => {
  const { ninferManager, llamaManager } = managers();
  const service = { options: { getNinferManager: () => ninferManager, getLlamaServerManager: () => llamaManager } };
  assert.deepEqual(resolveProviderIdentity({ service, apiUrl: 'http://127.0.0.1:8080' }), { provider_kind: 'llama-server', live_capable: false });
  assert.deepEqual(resolveProviderIdentity({ service, apiUrl: 'http://127.0.0.1:11434', engineType: 'ollama' }), { provider_kind: 'ollama', live_capable: false });
  assert.deepEqual(resolveProviderIdentity({ service, engineType: 'ollama' }), { provider_kind: 'ollama', live_capable: false });
  assert.deepEqual(resolveProviderIdentity({ service, apiUrl: 'http://127.0.0.1:9999' }), { provider_kind: 'other', live_capable: false });
  assert.deepEqual(resolveProviderIdentity({ service, apiUrl: 'https://api.example.com/v1' }), { provider_kind: 'other', live_capable: false });
  assert.deepEqual(resolveProviderIdentity({ service }), { provider_kind: 'other', live_capable: false });
  assert.deepEqual(resolveProviderIdentity({}), { provider_kind: 'other', live_capable: false });
  assert.deepEqual(resolveProviderIdentity(), { provider_kind: 'other', live_capable: false });
  const throwing = { options: { getNinferManager: () => { throw new Error('boom'); } } };
  assert.deepEqual(resolveProviderIdentity({ service: throwing, apiUrl: 'http://127.0.0.1:8034' }), { provider_kind: 'other', live_capable: false });
});

test('the chat.send field is live only for counter on plus a live-capable NInfer, and marks the request', async () => {
  const marks = [];
  const intake = { markRequest: (sessionId, mark) => marks.push([sessionId, mark]) };
  const apiUrl = 'http://127.0.0.1:8034';
  const args = { apiUrl, sessionId: 'sess_a', requestId: 'stream_1' };
  const live = await serviceWith({ ...managers(), intake });
  assert.deepEqual(inferencePerformanceRequestField(live, args), { inference_performance: { live: true, provider_kind: 'ninfer' } });
  assert.deepEqual(marks.at(-1), ['sess_a', { live_requested: true, live_capable: true, request_id: 'stream_1' }]);

  const off = await serviceWith({ ...managers(), showCounter: false, intake });
  assert.deepEqual(inferencePerformanceRequestField(off, args), { inference_performance: { live: false, provider_kind: 'ninfer' } });
  assert.deepEqual(marks.at(-1)[1], { live_requested: false, live_capable: true, request_id: 'stream_1' });

  const old = await serviceWith({ ...managers({ ninfer: { runtimeLabel: '0.9.0' } }), intake });
  assert.deepEqual(inferencePerformanceRequestField(old, args), { inference_performance: { live: false, provider_kind: 'ninfer' } });
  assert.deepEqual(marks.at(-1)[1], { live_requested: false, live_capable: false, request_id: 'stream_1' });

  const llama = await serviceWith({ ...managers(), intake });
  assert.deepEqual(inferencePerformanceRequestField(llama, { ...args, apiUrl: 'http://127.0.0.1:8080' }),
    { inference_performance: { live: false, provider_kind: 'llama-server' } });
  assert.deepEqual(inferencePerformanceRequestField(llama, { ...args, engineType: 'ollama', apiUrl: '' }),
    { inference_performance: { live: false, provider_kind: 'ollama' } });
});

test('the field is omitted (and nothing is marked) when the protocol was not negotiated or anything throws', async () => {
  const marks = [];
  const intake = { markRequest: (...a) => marks.push(a) };
  const args = { apiUrl: 'http://127.0.0.1:8034', sessionId: 'sess_a', requestId: 'stream_1' };
  const old = await serviceWith({ ...managers(), negotiated: false, intake });
  assert.deepEqual(inferencePerformanceRequestField(old, args), {});
  assert.deepEqual(inferencePerformanceRequestField(null, args), {});
  assert.deepEqual(inferencePerformanceRequestField(undefined), {});
  assert.equal(marks.length, 0);
  const broken = await serviceWith({ ...managers(), intake });
  broken.configService = { getState: () => { throw new Error('config unreadable'); } };
  assert.deepEqual(inferencePerformanceRequestField(broken, args), {});
});
