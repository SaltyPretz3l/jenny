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
// The drawer's presets; any whole number in [MIN, MAX] is accepted too (a
// custom window). MAX is the sidecar's context_length_override ceiling
// (sidecar/ai/config_sections.py); MIN stays clear of llama-server's 1024 floor.
const CONTEXT_LENGTH_STEPS = Object.freeze([
  4096, 8192, 16_384, 32_768, 65_536, 131_072, 262_144,
]);
const CONTEXT_LENGTH_MIN = 2048;
const CONTEXT_LENGTH_MAX = 262_144;

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
  if (!Number.isSafeInteger(parsed) || parsed < CONTEXT_LENGTH_MIN || parsed > CONTEXT_LENGTH_MAX) return null;
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

// ShellConfigService methods, installed on its prototype (shell-config-service.js).
const compactionTuningMethods = {
  // Per-model Ollama context window and auto-compact ratio, plus the custom
  // summarization prompt. Applies on the next sidecar (re)initialize.
  getCompactionTuning() {
    return normalizeCompactionTuning(this.state.compactionTuning);
  },

  setCompactionTuning(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const { modelId, ratio, contextLength, customPrompt } = source;
    const current = this.getCompactionTuning();
    const nextRatioByModel = { ...current.ratioByModel };
    const nextContextLengthByModel = { ...current.contextLengthByModel };
    const normalizedModelId = String(modelId || '').trim();
    const hasRatio = Object.prototype.hasOwnProperty.call(source, 'ratio');
    const hasContextLength = Object.prototype.hasOwnProperty.call(source, 'contextLength');
    const normalizedRatio = ratio == null ? null : normalizeRatio(ratio);
    if (normalizedModelId && hasRatio) {
      if (normalizedRatio == null) delete nextRatioByModel[normalizedModelId];
      else nextRatioByModel[normalizedModelId] = normalizedRatio;
    }
    if (normalizedModelId && hasContextLength) {
      if (contextLength == null) delete nextContextLengthByModel[normalizedModelId];
      else {
        const normalizedContextLength = normalizeContextLength(contextLength);
        if (normalizedContextLength != null) {
          nextContextLengthByModel[normalizedModelId] = normalizedContextLength;
        }
      }
    }
    const nextTuning = normalizeCompactionTuning({
      ratioByModel: nextRatioByModel,
      contextLengthByModel: nextContextLengthByModel,
      customPrompt: customPrompt === undefined ? current.customPrompt : customPrompt,
    });
    if (JSON.stringify(nextTuning) === JSON.stringify(current)) {
      return current;
    }
    const contextLengthChanged = JSON.stringify(nextTuning.contextLengthByModel)
      !== JSON.stringify(current.contextLengthByModel);
    return this._writeState(
      { ...this.state, compactionTuning: nextTuning },
      contextLengthChanged ? 'context_length_tuning_updated' : 'compaction_tuning_updated'
    ).compactionTuning;
  },
};

module.exports = {
  compactionTuningMethods,
  RATIO_MIN,
  RATIO_MAX,
  CUSTOM_PROMPT_MAX_CHARS,
  CONTEXT_LENGTH_STEPS,
  CONTEXT_LENGTH_MIN,
  CONTEXT_LENGTH_MAX,
  normalizeRatio,
  normalizeRatioByModel,
  normalizeContextLength,
  normalizeContextLengthByModel,
  normalizeCustomPrompt,
  normalizeCompactionTuning,
};
