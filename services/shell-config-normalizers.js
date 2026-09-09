const {
  DEFAULT_COMPANION_MODE,
  normalizeCompanionMode,
} = require('./companion-mode');
const { normalizeString } = require('./backend/path-utils');
const { normalizeFeatureOverrides } = require('./feature-flags');
const {
  DEFAULT_TOOL_SETTINGS,
  normalizeToolSettings,
} = require('./tool-config-schema');
const { isEngineTuningValueInRange } = require('../renderer/shared/engine-tuning-schema');

const DEFAULT_COMPANION = Object.freeze({
  mode: DEFAULT_COMPANION_MODE,
});
const DEFAULT_WORKSPACE_STATE = Object.freeze({
  activeSessionId: null,
  openSessionIds: [],
});
const DEFAULT_SKILLS = Object.freeze({
  bundledEnabled: true,
  userEnabled: false,
  projectEnabled: false,
  disabledSkillIds: Object.freeze([]),
  autoIndex: 'auto',
});
const SKILL_ID_PATTERN = /^(bundled|user|project)\/[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*){0,7}$/;
const DEFAULT_TIPS = Object.freeze({
  sessionCount: 0,
  historyByTipId: {},
});
const DEFAULT_MEMORY = Object.freeze({
  captureSuggestions: true,
});
const DEFAULT_TOOLS = DEFAULT_TOOL_SETTINGS;
const DEFAULT_TELEMETRY = Object.freeze({
  crashReportingOptIn: false,
});
const DEFAULT_FEATURE_OVERRIDES = Object.freeze({});
const UI_LANGUAGE_TAGS = Object.freeze([
  'en', 'es', 'fr', 'de', 'it', 'pt-BR', 'nl', 'pl', 'ru', 'uk', 'tr', 'ar', 'hi',
  'id', 'vi', 'ja', 'ko', 'zh-CN', 'zh-TW',
]);
const SAFETY_MODES = Object.freeze(['normal', 'strict', 'paranoid']);
const UNATTENDED_GUARD_MINUTES_DEFAULT = 10;
const UNATTENDED_GUARD_MINUTES_MAX = 120;

function normalizeUiLanguage(value) {
  if (typeof value !== 'string') return 'en';
  const normalized = value.toLowerCase();
  return UI_LANGUAGE_TAGS.find((tag) => tag.toLowerCase() === normalized) || 'en';
}

function normalizeSafetyMode(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SAFETY_MODES.includes(normalized) ? normalized : 'normal';
}

function normalizeUnattendedGuardMinutes(value) {
  if (!['number', 'string'].includes(typeof value)
    || (typeof value === 'string' && !value.trim())) {
    return UNATTENDED_GUARD_MINUTES_DEFAULT;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return UNATTENDED_GUARD_MINUTES_DEFAULT;
  if (parsed === 0) return 0;
  return Math.min(UNATTENDED_GUARD_MINUTES_MAX, Math.max(1, Math.trunc(parsed)));
}

function normalizeCompanion(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    mode: normalizeCompanionMode(source.mode),
  };
}

function normalizeMemorySettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    captureSuggestions: source.captureSuggestions !== false,
  };
}

function normalizeWorkspaceRoot(value) {
    const normalized = normalizeString(value);
    return normalized || null;
}

function hasOwnConfigField(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function normalizeTelemetrySettings(value = undefined, legacyState = {}) {
  const hasSource = value && typeof value === 'object' && !Array.isArray(value);
  const source = hasSource ? value : {};
  if (hasOwnConfigField(source, 'crashReportingOptIn')) {
    return {
      crashReportingOptIn: source.crashReportingOptIn === true,
    };
  }
  if (hasOwnConfigField(source, 'crash_reporting_opt_in')) {
    return {
      crashReportingOptIn: source.crash_reporting_opt_in === true,
    };
  }
  if (hasSource) {
    return {
      crashReportingOptIn: false,
    };
  }
  return {
    crashReportingOptIn:
      legacyState.crashReportingOptIn === true
      || legacyState.crash_reporting_opt_in === true,
  };
}

// Range comes from the engine-tuning schema (the single bounds table) so the
// top-level mirror can never accept a value the owned block rejects, or vice versa.
function normalizeMaxBudgetUsd(value) {
  if (value == null || value === '') return null;
  return isEngineTuningValueInRange('maxBudgetUsd', value) ? Number(value) : null;
}

function normalizeToolsSettings(value = {}, legacyState = {}) {
  return normalizeToolSettings(value, legacyState);
}

function isToolsWorktreeEnabled(state = {}) {
  const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const tools = source.tools && typeof source.tools === 'object' && !Array.isArray(source.tools)
    ? source.tools
    : {};
  return tools.worktree === true
    || source.toolsWorktreeEnabled === true
    || source.tools_worktree_enabled === true;
}

function cloneFeatureOverrides(value = {}) {
  return normalizeFeatureOverrides(value);
}

function normalizeSkillSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalizeScopeToggle = (camelKey, snakeKey, fallback) => {
    if (source[camelKey] === true || source[snakeKey] === true) return true;
    if (source[camelKey] === false || source[snakeKey] === false) return false;
    return fallback;
  };
  const rawDisabledIds = source.disabledSkillIds ?? source.disabled_skill_ids;
  const disabledSkillIds = [];
  for (const rawId of Array.isArray(rawDisabledIds) ? rawDisabledIds : []) {
    const skillId = typeof rawId === 'string' ? rawId.trim() : '';
    if (SKILL_ID_PATTERN.test(skillId) && !disabledSkillIds.includes(skillId)) {
      disabledSkillIds.push(skillId);
      if (disabledSkillIds.length >= 256) break;
    }
  }
  const rawAutoIndex = source.autoIndex ?? source.auto_index;
  return {
    bundledEnabled: normalizeScopeToggle(
      'bundledEnabled', 'bundled_enabled', DEFAULT_SKILLS.bundledEnabled
    ),
    userEnabled: normalizeScopeToggle('userEnabled', 'user_enabled', DEFAULT_SKILLS.userEnabled),
    projectEnabled: normalizeScopeToggle(
      'projectEnabled', 'project_enabled', DEFAULT_SKILLS.projectEnabled
    ),
    disabledSkillIds,
    autoIndex: ['auto', 'on', 'off'].includes(rawAutoIndex) ? rawAutoIndex : DEFAULT_SKILLS.autoIndex,
  };
}

function normalizeTipHistoryById(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = normalizeString(rawKey);
    if (!key) {
      continue;
    }
    const sessionIndex = Number(rawValue);
    if (!Number.isFinite(sessionIndex) || sessionIndex < 0) {
      continue;
    }
    normalized[key] = Math.floor(sessionIndex);
  }
  return normalized;
}

function normalizeTipsSettings(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sessionCount = Number(source.sessionCount || source.session_count);
  return {
    sessionCount: Number.isFinite(sessionCount) && sessionCount >= 0
      ? Math.floor(sessionCount)
      : DEFAULT_TIPS.sessionCount,
    historyByTipId: normalizeTipHistoryById(
      source.historyByTipId || source.history_by_tip_id
    ),
  };
}

function normalizeWorkspaceSessionId(value) {
  const normalized = normalizeString(value);
  return normalized || null;
}

function normalizeValidWorkspaceSessionIds(value) {
  if (value == null) {
    return null;
  }
  const entries =
    value instanceof Set
      ? [...value]
      : Array.isArray(value)
        ? value
        : typeof value[Symbol.iterator] === 'function'
          ? [...value]
          : [];
  const normalized = new Set();
  for (const entry of entries) {
    const sessionId = normalizeWorkspaceSessionId(entry);
    if (sessionId) {
      normalized.add(sessionId);
    }
  }
  return normalized;
}

function normalizeWorkspaceSessionIdList(value, validSessionIds = null) {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const sessionId = normalizeWorkspaceSessionId(entry);
    if (!sessionId || seen.has(sessionId)) {
      continue;
    }
    if (validSessionIds && !validSessionIds.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    result.push(sessionId);
    if (result.length >= 8) {
      break;
    }
  }
  return result;
}

function normalizeWorkspaceState(value = {}, validSessionIds = null) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalizedValidIds = normalizeValidWorkspaceSessionIds(validSessionIds);
  let activeSessionId = normalizeWorkspaceSessionId(
    source.activeSessionId || source.active_session_id
  );
  if (normalizedValidIds && activeSessionId && !normalizedValidIds.has(activeSessionId)) {
    activeSessionId = null;
  }
  return {
    activeSessionId,
    openSessionIds: normalizeWorkspaceSessionIdList(
      source.openSessionIds || source.open_session_ids,
      normalizedValidIds
    ),
  };
}

module.exports = {
  DEFAULT_COMPANION,
  DEFAULT_FEATURE_OVERRIDES,
  DEFAULT_MEMORY,
  DEFAULT_SKILLS,
  DEFAULT_TELEMETRY,
  DEFAULT_TIPS,
  DEFAULT_TOOLS,
  DEFAULT_WORKSPACE_STATE,
  SAFETY_MODES,
  UI_LANGUAGE_TAGS,
  UNATTENDED_GUARD_MINUTES_DEFAULT,
  UNATTENDED_GUARD_MINUTES_MAX,
  cloneFeatureOverrides,
  hasOwnConfigField,
  isToolsWorktreeEnabled,
  normalizeCompanion,
  normalizeMaxBudgetUsd,
  normalizeMemorySettings,
  normalizeSkillSettings,
  normalizeTelemetrySettings,
  normalizeTipHistoryById,
  normalizeTipsSettings,
  normalizeToolsSettings,
  normalizeSafetyMode,
  normalizeUiLanguage,
  normalizeUnattendedGuardMinutes,
  normalizeValidWorkspaceSessionIds,
  normalizeWorkspaceRoot,
  normalizeWorkspaceSessionId,
  normalizeWorkspaceSessionIdList,
  normalizeWorkspaceState,
};
