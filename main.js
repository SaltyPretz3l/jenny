const mainModuleEntryAt = Date.now(); // first executable line: anchors the cold-start audit's 'main-entry' mark
const { app, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, dialog, ipcMain, Menu, nativeImage, powerMonitor, protocol, safeStorage, screen, session, shell } = require('electron');
// Agent/dev profile isolation must precede every require that can touch userData.
// This lets automation use a throwaway profile beside the user's real one.
const jennyUserDataDirOverride = String(process.env.JENNY_USER_DATA_DIR || '').trim();
if (jennyUserDataDirOverride) {
  app.setPath('userData', require('path').resolve(jennyUserDataDirOverride));
}
// Route this process before the module graph below loads: a second launch takes
// the single-instance lock here (waking the running window) and exits at once.
const { MAIN_BOOT_MODES, resolveMainBootMode } = require('./services/main/main-boot-gate');
const {
  DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS,
  resolvePackagedSmokeConfig,
  shouldUsePackagedSidecarRuntime,
  createPackagedSmokeController,
} = require('./services/main/packaged-smoke');
const PACKAGED_SMOKE_CONFIG = resolvePackagedSmokeConfig();
const mainBootMode = resolveMainBootMode({
  app, packagedSmokeConfig: PACKAGED_SMOKE_CONFIG, onSecondInstance: () => focusMainWindow(),
});
// V8 compile cache for the module graph below, under the settled userData path
// (NODE_DISABLE_COMPILE_CACHE=1 turns it off; runtimes without it no-op).
if (mainBootMode === MAIN_BOOT_MODES.PRIMARY) {
  const nodeModule = require('node:module');
  if (typeof nodeModule.enableCompileCache === 'function') {
    try {
      nodeModule.enableCompileCache(require('path').join(app.getPath('userData'), 'compile-cache'));
    } catch (_error) {
      // Only a startup speedup: never block launch on it.
    }
  }
}
const { revealExistingWindow, startWhenSingleInstanceAvailable } = require('./services/apply-single-instance');
const { ensureDevPreloadBundle } = require('./services/main/dev-preload-bundle');
const { createSuggestionCache, clearSuggestionCache } = require('./services/backend/backend-suggestions');
const { ensureDesktopShortcut, ensureDevStartMenuShortcut, resolveAppUserModelId } = require('./services/desktop-shortcut');
const { createFeatureSettingsFacade } = require('./services/main/feature-settings-facade');
const { createClipboardAdapter } = require('./services/main/clipboard-adapter');
const { createMainErrorHardening } = require('./services/main-error-hardening');
const { showSidecarCrashDialog } = require('./services/sidecar-crash-dialog');
const { getBridgeChannel } = require('./services/ipc-contract');
const { createMainWindowStartupLifecycle } = require('./services/main-window-startup-lifecycle');
const { getWindowStateSnapshot } = require('./services/window-state-service');
const { APP_ZOOM_DEFAULT } = require('./services/shell-config-zoom-state');
const {
  buildSystemStatsPayload,
  createUnavailableGpuMemorySample,
  normalizeGpuMemorySample,
} = require('./services/system-stats-payload');
const { probeGpuTelemetry } = require('./services/gpu-telemetry-probe');
const { createGpuMemorySampleController } = require('./services/main/gpu-memory-sample');
const { MainLifecycleController, registerEmergencyShutdownHandlers, registerMainProcessLifecycleHandlers } = require('./services/main-lifecycle');
const { createStartupAudit } = require('./services/main/startup-audit');
const { createSetupReadinessProbe } = require('./services/main/setup-readiness');
const { createLogRedactionPrefixesProvider } = require('./services/main/client-log-forwarding');
const { createMainWindowWithDeps, resolveWindowIconPath } = require('./services/main/main-window-composition');
const { shouldRevealWindowInactive } = require('./services/agent-quiet-launch');
const { createRuntimeServicesWithDeps, resolveUiLanguage } = require('./services/main/runtime-service-composition');
const { scheduleStartupRetentionTasks } = require('./services/main/startup-retention-tasks');
const dataLifecycleStartup = require('./services/main/data-lifecycle-startup');
const { registerArtifactFramePrivilegedScheme } = require('./services/artifact-frame-protocol');
const { installDefaultSessionWiring } = require('./services/main/default-session-wiring');
const { createTrustedSenderAuthorizer, unauthorizedIpcResult } = require('./services/main/ipc-sender-authorization');
// Electron permits this registration only once and only before readiness.
registerArtifactFramePrivilegedScheme(protocol);
const {
  resolveBootFailureAction,
  shouldAutoStartMainProcess,
  shouldRefreshManagedConfigForShellConfigReason,
} = require('./services/main/main-process-policy');
let mainWindow;
let backendService;
let logStore;
let processLogWriter;
let personalityWorkspace;
let shellConfigService;
let schedulerService;
let linkStatusService;
let calendarService;
let deferredServicesStarted = false;
let startDeferredBackgroundRefreshes = () => {};
let startPostWindowServices = () => {};
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
let reaInstallService;
let mcpDiscoveryService;
let attachmentAssetStore;
let artifactService;
let mainLifecycle;
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
let packagedSmokeController = null;

const {
  applyFeatureSettingsPatch,
  buildEffectiveFeatureFlags,
  buildFeatureStatePayload,
} = createFeatureSettingsFacade({
  env: process.env,
  platform: process.platform,
  getShellConfigService: () => shellConfigService,
  getBackendService: () => backendService,
  sendToWindow: (channel, payload) => sendToWindow(channel, payload),
});

function isPackagedSmokeEnabled() {
  return Boolean(PACKAGED_SMOKE_CONFIG.outputPath);
}

const getLogRedactionPrefixes = createLogRedactionPrefixesProvider({
  app, rootDir: __dirname, getShellConfigService: () => shellConfigService,
});

function log(level, event, details = {}) {
  // Boot failures before createRuntimeServices() wires the store must still
  // reach their dialog/exit path instead of throwing from the logger.
  if (!logStore) {
    try { console.error(`[${level}] ${event}`, details); } catch (_error) { /* stderr gone */ }
    return null;
  }
  const redactionPrefixes = getLogRedactionPrefixes();
  // DiagnosticLogService owns normalizeLogEntry, persistence, and broadcast.
  return logStore.append({
    layer: 'electron',
    component: 'electron.main',
    level,
    event: String(event || 'electron.main.event').trim() || 'electron.main.event',
    details,
    data: details,
    message: String(details && details.message || '').trim() || String(details && details.error || '').trim() || (details && typeof details.line === 'string' ? details.line.trim() : '') || String(event || '').trim() || 'main event',
    status: String(details && details.status || '').trim() || 'ok',
    redaction_mode: 'redacted',
  }, { defaults: { redaction_prefixes: redactionPrefixes } });
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
  windowIconPath: resolveWindowIconPath({
    isPackaged: app.isPackaged, platform: process.platform, rootDir: __dirname, resourcesPath: process.resourcesPath,
  }),
  ipcMainRef: ipcMain,
  shell,
  Menu,
  isPackaged: app.isPackaged,
  platform: process.platform,
  windowStateService,
  mainErrorHardening,
  mainLifecycle,
  isPackagedSmokeEnabled,
  // Agent launches and GUI smokes (JENNY_AGENT_DEV / JENNY_WINDOW_REVEAL_INACTIVE)
  // reveal via showInactive() — visible but not activated — and never steal
  // focus from the owner's foreground app (services/agent-quiet-launch.js).
  revealWindowInactive: shouldRevealWindowInactive(process.env),
  getStartupElapsedMs,
  emitStartupAuditMark,
  log,
  emitMainWindowStateChanged,
  getMainWindow: () => mainWindow,
  setMainWindow: (nextWindow) => {
    mainWindow = nextWindow;
  },
  getWindowExitGuard: () => workspaceProcessServices.windowExitGuard,
  onWindowVisibilityChange: (visible) => systemStats?.visibilityPause?.setVisible(visible),
  getInitialAppZoomFactor: () => {
    try {
      const percent = Number(shellConfigService?.getWindowUiState?.().appZoomPercent);
      return Number.isFinite(percent) && percent > 0 ? percent / 100 : APP_ZOOM_DEFAULT / 100;
    } catch (_error) {
      return APP_ZOOM_DEFAULT / 100;
    }
  },
  getPortableAppearance: () => dataLifecycleStartup.readPortableAppearance(app), getUiLanguage: () => resolveUiLanguage({ shellConfigService }),
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

// Backend wiring, IPC registration and runtime shutdown load lazily: their
// first use comes after createWindow(), so their module graphs stay off the
// path to the window.
const createBackendService = () => {
  const { createBackendServiceWithDeps } = require('./services/main/backend-service-wiring');
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
    getNinferManager: () => getRuntimeShutdownController().getNinferManager(),
    buildEffectiveFeatureFlags,
    buildFeatureStatePayload,
    refreshGpuMemorySample,
    // #16: pass a live getter rather than the bare value -- refreshElectronToolRegistry
    // is a `let` assigned by createRuntimeServices() and the no-op default would be
    // captured here if construction order ever changed.
    getRefreshElectronToolRegistry: () => refreshElectronToolRegistry,
    shouldRefreshManagedConfigForShellConfigReason,
    sendBridgeEvent,
    log,
    showSidecarCrashDialog,
    shouldUsePackagedSidecarRuntime,
  });
  backendService = created.backendService;
  schedulerService = created.schedulerService;
  linkStatusService = created.linkStatusService;
  calendarService = created.calendarService;
  offlineIntelligenceService = created.offlineIntelligenceService;
  companionService = created.companionService;
  startDeferredBackgroundRefreshes = created.startDeferredBackgroundRefreshes;
  startPostWindowServices = created.startPostWindowServices;
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
    getSystemStats: () => systemStats,
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
  updateService.authorizeQuit = () => workspaceProcessServices.windowExitGuard?.authorizeNextQuit?.();
  updateService.revokeQuitAuthorization = () => workspaceProcessServices.windowExitGuard?.revokeQuitAuthorization?.();
  shellConfigService = created.shellConfigService;
  skillsService = created.skillsService;
  knowledgeService = created.knowledgeService;
  mcpDiscoveryService = created.mcpDiscoveryService;
  setupService = created.setupService;
  ollamaInstallService = created.ollamaInstallService;
  reaInstallService = created.reaInstallService;
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
  revealExistingWindow(mainWindow);
}

const registerIpcHandlers = () => require('./services/main/ipc-handler-registration').registerMainIpcHandlers({
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
  suggestionCache,
  offlineIntelligenceService,
  applyFeatureSettingsPatch,
  dialog,
  getMainWindow: () => mainWindow,
  attachmentAssetStore,
  processRef: process,
  clipboard: createClipboardAdapter({ clipboard, ClipboardItem }),
  nativeImage,
  log,
  getLlamaServerManager: () => getRuntimeShutdownController().getLlamaServerManager(),
  getNinferManager: () => getRuntimeShutdownController().getNinferManager(),
  getMainLifecycle: () => mainLifecycle,
  getWindowState: getMainWindowStatePayload,
  // A Retry after a failed boot must also finish a pending restore promotion.
  startDeferredServices: () => {
    void dataLifecycleStartup.finalizeSuccessfulRestoredBoot(app, log);
    startDeferredServices();
  },
  toolExecutor,
  toolPermissionStore,
  usageHistory,
  setupService,
  ollamaInstallService,
  reaInstallService,
  mcpDiscoveryService,
  schedulerService,
  linkStatusService,
  calendarService,
  getStartupAuditConfig,
  createStartupAuditMarkHandler,
  createStartupAuditMarksBatchHandler,
  refreshGpuMemorySample,
  getCurrentSystemStatsPayload,
  // system.setStatsWatch reads the cadence from it; without it the 2 s
  // watched tick never engages (SC-2).
  getSystemStats: () => systemStats,
  buildFeatureStatePayload,
  trashItemImpl: (targetPath) => shell.trashItem(targetPath),
  showItemInFolderImpl: (targetPath) => shell.showItemInFolder(targetPath),
  openPathImpl: (targetPath) => shell.openPath(targetPath),
  sendBridgeEvent,
  workspaceSnapshotStore: workspaceIdeSnapshotStore,
  getDisplayMediaSourceHandler: () => displayMediaSourceHandler,
  getDiagnosticLogService: () => logStore,
  getLogRedactionPrefixes,
});
function getRuntimeShutdownController() {
  if (!runtimeShutdownController) {
    const { createRuntimeShutdownController } = require('./services/main/runtime-shutdown');
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

const emitStartupProgress = (...args) => getRuntimeShutdownController().emitStartupProgress(...args);
const startLlamaServerBeforeBackend = () => getRuntimeShutdownController().startLlamaServerBeforeBackend();
const stopRuntimeBeforeQuit = (context) => {
  // Dispose main-owned display-media IPC state before the runtime drain.
  // Lifecycle cancellation is forwarded to fence late shutdown stages.
  try {
    displayMediaSourceHandler?.dispose();
    backendService?.modelFitObserver?.dispose();
  } catch (_error) {
    // best-effort only
  }
  return getRuntimeShutdownController().stopRuntimeBeforeQuit(context);
};
const runEmergencyRuntimeShutdownSync = () => getRuntimeShutdownController().runEmergencyRuntimeShutdownSync();
function startDeferredServices() {
  if (deferredServicesStarted || mainLifecycle?.isAppQuitting?.()) { return; }
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
// Push a 'failed' backend status. Guarded: a throw inside createRuntimeServices()
// fails startup *before* backendService is assigned, and an unguarded
// getBackendStatus() would raise a secondary TypeError so the 'failed' status
// never reached the UI. failure_context is set only when one is given.
function emitFailedBackendStatus(detail, failureContext) {
  const baseStatus = backendService && typeof backendService.getBackendStatus === 'function'
    ? backendService.getBackendStatus()
    : {};
  const failedStatus = { ...baseStatus, phase: 'failed', detail };
  if (failureContext !== undefined) failedStatus.failure_context = failureContext;
  sendBridgeEvent('backend.onStatus', failedStatus);
  return failedStatus;
}
function handleBootFailure(failedStatus, detail) {
  const action = resolveBootFailureAction({
    hasPackagedSmoke: Boolean(packagedSmokeController),
    // registerIpcHandlers() returns the exit guard last: without it the window has no Retry.
    hasLiveWindow: Boolean(workspaceProcessServices.windowExitGuard && mainWindow && !mainWindow.isDestroyed()),
  });
  if (action === 'packaged-smoke') packagedSmokeController.markBackendFailed(failedStatus, detail);
  else if (action === 'keep-window') log('WARN', 'backend.start_failed_window_kept', { reason: 'awaiting_retry' });
  else requestMainProcessShutdown(1);
}
function startMainProcess() {
  return startWhenSingleInstanceAvailable({
    // resolveMainBootMode took the lock (or the packaged-smoke bypass) at the top.
    acquireLock: () => mainBootMode === MAIN_BOOT_MODES.PRIMARY,
    onStart: () => {
      mainErrorHardening = createMainErrorHardening({
        app, processRef: process, log, stopRuntimeBeforeQuit,
        getMainLifecycle: () => mainLifecycle,
        emitFailedBackendStatus: (detail, context = {}) => {
          emitFailedBackendStatus(String(detail || '').trim() || 'Unexpected runtime failure.', context);
        },
        unhandledFailureEvent: 'app.unhandled_failure',
      });
      mainErrorHardening.resetForStartup();
      mainErrorHardening.registerGlobalCrashGuards();
      const preloadBundle = ensureDevPreloadBundle({ isPackaged: app.isPackaged, rootDir: __dirname });
      if (preloadBundle.status === 'failed') {
        dialog.showErrorBox('Jenny could not start', `The preload bundle could not be rebuilt.\n\n${preloadBundle.detail}`);
        return app.exit(1);
      }
      app.whenReady().then(async () => {
        emitStartupAuditMark('electron-ready', { source: 'main' });
        if (process.platform === 'win32') {
          app.setAppUserModelId(resolveAppUserModelId({ isPackaged: app.isPackaged }));
          // Before any Notification: Electron creates its toast shortcut when the
          // presenter starts. No-op when packaged; never blocks startup.
          try {
            ensureDevStartMenuShortcut({ app, shell, logger: log });
          } catch (_shortcutError) {
            // ensureDevStartMenuShortcut already logs failures.
          }
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
          const restoreResult = await dataLifecycleStartup.promotePendingRestore(app, nativeImage);
          emitStartupAuditMark('main-sync-init-start', {
            source: 'main',
            ts_ms: mainSyncInitStartedAt,
            startupMs: Math.max(mainSyncInitStartedAt - appStartupStartedAt, 0),
          });
          createRuntimeServices();
          if (!restoreResult.ok) log('WARN', 'data_lifecycle.restore_promotion_failed', restoreResult.error);
          flushStartupAuditMarks();
          // Deny-by-default permission guard, display-media picker, and the
          // jenny-artifact:// preview protocol — see default-session-wiring.js.
          require('./services/main/ipc-handler-timing').installIpcHandlerTiming(ipcMain, { log });
          ({ displayMediaSourceHandler } = installDefaultSessionWiring({
            session: session.defaultSession,
            desktopCapturer,
            ipcMain,
            authorization: {
              authorize: createTrustedSenderAuthorizer({ getMainWindow: () => mainWindow, log }),
              unauthorizedResult: unauthorizedIpcResult,
            },
            sendBridgeEvent,
            log,
            getMainWindow: () => mainWindow,
            getShellConfigService: () => shellConfigService,
          }));
          log('INFO', 'app.ready', { startupMs: getStartupElapsedMs(), preloadBundle: preloadBundle.status });
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
          mainLifecycle = new MainLifecycleController({
            appQuit: () => app.quit(),
            appExit: (exitCode = 0) => app.exit(exitCode),
            stopRuntime: (context) => stopRuntimeBeforeQuit(context),
            onEmergencyShutdown: runEmergencyRuntimeShutdownSync,
            quitPreflight: () => workspaceProcessServices.windowExitGuard?.requestQuitPreflight?.() ?? true,
            log,
          });
          registerMainProcessLifecycleHandlers(app, mainLifecycle);
          app.on('window-all-closed', () => {
            log('INFO', 'app.window_all_closed');
          });
          // The renderer boots (spawn, preload, HTML parse) while the backend and
          // IPC handlers are built below. No await may sit between createWindow()
          // and registerIpcHandlers(): renderer IPC is dispatched only after this
          // synchronous block yields, when every handler already exists.
          createWindow();
          createBackendService();
          scheduleStartupRetentionTasks({ artifactService, backendService, attachmentAssetStore, log });
          workspaceProcessServices = registerIpcHandlers() || {};
          workspaceProcessServices.windowExitGuard?.attach?.(mainWindow);
          startPostWindowServices();
          emitStartupAuditMark('main-sync-init-end', { source: 'main' });
          systemStats.start();
          log('INFO', 'app.bootstrap_ready', { startupMs: getStartupElapsedMs() });
          const localServerReadyPromise = startLlamaServerBeforeBackend();
          emitStartupAuditMark('backend-start', { source: 'main' });
          await backendService.start({
            localServerReadyPromise,
            onProgress: (phase, facts) => emitStartupProgress(phase, facts),
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
          emitStartupProgress('ready', {}, String(error.message || error));
          const failedStatus = emitFailedBackendStatus(String(error.message || error));
          handleBootFailure(failedStatus, error.message || error);
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
        handleBootFailure(emitFailedBackendStatus(detail), detail);
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

if (mainBootMode === MAIN_BOOT_MODES.UNINSTALL) {
  dataLifecycleStartup.startUninstallAssistant(process.argv, __dirname);
} else if (mainBootMode === MAIN_BOOT_MODES.PRIMARY) {
  startMainProcess();
}

// Consumed by tests that load main.js with a mocked Electron.
module.exports = {
  createMainWindowStartupLifecycle,
  createPackagedSmokeController,
  shouldAutoStartMainProcess,
  shouldRefreshManagedConfigForShellConfigReason,
};
