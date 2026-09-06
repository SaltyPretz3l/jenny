const {
  DEFAULT_COMPANION_MODE,
  normalizeCompanionMode,
} = require('./companion-mode');
const { normalizeString } = require('./backend/path-utils');
const { normalizeRunMode } = require('./backend/session-preferences-patch');
const { normalizeFeatureOverrides } = require('./feature-flags');
const {
  DEFAULT_TOOL_SETTINGS,
  normalizeToolSettings,
} = require('./tool-config-schema');
const { DEFAULT_ASSISTANT_IDENTITY, DEFAULT_SETUP, DEFAULT_SETUP_STEPS, normalizeAssistantIdentity, normalizeSetupState, normalizeSetupStepStatus, normalizeSetupSteps } = require('./shell-config-setup-state');
const { WEB_SEARCH_PROVIDER_IDS, normalizeWebSearchSettings } = require('./shell-config-web-search');
const { normalizeCompactionTuning } = require('./shell-config-compaction-tuning');
const {
  cloneEngineTuning,
  harvestLegacyEngineTuning,
  normalizeEngineTuning,
  stripLegacyEngineTuningKeys,
} = require('./shell-config-engine-tuning');
const { isEngineTuningValueInRange } = require('../renderer/shared/engine-tuning-schema');
const {
  DEFAULT_OFFLINE_INTELLIGENCE,
  DEFAULT_LOCAL_ENGINES,
  DEFAULT_CODEX_CLI,
  normalizeOfflineIntelligence,
  normalizeVllmLaunchArgs,
  normalizeOpenAICompatibleSettings,
  normalizeLocalEngines,
  normalizePreferredEngineType,
  normalizeCodexCliModelId,
  normalizeCodexCliSettings,
} = require('./shell-config-engines');
const {
  CHAT_UI_ZOOM_DEFAULT,
  CHAT_UI_ZOOM_MIN,
  CHAT_UI_ZOOM_MAX,
  CHAT_UI_ZOOM_STEP,
  APP_ZOOM_DEFAULT,
  APP_ZOOM_MIN,
  APP_ZOOM_MAX,
  APP_ZOOM_STEP,
  normalizeChatUiZoomPercent,
  normalizeChatUiSettings,
  normalizeWindowUiZoomPercent,
  normalizeWindowUiSettings,
} = require('./shell-config-zoom-state');
const { DEFAULT_HOME, normalizeHomeConfig } = require('./home-config-schema');
const {
  DEFAULT_WORKSPACE_IDE,
  migrateWorkspaceIdeSplitDefault,
  normalizeWorkspaceIde,
  normalizeWorkspaceIdeRelativePath,
  normalizeWorkspaceIdeStore,
} = require('./workspace-ide-config-schema');
const { migrateWorkspaceIdeV36 } = require('./shell-config-workspace-ide-migration');
const {
  cloneModelTuning,
  normalizeModelTuning,
  normalizePendingLegacyStreamInactivitySeconds,
} = require('./shell-config-model-tuning');
const {
  RESOURCE_ALERT_THRESHOLD_DEFAULT,
  RESOURCE_ALERT_THRESHOLD_MIN,
  RESOURCE_ALERT_THRESHOLD_MAX,
  MAX_PROACTIVE_REMINDERS,
  MAX_PROACTIVE_REMINDER_LABEL_CHARS,
  MAX_PROACTIVE_REMINDER_PROMPT_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_REMINDER_SOURCE_ID_CHARS,
  REMINDER_SCHEDULE_TYPES,
  REMINDER_SOURCE_KINDS,
  FOLLOW_UP_STATUSES,
  FOLLOW_UP_DEFER_PRESETS,
  FOLLOW_UP_SOURCE_KINDS,
  FOLLOW_UP_HISTORY_KINDS,
  cloneJsonValue,
  createReminderId,
  normalizeWatcherGlobs,
  normalizeIsoString,
  normalizeFollowUpStatus,
  normalizeFollowUpDeferPreset,
  normalizeFollowUpSourceKind,
  normalizeFollowUpSourceMeta,
  normalizeFollowUpHistoryKind,
  normalizeFollowUpHistoryEntry,
  normalizeFollowUpHistory,
  normalizeResourceAlertThreshold,
  normalizeReminder,
  normalizeFollowUp,
  sortReminders,
} = require('./shell-config-followups-schema');
const CONFIG_VERSION = 51;
const WORKSPACE_WRITE_DELAY_MS = 500;
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
const DEFAULT_CHAT_UI = Object.freeze({
  zoomPercent: CHAT_UI_ZOOM_DEFAULT,
});
const DEFAULT_TELEMETRY = Object.freeze({
  crashReportingOptIn: false,
});
const DEFAULT_FEATURE_OVERRIDES = Object.freeze({});

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

function migrateState(value = {}, validWorkspaceSessionIds = null) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const parsedVersion = Number(source.version ?? 1);
  const version = Number.isSafeInteger(parsedVersion) && parsedVersion >= 1 ? parsedVersion : 1;
  const migrated = { ...source };
  if (version < 2) {
    migrated.offlineIntelligence = normalizeOfflineIntelligence(
      source.offlineIntelligence || source.offline_intelligence
    );
  }
  if (version < 3) {
    migrated.workspace = normalizeWorkspaceState(
      source.workspace || source.workspace_state,
      validWorkspaceSessionIds
    );
  }
  if (version < 4) {
    migrated.companion = normalizeCompanion(source.companion);
  }
  if (version < 5) {
    migrated.followUps = [];
  }
  if (version < 6) {
    migrated.skills = normalizeSkillSettings(source.skills);
    migrated.tips = normalizeTipsSettings(source.tips);
  }
  if (version < 7) {
    migrated.tools = normalizeToolsSettings(source.tools, source);
    migrated.featureOverrides = normalizeFeatureOverrides(
      source.featureOverrides || source.feature_overrides
    );
  }
  if (version < 10) {
    migrated.followUps = Array.isArray(source.followUps)
      ? source.followUps
        .map((followUp) => normalizeFollowUp(followUp))
        .filter((followUp) => followUp.id)
      : [];
  }
  if (version < 11) {
    migrated.followUps = Array.isArray(migrated.followUps)
      ? migrated.followUps
        .map((followUp) => normalizeFollowUp({
          ...followUp,
          archivedAt: '',
          history: [],
        }))
        .filter((followUp) => followUp.id)
      : [];
  }
  if (version < 12) {
    migrated.chatUi = normalizeChatUiSettings(source.chatUi || source.chat_ui, source);
  }
  if (version < 13) {
    // No downgrade path: older shells will re-run this migration on read, which is
    // idempotent because normalizeLocalEngines fills defaults for missing keys.
    migrated.localEngines = normalizeLocalEngines(source.localEngines || source.local_engines);
  }
  if (version < 14) {
    migrated.telemetry = normalizeTelemetrySettings(source.telemetry || source, source);
  }
  if (version < 15) {
    migrated.setup = normalizeSetupState(source.setup || source.onboarding);
    migrated.assistantIdentity = normalizeAssistantIdentity(
      source.assistantIdentity || source.assistant_identity
    );
  }
  if (version < 19) {
    migrated.codexCli = normalizeCodexCliSettings(source.codexCli || source.codex_cli);
  }
  if (version < 20) {
    // jen-e desktop overlay was removed in the lean-harness trim. Drop its
    // persisted config key without throwing on legacy payloads that still
    // carry it; unknown keys are otherwise ignored on read.
    delete migrated.jenE;
    delete migrated.jen_e;
  }
  if (version < 21) {
    // local_speech (STT/TTS) was removed in the lean-harness trim. Drop its
    // persisted config key without throwing on legacy payloads that still
    // carry it; unknown keys are otherwise ignored on read.
    delete migrated.speech;
  }
  if (version < 22) {
    // auto_dream (background memory consolidation) was removed in the
    // lean-harness trim. Drop its persisted feature override so legacy payloads
    // that still carry it do not resurface the toggle; normalizeFeatureOverrides
    // already filters unknown keys, this makes the removal explicit.
    if (migrated.featureOverrides && typeof migrated.featureOverrides === 'object') {
      delete migrated.featureOverrides.auto_dream;
    }
    if (migrated.feature_overrides && typeof migrated.feature_overrides === 'object') {
      delete migrated.feature_overrides.auto_dream;
    }
  }
  if (version < 23) {
    // Home dashboard config (link-tile groups + weather location).
    migrated.home = normalizeHomeConfig(source.home);
  }
  if (version < 24) {
    // Workspace IDE page UI state (open tabs, rail layout).
    migrated.workspaceIde = normalizeWorkspaceIde(source.workspaceIde || source.workspace_ide);
  }
  if (version < 25) {
    // Workspace IDE editor preferences (fontSize/tabSize/minimap/lineNumbers/
    // renderWhitespace/eol). Base off the already-migrated slice so a v24 payload
    // keeps its tabs/rail layout and only gains the new defaults; normalizeWorkspaceIde
    // is idempotent so re-normalizing is harmless.
    migrated.workspaceIde = normalizeWorkspaceIde(migrated.workspaceIde || source.workspaceIde || source.workspace_ide);
  }
  if (version < 26) {
    // Workspace IDE bottom panel: Terminal + Problems were re-homed out of the
    // rail into a collapsible bottom container, adding bottomPanelOpen/Height/
    // ActiveView and dropping 'terminal'/'problems' from the railPanel whitelist.
    // normalizeWorkspaceIde is idempotent and now omits those rail values, so a
    // single re-run BOTH fills the new defaults AND coerces a stale
    // railPanel:'terminal'/'problems' back to 'explorer'. Base off the already-
    // migrated slice so tabs + editor prefs survive the v24/v25 chain.
    migrated.workspaceIde = normalizeWorkspaceIde(migrated.workspaceIde || source.workspaceIde || source.workspace_ide);
  }
  if (version < 27) {
    // Workspace IDE secondary sidebar: a second static side container opposite
    // the primary rail, hosting one of the existing rail panels. Adds
    // secondaryPanelOpen/secondaryPanel/secondaryWidth. normalizeWorkspaceIde is
    // idempotent and now fills those defaults, so a single re-run off the
    // already-migrated slice keeps tabs/rail/editor/bottom-panel state intact.
    migrated.workspaceIde = normalizeWorkspaceIde(migrated.workspaceIde || source.workspaceIde || source.workspace_ide);
  }
  if (version < 28) {
    // Workspace IDE secondary sidebar moves from a second-instance "clone" model
    // to a single-instance per-panel LOCATION model (VSCode "Move View"): adds
    // panelLocations (id -> 'primary'|'secondary', all 'primary' by default).
    // No seeding from the old secondaryPanel/secondaryPanelOpen clone fields —
    // the feature was unpushed, a clone != a location, and a clean all-primary
    // default is least-surprising. normalizeWorkspaceIde is idempotent and now
    // fills the panelLocations default + cross-validates the active railPanel/
    // secondaryPanel against it, so one re-run off the already-migrated slice
    // keeps tabs/rail/editor/bottom-panel state intact.
    migrated.workspaceIde = normalizeWorkspaceIde(migrated.workspaceIde || source.workspaceIde || source.workspace_ide);
  }
  if (version < 29) {
    // Workspace IDE inline autocomplete (FIM ghost text): adds
    // inlineSuggestEnabled (default on, still gated by the default-on
    // workspace_inline_suggest flag), inlineSuggestModel (selected Ollama tag),
    // and inlineSuggestUseGpu (default off => CPU-pinned). normalizeWorkspaceIde
    // is idempotent and now fills those defaults, so one re-run off the
    // already-migrated slice keeps all prior IDE state intact.
    migrated.workspaceIde = normalizeWorkspaceIde(migrated.workspaceIde || source.workspaceIde || source.workspace_ide);
  }
  if (version < 30) {
    // Scratchpad goes from a single { text, updatedAt } blob to multiple named
    // notes (tabs). normalizeHomeConfig -> normalizeHomeScratchpad promotes a
    // legacy { text } into one seed note ("Note 1") and always emits >= 1 note,
    // so re-normalizing the already-migrated home slice BOTH seeds the new
    // multi-note shape AND leaves an already-v30 payload untouched. Base off
    // migrated.home (set at v23) so links/weather/widgets/calendar/focusMode
    // survive the chain.
    migrated.home = normalizeHomeConfig(migrated.home || source.home);
  }
  if (version < 31) {
    // Workspace IDE debounced auto-save adds `autoSaveEnabled` (DEFAULT-OFF —
    // this writes the user's files, so existing configs must NOT silently start
    // auto-writing; normalizeWorkspaceIde defaults a missing/non-true value to
    // false). normalizeWorkspaceIde is idempotent, so a single re-run off the
    // already-migrated slice fills the new default while keeping all prior IDE
    // state intact (the v24–v29 idiom).
    migrated.workspaceIde = normalizeWorkspaceIde(migrated.workspaceIde || source.workspaceIde || source.workspace_ide);
  }
  if (version < 32) {
    // Workspace IDE pinned tabs now persist across restart. Previously the
    // normalizer stripped `pinned` from each open tab (runtime-only); the
    // schema now passes it through. This migration is a pure re-normalize:
    // old configs simply have no pinned tabs, so there is nothing to backfill.
    // normalizeWorkspaceIde is idempotent, so a single re-run off the
    // already-migrated slice keeps all prior IDE state intact (the v24–v31 idiom).
    migrated.workspaceIde = normalizeWorkspaceIde(migrated.workspaceIde || source.workspaceIde || source.workspace_ide);
  }
  if (version < 33) {
    // Overall app zoom (Electron webContents.setZoomFactor) adds the windowUi
    // slice. Old configs have no windowUi, so normalizeWindowUiSettings fills
    // the 100% default — nothing to backfill.
    migrated.windowUi = normalizeWindowUiSettings(source.windowUi || source.window_ui, source);
  }
  if (version < 34) {
    // Workspace IDE editor column rulers (`rulers`, array of column ints, default
    // []) + save-time hygiene (`formatOnSave`/`trimTrailingWhitespace`/
    // `insertFinalNewline`, all DEFAULT-OFF). Old configs have none, so
    // normalizeWorkspaceIde defaults rulers to [] and the bools to false —
    // nothing to backfill. Idempotent re-run off the already-migrated slice keeps
    // prior IDE state intact (the v24–v33 idiom; normalizeState also re-normalizes
    // workspaceIde unconditionally on every read).
    migrated.workspaceIde = normalizeWorkspaceIde(migrated.workspaceIde || source.workspaceIde || source.workspace_ide);
  }
  if (version < 35) {
    // The default Workspace IDE rail layout split: Explorer + Search dock left
    // (primary rail), Jenny's Changes + Source Control dock right (secondary
    // sidebar, collapsed). Flip a slice still on the prior default; keep any
    // customized layout (detection + flip live in workspace-ide-config-schema.js).
    migrated.workspaceIde = migrateWorkspaceIdeSplitDefault(
      source.workspaceIde || source.workspace_ide,
      migrated.workspaceIde
    );
  }
  if (version < 36) {
    migrated.workspaceIde = migrateWorkspaceIdeV36(
      migrated.workspaceIde || source.workspaceIde || source.workspace_ide,
      migrated.toolsWorkspaceRoot || source.tools_workspace_root
    );
  }
  if (version < 37) migrated.workspaceIde = normalizeWorkspaceIdeStore(migrated.workspaceIde);
  if (version < 38) {
    const rawOldOverrides = source.featureOverrides || source.feature_overrides;
    const oldOverrideSource = rawOldOverrides && typeof rawOldOverrides === 'object'
      && !Array.isArray(rawOldOverrides) ? rawOldOverrides : {};
    const oldOverrides = normalizeFeatureOverrides(oldOverrideSource);
    migrated.workspaceIde = normalizeWorkspaceIdeStore(
      migrated.workspaceIde || source.workspaceIde || source.workspace_ide
    );
    if (oldOverrideSource.workspace_auto_save === false) {
      migrated.workspaceIde = {
        ...migrated.workspaceIde,
        preferences: {
          ...migrated.workspaceIde.preferences,
          autoSaveEnabled: false,
        },
      };
    }
    const nextOverrides = { ...oldOverrides };
    delete nextOverrides.workspace_auto_save;
    migrated.featureOverrides = nextOverrides;
    delete migrated.feature_overrides;
    migrated.modelTuning = normalizeModelTuning(
      source.modelTuning || source.model_tuning,
      normalizePendingLegacyStreamInactivitySeconds(
        source.chunkInactivitySeconds ?? source.chunk_inactivity_seconds
      )
    );
    delete migrated.chunkInactivitySeconds;
    delete migrated.chunk_inactivity_seconds;
    delete migrated.preserveThinking;
    delete migrated.preserve_thinking;
  }
  if (version < 39) {
    const rawOverrides = migrated.featureOverrides || source.featureOverrides || source.feature_overrides;
    const overrideSource = rawOverrides && typeof rawOverrides === 'object'
      && !Array.isArray(rawOverrides) ? rawOverrides : {};
    const nextOverrides = { ...overrideSource };
    delete nextOverrides.memory_extraction;
    delete nextOverrides.session_memory;
    delete nextOverrides.cron_scheduler;
    migrated.featureOverrides = normalizeFeatureOverrides(nextOverrides);
    delete migrated.feature_overrides;
  }
  if (version < 40) {
    const rawOverrides = migrated.featureOverrides || source.featureOverrides || source.feature_overrides;
    const overrideSource = rawOverrides && typeof rawOverrides === 'object'
      && !Array.isArray(rawOverrides) ? rawOverrides : {};
    const nextOverrides = { ...overrideSource };
    delete nextOverrides.cost_tracker;
    migrated.featureOverrides = normalizeFeatureOverrides(nextOverrides);
    delete migrated.feature_overrides;
  }
  if (version < 41) {
    migrated.memory = normalizeMemorySettings(source.memory);
  }
  if (version < 42) {
    const rawOverrides = migrated.featureOverrides || source.featureOverrides || source.feature_overrides;
    const overrideSource = rawOverrides && typeof rawOverrides === 'object'
      && !Array.isArray(rawOverrides) ? rawOverrides : {};
    const nextOverrides = { ...overrideSource };
    delete nextOverrides.prompt_cache;
    delete nextOverrides.tool_search;
    migrated.featureOverrides = normalizeFeatureOverrides(nextOverrides);
    delete migrated.feature_overrides;
  }
  if (version < 43) {
    // Generation profiles are additive and default-empty. The bounded
    // normalizer preserves every v42 stream-timeout entry while discarding any
    // malformed forward-written profile independently.
    migrated.modelTuning = normalizeModelTuning(
      migrated.modelTuning || source.modelTuning || source.model_tuning
    );
  }
  if (version < 44) {
    // Personal and project skill bodies are trust-bearing context. Historical
    // releases defaulted both scopes on, so a stored true cannot prove that
    // the owner opted in. Revoke those implicit grants once; bundled skills
    // remain enabled and either untrusted scope can be enabled explicitly.
    migrated.skills = {
      bundledEnabled: true,
      userEnabled: false,
      projectEnabled: false,
    };
  }
  if (version < 45) {
    // Contextual tips used to require two independent switches:
    // featureOverrides.tips_surface and tips.enabled. Preserve their effective
    // conjunction once, then retire both persisted controls in favor of the
    // single Home-owned showContextualTips preference.
    const rawHome = migrated.home || source.home;
    const homeSource = rawHome && typeof rawHome === 'object' && !Array.isArray(rawHome)
      ? rawHome
      : {};
    const rawTips = migrated.tips || source.tips;
    const tipsSource = rawTips && typeof rawTips === 'object' && !Array.isArray(rawTips)
      ? rawTips
      : {};
    const rawOverrides = migrated.featureOverrides || source.featureOverrides || source.feature_overrides;
    const overrideSource = rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)
      ? rawOverrides
      : {};
    const originalHome = source.home && typeof source.home === 'object' && !Array.isArray(source.home)
      ? source.home
      : {};
    const showContextualTips = Object.prototype.hasOwnProperty.call(originalHome, 'showContextualTips')
      ? originalHome.showContextualTips === true
      : source.version == null
        ? true
        : overrideSource.tips_surface === true && tipsSource.enabled !== false;
    migrated.home = normalizeHomeConfig({ ...homeSource, showContextualTips });
    migrated.tips = normalizeTipsSettings(tipsSource);
    const nextOverrides = { ...overrideSource };
    delete nextOverrides.tips_surface;
    migrated.featureOverrides = normalizeFeatureOverrides(nextOverrides);
    delete migrated.feature_overrides;
  }
  if (version < 46) {
    // Inline-completion compute placement is now selected from live engine and
    // resource evidence. Re-normalizing drops the retired inlineSuggestUseGpu
    // preference from both legacy flat and v37+ store shapes while preserving
    // every remaining global preference and root-scoped IDE state.
    migrated.workspaceIde = normalizeWorkspaceIdeStore(
      migrated.workspaceIde || source.workspaceIde || source.workspace_ide
    );
  }
  if (version < 47) {
    // Personality v3 retired the four canned profiles and the custom-text
    // overlay: the assistant identity is now the NAME only, and tone lives in
    // the user-owned PERSONALITY.md note. The personality-workspace v3
    // migration reads the retired `profile` / `customText` values from the
    // on-disk shell-config before this bump drops them, so no user text is
    // lost. Re-normalizing is what removes the keys; agentName is preserved.
    // The personality-workspace v3 migration is what carries any retired
    // customText into PERSONALITY.md; it snapshots shell-config.json at
    // service construction, before this bump can rewrite the file.
    migrated.assistantIdentity = normalizeAssistantIdentity(
      migrated.assistantIdentity || source.assistantIdentity || source.assistant_identity
    );
    delete migrated.assistant_identity;
  }
  if (version < 48) {
    // Move legacy flat tuning keys into the owned engineTuning block, then strip
    // the flats; forward-only like every block above.
    migrated.engineTuning = harvestLegacyEngineTuning(migrated, source);
    stripLegacyEngineTuningKeys(migrated);
  }
  if (version < 49) {
    migrated.defaultRunMode = normalizeRunMode(migrated.defaultRunMode);
  }
  if (version < 50) {
    // W7a retired browser/apply_patch; re-normalizing strips the nested
    // tools.browser/tools.applyPatch keys through the allowlist-shaped schema.
    delete migrated.tools_browser_enabled;
    delete migrated.toolsBrowserEnabled;
    delete migrated.tools_apply_patch_enabled;
    delete migrated.toolsApplyPatchEnabled;
  }
  if (version < 51) {
    migrated.skills = normalizeSkillSettings(migrated.skills || source.skills);
  }
  migrated.version = CONFIG_VERSION;
  return migrated;
}

function normalizeState(value = {}, options = {}) {
  const validWorkspaceSessionIds = normalizeValidWorkspaceSessionIds(
    options.validWorkspaceSessionIds
  );
  const source = migrateState(value, validWorkspaceSessionIds);
  const proactive = source.proactive && typeof source.proactive === 'object' && !Array.isArray(source.proactive)
    ? source.proactive
    : {};
  const reminders = Array.isArray(proactive.reminders) ? proactive.reminders : [];
  const tools = normalizeToolsSettings(source.tools, source);
  const chatUi = normalizeChatUiSettings(source.chatUi || source.chat_ui, source);
  const telemetry = normalizeTelemetrySettings(source.telemetry || source.telemetry_settings, source);
  const featureOverrides = normalizeFeatureOverrides(
    source.featureOverrides || source.feature_overrides
  );
  const setup = normalizeSetupState(source.setup || source.onboarding);
  const assistantIdentity = normalizeAssistantIdentity(
    source.assistantIdentity || source.assistant_identity
  );
  const codexCli = normalizeCodexCliSettings(source.codexCli || source.codex_cli);
  const engineTuning = normalizeEngineTuning(source.engineTuning || source.engine_tuning);
  // A caller that sets the mirrored top-level maxBudgetUsd (replaceState, or an
  // older config file) still has to end up writing to the one place the value is
  // stored. Absorb it only when the block has no opinion, so the block always wins.
  // The owned write paths (shell-config-engine-tuning.js) re-derive the mirror
  // from the block BEFORE handing the state here, so clearing the key in the
  // block cannot be undone by a stale mirror riding along on `...this.state`.
  if (!Object.prototype.hasOwnProperty.call(engineTuning, 'maxBudgetUsd')) {
    const legacyBudget = normalizeMaxBudgetUsd(source.maxBudgetUsd ?? source.max_budget_usd);
    if (legacyBudget != null) engineTuning.maxBudgetUsd = legacyBudget;
  }
  return {
    version: CONFIG_VERSION,
    toolsWorkspaceRoot: normalizeWorkspaceRoot(source.toolsWorkspaceRoot || source.tools_workspace_root),
    // maxBudgetUsd is stored in the owned engineTuning block like every other
    // tuning knob, but stays readable at the top level because callers (and the
    // managed-sidecar reader's legacy path) have always looked for it there.
    // Mirroring rather than dual-storing keeps a single write path: a reset that
    // clears the block clears this too, instead of resurrecting a stale value.
    maxBudgetUsd: normalizeMaxBudgetUsd(
      engineTuning.maxBudgetUsd ?? source.maxBudgetUsd ?? source.max_budget_usd
    ),
    modelTuning: normalizeModelTuning(source.modelTuning || source.model_tuning),
    engineTuning,
    compactionTuning: normalizeCompactionTuning(source.compactionTuning || source.compaction_tuning, source),
    tools,
    toolsWorktreeEnabled: tools.worktree === true,
    webSearch: normalizeWebSearchSettings(source.webSearch || source.web_search),
    chatUi,
    windowUi: normalizeWindowUiSettings(source.windowUi || source.window_ui, source),
    telemetry,
    featureOverrides,
    setup,
    assistantIdentity,
    offlineIntelligence: normalizeOfflineIntelligence(
      source.offlineIntelligence || source.offline_intelligence
    ),
    localEngines: normalizeLocalEngines(source.localEngines || source.local_engines),
    preferredEngineType: normalizePreferredEngineType(
      source.preferredEngineType ?? source.preferred_engine_type,
    ),
    defaultRunMode: normalizeRunMode(source.defaultRunMode),
    codexCli,
    companion: normalizeCompanion(source.companion),
    home: normalizeHomeConfig(source.home),
    skills: normalizeSkillSettings(source.skills),
    tips: normalizeTipsSettings(source.tips),
    memory: normalizeMemorySettings(source.memory),
    followUps: Array.isArray(source.followUps)
      ? source.followUps.map((followUp) => normalizeFollowUp(followUp)).filter((followUp) => followUp.id)
      : [],
    proactive: {
      reminders: sortReminders(reminders.map((reminder) => normalizeReminder(reminder))),
    },
    workspace: normalizeWorkspaceState(
      source.workspace || source.workspace_state,
      validWorkspaceSessionIds
    ),
    workspaceIde: normalizeWorkspaceIdeStore(source.workspaceIde || source.workspace_ide),
  };
}

function cloneState(state) {
  return {
    ...state,
    maxBudgetUsd: normalizeMaxBudgetUsd(state.maxBudgetUsd ?? state.max_budget_usd),
    modelTuning: cloneModelTuning(state.modelTuning),
    compactionTuning: normalizeCompactionTuning(state.compactionTuning),
    engineTuning: cloneEngineTuning(state.engineTuning),
    tools: {
      ...state.tools,
    },
    chatUi: {
      ...state.chatUi,
    },
    windowUi: {
      ...state.windowUi,
    },
    telemetry: {
      ...state.telemetry,
    },
    featureOverrides: cloneFeatureOverrides(state.featureOverrides),
    setup: {
      ...state.setup,
      steps: {
        ...state.setup.steps,
      },
    },
    assistantIdentity: {
      ...state.assistantIdentity,
    },
    offlineIntelligence: {
      ...state.offlineIntelligence,
    },
    localEngines: normalizeLocalEngines(state.localEngines),
    preferredEngineType: normalizePreferredEngineType(state.preferredEngineType),
    defaultRunMode: normalizeRunMode(state.defaultRunMode),
    codexCli: normalizeCodexCliSettings(state.codexCli || state.codex_cli),
    companion: {
      ...state.companion,
    },
    home: normalizeHomeConfig(state.home),
    skills: normalizeSkillSettings(state.skills),
    tips: {
      ...state.tips,
      historyByTipId: {
        ...state.tips.historyByTipId,
      },
    },
    memory: normalizeMemorySettings(state.memory),
    followUps: state.followUps.map((followUp) => ({
      ...followUp,
      sourceMeta: cloneJsonValue(
        followUp?.sourceMeta && typeof followUp.sourceMeta === 'object' && !Array.isArray(followUp.sourceMeta)
          ? followUp.sourceMeta
          : {}
      ),
      history: Array.isArray(followUp?.history)
        ? followUp.history.map((entry) => ({ ...entry }))
        : [],
    })),
    proactive: {
      reminders: state.proactive.reminders.map((reminder) => ({ ...reminder })),
    },
    workspace: {
      activeSessionId: state.workspace.activeSessionId,
      openSessionIds: [...state.workspace.openSessionIds],
    },
    workspaceIde: normalizeWorkspaceIdeStore(state.workspaceIde),
  };
}

function serializeState(state) {
  return {
    version: CONFIG_VERSION,
    toolsWorkspaceRoot: state.toolsWorkspaceRoot,
    modelTuning: cloneModelTuning(state.modelTuning),
    compactionTuning: normalizeCompactionTuning(state.compactionTuning),
    engineTuning: cloneEngineTuning(state.engineTuning),
    tools: normalizeToolsSettings(state.tools, state),
    webSearch: normalizeWebSearchSettings(state.webSearch),
    chatUi: normalizeChatUiSettings(state.chatUi, state),
    windowUi: normalizeWindowUiSettings(state.windowUi, state),
    telemetry: normalizeTelemetrySettings(state.telemetry, state),
    featureOverrides: cloneFeatureOverrides(state.featureOverrides),
    setup: normalizeSetupState(state.setup),
    assistantIdentity: normalizeAssistantIdentity(state.assistantIdentity),
    offlineIntelligence: {
      ...state.offlineIntelligence,
    },
    localEngines: normalizeLocalEngines(state.localEngines),
    preferredEngineType: normalizePreferredEngineType(state.preferredEngineType),
    defaultRunMode: normalizeRunMode(state.defaultRunMode),
    codexCli: normalizeCodexCliSettings(state.codexCli || state.codex_cli),
    companion: {
      ...state.companion,
    },
    home: normalizeHomeConfig(state.home),
    skills: normalizeSkillSettings(state.skills),
    tips: {
      ...state.tips,
      historyByTipId: {
        ...state.tips.historyByTipId,
      },
    },
    memory: normalizeMemorySettings(state.memory),
    followUps: state.followUps.map((followUp) => ({
      ...followUp,
      sourceMeta: cloneJsonValue(
        followUp?.sourceMeta && typeof followUp.sourceMeta === 'object' && !Array.isArray(followUp.sourceMeta)
          ? followUp.sourceMeta
          : {}
      ),
      history: Array.isArray(followUp?.history)
        ? followUp.history.map((entry) => ({ ...entry }))
        : [],
    })),
    proactive: {
      reminders: state.proactive.reminders.map((reminder) => ({ ...reminder })),
    },
    workspace: {
      activeSessionId: state.workspace.activeSessionId,
      openSessionIds: [...state.workspace.openSessionIds],
    },
    workspaceIde: normalizeWorkspaceIdeStore(state.workspaceIde || state.workspace_ide),
  };
}
module.exports = {
  CONFIG_VERSION,
  CHAT_UI_ZOOM_DEFAULT,
  CHAT_UI_ZOOM_MAX,
  CHAT_UI_ZOOM_MIN,
  CHAT_UI_ZOOM_STEP,
  APP_ZOOM_DEFAULT,
  APP_ZOOM_MAX,
  APP_ZOOM_MIN,
  APP_ZOOM_STEP,
  DEFAULT_CHAT_UI,
  DEFAULT_CODEX_CLI,
  DEFAULT_COMPANION,
  DEFAULT_ASSISTANT_IDENTITY,
  DEFAULT_FEATURE_OVERRIDES,
  DEFAULT_HOME,
  DEFAULT_LOCAL_ENGINES,
  DEFAULT_MEMORY,
  DEFAULT_OFFLINE_INTELLIGENCE,
  DEFAULT_SETUP,
  DEFAULT_SETUP_STEPS,
  DEFAULT_SKILLS,
  DEFAULT_TELEMETRY,
  DEFAULT_TIPS,
  DEFAULT_TOOLS,
  DEFAULT_WORKSPACE_IDE,
  DEFAULT_WORKSPACE_STATE,
  FOLLOW_UP_DEFER_PRESETS,
  FOLLOW_UP_HISTORY_KINDS,
  FOLLOW_UP_SOURCE_KINDS,
  FOLLOW_UP_STATUSES,
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
  MAX_PROACTIVE_REMINDER_LABEL_CHARS,
  MAX_PROACTIVE_REMINDER_PROMPT_CHARS,
  MAX_PROACTIVE_REMINDERS,
  MAX_REMINDER_SOURCE_ID_CHARS,
  REMINDER_SCHEDULE_TYPES,
  REMINDER_SOURCE_KINDS,
  RESOURCE_ALERT_THRESHOLD_DEFAULT,
  RESOURCE_ALERT_THRESHOLD_MAX,
  RESOURCE_ALERT_THRESHOLD_MIN,
  WORKSPACE_WRITE_DELAY_MS,
  cloneState,
  createReminderId,
  normalizeChatUiSettings,
  normalizeChatUiZoomPercent,
  normalizeWindowUiSettings,
  normalizeWindowUiZoomPercent,
  normalizeCodexCliModelId,
  normalizeCodexCliSettings,
  normalizeCompanion,
  normalizeCompanionMode,
  isToolsWorktreeEnabled,
  normalizeFollowUpDeferPreset,
  normalizeFollowUpHistory,
  normalizeFollowUpHistoryEntry,
  normalizeFollowUpHistoryKind,
  normalizeFollowUpSourceKind,
  normalizeFollowUpSourceMeta,
  normalizeFollowUpStatus,
  normalizeFeatureOverrides,
  normalizeFollowUp,
  normalizeHomeConfig,
  normalizeLocalEngines,
  normalizeMemorySettings,
  normalizeOfflineIntelligence,
  normalizeOpenAICompatibleSettings,
  normalizePreferredEngineType,
  normalizeRunMode,
  normalizeAssistantIdentity,
  normalizeResourceAlertThreshold,
  normalizeSetupState,
  normalizeSetupStepStatus,
  normalizeSetupSteps,
  normalizeVllmLaunchArgs,
  normalizeReminder,
  normalizeSkillSettings,
  normalizeTelemetrySettings,
  normalizeState,
  normalizeTipsSettings,
  normalizeToolsSettings,
  normalizeWebSearchSettings,
  WEB_SEARCH_PROVIDER_IDS,
  normalizeWatcherGlobs,
  normalizeWorkspaceIde,
  normalizeWorkspaceIdeRelativePath,
  normalizeWorkspaceRoot,
  normalizeWorkspaceState,
  normalizeValidWorkspaceSessionIds,
  normalizeIsoString,
  serializeState,
  sortReminders,
};
