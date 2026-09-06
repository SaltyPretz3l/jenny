const path = require('path');
const { EventEmitter } = require('events');
const { FileJsonStore } = require('./backend/file-json-store');
const { normalizeString } = require('./backend/path-utils');
const {
  logNewerSchemaDetected,
  logWriteFailed,
  safeEmitLog,
} = require('./backend/session-store-logging');
const { FEATURE_OVERRIDE_KEYS, TOOL_SETTING_KEYS } = require('./feature-flags');
const { normalizeLocalEngines } = require('./shell-config-engines');
const {
  CONFIG_VERSION,
  DEFAULT_CHAT_UI,
  DEFAULT_CODEX_CLI,
  DEFAULT_COMPANION,
  DEFAULT_ASSISTANT_IDENTITY,
  DEFAULT_FEATURE_OVERRIDES,
  DEFAULT_MEMORY,
  DEFAULT_OFFLINE_INTELLIGENCE,
  DEFAULT_SETUP,
  DEFAULT_SKILLS,
  DEFAULT_TELEMETRY,
  DEFAULT_TIPS,
  DEFAULT_TOOLS,
  DEFAULT_WORKSPACE_STATE,
  FOLLOW_UP_DEFER_PRESETS,
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
  WORKSPACE_WRITE_DELAY_MS,
  cloneState,
  normalizeChatUiSettings,
  normalizeWindowUiSettings,
  normalizeAssistantIdentity,
  normalizeCodexCliSettings,
  normalizeCompanion,
  normalizeCompanionMode,
  normalizeFollowUp,
  normalizeHomeConfig,
  normalizeMemorySettings,
  normalizeOfflineIntelligence,
  normalizePreferredEngineType,
  normalizeRunMode,
  normalizeSetupState,
  normalizeReminder,
  normalizeSkillSettings,
  normalizeTelemetrySettings,
  normalizeState,
  normalizeTipsSettings,
  normalizeToolsSettings,
  normalizeValidWorkspaceSessionIds,
  normalizeWebSearchSettings,
  normalizeWatcherGlobs,
  normalizeWorkspaceRoot,
  normalizeWorkspaceState,
  serializeState,
} = require('./shell-config-state');
const { normalizeFeatureOverrides } = require('./feature-flags');
const {
  calculateDeferredUntilForPreset,
  cloneNow,
  getAvailableFollowUpDeferPresets: listAvailableFollowUpDeferPresets,
} = require('./shell-config-followups');
const { followUpActionMethods } = require('./shell-config-followup-actions');
const { proactiveActionMethods } = require('./shell-config-proactive-actions');
const {
  createWorkspaceRootStatusController,
  workspaceRootMethods,
} = require('./shell-config-workspace-root');
const { workspaceIdeMethods } = require('./shell-config-workspace-ide');
const { modelTuningMethods } = require('./shell-config-model-tuning');
const { engineTuningMethods } = require('./shell-config-engine-tuning');
const { collectWorkspaceIdeDropCounts } = require('./shell-config-workspace-ide-migration');
const {
  normalizeContextLength,
  normalizeRatio: normalizeCompactionRatio,
  normalizeCompactionTuning,
} = require('./shell-config-compaction-tuning');
const getAvailableFollowUpDeferPresets = (now = new Date(), scheduleOptions = {}) =>
  listAvailableFollowUpDeferPresets(now, FOLLOW_UP_DEFER_PRESETS, scheduleOptions);

function cloneSetupState(setup) {
  return {
    ...setup,
    steps: {
      ...setup.steps,
    },
  };
}

function cloneAssistantIdentity(identity) {
  return {
    ...identity,
  };
}

function normalizeConfigVersion(value) {
  const version = Number(value ?? 1);
  return Number.isSafeInteger(version) && version >= 1 ? version : 1;
}

class ShellConfigService extends EventEmitter {
  constructor({
    userDataPath,
    env = process.env,
    getValidWorkspaceSessionIds = null,
    logger = null,
    nowProvider = null,
    resourcesPath = process.resourcesPath,
    workspaceWriteDelayMs = WORKSPACE_WRITE_DELAY_MS,
    workspaceWriteRetryLimit = 3,
    workspaceWriteRetryMaxDelayMs = 4_000,
    workspaceRootStatusOptions = null,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {}) {
    super();
    if (!userDataPath) {
      throw new Error('userDataPath is required for ShellConfigService.');
    }
    this._logger = typeof logger === 'function' ? logger : null;
    this.store = new FileJsonStore(path.join(userDataPath, 'shell-config.json'), {
      logger: this._logger,
    });
    this.env = env;
    this._getValidWorkspaceSessionIds =
      typeof getValidWorkspaceSessionIds === 'function' ? getValidWorkspaceSessionIds : null;
    this._nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
    this.resourcesPath = String(resourcesPath || '').trim();
    this._workspaceWriteDelayMs =
      Math.max(0, Number(workspaceWriteDelayMs) || WORKSPACE_WRITE_DELAY_MS);
    this._workspaceWriteTimer = null;
    this._workspaceWriteDirty = false;
    this._workspaceWriteRetryCount = 0;
    this._workspaceWriteRetryLimit = Math.max(0, Math.trunc(workspaceWriteRetryLimit));
    this._workspaceWriteRetryMaxDelayMs = Math.max(
      this._workspaceWriteDelayMs,
      Math.trunc(workspaceWriteRetryMaxDelayMs) || 4_000
    );
    this._workspaceWriteRevision = 0;
    this._setTimeout = setTimeoutImpl;
    this._clearTimeout = clearTimeoutImpl;
    this._newerConfigVersion = 0;
    this._blockedConfigWriteLoggedForVersion = 0;
    const initialRawState = this.store.read({});
    const initialVersion = normalizeConfigVersion(initialRawState?.version);
    const workspaceIdeDropCounts = collectWorkspaceIdeDropCounts(
      initialRawState?.workspaceIde || initialRawState?.workspace_ide,
      initialRawState?.toolsWorkspaceRoot || initialRawState?.tools_workspace_root
    );
    if (Object.keys(workspaceIdeDropCounts).length) {
      safeEmitLog(this._logger, 'WARN', 'shell_config.workspace_ide_entries_dropped', {
        counts: workspaceIdeDropCounts,
      });
    }
    this.state = this._normalizeState(initialRawState);
    const rootStatusOptions = workspaceRootStatusOptions && typeof workspaceRootStatusOptions === 'object'
      ? workspaceRootStatusOptions
      : {};
    this._workspaceRootStatusController = createWorkspaceRootStatusController({
      ...rootStatusOptions,
      setTimeoutImpl: rootStatusOptions.setTimeoutImpl || setTimeoutImpl,
      clearTimeoutImpl: rootStatusOptions.clearTimeoutImpl || clearTimeoutImpl,
      logger: rootStatusOptions.logger || this._logger,
      onChange: () => this.emit('changed', this.getState(), { reason: 'workspace_root_status_updated' }),
    });
    if (initialVersion > CONFIG_VERSION) {
      this._newerConfigVersion = initialVersion;
      this._logNewerConfigVersion('shell_config.newer_schema_detected');
    }
    this._seedWorkspaceRootFromEnvOnce();
  }

  _resolveValidWorkspaceSessionIds() {
    if (typeof this._getValidWorkspaceSessionIds !== 'function') {
      return null;
    }
    try {
      return normalizeValidWorkspaceSessionIds(this._getValidWorkspaceSessionIds());
    } catch (_error) {
      return null;
    }
  }

  _normalizeState(value) {
    return normalizeState(value, {
      validWorkspaceSessionIds: this._resolveValidWorkspaceSessionIds(),
    });
  }

  _clearPendingWorkspaceTimer() {
    if (this._workspaceWriteTimer) {
      this._clearTimeout(this._workspaceWriteTimer);
      this._workspaceWriteTimer = null;
    }
  }

  _logNewerConfigVersion(event) {
    logNewerSchemaDetected(
      this._logger,
      event,
      this.store.filePath,
      this._newerConfigVersion,
      CONFIG_VERSION
    );
  }

  _hasNewerConfigVersion() {
    return this._newerConfigVersion > CONFIG_VERSION;
  }

  _shouldBlockConfigWrite() {
    if (!this._hasNewerConfigVersion()) {
      return false;
    }
    if (this._blockedConfigWriteLoggedForVersion !== this._newerConfigVersion) {
      this._blockedConfigWriteLoggedForVersion = this._newerConfigVersion;
      this._logNewerConfigVersion('shell_config.newer_schema_write_blocked');
    }
    return true;
  }

  _persistState(value, writeFailedEvent = 'shell_config.write_failed') {
    if (this._shouldBlockConfigWrite()) {
      return false;
    }
    try {
      this.store.write(serializeState(value));
    } catch (error) {
      logWriteFailed(this._logger, writeFailedEvent, this.store.filePath, error);
      throw error;
    }
    this._workspaceWriteDirty = false;
    return true;
  }

  _scheduleWorkspaceWrite({ retry = false } = {}) {
    this._clearPendingWorkspaceTimer();
    if (!retry) {
      this._workspaceWriteRetryCount = 0;
      this._workspaceWriteRevision += 1;
    }
    const revision = this._workspaceWriteRevision;
    const retryDelay = this._workspaceWriteDelayMs * (2 ** this._workspaceWriteRetryCount);
    const delay = Math.min(this._workspaceWriteRetryMaxDelayMs, retryDelay);
    this._workspaceWriteTimer = this._setTimeout(() => {
      this._workspaceWriteTimer = null;
      if (!this._workspaceWriteDirty || revision !== this._workspaceWriteRevision) {
        return;
      }
      try {
        if (!this._persistState(this.state, 'shell_config.workspace_write_failed')) {
          this._workspaceWriteDirty = true;
          return;
        }
        this._workspaceWriteRetryCount = 0;
      } catch (_error) {
        this._workspaceWriteDirty = true;
        if (this._workspaceWriteRetryCount < this._workspaceWriteRetryLimit) {
          this._workspaceWriteRetryCount += 1;
          this._scheduleWorkspaceWrite({ retry: true });
          return;
        }
        safeEmitLog(this._logger, 'WARN', 'shell_config.workspace_write_retry_exhausted', {
          attempts: this._workspaceWriteRetryCount + 1,
        });
      }
    }, delay);
    if (typeof this._workspaceWriteTimer?.unref === 'function') {
      this._workspaceWriteTimer.unref();
    }
  }

  _commitState(nextState, reason, details = {}) {
    const normalized = this._normalizeState(nextState);
    if (!this._persistState(normalized)) {
      return { persisted: false, snapshot: this.getState() };
    }
    this._clearPendingWorkspaceTimer();
    this._workspaceWriteRetryCount = 0;
    this.state = normalized;
    const snapshot = this.getState();
    this.emit('changed', snapshot, {
      reason: normalizeString(reason) || 'updated',
      ...details,
    });
    return { persisted: true, snapshot };
  }

  _writeState(nextState, reason, details = {}) {
    return this._commitState(nextState, reason, details).snapshot;
  }

  _getNow() {
    return cloneNow(this._nowProvider);
  }

  getState() {
    return cloneState(this.state);
  }

  getWorkspaceState() {
    return {
      activeSessionId: this.state.workspace.activeSessionId,
      openSessionIds: [...this.state.workspace.openSessionIds],
    };
  }

  getChatUiState() {
    return {
      ...this.state.chatUi,
      defaultRunMode: normalizeRunMode(this.state.defaultRunMode),
    };
  }

  getWindowUiState() {
    return {
      ...this.state.windowUi,
    };
  }

  getHomeConfig() {
    return normalizeHomeConfig(this.state.home);
  }

  updateHomeConfig(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const current = normalizeHomeConfig(this.state.home);
    // Object-valued home sections merge shallowly so a partial patch (e.g.
    // {scratchpad:{text}} or {widgets:{hidden}}) keeps its sibling fields. Every
    // object-valued key of the home config MUST be listed here: the merge is
    // one level deep, so an unlisted section is overwritten wholesale by the
    // patch instead of merged, silently dropping its untouched fields.
    const mergeHomeSection = (key) => [key, {
      ...current[key],
      ...(source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        ? source[key]
        : {}),
    }];
    const nextHome = normalizeHomeConfig({
      ...current,
      ...source,
      ...Object.fromEntries(['weather', 'widgets', 'scratchpad', 'calendar', 'layout'].map(mergeHomeSection)),
    });
    if (JSON.stringify(nextHome) === JSON.stringify(current)) {
      return this.getHomeConfig();
    }
    const committed = this._commitState(
      {
        ...this.state,
        home: nextHome,
      },
      'home_config_updated'
    );
    if (!committed.persisted) {
      throw Object.assign(new Error('Home preferences could not be persisted.'), { code: 'home_config_write_failed' });
    }
    return committed.snapshot.home;
  }

  getSetupState() {
    return cloneSetupState(this.state.setup);
  }

  getAssistantIdentity() {
    return cloneAssistantIdentity(this.state.assistantIdentity);
  }

  replaceState(nextState, reason = 'state_replaced') {
    return this._writeState(nextState, reason);
  }

  updateSetupState(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const nowIso = this._getNow().toISOString();
    const nextSetup = normalizeSetupState({
      ...this.state.setup,
      ...source,
      updatedAt: normalizeString(source.updatedAt ?? source.updated_at) || nowIso,
      steps: {
        ...this.state.setup.steps,
        ...(source.steps && typeof source.steps === 'object' && !Array.isArray(source.steps)
          ? source.steps
          : {}),
      },
    });
    if (JSON.stringify(nextSetup) === JSON.stringify(this.state.setup)) {
      return this.getSetupState();
    }
    const snapshot = this._writeState(
      {
        ...this.state,
        setup: nextSetup,
      },
      'setup_state_updated'
    );
    return cloneSetupState(snapshot.setup);
  }

  markSetupComplete() {
    const nowIso = this._getNow().toISOString();
    const snapshot = this._writeState(
      {
        ...this.state,
        setup: normalizeSetupState({
          ...this.state.setup,
          seen: true,
          setupComplete: true,
          completedAt: nowIso,
          updatedAt: nowIso,
        }),
      },
      'setup_completed'
    );
    return cloneSetupState(snapshot.setup);
  }

  resetSetupState() {
    const nowIso = this._getNow().toISOString();
    const snapshot = this._writeState(
      {
        ...this.state,
        setup: normalizeSetupState({
          updatedAt: nowIso,
        }),
      },
      'setup_reset'
    );
    return cloneSetupState(snapshot.setup);
  }

  updateAssistantIdentity(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const nowIso = this._getNow().toISOString();
    const nextIdentity = normalizeAssistantIdentity({
      ...this.state.assistantIdentity,
      ...source,
      updatedAt: normalizeString(source.updatedAt ?? source.updated_at) || nowIso,
    });
    if (JSON.stringify(nextIdentity) === JSON.stringify(this.state.assistantIdentity)) {
      return this.getAssistantIdentity();
    }
    const committed = this._commitState(
      {
        ...this.state,
        assistantIdentity: nextIdentity,
      },
      'assistant_identity_updated'
    );
    if (!committed.persisted) {
      throw Object.assign(new Error('Assistant identity could not be persisted.'), { code: 'assistant_identity_write_failed' });
    }
    return cloneAssistantIdentity(committed.snapshot.assistantIdentity);
  }

  resetOnboarding() {
    const nowIso = this._getNow().toISOString();
    const nextSetup = normalizeSetupState({ updatedAt: nowIso });
    const nextIdentity = normalizeAssistantIdentity({
      ...DEFAULT_ASSISTANT_IDENTITY,
      updatedAt: nowIso,
    });
    const committed = this._commitState(
      {
        ...this.state,
        setup: nextSetup,
        assistantIdentity: nextIdentity,
      },
      'onboarding_reset'
    );
    if (!committed.persisted) {
      const error = new Error('Onboarding reset could not be persisted.');
      error.code = 'onboarding_reset_write_failed';
      throw error;
    }
    const { snapshot } = committed;
    return {
      setup: cloneSetupState(snapshot.setup),
      assistantIdentity: cloneAssistantIdentity(snapshot.assistantIdentity),
    };
  }

  setCompanionMode(mode) {
    const normalizedMode = normalizeCompanionMode(mode);
    if (normalizedMode === this.state.companion.mode) {
      return this.getState();
    }
    return this._writeState(
      {
        ...this.state,
        companion: {
          mode: normalizedMode,
        },
      },
      'companion_mode_updated'
    );
  }

  // Per-model Ollama context window and auto-compact ratio, plus the custom
  // summarization prompt. Applies on the next sidecar (re)initialize.
  getCompactionTuning() {
    return normalizeCompactionTuning(this.state.compactionTuning);
  }

  setCompactionTuning(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const { modelId, ratio, contextLength, customPrompt } = source;
    const current = this.getCompactionTuning();
    const nextRatioByModel = { ...current.ratioByModel };
    const nextContextLengthByModel = { ...current.contextLengthByModel };
    const normalizedModelId = String(modelId || '').trim();
    const hasRatio = Object.prototype.hasOwnProperty.call(source, 'ratio');
    const hasContextLength = Object.prototype.hasOwnProperty.call(source, 'contextLength');
    const normalizedRatio = ratio == null ? null : normalizeCompactionRatio(ratio);
    if (normalizedModelId && hasRatio) {
      if (normalizedRatio == null) delete nextRatioByModel[normalizedModelId];
      else nextRatioByModel[normalizedModelId] = normalizedRatio;
    }
    if (normalizedModelId && hasContextLength) {
      if (contextLength == null) delete nextContextLengthByModel[normalizedModelId];
      else {
        const normalizedContextLength = normalizeContextLength(contextLength);
        if (normalizedContextLength != null) {
          nextContextLengthByModel[normalizedModelId] = normalizedContextLength;
        }
      }
    }
    const nextTuning = normalizeCompactionTuning({
      ratioByModel: nextRatioByModel,
      contextLengthByModel: nextContextLengthByModel,
      customPrompt: customPrompt === undefined ? current.customPrompt : customPrompt,
    });
    if (JSON.stringify(nextTuning) === JSON.stringify(current)) {
      return current;
    }
    const contextLengthChanged = JSON.stringify(nextTuning.contextLengthByModel)
      !== JSON.stringify(current.contextLengthByModel);
    return this._writeState(
      { ...this.state, compactionTuning: nextTuning },
      contextLengthChanged ? 'context_length_tuning_updated' : 'compaction_tuning_updated'
    ).compactionTuning;
  }

  _updateNormalizedSection(patch, sectionKey, normalizeSection, reason) {
    const currentSection = this.state[sectionKey];
    const nextSection = normalizeSection({
      ...currentSection,
      ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}),
    });
    if (JSON.stringify(nextSection) === JSON.stringify(currentSection)) {
      return this.getState();
    }
    return this._writeState({
      ...this.state,
      [sectionKey]: nextSection,
    }, reason);
  }

  updateSkillsSettings(patch = {}) {
    return this._updateNormalizedSection(
      patch,
      'skills',
      normalizeSkillSettings,
      'skills_settings_updated'
    );
  }

  updateTipsSettings(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    if (Object.prototype.hasOwnProperty.call(source, 'enabled')) {
      this.updateHomeConfig({ showContextualTips: source.enabled === true });
    }
    const nextPatch = { ...source };
    delete nextPatch.enabled;
    return this._updateNormalizedSection(nextPatch, 'tips', normalizeTipsSettings, 'tips_settings_updated');
  }

  updateChatUiSettings(patch = {}) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'defaultRunMode')) {
      this.updateDefaultRunMode(patch.defaultRunMode);
    }
    this._updateNormalizedSection(
      patch,
      'chatUi',
      normalizeChatUiSettings,
      'chat_ui_settings_updated'
    );
    return this.getChatUiState();
  }

  updateWindowUiSettings(patch = {}) {
    return this._updateNormalizedSection(
      patch,
      'windowUi',
      normalizeWindowUiSettings,
      'window_ui_settings_updated'
    ).windowUi;
  }

  incrementTipsSessionCount() {
    return this._writeState(
      {
        ...this.state,
        tips: {
          ...this.state.tips,
          sessionCount: this.state.tips.sessionCount + 1,
        },
      },
      'tips_session_started'
    );
  }

  recordTipShown(tipId, sessionCount = this.state.tips.sessionCount) {
    const normalizedTipId = normalizeString(tipId);
    if (!normalizedTipId) {
      return this.getState();
    }
    const normalizedSessionCount =
      Number.isFinite(Number(sessionCount)) && Number(sessionCount) >= 0
        ? Math.floor(Number(sessionCount))
        : this.state.tips.sessionCount;
    if (this.state.tips.historyByTipId[normalizedTipId] === normalizedSessionCount) {
      return this.getState();
    }
    return this._writeState(
      {
        ...this.state,
        tips: {
          ...this.state.tips,
          historyByTipId: {
            ...this.state.tips.historyByTipId,
            [normalizedTipId]: normalizedSessionCount,
          },
        },
      },
      'tip_shown',
      { tipId: normalizedTipId }
    );
  }

  setWorkspaceSessionIdProvider(getValidWorkspaceSessionIds) {
    this._getValidWorkspaceSessionIds =
      typeof getValidWorkspaceSessionIds === 'function' ? getValidWorkspaceSessionIds : null;
    const normalized = this._normalizeState(this.state);
    if (JSON.stringify(normalized.workspace) === JSON.stringify(this.state.workspace)) {
      return this.getWorkspaceState();
    }
    return this._writeState(normalized, 'workspace_state_reconciled');
  }

  updateWorkspaceState(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const normalized = this._normalizeState({
      ...this.state,
      workspace: {
        ...this.state.workspace,
        ...source,
      },
    });
    if (JSON.stringify(normalized.workspace) === JSON.stringify(this.state.workspace)) {
      return this.getWorkspaceState();
    }
    if (this._shouldBlockConfigWrite()) {
      return this.getWorkspaceState();
    }
    this.state = normalized;
    this._workspaceWriteDirty = true;
    this._scheduleWorkspaceWrite();
    const snapshot = this.getState();
    this.emit('changed', snapshot, {
      reason: 'workspace_state_updated',
    });
    return this.getWorkspaceState();
  }

  flushPendingWorkspaceWrite() {
    if (!this._workspaceWriteTimer && !this._workspaceWriteDirty) {
      return this.getWorkspaceState();
    }
    this._clearPendingWorkspaceTimer();
    this._workspaceWriteRevision += 1;
    this._workspaceWriteRetryCount = 0;
    if (!this._workspaceWriteDirty) {
      return this.getWorkspaceState();
    }
    try {
      if (!this._persistState(this.state, 'shell_config.workspace_write_failed')) {
        this._workspaceWriteDirty = true;
      }
    } catch (_error) {
      this._workspaceWriteDirty = true;
      safeEmitLog(this._logger, 'WARN', 'shell_config.workspace_flush_deferred', {});
    }
    return this.getWorkspaceState();
  }

  updateFeatureSettings(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const nextTools = normalizeToolsSettings({
      ...this.state.tools,
      ...(source.tools && typeof source.tools === 'object' && !Array.isArray(source.tools)
        ? source.tools
        : {}),
    });
    const nextFeatureOverrides = normalizeFeatureOverrides({
      ...this.state.featureOverrides,
      ...(source.featureOverrides
      && typeof source.featureOverrides === 'object'
      && !Array.isArray(source.featureOverrides)
        ? source.featureOverrides
        : {}),
    });
    const nextWebSearch = normalizeWebSearchSettings({
      ...this.state.webSearch,
      ...(source.webSearch && typeof source.webSearch === 'object' && !Array.isArray(source.webSearch)
        ? source.webSearch
        : {}),
    });
    const nextMemory = normalizeMemorySettings({
      ...this.state.memory,
      ...(source.memory && typeof source.memory === 'object' && !Array.isArray(source.memory)
        ? source.memory
        : {}),
    });
    const toolsChanged = JSON.stringify(nextTools) !== JSON.stringify(this.state.tools);
    const overridesChanged =
      JSON.stringify(nextFeatureOverrides) !== JSON.stringify(this.state.featureOverrides);
    const webSearchChanged =
      JSON.stringify(nextWebSearch) !== JSON.stringify(this.state.webSearch);
    const memoryChanged = JSON.stringify(nextMemory) !== JSON.stringify(this.state.memory);
    if (!toolsChanged && !overridesChanged && !webSearchChanged && !memoryChanged) {
      return this.getState();
    }

    const nextState = {
      ...this.state,
      tools: nextTools,
      toolsWorktreeEnabled: nextTools.worktree === true,
      webSearch: nextWebSearch,
      featureOverrides: nextFeatureOverrides,
      memory: nextMemory,
    };
    let reason = 'feature_settings_updated';
    if (toolsChanged && !overridesChanged) {
      const changedTool = TOOL_SETTING_KEYS.find((key) => nextTools[key] !== this.state.tools[key]);
      if (changedTool === 'web') {
        reason = 'tools_web_enabled_updated';
      } else if (changedTool === 'imageRead') {
        reason = 'tools_image_read_enabled_updated';
      } else if (changedTool === 'pythonRuntime') {
        reason = 'tools_python_runtime_enabled_updated';
      } else if (changedTool === 'todo') {
        reason = 'tools_todo_enabled_updated';
      } else if (changedTool === 'mermaid') {
        reason = 'tools_mermaid_enabled_updated';
      } else if (changedTool === 'worktree') {
        reason = 'tools_worktree_enabled_updated';
      }
    }
    if (overridesChanged && !toolsChanged) {
      const changedFeature = FEATURE_OVERRIDE_KEYS.find(
        (key) => nextFeatureOverrides[key] !== this.state.featureOverrides[key]
      );
      if (changedFeature) {
        reason = `feature_override_${changedFeature}_updated`;
      }
    }
    if (webSearchChanged && !toolsChanged && !overridesChanged) {
      reason = 'web_search_settings_updated';
    }
    if (memoryChanged && !toolsChanged && !overridesChanged && !webSearchChanged) {
      reason = 'memory_capture_suggestions_updated';
    }
    return this._writeState(nextState, reason);
  }

  updateOfflineIntelligence(patch = {}) {
    const nextOffline = {
      ...this.state.offlineIntelligence,
      ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}),
    };
    return this._writeState(
      {
        ...this.state,
        offlineIntelligence: normalizeOfflineIntelligence(nextOffline),
      },
      'offline_intelligence_updated'
    );
  }

  getLocalEngines() {
    return normalizeLocalEngines(this.state.localEngines);
  }

  updateLocalEngineAcceleration(patch) {
    const localEngines = normalizeLocalEngines({
      ...this.state.localEngines,
      openaiCompatible: {
        ...this.state.localEngines?.openaiCompatible,
        acceleration: patch,
      },
    });
    const current = this.getLocalEngines().openaiCompatible.acceleration;
    if (JSON.stringify(localEngines.openaiCompatible.acceleration) === JSON.stringify(current)) {
      return this.getState();
    }
    return this._writeState(
      { ...this.state, localEngines },
      'local_engine_acceleration_updated'
    );
  }

  updateManagedLlamaServer(patch) {
    const current = this.getLocalEngines().openaiCompatible.managed;
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const perModel = { ...current.perModel };
    if (source.perModel && typeof source.perModel === 'object' && !Array.isArray(source.perModel)) {
      for (const [key, value] of Object.entries(source.perModel)) {
        if (value === null) {
          delete perModel[key];
        } else {
          perModel[key] = value;
        }
      }
    }
    const openaiCompatible = {
      ...this.state.localEngines?.openaiCompatible,
      managed: { ...current, ...source, perModel },
    };
    const localEngines = normalizeLocalEngines({ ...this.state.localEngines, openaiCompatible });
    if (JSON.stringify(localEngines.openaiCompatible.managed) === JSON.stringify(current)) {
      return this.getState();
    }
    return this._writeState({ ...this.state, localEngines }, 'managed_llama_server_updated');
  }

  updatePreferredEngineType(value) {
    const preferredEngineType = normalizePreferredEngineType(value);
    if (preferredEngineType === this.state.preferredEngineType) {
      return this.getState();
    }
    return this._writeState(
      {
        ...this.state,
        preferredEngineType,
      },
      'preferred_engine_type_updated'
    );
  }

  updateDefaultRunMode(value) {
    const defaultRunMode = normalizeRunMode(value);
    if (defaultRunMode === this.state.defaultRunMode) {
      return this.getState();
    }
    return this._writeState(
      { ...this.state, defaultRunMode },
      'default_run_mode_updated'
    );
  }

  saveSetupEndpoint({ engineType, port, apiUrl } = {}) {
    const preferredEngineType = normalizePreferredEngineType(engineType);
    if (!['ollama', 'vllm', 'openai-compatible'].includes(preferredEngineType)) {
      return { saved: false, reason: 'unsupported_engine' };
    }
    const localEngines = normalizeLocalEngines({
      ...this.state.localEngines,
      ...(preferredEngineType === 'vllm' ? {
        vllm: { ...this.state.localEngines?.vllm, port },
      } : {}),
      ...(preferredEngineType === 'openai-compatible' ? {
        openaiCompatible: { ...this.state.localEngines?.openaiCompatible, port, apiUrl },
      } : {}),
    });
    const nextState = {
      ...this.state,
      preferredEngineType,
      localEngines,
    };
    const committed = this._commitState(nextState, 'setup_endpoint_saved');
    return { saved: committed.persisted, state: committed.snapshot };
  }

}

function installPrototypeMethods(target, methods) {
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(target, name, {
      value: method,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

for (const methods of [followUpActionMethods, proactiveActionMethods, workspaceRootMethods,
  workspaceIdeMethods, modelTuningMethods, engineTuningMethods]) {
  installPrototypeMethods(ShellConfigService.prototype, methods);
}

module.exports = {
  CONFIG_VERSION,
  DEFAULT_CHAT_UI,
  DEFAULT_CODEX_CLI,
  DEFAULT_COMPANION,
  DEFAULT_FEATURE_OVERRIDES,
  DEFAULT_MEMORY,
  DEFAULT_OFFLINE_INTELLIGENCE,
  DEFAULT_SETUP,
  DEFAULT_SKILLS,
  DEFAULT_TELEMETRY,
  DEFAULT_TIPS,
  DEFAULT_TOOLS,
  DEFAULT_WORKSPACE_STATE,
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
  ShellConfigService,
  calculateDeferredUntilForPreset,
  getAvailableFollowUpDeferPresets,
  normalizeChatUiSettings,
  normalizeWindowUiSettings,
  normalizeAssistantIdentity,
  normalizeCodexCliSettings,
  normalizeCompanion,
  normalizeCompanionMode,
  normalizeFollowUp,
  normalizeLocalEngines,
  normalizeMemorySettings,
  normalizeOfflineIntelligence,
  normalizeReminder,
  normalizeSetupState,
  normalizeSkillSettings,
  normalizeTelemetrySettings,
  normalizeState,
  normalizeTipsSettings,
  normalizeToolsSettings,
  normalizeWatcherGlobs,
  normalizeWebSearchSettings,
  normalizeWorkspaceRoot,
  normalizeWorkspaceState,
};
