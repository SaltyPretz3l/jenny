const DEFAULT_CONTEXT_PREFERENCES = Object.freeze({
  history_scope: 'session',
  include_personality: true,
  include_memory: true,
  include_git_context: true,
  include_codebase_context: true,
  include_active_file_context: true,
  // Memory v2: "Don't remember this chat" (capture off for this session only).
  memory_opt_out: false,
});

function normalizeBoolean(value, fallback) {
  if (value === true || value === false) {
    return value;
  }
  return fallback;
}

function normalizeHistoryScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_CONTEXT_PREFERENCES.history_scope;
  }
  if (normalized === 'session' || normalized === 'recent' || normalized === 'fresh') {
    return normalized;
  }
  return 'fresh';
}

// [snake_case key, camelCase alias] for every boolean preference, in warning order.
const BOOLEAN_PREFERENCE_KEYS = Object.freeze([
  ['include_personality', 'includePersonality'],
  ['include_memory', 'includeMemory'],
  ['include_git_context', 'includeGitContext'],
  ['include_codebase_context', 'includeCodebaseContext'],
  ['include_active_file_context', 'includeActiveFileContext'],
  ['memory_opt_out', 'memoryOptOut'],
]);

function readPreference(source, key, alias) {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : source[alias];
}

function inspectContextPreferences(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawHistoryScopeValue = readPreference(source, 'history_scope', 'historyScope');
  const rawHistoryScope = typeof rawHistoryScopeValue !== 'undefined'
    ? String(rawHistoryScopeValue || '').trim()
    : '';
  const warnings = [];
  const normalized = { history_scope: normalizeHistoryScope(rawHistoryScopeValue) };
  if (rawHistoryScope && normalized.history_scope === 'fresh' && rawHistoryScope.toLowerCase() !== 'fresh') {
    warnings.push(`context_preferences.history_scope:${rawHistoryScope}`);
  }
  for (const [key, alias] of BOOLEAN_PREFERENCE_KEYS) {
    const raw = readPreference(source, key, alias);
    normalized[key] = normalizeBoolean(raw, DEFAULT_CONTEXT_PREFERENCES[key]);
    if (typeof raw !== 'undefined' && typeof raw !== 'boolean') {
      warnings.push(`context_preferences.${key}`);
    }
  }
  return {
    normalized,
    warnings,
  };
}

function normalizeContextPreferences(value) {
  return inspectContextPreferences(value).normalized;
}

module.exports = {
  DEFAULT_CONTEXT_PREFERENCES,
  inspectContextPreferences,
  normalizeContextPreferences,
  normalizeHistoryScope,
};
