const mainModuleEntryAt = Date.now(); // first executable line: anchors the cold-start audit's 'main-entry' mark
const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, powerMonitor, protocol, safeStorage, screen, session, shell } = require('electron');
// Agent/dev profile isolation must precede every require that can touch userData.
// This lets automation use a throwaway profile beside the user's real one.
const jennyUserDataDirOverride = String(process.env.JENNY_USER_DATA_DIR || '').trim();
if (jennyUserDataDirOverride) {
  app.setPath('userData', require('path').resolve(jennyUserDataDirOverride));
}
const { applySingleInstance, startWhenSingleInstanceAvailable } = require('./services/apply-single-instance');
const { createSuggestionCache, clearSuggestionCache } = require('./services/backend/backend-suggestions');
const { APP_USER_MODEL_ID, ensureDesktopShortcut } = require('./services/desktop-shortcut');
const { createCometOverlay } = require('./overlay-window');
const { createFeatureSettingsFacade } = require('./services/main/feature-settings-facade');
const { stopRuntimeWithDependencies } = require('./services/runtime-stop');
const { normalizeLogEntry, toPersistedMainLog } = require('./services/log-entry-normalizer');
const { createMainErrorHardening } = require('./services/main-error-hardening');
const { normalizeCrashDetail, readSidecarLogTail, showSidecarCrashDialog } = require('./services/sidecar-crash-dialog');
const { getBridgeChannel } = require('./services/ipc-contract');
const { createMainWindowStartupLifecycle } = require('./services/main-window-startup-lifecycle');
const { getWindowStateSnapshot } = require('./services/window-state-service');
const {
  buildSystemStatsPayload,
  createUnavailableGpuMemorySample,
  normalizeGpuMemorySample,
} = require('./services/system-stats-payload');
const { probeGpuTelemetry } = require('./services/gpu-telemetry-probe');
const { createGpuMemorySampleController } = require('./services/main/gpu-memory-sample');
const { MainLifecycleController, registerEmergencyShutdownHandlers, registerMainProcessLifecycleHandlers } = require('./services/main-lifecycle');
const {
  DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS,
  resolvePackagedSmokeConfig,
  shouldBypassSingleInstanceForPackagedSmoke,
  shouldUsePackagedSidecarRuntime,
  createPackagedSmokeController,
} = require('./services/main/packaged-smoke');
const { createStartupAudit } = require('./services/main/startup-audit');
const { createSetupReadinessProbe } = require('./services/main/setup-readiness');
const { createLogRedactionPrefixesProvider } = require('./services/main/client-log-forwarding');
const { createBackendServiceWithDeps } = require('./services/main/backend-service-wiring');
const mainIpcRegistration = require('./services/main/ipc-handler-registration');
const {
  handleCometOverlayToggle,
  normalizeCometOverlayPresencePayload,
} = require('./services/main/comet-overlay-controller');
const { createMainWindowWithDeps } = require('./services/main/main-window-composition');
const { createRuntimeServicesWithDeps } = require('./services/main/runtime-service-composition');
const { createRuntimeShutdownController } = require('./services/main/runtime-shutdown');
const { scheduleStartupRetentionTasks } = require('./services/main/startup-retention-tasks');
const dataLifecycleStartup = require('./services/main/data-lifecycle-startup');
const { registerArtifactFramePrivilegedScheme } = require('./services/artifact-frame-protocol');
const { PLUGIN_VIEW_PRIVILEGED_SCHEME } = require('./services/main/plugin-view-protocol');
const { installDefaultSessionWiring } = require('./services/main/default-session-wiring');
// Electron permits this registration only once and only before readiness.
registerArtifactFramePrivilegedScheme(protocol, [PLUGIN_VIEW_PRIVILEGED_SCHEME]);
const {
  shouldAutoStartMainProcess,
  shouldRefreshManagedConfigForShellConfigReason,
} = require('./services/main/main-process-policy');
let mainWindow;
let overlayRef = null; /* comet overlay companion (spike, default-off) */
let backendService;
let logStore;
let processLogWriter;
let personalityWorkspace;
let shellConfigService;
let schedulerService;
let weatherService;
let linkStatusService;
let calendarService;
let deferredServicesStarted = false;
let startDeferredBackgroundRefreshes = () => {};
let offlineIntelligenceService;
let companionService;
let systemStats;
let toolExecutor;
let toolPermissionStore;
let workspaceIdeSnapshotStore;
// Workspace child-process services (piped terminal, ConPTY, and test runner),
// created inside registerMainIpcHandlers and surfaced here for awaited quit.
let workspaceProcessServices = {};
let worktreeService;
let automationService;
let skillsService;
let knowledgeService;
let setupService;
let ollamaInstallService;
let mcpDiscoveryService;
let attachmentAssetStore;
let artifactService;
let mainLifecycle;
let tipsService;
let chatStreamBridge;
let usageHistory;
let updateService;
let windowStateService;
let windowStateDisplayUnsubscribe = null;
let mainErrorHardening;
const systemArch = String(process.arch || '').trim().toLowerCase();
// GPU telemetry is ambient — a slow idle cadence is plenty. The system-stats
// tick fires every 2s (CPU/RAM are cheap OS reads), and each tick calls
// refreshGpuMemorySample(). The GPU probe first asks the sidecar, then uses the
// direct platform path when the sidecar declines during generation. Direct idle
// probes can wake the GPU power state, so their cadence stays DECOUPLED from the
// 2s CPU/RAM tick and throttled to 15s. During generation the GPU is already
// awake, making the same bounded direct probe appropriate for fresh telemetry.
// Forced backend-ready and explicit IPC refreshes bypass the ambient throttle;
// manual refreshes retain their own tighter anti-spam guard for repeated clicks.
// This keeps the UI prompt without reintroducing frequent idle probe stutter.
// State (gpuMemorySample / refresh throttle) lives in gpu-memory-sample.js.
const gpuMemorySampleController = createGpuMemorySampleController({
  systemArch,
  createUnavailableGpuMemorySample,
  normalizeGpuMemorySample,
  buildSystemStatsPayload,
  probeGpuTelemetry,
  getBackendService: () => backendService,
  getStats: (opts) => (systemStats ? systemStats.getStats(opts) : null),
});
const { getCurrentSystemStatsPayload, refreshGpuMemorySample, resetGpuMemorySample } = gpuMemorySampleController;
const suggestionCache = createSuggestionCache();
const appStartupStartedAt = Date.now();
const getStartupElapsedMs = () => Math.max(Date.now() - appStartupStartedAt, 0);
let refreshElectronToolRegistry = () => {};
let runtimeShutdownController = null;
let displayMediaSourceHandler = null;
getBridgeChannel('diagnostics.reportRendererError', 'invoke');
// diagnostics:renderer-error is the canonical renderer error-reporting channel.
const RENDERER_READY_CHANNEL = getBridgeChannel('lifecycle.signalReady', 'send');
const {
  emitMainEntryMark,
  emitStartupAuditMark,
  flushStartupAuditMarks,
  getStartupAuditConfig,
  createStartupAuditMarkHandler,
  createStartupAuditMarksBatchHandler,
} = createStartupAudit({
  env: process.env,
  log: (level, event, details) => log(level, event, details),
  canLog: () => Boolean(logStore),
  getStartupElapsedMs,
});

const { probeSetupReadiness } = createSetupReadinessProbe({
  getBackendService: () => backendService,
  emitLog: (level, event, details) => log(level, event, details),
});
const PACKAGED_SMOKE_CONFIG = resolvePackagedSmokeConfig();
let packagedSmokeController = null;

const {
  applyFeatureSettingsPatch,
  buildEffectiveFeatureFlags,
  buildFeatureStatePayload,
  closeCometOverlayIfDisabled,
  isCometOverlayEnabled,
} = createFeatureSettingsFacade({
  env: process.env,
  platform: process.platform,
  getShellConfigService: () => shellConfigService,
  getBackendService: () => backendService,
  getOverlayRef: () => overlayRef,
  setOverlayRef: (nextOverlayRef) => {
    overlayRef = nextOverlayRef;
  },
  sendToWindow: (channel, payload) => sendToWindow(channel, payload),
});

function isPackagedSmokeEnabled() {
  return Boolean(PACKAGED_SMOKE_CONFIG.outputPath);
}

const getLogRedactionPrefixes = createLogRedactionPrefixesProvider({
  app, rootDir: __dirname, getShellConfigService: () => shellConfigService,
});

function log(level, event, details = {}) {
  const redactionPrefixes = getLogRedactionPrefixes();
  const entry = normalizeLogEntry({
    layer: 'electron',
    component: 'electron.main',
    level,
    event: String(event || 'electron.main.event').trim() || 'electron.main.event',
    details,
    data: details,
    message: String(details && details.message || '').trim() || String(details && details.error || '').trim() || (details && typeof details.line === 'string' ? details.line.trim() : '') || String(event || '').trim() || 'main event',
    status: String(details && details.status || '').trim() || 'ok',
    redaction_mode: 'redacted',
    redaction_prefixes: redactionPrefixes,
  });
  const persisted = logStore.append(toPersistedMainLog(level, entry));
  if (typeof logStore.getSnapshot === 'function') {
    return persisted;
  }
  if (processLogWriter && typeof processLogWriter.write === 'function') {
    processLogWriter.write(persisted);
  }
  sendBridgeEvent('logs.onAppend', persisted);
  return persisted;
}

function getMainWindowStatePayload() {
  if (windowStateService && typeof windowStateService.getWindowState === 'function') {
    return windowStateService.getWindowState(mainWindow);
  }
  return getWindowStateSnapshot(mainWindow);
}

function emitMainWindowStateChanged() {
  sendBridgeEvent('window.onStateChanged', getMainWindowStatePayload());
}

const createWindow = () => createMainWindowWithDeps({
  BrowserWindow,
  rootDir: __dirname,
  // A packaged executable carries its icon in the exe resources; an unpackaged
  // dev run has none, so point BrowserWindow at the build artwork explicitly.
  windowIconPath: app.isPackaged
    ? null
    : require('path').join(__dirname, 'build',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
  ipcMainRef: ipcMain,
  shell,
  windowStateService,
  mainErrorHardening,
  mainLifecycle,
  isPackagedSmokeEnabled,
  // GUI smokes (and any opt-in background launch) set JENNY_WINDOW_REVEAL_INACTIVE
  // so the window reveals via showInactive() — visible but not activated — and
  // never steals focus from a foreground full-screen app.
  revealWindowInactive: /^(1|true|yes|on)$/i.test(
    String(process.env.JENNY_WINDOW_REVEAL_INACTIVE || '').trim()
  ),
  getStartupElapsedMs,
  emitStartupAuditMark,
  log,
  emitMainWindowStateChanged,
  getMainWindow: () => mainWindow,
  setMainWindow: (nextWindow) => {
    mainWindow = nextWindow;
  },
  getWindowExitGuard: () => workspaceProcessServices.windowExitGuard,
  getInitialAppZoomFactor: () => {
    try {
      const percent = Number(shellConfigService?.getWindowUiState?.().appZoomPercent);
      return Number.isFinite(percent) && percent > 0 ? percent / 100 : 1;
    } catch (_error) {
      return 1;
    }
  },
  getPortableAppearance: () => dataLifecycleStartup.readPortableAppearance(app),
});

function sendToWindow(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(channel, payload);
}

function sendBridgeEvent(methodPath, payload) {
  sendToWindow(getBridgeChannel(methodPath, 'subscribe'), payload);
}

const createBackendService = () => {
  const created = createBackendServiceWithDeps({
    app,
    processRef: process,
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
    diagnosticLogService: logStore,
    getSystemStatsPayload: () => (systemStats ? getCurrentSystemStatsPayload() : null),
    getMainWindow: () => mainWindow,
    getPackagedSmokeController: () => packagedSmokeController,
    getLlamaServerManager: () => getRuntimeShutdownController().getLlamaServerManager(),
    buildEffectiveFeatureFlags,
    buildFeatureStatePayload,
    refreshGpuMemorySample,
    // #16: pass a live getter rather than the bare value -- refreshElectronToolRegistry
    // is a `let` assigned by createRuntimeServices() and the no-op default would be
    // captured here if construction order ever changed.
    getRefreshElectronToolRegistry: () => refreshElectronToolRegistry,
    shouldRefreshManagedConfigForShellConfigReason,
    closeCometOverlayIfDisabled,
    sendBridgeEvent,
    log,
    showSidecarCrashDialog,
    shouldUsePackagedSidecarRuntime,
  });
  backendService = created.backendService;
  schedulerService = created.schedulerService;
  weatherService = created.weatherService;
  linkStatusService = created.linkStatusService;
  calendarService = created.calendarService;
  offlineIntelligenceService = created.offlineIntelligenceService;
  companionService = created.companionService;
  tipsService = created.tipsService;
  chatStreamBridge = created.chatStreamBridge;
  startDeferredBackgroundRefreshes = created.startDeferredBackgroundRefreshes;
};

const createRuntimeServices = () => {
  const created = createRuntimeServicesWithDeps({
    app,
    BrowserWindow,
    nativeImage,
    powerMonitor,
    screen,
    shell,
    processRef: process,
    rootDir: __dirname,
    systemArch,
    previousWindowStateDisplayUnsubscribe: windowStateDisplayUnsubscribe,
    createUnavailableGpuMemorySample,
    onGpuMemoryReset: resetGpuMemorySample,
    getBackendService: () => backendService,
    getCurrentSystemStatsPayload,
    refreshGpuMemorySample,
    probeSetupReadiness,
    sendBridgeEvent,
    getMainWindow: () => mainWindow,
    getLlamaServerManager: () => getRuntimeShutdownController().getLlamaServerManager(),
    log,
    onCoreLoggingReady: (core) => {
      logStore = core.logStore;
      processLogWriter = core.processLogWriter;
    },
  });
  logStore = created.logStore;
  processLogWriter = created.processLogWriter;
  windowStateService = created.windowStateService;
  windowStateDisplayUnsubscribe = created.windowStateDisplayUnsubscribe;
  updateService = created.updateService;
  shellConfigService = created.shellConfigService;
  skillsService = created.skillsService;
  knowledgeService = created.knowledgeService;
  mcpDiscoveryService = created.mcpDiscoveryService;
  setupService = created.setupService;
  ollamaInstallService = created.ollamaInstallService;
  attachmentAssetStore = created.attachmentAssetStore;
  personalityWorkspace = created.personalityWorkspace;
  artifactService = created.artifactService;
  worktreeService = created.worktreeService;
  automationService = created.automationService;
  systemStats = created.systemStats;
  toolExecutor = created.toolExecutor;
  toolPermissionStore = created.toolPermissionStore;
  workspaceIdeSnapshotStore = created.workspaceIdeSnapshotStore;
  usageHistory = created.usageHistory;
  refreshElectronToolRegistry = created.refreshElectronToolRegistry;
};
function getProactiveStatePayload() {
  const state = shellConfigService.getState();
  return {
    toolsWorkspaceRoot: state.toolsWorkspaceRoot,
    workspaceRootStatus: shellConfigService.getWorkspaceRootStatus(),
    proactive: state.proactive,
  };
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

const registerWorkspaceIpcHandlers = (ipcMainLike = ipcMain, configService = shellConfigService) =>
  mainIpcRegistration.registerWorkspaceIpcHandlers(ipcMainLike, configService);

const registerWorkspaceRootIpcHandlers = (ipcMainLike = ipcMain, deps = {}) =>
  mainIpcRegistration.registerWorkspaceRootIpcHandlers(ipcMainLike, deps);

const registerGuidanceIpcHandlers = (ipcMainLike = ipcMain, skillService = skillsService, tipService = tipsService) =>
  mainIpcRegistration.registerGuidanceIpcHandlers(ipcMainLike, skillService, tipService);

const registerFeatureIpcHandlers = (ipcMainLike = ipcMain, deps = {}) =>
  mainIpcRegistration.registerFeatureIpcHandlers(ipcMainLike, deps);

const registerIpcHandlers = () => mainIpcRegistration.registerMainIpcHandlers({
  app,
  ipcMain,
  backendService,
  logStore,
  updateService,
  personalityWorkspace,
  artifactService,
  getProactiveStatePayload,
  shellConfigService,
  companionService,
  skillsService,
  knowledgeService,
  tipsService,
  suggestionCache,
  offlineIntelligenceService,
  applyFeatureSettingsPatch,
  dialog,
  getMainWindow: () => mainWindow,
  attachmentAssetStore,
  processRef: process,
  clipboard,
  log,
  getLlamaServerManager: () => getRuntimeShutdownController().getLlamaServerManager(),
  getMainLifecycle: () => mainLifecycle,
  getWindowState: getMainWindowStatePayload,
  startDeferredServices,
  toolExecutor,
  toolPermissionStore,
  usageHistory,
  setupService,
  ollamaInstallService,
  mcpDiscoveryService,
  schedulerService,
  weatherService,
  linkStatusService,
  calendarService,
  chatStreamBridge,
  getStartupAuditConfig,
  createStartupAuditMarkHandler,
  createStartupAuditMarksBatchHandler,
  refreshGpuMemorySample,
  getCurrentSystemStatsPayload,
  buildFeatureStatePayload,
  getOverlayRef: () => overlayRef,
  setOverlayRef: (nextOverlayRef) => {
    overlayRef = nextOverlayRef;
  },
  isCometOverlayEnabled,
  createCometOverlay,
  handleCometOverlayToggle,
  normalizeCometOverlayPresencePayload,
  trashItemImpl: (targetPath) => shell.trashItem(targetPath),
  showItemInFolderImpl: (targetPath) => shell.showItemInFolder(targetPath),
  openPathImpl: (targetPath) => shell.openPath(targetPath),
  sendBridgeEvent,
  workspaceSnapshotStore: workspaceIdeSnapshotStore,
  getDisplayMediaSourceHandler: () => displayMediaSourceHandler,
  getProcessLogWriter: () => processLogWriter,
  getDiagnosticLogService: () => logStore,
  getLogRedactionPrefixes,
});
function getRuntimeShutdownController() {
  if (!runtimeShutdownController) {
    runtimeShutdownController = createRuntimeShutdownController({
      app,
      processRef: process,
      rootDir: __dirname,
      clearSuggestionCache,
      suggestionCache,
      getShellConfigService: () => shellConfigService,
      getSystemStats: () => systemStats,
      getSchedulerService: () => schedulerService,
      getBackendService: () => backendService,
      getProcessLogWriter: () => processLogWriter,
      getWorkspaceTerminalService: () => workspaceProcessServices.workspaceTerminalService || null,
      getWorkspacePtyService: () => workspaceProcessServices.workspacePtyService || null,
      getWorkspaceRunTaskService: () => workspaceProcessServices.workspaceRunTaskService || null,
      getWorkspaceTestRunnerService: () => workspaceProcessServices.workspaceTestRunnerService || null,
      getSetupService: () => setupService,
      getOllamaInstallService: () => ollamaInstallService,
      getUpdateService: () => updateService,
      getWindowStateDisplayUnsubscribe: () => windowStateDisplayUnsubscribe,
      setWindowStateDisplayUnsubscribe: (unsubscribe) => {
        windowStateDisplayUnsubscribe = unsubscribe;
      },
      getPackagedSmokeController: () => packagedSmokeController,
      setPackagedSmokeController: (controller) => {
        packagedSmokeController = controller;
      },
      sendBridgeEvent,
      emitStartupAuditMark,
      log,
    });
  }
  return runtimeShutdownController;
}

const emitLifecycleProgress = (...args) => getRuntimeShutdownController().emitLifecycleProgress(...args);
const startLlamaServerBeforeBackend = () => getRuntimeShutdownController().startLlamaServerBeforeBackend();
const stopRuntimeBeforeQuit = () => {
  // Best-effort: tear down the display-media picker's pending IPC state
  // (installed onto session.defaultSession in app.whenReady) before the rest
  // of the awaited shutdown sequence runs. displayMediaSourceHandler is a
  // main.js-owned module-level service, so its disposal is co-located here
  // rather than threaded into runtime-shutdown.js's stopRuntimeBeforeQuit.
  try {
    displayMediaSourceHandler?.dispose();
    backendService?.modelFitObserver?.dispose();
  } catch (_error) {
    // best-effort only
  }
  return getRuntimeShutdownController().stopRuntimeBeforeQuit();
};
const runEmergencyRuntimeShutdownSync = () => getRuntimeShutdownController().runEmergencyRuntimeShutdownSync();
function startDeferredServices() {
  if (deferredServicesStarted) { return; }
  deferredServicesStarted = true;
  try {
    startDeferredBackgroundRefreshes();
    schedulerService.start();
    log('INFO', 'app.deferred_services_started', { startupMs: getStartupElapsedMs() });
  } catch (error) {
    log('WARN', 'app.deferred_services_failed', { message: String(error.message || error) });
  }
}

// #10: exit a failed startup through the graceful drain path when the lifecycle
// controller exists (so child procs/stores are stopped cleanly), falling back to
// a hard app.exit only when the failure happened before it was constructed (the
// sync emergency-exit handler still reaps any children in that case).
function requestMainProcessShutdown(exitCode = 1) {
  if (mainLifecycle && typeof mainLifecycle.requestEmergencyShutdown === 'function') return mainLifecycle.requestEmergencyShutdown({ exitCode });
  app.exit(exitCode);
}
function startMainProcess() {
  return startWhenSingleInstanceAvailable({
    acquireLock: () => (
      shouldBypassSingleInstanceForPackagedSmoke(PACKAGED_SMOKE_CONFIG)
      || applySingleInstance(app, focusMainWindow)
    ),
    onStart: () => {
      mainErrorHardening = createMainErrorHardening({
        app, processRef: process, log, stopRuntimeBeforeQuit,
        getMainLifecycle: () => mainLifecycle,
        emitFailedBackendStatus: (detail, context = {}) => {
          const normalizedDetail = String(detail || '').trim() || 'Unexpected runtime failure.';
          const baseStatus = backendService && typeof backendService.getBackendStatus === 'function' ? backendService.getBackendStatus() : {};
          sendBridgeEvent('backend.onStatus', { ...baseStatus, phase: 'failed', detail: normalizedDetail, failure_context: context });
        },
        unhandledFailureEvent: 'app.unhandled_failure',
      });
      mainErrorHardening.resetForStartup();
      mainErrorHardening.registerGlobalCrashGuards();
      app.whenReady().then(async () => {
        emitStartupAuditMark('electron-ready', { source: 'main' });
        if (process.platform === 'win32') {
          app.setAppUserModelId(APP_USER_MODEL_ID);
        }

        packagedSmokeController = createPackagedSmokeController({
          outputPath: PACKAGED_SMOKE_CONFIG.outputPath,
          timeoutMs: Number(PACKAGED_SMOKE_CONFIG.timeoutMs || DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS),
          requestShutdown: requestMainProcessShutdown,
          ipcMainRef: ipcMain,
          getWindow: () => mainWindow,
          getBackendStatus: () => (backendService ? backendService.getBackendStatus() : {}),
          readyChannel: RENDERER_READY_CHANNEL,
        });
        try {
          const mainSyncInitStartedAt = Date.now();
          emitMainEntryMark({ mainModuleEntryAt, appStartupStartedAt });
          await dataLifecycleStartup.promotePendingRestore(app, nativeImage, log);
          emitStartupAuditMark('main-sync-init-start', {
            source: 'main',
            ts_ms: mainSyncInitStartedAt,
            startupMs: Math.max(mainSyncInitStartedAt - appStartupStartedAt, 0),
          });
          createRuntimeServices();
          flushStartupAuditMarks();
          // Deny-by-default permission guard, display-media picker, and the
          // jenny-artifact:// preview protocol — see default-session-wiring.js.
          ({ displayMediaSourceHandler } = installDefaultSessionWiring({
            session: session.defaultSession,
            desktopCapturer,
            ipcMain,
            sendBridgeEvent,
            log,
          }));
          log('INFO', 'app.ready', { startupMs: getStartupElapsedMs() });
          if (/^(1|true|yes|on)$/i.test(String(process.env.JENNY_AGENT_DEV || '').trim())) {
            log('INFO', 'app.agent_mode_active', {
              userDataOverridden: Boolean(jennyUserDataDirOverride),
            });
          }
          emitStartupAuditMark('app-ready', { source: 'main' });
          // #11: the desktop shortcut refresh is not needed before first paint --
          // defer it off the pre-window critical path (it is also idempotent now,
          // skipping the .lnk rewrite when nothing changed).
          setImmediate(() => {
            try {
              ensureDesktopShortcut({ app, shell, logger: log });
            } catch (_shortcutError) {
              // ensureDesktopShortcut already logs failures; never block startup.
            }
          });
          createBackendService();
          scheduleStartupRetentionTasks({
            artifactService,
            backendService,
            attachmentAssetStore,
            log,
          });
          mainLifecycle = new MainLifecycleController({
            appQuit: () => app.quit(),
            appExit: (exitCode = 0) => app.exit(exitCode),
            stopRuntime: () => stopRuntimeBeforeQuit(),
          });
          registerMainProcessLifecycleHandlers(app, mainLifecycle);
          app.on('window-all-closed', () => {
            if (overlayRef) { overlayRef.dispose(); overlayRef = null; }
            log('INFO', 'app.window_all_closed');
          });
          workspaceProcessServices = registerIpcHandlers() || {};
          emitStartupAuditMark('main-sync-init-end', { source: 'main' });
          createWindow();
          systemStats.start();
          log('INFO', 'app.bootstrap_ready', { startupMs: getStartupElapsedMs() });
          const localServerReadyPromise = startLlamaServerBeforeBackend();
          emitStartupAuditMark('backend-start', { source: 'main' });
          await backendService.start({
            localServerReadyPromise,
            onProgress: (phase, detail) => {
              const startupController = getRuntimeShutdownController();
              const idx = startupController.startupStepIndex[phase] ?? 0;
              emitLifecycleProgress('startup', phase, detail, idx, startupController.startupStepCount);
            },
          });
          await dataLifecycleStartup.finalizeSuccessfulRestoredBoot(app, log);
          emitStartupAuditMark('backend-ready', { source: 'main' });
          if (packagedSmokeController) {
            packagedSmokeController.markBackendReady(backendService.getBackendStatus());
          } else {
            startDeferredServices();
          }
        } catch (error) {
          log('ERROR', 'backend.start_failed', {
            message: String(error.message || error),
          });
          emitLifecycleProgress('startup', 'ready', 'Startup failed', 6, getRuntimeShutdownController().startupStepCount,
            String(error.message || error));
          // Guard the deref: a throw inside createRuntimeServices() lands here
          // *before* backendService is assigned, so an unguarded
          // backendService.getBackendStatus() would raise a secondary TypeError
          // and the intended 'failed' status would never reach the UI.
          const baseStatus = backendService && typeof backendService.getBackendStatus === 'function'
            ? backendService.getBackendStatus()
            : {};
          const failedStatus = { ...baseStatus, phase: 'failed', detail: String(error.message || error) };
          sendBridgeEvent('backend.onStatus', failedStatus);
          if (packagedSmokeController) {
            packagedSmokeController.markBackendFailed(failedStatus, error.message || error);
          } else {
            requestMainProcessShutdown(1);
          }
        }

        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
          } else {
            focusMainWindow();
          }
        });
      }).catch((error) => {
        // Last-resort guard for anything that escapes the inner try/catch (a throw
        // before backendService exists, in the catch handler itself, or in the
        // post-try registration above). Without this, the rejection is only
        // swallowed by the global crash guard and the UI hangs on the connecting
        // screen with no 'failed' status. Surface it deterministically instead.
        const detail = String((error && error.message) || error || 'Unexpected startup failure.');
        log('ERROR', 'app.whenready_failed', { message: detail });
        const baseStatus = backendService && typeof backendService.getBackendStatus === 'function'
          ? backendService.getBackendStatus()
          : {};
        const failedStatus = { ...baseStatus, phase: 'failed', detail };
        sendBridgeEvent('backend.onStatus', failedStatus);
        if (packagedSmokeController) {
          packagedSmokeController.markBackendFailed(failedStatus, detail);
        } else {
          requestMainProcessShutdown(1);
        }
      });

      registerEmergencyShutdownHandlers(process, {
        onExit: () => {
          runEmergencyRuntimeShutdownSync();
        },
        onSignal: (signal) => {
          runEmergencyRuntimeShutdownSync();
          const exitCode = signal === 'SIGINT' ? 130 : 143;
          process.exit(exitCode);
        },
      });
    },
  });
}

if (shouldAutoStartMainProcess() && !dataLifecycleStartup.startUninstallAssistant(process.argv, __dirname)) {
  startMainProcess();
}

module.exports = {
  createMainWindowStartupLifecycle,
  handleCometOverlayToggle,
  isCometOverlayEnabled,
  normalizeCometOverlayPresencePayload,
  normalizeCrashDetail,
  registerFeatureIpcHandlers,
  readSidecarLogTail,
  registerGuidanceIpcHandlers,
  registerWorkspaceIpcHandlers,
  registerWorkspaceRootIpcHandlers,
  registerIpcHandlers,
  createPackagedSmokeController,
  resolvePackagedSmokeConfig,
  showSidecarCrashDialog,
  shouldUsePackagedSidecarRuntime,
  shouldAutoStartMainProcess,
  shouldRefreshManagedConfigForShellConfigReason,
  startMainProcess,
  stopRuntimeWithDependencies,
  stopRuntimeBeforeQuit,
};
