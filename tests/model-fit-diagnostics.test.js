'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildModelFitEstimates } = require('../services/model-fit-diagnostics');

function divergentFit(logs, { modelId = 'divergent:7b', gpuName = 'GPU A', vramMb = 16000,
  gpuType = 'cuda', contextLength = 8192 } = {}) {
  return buildModelFitEstimates({
    backend: { _emitServiceLog: (...args) => logs.push(args) },
    installedModels: [{ id: modelId, size: 4_000_000_000, parameterSize: '7B', quantizationLevel: 'Q4_K_M' }],
    hardwareProfile: { gpu: { name: gpuName, type: gpuType, vram_mb: vramMb } },
    memory: { totalMb: 32000, availableMb: 24000 },
    modelRecommendations: [{ pullTag: modelId, vramRequiredMb: 100, contextLength }],
    loadContextLengthFor: () => contextLength,
  });
}

test('divergence logs once per model, GPU identity and context across refreshes', async () => {
  const logs = [];
  await divergentFit(logs);
  await divergentFit(logs);
  assert.equal(logs.length, 1);
  await divergentFit(logs, { modelId: 'different:7b' });
  await divergentFit(logs, { gpuName: 'GPU B' });
  await divergentFit(logs, { vramMb: 24000 });
  await divergentFit(logs, { gpuType: 'metal' });
  await divergentFit(logs, { contextLength: 32768 });
  assert.equal(logs.length, 6);
  assert.ok(logs.every(([level, event]) => level === 'INFO' && event === 'model_fit.estimate_catalog_divergence'));
});

test('divergence deduplication remains bounded without repeating earlier identities', async () => {
  const logs = [];
  for (let index = 0; index < 260; index += 1) {
    await divergentFit(logs, { modelId: `bounded-${index}:7b` });
  }
  const count = logs.length;
  assert.ok(count > 0 && count <= 256);
  await divergentFit(logs, { modelId: 'bounded-0:7b' });
  await divergentFit(logs, { modelId: 'bounded-259:7b' });
  assert.equal(logs.length, count);
});
