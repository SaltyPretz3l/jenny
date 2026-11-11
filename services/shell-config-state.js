const {
  normalizeCompanionMode,
} = require('./companion-mode');
const { normalizeRunMode } = require('./backend/session-preferences-patch');
const { normalizeFeatureOverrides } = require('./feature-flags');
const {
  AUTO_APPROVE_STREAK_CAP_DEFAULT,
  AUTO_APPROVE_STREAK_CAP_MAX,
  DEFAULT_COMPANION,
  DEFAULT_FEATURE_OVERRIDES,
  DEFAULT_MEMORY,
  DEFAULT_SKILLS,
  DEFAULT_TELEMETRY,
  DEFAULT_TOOLS,
  DEFAULT_WORKSPACE_STATE,
  SAFETY_MODES,
  UI_LANGUAGE_TAGS,
  UNATTENDED_GUARD_MINUTES_DEFAULT,
  UNATTENDED_GUARD_MINUTES_MAX,
  cloneFeatureOverrides,
  isToolsWorktreeEnabled,
  normalizeAutoApproveStreakCap,
  normalizeCompanion,
  normalizeMaxBudgetUsd,
  normalizeMemorySettings,
  normalizeSkillSettings,
  normalizeTelemetrySettings,
  normalizeToolsSettings,
  normalizeSafetyMode,
  normalizeUiLanguage,
  normalizeUnattendedGuardMinutes,
  normalizeDigestQuietStart,
  normalizeDigestQuietEnd,
  normalizeValidWorkspaceSessionIds,
  normalizeWorkspaceRoot,
  normalizeWorkspaceState,
} = require('./shell-config-normalizers');
const { DEFAULT_ASSISTANT_IDENTITY, DEFAULT_SETUP, DEFAULT_SETUP_STEPS, normalizeAssistantIdentity, normalizeSetupState, normalizeSetupStepStatus, normalizeSetupSteps } = require('./shell-config-setup-state');
const { WEB_SEARCH_PROVIDER_IDS, normalizeWebSearchSettings } = require('./shell-config-web-search');
const { normalizeCompactionTuning } = require('./shell-config-compaction-tuning');
const {
  cloneEngineTuning,
  normalizeEngineTuning,
} = require('./shell-config-engine-tuning');
const {
  DEFAULT_OFFLINE_INTELLIGENCE,
  DEFAULT_LOCAL_ENGINES,
  DEFAULT_CODEX_CLI,
  normalizeOfflineIntelligence,
  normalizeVllmLaunchArgs,
  normalizeOpenAICompatibleSettings,
  normalizeLocalEngines,
  normalizePreferredEngineType,
  normalizeLastChatgptModel,
  normalizeChatgptModelsEnabled,
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
  normalizeWorkspaceIde,
  normalizeWorkspaceIdeRelativePath,
  normalizeWorkspaceIdeStore,
} = require('./workspace-ide-config-schema');
const {
  cloneModelTuning,
  normalizeModelTuning,
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
const { normalizeCommandSandbox } = require('./shell-config-command-sandbox');
const { normalizeSessionRuntime } = require('./shell-config-session-runtime');
const { normalizePerformanceTelemetry } = require('./shell-config-performance');
const { normalizePrimaryChat } = require('./shell-config-primary-chat');
const { normalizeApiProvidersConfig } = require('./backend/api-provider-config');
const { normalizeSubagentRouting } = require('./subagent-routing-settings');
const { CONFIG_VERSION, migrateState } = require('./shell-config-migrations');
const WORKSPACE_WRITE_DELAY_MS = 500;
const DEFAULT_CHAT_UI = Object.freeze({
  zoomPercent: CHAT_UI_ZOOM_DEFAULT,
});

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
    commandSandbox: normalizeCommandSandbox(source.commandSandbox),
    sessionRuntime: normalizeSessionRuntime(source.sessionRuntime || source.session_runtime),
    // Additive (row 59 cp6): no CONFIG_VERSION bump; a newer nested schema survives untouched.
    performanceTelemetry: normalizePerformanceTelemetry(source.performanceTelemetry),
    primaryChat: normalizePrimaryChat(source.primaryChat), // row 76: additive, no version bump
    apiProviders: normalizeApiProvidersConfig(source.apiProviders), // row 78: additive, no version bump
    subagentRouting: normalizeSubagentRouting(source.subagentRouting),
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
    // Additive optional field with a safe default: no CONFIG_VERSION bump.
    lastChatgptModel: normalizeLastChatgptModel(source.lastChatgptModel),
    chatgptModelsEnabled: normalizeChatgptModelsEnabled(source.chatgptModelsEnabled),
    defaultRunMode: normalizeRunMode(source.defaultRunMode),
    browserOnInNewChats: source.browserOnInNewChats === true,
    uiLanguage: normalizeUiLanguage(source.uiLanguage),
    use24HourTime: source.use24HourTime === true,
    safetyMode: normalizeSafetyMode(source.safetyMode),
    autoApproveStreakCap: normalizeAutoApproveStreakCap(source.autoApproveStreakCap),
    unattendedGuardMinutes: normalizeUnattendedGuardMinutes(source.unattendedGuardMinutes),
    // Row 86: additive with safe defaults, no CONFIG_VERSION bump.
    digestQuietStart: normalizeDigestQuietStart(source.digestQuietStart),
    digestQuietEnd: normalizeDigestQuietEnd(source.digestQuietEnd),
    codexCli,
    companion: normalizeCompanion(source.companion),
    home: normalizeHomeConfig(source.home),
    skills: normalizeSkillSettings(source.skills),
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
    sessionRuntime: normalizeSessionRuntime(state.sessionRuntime),
    performanceTelemetry: normalizePerformanceTelemetry(state.performanceTelemetry),
    primaryChat: normalizePrimaryChat(state.primaryChat),
    apiProviders: normalizeApiProvidersConfig(state.apiProviders),
    subagentRouting: normalizeSubagentRouting(state.subagentRouting),
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
    lastChatgptModel: normalizeLastChatgptModel(state.lastChatgptModel),
    chatgptModelsEnabled: normalizeChatgptModelsEnabled(state.chatgptModelsEnabled),
    defaultRunMode: normalizeRunMode(state.defaultRunMode),
    browserOnInNewChats: state.browserOnInNewChats === true,
    uiLanguage: normalizeUiLanguage(state.uiLanguage),
    use24HourTime: state.use24HourTime === true,
    safetyMode: normalizeSafetyMode(state.safetyMode),
    autoApproveStreakCap: normalizeAutoApproveStreakCap(state.autoApproveStreakCap),
    unattendedGuardMinutes: normalizeUnattendedGuardMinutes(state.unattendedGuardMinutes),
    digestQuietStart: normalizeDigestQuietStart(state.digestQuietStart),
    digestQuietEnd: normalizeDigestQuietEnd(state.digestQuietEnd),
    codexCli: normalizeCodexCliSettings(state.codexCli || state.codex_cli),
    companion: {
      ...state.companion,
    },
    home: normalizeHomeConfig(state.home),
    skills: normalizeSkillSettings(state.skills),
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
      panes: state.workspace.panes.map(({ paneId, sessionId }) => ({ paneId, sessionId })),
      focusedPaneId: state.workspace.focusedPaneId,
      splitRatio: state.workspace.splitRatio,
    },
    workspaceIde: normalizeWorkspaceIdeStore(state.workspaceIde),
  };
}

function serializeState(state) {
  return {
    version: CONFIG_VERSION,
    commandSandbox: normalizeCommandSandbox(state.commandSandbox),
    session_runtime: normalizeSessionRuntime(state.sessionRuntime),
    performanceTelemetry: normalizePerformanceTelemetry(state.performanceTelemetry),
    primaryChat: normalizePrimaryChat(state.primaryChat),
    apiProviders: normalizeApiProvidersConfig(state.apiProviders),
    subagentRouting: normalizeSubagentRouting(state.subagentRouting),
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
    lastChatgptModel: normalizeLastChatgptModel(state.lastChatgptModel),
    chatgptModelsEnabled: normalizeChatgptModelsEnabled(state.chatgptModelsEnabled),
    defaultRunMode: normalizeRunMode(state.defaultRunMode),
    browserOnInNewChats: state.browserOnInNewChats === true,
    uiLanguage: normalizeUiLanguage(state.uiLanguage),
    use24HourTime: state.use24HourTime === true,
    safetyMode: normalizeSafetyMode(state.safetyMode),
    autoApproveStreakCap: normalizeAutoApproveStreakCap(state.autoApproveStreakCap),
    unattendedGuardMinutes: normalizeUnattendedGuardMinutes(state.unattendedGuardMinutes),
    digestQuietStart: normalizeDigestQuietStart(state.digestQuietStart),
    digestQuietEnd: normalizeDigestQuietEnd(state.digestQuietEnd),
    codexCli: normalizeCodexCliSettings(state.codexCli || state.codex_cli),
    companion: {
      ...state.companion,
    },
    home: normalizeHomeConfig(state.home),
    skills: normalizeSkillSettings(state.skills),
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
      panes: state.workspace.panes.map(({ paneId, sessionId }) => ({ paneId, sessionId })),
      focusedPaneId: state.workspace.focusedPaneId,
      splitRatio: state.workspace.splitRatio,
    },
    workspaceIde: normalizeWorkspaceIdeStore(state.workspaceIde || state.workspace_ide),
  };
}
module.exports = {
  AUTO_APPROVE_STREAK_CAP_DEFAULT,
  AUTO_APPROVE_STREAK_CAP_MAX,
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
  DEFAULT_TOOLS,
  DEFAULT_WORKSPACE_IDE,
  DEFAULT_WORKSPACE_STATE,
  SAFETY_MODES,
  UI_LANGUAGE_TAGS,
  UNATTENDED_GUARD_MINUTES_DEFAULT,
  UNATTENDED_GUARD_MINUTES_MAX,
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
  normalizeToolsSettings,
  normalizeAutoApproveStreakCap,
  normalizeSafetyMode,
  normalizeUiLanguage,
  normalizeUnattendedGuardMinutes,
  normalizeDigestQuietStart,
  normalizeDigestQuietEnd,
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
