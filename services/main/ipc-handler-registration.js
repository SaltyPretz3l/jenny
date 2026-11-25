const os = require('os');
const { prepareAttachmentEntries } = require('../attachment-service');
const { registerKnowledgeIpcHandlers } = require('./knowledge-ipc-handlers');
const { getCachedOrGenerateSuggestions } = require('../backend/backend-suggestions');
const { generateCommitMessage } = require('../backend/backend-commit');
const { isChildPath } = require('../backend/path-utils');
const { registerAuxiliaryIpcHandlers } = require('../auxiliary-ipc-handlers');
const { ModelTuningService } = require('../model-tuning-service');
const { EngineTuningService } = require('../engine-tuning-service');
const { createWindowExitGuard } = require('./window-exit-guard');
const {
  createTrustedSenderAuthorizer,
  unauthorizedIpcResult,
} = require('./ipc-sender-authorization');
const { startVersionedWorkspaceTempRecovery } = require('../versioned-workspace-temp-recovery');
const {
  registerWorkspaceFileMapIpcHandlers,
  registerWorkspaceFsIpcHandlers,
  registerWorkspaceGitIpcHandlers,
  registerWorkspacePtyIpcHandlers,
  registerWorkspaceTerminalShutdownTask,
  registerWorkspaceTestRunnerIpcHandlers,
  registerWorkspaceIpcHandlers,
  registerWorkspaceRootIpcHandlers,
} = require('./workspace-ipc-registration');
// Per-domain registrations (services/main/ipc-registration/). The calls below run
// in a fixed order: it is the channel registration order and the shutdown-task order.
const {
  registerChatSurfaceIpcHandlers,
  registerChatUserQuestionIpcHandlers,
} = require('./ipc-registration/chat-ipc');
const {
  registerWorkspaceServicesIpcHandlers,
  registerWorkspaceStateIpcHandlers,
} = require('./ipc-registration/workspace-ipc');
const {
  registerGuidanceIpcHandlers,
  registerGuidanceKnowledgeIpcHandlers,
} = require('./ipc-registration/guidance-ipc');
const {
  registerEngineIpcHandlers,
  registerModelIpcHandlers,
  registerOllamaTrayRemediationIpcHandlers,
} = require('./ipc-registration/engines-ipc');
const {
  registerAppShellIpcHandlers,
  registerFeatureIpcHandlers,
} = require('./ipc-registration/app-shell-ipc');
const { registerSessionIpcHandlers } = require('./ipc-registration/sessions-ipc');
const { registerSystemIpcHandlers } = require('./ipc-registration/system-ipc');
const { registerPersonalityIpcHandlers } = require('./ipc-registration/personality-memory-ipc');

function registerMainIpcHandlers({
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
  getMainWindow,
  attachmentAssetStore,
  processRef = process,
  clipboard,
  nativeImage,
  log,
  getMainLifecycle,
  getWindowState,
  startDeferredServices = () => {},
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
  // Managed llama-server manager (services/main/llama-server-manager.js), owned
  // by the runtime-shutdown controller; null until main wires it.
  getLlamaServerManager = () => null,
  getCurrentSystemStatsPayload,
  getSystemStats = () => null,
  buildFeatureStatePayload,
  getDiagnosticLogService = () => logStore,
  getLogRedactionPrefixes = () => [],
  trashItemImpl = null,
  showItemInFolderImpl = null,
  openPathImpl = null,
  sendBridgeEvent = () => {},
  workspaceSnapshotStore = null,
  browserSessionService = null,
  getDisplayMediaSourceHandler = null,
  authorizeWorkspaceSender = null,
  versionedTempRecoveryStarter = startVersionedWorkspaceTempRecovery,
  spellcheckSessionRef = null,
  outsideFileLaunch = null,
} = {}) {
  const modelTuningService = new ModelTuningService({
    shellConfigService,
    backendService,
    offlineIntelligenceService,
    log,
  });
  const engineTuningService = new EngineTuningService({
    shellConfigService,
    backendService,
    log,
  });
  const workspaceAuthorization = {
    authorize: typeof authorizeWorkspaceSender === 'function'
      ? authorizeWorkspaceSender
      : createTrustedSenderAuthorizer({ getMainWindow, log }),
    unauthorizedResult: unauthorizedIpcResult,
  };
  registerChatSurfaceIpcHandlers(ipcMain, {
    app, backendService, dialog, getMainWindow, workspaceAuthorization, browserSessionService, workspaceSnapshotStore, log,
  });
  registerWorkspaceStateIpcHandlers(ipcMain, { app, backendService, shellConfigService, workspaceAuthorization });
  registerChatUserQuestionIpcHandlers(ipcMain, { backendService, workspaceAuthorization });
  const workspace = registerWorkspaceServicesIpcHandlers(ipcMain, {
    app, backendService, shellConfigService, dialog, getMainWindow, log, getMainLifecycle, toolExecutor,
    trashItemImpl, showItemInFolderImpl, openPathImpl, sendBridgeEvent, workspaceSnapshotStore,
    getDisplayMediaSourceHandler, versionedTempRecoveryStarter, modelTuningService, engineTuningService,
    workspaceAuthorization,
  });
  const { workspaceRootCoordinator } = workspace;
  // Row 197: the chat's Live tab. Its capture is armed through the display-media handler (lane A1).
  backendService.runView?.setCaptureSource?.(() => (getDisplayMediaSourceHandler ? getDisplayMediaSourceHandler() : null));
  const runViewIpc = require('./run-view-ipc-registration');
  const runViewGates = {
    getHolder: () => backendService.runView || null,
    isEnabled: () => backendService.featureFlags?.live_run_view !== false,
    isHostedServer: () => backendService.hostMode === 'server',
    isSandboxOnly: () => backendService.commandSandbox?.enabled === true,
  };
  backendService.runView?.setStartGate?.(runViewIpc.startGateFor(runViewGates)); // a turn's end restarts under the same rules
  runViewIpc.registerRunViewIpc(ipcMain, { ...runViewGates, authorization: workspaceAuthorization });
  // Row 196: the computer tool's owner controls (Tools menu, Settings, the chat's pause line).
  require('./computer-use-ipc-registration').registerComputerUseIpc(ipcMain, {
    getHolder: () => backendService.toolExecutor?.computerUse || null, getBackendService: () => backendService,
    dialog, getMainWindow, sendBridgeEvent, authorization: workspaceAuthorization,
    isHostedServer: () => backendService.hostMode === 'server',
  });
  // Row 137: files opened from outside the Workspace. The launch buffer holds
  // what arrived before now (cold launch, macOS open-file, second launches).
  const outsideFiles = require('./outside-files/outside-file-ipc').registerOutsideFileIpc(ipcMain, {
    app, backendService, shellConfigService, dialog, getMainWindow, attachmentAssetStore, processRef,
    showItemInFolderImpl, sendBridgeEvent, workspaceRootCoordinator, workspaceAuthorization, log,
  });
  outsideFileLaunch?.attach?.(outsideFiles.service);
  void outsideFiles.service.restore();
  registerGuidanceKnowledgeIpcHandlers(ipcMain, {
    backendService, skillsService, knowledgeService, shellConfigService, dialog, getMainWindow,
    workspaceAuthorization,
  });
  // Row 123 slice 1f-1: the team member client; nothing of it loads while the flag is off. Slice 6-5: model sharing reads
  // the discovery scan (a scan before the engine handlers exist is a failed scan) and the model roots late-bound.
  let engineHandlers = null;
  const modelSources = {
    list: () => { if (!engineHandlers?.listLocalGgufs) throw new Error('scan_unavailable'); return engineHandlers.listLocalGgufs(); },
    roots: () => require('./team-model-roots').teamModelRoots({ userDataPath: app.getPath('userData'),
      libraryRoots: shellConfigService?.getLocalEngines?.()?.openaiCompatible?.managed?.libraryRoots }),
  };
  if (backendService?.featureFlags?.team === true) {
    require('./team-registration').registerTeam(ipcMain, { featureFlags: backendService.featureFlags, backendService,
      userDataPath: app.getPath('userData'), getSecureStore: () => backendService.secureStore || null,
      sendBridgeEvent, authorization: workspaceAuthorization, getMainLifecycle, appVersion: app.getVersion?.() || '', log,
      // E64: Force local means no team networking; the mode is read live and compared on every saved config change.
      readOfflineMode: () => offlineIntelligenceService.getMode(), modelSources,
      subscribeConfig: (listener) => { shellConfigService.on('changed', listener); return () => shellConfigService.off('changed', listener); } });
  }
  // Row 150: project boards. Always registered (each call answers `disabled` with the flag off); nothing is built or read before the first call.
  require('./board-ipc-registration').registerBoardIpc(ipcMain, { app, backendService, sendBridgeEvent, authorization: workspaceAuthorization, log });
  require('./sketch-ipc-registration').registerSketchIpc(ipcMain, { backendService, authorization: workspaceAuthorization, log }); // Row 149: a drawing's file node, checked against the chat's project root.
  engineHandlers = registerEngineIpcHandlers(ipcMain, {
    app, backendService, shellConfigService, processRef, dialog, getMainWindow, getLlamaServerManager,
    attachmentAssetStore, sendBridgeEvent, log, getMainLifecycle, workspaceAuthorization,
  });
  registerAppShellIpcHandlers(ipcMain, {
    app, backendService, shellConfigService, buildFeatureStatePayload, applyFeatureSettingsPatch,
    spellcheckSessionRef, getDiagnosticLogService, getLogRedactionPrefixes, processRef, log, getMainLifecycle,
    workspaceAuthorization,
  });
  registerSessionIpcHandlers(ipcMain, { backendService, shellConfigService, startDeferredServices, workspaceAuthorization });
  registerModelIpcHandlers(ipcMain, { backendService, setupService, workspaceAuthorization });
  registerSystemIpcHandlers(ipcMain, {
    backendService, logStore, updateService, log, refreshGpuMemorySample, getCurrentSystemStatsPayload,
    getSystemStats, getStartupAuditConfig, createStartupAuditMarkHandler, createStartupAuditMarksBatchHandler,
    workspaceAuthorization,
  });
  registerPersonalityIpcHandlers(ipcMain, {
    backendService, shellConfigService, personalityWorkspace, log, workspaceAuthorization,
  });

  const { registerSaveFileHandler } = require('../save-file-handler');
  registerSaveFileHandler({
    ipcMainLike: ipcMain,
    dialog,
    getMainWindow,
    getProtectedRoots: () => [app.getPath('userData')],
    log,
    authorization: workspaceAuthorization,
  });

  const dataLifecycleRuntime = require('./data-lifecycle-ipc-registration').registerDataLifecycleRuntime(ipcMain, {
    app,
    backendService,
    attachmentStore: attachmentAssetStore,
    shellConfigService,
    workspaceRootCoordinator,
    dialog,
    getMainWindow,
    sendBridgeEvent,
    log,
  });

  // UIUX-003 native-close dirty-buffer guard. Created here (before the window
  // exists) so its resolvePreflight/authorizeNextClose seams are available to
  // the aux handlers below; attached to the BrowserWindow at creation via the
  // returned `windowExitGuard` (main-window-composition).
  const windowExitGuard = createWindowExitGuard({ getMainLifecycle, log });
  // Row 88: the appearance relay (D8) and the Jenny chat's settings port it feeds.
  const { appearanceRelay } = require('./primary-chat-wiring').attachPrimarySettings(backendService, { configService: () => shellConfigService, applyFeatureSettingsPatch, getMainWindow, log });

  registerAuxiliaryIpcHandlers({
    ipcMainLike: ipcMain,
    windowExitGuard,
    appearanceRelay,
    getProtectedRoots: () => [app.getPath('userData')],
    personalityWorkspace,
    artifactService,
    backendService,
    getProactiveStatePayload,
    shellConfigService,
    companionService,
    suggestionCache,
    getCachedOrGenerateSuggestions,
    generateCommitMessage,
    offlineIntelligenceService,
    modelTuningService,
    engineTuningService,
    dialog,
    getMainWindow,
    workspaceRootCoordinator,
    ipcAuthorization: workspaceAuthorization,
    prepareAttachmentEntries,
    attachmentAssetStore,
    processRef,
    os,
    isChildPath,
    clipboard,
    nativeImage,
    shell: require('electron')?.shell || null,
    log,
    getMainLifecycle,
    getWindowState,
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
    homeAssistantService: backendService?.homeAssistantService || null,
    projectNotesService: backendService?.projectNotesService || null,
    workspaceGitService: workspace.workspaceGitService,
    workspaceIdeService: workspace.workspaceIdeService,
  });

  return {
    workspaceIdeService: workspace.workspaceIdeService,
    workspaceFileMapService: workspace.workspaceFileMapService,
    workspacePtyService: workspace.workspacePtyService,
    workspaceRunTaskService: workspace.workspaceRunTaskService,
    workspaceTestRunnerService: workspace.workspaceTestRunnerService,
    versionedWorkspaceFileService: workspace.versionedWorkspaceFileService,
    workspaceRootExternalTransitionBroker: workspace.workspaceRootExternalTransitionBroker,
    workspaceRootCoordinator,
    workspaceRootRuntime: workspace.workspaceRootRuntime,
    windowExitGuard,
    dataLifecycleRuntime,
  };
}

module.exports = {
  registerFeatureIpcHandlers,
  registerGuidanceIpcHandlers,
  registerKnowledgeIpcHandlers,
  registerMainIpcHandlers,
  registerOllamaTrayRemediationIpcHandlers,
  registerWorkspaceFileMapIpcHandlers,
  registerWorkspaceFsIpcHandlers,
  registerWorkspaceGitIpcHandlers,
  registerWorkspacePtyIpcHandlers,
  registerWorkspaceTerminalShutdownTask,
  registerWorkspaceTestRunnerIpcHandlers,
  registerWorkspaceIpcHandlers,
  registerWorkspaceRootIpcHandlers,
};
