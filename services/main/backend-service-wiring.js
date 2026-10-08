const path = require('path');
const {
  DEFAULT_MANAGED_SHELL_MODEL,
  resolveLlamaServerSettings,
} = require('../backend/backend-config');
const { BackendService } = require('../backend/backend-service');
const { createIpcPayloadStore } = require('../backend/ipc-payload-store');
const { createTrackerForService } = require('../workspace-active-use-tracker');
const { resolvePackagedSidecarLaunchAsync } = require('../backend/packaged-sidecar-launch');
const { CalendarService } = require('../calendar-service');
const { createBackgroundJobTracker } = require('./background-job-tracker');
const { createSuggestedChangesService } = require('../backend/suggested-changes-wiring');
const { resolveChromiumSandboxStatus } = require('./chromium-sandbox-status');
const { BACKEND_UP_PHASES } = require('./packaged-smoke');
const { shouldBroadcastFeatureState } = require('./main-process-policy');
const { createChatStreamBridge } = require('../chat-stream-bridge');
const { isAwaitedFeatureSettingsCommit } = require('../feature-settings-service');
const { CompanionService } = require('../companion-service');
const { HomeAssistantService } = require('../home-assistant-service');
const { LinkStatusService } = require('../link-status-service');
const { OfflineIntelligenceService } = require('../offline-intelligence-service');
const { ProjectNotesService } = require('../project-notes-service');
const { ModelCatalogService } = require('../model-catalog-service');
const { ModelFitObservationStore } = require('../model-fit-observation-store');
const { ModelLoadDurationStore } = require('../model-load-duration-store');
const { createModelFitObserver } = require('../model-fit-observer');
const { formatDateKey } = require('../personality-workspace-service');
const { SchedulerService } = require('../scheduler-service');

function createBackendServiceWithDeps({
  app,
  processRef = process,
  safeStorage,
  dialog,
  shellConfigService,
  personalityWorkspace,
  toolExecutor,
  toolPermissionStore,
  attachmentAssetStore,
  artifactService,
  worktreeService,
  automationService,
  skillsService,
  knowledgeService,
  mcpDiscoveryService,
  setupService,
  usageHistory,
  logStore,
  diagnosticLogService = logStore,
  getSystemStatsPayload = () => null,
  getMainWindow = () => null,
  getPackagedSmokeController = () => null,
  // Managed llama-server manager getter (api key + base URL for the sidecar
  // secrets broker, status for diagnostics, ensureRunning for engine switch).
  getLlamaServerManager = () => null,
  buildEffectiveFeatureFlags = () => ({}),
  buildFeatureStatePayload = () => ({}),
  refreshGpuMemorySample = async () => null,
  getRefreshElectronToolRegistry = () => () => {},
  shouldRefreshManagedConfigForShellConfigReason = () => false,
  sendBridgeEvent = () => {},
  log = () => {},
  showSidecarCrashDialog = async () => null,
  shouldUsePackagedSidecarRuntime = () => false,
} = {}) {
  const initialFeatureFlags = buildEffectiveFeatureFlags();
  const usePackagedSidecarRuntime = shouldUsePackagedSidecarRuntime({
    appRef: app,
    resourcesPath: processRef.resourcesPath,
  });
  const configuredRepoRoot = String(processRef.env.JENNY_BACKEND_REPO || '').trim();
  const developmentRepoRoot = configuredRepoRoot
    || (typeof processRef.cwd === 'function' ? processRef.cwd() : process.cwd());
  const appRoot = typeof app.getAppPath === 'function'
    ? app.getAppPath()
    : developmentRepoRoot;
  const llamaServerSettings = resolveLlamaServerSettings({
    env: processRef.env,
    repoRoot: appRoot,
  });
  const pythonRuntimeBundleRoot = usePackagedSidecarRuntime
    ? processRef.resourcesPath
    : path.join(developmentRepoRoot, 'vendor');
  // Packaged-release launch validation (full-binary SHA-256 + `--version` probe)
  // is deferred behind an async resolver so it runs inside the awaited
  // backendService.start() phase -- after the window exists -- rather than
  // blocking first paint synchronously at construction. The cheap packaged-mode
  // determination above stays synchronous (it only gates repoRoot/python below).
  const resolvePackagedLaunch = usePackagedSidecarRuntime
    ? async () => {
      const packagedSidecarLaunch = await resolvePackagedSidecarLaunchAsync({
        resourcesPath: processRef.resourcesPath,
      });
      if (packagedSidecarLaunch) {
        log(packagedSidecarLaunch.ok ? 'INFO' : 'WARN', 'sidecar.packaged_launch_resolved', {
          launchSource: packagedSidecarLaunch.launchSource,
          detail: packagedSidecarLaunch.packagedLaunchDetail || packagedSidecarLaunch.failureReason || '',
          artifactPath: packagedSidecarLaunch.artifactPath || '',
          manifestPath: packagedSidecarLaunch.manifestPath || '',
          ok: packagedSidecarLaunch.ok === true,
        });
      }
      return packagedSidecarLaunch;
    }
    : null;
  const chromiumSandbox = resolveChromiumSandboxStatus({
    platform: processRef.platform || process.platform,
    isPackaged: app.isPackaged === true,
    hasSwitch: typeof app.commandLine?.hasSwitch === 'function'
      ? (name) => app.commandLine.hasSwitch(name)
      : null,
    env: processRef.env,
    execPath: processRef.execPath || process.execPath,
  });
  if (chromiumSandbox.packaged && chromiumSandbox.sandboxed === false) {
    log('WARN', 'chromium.sandbox_disabled', {
      reason: chromiumSandbox.reason,
      package_kind: chromiumSandbox.package_kind,
      platform: chromiumSandbox.platform,
    });
  }
  // The optional PDF reading add-on (PyMuPDF, AGPL-3.0; never bundled). Built
  // before the backend so the first sidecar spawn already carries its directory.
  const { PdfAddonService } = require('../pdf-addon-service');
  const pdfAddon = new PdfAddonService({
    userDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged === true,
    platform: processRef.platform,
    getBackend: () => backendService,
    showOpenDialog: (options) => {
      const owner = getMainWindow();
      return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
    },
    logger: log,
  });
  const { ImageEngineService } = require('../image-engine-service');
  const imageEngine = new ImageEngineService({
    userDataPath: app.getPath('userData'), platform: processRef.platform, logger: log,
  });
  const backendService = new BackendService({
    appVersion: app.getVersion(),
    // Source setup forwards this process-only choice through start.js.
    skipOllamaAutoStart: Array.isArray(processRef.argv) && processRef.argv.includes('--existing-server'),
    chromiumSandbox,
    userDataPath: app.getPath('userData'),
    repoRoot: usePackagedSidecarRuntime ? undefined : (configuredRepoRoot || undefined),
    pythonExecutable: usePackagedSidecarRuntime ? undefined : (String(processRef.env.JENNY_BACKEND_PYTHON || '').trim() || undefined),
    pythonRuntimeBundleRoot,
    enableInteractiveStreamDebug: /^(1|true|yes)$/i.test(
      String(processRef.env.JENNY_INTERACTIVE_DEBUG || '').trim()
    ),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    managedLlamaServerProfile: llamaServerSettings.profileError
      ? null
      : llamaServerSettings.profile,
    getLlamaServerManager,
    configService: shellConfigService,
    personalityWorkspace,
    safeStorage,
    isSafeStorageReady: () => typeof app.isReady !== 'function' || app.isReady(),
    toolExecutor,
    toolPermissionStore,
    attachmentAssetStore,
    // Reference-counted retention for the sidecar's externalized tool payloads.
    // Built HERE rather than in runtime-service-composition so main.js needs no
    // new wiring line (it is at its line ceiling): both consumers reach the store
    // through the BackendService -- cleanupDeletedSession reads
    // service.ipcPayloadStore, and the startup orphan sweep reads it off the same
    // service. The store derives <userData>/background-memory/ipc-payloads itself.
    ipcPayloadStore: createIpcPayloadStore({ userDataPath: app.getPath('userData') }),
    artifactService,
    worktreeService,
    automationService,
    skillsService,
    knowledgeService,
    mcpDiscoveryService,
    setupService,
    usageHistory,
    shellLogStore: logStore,
    systemStatsProvider: getSystemStatsPayload,
    appMemoryProvider: () => {
      try {
        if (typeof app.getAppMetrics !== 'function') return null;
        return process.memoryUsage().rss + app.getAppMetrics()
          .filter((metric) => metric.pid !== process.pid)
          .reduce((bytes, metric) => {
            if (!Number.isFinite(metric.memory?.workingSetSize)) throw new Error('App memory metric is unavailable.');
            return bytes + metric.memory.workingSetSize * 1024;
          }, 0);
      } catch { return null; }
    },
    featureFlags: initialFeatureFlags,
    bundledSkillsRoot: skillsService ? skillsService.getBundledRoot() : '',
    resolvePackagedLaunch,
    resolveSidecarExtraEnv: () => pdfAddon.sidecarEnv(),
  });
  backendService.pdfAddon = pdfAddon;
  // workspace_present outcomes: the IDE's reports reach the originating tool
  // row (late-event audit) and the session's next context assembly.
  const workspacePresentationService = toolExecutor?.workspacePresentationService || null;
  backendService.workspacePresentationService = workspacePresentationService;
  workspacePresentationService?.setOutcomeListener?.((sessionId, callId, lateEvent) => {
    backendService._appendLateEventAudit(sessionId, callId, lateEvent);
  });
  pdfAddon.on('changed', (state) => sendBridgeEvent('pdfAddon.onChanged', state));
  void pdfAddon.start().catch(() => {});
  const { ExclusiveGpuCoordinator } = require('../backend/exclusive-gpu-coordinator');
  const { createChatGpuHandoff } = require('../backend/chat-gpu-handoff');
  const { reconcileRenderRecord, killRenderRecordSync } = require('../image-engine-pidfile');
  backendService.imageEngine = imageEngine;
  imageEngine.on('changed', (state) => sendBridgeEvent('imageEngine.onChanged', state));
  imageEngine.start();
  backendService.exclusiveGpuCoordinator = backendService.exclusiveGpuCoordinator || new ExclusiveGpuCoordinator({ logger: log });
  backendService.chatGpuHandoff = createChatGpuHandoff({
    backendService, coordinator: backendService.exclusiveGpuCoordinator, getLlamaServerManager,
    reconcileRenderProcesses: () => reconcileRenderRecord({ userDataPath: app.getPath('userData'), log }),
    log,
  });
  backendService.imageEngineRuntime = {
    killRenderSync: () => killRenderRecordSync({ userDataPath: app.getPath('userData'), log }),
  };
  const { DesktopSandboxService } = require('../execution/desktop-sandbox-service');
  backendService.commandSandbox = new DesktopSandboxService({
    userDataPath: app.getPath('userData'),
    sourceRoot: app.isPackaged ? path.join(processRef.resourcesPath, 'command-worker') : appRoot,
    configService: shellConfigService, getBackend: () => backendService,
    platform: processRef.platform, logger: log,
  });
  backendService.commandSandbox.on('changed', (state) => sendBridgeEvent('commandSandbox.onChanged', state));
  void backendService.commandSandbox.start().catch(() => {});
  // Row 41: idle-gated semantic catalog over the knowledge folders (inert until
  // the user picks an embedding model; JENNY_ENABLE_SEMANTIC_CATALOG=0 off).
  require('./semantic-catalog-wiring').wireSemanticCatalog({
    backendService, shellConfigService, knowledgeService, buildEffectiveFeatureFlags,
    userDataPath: app.getPath('userData'), resourcesPath: processRef.resourcesPath || '', appRoot, log,
    sendBridgeEvent,
  });
  backendService.workspaceActiveUseTracker = createTrackerForService(backendService, {
    app,
    getWindow: getMainWindow,
  });
  if (mcpDiscoveryService && typeof mcpDiscoveryService.setBackendService === 'function') {
    mcpDiscoveryService.setBackendService(backendService);
  }
  const schedulerService = new SchedulerService({
    userDataPath: app.getPath('userData'),
    configService: shellConfigService,
    backendService,
    backgroundRuntimeRoot: backendService.getBackgroundRuntimeRoot(),
    logger: log,
  });
  const modelCatalogService = new ModelCatalogService({
    cachePath: path.join(app.getPath('userData'), 'model-recommendation-catalog.json'),
    remoteUrl: String(processRef.env.JENNY_MODEL_CATALOG_URL || '').trim() || undefined,
    logger: log,
  });
  // Wave 4 "record on first load, then self-catalog": the store persists
  // measured Ollama footprints across restarts; the observer watches
  // backend-status for a newly-ready Ollama model and polls until it shows
  // up resident, then records it.
  const modelFitObservationStore = new ModelFitObservationStore({
    filePath: path.join(app.getPath('userData'), 'model-fit-observations.json'),
    logger: log,
  });
  const offlineIntelligenceService = new OfflineIntelligenceService({
    configService: shellConfigService,
    backendService,
    modelCatalogService,
    modelFitObservationStore,
  });
  const modelFitObserver = createModelFitObserver({
    backendService,
    store: modelFitObservationStore,
    getHardwareProfile: async () => {
      try {
        const { getHardwareProfile } = require('../backend/backend-runtime');
        return await getHardwareProfile(backendService, {});
      } catch (_) {
        return null;
      }
    },
    logger: log,
  });
  // Small additive hook (see services/model-tuning-service.js): a successful
  // context-length apply for the active model should re-observe under the
  // new context, rather than waiting for the next natural reload.
  backendService.modelFitObserver = modelFitObserver;
  // Per-model last-load memory read by local-engine-status.js at the
  // loading -> ready transition and surfaced as model_acquisition.last_load_ms
  // for the health popover's "Last time" line. Bounded (20 pairs), never throws.
  backendService.modelLoadDurationStore = new ModelLoadDurationStore({
    filePath: path.join(app.getPath('userData'), 'model-load-durations.json'),
    logger: log,
  });
  const companionService = new CompanionService({
    configService: shellConfigService,
    personalityWorkspace,
    listSessionSummaries: () =>
      backendService && backendService.sessionStore
        ? backendService.sessionStore.listSessions()
        : null,
    listSessionRecords: () =>
      backendService && backendService.sessionStore
        && typeof backendService.sessionStore.listSessionRecords === 'function'
        ? backendService.sessionStore.listSessionRecords()
        : [],
    getWorkspaceState: () => shellConfigService.getWorkspaceState(),
    formatDateKey,
    taskLifecycleEnabled: () => buildEffectiveFeatureFlags().task_lifecycle === true,
    taskBoardEnabled: () => buildEffectiveFeatureFlags().tools_task_board_enabled === true,
  });
  backendService.offlineIntelligenceService = offlineIntelligenceService;
  backendService.setFeatureFlags(initialFeatureFlags);
  skillsService.on('changed', (state) => {
    sendBridgeEvent('skills.onChanged', state);
  });
  if (knowledgeService && typeof knowledgeService.on === 'function') {
    knowledgeService.on('changed', (snapshot) => {
      sendBridgeEvent('knowledge.onChanged', snapshot);
    });
  }
  schedulerService.on('changed', (snapshot) => {
    sendBridgeEvent('scheduler.onChanged', snapshot);
  });
  // Home dashboard link-tile status dots. Polls only explicit `siteMonitor`
  // URLs (never tile hrefs), so no traffic until a tile opts in. The timer is
  // unref'd, so no explicit shutdown threading is required (no locks,
  // watchers, or pending writes).
  const linkStatusService = new LinkStatusService({
    configService: shellConfigService,
    logger: log,
  });
  linkStatusService.on('changed', (state) => {
    sendBridgeEvent('linkStatus.onChanged', state);
  });
  linkStatusService.start({ deferInitialRefresh: true });
  // Home dashboard calendar: local events in <userData>/home-calendar.json
  // plus read-only ICS feed polling (config `home.calendar.feeds`, refreshed
  // on `home_config_updated`). Same unref'd-timer rationale as link-status;
  // event mutations write-immediate, so no shutdown threading.
  const calendarService = new CalendarService({
    userDataPath: app.getPath('userData'),
    configService: shellConfigService,
    logger: log,
  });
  calendarService.on('changed', (state) => {
    sendBridgeEvent('calendar.onChanged', state);
  });
  calendarService.start({ deferInitialRefresh: true });
  // The `home` tool's only write path. It wraps the calendar and shell-config
  // services so every assistant-made Home change is attributed and lands in
  // the undo journal at <userData>/home-ai-journal.json. Entity state still
  // rides the existing calendar.onChanged / proactive channels; this event
  // carries only the journal + reminder snapshot the Home undo strip reads.
  const homeAssistantService = new HomeAssistantService({
    userDataPath: app.getPath('userData'),
    calendarService,
    configService: shellConfigService,
    logger: log,
  });
  homeAssistantService.on('changed', (payload) => {
    sendBridgeEvent('home.onAiChanged', payload);
  });
  // Published on the backend service (the offlineIntelligenceService
  // precedent above) so main.js needs no module-level slot: the tool executor's
  // live getter and the IPC handler deps both reach it through getBackendService.
  backendService.homeAssistantService = homeAssistantService;
  // Per-project scratch note (<userData>/project-notes/<projectId>.json). The
  // renderer note editor and the note tool both write through this service;
  // it publishes on the backend service like homeAssistantService above.
  const projectNotesService = new ProjectNotesService({
    userDataPath: app.getPath('userData'),
    logger: log,
    // Hosts without a project service (minimal embedded/test hosts) fail open.
    projectExists: (projectId) => (typeof backendService.projectService?.get === 'function'
      ? Boolean(backendService.projectService.get(projectId))
      : true),
  });
  projectNotesService.on('changed', (payload) => {
    sendBridgeEvent('projectNotes.onChanged', payload);
  });
  backendService.projectNotesService = projectNotesService;
  const chatStreamBridge = createChatStreamBridge({
    sendBridgeEvent,
    log,
    usageHistory,
  });

  backendService.on('backend-status', (status) => {
    log('INFO', 'backend.status', {
      phase: status.phase,
      detail: status.detail || '',
      startupStage: status.startupStage || '',
      startupMs: Number(status.startupMs || 0),
      progressLogCount: Number(status.progressLogCount || 0),
      launchSource: status.launchSource || '',
      packagedLaunchDetail: status.packagedLaunchDetail || '',
    });
    sendBridgeEvent('backend.onStatus', status);
    const packagedSmokeController = getPackagedSmokeController();
    if (packagedSmokeController && status && status.phase === 'failed') {
      packagedSmokeController.markBackendFailed(status, status.detail || '');
    }
    // start() can return while the startup model load still holds the phase
    // at sidecar_spawned; the ready (or, without a model, model_unavailable)
    // status that follows completes the smoke.
    if (packagedSmokeController && status && BACKEND_UP_PHASES.has(status.phase)) {
      packagedSmokeController.markBackendReady?.(status);
    }
    if (status && status.phase === 'ready') {
      void refreshGpuMemorySample({ force: true }).catch(() => null);
    }
  });

  // W2-2 background-job visibility: tool results carrying a
  // metadata.background_job_id register here; the tracker polls the job's
  // status.json and pushes chip snapshots over the bridge-event bus (the
  // chat stream is turn-scoped and cannot carry a job that outlives its
  // call). Poll timer is unref'd — no shutdown threading needed.
  // Each job carries its turn's execution root from registration; there is
  // no global-root fallback (a project-bound job would be polled elsewhere).
  const backgroundJobTracker = createBackgroundJobTracker({
    sendBridgeEvent,
    log,
  });
  backendService.backgroundJobTracker = backgroundJobTracker;
  backendService.on('background-job-started', (info) => {
    backgroundJobTracker.registerJob(info || {});
  });

  // Propose-mode suggestions (row 35): Electron owns the per-session record;
  // accept applies one suggestion through the sidecar's journaled write.
  backendService.suggestedChanges = createSuggestedChangesService({
    backendService, emit: (event) => sendBridgeEvent('suggestedChanges.onChanged', event), log,
  });

  backendService.on('auth-state', (state) => {
    log('INFO', 'auth.state', {
      authenticated: Boolean(state.authenticated),
      userPresent: Boolean(state.user && state.user.email),
    });
    sendBridgeEvent('auth.onState', state);
  });

  backendService.on('chat-stream', (event) => {
    chatStreamBridge.handleEvent(event);
  });

  backendService.on('service-log', (entry) => {
    log(entry.level || 'INFO', entry.event || 'backend.service', entry.details || {});
  });

  backendService.on('diagnostic-entry', (entry) => {
    if (entry?.event === 'sidecar.diagnostics.oversized_record') {
      diagnosticLogService?.recordDrop?.('sidecar', Number(entry?.data?.dropped_count) || 1);
    }
    diagnosticLogService?.append?.(entry, { broadcast: true, persist: true });
  });

  backendService.on('diagnostic-drop', (drop) => {
    diagnosticLogService?.recordDrop?.(drop?.source, drop?.count);
  });

  backendService.on('sidecar-crash', ({ detail }) => {
    void showSidecarCrashDialog({
      appVersion: app.getVersion(),
      dialogImpl: dialog,
      detail,
      ownerWindow: getMainWindow(),
    }).catch(() => null);
  });

  shellConfigService.on('changed', async (_state, context = {}) => {
    if (
      context.reason === 'tools_worktree_enabled_updated'
      || context.reason === 'feature_settings_updated'
    ) {
      getRefreshElectronToolRegistry()?.();
    }
    if (shouldBroadcastFeatureState(context.reason, context.reasons)) {
      sendBridgeEvent('features.onChanged', buildFeatureStatePayload());
    }
    if (
      isAwaitedFeatureSettingsCommit(shellConfigService)
      || !shouldRefreshManagedConfigForShellConfigReason(context.reason, context.reasons)
    ) {
      return;
    }
    try {
      await backendService.refreshManagedConfig(context.reason);
    } catch (_error) {
      // backendService logs refresh failures
    }
  });

  let deferredBackgroundRefreshesStarted = false;
  function startDeferredBackgroundRefreshes() {
    if (deferredBackgroundRefreshesStarted) {
      return;
    }
    deferredBackgroundRefreshesStarted = true;
    const refreshes = [
      ['model_catalog', () => modelCatalogService.refresh()],
      ['link_status', () => linkStatusService.refresh()],
      ['calendar', () => calendarService.refreshFeeds()],
    ];
    for (const [service, refresh] of refreshes) {
      void Promise.resolve()
        .then(refresh)
        .catch((error) => {
          try {
            log('WARN', 'background_refresh.failed', {
              service,
              message: String((error && error.message) || error).slice(0, 256),
            });
          } catch (_error) {
            // logging must never throw
          }
        });
    }
  }

  return {
    backendService,
    backgroundJobTracker,
    calendarService,
    chatStreamBridge,
    companionService,
    homeAssistantService,
    projectNotesService,
    offlineIntelligenceService,
    modelCatalogService,
    modelFitObserver,
    linkStatusService,
    schedulerService,
    startDeferredBackgroundRefreshes,
  };
}

module.exports = {
  createBackendServiceWithDeps,
};
