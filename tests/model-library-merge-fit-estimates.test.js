/* Wave 2: estimator-sourced fit verdicts for installed non-catalog models.
 * Split out of model-library-merge.test.js to keep that file under the
 * 600-line soft cap; see services/model-fit-estimator.js for the shape of a
 * diagnostics.modelFitEstimates entry. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const merge = require('../renderer/shell/model-library/model-library-merge.js');

const catalog = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'config', 'model-recommendation-catalog.json'),
  'utf8'
));

function recommendation(index, overrides = {}) {
  return {
    ...catalog.models[index],
    fits: true,
    fitsInVram: true,
    fitsInAccelerator: false,
    fitsOnCpu: true,
    recommended: false,
    reason: 'Fits this machine.',
    ...overrides,
  };
}

function mergeLibrary(overrides = {}) {
  return merge.mergeModelLibrary({
    installed: [],
    ollamaTags: [],
    recommendations: [],
    fitEstimates: [],
    hardware: { gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 16384 } },
    memory: { totalMb: 32768, availableMb: 24576 },
    catalogMeta: { catalogVersion: catalog.catalogVersion },
    activeModel: '',
    preferredLocalModel: '',
    ...overrides,
  });
}

const ACCELERATION_FAMILIES = [
  { matchPrefixes: ['gemma4', 'gemma-4'], mtp: 'yes' },
];

test('an installed non-catalog model with a fit estimate gets an estimated fit verdict', () => {
  const result = mergeLibrary({
    installed: [{
      id: 'private/estimated:q4',
      size: 4096,
      parameterSize: '7B',
      quantizationLevel: 'Q4_K_M',
    }],
    fitEstimates: [{
      modelId: 'private/estimated:q4',
      vramRequiredMb: 4096,
      ramRequiredMb: 6144,
      contextLength: 8192,
      fits: true,
      fitsInVram: true,
      fitsInAccelerator: false,
      fitsOnCpu: true,
      source: 'estimated',
      confidence: 'medium',
      params: '7B',
      quant: 'Q4_K_M',
    }],
  });
  const card = result.cards[0];

  assert.equal(card.fitState, 'fits');
  assert.equal(card.fitRatio, 4096 / 16384);
  assert.equal(card.fitLabel, '4 GB of 16 GB VRAM');
  assert.equal(card.fitSource, 'estimated');
  assert.equal(card.fitConfidence, 'medium');
  assert.equal(card.vramRequiredMb, 4096);
  assert.equal(card.ramRequiredMb, 6144);
  assert.equal(card.contextLength, 8192);
  assert.equal(card.params, '7B');
  assert.equal(card.quant, 'Q4_K_M');
});

test('MTP headroom degrades an estimated fit the same way it degrades a catalog fit', () => {
  const result = mergeLibrary({
    hardware: { gpu: { type: 'cuda', name: 'Tiny GPU', vram_mb: 4096 } },
    acceleration: { enabled: true, headroomMb: 2048, families: ACCELERATION_FAMILIES },
    managed: {
      enabled: true,
      perModel: { 'gemma4-estimated-q4': { engine: 'llama-server', mtp: { mode: 'mtp' } } },
    },
    installed: [{ id: 'gemma4-estimated:q4', size: 4096 }],
    fitEstimates: [{
      modelId: 'gemma4-estimated:q4',
      vramRequiredMb: 3072,
      ramRequiredMb: 4096,
      contextLength: 4096,
      fits: true,
      fitsInVram: true,
      fitsOnCpu: true,
    }],
  });
  const card = result.cards[0];

  // Budget 4096 - headroom 2048 = 2048, which is under the 3072 required.
  assert.equal(card.fitState, 'over');
  assert.equal(card.fitSource, 'estimated');
});

test('an installed non-catalog model without a fit estimate keeps today\'s unknown verdict', () => {
  const result = mergeLibrary({
    installed: [{ id: 'private/installed-only:q4', size: 0 }],
    fitEstimates: [],
  });
  const card = result.cards[0];

  assert.equal(card.fitState, 'unknown');
  assert.equal(card.fitLabel, 'Not in catalog');
  assert.equal(card.fitSource, '');
  assert.equal(card.fitConfidence, '');
  assert.equal(card.vramRequiredMb, 0);
  assert.equal(card.contextLength, 0);
});

test('a catalog-matched card always carries fitSource catalog and high confidence', () => {
  const result = mergeLibrary({ recommendations: [recommendation(0)] });
  const card = result.cards[0];

  assert.equal(card.fitSource, 'catalog');
  assert.equal(card.fitConfidence, 'high');
});

test('a diagnostics entry resolved from a measured observation carries fitSource observed', () => {
  const result = mergeLibrary({
    installed: [{ id: 'custom/model:latest', size: 6 * 1024 * 1024 * 1024, engine_type: 'ollama' }],
    fitEstimates: [{
      modelId: 'custom/model:latest',
      vramRequiredMb: 6200,
      ramRequiredMb: 7400,
      contextLength: 8192,
      fits: true,
      fitsInVram: true,
      fitsInAccelerator: false,
      fitsOnCpu: true,
      source: 'observed',
      fitSource: 'observed',
      fitConfidence: 'high',
      confidence: 'low',
    }],
  });
  const card = result.cards.find((entry) => entry.tag === 'custom/model:latest');
  assert.equal(card.fitSource, 'observed');
  assert.equal(card.fitConfidence, 'high');
  assert.equal(card.fitState, 'fits');
});
