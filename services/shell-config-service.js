const path = require('path');
const { EventEmitter } = require('events');
const { preserveCorruptFile, readWithRetry } = require('./backend/corrupt-file-preserve');
const { FileJsonStore } = require('./backend/file-json-store');
const { normalizeString } = require('./backend/path-utils');
const { logNewerSchemaDetected, logWriteFailed, safeEmitLog } = require('./backend/session-store-logging');
const { normalizeLocalEngines } = require('./shell-config-engines');
const { mergeWorkspacePatch, workspaceStateView } = require('./shell-config-normalizers');
const {
  CONFIG_VERSION,
  DEFAULT_CHAT_UI,
  DEFAULT_CODEX_CLI,
  DEFAULT_COMPANION,
  DEFAULT_FEATURE_OVERRIDES,
  DEFAULT_OFFLINE_INTELLIGENCE,
  DEFAULT_SETUP,
  DEFAULT_SKILLS,
  DEFAULT_TELEMETRY,
  DEFAULT_TOOLS,
  DEFAULT_WORKSPACE_STATE,
  FOLLOW_UP_DEFER_PRESETS,
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
  WORKSPACE_WRITE_DELAY_MS,
  cloneState,
  normalizeAutoApproveStreakCap,
  normalizeChatUiSettings,
  normalizeWindowUiSettings,
  normalizeAssistantIdentity,
  normalizeCodexCliSettings,
  normalizeCompanion,
  normalizeCompanionMode,
  normalizeFollowUp,
  normalizeOfflineIntelligence,
  normalizeRunMode,
  normalizeSafetyMode,
  normalizeSetupState,
  normalizeReminder,
  normalizeSkillSettings,
  normalizeTelemetrySettings,
  normalizeState,
  normalizeToolsSettings,
  normalizeUiLanguage,
  normalizeUnattendedGuardMinutes,
  normalizeDigestQuietStart, normalizeDigestQuietEnd,
  normalizeValidWorkspaceSessionIds,
  normalizeWebSearchSettings,
  normalizeWatcherGlobs,
  normalizeWorkspaceRoot,
  normalizeWorkspaceState,
  serializeState,
} = require('./shell-config-state');
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
const { agentQuietLaunchMethods } = require('./agent-quiet-launch');
const { modelTuningMethods } = require('./shell-config-model-tuning');
const { engineTuningMethods } = require('./shell-config-engine-tuning');
const { collectWorkspaceIdeDropCounts } = require('./shell-config-workspace-ide-migration');
const { compactionTuningMethods } = require('./shell-config-compaction-tuning');
const { setupActionMethods } = require('./shell-config-setup-actions');
const { settingsBlockMethods } = require('./shell-config-settings-blocks');
const { localEngineActionMethods } = require('./shell-config-local-engine-actions');
const getAvailableFollowUpDeferPresets = (now = new Date(), scheduleOptions = {}) =>
  listAvailableFollowUpDeferPresets(now, FOLLOW_UP_DEFER_PRESETS, scheduleOptions);
// Top-level chat UI scalars updateChatUiSettings owns: [key, normalize, changed reason].
const CHAT_UI_TOP_LEVEL_FIELDS = [
  ['use24HourTime', (value) => value === true, 'time_format_updated'],
  ['defaultRunMode', normalizeRunMode, 'default_run_mode_updated'],
  ['uiLanguage', normalizeUiLanguage, 'ui_language_updated'],
  ['safetyMode', normalizeSafetyMode, 'safety_mode_updated'],
  ['unattendedGuardMinutes', normalizeUnattendedGuardMinutes, 'unattended_guard_minutes_updated'],
  ['autoApproveStreakCap', normalizeAutoApproveStreakCap, 'auto_approve_streak_cap_updated'],
  // Row 86 digest quiet hours: read by main (primary-digest-wiring.js); no reason of their own.
  ['digestQuietStart', normalizeDigestQuietStart, 'chat_ui_settings_updated'],
  ['digestQuietEnd', normalizeDigestQuietEnd, 'chat_ui_settings_updated'],
  // Row 117: written only by the composer's Browser row; read at the sessions.create IPC entry.
  ['browserOnInNewChats', (value) => value === true, 'chat_ui_settings_updated'],
];



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
    this.setMaxListeners(32); // eleven main-process 'changed' subscribers (2026-09-15); Node warns past 10
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
    this._workspaceWriteDelayMs = Math.max(0, Number(workspaceWriteDelayMs) || WORKSPACE_WRITE_DELAY_MS);
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
    this._blockedConfigWriteLoggedFor = '';
    this._damagedConfigStillInPlace = false;
    const initialRawState = this._readInitialState();
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
    this._seedAgentQuietSetupOnce();
  }

  // A missing file is a fresh install. A file that cannot be parsed, or is not
  // a JSON object, is moved aside so the first save cannot replace its bytes;
  // if the move fails the file stays and every config write is blocked. A file
  // that could not be read at all (a read error code) may be healthy, so it is
  // never moved: it stays and writes are blocked.
  _readInitialState() {
    const result = readWithRetry(this.store, {});
    const isObject = Boolean(result.value) && typeof result.value === 'object'
      && !Array.isArray(result.value);
    if (!result.corrupted && !result.unreadable && (result.missing || isObject)) {
      this._freshInstall = !Object.keys(result.value).length;
      return result.value;
    }
    const outcome = result.unreadable
      ? { preserved: false, reason: 'unreadable' }
      : preserveCorruptFile(this.store.filePath, { logger: this._logger });
    this._damagedConfigStillInPlace = !outcome.preserved && outcome.reason !== 'missing';
    this._freshInstall = false;
    safeEmitLog(this._logger, 'ERROR', 'shell_config.corrupt_state_detected', {
      fileName: path.basename(this.store.filePath),
      preserved: outcome.preserved === true,
      ...(outcome.preserved
        ? { preservedName: path.basename(outcome.preservedPath) }
        : { reason: outcome.reason }),
      errorCode: result.errorCode || (result.corrupted ? 'invalid_json' : 'not_an_object'),
    });
    return {};
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
    const reason = this._damagedConfigStillInPlace ? 'corrupt' : this._hasNewerConfigVersion() ? 'newer' : '';
    if (!reason) {
      return false;
    }
    if (this._blockedConfigWriteLoggedFor !== reason) {
      this._blockedConfigWriteLoggedFor = reason;
      if (reason === 'corrupt') {
        safeEmitLog(this._logger, 'ERROR', 'shell_config.corrupt_write_blocked', {
          fileName: path.basename(this.store.filePath),
        });
      } else {
        this._logNewerConfigVersion('shell_config.newer_schema_write_blocked');
      }
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

  isFreshInstall() {
    return this._freshInstall;
  }

  getWorkspaceState() {
    return workspaceStateView(this.state.workspace);
  }

  getChatUiState() {
    // The chatUi block plus every top-level scalar updateChatUiSettings owns, normalized.
    return { ...this.state.chatUi, ...Object.fromEntries(CHAT_UI_TOP_LEVEL_FIELDS.map(([key, normalize]) => [key, normalize(this.state[key])])) };
  }
  getUiLanguage() {
    return normalizeUiLanguage(this.state.uiLanguage);
  }

  getWindowUiState() {
    return normalizeWindowUiSettings(this.state.windowUi);
  }





  replaceState(nextState, reason = 'state_replaced') {
    return this._writeState(nextState, reason);
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

  // One whole-file write per patch. `reasons` names every sub-change; `reason`
  // stays the specific one when only one applied (listeners key off it).
  updateChatUiSettings(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const nextState = { ...this.state };
    const reasons = [];
    for (const [key, normalize, reason] of CHAT_UI_TOP_LEVEL_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      nextState[key] = normalize(source[key]);
      if (nextState[key] !== this.state[key]) reasons.push(reason);
    }
    nextState.chatUi = normalizeChatUiSettings({ ...this.state.chatUi, ...source });
    if (JSON.stringify(nextState.chatUi) !== JSON.stringify(this.state.chatUi)) reasons.push('chat_ui_settings_updated');
    if (reasons.length) {
      this._writeState(nextState, reasons.length === 1 ? reasons[0] : 'chat_ui_settings_updated', { reasons });
    }
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
      workspace: mergeWorkspacePatch(this.state.workspace, source),
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















  updateDefaultRunMode(value) {
    this.updateChatUiSettings({ defaultRunMode: value });
    return this.getState();
  }

  updateUiLanguage(value) {
    this.updateChatUiSettings({ uiLanguage: value });
    return this.getState();
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
  workspaceIdeMethods, modelTuningMethods, engineTuningMethods, agentQuietLaunchMethods,
  setupActionMethods, settingsBlockMethods, localEngineActionMethods, compactionTuningMethods]) {
  installPrototypeMethods(ShellConfigService.prototype, methods);
}

module.exports = {
  CONFIG_VERSION,
  DEFAULT_CHAT_UI,
  DEFAULT_CODEX_CLI,
  DEFAULT_COMPANION,
  DEFAULT_FEATURE_OVERRIDES,
  DEFAULT_OFFLINE_INTELLIGENCE,
  DEFAULT_SETUP,
  DEFAULT_SKILLS,
  DEFAULT_TELEMETRY,
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
  normalizeOfflineIntelligence,
  normalizeReminder,
  normalizeSetupState,
  normalizeSkillSettings,
  normalizeTelemetrySettings,
  normalizeState,
  normalizeToolsSettings,
  normalizeWatcherGlobs,
  normalizeWebSearchSettings,
  normalizeWorkspaceRoot,
  normalizeWorkspaceState,
};
