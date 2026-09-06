/* renderer/shared/model-capability-utils.js – local-model capability heuristics (UMD)
 *
 * Read-only plan mode asks the model for coherent multi-step analysis. Small
 * local models (gemma4-e4b ~4B, 3B-active MoEs) routinely lose that structure.
 * The composer uses these helpers to hint when the selected model may struggle.
 *
 * Name-pattern heuristics only: param metadata lives in sidecar app profiles
 * and is not exposed over the models IPC, and a hint does not justify a new
 * RPC. Unknown names err toward "small" (show the hint) — it is advisory,
 * never gating.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.modelCapabilityUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Effective-parameter floor (billions) below which multi-step planning is
  // unreliable on local models.
  const SMALL_MODEL_PARAM_THRESHOLD_B = 7;

  // MoE tags advertise total params in the name but run far fewer active
  // params (qwen3.6:35b-a3b = 35B total / 3B active). These must classify
  // small BEFORE the generic NNb size match sees the "35b".
  const SMALL_ACTIVE_PARAM_PATTERNS = [/a3b/i, /a1b/i, /-e2b/i, /-e4b/i];

  function parseParamBillions(name) {
    const text = String(name || '');
    let best = null;
    const sizeMatches = text.matchAll(/(\d+(?:\.\d+)?)\s*b\b/gi);
    for (const match of sizeMatches) {
      const value = Number.parseFloat(match[1]);
      if (Number.isFinite(value) && (best === null || value > best)) {
        best = value;
      }
    }
    return best;
  }

  /**
   * True when the named model is large enough that multi-step planning is
   * expected to work. Empty/unknown names return false (hint shows).
   */
  function isPlanCapableModel(name) {
    const text = String(name || '').trim();
    if (!text) {
      return false;
    }
    for (const pattern of SMALL_ACTIVE_PARAM_PATTERNS) {
      if (pattern.test(text)) {
        return false;
      }
    }
    const paramBillions = parseParamBillions(text);
    if (paramBillions === null) {
      return false;
    }
    return paramBillions >= SMALL_MODEL_PARAM_THRESHOLD_B;
  }

  /** Short display label for hint copy: strip tag suffixes and quant noise. */
  function formatModelLabel(name) {
    const text = String(name || '').trim();
    if (!text) {
      return 'the current model';
    }
    let base = text.split(':')[0];
    const suffixNoise = /[-_](q\d\S*|latest|it|instruct)$/i;
    while (suffixNoise.test(base)) {
      base = base.replace(suffixNoise, '');
    }
    return base || text;
  }

  return {
    SMALL_MODEL_PARAM_THRESHOLD_B,
    isPlanCapableModel,
    formatModelLabel,
  };
});
