/* services/backend/managed-sidecar-engine-tuning.js - raw_config resolution for the
 * Advanced engine-tuning knobs.
 *
 * Split out of managed-sidecar-config.js, which sits against the file-size
 * ceiling. Everything here answers one question: what value, if any, has the
 * user set for a given tuning key - and it deliberately says "nothing" rather
 * than inventing a default, so the sidecar's own default stays authoritative.
 *
 * Bounds and defaults are READ from renderer/shared/engine-tuning-schema.js,
 * never restated here: that schema is the single bounds table, machine-checked
 * against sidecar/ai/config.py, and a literal copy in this file would drift.
 */
const { getFieldDefinition } = require('../../renderer/shared/engine-tuning-schema');

// Resolve one Advanced engine-tuning override. The owned `engineTuning` block is
// authoritative whenever the config service exposes it: since CONFIG_VERSION 48
// the legacy flat keys are harvested into that block and stripped on write, so
// a null there means "unset" - NOT "go look elsewhere". Falling through to a
// full getState() (a deep clone of the whole shell config) on every unset key
// turned ~28 single-key lookups per buildManagedSidecarConfig into ~28 deep
// clones. The flat-key walk survives only for a config service that predates
// the owned block (test doubles, foreign shells).
function resolveEngineTuningOverride(service, keys) {
  const configService = service.configService;
  if (!configService) return null;
  const aliases = Array.isArray(keys) ? keys : [keys];
  if (typeof configService.resolveEngineTuningValue === 'function') {
    const owned = configService.resolveEngineTuningValue(aliases[0]);
    return owned == null ? null : owned;
  }
  if (typeof configService.getState !== 'function') return null;
  const state = configService.getState() || {};
  for (const alias of aliases) {
    if (state[alias] != null) return state[alias];
  }
  return null;
}

function aliasesFor(field) {
  return field.rawKey ? [field.key, field.rawKey] : [field.key];
}

function requireField(key) {
  const field = getFieldDefinition(key);
  if (!field) throw new Error(`Unknown engine tuning field: ${key}`);
  return field;
}

// Same resolution, but emits null (not a default) when the user has no
// override. `raw_config.get(k)` returning None makes the sidecar fall through to
// its own default, so an unset key is byte-identical to an absent one - which is
// what keeps every newly-emitted key inert until somebody actually sets it.
function getConfiguredOptionalBounded(service, keys, minValue, maxValue, { integer = false } = {}) {
  const rawValue = resolveEngineTuningOverride(service, keys);
  if (rawValue == null) return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return null;
  const normalized = integer ? Math.trunc(parsed) : parsed;
  if (integer && normalized !== parsed) return null;
  return normalized >= minValue && normalized <= maxValue ? normalized : null;
}

// Schema-driven optional reader: bounds, type, and aliases come from the field.
function getConfiguredOptional(service, key) {
  const field = requireField(key);
  return getConfiguredOptionalBounded(service, aliasesFor(field), field.min, field.max, {
    integer: field.type === 'integer',
  });
}

// Schema-driven reader for fields the sidecar has always received: returns the
// schema default (never null) when unset, non-finite, or out of range. Drop,
// never clamp - the sidecar does the same with an out-of-range value.
function getConfiguredWithDefault(service, key) {
  const field = requireField(key);
  const rawValue = resolveEngineTuningOverride(service, aliasesFor(field));
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return field.default;
  const normalized = field.type === 'integer' ? Math.trunc(parsed) : parsed;
  return normalized >= field.min && normalized <= field.max ? normalized : field.default;
}

function getConfiguredToolsExecutionTimeoutSeconds(service) {
  return getConfiguredOptional(service, 'toolsExecutionTimeoutSeconds');
}

function getConfiguredToolsGitTimeoutSeconds(service) {
  return getConfiguredOptional(service, 'toolsGitTimeoutSeconds');
}

function getConfiguredMaxCodeIntelligenceToolCallsPerTurn(service) {
  return getConfiguredOptional(service, 'maxCodeIntelligenceToolCallsPerTurn');
}

function getConfiguredToolsPythonRuntimeTimeoutSeconds(service) {
  return getConfiguredOptional(service, 'toolsPythonRuntimeTimeoutSeconds');
}

function getConfiguredToolsPythonRuntimeMaxMemoryMb(service) {
  return getConfiguredOptional(service, 'toolsPythonRuntimeMaxMemoryMb');
}

// Global token-budget knobs. Distinct from the PER-MODEL auto-compact ratio in
// compactionTuning.ratioByModel, which the sidecar applies in preference to
// these when a model-specific value exists. All four have no sidecar default
// (schema default null), so unset emits null.
function getConfiguredTokenBudgetTuning(service) {
  return {
    autoCompactRatio: getConfiguredOptional(service, 'tokenBudgetAutoCompactRatio'),
    warningRatio: getConfiguredOptional(service, 'tokenBudgetWarningRatio'),
    reservedForSummary: getConfiguredOptional(service, 'tokenBudgetReservedForSummary'),
    toolOverhead: getConfiguredOptional(service, 'tokenBudgetToolOverhead'),
  };
}

// Cloud-engine loop profile. The schema keeps these DELIBERATELY WIDER than
// their local twins (see sidecar/ai/config.py) - the whole point of the profile
// is limits a local GPU would never be given.
function getConfiguredCloudLoopProfile(service) {
  return {
    maxChatLoopIterations: getConfiguredOptional(service, 'cloudMaxChatLoopIterations'),
    maxTaskLoopIterations: getConfiguredOptional(service, 'cloudMaxTaskLoopIterations'),
    maxToolsPerTurn: getConfiguredOptional(service, 'cloudMaxToolsPerTurn'),
    maxToolCallsPerSession: getConfiguredOptional(service, 'cloudMaxToolCallsPerSession'),
    maxWebToolCallsPerTurn: getConfiguredOptional(service, 'cloudMaxWebToolCallsPerTurn'),
    toolsExecutionTimeoutSeconds: getConfiguredOptional(service, 'cloudToolsExecutionTimeoutSeconds'),
  };
}

module.exports = {
  resolveEngineTuningOverride,
  getConfiguredOptionalBounded,
  getConfiguredOptional,
  getConfiguredWithDefault,
  getConfiguredToolsExecutionTimeoutSeconds,
  getConfiguredToolsGitTimeoutSeconds,
  getConfiguredMaxCodeIntelligenceToolCallsPerTurn,
  getConfiguredToolsPythonRuntimeTimeoutSeconds,
  getConfiguredToolsPythonRuntimeMaxMemoryMb,
  getConfiguredTokenBudgetTuning,
  getConfiguredCloudLoopProfile,
};
