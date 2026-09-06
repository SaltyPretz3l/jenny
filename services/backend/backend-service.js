const path = require('path');
const { EventEmitter } = require('events');

const { version: DEFAULT_APP_VERSION } = require('../../package.json');
const {
  getAuthState: _getAuthState,
  restoreAuthState: _restoreAuthState,
  updateLocalProfile: _updateLocalProfile,
} = require('./backend-auth');
const {
  resolveModel: _resolveModel,
  cancelChatStream: _cancelChatStream,
  compactContextNow: _compactContextNow,
  approveToolCall: _approveToolCall,
  denyToolCall: _denyToolCall,
  handleChatStreamEnd: _handleChatStreamEnd,
  hasPendingUserQuestions: _hasPendingUserQuestions,
  answerUserQuestions: _answerUserQuestions,
  declineUserQuestions: _declineUserQuestions,
} = require('./backend-chat-stream');
const {
  startManagedSidecarChatStream: _startManagedSidecarChatStream,
} = require('./managed-sidecar-chat');
const { discardUnsavedReply: _discardUnsavedReply, retryUnsavedReply: _retryUnsavedReply } = require('./backend-terminal-repair-actions');
const { assertChatTurnAdmissible } = require('./chat-turn-admission');
const {
  buildManagedSidecarConfig: _buildManagedSidecarConfig,
  disposeSidecarClient: _disposeSidecarClient,
  restartManagedSidecar: _restartManagedSidecar,
  refreshManagedConfig: _refreshManagedConfig,
} = require('./managed-sidecar-lifecycle');
const {
  abortManagedSidecarInitialization: _abortManagedSidecarInitialization,
  buildObservedBackendStatus: _buildObservedBackendStatus,
  initializeManagedSidecarWithTimeout: _initializeManagedSidecarWithTimeout,
  buildLocalEngineStatusSnapshot: _buildLocalEngineStatusSnapshot,
} = require('./local-engine-status');
const {
  attemptAutoReconnect: _attemptAutoReconnectManaged,
  handleSidecarLog: _handleLocalEngineSidecarLog,
  handleSidecarStatus: _handleLocalEngineSidecarStatus,
  markManagedSidecarInitialized: _markManagedSidecarInitialized,
  retryStartBackendService: _retryStartBackendService,
  startBackendService: _startBackendService,
  stopBackendService: _stopBackendService,
} = require('./local-engine-lifecycle');
const {
  appendLateEventAudit: _appendLateEventAudit,
  recordLateSidecarEvent: _recordLateSidecarEvent,
} = require('./backend-late-event-audit');
const {
  schedulePendingSessionMigrations: _schedulePendingSessionMigrations,
  clearPendingSessionMigrationSchedule: _clearPendingSessionMigrationSchedule,
  runPendingMigrations: _runPendingMigrations,
} = require('./backend-session-migration-scheduler');
const {
  startLocalEngineChatStream: _startLocalEngineChatStream,
} = require('./local-engine-requests');
const {
  getMemoryStatus: _getMemoryStatus,
  dismissMemorySuggestion: _dismissMemorySuggestion,
  isMemorySuggestionDismissed: _isMemorySuggestionDismissed,
  suggestMemoriesForSession: _suggestMemoriesForSession,
  saveMemoryForSession: _saveMemoryForSession,
  listApprovedMemories: _listApprovedMemories,
  listPendingMemories: _listPendingMemories,
  updateApprovedMemory: _updateApprovedMemory,
  deleteApprovedMemory: _deleteApprovedMemory,
  deletePendingMemory: _deletePendingMemory,
  recallApprovedMemories: _recallApprovedMemories,
  recallRecentApprovedMemories: _recallRecentApprovedMemories,
} = require('./backend-memory');
const {
  runBackgroundTask: _runBackgroundTask,
} = require('./backend-background-tasks');
const {
  inspectHarness: _inspectHarness,
} = require('./backend-harness');
const {
  getJennyStatus: _getJennyStatus,
} = require('./jenny-status-composer');
const {
  checkCodexDiagnosticSetup,
  openCodexLoginTerminal,
} = require('./codex-cli-setup-adapter');
const {
  createCodexCliAuthService,
} = require('./codex-cli-auth-service');
const {
  createCodexCliRuntimeService,
} = require('./codex-cli-runtime-service');
const {
  createPhasePercentilesAggregator,
} = require('./phase-percentiles-aggregator');
const {
  createToolObservabilityAggregator,
} = require('./tool-observability-aggregator');
const {
  CANCEL_REASON_DISPOSE,
  CANCEL_REASON_SERVICE_STOP,
  CANCEL_REASON_USER,
  createCancellationError,
  normalizeCancelReason,
} = require('./chat-stream-terminal-utils');
const { isolateActiveStreamAbort } = require('./active-stream-shutdown-drain');
const { getOllamaModelBlob: _getOllamaModelBlob } = require('./backend-ollama-blob');
const {
  refreshStatusSnapshot: _refreshStatusSnapshot,
  listModels: _listModels,
  listModelsForEngine: _listModelsForEngine,
  loadModel: _loadModel,
  autoLoadDefaultModel: _autoLoadDefaultModel,
  unloadModel: _unloadModel,
  unloadManagedModelForShutdown: _unloadManagedModelForShutdown,
  getHardwareVramUsage: _getHardwareVramUsage,
  getResidentModels: _getResidentModels,
} = require('./backend-runtime');
const {
  listSessions: _listSessions,
  createSession: _createSession,
  renameSession: _renameSession,
  getSessionMessages: _getSessionMessages,
  setSessionPreferences: _setSessionPreferences,
  setSessionMeta: _setSessionMeta,
  sweepEmptySessions: _sweepEmptySessions,
  updateSessionMessage: _updateSessionMessage,
  editUserMessageAndTruncate: _editUserMessageAndTruncate,
} = require('./backend-sessions');
const {
  deleteSessionWithQuiescence: _deleteSessionWithQuiescence,
} = require('./backend-session-delete-lifecycle');
const {
  inferEngineTypeFromModel,
} = require('./backend-service-utils');
const {
  getManagedActiveTurnState: _getManagedActiveTurnState,
} = require('./backend-active-turn-state');
const {
  getManagedReasoningSupportForModel: _getManagedReasoningSupportForModel,
  normalizeManagedSessionPreferencePatch: _normalizeManagedSessionPreferencePatch,
  normalizeManagedReasoningEfforts: _normalizeManagedReasoningEfforts,
} = require('./backend-managed-reasoning');
const { drainSessionStoresSync } = require('./session-store-drain');
const { OllamaProcessManager, runOllamaDisposeForceKillSweep } = require('./ollama-process-manager');
const { VLLMProcessManager } = require('./vllm-process-manager');
const { SidecarManager } = require('./sidecar-manager');
const { SecureStore } = require('./secure-store');
const { getAllSchemaVersions } = require('./schema-version-registry');
const { createProviderIntegrationRegistry } = require('./provider-integrations');
const { createUnavailableSetupState } = require('../setup-service');
const {
  initializeConversationStorage,
} = require('./backend-conversation-storage');
const MAX_DISMISSED_MEMORY_FINGERPRINTS = 1000;
class BackendService extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    const emitLog = (level, event, details) => this._emitServiceLog(level, event, details);
    const appVersion = String(options.appVersion || '').trim();
    this.appVersion = appVersion || String(DEFAULT_APP_VERSION || '').trim();
    this.currentModel = '';
    // Preferred-engine override wins over model-based inference: lets the
    // picker show openai-compatible (llama-server) models at boot even
    // while the default model string still implies ollama.  Empty = infer.
    const preferredEngineType = String(
      options.configService?.getState?.()?.preferredEngineType || ''
    ).trim().toLowerCase();
    this.currentEngineType = preferredEngineType
      || inferEngineTypeFromModel(options.defaultModel || '');
    this.currentStatus = null;
    this._lastEngineFallback = null;
    this._modelEngineHints = new Map();
    this._managedPendingModel = '';
    this._managedInitializeFlight = null;
    this._managedInitializeGeneration = 0;
    this._modelLifecycle = {
      state: 'unloaded',
      requested_model: '',
      engine: this.currentEngineType,
      status: '',
      percent: 0,
      completed_bytes: 0,
      total_bytes: 0,
      error_code: null,
      started_at: null,
      updated_at: null,
      ready_at: null,
    };
    this.ollamaManager = new OllamaProcessManager({
      logger: emitLog,
      userDataPath: options.userDataPath,
      resolveMaxLoadedModels: () => this._resolveOllamaMaxLoadedModels(),
      // Managed-engine liveness heartbeat for the sidecar's stream-inactivity
      // watchdog (a busy engine composing a buffered tool call streams no
      // chat chunks — see services/backend/ollama-process-manager.js).
      onEngineActivity: () => {
        try {
          this.sidecarClient?.notifyEngineActivity?.();
        } catch (_error) {
          /* best-effort */
        }
      },
    });
    this.vllmManager = new VLLMProcessManager({
      logger: emitLog,
      userDataPath: options.userDataPath,
      model: this.currentEngineType === 'vllm' ? String(options.defaultModel || '').trim() : '',
    });
    this.defaultModel = String(options.defaultModel || '').trim();
    this.reasoningEffortSupport = 'unknown';
    this.accessToken = '';
    this.activeStreams = new Map();
    this.pendingToolApprovals = new Map();
    this.pendingUserQuestions = new Map();
    this.on('chat-stream', (event) => _handleChatStreamEnd(this, event));
    this.enableInteractiveStreamDebug = Boolean(options.enableInteractiveStreamDebug);
    this.personalityWorkspace = options.personalityWorkspace || null;
    this.configService = options.configService || null;
    this.skillsService = options.skillsService || null;
    this.knowledgeService = options.knowledgeService || null;
    this.mcpDiscoveryService = options.mcpDiscoveryService || null;
    this.tipsService = options.tipsService || null;
    this.setupService = options.setupService || null;
    this.usageHistory = options.usageHistory || null;
    this.shellLogStore = options.shellLogStore || null;
    this.phasePercentilesAggregator = options.phasePercentilesAggregator
      || createPhasePercentilesAggregator();
    this.toolObservabilityAggregator = options.toolObservabilityAggregator
      || createToolObservabilityAggregator();
    this.systemStatsProvider = typeof options.systemStatsProvider === 'function'
      ? options.systemStatsProvider
      : null;
    this.attachmentAssetStore = options.attachmentAssetStore || null;
    // Read by cleanupDeletedSession's ipc_payloads step. Without this the
    // whole reference-counted payload cleanup is dead code in production.
    this.ipcPayloadStore = options.ipcPayloadStore || null;
    this.artifactService = options.artifactService || null;
    this.worktreeService = options.worktreeService || null;
    this.automationService = options.automationService || null;
    this.secureStore = new SecureStore({
      filePath: path.join(options.userDataPath, 'secure-state.json'),
      safeStorage: options.safeStorage,
      isSafeStorageReady: options.isSafeStorageReady,
    });
    // Chat-stream stores opt into trailing-edge write debouncing
    // (services/backend/file-json-store.js writeDebounceMs). On long histories,
    // sync rewrites on terminal-phase notification handlers could stall the
    // event loop and freeze the UI; bursts now collapse to one async write per
    // debounce window, and dispose/stop drains pending writes explicitly.
    initializeConversationStorage(this, options);
    const codexCheckSetup = typeof options.checkCodexDiagnosticSetup === 'function'
      ? options.checkCodexDiagnosticSetup
      : checkCodexDiagnosticSetup;
    const codexOpenLoginTerminal = typeof options.openCodexLoginTerminal === 'function'
      ? options.openCodexLoginTerminal
      : openCodexLoginTerminal;
    this.codexCliAuthService = createCodexCliAuthService({
      checkSetup: codexCheckSetup,
      openLoginTerminal: codexOpenLoginTerminal,
      logger: emitLog,
    });
    this.codexCliRuntimeService = createCodexCliRuntimeService({
      userDataPath: options.userDataPath,
      configService: this.configService,
      authService: this.codexCliAuthService,
      logger: emitLog,
    });
    this.sidecarManager = new SidecarManager({
      mode: 'managed-dev',
      userDataPath: options.userDataPath,
      repoRoot: options.repoRoot,
      pythonExecutable: options.pythonExecutable,
      sandboxRoot: options.sandboxRoot,
      spawnImpl: options.spawnImpl,
      launchCommand: options.launchCommand,
      launchArgs: options.launchArgs,
      launchSource: options.launchSource,
      packagedLaunchDetail: options.packagedLaunchDetail,
      packagedSidecarLaunch: options.packagedSidecarLaunch,
      resolvePackagedLaunch: options.resolvePackagedLaunch,
      killProcessTreeImpl: options.killProcessTreeImpl,
      startupSoftTimeoutMs: options.startupSoftTimeoutMs,
      logger: emitLog,
    });
    this.sidecarClient = null;
    this.featureFlags = options.featureFlags && typeof options.featureFlags === 'object'
      ? { ...options.featureFlags }
      : {};
    this.providerIntegrationRegistry = createProviderIntegrationRegistry([
      this.codexCliRuntimeService,
      ...(Array.isArray(options.providerIntegrations) ? options.providerIntegrations : []),
    ]);
    this.offlineIntelligenceService = options.offlineIntelligenceService || null;
    this.toolExecutor = options.toolExecutor || null;
    this.toolPermissionStore = options.toolPermissionStore || null;
    this._electronToolGeneratedArtifactsByCall = new Map();
    // Dismissed memory suggestion fingerprints persist across renderer reloads
    // but not across app restarts.  Keyed by normalized fingerprint string.
    this._dismissedMemoryFingerprints = new Set();
    this._disposed = false;
    this._sidecarClientErrorListener = null;
    this._sidecarClientLateNotificationListener = null;
    this._sidecarClientMonitorNotificationListener = null;
    this._handleSidecarStatus = this._handleSidecarStatus.bind(this);
    this._handleSidecarLog = this._handleSidecarLog.bind(this);

    this._autoReconnectPending = false;
    this._autoReconnectAttempted = false;
    this._managedReadyOnce = false;
    this._stopping = false;
    this.sidecarManager.on('status', this._handleSidecarStatus);
    this.sidecarManager.on('log', this._handleSidecarLog);
    this.setFeatureFlags(this.featureFlags);
  }

  _handleSidecarStatus(status) {
    return _handleLocalEngineSidecarStatus(this, status);
  }

  async _attemptAutoReconnect(failedStatus) {
    return _attemptAutoReconnectManaged(this, failedStatus);
  }

  _markManagedSidecarInitialized() {
    return _markManagedSidecarInitialized(this);
  }

  _handleSidecarLog(text) {
    return _handleLocalEngineSidecarLog(this, text);
  }

  _removeManagedListeners() {
    if (typeof this.sidecarManager.off === 'function') {
      this.sidecarManager.off('status', this._handleSidecarStatus);
      this.sidecarManager.off('log', this._handleSidecarLog);
    } else if (typeof this.sidecarManager.removeListener === 'function') {
      this.sidecarManager.removeListener('status', this._handleSidecarStatus);
      this.sidecarManager.removeListener('log', this._handleSidecarLog);
    }
  }

  _abortActiveStreams(reason = CANCEL_REASON_SERVICE_STOP, { clear = false } = {}) {
    const cancelError = createCancellationError(reason);
    for (const [streamId, controller] of this.activeStreams) {
      if (typeof this._emitServiceLog === 'function') {
        this._emitServiceLog('INFO', 'chat.stream_abort_requested', {
          streamId,
          traceId: String(controller?.traceId || '').trim(),
          cancelReason: cancelError.cancel_reason,
          cancel_reason: cancelError.cancel_reason,
        });
      }
      isolateActiveStreamAbort(this, streamId, cancelError.cancel_reason,
        () => controller.abort(createCancellationError(cancelError.cancel_reason)));
    }
    if (clear) {
      this.activeStreams.clear();
    }
  }

  _clearPendingToolApprovals() {
    for (const [, pending] of this.pendingToolApprovals) {
      pending.resolve(false, 'cancelled');
    }
    this.pendingToolApprovals.clear();
  }

  _disposeSidecarClient() {
    _disposeSidecarClient(this);
  }

  _appendLateEventAudit(sessionId, callId, lateEvent) {
    return _appendLateEventAudit(this, sessionId, callId, lateEvent);
  }

  _recordLateSidecarEvent(message) {
    return _recordLateSidecarEvent(this, message);
  }

  _schedulePendingSessionMigrations() {
    _schedulePendingSessionMigrations(this);
  }

  _clearPendingSessionMigrationSchedule() {
    _clearPendingSessionMigrationSchedule(this);
  }

  async runPendingMigrations() {
    return _runPendingMigrations(this);
  }

  async start(options) {
    return _startBackendService(this, options);
  }

  async stop(options) {
    return _stopBackendService(this, options);
  }

  dispose() {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this.workspaceActiveUseTracker?.dispose?.();
    _abortManagedSidecarInitialization(this, 'Backend service disposed.');
    this._clearPendingSessionMigrationSchedule();
    this._removeManagedListeners();
    this._abortActiveStreams(CANCEL_REASON_DISPOSE, { clear: true });
    this._clearPendingToolApprovals();
    this.mcpDiscoveryService?.dispose?.();
    this._disposeSidecarClient();
    // Drain any debounced writes from the chat-stream stores before any
    // process teardown. These stores opt into trailing-edge write coalescing
    // (services/backend/file-json-store.js writeDebounceMs) to keep the
    // streaming hot path off the disk; without an explicit flush, pending
    // session/journal updates can be lost when the timer is preempted by
    // process exit.
    drainSessionStoresSync(this);
    try { this.sidecarManager.stop().catch(() => null); } catch (_) { /* best effort */ }
    try { this.vllmManager.stop().catch(() => null); } catch (_) { /* best effort */ }
    if (this.ollamaManager) {
      try {
        // Residue-gated: skips the ~1s win32 process-list scan when no local
        // ollama could be left behind (see runOllamaDisposeForceKillSweep).
        runOllamaDisposeForceKillSweep(this.ollamaManager);
      } catch (_error) {
        // best effort only
      }
    }
  }

  async retryStart() {
    return _retryStartBackendService(this);
  }

  getBackendStatus() {
    const setupSnapshot = this.setupService && typeof this.setupService.getState === 'function'
      ? this.setupService.getState()
      : createUnavailableSetupState();
    const runtimeStatus = _buildObservedBackendStatus(this);
    return {
      ...runtimeStatus,
      appVersion: this.appVersion,
      credentialStore: this.secureStore.getStatus(),
      schemaVersions: getAllSchemaVersions({
        sidecarSchemaVersions:
          this.currentStatus?.schema_versions || this.currentStatus?.schemaVersions || [],
      }),
      setup_complete: setupSnapshot.setup_complete === true,
      setup_state: setupSnapshot.setup_state || null,
    };
  }

  async setFeatureFlags(nextFlags = {}) {
    this.featureFlags = nextFlags && typeof nextFlags === 'object' && !Array.isArray(nextFlags)
      ? { ...nextFlags }
      : {};
    if (this.skillsService && typeof this.skillsService.setFeatureEnabled === 'function') {
      this.skillsService.setFeatureEnabled(this.featureFlags.skills_system === true);
    }
    return { ...this.featureFlags };
  }

  // Decide the Ollama MAX_LOADED_MODELS ceiling for the next daemon spawn. Inline
  // autocomplete loads a small FIM model alongside the chat model; on a single
  // GPU the anti-thrash pin of 1 would force one to evict the other every time
  // work bounces between editing and chat. When the feature is active with a
  // selected completion model we raise the ceiling to 2 so both runners stay
  // resident (the FIM model is CPU-pinned per-request in the sidecar by default,
  // so it never erodes the chat model's VRAM budget). Returns null to keep the
  // default ceiling. Read at start() time, so a toggle takes effect on the next
  // managed Ollama (re)launch.
  _resolveOllamaMaxLoadedModels() {
    try {
      if (this.featureFlags?.workspace_inline_suggest !== true) {
        return null;
      }
      const ide = this.configService?.getState?.()?.workspaceIde || {};
      if (ide.inlineSuggestEnabled === false) {
        return null;
      }
      const model = String(ide.inlineSuggestModel || '').trim();
      return model ? 2 : null;
    } catch (_error) {
      return null;
    }
  }

  getAuthState() {
    return _getAuthState(this);
  }

  _emitServiceLog(level, event, details = {}) {
    this.emit('service-log', {
      level: String(level || 'INFO').toUpperCase(),
      event: String(event || 'service.event'),
      details,
    });
  }

  async restoreAuthState() {
    return _restoreAuthState(this);
  }

  updateLocalProfile(opts) {
    return _updateLocalProfile(this, opts);
  }

  _getManagedReasoningSupportForModel(preferredModel = '') {
    return _getManagedReasoningSupportForModel(this, preferredModel);
  }

  _normalizeManagedSessionPreferencePatch(preferences = {}, sessionId = '') {
    return _normalizeManagedSessionPreferencePatch(this, preferences, sessionId);
  }

  _normalizeManagedReasoningEfforts() {
    return _normalizeManagedReasoningEfforts(this);
  }

  async refreshStatusSnapshot() {
    return _refreshStatusSnapshot(this);
  }

  async listModels() {
    return _listModels(this);
  }

  async listModelsForEngine(engineType, options = {}) {
    return _listModelsForEngine(this, engineType, options);
  }

  async loadModel(model, options = {}) {
    return _loadModel(this, model, options);
  }

  _autoLoadDefaultModel() {
    return _autoLoadDefaultModel(this);
  }

  async unloadModel() {
    return _unloadModel(this);
  }

  async _unloadManagedModelForShutdown() {
    return _unloadManagedModelForShutdown(this);
  }

  async getHardwareVramUsage() {
    return _getHardwareVramUsage(this);
  }

  async getResidentModels() {
    return _getResidentModels(this);
  }

  async getOllamaModelBlob(modelId) {
    return _getOllamaModelBlob(this, modelId);
  }

  async listSessions() {
    return _listSessions(this);
  }

  getSessionSummariesForScheduler() {
    return this.sessionStore.listSessions();
  }

  getBackgroundRuntimeRoot() {
    return path.join(this.options.userDataPath, 'background-memory');
  }

  async createSession({ title, preferences, sessionType, providerAuthority, initialPrompt, linkedTaskId } = {}) {
    return _createSession(this, { title, preferences, sessionType, providerAuthority, initialPrompt, linkedTaskId });
  }

  async renameSession(sessionId, title) {
    return _renameSession(this, sessionId, title);
  }

  async deleteSession(sessionId) {
    return _deleteSessionWithQuiescence(this, sessionId);
  }

  async getSessionMessages(sessionId) {
    return _getSessionMessages(this, sessionId);
  }

  async setSessionPreferences(sessionId, preferences = {}) {
    return _setSessionPreferences(this, sessionId, preferences);
  }

  async setSessionMeta(sessionId, meta = {}) {
    return _setSessionMeta(this, sessionId, meta);
  }

  async sweepEmptySessions(options = {}) {
    return _sweepEmptySessions(this, options);
  }

  async updateSessionMessage(sessionId, messageId, patch = {}) {
    return _updateSessionMessage(this, sessionId, messageId, patch);
  }

  async editUserMessageAndTruncate(sessionId, messageId, payload = {}) {
    const normalizedSessionId = String(sessionId || '').trim();
    const normalizedMessageId = String(messageId || '').trim();
    if (!normalizedSessionId || !normalizedMessageId) return null;
    return this.sessionTurnActors.runSessionMutation(
      normalizedSessionId,
      'sessions.edit_and_truncate',
      () => null,
      () => _editUserMessageAndTruncate(this, normalizedSessionId, normalizedMessageId, payload),
      { requireIdle: true }
    );
  }

  dismissMemorySuggestion(fingerprint) {
    return _dismissMemorySuggestion(this, fingerprint);
  }

  isMemorySuggestionDismissed(fingerprint) {
    return _isMemorySuggestionDismissed(this, fingerprint);
  }

  async runBackgroundTask(task, params = {}) {
    return _runBackgroundTask(this, task, params);
  }

  trimDismissedMemoryFingerprints() {
    while (this._dismissedMemoryFingerprints.size > MAX_DISMISSED_MEMORY_FINGERPRINTS) {
      const oldest = this._dismissedMemoryFingerprints.values().next().value;
      if (!oldest) {
        break;
      }
      this._dismissedMemoryFingerprints.delete(oldest);
    }
  }

  async suggestMemoriesForSession(sessionId) {
    return _suggestMemoriesForSession(this, sessionId);
  }

  async getMemoryStatus() {
    return _getMemoryStatus(this);
  }

  async saveMemoryForSession(sessionId, candidate) {
    return _saveMemoryForSession(this, sessionId, candidate);
  }

  async listApprovedMemories() {
    return _listApprovedMemories(this);
  }

  async listPendingMemories() {
    return _listPendingMemories(this);
  }

  async updateApprovedMemory(memoryId, patch) {
    return _updateApprovedMemory(this, memoryId, patch);
  }

  async deleteApprovedMemory(memoryId) {
    return _deleteApprovedMemory(this, memoryId);
  }

  async deletePendingMemory(sessionId, contentFingerprint) {
    return _deletePendingMemory(this, sessionId, contentFingerprint);
  }

  async recallApprovedMemories(query, limit = 3) {
    return _recallApprovedMemories(this, query, limit);
  }

  async recallRecentApprovedMemories(lessonKind, limit = 2) {
    return _recallRecentApprovedMemories(this, lessonKind, limit);
  }

  async inspectHarness(options = {}) {
    return _inspectHarness(this, options);
  }

  async getJennyStatus(options = {}) {
    return _getJennyStatus(this, options);
  }


  getCodexCliState() {
    return this.codexCliRuntimeService.getState();
  }

  refreshCodexCliState() {
    return this.codexCliRuntimeService.refresh();
  }

  openCodexCliLoginTerminal() {
    return this.codexCliRuntimeService.openLoginTerminal();
  }

  async getPhasePercentilesSnapshot() {
    return this.phasePercentilesAggregator.snapshot();
  }

  getToolObservabilitySnapshot() {
    return this.toolObservabilityAggregator.snapshot();
  }

  async resetPhasePercentiles() {
    return this.phasePercentilesAggregator.reset();
  }

  async _resolveModel(preferredModel = '', preferredEngineType = '', ownStreamId = '') {
    return _resolveModel(this, preferredModel, preferredEngineType, ownStreamId);
  }

  async startChatStream({
    sessionId,
    prompt,
    visiblePrompt,
    traceId,
    preferredModel,
    reasoningEffort,
    attachments,
    interactiveResponse,
    interactiveRoundCount,
    planMode,
    contextPreferences,
    activeFileContext,
    mentionContents,
    toolPreferences,
    approvalMode,
    debugOptions,
    clientTiming, pluginCommandInvocation, skillInvocation, editedMessageId, failureRetry,
  }) {
    // IMG-D01/C3 + C2 admission (gpu_busy_image / session_type_mismatch).
    assertChatTurnAdmissible(this, sessionId);
    return _startLocalEngineChatStream(this, {
      sessionId,
      prompt,
      visiblePrompt,
      traceId,
      preferredModel,
      reasoningEffort,
      attachments,
      interactiveResponse,
      interactiveRoundCount,
      planMode,
      contextPreferences,
      activeFileContext,
      mentionContents,
      toolPreferences,
      approvalMode,
      debugOptions,
      clientTiming, pluginCommandInvocation, skillInvocation, editedMessageId, failureRetry,
    });
  }

  async editAndRegenerate(payload = {}) {
    const sessionId = String(payload.sessionId || '').trim();
    const editedMessageId = String(payload.editedMessageId || '').trim();
    const failureRetry = payload.failureRetry === true;
    if (!sessionId || !editedMessageId) {
      throw new TypeError('Edit-and-regenerate requires sessionId and editedMessageId.');
    }
    return this.startChatStream({
      ...payload,
      sessionId,
      editedMessageId,
      // Normalized, not conditionally spread: `...payload` above carries the
      // caller's raw value, so an absent spread would let a truthy non-boolean
      // ride through unchanged. Every consumer tests `=== true`, but a field
      // that only LOOKS boolean is how this codebase has repeatedly turned one
      // state into another by accident.
      failureRetry,
    });
  }

  async retryUnsavedReply(payload = {}) {
    return _retryUnsavedReply(this, payload);
  }

  async discardUnsavedReply(payload = {}) {
    return _discardUnsavedReply(this, payload);
  }

  cancelChatStream(streamId, reason) {
    const normalized = normalizeCancelReason(reason, CANCEL_REASON_USER);
    return _cancelChatStream(this, streamId, normalized);
  }

  async getActiveTurnState(sessionId) {
    return _getManagedActiveTurnState(this, sessionId);
  }

  // Manual/on-demand compaction (Settings "Compact now"). Passthrough of the
  // sidecar's chat.compact result; see backend-chat-stream.js for the guard +
  // message-mapping logic (kept there to stay under the file-size cap here).
  async compactContextNow(sessionId) {
    return _compactContextNow(this, sessionId);
  }

  approveToolCall(callId, options = {}) {
    return _approveToolCall(this, callId, options);
  }

  denyToolCall(callId) {
    return _denyToolCall(this, callId);
  }

  hasPendingUserQuestions(questionRef) {
    return _hasPendingUserQuestions(this, questionRef);
  }

  answerUserQuestions(questionRef, payload = {}) {
    return _answerUserQuestions(this, questionRef, payload);
  }

  declineUserQuestions(questionRef) {
    return _declineUserQuestions(this, questionRef);
  }

  async _initializeManagedSidecar(options = {}) {
    return _initializeManagedSidecarWithTimeout(this, options);
  }

  _abortManagedInitialization(reason) {
    return _abortManagedSidecarInitialization(this, reason);
  }

  _buildManagedSidecarConfig() {
    return _buildManagedSidecarConfig(this);
  }

  _buildManagedStatusSnapshot(overrides = {}) {
    return _buildLocalEngineStatusSnapshot(this, overrides);
  }

  async _restartManagedSidecar(reason) {
    return _restartManagedSidecar(this, reason);
  }

  async refreshManagedConfig(reason = 'config_updated', options = {}) {
    return _refreshManagedConfig(this, reason, options);
  }

  async _startManagedSidecarChatStream(opts) {
    return _startManagedSidecarChatStream(this, opts);
  }
}

module.exports = {
  MAX_DISMISSED_MEMORY_FINGERPRINTS,
  BackendService,
};
