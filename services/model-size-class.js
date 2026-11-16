'use strict';

/* services/model-size-class.js - row 144 (plan SCHEDULED_CHECK_MODEL_FLOOR_2026-11-13.md section 3.2): is a model big
 * enough to run unattended work (a scheduled check) in the Jenny chat?
 *
 * Owner decision D2 (2026-11-13): under 7B parameters is too small; a MoE model counts by its TOTAL size ("35B-A3B"
 * passes); a cloud engine always passes; a model whose size cannot be found counts as too small. Sources, strongest
 * first: the engine's own parameter count (Ollama `parameter_size`), the GGUF `general.size_label`, then the model
 * id. Pure: callers pass what they read. The advisory plan-mode hint (renderer/shared/model-capability-utils.js)
 * judges MoE models by active size on purpose and is not this rule.
 */

const { parseParamsBillions } = require('./model-fit-estimator');

const UNATTENDED_MIN_PARAMS_B = 7;
const CLOUD_ENGINE_TYPES = new Set(['chatgpt', 'codex-cli', 'api-provider']);
// "27b", "2.6B", "8x7B" (experts x size): a number glued to a trailing b that ends the token.
const SIZE_TOKEN = /(?:(\d+)x)?(\d+(?:\.\d+)?)b(?![a-z0-9])/gi;

const positive = (value) => (Number.isFinite(value) && value > 0 ? value : null);

// The largest size token in a label or id ("Qwen3.8-27B-Q4_K_M" -> 27, "qwen3.6:35b-a3b" -> 35, "8x7B" -> 56).
function sizeFromText(text) {
  let best = null;
  for (const match of String(text || '').matchAll(SIZE_TOKEN)) {
    const value = positive(Number.parseFloat(match[2]) * (match[1] ? Number(match[1]) : 1));
    if (value !== null && (best === null || value > best)) best = value;
  }
  return best;
}

// A metadata string: "27.8B", "670M", "35B-A3B", "8x7B". Experts multiply; otherwise the leading number counts.
function sizeFromLabel(label) {
  const text = typeof label === 'string' ? label.trim() : '';
  if (!text) return null;
  return /^\d+x/i.test(text) ? sizeFromText(text) : positive(parseParamsBillions(text));
}

function classifyModelSize({
  model = '', engineType = '', parameterSize = '', ggufSizeLabel = '',
} = {}) {
  if (CLOUD_ENGINE_TYPES.has(String(engineType || '').trim().toLowerCase())) {
    return { fit: true, params_b: null, source: 'cloud' };
  }
  const candidates = [
    ['engine', sizeFromLabel(parameterSize)],
    ['gguf', sizeFromLabel(ggufSizeLabel)],
    ['name', sizeFromText(model)],
  ];
  const found = candidates.find(([, value]) => value !== null);
  if (!found) return { fit: false, params_b: null, source: 'unknown' };
  const [source, params] = found;
  return { fit: params >= UNATTENDED_MIN_PARAMS_B, params_b: Math.round(params * 10) / 10, source };
}

module.exports = { CLOUD_ENGINE_TYPES, UNATTENDED_MIN_PARAMS_B, classifyModelSize, sizeFromLabel, sizeFromText };
