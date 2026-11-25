const path = require('path');

const { AttachmentAssetStore } = require('../attachment-asset-store');
const { ArtifactWorkspaceService } = require('../artifact-workspace-service');
const { AutomationService } = require('../automation-service');
const { BrowserSessionService } = require('../browser-session-service');
const { UsageHistoryService } = require('../usage-history-service');
const { buildFeatureFlags, isFeatureEnabledByDefault } = require('../feature-flags');
const { buildEffectiveFeatureFlags: buildEffectiveFeatureFlagsWithDeps } = require('../feature-settings-service');
const {
  createI18nMain,
  mapAppLocaleToUiLanguage,
  registerMainTranslator,
  resolveUiLanguage,
} = require('../i18n-main');
const { McpDiscoveryService } = require('../mcp-discovery-service');
const { PersonalityWorkspaceService } = require('../personality-workspace-service');
const { ProcessLogWriter } = require('../process-log-writer');
const { DiagnosticLogService } = require('../diagnostic-log-service');
const { SetupService } = require('../setup-service');
const { OllamaInstallService } = require('../ollama-install-service');
const { ReaInstallService } = require('../rea-install-service');
const { ShellConfigService } = require('../shell-config-service');
const { isToolsWorktreeEnabled } = require('../shell-config-state');
const { SystemStatsMonitor } = require('../system-stats');
const { isGpuTelemetrySupported } = require('../system-stats-payload');
const { createDefaultRegistry, ToolPathPolicy, ToolPermissionStore, ToolExecutor } = require('../tools');
const { UpdateService } = require('../update-service');
const { createGitHubReleaseClient } = require('../github-release-client');
const { createWorkspaceIdeSnapshotStore } = require('../workspace-ide-snapshot-store');
const { WorkspacePresentationService } = require('../workspace-presentation-service');
const { WindowStateService } = require('../window-state-service');
const { WorktreeService } = require('../worktree-service');
const { WorktreeRegistryService, defaultRegistryPath } = require('../worktree-registry-service');
const { createDesktopNotifier, isRuntimeChildSession } = require('./desktop-notifier');
const { createReminderNotifier } = require('./reminder-notifier');
const { createUnattendedGuard } = require('./unattended-guard');
const {
  STATS_IDLE_INTERVAL_MS, STATS_WATCHED_INTERVAL_MS, createLocalGenerationSync, createStatsWatchCadence,
} = require('./stats-watch-cadence');

// Pauses the stats monitor while the window is hidden or minimised and resumes
// it with one immediate tick so the title-bar read-out catches up. start() and
// stop() keep their meaning: a stopped monitor stays stopped whatever the
// window does, and a start while hidden waits for the window to come back.
function createStatsVisibilityPause(monitor, onVisibilityChange = null) {
  const startTimer = monitor.start.bind(monitor);
  const stopTimer = monitor.stop.bind(monitor);
  let running = false;
  let visible = true;
  monitor.start = () => {
    running = true;
    if (visible) startTimer();
  };
  monitor.stop = () => {
    running = false;
    stopTimer();
  };
  return {
    setVisible(next) {
      const nextVisible = next !== false;
      if (nextVisible === visible) return;
      visible = nextVisible;
      try { onVisibilityChange?.(visible); } catch (_error) { /* the skills poll follows; never blocks this pause */ }
      if (!running) return;
      if (!visible) {
        stopTimer();
        return;
      }
      startTimer();
      monitor.emit('stats', monitor.sample());
    },
    isVisible: () => visible,
  };
}

function createRuntimeServicesWithDeps({
  app,
  nativeImage,
  powerMonitor,
  screen,
  shell,
  processRef = process,
  rootDir,
  systemArch = '',
  previousWindowStateDisplayUnsubscribe = null,
  createUnavailableGpuMemorySample = () => ({}),
  onGpuMemoryReset = () => {},
  getBackendService = () => null,
  getCurrentSystemStatsPayload = () => null,
  refreshGpuMemorySample = async () => null,
  probeSetupReadiness = async () => ({}),
  sendBridgeEvent = () => {},
  getMainWindow = () => null,
  getLlamaServerManager = () => null,
  getNinferManager = () => null,
  getStrataManager = () => null,
  log = () => {},
  onCoreLoggingReady = () => {},
} = {}) {
  onGpuMemoryReset(
    !isGpuTelemetrySupported({ arch: systemArch, platform: processRef.platform })
      ? createUnavailableGpuMemorySample({ source: 'arm_fallback' })
      : createUnavailableGpuMemorySample()
  );
  // app.getPath('userData') is stable for this composition pass.
  const userDataPath = app.getPath('userData');
  const processLogPath = path.join(userDataPath, 'logs', 'shell.log');
  const processLogWriter = new ProcessLogWriter({
    filePath: processLogPath,
    logger: log,
    // DEBUG reaches shell.log only under the agent/dev launcher, matching
    // renderer DEBUG forwarding (services/main/client-log-forwarding.js).
    fileMinLevel: buildFeatureFlags(processRef.env).agent_test_hooks === true ? 'DEBUG' : 'INFO',
  });
  const logStore = new DiagnosticLogService({
    writer: processLogWriter,
    filePath: processLogPath,
    onEntry: (entry) => {
      sendBridgeEvent('diagnostics.logs.onEntry', entry);
    },
  });
  // Publish core logging to the caller immediately, before any service that
  // logs during construction or initialization runs --
  // otherwise the injected logger's backing store is still undefined and
  // startup throws inside whenReady (and again in its catch), hanging the app.
  onCoreLoggingReady({ logStore, processLogWriter });
  if (typeof previousWindowStateDisplayUnsubscribe === 'function') {
    previousWindowStateDisplayUnsubscribe();
  }
  const windowStateService = new WindowStateService({
    userDataPath: userDataPath,
    screen,
    logger: log,
  });
  const windowStateDisplayUnsubscribe = windowStateService.attachDisplayListeners(getMainWindow);
  const updateService = new UpdateService({
    app,
    storePath: path.join(userDataPath, 'update-state.json'),
    logger: log,
    // Electron's network stack, not Node's fetch: it follows the system proxy
    // and certificate store, where Node's connects directly and is refused
    // behind a proxy. Same fixed URL, no credentials, redirects still rejected.
    releaseClient: createGitHubReleaseClient({
      fetchImpl: (url, init) => require('electron').net.fetch(url, init),
    }),
  });
  updateService.on('changed', (state) => {
    sendBridgeEvent('updates.onChanged', state);
  });

  const shellConfigService = new ShellConfigService({
    userDataPath: userDataPath,
    resourcesPath: processRef.resourcesPath,
    logger: log,
  });
  if (shellConfigService.isFreshInstall?.() === true) {
    const locale = typeof app?.getLocale === 'function' ? app.getLocale() : '';
    const mapped = mapAppLocaleToUiLanguage(locale);
    if (mapped !== 'en') shellConfigService.updateUiLanguage(mapped);
    log('INFO', 'i18n.first_run_locale', { locale, mapped });
  }
  const i18nMain = createI18nMain({ log });
  registerMainTranslator(i18nMain);
  i18nMain.setLocale(resolveUiLanguage({ env: processRef.env, shellConfigService }));
  shellConfigService.on('changed', (_state, meta) => {
    if (meta?.reason === 'ui_language_updated' || meta?.reasons?.includes?.('ui_language_updated')) {
      i18nMain.setLocale(resolveUiLanguage({ env: processRef.env, shellConfigService }));
    }
  });

  function buildEffectiveFeatureFlags() {
    return buildEffectiveFeatureFlagsWithDeps({
      shellConfigService,
      env: processRef.env,
    });
  }

  const skillsService = new (require('../skills-service').SkillsService)({
    configService: shellConfigService,
    bundledRoot: path.join(rootDir, 'skills'),
    openPathImpl: (targetPath) => shell.openPath(targetPath),
    featureEnabled: isFeatureEnabledByDefault(processRef.env.JENNY_ENABLE_SKILLS_SURFACES, true),
    logger: log,
  });
  // knowledge_layer (default-off, internal): user-folder "knowledge roots"
  // registry. Inert unless the flag is on AND the user registers a folder.
  // The flag is read live off buildEffectiveFeatureFlags (config + env), and
  // add/remove push the updated roots through the managed-sidecar config
  // channel via the backend service (which does not exist yet at this
  // composition pass, hence the getBackendService accessor — same pattern as
  // the tool executor's refreshManagedConfig above).
  const knowledgeService = new (require('../knowledge-service').KnowledgeService)({
    userDataPath: userDataPath,
    featureFlagProvider: buildEffectiveFeatureFlags,
    logger: log,
    refreshManagedConfig: async (reason) => {
      const backendService = getBackendService();
      if (!backendService || typeof backendService.refreshManagedConfig !== 'function') {
        return null;
      }
      return backendService.refreshManagedConfig(reason);
    },
  });
  const mcpDiscoveryService = new McpDiscoveryService({
    userDataPath: userDataPath,
    openPathImpl: (targetPath) => shell.openPath(targetPath),
  });
  const reaInstallService = new ReaInstallService({
    manifest: require('../../config/rea-install-manifest.json'),
    userDataPath, discovery: mcpDiscoveryService, skillsService, logger: log,
  });
  // Repairs an install killed part-way; installs start from a user action, so this waits for the window.
  setImmediate(() => {
    try {
      reaInstallService.reconcile();
    } catch (_error) {
      log('WARN', 'rea_install.reconcile_failed', { reason: 'staging_cleanup_failed' });
    }
  });
  reaInstallService.on('install-progress', (payload) => {
    sendBridgeEvent('mcpDiscovery.onReaInstallProgress', payload);
  });
  let toolExecutor = null;
  const getOwnedOllamaPid = () => {
    const manager = getBackendService()?.ollamaManager;
    return manager?._getOwnedPid?.(manager?._readOwnedState?.()) || 0;
  };
  const setupService = new SetupService({
    getOwnedOllamaPid,
    configService: shellConfigService,
    getLlamaServerManager,
    getManagedServerManagers: () => [getNinferManager(), getStrataManager()],
    readinessProvider: probeSetupReadiness,
    refreshManagedConfig: async (reason) => {
      const backendService = getBackendService();
      if (!backendService || typeof backendService.refreshManagedConfig !== 'function') {
        throw new Error('Managed sidecar service is unavailable.');
      }
      const refreshed = await backendService.refreshManagedConfig(reason);
      if (refreshed == null) {
        throw new Error('Managed sidecar service is not ready to apply endpoint settings.');
      }
      return refreshed;
    },
    workspaceRootCoordinatorProvider: () => (
      getBackendService()?.workspaceRootCoordinator || null
    ),
    mcpToolsDiscoveredProvider: () => {
      const backendService = getBackendService();
      const toolsStatus = backendService && backendService.currentStatus
        ? backendService.currentStatus.tools_status
        : {};
      const registryTools = toolExecutor?.registry?.getAllTools?.() || [];
      const runtimeStatus = toolsStatus && typeof toolsStatus === 'object' ? toolsStatus : {};
      return registryTools.some((tool) => String(tool?.name || '').trim().startsWith('mcp__'))
        || Object.keys(runtimeStatus).some((name) => String(name || '').trim().startsWith('mcp__'));
    },
    logger: log,
  });
  setupService.on('model-pull-progress', (payload) => {
    sendBridgeEvent('setup.onModelPullProgress', payload);
  });
  const ollamaInstallService = new OllamaInstallService({
    manifest: require('../../config/ollama-install-manifest.json'),
    detectImpl: (args) => setupService.detectOllama(args),
    releaseOwnedImpl: async () => {
      const manager = getBackendService()?.ollamaManager;
      if (!getOwnedOllamaPid() || typeof manager?.stop !== 'function') return false;
      await manager.stop({ scope: 'app_owned' });
      return true;
    },
    restartImpl: async () => {
      const manager = getBackendService()?.ollamaManager;
      if (!manager || typeof manager.stop !== 'function' || typeof manager.start !== 'function') {
        return { ok: false, reason: 'ollama_manager_unavailable' };
      }
      await manager.stop({ scope: 'any_local' });
      const started = await manager.start();
      const running = Boolean(started?.started || started?.external)
        || (typeof manager._isRunning === 'function' && await manager._isRunning());
      return { ok: running, running, ...(running ? {} : { reason: 'engine_not_running' }) };
    },
    logger: log,
  });
  // Repairs a Linux archive publish a previous run was killed in the middle of.
  try {
    ollamaInstallService.reconcileArchiveInstall();
  } catch (error) {
    log('WARN', 'ollama_install.reconcile_failed', { reason: String(error?.message || error) });
  }
  ollamaInstallService.on('install-progress', (payload) => {
    sendBridgeEvent('setup.onOllamaInstallProgress', payload);
  });
  // DEV-ONLY: manual onboarding walkthrough with faked download/install/pull.
  // No-op unless JENNY_ONBOARDING_DEMO=1 (scripts/dev/run-onboarding-demo.js).
  const onboardingDemo = require('../dev/onboarding-demo-fixtures');
  if (onboardingDemo.isOnboardingDemo(processRef.env)) {
    onboardingDemo.applyOnboardingDemo({ setupService, ollamaInstallService });
  }
  const attachmentAssetStore = new AttachmentAssetStore({
    rootDir: path.join(userDataPath, 'attachments'),
    nativeImage,
  });
  const personalityWorkspace = new PersonalityWorkspaceService({
    userDataPath: userDataPath,
    openPathImpl: (targetPath) => shell.openPath(targetPath),
    logger: log,
    // A project chat's Notes slot is its project-notes page (row 58 W1 S5).
    projectNotesProvider: () => getBackendService()?.projectNotesService,
  });
  const artifactService = new ArtifactWorkspaceService({
    configService: shellConfigService,
    projectAuthorityProvider: () => getBackendService()?.projectAuthority,
    sessionMessageReader: async (sessionId) => {
      const backendService = getBackendService();
      if (!backendService || typeof backendService.getSessionMessages !== 'function') {
        return [];
      }
      const result = await backendService.getSessionMessages(sessionId).catch(() => null);
      return Array.isArray(result?.data) ? result.data : [];
    },
    openPathImpl: (targetPath) => shell.openPath(targetPath),
    showItemInFolderImpl: (targetPath) => shell.showItemInFolder(targetPath),
    logger: log,
  });
  const worktreeService = new WorktreeService({
    registryService: new WorktreeRegistryService(defaultRegistryPath(userDataPath), {
      logger: log,
    }),
    logger: log,
  });
  const automationService = new AutomationService({
    userDataPath: userDataPath,
    configService: shellConfigService,
    logger: log,
  });
  const workspacePresentationService = new WorkspacePresentationService({
    sendBridgeEvent,
    getUiWorkspaceRoot: () => shellConfigService.getToolsWorkspaceRoot(),
    projectAuthorityProvider: () => getBackendService()?.projectAuthority,
    isRendererAvailable: () => {
      const win = getMainWindow?.();
      return !!win && !win.isDestroyed();
    },
    logger: log,
  });
  const browserSessionService = new BrowserSessionService({ browserWindowFactory: (options) => new (require('electron').BrowserWindow)(options), logger: log });
  // Row 114: the model-driven browser; its modules and Electron's view classes load on first use.
  const browserUse = require('./browser-use-composition').createLazyBrowserUse({ getMainWindow, sendBridgeEvent, getBackendService, logger: log, getSafetyMode: () => shellConfigService.getState()?.safetyMode });
  // Row 196: the computer tool; its modules load on first use and it shares the Live tab's helper.
  const computerUse = require('./computer-use-composition').createLazyComputerUse({ getRunView: () => getBackendService()?.runView, userDataPath, log });
  // NOTE: worktreeService is injected into BackendService at construction time
  // (see backend-service-wiring.js) rather than wired here -- the backend service
  // does not exist yet during this composition pass, so a post-hoc assignment guard
  // would always be falsy and silently leave worktree status unpopulated.
  const systemStats = new SystemStatsMonitor({
    // 2s keeps CPU/RAM near real-time (cheap OS reads) while watched; the watch
    // cadence below drops to 15s when nothing shows them and reads the card only
    // while a readout watches or a local model writes (2026-11-23).
    intervalMs: STATS_WATCHED_INTERVAL_MS,
    powerMonitor,
  });
  const unattendedGuard = createUnattendedGuard({
    powerMonitor,
    getBackendService,
    getThresholdMinutes: () => Number(
      shellConfigService?.getChatUiState?.()?.unattendedGuardMinutes
    ),
    isEnabled: () => buildEffectiveFeatureFlags().unattended_guard === true,
    // Row 196: never starts computer use; null unless its service runs a watch.
    getRealInputAgeMs: () => getBackendService()?.toolExecutor?.computerUse?.peek?.()?.lastRealInputAgeMs?.() ?? null,
    sendBridgeEvent,
    log,
  });
  // Started here rather than from main.js: the tick is inert until a backend
  // with live streams exists, and main.js sits at its line cap. Attached to
  // systemStats because the shutdown path only holds systemStats through a
  // main.js accessor; runtime-stop reads it back from there.
  unattendedGuard.start();
  systemStats.unattendedGuard = unattendedGuard;
  const reminderNotifier = createReminderNotifier({
    getShellConfigService: () => shellConfigService, isAppMuted: () => browserUse.isAppMuted(),
    getMainWindow,
    notificationFactory: (options) => new (require('electron').Notification)(options),
    isSupported: () => require('electron').Notification.isSupported(),
    isEnabled: () => buildEffectiveFeatureFlags().desktop_notifications === true,
    sendBridgeEvent, powerMonitor, // row 85: a due Jenny check goes to the Jenny chat (primary-scheduled-check.js), a paused one-off waits
    log, onJennyTurnDue: (...args) => getBackendService()?.primaryScheduledChecks?.onDue?.(...args) ?? { handled: false }, holdJennyTurn: (reminder) => getBackendService()?.primaryScheduledChecks?.holds?.(reminder) === true,
  });
  reminderNotifier.start();
  systemStats.reminderNotifier = reminderNotifier;
  shellConfigService.reminderNotifier = reminderNotifier;
  // Desktop toasts for renderer-detected replies/failures/permissions/
  // questions. start() registers the notifications.notify send channel here
  // (main.js is at its line cap); runtime-stop stops it via systemStats.
  const desktopNotifier = createDesktopNotifier({
    getShellConfigService: () => shellConfigService, isAppMuted: () => browserUse.isAppMuted(),
    getMainWindow,
    notificationFactory: (options) => new (require('electron').Notification)(options),
    isSupported: () => require('electron').Notification.isSupported(),
    ipcMainLike: require('electron').ipcMain,
    sendBridgeEvent,
    log, isPrimarySession: (sessionId) => getBackendService()?.primaryChatControls?.isPrimary?.(sessionId) === true, // row 89 quiet hours
    isEnabled: () => buildEffectiveFeatureFlags().desktop_notifications === true,
    isChildSession: (sessionId) => isRuntimeChildSession(getBackendService()?.sessionRuntime, sessionId),
  });
  desktopNotifier.start();
  systemStats.desktopNotifier = desktopNotifier;

  let syncGeneration = () => {};
  systemStats.on('stats', (stats, { resume = false } = {}) => {
    sendBridgeEvent('system.onStats', getCurrentSystemStatsPayload(stats));
    syncGeneration();
    // A watcher or a generation that just arrived forces one read; later ticks take the throttled one.
    if (systemStats.watchCadence.isWanted()) void refreshGpuMemorySample(resume ? { force: true } : undefined).catch(() => null);
  });
  // Nothing on screen, nothing sampled: main.js hands the window's visibility
  // (main-window-composition's hide/minimize/show/restore) to this pause.
  systemStats.visibilityPause = createStatsVisibilityPause(systemStats, (visible) => skillsService.setWindowVisible(visible));
  // Renderer watchers (system.setStatsWatch) pick the tick rate.
  systemStats.watchCadence = createStatsWatchCadence(systemStats);
  syncGeneration = createLocalGenerationSync({ getBackendService, cadence: systemStats.watchCadence });

  const toolPathPolicy = new ToolPathPolicy({
    fs: require('fs/promises'),
    path: require('path'),
    logger: log,
  });
  const toolPermissionStore = new ToolPermissionStore(
    path.join(userDataPath, 'tool-permissions.json'),
    { logger: log }
  );
  // Preserve a retired per-type inspect deny by disabling the folded capability.
  if (toolPermissionStore.consumeRetiredInspectDenyNotice()) {
    try {
      shellConfigService.updateFeatureSettings({ tools: { richFiles: false } });
    } catch (error) {
      log('WARN', 'permissions.retired_inspect_migration_persist_failed', { code: error?.code });
    }
  }

  // One state read and one flag build per registry: this runs before the
  // window on every launch and again on each feature or worktree toggle.
  function createToolRegistryForCurrentConfig() {
    const flags = buildEffectiveFeatureFlags();
    const primaryChat = flags.primary_chat !== false;
    const toolsTerminalEnabled = flags.terminal_tools !== false;
    return createDefaultRegistry({
      toolsWorktreeEnabled: isToolsWorktreeEnabled(shellConfigService.getState()),
      toolsAutomationsEnabled: flags.tools_automations_enabled === true,
      toolsWorkspacePresentEnabled: flags.tools_workspace_present_enabled === true,
      toolsPreviewTestEnabled: flags.tools_preview_test_enabled === true,
      toolsVerifyEnabled: flags.tools_verify_enabled === true,
      toolsBrowserUseEnabled: flags.tools_browser_use_enabled === true,
      toolsRunViewEnabled: flags.tools_run_view_enabled === true && flags.live_run_view !== false, // row 197
      toolsComputerUseEnabled: flags.tools_computer_use_enabled === true && process.platform === 'win32', // row 196
      toolsImageGenerateEnabled: flags.tools_image_generate_enabled === true,
      toolsHomeEnabled: flags.tools_home_enabled === true,
      toolsNextStepEnabled: flags.tools_next_step_enabled === true,
      toolsTaskBoardEnabled: flags.tools_task_board_enabled === true,
      toolsProjectNotesEnabled: flags.tools_project_notes_enabled === true,
      toolsConversationsEnabled: flags.memory_v2_enabled === true,
      // Rows 69 / 88 / 94 / 85: declared in feature-flags.js, default on; JENNY_ENABLE_TOOLS_SESSION_DIRECTORY_ENABLED=0 / JENNY_ENABLE_PRIMARY_SETTINGS_WRITES=0 / JENNY_ENABLE_PRIMARY_CHAT_MANAGE=0 / JENNY_ENABLE_PRIMARY_CHAT_PLACEMENT=0 / JENNY_ENABLE_PRIMARY_SCHEDULED_CHECKS=0 turn them off.
      toolsSessionDirectoryEnabled: flags.tools_session_directory_enabled !== false,
      toolsPrimarySettingsEnabled: flags.primary_settings_writes !== false,
      toolsPrimaryChatManageEnabled: flags.primary_chat_manage !== false,
      toolsPrimaryChatPlacementEnabled: flags.primary_chat_placement !== false && primaryChat,
      toolsPrimaryAppViewEnabled: flags.primary_app_view !== false && primaryChat,
      toolsPrimaryChatExportEnabled: flags.primary_chat_export !== false && primaryChat,
      toolsTerminalEnabled,
      toolsTerminalRunEnabled: toolsTerminalEnabled && primaryChat,
      toolsPrimarySchedulesEnabled: flags.primary_scheduled_checks !== false && primaryChat,
      toolsPrimaryDigestsEnabled: flags.primary_digests === true && primaryChat, // row 86: default off
    });
  }

  // Pre-change snapshots captured fail-open on the write/edit tool path; the
  // Workspace IDE reads them back via workspaceFs.readPreChange for diffs.
  const workspaceIdeSnapshotStore = createWorkspaceIdeSnapshotStore({
    rootDir: path.join(userDataPath, 'workspace-snapshots'),
    logger: log,
  });

  // The session directory reads the backend's stores, so it is built on first tool use (row 69).
  let sessionDirectory = null;
  const createSessionDirectory = () => require('../session-directory-service').createSessionDirectoryService({
    sessionStore: () => getBackendService()?.sessionStore, projectService: () => getBackendService()?.projectService,
    runtime: () => getBackendService()?.runtimeApplicationService, configService: () => shellConfigService,
    projectNotesService: () => getBackendService()?.projectNotesService,
    chatWorkspaceService: () => getBackendService()?.chatWorkspace,
    pendingApprovals: () => getBackendService()?.pendingToolApprovals,
    visibleChat: () => require('../backend/memory-reflection-eligibility').visibleChatPredicate(getBackendService()),
    cancelChatStream: (streamId, reason) => getBackendService()?.cancelChatStream?.(streamId, reason) === true,
    primaryChatEnabled: () => require('../backend/primary-session').primaryChatEnabled(buildEffectiveFeatureFlags()),
    waitNotices: () => getBackendService()?.sessionRuntime?.waitNotices, log, // row 100 P2 waiting_for
  });
  const toolRegistry = createToolRegistryForCurrentConfig();
  toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    permissionStore: toolPermissionStore,
    pathPolicy: toolPathPolicy,
    logger: log,
    artifactService,
    worktreeService,
    automationService,
    workspacePresentationService,
    browserSessionService, browserUse, computerUse,
    // Home is constructed alongside the calendar service in
    // backend-service-wiring, which runs AFTER this composition pass — hence a
    // live getter, the same reason refreshManagedConfig below uses one.
    homeAssistantService: () => getBackendService()?.homeAssistantService || null,
    projectNotesService: () => getBackendService()?.projectNotesService || null,
    sessionDirectoryService: () => (sessionDirectory ||= createSessionDirectory()), primarySettingsService: () => getBackendService()?.primarySettings || null, primaryChatManageService: () => getBackendService()?.primaryChatManage || null, primaryChatPlacementService: () => getBackendService()?.primaryChatPlacement || null, appViewService: () => getBackendService()?.appView || null, primaryChatExportService: () => getBackendService()?.primaryChatExport || null, terminalToolsService: () => getBackendService()?.terminalTools || null, primaryScheduleService: () => getBackendService()?.primarySchedules || null, // rows 88 / 94 / 94 P2 / 85
    configService: shellConfigService,
    refreshManagedConfig: async (reason) => {
      const backendService = getBackendService();
      if (!backendService || typeof backendService.refreshManagedConfig !== 'function') {
        throw new Error('Managed sidecar service is unavailable.');
      }
      return backendService.refreshManagedConfig(reason);
    },
  });

  let usageHistory;
  try {
    usageHistory = new UsageHistoryService({
      userDataPath: userDataPath,
      logger: log,
    });
  } catch (_err) {
    usageHistory = null;
  }

  function refreshElectronToolRegistry() {
    if (!toolExecutor) {
      return;
    }
    toolExecutor.registry = createToolRegistryForCurrentConfig();
  }

  return {
    attachmentAssetStore,
    artifactService,
    automationService,
    browserSessionService,
    buildEffectiveFeatureFlags,
    i18nMain,
    usageHistory,
    knowledgeService,
    logStore,
    mcpDiscoveryService,
    personalityWorkspace,
    processLogWriter,
    refreshElectronToolRegistry,
    ollamaInstallService,
    reaInstallService,
    setupService,
    shellConfigService,
    skillsService,
    systemStats,
    reminderNotifier,
    desktopNotifier,
    unattendedGuard,
    toolExecutor,
    toolPermissionStore,
    updateService,
    windowStateDisplayUnsubscribe,
    windowStateService,
    workspaceIdeSnapshotStore,
    workspacePresentationService,
    worktreeService,
  };
}

module.exports = {
  createRuntimeServicesWithDeps,
  createStatsWatchCadence,
  STATS_WATCHED_INTERVAL_MS,
  STATS_IDLE_INTERVAL_MS,
  resolveUiLanguage,
};
