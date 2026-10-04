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
// The split-view pane rules live in ONE place (UMD, loads under Node); the
// workspace normalizer derives the persisted layout through it.
const {
  DEFAULT_SPLIT_RATIO,
  deriveCurrentSessionId,
  normalizePaneLayout,
  resolvePaneForSession,
} = require('../renderer/shell/renderer-pane-model');

const DEFAULT_COMPANION = Object.freeze({
  mode: DEFAULT_COMPANION_MODE,
});
const DEFAULT_WORKSPACE_STATE = Object.freeze({
  activeSessionId: null,
  openSessionIds: [],
  panes: Object.freeze([Object.freeze({ paneId: 0, sessionId: '' })]),
  focusedPaneId: 0,
  splitRatio: DEFAULT_SPLIT_RATIO,
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
const UNATTENDED_GUARD_MINUTES_DEFAULT = 0;
const UNATTENDED_GUARD_MINUTES_MAX = 120;
const AUTO_APPROVE_STREAK_CAP_DEFAULT = 50;
const AUTO_APPROVE_STREAK_CAP_MAX = 500;

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

function normalizeAutoApproveStreakCap(value) {
  if (!['number', 'string'].includes(typeof value)
    || (typeof value === 'string' && !value.trim())) return AUTO_APPROVE_STREAK_CAP_DEFAULT;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return AUTO_APPROVE_STREAK_CAP_DEFAULT;
  return Math.min(AUTO_APPROVE_STREAK_CAP_MAX, Math.max(0, Math.trunc(parsed)));
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

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

// The stored layout fields, camelCase first, then the snake_case aliases, then
// a nested `pane_layout` block. `panes` stays null when nothing was stored.
function readStoredPaneLayout(source) {
  const nested = source.pane_layout && typeof source.pane_layout === 'object' ? source.pane_layout : {};
  const panes = firstDefined(source.panes, nested.panes);
  return {
    panes: panes == null ? null : panes,
    focusedPaneId: firstDefined(
      source.focusedPaneId, source.focused_pane_id, nested.focusedPaneId, nested.focused_pane_id
    ),
    splitRatio: firstDefined(source.splitRatio, source.split_ratio, nested.splitRatio, nested.split_ratio),
  };
}

function toPlainPaneLayout(layout) {
  return {
    panes: layout.panes.map(({ paneId, sessionId }) => ({ paneId, sessionId })),
    focusedPaneId: layout.focusedPaneId,
    splitRatio: layout.splitRatio,
  };
}

/**
 * The persisted pane layout: the pane model's rules (one pane at least, a
 * session in one pane only, known sessions only, focus in range, ratio in
 * [0.2, 0.8]) plus the rail's: a pane may only show an OPEN tab, so a pane
 * whose session is not in `openSessionIds` holds nothing. Nothing stored seeds
 * one pane from the active tab. Returns plain objects (never the frozen value).
 */
function normalizeWorkspacePaneLayout(source, activeSessionId, openSessionIds, validSessionIds) {
  const stored = readStoredPaneLayout(source);
  const layout = normalizePaneLayout({
    panes: stored.panes == null ? [activeSessionId || ''] : stored.panes,
    focusedPaneId: stored.focusedPaneId,
    splitRatio: stored.splitRatio,
  }, { validSessionIds });
  const open = new Set(openSessionIds);
  return toPlainPaneLayout(normalizePaneLayout({
    panes: layout.panes.map(({ sessionId }) => (open.has(sessionId) ? sessionId : '')),
    focusedPaneId: layout.focusedPaneId,
    splitRatio: layout.splitRatio,
  }));
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
  const openSessionIds = normalizeWorkspaceSessionIdList(
    source.openSessionIds || source.open_session_ids,
    normalizedValidIds
  );
  const layout = normalizeWorkspacePaneLayout(source, activeSessionId, openSessionIds, normalizedValidIds);
  // The focused pane's session IS the active tab; a blank focused pane leaves
  // activeSessionId as it was, so every existing reader keeps its meaning.
  return {
    activeSessionId: deriveCurrentSessionId(layout) || activeSessionId,
    openSessionIds,
    ...layout,
  };
}

const PANE_FOCUS_PATCH_KEYS = ['panes', 'focusedPaneId', 'pane_layout', 'focused_pane_id'];

/**
 * Merge a `workspace.updateState` patch over the stored workspace. A patch that
 * names the layout (panes or focus) is authoritative and activeSessionId is
 * derived from it. A rail-only patch (activeSessionId, no layout) moves the
 * layout with the rail, so today's writers keep their meaning: focus the pane
 * already showing that session, otherwise show it in the focused pane.
 */
function mergeWorkspacePatch(current = {}, patch = {}) {
  const merged = { ...current, ...patch };
  const railOnly = Object.prototype.hasOwnProperty.call(patch, 'activeSessionId')
    && !PANE_FOCUS_PATCH_KEYS.some((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (!railOnly || !Array.isArray(current.panes)) return merged;
  const activeSessionId = normalizeString(patch.activeSessionId);
  const layout = normalizePaneLayout(current);
  const holder = resolvePaneForSession(layout, activeSessionId);
  if (holder) return { ...merged, focusedPaneId: holder.paneId };
  return {
    ...merged,
    panes: layout.panes.map((pane) => (pane.paneId === layout.focusedPaneId ? activeSessionId : pane.sessionId)),
    focusedPaneId: layout.focusedPaneId,
  };
}

/**
 * What `workspace.getState` hands out: fresh copies. The layout fields are left
 * out while the layout is exactly what the two rail fields would seed (one
 * pane, focus 0, default ratio), so single-pane readers see the v55 shape and
 * the renderer seeds the same layout back on hydrate.
 */
function workspaceStateView(workspace = {}) {
  const view = {
    activeSessionId: workspace.activeSessionId,
    openSessionIds: [...workspace.openSessionIds],
  };
  const layout = toPlainPaneLayout(normalizePaneLayout(workspace));
  const seeded = normalizeWorkspacePaneLayout({}, workspace.activeSessionId, workspace.openSessionIds, null);
  return JSON.stringify(layout) === JSON.stringify(seeded) ? view : { ...view, ...layout };
}

module.exports = {
  AUTO_APPROVE_STREAK_CAP_DEFAULT,
  AUTO_APPROVE_STREAK_CAP_MAX,
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
  mergeWorkspacePatch,
  normalizeAutoApproveStreakCap,
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
  workspaceStateView,
};
