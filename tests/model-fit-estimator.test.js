const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  parseParamsBillions,
  isMoeParams,
  estimateModelFit,
  resolveModelFit,
  estimateDivergence,
} = require('../services/model-fit-estimator');

const CATALOG_PATH = path.join(__dirname, '..', 'config', 'model-recommendation-catalog.json');
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));

test('parseParamsBillions handles the catalog\'s param-string shapes', () => {
  assert.equal(parseParamsBillions('9.0B'), 9);
  assert.equal(parseParamsBillions('12B'), 12);
  assert.equal(parseParamsBillions('26B-A4B'), 26);
  assert.equal(parseParamsBillions('4B'), 4);
  assert.equal(parseParamsBillions('670M'), 0.67);
  assert.equal(parseParamsBillions(''), 0);
  assert.equal(parseParamsBillions(null), 0);
  assert.equal(parseParamsBillions('unknown'), 0);
});

test('isMoeParams flags an active-param token', () => {
  assert.equal(isMoeParams('26B-A4B'), true);
  assert.equal(isMoeParams('12B'), false);
  assert.equal(isMoeParams(''), false);
  assert.equal(isMoeParams(null), false);
});

test('estimateModelFit returns null for a non-positive sizeBytes', () => {
  assert.equal(estimateModelFit({ sizeBytes: 0, params: '9B' }), null);
  assert.equal(estimateModelFit({ sizeBytes: -1, params: '9B' }), null);
  assert.equal(estimateModelFit({}), null);
});

test('estimateModelFit reproduces catalog vramRequiredMb within +/-15% for every non-MoE, vram-priced catalog model', () => {
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const candidates = models.filter(
    (m) => Number(m.vramRequiredMb) > 0 && !isMoeParams(m.params)
  );
  assert.ok(candidates.length >= 4, 'expected several non-MoE, vram-priced catalog entries to calibrate against');

  for (const model of candidates) {
    const sizeBytes = Number(model.downloadSizeMb) * 1024 * 1024;
    const estimate = estimateModelFit({
      sizeBytes,
      params: model.params,
      quant: model.quant,
      contextLength: model.contextLength,
    });
    assert.ok(estimate, `estimate should not be null for ${model.modelId}`);
    const ratio = Math.abs(estimate.vramRequiredMb - model.vramRequiredMb) / model.vramRequiredMb;
    assert.ok(
      ratio <= 0.15,
      `${model.modelId}: estimated ${estimate.vramRequiredMb}MB vs catalog ${model.vramRequiredMb}MB (ratio ${ratio.toFixed(3)})`
    );
    assert.ok(estimate.ramRequiredMb >= estimate.vramRequiredMb);
  }
});

test('estimateModelFit MoE model gets low confidence', () => {
  const moe = catalog.models.find((m) => isMoeParams(m.params));
  assert.ok(moe, 'expected an MoE catalog entry (gemma4-26b)');
  const estimate = estimateModelFit({
    sizeBytes: Number(moe.downloadSizeMb) * 1024 * 1024,
    params: moe.params,
    quant: moe.quant,
    contextLength: moe.contextLength,
  });
  assert.ok(estimate);
  assert.equal(estimate.confidence, 'low');
});

test('estimateModelFit unknown-params model gets low confidence', () => {
  const estimate = estimateModelFit({ sizeBytes: 5_000_000_000, params: '', contextLength: 8192 });
  assert.ok(estimate);
  assert.equal(estimate.confidence, 'low');
  assert.equal(estimate.paramsBillions, 0);
});

test('estimateModelFit metal path: unified budget is half of unified_memory_mb', () => {
  // 32768 * 0.5 = 16384 MB budget; a model priced well under that should
  // fit the accelerator path.
  const estimate = estimateModelFit({
    sizeBytes: 5_000_000_000, // ~4768 MB
    params: '9B',
    contextLength: 8192,
    hardware: { gpu: { type: 'metal', unified_memory_mb: 32768 } },
    memory: { totalMb: 32768, availableMb: 20000 },
  });
  assert.ok(estimate);
  assert.equal(estimate.fitsInAccelerator, true);
  assert.equal(estimate.fitsInVram, false);
});

test('estimateModelFit CPU path: fits when available RAM covers ramRequiredMb', () => {
  const estimate = estimateModelFit({
    sizeBytes: 5_000_000_000,
    params: '9B',
    contextLength: 8192,
    hardware: { gpu: { type: 'cpu', vram_mb: 0 } },
    memory: { totalMb: 64000, availableMb: 40000 },
  });
  assert.ok(estimate);
  assert.equal(estimate.fitsInVram, false);
  assert.equal(estimate.fitsInAccelerator, false);
  assert.equal(estimate.fitsOnCpu, true);
  assert.equal(estimate.fits, true);
});

test('estimateModelFit no-hardware path: no vram/accelerator, cpu fit defaults from availableMb', () => {
  const estimate = estimateModelFit({
    sizeBytes: 5_000_000_000,
    params: '9B',
    contextLength: 8192,
  });
  assert.ok(estimate);
  assert.equal(estimate.fitsInVram, false);
  assert.equal(estimate.fitsInAccelerator, false);
  assert.equal(estimate.fitsOnCpu, false); // no memory info -> availableMb 0 < ramRequiredMb
  assert.equal(estimate.fits, false);
});

test('resolveModelFit precedence: observation > recommendation > estimate', () => {
  const observation = { vramRequiredMb: 1 };
  const recommendation = { vramRequiredMb: 2 };
  const estimate = { vramRequiredMb: 3, confidence: 'medium' };

  const withObservation = resolveModelFit({ recommendation, observation, estimate });
  assert.equal(withObservation.vramRequiredMb, 1);
  assert.equal(withObservation.fitSource, 'observed');
  assert.equal(withObservation.fitConfidence, 'high');

  const withRecommendation = resolveModelFit({ recommendation, estimate });
  assert.equal(withRecommendation.vramRequiredMb, 2);
  assert.equal(withRecommendation.fitSource, 'catalog');
  assert.equal(withRecommendation.fitConfidence, 'high');

  const withEstimateOnly = resolveModelFit({ estimate });
  assert.equal(withEstimateOnly.vramRequiredMb, 3);
  assert.equal(withEstimateOnly.fitSource, 'estimated');
  assert.equal(withEstimateOnly.fitConfidence, 'medium');

  assert.equal(resolveModelFit({}), null);
});

test('estimateDivergence computes the vramRequiredMb ratio and tolerates missing inputs', () => {
  assert.equal(estimateDivergence({ vramRequiredMb: 12000 }, { vramRequiredMb: 10000 }), 0.2);
  assert.equal(estimateDivergence(null, { vramRequiredMb: 10000 }), 0);
  assert.equal(estimateDivergence({ vramRequiredMb: 12000 }, null), 0);
  assert.equal(estimateDivergence({ vramRequiredMb: 0 }, { vramRequiredMb: 10000 }), 0);
});
