'use strict';

// Defensive copies of the skills state the service hands out, so a caller
// can never mutate the service's cached snapshot.

function cloneSkillEntry(entry = {}) {
  return {
    id: String(entry.id || ''),
    enabled: entry.enabled !== false,
    scope: String(entry.scope || ''),
    name: String(entry.name || ''),
    description: String(entry.description || ''),
    command: String(entry.command || ''),
    whenToUse: String(entry.whenToUse || ''),
    allowedTools: Array.isArray(entry.allowedTools) ? [...entry.allowedTools] : [],
    always: entry.always === true,
    body: String(entry.body || ''),
    path: String(entry.path || ''),
    realPath: String(entry.realPath || ''),
    relPath: String(entry.relPath || ''),
  };
}

function cloneSkillWarning(warning = {}) {
  return {
    scope: String(warning.scope || ''),
    path: String(warning.path || ''),
    code: String(warning.code || ''),
    message: String(warning.message || ''),
  };
}

function cloneSkillScope(scope = {}) {
  return {
    scope: String(scope.scope || ''),
    label: String(scope.label || ''),
    path: String(scope.path || ''),
    enabled: scope.enabled === true,
    status: String(scope.status || ''),
    message: String(scope.message || ''),
    blocked: scope.blocked === true,
    workspaceRoot: String(scope.workspaceRoot || ''),
    entries: Array.isArray(scope.entries) ? scope.entries.map((entry) => cloneSkillEntry(entry)) : [],
    warnings: Array.isArray(scope.warnings)
      ? scope.warnings.map((warning) => cloneSkillWarning(warning))
      : [],
  };
}

function cloneSkillsState(state = {}) {
  return {
    featureEnabled: state.featureEnabled === true,
    settings: {
      ...(state.settings && typeof state.settings === 'object' && !Array.isArray(state.settings)
        ? state.settings
        : {}),
      disabledSkillIds: Array.isArray(state.settings?.disabledSkillIds)
        ? [...state.settings.disabledSkillIds]
        : [],
    },
    scopes: Array.isArray(state.scopes) ? state.scopes.map((scope) => cloneSkillScope(scope)) : [],
    entries: Array.isArray(state.entries) ? state.entries.map((entry) => cloneSkillEntry(entry)) : [],
    warnings: Array.isArray(state.warnings)
      ? state.warnings.map((warning) => cloneSkillWarning(warning))
      : [],
    counts: {
      total: Number.isFinite(Number(state.counts?.total)) ? Number(state.counts.total) : 0,
      always: Number.isFinite(Number(state.counts?.always)) ? Number(state.counts.always) : 0,
      warnings: Number.isFinite(Number(state.counts?.warnings)) ? Number(state.counts.warnings) : 0,
    },
  };
}

module.exports = { cloneSkillScope, cloneSkillsState };
