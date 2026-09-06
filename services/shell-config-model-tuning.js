const STREAM_INACTIVITY_SECONDS_DEFAULT_LOCAL = 120;
const STREAM_INACTIVITY_SECONDS_DEFAULT_CLOUD = 300;
const STREAM_INACTIVITY_SECONDS_MIN = 5;
const STREAM_INACTIVITY_SECONDS_MAX = 300;
const MAX_MODEL_TUNING_ENTRIES = 128;
const MAX_MODEL_ID_CHARS = 240;
const GENERATION_PROFILE_BOUNDS = Object.freeze({
  temperature: Object.freeze({ min: 0, max: 2, integer: false }),
  topP: Object.freeze({ min: 0, max: 1, integer: false }),
  topK: Object.freeze({ min: 0, max: 200, integer: true }),
  minP: Object.freeze({ min: 0, max: 1, integer: false }),
  presencePenalty: Object.freeze({ min: -2, max: 2, integer: false }),
  repetitionPenalty: Object.freeze({ min: 0, max: 2, integer: false }),
  maxOutputTokens: Object.freeze({ min: 1, max: 200_000, integer: true }),
});

function normalizeModelId(value) {
  const normalized = String(value || '').trim();
  return normalized && normalized.length <= MAX_MODEL_ID_CHARS ? normalized : '';
}

function canonicalizeOllamaModelId(value) {
  const normalized = normalizeModelId(value).toLowerCase();
  if (!normalized) return '';
  const lastSegment = normalized.slice(normalized.lastIndexOf('/') + 1);
  return lastSegment.includes(':') ? normalized : `${normalized}:latest`;
}

function normalizeStreamInactivitySeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
  return parsed >= STREAM_INACTIVITY_SECONDS_MIN && parsed <= STREAM_INACTIVITY_SECONDS_MAX
    ? parsed
    : null;
}

function normalizeStreamInactivitySecondsByModel(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const [rawModelId, rawSeconds] of Object.entries(source)) {
    const modelId = normalizeModelId(rawModelId);
    const seconds = normalizeStreamInactivitySeconds(rawSeconds);
    if (!modelId || seconds == null) continue;
    delete normalized[modelId];
    normalized[modelId] = seconds;
    while (Object.keys(normalized).length > MAX_MODEL_TUNING_ENTRIES) {
      delete normalized[Object.keys(normalized)[0]];
    }
  }
  return normalized;
}

function normalizeGenerationProfile(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const [field, bounds] of Object.entries(GENERATION_PROFILE_BOUNDS)) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const rawValue = source[field];
    if (rawValue == null || rawValue === '') continue;
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) continue;
    if (bounds.integer && !Number.isSafeInteger(parsed)) continue;
    if (parsed < bounds.min || parsed > bounds.max) continue;
    normalized[field] = parsed;
  }
  return normalized;
}

function normalizeGenerationProfilesByModel(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const [rawModelId, rawProfile] of Object.entries(source)) {
    const modelId = normalizeModelId(rawModelId);
    if (!modelId) continue;
    const profile = normalizeGenerationProfile(rawProfile);
    if (!Object.keys(profile).length) continue;
    delete normalized[modelId];
    normalized[modelId] = profile;
    while (Object.keys(normalized).length > MAX_MODEL_TUNING_ENTRIES) {
      delete normalized[Object.keys(normalized)[0]];
    }
  }
  return normalized;
}

function normalizePendingLegacyStreamInactivitySeconds(value) {
  const normalized = normalizeStreamInactivitySeconds(value);
  return normalized === STREAM_INACTIVITY_SECONDS_DEFAULT_LOCAL ? null : normalized;
}

function normalizeModelTuning(value = {}, legacyPendingValue = null) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    streamInactivitySecondsByModel: normalizeStreamInactivitySecondsByModel(
      source.streamInactivitySecondsByModel || source.stream_inactivity_seconds_by_model
    ),
    pendingLegacyStreamInactivitySeconds: normalizePendingLegacyStreamInactivitySeconds(
      source.pendingLegacyStreamInactivitySeconds
        ?? source.pending_legacy_stream_inactivity_seconds
        ?? legacyPendingValue
    ),
    generationProfilesByModel: normalizeGenerationProfilesByModel(
      source.generationProfilesByModel || source.generation_profiles_by_model
    ),
  };
}

function cloneModelTuning(value = {}) {
  const normalized = normalizeModelTuning(value);
  return {
    streamInactivitySecondsByModel: { ...normalized.streamInactivitySecondsByModel },
    pendingLegacyStreamInactivitySeconds: normalized.pendingLegacyStreamInactivitySeconds,
    generationProfilesByModel: Object.fromEntries(
      Object.entries(normalized.generationProfilesByModel).map(([modelId, profile]) => [
        modelId,
        { ...profile },
      ])
    ),
  };
}

const modelTuningMethods = Object.freeze({
  getModelTuning() {
    return cloneModelTuning(this.state.modelTuning);
  },

  updateModelTuning(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const {
      modelId,
      streamInactivitySeconds,
      generationProfile,
      resetGenerationProfile = false,
    } = source;
    const normalizedModelId = normalizeModelId(modelId);
    if (!normalizedModelId) return this.getModelTuning();
    const current = this.getModelTuning();
    const nextByModel = { ...current.streamInactivitySecondsByModel };
    const nextGenerationProfiles = { ...current.generationProfilesByModel };
    if (Object.prototype.hasOwnProperty.call(source, 'streamInactivitySeconds')) {
      if (streamInactivitySeconds == null) delete nextByModel[normalizedModelId];
      else {
        const normalizedSeconds = normalizeStreamInactivitySeconds(streamInactivitySeconds);
        if (normalizedSeconds == null) return current;
        delete nextByModel[normalizedModelId];
        nextByModel[normalizedModelId] = normalizedSeconds;
      }
    }
    if (resetGenerationProfile) {
      delete nextGenerationProfiles[normalizedModelId];
    } else if (Object.prototype.hasOwnProperty.call(source, 'generationProfile')) {
      const normalizedProfile = normalizeGenerationProfile(generationProfile);
      if (generationProfile && typeof generationProfile === 'object'
        && Object.keys(generationProfile).length !== Object.keys(normalizedProfile).length) {
        return current;
      }
      if (Object.keys(normalizedProfile).length) {
        delete nextGenerationProfiles[normalizedModelId];
        nextGenerationProfiles[normalizedModelId] = normalizedProfile;
      } else {
        delete nextGenerationProfiles[normalizedModelId];
      }
    }
    const next = normalizeModelTuning({
      ...current,
      streamInactivitySecondsByModel: nextByModel,
      generationProfilesByModel: nextGenerationProfiles,
    });
    if (JSON.stringify(next) === JSON.stringify(current)) return current;
    return cloneModelTuning(this._writeState(
      { ...this.state, modelTuning: next },
      'model_tuning_updated'
    ).modelTuning);
  },

  resolveStreamInactivitySeconds(modelId, { cloud = false, ollama = false } = {}) {
    const normalizedModelId = normalizeModelId(modelId);
    const current = this.getModelTuning();
    let explicit = normalizedModelId
      && Object.prototype.hasOwnProperty.call(
        current.streamInactivitySecondsByModel,
        normalizedModelId
      )
      ? current.streamInactivitySecondsByModel[normalizedModelId]
      : null;
    if (explicit == null && ollama && normalizedModelId) {
      const canonicalModelId = canonicalizeOllamaModelId(normalizedModelId);
      const aliasEntry = Object.entries(current.streamInactivitySecondsByModel)
        .find(([candidate]) => canonicalizeOllamaModelId(candidate) === canonicalModelId);
      explicit = aliasEntry ? aliasEntry[1] : null;
    }
    if (explicit != null) {
      if (current.pendingLegacyStreamInactivitySeconds != null) {
        const next = normalizeModelTuning({
          ...current,
          pendingLegacyStreamInactivitySeconds: null,
        });
        this._writeState({ ...this.state, modelTuning: next }, 'model_tuning_legacy_claimed');
      }
      return { seconds: explicit, automatic: false };
    }
    if (normalizedModelId && current.pendingLegacyStreamInactivitySeconds != null) {
      const claimed = current.pendingLegacyStreamInactivitySeconds;
      const next = normalizeModelTuning({
        streamInactivitySecondsByModel: {
          ...current.streamInactivitySecondsByModel,
          [normalizedModelId]: claimed,
        },
        pendingLegacyStreamInactivitySeconds: null,
      });
      this._writeState({ ...this.state, modelTuning: next }, 'model_tuning_legacy_claimed');
      return { seconds: claimed, automatic: false };
    }
    return {
      seconds: cloud ? STREAM_INACTIVITY_SECONDS_DEFAULT_CLOUD : STREAM_INACTIVITY_SECONDS_DEFAULT_LOCAL,
      automatic: true,
    };
  },
});

module.exports = {
  GENERATION_PROFILE_BOUNDS,
  MAX_MODEL_ID_CHARS,
  MAX_MODEL_TUNING_ENTRIES,
  STREAM_INACTIVITY_SECONDS_DEFAULT_CLOUD,
  STREAM_INACTIVITY_SECONDS_DEFAULT_LOCAL,
  STREAM_INACTIVITY_SECONDS_MAX,
  STREAM_INACTIVITY_SECONDS_MIN,
  canonicalizeOllamaModelId,
  cloneModelTuning,
  modelTuningMethods,
  normalizeGenerationProfile,
  normalizeGenerationProfilesByModel,
  normalizeModelId,
  normalizeModelTuning,
  normalizePendingLegacyStreamInactivitySeconds,
  normalizeStreamInactivitySeconds,
  normalizeStreamInactivitySecondsByModel,
};
