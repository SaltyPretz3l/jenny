const {
  TOOL_SETTING_KEYS,
} = require('./tool-config-schema');
const { isAgentQuietLaunch } = require('./agent-quiet-launch');
const { FEATURE_FLAG_TABLE, RETIRED_FEATURE_FLAG_ENV_KEYS } = require('./feature-flag-table');

// Every flag is one row in services/feature-flag-table.js; the lists and the
// defaults below are derived from it.

function isFeatureEnabledByDefault(envValue, defaultValue = true) {
  const normalized = String(envValue || '').trim().toLowerCase();
  if (!normalized) {
    return defaultValue === true;
  }
  if (/^(1|true|yes|on)$/.test(normalized)) {
    return true;
  }
  if (/^(0|false|no|off)$/.test(normalized)) {
    return false;
  }
  return defaultValue === true;
}

const envKeyOf = (row) => `JENNY_ENABLE_${row.env}`;
const keysWhere = (predicate) => Object.freeze(FEATURE_FLAG_TABLE.filter(predicate).map((row) => row.key));

const FEATURE_OVERRIDE_KEYS = keysWhere((row) => row.override === true);
const INTERNAL_FEATURE_FLAG_KEYS = keysWhere((row) => row.internal === true);
const FORCE_DENY_ENV_KEYS = Object.freeze(Object.fromEntries(
  FEATURE_FLAG_TABLE.filter((row) => row.forceDeny === true).map((row) => [row.key, envKeyOf(row)])
));

// Resolvers for a row's `dynamicDefault`; each returns the default used when
// the row's own JENNY_ENABLE_* variable is unset or unrecognised.
const DYNAMIC_DEFAULTS = Object.freeze({
  // On under the agent/dev launcher (JENNY_AGENT_DEV), off everywhere else.
  agent_dev: ({ env }) => isFeatureEnabledByDefault(env.JENNY_AGENT_DEV, false),
  // Off for quiet agent launches (services/agent-quiet-launch.js).
  agent_quiet_off: ({ env }) => !isAgentQuietLaunch(env),
  // Follows the already-resolved canonical_m3_rollout row (earlier in the table).
  canonical_m3_rollout: ({ flags, row }) => (flags.canonical_m3_rollout === true ? true : row.default),
});

function normalizeBooleanOverride(value) {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  return null;
}

function normalizeFeatureOverrides(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const key of FEATURE_OVERRIDE_KEYS) {
    const candidate = normalizeBooleanOverride(source[key]);
    if (candidate == null) {
      continue;
    }
    normalized[key] = candidate;
  }
  return normalized;
}

function buildFeatureFlagDefaults(env = process.env) {
  const flags = {};
  for (const row of FEATURE_FLAG_TABLE) {
    const fallback = row.dynamicDefault
      ? DYNAMIC_DEFAULTS[row.dynamicDefault]({ env, flags, row })
      : row.default;
    flags[row.key] = isFeatureEnabledByDefault(env[envKeyOf(row)], fallback);
  }
  return flags;
}

function buildFeatureFlags(env = process.env, overrides = {}) {
  const flags = {
    ...buildFeatureFlagDefaults(env),
    ...normalizeFeatureOverrides(overrides),
  };
  for (const [key, envKey] of Object.entries(FORCE_DENY_ENV_KEYS)) {
    if (isFeatureEnabledByDefault(env[envKey], true) === false) {
      flags[key] = false;
    }
  }
  return flags;
}

module.exports = {
  FEATURE_OVERRIDE_KEYS,
  FORCE_DENY_ENV_KEYS,
  INTERNAL_FEATURE_FLAG_KEYS,
  RETIRED_FEATURE_FLAG_ENV_KEYS,
  TOOL_SETTING_KEYS,
  buildFeatureFlags,
  buildFeatureFlagDefaults,
  isFeatureEnabledByDefault,
  normalizeFeatureOverrides,
};
