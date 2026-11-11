const path = require('path');
const { EventEmitter } = require('events');

const { version: DEFAULT_APP_VERSION } = require('../../package.json');
const {
  getAuthState: _getAuthState,
  restoreAuthState: _restoreAuthState,
  updateLocalProfile: _updateLocalProfile,
} = require('./backend-auth');
const { handleChatStreamEnd: _handleChatStreamEnd } = require('./backend-chat-stream');
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
  resolveCodexCommandPath,
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
  createCancellationError,
} = require('./chat-stream-terminal-utils');
const { isolateActiveStreamAbort } = require('./active-stream-shutdown-drain');
const { createApprovedCallGrants } = require('./runtime-approved-call-grants');
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
const { chatMethods } = require('./backend-service-chat-methods');
const { memoryMethods } = require('./backend-service-memory-methods');
const { sessionMethods } = require('./backend-service-session-methods');
const {
  inferEngineTypeFromModel,
} = require('./backend-service-utils');
const {
  getManagedReasoningSupportForModel: _getManagedReasoningSupportForModel,
} = require('./backend-managed-reasoning');
const { drainSessionStoresSync } = require('./session-store-drain');
const { OllamaProcessManager, runOllamaDisposeForceKillSweep } = require('./ollama-process-manager');
const { VLLMProcessManager } = require('./vllm-process-manager');
const { SidecarManager } = require('./sidecar-manager');
const { SecureStore } = require('./secure-store');
const { getAllSchemaVersions } = require('./schema-version-registry');
const { createProviderIntegrationRegistry } = require('./provider-integrations');
const { createUnavailableSetupState } = require('../setup-service');
const { createHostPorts } = require('../host/host-ports');
const {
  initializeConversationStorage,
} = require('./backend-conversation-storage');
const { backfillTaskBoardProjects } = require('./task-board-project-backfill');
const { createServiceLogBuffer } = require('./service-log-buffer');
class BackendService extends EventEmitter {
  constructor(options) {
    super();
    options = options && typeof options === 'object' ? options : {};
    this.options = options;
    this._earlyServiceLogs = createServiceLogBuffer();
    // Host ports are pure policy. Desktop callers with no host options retain
    // the existing managed-engine behavior; server callers inject their
    // credential service and explicitly opt into external engine ownership.
    this.hostPorts = createHostPorts({
      hostMode: options.hostMode,
      credentialService: options.credentialService,
    });
    this.hostMode = this.hostPorts.mode;
    const emitLog = (level, event, details) => this._emitServiceLog(level, event, details);
    const appVersion = String(options.appVersion || '').trim();
    this.appVersion = appVersion || String(DEFAULT_APP_VERSION || '').trim();
    this.currentModel = '';
    // Preferred-engine override wins over model-based inference: lets the
    // picker show openai-compatible (llama-server) models at boot even
    // while the default model string still implies ollama.  Empty = infer.
    const preferredEngineType = String(
      options.preferredEngineType
      || options.modelEndpoint?.engine
      || options.configService?.getState?.()?.preferredEngineType
      || ''
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
    this.ollamaManager = options.ollamaManager || new OllamaProcessManager({
      logger: emitLog,
      userDataPath: options.userDataPath,
      resolveChatEngineType: () => this.currentEngineType,
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
    this.vllmManager = options.vllmManager || new VLLMProcessManager({
      logger: emitLog,
      userDataPath: options.userDataPath,
      model: this.currentEngineType === 'vllm' ? String(options.defaultModel || '').trim() : '',
    });
    this.defaultModel = String(options.defaultModel || '').trim();
    this.reasoningEffortSupport = 'unknown';
    this.accessToken = '';
    this.activeStreams = new Map();
    this.pendingToolApprovals = new Map();
    this.approvedCallGrants = createApprovedCallGrants();
    this.pendingUserQuestions = new Map();
    this.on('chat-stream', (event) => _handleChatStreamEnd(this, event));
    this.enableInteractiveStreamDebug = Boolean(options.enableInteractiveStreamDebug);
    this.personalityWorkspace = options.personalityWorkspace || null;
    this.configService = options.configService || null;
    this.skillsService = options.skillsService || null;
    this.knowledgeService = options.knowledgeService || null;
    this.mcpDiscoveryService = options.mcpDiscoveryService || null;
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
    this.appMemoryProvider = typeof options.appMemoryProvider === 'function'
      ? options.appMemoryProvider
      : null;
    this.attachmentAssetStore = options.attachmentAssetStore || null;
    // Read by cleanupDeletedSession's ipc_payloads step. Without this the
    // whole reference-counted payload cleanup is dead code in production.
    this.ipcPayloadStore = options.ipcPayloadStore || null;
    this.artifactService = options.artifactService || null;
    this.worktreeService = options.worktreeService || null;
    this.automationService = options.automationService || null;
    this.secureStore = options.credentialService || new SecureStore({
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
    if (typeof this.configService?.stampFollowUpProjects === 'function') {
      backfillTaskBoardProjects({ configService: this.configService, sessionStore: this.sessionStore, logger: emitLog });
    }
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
      autoRefresh: this.hostMode !== 'server',
    });
    this.sidecarManager = options.sidecarManager || new SidecarManager({
      mode: 'managed-dev',
      userDataPath: options.userDataPath,
      runtimeHome: this.hostMode === 'server' ? options.runtimeHome : null,
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
      resolveExtraEnv: options.resolveSidecarExtraEnv,
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
    require('../projects/application-execution-composition').initializeSessionExecutionAuthority(this);
    require('../session-runtime/composition').initializeSessionRuntimeComposition(this);
    this._electronToolGeneratedArtifactsByCall = new Map();
    this._disposed = false;
    this._sidecarClientErrorListener = null;
    this._sidecarClientLateNotificationListener = null;
    this._sidecarClientMonitorNotificationListener = null;
    this._handleSidecarStatus = this._handleSidecarStatus.bind(this);
    this._handleSidecarLog = this._handleSidecarLog.bind(this);

    this._autoReconnectPending = false;
    this._autoReconnectAttempted = false;
    this._managedReadyOnce = false;
    // The sidecarManager.process the managed client was last initialized for;
    // see managedInitializedForCurrentProcess in local-engine-status.js.
    this._managedInitializedProcess = null;
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
    try { this.sessionRuntime?.workLeases?.close?.(); } catch (_) { /* best effort */ }
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
    if (this.hostPorts?.posture?.ownsEngineLifecycle !== false) {
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
      credentialStore: typeof this.secureStore?.getStatus === 'function'
        ? this.secureStore.getStatus()
        : { status: 'unavailable', ready: false },
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
    this.sessionRuntime?.setEnabled?.(this.featureFlags.session_runtime === true);
    return { ...this.featureFlags };
  }

  getAuthState() {
    return _getAuthState(this);
  }

  _emitServiceLog(level, event, details = {}) {
    const entry = { level: String(level || 'INFO').toUpperCase(), event: String(event || 'service.event'), details };
    if (this.listenerCount('service-log') === 0 && this._earlyServiceLogs?.hold(entry)) return;
    this.emit('service-log', entry);
  }

  // Logs emitted before the host listened (constructor-time runtime recovery);
  // the host replays them once, right after it attaches its listener.
  drainEarlyServiceLogs() {
    return this._earlyServiceLogs?.drain() || [];
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

  async unloadModel(options) {
    return _unloadModel(this, options);
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

















  async runBackgroundTask(task, params = {}) {
    return _runBackgroundTask(this, task, params);
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

}

// The chat, memory and session delegates live in backend-service-*-methods.js;
// install them on the prototype so the class surface (and test stubs on it) is unchanged.
for (const methods of [chatMethods, memoryMethods, sessionMethods]) {
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(BackendService.prototype, name, {
      value: method,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

module.exports = {
  BackendService,
  resolveCodexCommandPath,
};
