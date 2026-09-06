/* Pure fit-verdict helpers shared by the catalog and installed card builders. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.modelLibraryFit = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function nonNegativeNumber(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  function hasFitField(recommendation) {
    var source = recommendation && typeof recommendation === 'object' ? recommendation : {};
    return ['fitsInVram', 'fitsInAccelerator', 'fitsOnCpu', 'fits'].some(function (key) {
      return Object.prototype.hasOwnProperty.call(source, key)
        && typeof source[key] === 'boolean';
    });
  }

  function deriveFitState(recommendation, hardware) {
    var source = recommendation && typeof recommendation === 'object' ? recommendation : {};
    var hw = hardware && typeof hardware === 'object' ? hardware : {};
    if (!hw.detected || !hasFitField(source)) return 'unknown';
    if (source.fitsInVram === true || source.fitsInAccelerator === true) {
      return 'fits';
    }
    if (source.fitsOnCpu === true || source.fits === true) return 'cpu';
    return 'over';
  }

  function gbLabel(megabytes) {
    var number = nonNegativeNumber(megabytes);
    return number ? (Math.round((number / 1024) * 10) / 10) + ' GB' : '';
  }

  // Quantitative when both sides are known ("12 GB of 16 GB VRAM"), generic
  // otherwise — the bar must never imply numbers the payload didn't provide.
  function fitLabelFor(state, vramRequiredMb, budgetMb) {
    var need = gbLabel(vramRequiredMb);
    var budget = gbLabel(budgetMb);
    if (state === 'fits') {
      return need && budget ? need + ' of ' + budget + ' VRAM' : 'Fits accelerator memory';
    }
    if (state === 'cpu') return 'Runs on CPU';
    if (state === 'over') return need ? 'Needs ' + need + ' VRAM' : 'Over memory budget';
    return 'Hardware not detected';
  }

  function fitRatioFor(vramRequiredMb, budgetMb, state) {
    if (state === 'unknown' || !vramRequiredMb || !budgetMb) return 0;
    return Math.min(Math.max(vramRequiredMb / budgetMb, 0), 1.5);
  }

  function effectiveCatalogFitState(recommendation, vramRequiredMb, context, effectiveBudgetMb) {
    var ctx = context && typeof context === 'object' ? context : {};
    var hardware = ctx.hardware && typeof ctx.hardware === 'object' ? ctx.hardware : {};
    var acceleration = ctx.acceleration && typeof ctx.acceleration === 'object' ? ctx.acceleration : {};
    var fitState = deriveFitState(recommendation, hardware);
    // Headroom can only invalidate a 'fits' verdict — a card already known to
    // be over budget (or CPU-bound, or unknown) keeps its honest state even
    // when the headroom consumes the whole budget.
    if (!acceleration.enabled || fitState !== 'fits') return fitState;
    if (nonNegativeNumber(hardware.budgetMb) > 0 && effectiveBudgetMb === 0) return 'unknown';
    if (vramRequiredMb > 0
        && effectiveBudgetMb > 0
        && vramRequiredMb > effectiveBudgetMb) {
      return 'over';
    }
    return fitState;
  }

  function fitTone(card) {
    var state = card && card.fitState;
    if (state === 'fits') return 'success';
    if (state === 'cpu') return 'warning';
    if (state === 'over') return 'danger';
    return 'muted';
  }

  return {
    hasFitField: hasFitField,
    deriveFitState: deriveFitState,
    gbLabel: gbLabel,
    fitLabelFor: fitLabelFor,
    fitRatioFor: fitRatioFor,
    effectiveCatalogFitState: effectiveCatalogFitState,
    fitTone: fitTone,
  };
});
