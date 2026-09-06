'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SIDECAR_ERROR_CODES } = require('../services/backend/error-codes');
const { getOllamaModelBlob } = require('../services/backend/backend-ollama-blob');

test('getOllamaModelBlob returns null before the sidecar is ready', async () => {
  let calls = 0;
  const result = await getOllamaModelBlob({
    sidecarManager: { getStatus: () => ({ phase: 'starting' }) },
    sidecarClient: { async modelsOllamaBlob() { calls += 1; } },
  }, 'gemma4:12b');

  assert.equal(result, null);
  assert.equal(calls, 0);
});

test('getOllamaModelBlob returns null when the sidecar client is missing', async () => {
  const result = await getOllamaModelBlob({
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: null,
  }, 'gemma4:12b');

  assert.equal(result, null);
});

test('getOllamaModelBlob returns null for unavailable or blank blob payloads', async () => {
  const service = {
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: { async modelsOllamaBlob() { return { available: false, blob_path: 'x' }; } },
  };
  assert.equal(await getOllamaModelBlob(service, 'gemma4:12b'), null);

  service.sidecarClient.modelsOllamaBlob = async () => ({ available: true, blob_path: '   ' });
  assert.equal(await getOllamaModelBlob(service, 'gemma4:12b'), null);
});

test('getOllamaModelBlob normalizes the available sidecar payload', async () => {
  const modelIds = [];
  const result = await getOllamaModelBlob({
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: {
      async modelsOllamaBlob(modelId) {
        modelIds.push(modelId);
        return { available: true, blob_path: ' C:\\ollama\\blob ', mmproj_path: ' C:\\ollama\\mmproj ' };
      },
    },
  }, 'gemma4:12b');

  assert.deepEqual(modelIds, ['gemma4:12b']);
  assert.deepEqual(result, {
    blobPath: 'C:\\ollama\\blob',
    mmprojPath: 'C:\\ollama\\mmproj',
  });
});

test('getOllamaModelBlob degrades to null and logs WARN on sidecar failure', async () => {
  const logs = [];
  const result = await getOllamaModelBlob({
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: { async modelsOllamaBlob() { throw new Error('rpc failed'); } },
    _emitServiceLog(level, event, data) { logs.push({ level, event, data }); },
  }, 'gemma4:12b');

  assert.equal(result, null);
  assert.deepEqual(logs, [{
    level: 'WARN',
    event: 'backend.models_ollama_blob_failed',
    data: { message: 'rpc failed' },
  }]);
});

test('getOllamaModelBlob logs DEBUG on timeout', async () => {
  const logs = [];
  const timeout = new Error('timed out');
  timeout.error_code = SIDECAR_ERROR_CODES.TIMEOUT;
  const result = await getOllamaModelBlob({
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: { async modelsOllamaBlob() { throw timeout; } },
    _emitServiceLog(level, event, data) { logs.push({ level, event, data }); },
  }, 'gemma4:12b');

  assert.equal(result, null);
  assert.equal(logs[0].level, 'DEBUG');
  assert.equal(logs[0].event, 'backend.models_ollama_blob_failed');
});
