const { createArtifactFileActions } = require('./artifact-file-actions');
const { createChatImageFileActions } = require('./chat-image-file-actions');
const { registerWorkspaceRecoveryIpcHandlers } = require('./workspace-recovery-ipc-handlers');
const { registerUsageStatsIpc } = require('./main/usage-stats-ipc');
const {
  createChatGptAuthServiceDefault,
  ensureChatgptAuthService,
} = require('./provider-auth-runtime');
const { registerArtifactIpcHandlers } = require('./main/ipc-registration/sessions-ipc');
const { registerMemoryIpcHandlers } = require('./main/ipc-registration/personality-memory-ipc');
const {
  registerRuntimeDiagnosticsIpcHandlers,
  registerUsageIpcHandlers,
} = require('./main/ipc-registration/system-ipc');
const { registerMcpIpcHandlers, registerSetupIpcHandlers } = require('./main/ipc-registration/setup-ipc');
const {
  registerCompanionIpcHandlers,
  registerHomeIpcHandlers,
  registerProactiveIpcHandlers,
} = require('./main/ipc-registration/home-companion-ipc');
const { registerEngineSettingsIpcHandlers } = require('./main/ipc-registration/engines-ipc');
const {
  registerUiSettingsIpcHandlers,
  registerWindowIpcHandlers,
} = require('./main/ipc-registration/app-shell-ipc');
const { registerTuningIpcHandlers } = require('./main/ipc-registration/tuning-ipc');
const { registerChatStreamIpcHandlers } = require('./main/ipc-registration/chat-ipc');
const { registerToolIpcHandlers } = require('./main/ipc-registration/tools-ipc');

// The auxiliary IPC surface registered after the main registry: each domain's
// channels live in services/main/ipc-registration/ beside the main registry's
// domains, and are registered here in their fixed channel order, every batch
// behind the same ipcAuthorization.
function registerAuxiliaryIpcHandlers({
  ipcMainLike,
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
  modelTuningService = null,
  engineTuningService = null,
  dialog,
  getMainWindow,
  getProtectedRoots = () => [],
  workspaceRootCoordinator = null,
  ipcAuthorization = {},
  prepareAttachmentEntries,
  attachmentAssetStore,
  processRef,
  os,
  isChildPath,
  clipboard,
  nativeImage,
  shell,
  log,
  getMainLifecycle,
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
  homeAssistantService,
  projectNotesService = null,
  getWindowState,
  windowExitGuard = null,
  appearanceRelay = null,
  createAuthService = createChatGptAuthServiceDefault,
  workspaceGitService = null,
  workspaceIdeService = null,
} = {}) {
  const fileActions = createArtifactFileActions({ artifactService, dialog, getMainWindow, clipboard, nativeImage });
  const chatImageActions = createChatImageFileActions({
    service: backendService, dialog, getMainWindow, clipboard, nativeImage, shell,
  });
  ensureChatgptAuthService({ backendService, log, createAuthService });
  registerArtifactIpcHandlers(ipcMainLike, {
    artifactService, backendService, fileActions, chatImageActions, ipcAuthorization,
  });
  registerMemoryIpcHandlers(ipcMainLike, {
    backendService, personalityWorkspace, dialog, getMainWindow, getProtectedRoots, log, ipcAuthorization,
  });
  registerRuntimeDiagnosticsIpcHandlers(ipcMainLike, { backendService, ipcAuthorization });
  registerSetupIpcHandlers(ipcMainLike, { setupService, ollamaInstallService, ipcAuthorization });
  registerMcpIpcHandlers(ipcMainLike, { mcpDiscoveryService, reaInstallService, ipcAuthorization });
  registerHomeIpcHandlers(ipcMainLike, {
    schedulerService, shellConfigService, homeAssistantService, projectNotesService,
    linkStatusService, calendarService, ipcAuthorization,
  });
  registerCompanionIpcHandlers(ipcMainLike, {
    backendService, shellConfigService, companionService, personalityWorkspace, getProactiveStatePayload,
    suggestionCache, getCachedOrGenerateSuggestions, generateCommitMessage, ipcAuthorization,
  });
  registerEngineSettingsIpcHandlers(ipcMainLike, {
    backendService, shellConfigService, offlineIntelligenceService, processRef, log, ipcAuthorization,
  });
  registerUiSettingsIpcHandlers(ipcMainLike, { shellConfigService, ipcAuthorization });
  registerTuningIpcHandlers(ipcMainLike, {
    backendService, shellConfigService, modelTuningService, engineTuningService, log, ipcAuthorization,
  });
  registerProactiveIpcHandlers(ipcMainLike, {
    backendService, shellConfigService, getProactiveStatePayload, workspaceRootCoordinator, ipcAuthorization,
  });
  registerChatStreamIpcHandlers(ipcMainLike, {
    backendService, shellConfigService, dialog, getMainWindow, prepareAttachmentEntries,
    attachmentAssetStore, processRef, isChildPath, log, ipcAuthorization,
  });
  registerWindowIpcHandlers(ipcMainLike, {
    clipboard, getMainWindow, getWindowState, getMainLifecycle, windowExitGuard, appearanceRelay, log,
    ipcAuthorization,
  });
  registerToolIpcHandlers(ipcMainLike, { backendService, toolExecutor, toolPermissionStore, ipcAuthorization });
  registerUsageIpcHandlers(ipcMainLike, { usageHistory, ipcAuthorization });

  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike, backendService, ipcAuthorization, gitService: workspaceGitService, ideService: workspaceIdeService,
    sandboxTrashItem: typeof shell?.trashItem === 'function' ? (targetPath) => shell.trashItem(targetPath) : null,
  });
  // Home "Usage" widget read (row 98), beside usage.getSnapshot: every range from the durable rollup.
  registerUsageStatsIpc(ipcMainLike, { usageHistory, logger: log, authorization: ipcAuthorization });
}

module.exports = {
  registerAuxiliaryIpcHandlers,
};
