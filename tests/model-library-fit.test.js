const test = require('node:test');
const assert = require('node:assert/strict');

const fit = require('../renderer/shell/model-library/model-library-fit.js');

test('hasFitField requires at least one boolean fit predicate', () => {
  assert.equal(fit.hasFitField({}), false);
  assert.equal(fit.hasFitField({ fits: 'yes' }), false);
  assert.equal(fit.hasFitField({ fits: true }), true);
  assert.equal(fit.hasFitField({ fitsInVram: false }), true);
});

test('deriveFitState returns unknown without detected hardware or fit fields', () => {
  assert.equal(fit.deriveFitState({ fits: true }, { detected: false }), 'unknown');
  assert.equal(fit.deriveFitState({}, { detected: true }), 'unknown');
});

test('deriveFitState prioritizes vram/accelerator fit over cpu fallback', () => {
  assert.equal(
    fit.deriveFitState({ fitsInVram: true, fitsOnCpu: true }, { detected: true }),
    'fits'
  );
  assert.equal(
    fit.deriveFitState({ fitsInAccelerator: true }, { detected: true }),
    'fits'
  );
  assert.equal(
    fit.deriveFitState({ fitsInVram: false, fitsOnCpu: true }, { detected: true }),
    'cpu'
  );
  assert.equal(
    fit.deriveFitState({ fitsInVram: false, fitsOnCpu: false, fits: false }, { detected: true }),
    'over'
  );
});

test('gbLabel formats megabytes to one decimal GB or empty for non-positive input', () => {
  assert.equal(fit.gbLabel(4096), '4 GB');
  assert.equal(fit.gbLabel(6144), '6 GB');
  assert.equal(fit.gbLabel(1536), '1.5 GB');
  assert.equal(fit.gbLabel(0), '');
  assert.equal(fit.gbLabel(-5), '');
});

test('fitLabelFor produces quantitative text when both sides are known', () => {
  assert.equal(fit.fitLabelFor('fits', 4096, 16384), '4 GB of 16 GB VRAM');
  assert.equal(fit.fitLabelFor('fits', 0, 0), 'Fits accelerator memory');
  assert.equal(fit.fitLabelFor('cpu', 4096, 16384), 'Runs on CPU');
  assert.equal(fit.fitLabelFor('over', 20480, 16384), 'Needs 20 GB VRAM');
  assert.equal(fit.fitLabelFor('over', 0, 0), 'Over memory budget');
  assert.equal(fit.fitLabelFor('unknown', 0, 0), 'Hardware not detected');
});

test('fitRatioFor clamps to [0, 1.5] and is zero for unknown state or missing inputs', () => {
  assert.equal(fit.fitRatioFor(4096, 16384, 'fits'), 0.25);
  assert.equal(fit.fitRatioFor(32768, 16384, 'over'), 1.5);
  assert.equal(fit.fitRatioFor(4096, 16384, 'unknown'), 0);
  assert.equal(fit.fitRatioFor(0, 16384, 'fits'), 0);
  assert.equal(fit.fitRatioFor(4096, 0, 'fits'), 0);
});

test('effectiveCatalogFitState only lets headroom downgrade a fits verdict', () => {
  const context = { hardware: { detected: true, budgetMb: 16384 }, acceleration: { enabled: true } };
  const recommendation = { fitsInVram: true };
  // Headroom leaves budget: stays fits.
  assert.equal(fit.effectiveCatalogFitState(recommendation, 4096, context, 8192), 'fits');
  // Headroom consumes the whole budget: unknown.
  assert.equal(fit.effectiveCatalogFitState(recommendation, 4096, context, 0), 'unknown');
  // Headroom leaves a smaller budget than required: over.
  assert.equal(fit.effectiveCatalogFitState(recommendation, 12288, context, 8192), 'over');
  // A non-'fits' verdict is never touched by headroom.
  const over = { fitsInVram: false, fitsOnCpu: false, fits: false };
  assert.equal(fit.effectiveCatalogFitState(over, 4096, context, 0), 'over');
});

test('effectiveCatalogFitState passes through unchanged when acceleration is disabled', () => {
  const context = { hardware: { detected: true, budgetMb: 16384 }, acceleration: { enabled: false } };
  assert.equal(
    fit.effectiveCatalogFitState({ fitsInVram: true }, 4096, context, 0),
    'fits'
  );
});

test('fitTone maps fit state to a badge tone, defaulting to muted', () => {
  assert.equal(fit.fitTone({ fitState: 'fits' }), 'success');
  assert.equal(fit.fitTone({ fitState: 'cpu' }), 'warning');
  assert.equal(fit.fitTone({ fitState: 'over' }), 'danger');
  assert.equal(fit.fitTone({ fitState: 'unknown' }), 'muted');
  assert.equal(fit.fitTone(null), 'muted');
});
