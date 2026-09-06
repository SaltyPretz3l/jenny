const path = require('path');

const { AttachmentAssetStore } = require('../attachment-asset-store');
const { ArtifactWorkspaceService } = require('../artifact-workspace-service');
const { AutomationService } = require('../automation-service');
const { BrowserSessionService } = require('../browser-session-service');
const { UsageHistoryService } = require('../usage-history-service');
const { isFeatureEnabledByDefault } = require('../feature-flags');
const { buildEffectiveFeatureFlags: buildEffectiveFeatureFlagsWithDeps } = require('../feature-settings-service');
const { McpDiscoveryService } = require('../mcp-discovery-service');
const { PersonalityWorkspaceService } = require('../personality-workspace-service');
const { ProcessLogWriter } = require('../process-log-writer');
const { DiagnosticLogService } = require('../diagnostic-log-service');
const { SetupService } = require('../setup-service');
const { OllamaInstallService } = require('../ollama-install-service');
const { ShellConfigService } = require('../shell-config-service');
const { isToolsWorktreeEnabled } = require('../shell-config-state');
const { SystemStatsMonitor } = require('../system-stats');
const { isGpuTelemetrySupported } = require('../system-stats-payload');
const { createDefaultRegistry, ToolPathPolicy, ToolPermissionStore, ToolExecutor } = require('../tools');
const { UpdateService } = require('../update-service');
const { createWorkspaceIdeSnapshotStore } = require('../workspace-ide-snapshot-store');
const { WorkspacePresentationService } = require('../workspace-presentation-service');
const { WindowStateService } = require('../window-state-service');
const { WorktreeService } = require('../worktree-service');
const { WorktreeRegistryService, defaultRegistryPath } = require('../worktree-registry-service');

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
  });
  const logStore = new DiagnosticLogService({
    writer: processLogWriter,
    filePath: processLogPath,
    onEntry: (entry) => {
      sendBridgeEvent('diagnostics.logs.onEntry', entry);
      sendBridgeEvent('logs.onAppend', entry);
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
  });
  updateService.on('changed', (state) => {
    sendBridgeEvent('updates.onChanged', state);
  });

  const shellConfigService = new ShellConfigService({
    userDataPath: userDataPath,
    resourcesPath: processRef.resourcesPath,
    logger: log,
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
  let toolExecutor = null;
  const setupService = new SetupService({
    configService: shellConfigService,
    getLlamaServerManager,
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
  });
  const artifactService = new ArtifactWorkspaceService({
    configService: shellConfigService,
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
    isRendererAvailable: () => {
      const win = getMainWindow?.();
      return !!win && !win.isDestroyed();
    },
    logger: log,
  });
  const browserSessionService = new BrowserSessionService({
    browserWindowFactory: (options) => new (require('electron').BrowserWindow)(options),
    logger: log,
  });
  // NOTE: worktreeService is injected into BackendService at construction time
  // (see backend-service-wiring.js) rather than wired here -- the backend service
  // does not exist yet during this composition pass, so a post-hoc assignment guard
  // would always be falsy and silently leave worktree status unpopulated.
  const systemStats = new SystemStatsMonitor({
    // 2s keeps CPU/RAM near real-time (cheap OS reads). GPU telemetry has its
    // own 15s controller cadence; when the sidecar declines mid-inference, the
    // controller falls through to the platform probe.
    intervalMs: 2000,
    powerMonitor,
  });

  systemStats.on('stats', (stats) => {
    sendBridgeEvent('system.onStats', getCurrentSystemStatsPayload(stats));
    void refreshGpuMemorySample().catch(() => null);
  });

  const toolPathPolicy = new ToolPathPolicy({
    fs: require('fs/promises'),
    path: require('path'),
    logger: log,
  });
  const toolPermissionStore = new ToolPermissionStore(
    path.join(userDataPath, 'tool-permissions.json')
  );
  // Preserve a retired per-type inspect deny by disabling the folded capability.
  if (toolPermissionStore.consumeRetiredInspectDenyNotice()) {
    shellConfigService.updateFeatureSettings({ tools: { richFiles: false } });
  }

  function isWorktreeToolEnabledFromConfig(configService = shellConfigService) {
    const state = configService && typeof configService.getState === 'function'
      ? configService.getState()
      : {};
    return isToolsWorktreeEnabled(state);
  }

  function createToolRegistryForCurrentConfig({
    toolsWorktreeEnabled = isWorktreeToolEnabledFromConfig(),
    toolsAutomationsEnabled = buildEffectiveFeatureFlags().tools_automations_enabled === true,
    toolsWorkspacePresentEnabled = buildEffectiveFeatureFlags().tools_workspace_present_enabled === true,
    toolsPreviewTestEnabled = buildEffectiveFeatureFlags().tools_preview_test_enabled === true,
    toolsVerifyEnabled = buildEffectiveFeatureFlags().tools_verify_enabled === true,
    toolsHomeEnabled = buildEffectiveFeatureFlags().tools_home_enabled === true,
    toolsTaskBoardEnabled = buildEffectiveFeatureFlags().tools_task_board_enabled === true,
  } = {}) {
    return createDefaultRegistry({
      toolsWorktreeEnabled,
      toolsAutomationsEnabled,
      toolsWorkspacePresentEnabled,
      toolsPreviewTestEnabled,
      toolsVerifyEnabled,
      toolsHomeEnabled,
      toolsTaskBoardEnabled,
    });
  }

  // Pre-change snapshots captured fail-open on the write/edit tool path; the
  // Workspace IDE reads them back via workspaceFs.readPreChange for diffs.
  const workspaceIdeSnapshotStore = createWorkspaceIdeSnapshotStore({
    rootDir: path.join(userDataPath, 'workspace-snapshots'),
    logger: log,
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
    browserSessionService,
    // Home is constructed alongside the calendar service in
    // backend-service-wiring, which runs AFTER this composition pass — hence a
    // live getter, the same reason refreshManagedConfig below uses one.
    homeAssistantService: () => getBackendService()?.homeAssistantService || null,
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
    const toolsWorktreeEnabled = isWorktreeToolEnabledFromConfig();
    const toolsAutomationsEnabled = buildEffectiveFeatureFlags().tools_automations_enabled === true;
    const toolsWorkspacePresentEnabled = buildEffectiveFeatureFlags().tools_workspace_present_enabled === true;
    const toolsPreviewTestEnabled = buildEffectiveFeatureFlags().tools_preview_test_enabled === true;
    const toolsVerifyEnabled = buildEffectiveFeatureFlags().tools_verify_enabled === true;
    const toolsHomeEnabled = buildEffectiveFeatureFlags().tools_home_enabled === true;
    const toolsTaskBoardEnabled = buildEffectiveFeatureFlags().tools_task_board_enabled === true;
    toolExecutor.registry = createToolRegistryForCurrentConfig({
      toolsWorktreeEnabled,
      toolsAutomationsEnabled,
      toolsWorkspacePresentEnabled,
      toolsPreviewTestEnabled,
      toolsVerifyEnabled,
      toolsHomeEnabled,
      toolsTaskBoardEnabled,
    });
  }

  return {
    attachmentAssetStore,
    artifactService,
    automationService,
    browserSessionService,
    buildEffectiveFeatureFlags,
    usageHistory,
    knowledgeService,
    logStore,
    mcpDiscoveryService,
    personalityWorkspace,
    processLogWriter,
    refreshElectronToolRegistry,
    ollamaInstallService,
    setupService,
    shellConfigService,
    skillsService,
    systemStats,
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
};
