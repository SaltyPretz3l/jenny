// Per-model context-window and compaction tunability settings. Additive
// object/string settings with safe defaults - no CONFIG_VERSION bump needed
// (normalizeState backfills on read, same pattern as other settings /
// webSearch). These values flow one-way into the managed-sidecar config
// (context_length_override / token_budget_auto_compact_ratio_by_model /
// compaction_custom_prompt);
// tunability changes apply on the next sidecar (re)initialize, same as every
// other managed-sidecar config field.

const RATIO_MIN = 0.1;
const RATIO_MAX = 0.99;
const CUSTOM_PROMPT_MAX_CHARS = 20_000;
const MAX_MODEL_TUNING_ENTRIES = 128;
const MAX_MODEL_ID_CHARS = 240;
const CONTEXT_LENGTH_STEPS = Object.freeze([
  4096, 8192, 16_384, 32_768, 65_536, 131_072, 262_144,
]);

function normalizeRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed < RATIO_MIN || parsed > RATIO_MAX) {
    return null;
  }
  return parsed;
}

// modelId -> ratio (in [0.1, 0.99]). Entries with an invalid modelId or ratio
// are dropped rather than clamped, so a stale/garbage entry silently
// disappears instead of persisting a surprising clamped value.
function normalizeRatioByModel(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const [modelId, rawRatio] of Object.entries(source)) {
    const key = String(modelId || '').trim().slice(0, MAX_MODEL_ID_CHARS);
    if (!key) {
      continue;
    }
    const ratio = normalizeRatio(rawRatio);
    if (ratio == null) {
      continue;
    }
    normalized[key] = ratio;
    if (Object.keys(normalized).length >= MAX_MODEL_TUNING_ENTRIES) break;
  }
  return normalized;
}

function normalizeContextLength(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || !CONTEXT_LENGTH_STEPS.includes(parsed)) return null;
  return parsed;
}

function normalizeContextLengthByModel(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const [modelId, rawLength] of Object.entries(source)) {
    const key = String(modelId || '').trim().slice(0, MAX_MODEL_ID_CHARS);
    const contextLength = normalizeContextLength(rawLength);
    if (!key || contextLength == null) continue;
    normalized[key] = contextLength;
    if (Object.keys(normalized).length >= MAX_MODEL_TUNING_ENTRIES) break;
  }
  return normalized;
}

function normalizeCustomPrompt(value) {
  const text = typeof value === 'string' ? value : '';
  return text.trim().slice(0, CUSTOM_PROMPT_MAX_CHARS);
}

function normalizeCompactionTuning(value = {}, legacyState = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ratioByModel: normalizeRatioByModel(
      source.ratioByModel
      ?? source.ratio_by_model
      ?? legacyState.compactionAutoCompactRatioByModel
      ?? legacyState.compaction_auto_compact_ratio_by_model
    ),
    contextLengthByModel: normalizeContextLengthByModel(
      source.contextLengthByModel
      ?? source.context_length_by_model
      ?? legacyState.contextLengthByModel
      ?? legacyState.context_length_by_model
    ),
    customPrompt: normalizeCustomPrompt(
      source.customPrompt
      ?? source.custom_prompt
      ?? legacyState.compactionCustomPrompt
      ?? legacyState.compaction_custom_prompt
    ),
  };
}

module.exports = {
  RATIO_MIN,
  RATIO_MAX,
  CUSTOM_PROMPT_MAX_CHARS,
  CONTEXT_LENGTH_STEPS,
  normalizeRatio,
  normalizeRatioByModel,
  normalizeContextLength,
  normalizeContextLengthByModel,
  normalizeCustomPrompt,
  normalizeCompactionTuning,
};
