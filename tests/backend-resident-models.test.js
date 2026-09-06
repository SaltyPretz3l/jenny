'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getResidentModels,
  normalizeResidentModelEntry,
} = require('../services/backend/backend-resident-models');

test('normalizeResidentModelEntry maps snake_case fields to camelCase', () => {
  const entry = normalizeResidentModelEntry({
    name: 'llama3.1:8b',
    digest: 'sha256:abc',
    size: 4900000000,
    size_vram: 4900000000,
    context_length: 8192,
    parameter_size: '8B',
    quantization_level: 'Q4_0',
    expires_at: '2026-09-01T00:05:00Z',
  });
  assert.deepEqual(entry, {
    name: 'llama3.1:8b',
    digest: 'sha256:abc',
    sizeBytes: 4900000000,
    vramBytes: 4900000000,
    contextLength: 8192,
    parameterSize: '8B',
    quantizationLevel: 'Q4_0',
    expiresAt: '2026-09-01T00:05:00Z',
  });
});

test('normalizeResidentModelEntry returns null for entries without a name', () => {
  assert.equal(normalizeResidentModelEntry({ digest: 'abc' }), null);
  assert.equal(normalizeResidentModelEntry(null), null);
  assert.equal(normalizeResidentModelEntry('not-an-object'), null);
});

test('normalizeResidentModelEntry defaults missing/invalid numeric fields to 0/null', () => {
  const entry = normalizeResidentModelEntry({ name: 'x', context_length: -1 });
  assert.equal(entry.sizeBytes, 0);
  assert.equal(entry.vramBytes, 0);
  assert.equal(entry.contextLength, null);
  assert.equal(entry.expiresAt, null);
});

test('getResidentModels returns null when sidecar phase is not ready', async () => {
  const result = await getResidentModels({
    sidecarManager: { getStatus: () => ({ phase: 'starting' }) },
    sidecarClient: { async modelsResident() { throw new Error('should not be called'); } },
  });
  assert.equal(result, null);
});

test('getResidentModels returns null when sidecarClient is missing', async () => {
  const result = await getResidentModels({
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: null,
  });
  assert.equal(result, null);
});

test('getResidentModels returns null when the sidecar reports unavailable', async () => {
  const result = await getResidentModels({
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: {
      async modelsResident() {
        return { available: false, reason: 'ollama_engine_unavailable', models: [] };
      },
    },
  });
  assert.equal(result, null);
});

test('getResidentModels normalizes the models array from a ready sidecar', async () => {
  const result = await getResidentModels({
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: {
      async modelsResident() {
        return {
          available: true,
          reason: '',
          models: [
            { name: 'llama3.1:8b', size: 100, size_vram: 100 },
            { digest: 'no-name-skip' },
          ],
        };
      },
    },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'llama3.1:8b');
});

test('getResidentModels degrades to null and logs on sidecar failure', async () => {
  const logs = [];
  const result = await getResidentModels({
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: {
      async modelsResident() {
        throw new Error('rpc failed');
      },
    },
    _emitServiceLog(level, event, data) {
      logs.push({ level, event, data });
    },
  });
  assert.equal(result, null);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'backend.models_resident_failed');
});
