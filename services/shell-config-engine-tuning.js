/* services/shell-config-engine-tuning.js - Persistence for the Advanced engine-tuning knobs.
 *
 * normalizeState() in shell-config-state.js is an ALLOWLISTED object literal, so
 * a tuning key missing from that allowlist is silently dropped on every write.
 * Owning ONE key (`engineTuning`) rather than ~25 top-level keys makes that
 * structurally impossible: a single key backed by a dedicated normalizer cannot
 * be half-added to the allowlist.
 *
 * Bounds live in renderer/shared/engine-tuning-schema.js and are mirrored from
 * sidecar/ai/config.py by a machine-checked drift guard. There is no second
 * bounds table here on purpose.
 */
const {
  ENGINE_TUNING_FIELDS,
  STORAGE_ENGINE_TUNING,
  getFieldDefinition,
  normalizeEngineTuningValue,
} = require('../renderer/shared/engine-tuning-schema');

/* Every schema field persists into this block - including `maxBudgetUsd`,
 * which the v48 migration folded in from its old bare top-level spelling. The
 * top-level key survives only as a read mirror derived from this block. */
const OWNED_FIELDS = Object.freeze(
  ENGINE_TUNING_FIELDS.filter((field) => field.storage === STORAGE_ENGINE_TUNING)
);
const OWNED_KEYS = Object.freeze(OWNED_FIELDS.map((field) => field.key));

/* snake_case aliases for the legacy flat keys the managed-sidecar-config readers
 * have always probed (`['maxToolsPerTurn', 'max_tools_per_turn']`), so a
 * hand-edited shell-config.json is harvested in either spelling. */
const LEGACY_ALIASES = Object.freeze(
  OWNED_FIELDS.reduce((accumulator, field) => {
    accumulator[field.key] = Object.freeze([field.key, field.rawKey]);
    return accumulator;
  }, Object.create(null))
);

function normalizeEngineTuning(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const key of OWNED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    // Drop-not-clamp, and drop values equal to the default: see the
    // normalization contract in renderer/shared/engine-tuning-schema.js.
    const candidate = normalizeEngineTuningValue(key, source[key]);
    if (candidate == null) continue;
    normalized[key] = candidate;
  }
  return normalized;
}

function cloneEngineTuning(value = {}) {
  return { ...normalizeEngineTuning(value) };
}

/* One-time rescue for a hand-edited config. The readers probed `state[key]`
 * directly for years, so a power user who edited shell-config.json by hand has
 * these as flat top-level keys today; normalizeState dropped them on the next
 * write, but a read-only session preserved them on disk. Tolerant of an
 * already-nested block because every migration step runs in sequence. */
function harvestLegacyEngineTuning(...sources) {
  const harvested = {};
  for (const source of sources) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    const nested = source.engineTuning || source.engine_tuning;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      for (const key of OWNED_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(nested, key)) continue;
        if (harvested[key] === undefined) harvested[key] = nested[key];
      }
    }
    for (const key of OWNED_KEYS) {
      if (harvested[key] !== undefined) continue;
      for (const alias of LEGACY_ALIASES[key]) {
        if (!Object.prototype.hasOwnProperty.call(source, alias)) continue;
        harvested[key] = source[alias];
        break;
      }
    }
  }
  return normalizeEngineTuning(harvested);
}

/* Remove the flat spellings once harvested, so the owned block is the only
 * place a value can live and a stale flat key cannot shadow a later edit. */
function stripLegacyEngineTuningKeys(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return target;
  for (const key of OWNED_KEYS) {
    for (const alias of LEGACY_ALIASES[key]) {
      delete target[alias];
    }
  }
  return target;
}

/* Next state for a write. normalizeState mirrors engineTuning.maxBudgetUsd to
 * the top-level key and, when the block has no opinion, absorbs a top-level
 * value back INTO the block - so a write that carries the previous top-level
 * mirror alongside a block that just dropped the key would resurrect it. Derive
 * the mirror from the block here so the block is the only thing that speaks. */
function withEngineTuning(state, engineTuning) {
  return {
    ...state,
    maxBudgetUsd: Object.prototype.hasOwnProperty.call(engineTuning, 'maxBudgetUsd')
      ? engineTuning.maxBudgetUsd
      : null,
    engineTuning,
  };
}

const engineTuningMethods = Object.freeze({
  getEngineTuning() {
    return cloneEngineTuning(this.state.engineTuning);
  },

  /* Patch semantics: a key mapped to null/undefined is a RESET (delete), any
   * other value is validated and either stored or ignored. Returns the resulting
   * block; identical writes short-circuit so callers do not trigger a needless
   * sidecar refresh. */
  updateEngineTuning(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const current = this.getEngineTuning();
    const next = { ...current };
    for (const [rawKey, rawValue] of Object.entries(source)) {
      const field = getFieldDefinition(rawKey);
      if (!field || field.storage !== STORAGE_ENGINE_TUNING) continue;
      if (rawValue == null || rawValue === '') {
        delete next[rawKey];
        continue;
      }
      const candidate = normalizeEngineTuningValue(rawKey, rawValue);
      // A value that normalizes to null is either out of bounds or exactly the
      // default; both mean "no override", so the key goes back to unset rather
      // than silently retaining a stale previous override.
      if (candidate == null) delete next[rawKey];
      else next[rawKey] = candidate;
    }
    const normalized = normalizeEngineTuning(next);
    if (JSON.stringify(normalized) === JSON.stringify(current)) return current;
    return cloneEngineTuning(this._writeState(
      withEngineTuning(this.state, normalized),
      'engine_tuning_updated'
    ).engineTuning);
  },

  /* Clear every override, or only those on one segmented pane. Scope filtering
   * uses the schema so `shared` fields clear from either pane. */
  resetEngineTuning(scope = null) {
    const current = this.getEngineTuning();
    const normalizedScope = String(scope || '').trim();
    const next = {};
    if (normalizedScope) {
      for (const [key, value] of Object.entries(current)) {
        const field = getFieldDefinition(key);
        if (!field) continue;
        if (field.scope === normalizedScope || field.scope === 'shared') continue;
        next[key] = value;
      }
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return current;
    return cloneEngineTuning(this._writeState(
      withEngineTuning(this.state, next),
      'engine_tuning_reset'
    ).engineTuning);
  },

  /* Resolved override for one key, or null when the user has not set it.
   * managed-sidecar-config uses this to decide between a user value and the
   * sidecar default. */
  resolveEngineTuningValue(key) {
    const current = this.getEngineTuning();
    return Object.prototype.hasOwnProperty.call(current, key) ? current[key] : null;
  },
});

module.exports = {
  OWNED_ENGINE_TUNING_KEYS: OWNED_KEYS,
  cloneEngineTuning,
  engineTuningMethods,
  harvestLegacyEngineTuning,
  normalizeEngineTuning,
  stripLegacyEngineTuningKeys,
};
