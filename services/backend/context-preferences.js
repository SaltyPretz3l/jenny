const DEFAULT_CONTEXT_PREFERENCES = Object.freeze({
  history_scope: 'session',
  include_personality: true,
  include_memory: true,
  include_git_context: true,
  include_codebase_context: true,
  include_active_file_context: true,
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

function inspectContextPreferences(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawHistoryScopeValue = Object.prototype.hasOwnProperty.call(source, 'history_scope')
    ? source.history_scope
    : source.historyScope;
  const rawIncludePersonalityValue = Object.prototype.hasOwnProperty.call(source, 'include_personality')
    ? source.include_personality
    : source.includePersonality;
  const rawIncludeMemoryValue = Object.prototype.hasOwnProperty.call(source, 'include_memory')
    ? source.include_memory
    : source.includeMemory;
  const rawIncludeGitContextValue = Object.prototype.hasOwnProperty.call(source, 'include_git_context')
    ? source.include_git_context
    : source.includeGitContext;
  const rawIncludeCodebaseContextValue = Object.prototype.hasOwnProperty.call(source, 'include_codebase_context')
    ? source.include_codebase_context
    : source.includeCodebaseContext;
  const rawIncludeActiveFileContextValue = Object.prototype.hasOwnProperty.call(source, 'include_active_file_context')
    ? source.include_active_file_context
    : source.includeActiveFileContext;
  const warnings = [];
  const rawHistoryScope = typeof rawHistoryScopeValue !== 'undefined'
    ? String(rawHistoryScopeValue || '').trim()
    : '';

  const normalized = {
    history_scope: normalizeHistoryScope(rawHistoryScopeValue),
    include_personality: normalizeBoolean(
      rawIncludePersonalityValue,
      DEFAULT_CONTEXT_PREFERENCES.include_personality
    ),
    include_memory: normalizeBoolean(
      rawIncludeMemoryValue,
      DEFAULT_CONTEXT_PREFERENCES.include_memory
    ),
    include_git_context: normalizeBoolean(
      rawIncludeGitContextValue,
      DEFAULT_CONTEXT_PREFERENCES.include_git_context
    ),
    include_codebase_context: normalizeBoolean(
      rawIncludeCodebaseContextValue,
      DEFAULT_CONTEXT_PREFERENCES.include_codebase_context
    ),
    include_active_file_context: normalizeBoolean(
      rawIncludeActiveFileContextValue,
      DEFAULT_CONTEXT_PREFERENCES.include_active_file_context
    ),
  };

  if (rawHistoryScope && normalized.history_scope === 'fresh' && rawHistoryScope.toLowerCase() !== 'fresh') {
    warnings.push(`context_preferences.history_scope:${rawHistoryScope}`);
  }
  if (
    typeof rawIncludePersonalityValue !== 'undefined'
    && rawIncludePersonalityValue !== true
    && rawIncludePersonalityValue !== false
  ) {
    warnings.push('context_preferences.include_personality');
  }
  if (
    typeof rawIncludeMemoryValue !== 'undefined'
    && rawIncludeMemoryValue !== true
    && rawIncludeMemoryValue !== false
  ) {
    warnings.push('context_preferences.include_memory');
  }
  if (
    typeof rawIncludeGitContextValue !== 'undefined'
    && rawIncludeGitContextValue !== true
    && rawIncludeGitContextValue !== false
  ) {
    warnings.push('context_preferences.include_git_context');
  }
  if (
    typeof rawIncludeCodebaseContextValue !== 'undefined'
    && rawIncludeCodebaseContextValue !== true
    && rawIncludeCodebaseContextValue !== false
  ) {
    warnings.push('context_preferences.include_codebase_context');
  }
  if (
    typeof rawIncludeActiveFileContextValue !== 'undefined'
    && rawIncludeActiveFileContextValue !== true
    && rawIncludeActiveFileContextValue !== false
  ) {
    warnings.push('context_preferences.include_active_file_context');
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
