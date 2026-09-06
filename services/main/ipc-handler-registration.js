const os = require('os');

const { prepareAttachmentEntries } = require('../attachment-service');
const { ExclusiveGpuCoordinator } = require('../backend/exclusive-gpu-coordinator');
const { registerLlamaServerIpcHandlers } = require('./llama-server-ipc-handlers');
const { getCachedOrGenerateSuggestions } = require('../backend/backend-suggestions');
const { generateCommitMessage } = require('../backend/backend-commit');
const {
  generateInlineCompletion,
  listLoadedInlineModels,
  unloadInlineModel,
} = require('../backend/backend-inline-complete');
const { isChildPath } = require('../backend/path-utils');
const { PERSONALITY_ERROR_CODES } = require('../backend/error-codes');
const { registerAuxiliaryIpcHandlers } = require('../auxiliary-ipc-handlers');
const { ModelTuningService } = require('../model-tuning-service');
const { EngineTuningService } = require('../engine-tuning-service');
const {
  applyWebSearchSecret,
  buildWebSearchSecretStatus,
  registerFeatureIpcHandlers: registerFeatureIpcHandlersWithDeps,
} = require('../feature-settings-service');
const { registerPluginsRuntime } = require('./plugins-ipc-registration');
const { registerChatGptPlanUsageIpc } = require('./chatgpt-plan-usage-ipc');
const { registerClientLogIpcHandler } = require('./client-log-forwarding');
const { createWindowExitGuard } = require('./window-exit-guard');
const { createSpellcheckSessionController } = require('./spellcheck-session-controller');
const {
  createTrustedSenderAuthorizer,
  unauthorizedIpcResult,
} = require('./ipc-sender-authorization');
const { getBridgeChannel, registerIpcInvokeHandlers } = require('../ipc-contract');
const { WorkspaceIdeService } = require('../workspace-ide-service');
const { WorkspaceImportService } = require('../workspace-import-service');
const { VersionedWorkspaceFileService } = require('../versioned-workspace-file-service');
const { startVersionedWorkspaceTempRecovery } = require('../versioned-workspace-temp-recovery');
const { createWorkspaceIdeWatcher } = require('../workspace-ide-watcher');
const { WorkspaceGitService } = require('../workspace-git-service');
const { WorkspaceFileMapService } = require('../workspace-file-map-service');
const { WorkspaceTerminalService } = require('../workspace-terminal-service');
const { WorkspacePtyService } = require('../workspace-pty-service');
const { WorkspaceRunTaskService } = require('../workspace-run-task-service');
const { createWorkspaceTestRunnerWiring } = require('./workspace-test-runner-wiring');
const { getWorkspaceRootStatePayload } = require('../workspace-root-ipc');
const { createWorkspaceRootRuntime } = require('../workspace-root-runtime');
const {
  WorkspaceRootExternalTransitionBroker,
} = require('./workspace-root-external-transition-broker');
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

// ollamaTray.* namespace: owner-triggered remediation for the Ollama
// tray-app conflict (see ollama-tray-conflict.js for detection and
// ollama-tray-remediation.js for the remediation actions). Gated by the
// ollama_tray_remediation feature flag; a disabled flag or missing
// backendService means nothing is registered (channels stay unhandled).
// Every handler is fail-soft — it never throws across the IPC boundary.
//
// detectImpl/quitImpl/disableImpl are injectable seams purely for
// determinism in tests; production callers omit them and get the real
// detection/remediation module functions.
function registerOllamaTrayRemediationIpcHandlers(ipcMainLike, {
  backendService,
  log,
  enabled = false,
  detectImpl,
  quitImpl,
  disableImpl,
} = {}) {
  if (!enabled || !backendService) {
    return [];
  }

  const logEvent = typeof log === 'function' ? log : () => {};
  const {
    detectOllamaTrayConflictSync,
  } = require('../backend/ollama-tray-conflict');
  const {
    quitOllamaTrayAppSync,
    disableOllamaStartupShortcutsSync,
  } = require('../backend/ollama-tray-remediation');

  const detect = detectImpl || detectOllamaTrayConflictSync;
  const quit = quitImpl || quitOllamaTrayAppSync;
  const disable = disableImpl || disableOllamaStartupShortcutsSync;

  return registerIpcInvokeHandlers(ipcMainLike, {
    'ollamaTray.status': () => {
      try {
        const { detected, trayProcesses, startupShortcuts } = detect({
          platform: process.platform,
          env: process.env,
          logger: undefined,
        }) || {};
        return {
          ok: true,
          supported: process.platform === 'win32',
          platform: process.platform,
          detected: Boolean(detected),
          trayProcesses: Array.isArray(trayProcesses) ? trayProcesses : [],
          startupShortcuts: Array.isArray(startupShortcuts) ? startupShortcuts : [],
        };
      } catch (error) {
        return { ok: false, reason: String((error && error.message) || error) };
      }
    },
    'ollamaTray.quitTrayApp': () => {
      let result;
      try {
        result = quit({});
      } catch (error) {
        result = { ok: false, killedPids: [], reason: String((error && error.message) || error) };
      }
      logEvent(result.ok ? 'INFO' : 'WARN', 'ollama.tray_remediation_quit', {
        killedPids: result.killedPids,
        reason: result.reason,
      });
      return result;
    },
    'ollamaTray.disableStartupShortcut': () => {
      let result;
      try {
        result = disable({});
      } catch (error) {
        result = { ok: false, disabled: [], skipped: [], reason: String((error && error.message) || error) };
      }
      logEvent(result.ok ? 'INFO' : 'WARN', 'ollama.tray_remediation_disable_startup', {
        disabled: result.disabled,
        skipped: result.skipped,
        reason: result.reason,
      });
      return result;
    },
    'ollamaTray.restartEngine': async () => {
      try {
        const manager = backendService.ollamaManager;
        await manager.stop();
        const startResult = await manager.start();
        let running = Boolean(startResult && startResult.started);
        if (!running && typeof manager._isRunning === 'function') {
          running = Boolean(await manager._isRunning());
        }
        const ok = running;
        const result = {
          ok,
          running,
          ...(ok ? {} : { reason: (startResult && startResult.failure && startResult.failure.remediation)
            || 'engine_not_running' }),
        };
        logEvent(ok ? 'INFO' : 'WARN', 'ollama.tray_remediation_restart', {
          running: result.running,
          reason: result.reason,
        });
        return result;
      } catch (error) {
        const result = { ok: false, running: false, reason: String((error && error.message) || error) };
        logEvent('WARN', 'ollama.tray_remediation_restart', {
          running: result.running,
          reason: result.reason,
        });
        return result;
      }
    },
  });
}

// Personality v3 agent-name seam. The name is shell-config state, not a
// workspace file, so the personality IPC composes the two owners here. Both
// helpers degrade to the default name rather than throwing across the preload
// seam: a failed name write must not discard the note the user just typed.
function readAgentName(shellConfigService) {
  try {
    const identity = typeof shellConfigService?.getAssistantIdentity === 'function'
      ? shellConfigService.getAssistantIdentity()
      : null;
    return String(identity?.agentName || '').trim() || 'Jenny';
  } catch (_error) {
    return 'Jenny';
  }
}

// Returns `{ agentName, persisted }`. `persisted` is the honest signal the
// caller needs: reporting ok:true with the OLD name after a failed write is how
// a user silently loses a rename. The name is compared by nothing -- the
// service clips to 80 chars, so only the write outcome decides.
function persistAgentName(shellConfigService, value, logEvent) {
  const next = String(value ?? '').trim();
  if (!next) return { agentName: readAgentName(shellConfigService), persisted: true };
  if (typeof shellConfigService?.updateAssistantIdentity !== 'function') {
    return { agentName: readAgentName(shellConfigService), persisted: false };
  }
  try {
    const identity = shellConfigService.updateAssistantIdentity({ agentName: next });
    return {
      agentName: String(identity?.agentName || next).trim() || 'Jenny',
      persisted: true,
    };
  } catch (error) {
    logEvent?.('WARN', 'personality.agent_name_write_failed', {
      reason: String(error?.code || 'write_failed').slice(0, 64),
    });
    return { agentName: readAgentName(shellConfigService), persisted: false };
  }
}

function registerGuidanceIpcHandlers(ipcMainLike, skillService, tipService) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'skills.getState': () => skillService.getState(),
    'skills.updateSettings': (_, patch) => skillService.updateSettings(patch),
    'skills.openScopeFolder': (_, scope) => skillService.openScopeFolder(scope),
    'tips.getState': () => tipService.getState(),
    'tips.updateSettings': (_, patch) => tipService.updateSettings(patch),
  });
}

// knowledge_layer (default-off, internal): register the knowledge.* invoke
// handlers ONLY when the flag is on. Flag-off leaves the channels unregistered
// so a renderer invoke fails as an unknown channel (the intended byte-identical
// -off posture); the service itself also stays inert regardless.
function registerKnowledgeIpcHandlers(
  ipcMainLike,
  knowledgeService,
  { enabled = false, dialog = null, getOwnerWindow = () => null } = {},
) {
  if (!enabled || !knowledgeService) {
    return [];
  }
  return registerIpcInvokeHandlers(ipcMainLike, {
    'knowledge.getState': () => knowledgeService.getStateSnapshot(),
    'knowledge.addFolder': (_, payload) => knowledgeService.addFolder(payload || {}),
    'knowledge.removeFolder': (_, payload) => knowledgeService.removeFolder(payload || {}),
    // Native directory picker → addFolder in one round-trip (mirrors
    // chooseWorkspaceRoot; the picked path still runs the full addFolder
    // validation: realpath, sensitive-path block, is-directory, dedupe, cap).
    'knowledge.chooseFolder': async () => {
      if (!dialog || typeof dialog.showOpenDialog !== 'function') {
        return { ok: false, reason: 'picker_unavailable' };
      }
      const result = await dialog.showOpenDialog(getOwnerWindow(), {
        title: 'Add Knowledge Folder',
        properties: ['openDirectory'],
      });
      if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
        return { ok: false, reason: 'canceled' };
      }
      return knowledgeService.addFolder({ path: result.filePaths[0] });
    },
  });
}

function registerFeatureIpcHandlers(
  ipcMainLike,
  {
    getState = () => ({}),
    updateSettings = () => ({}),
    getWebSearchSecretStatus = null,
    setWebSearchSecret = null,
  } = {}
) {
  registerFeatureIpcHandlersWithDeps({
    ipcMainLike,
    getState,
    updateSettings,
    getWebSearchSecretStatus,
    setWebSearchSecret,
  });
}

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
  tipsService,
  suggestionCache,
  offlineIntelligenceService,
  applyFeatureSettingsPatch,
  dialog,
  getMainWindow,
  attachmentAssetStore,
  processRef = process,
  clipboard,
  log,
  getMainLifecycle,
  getWindowState,
  startDeferredServices = () => {},
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
  // Managed llama-server manager (services/main/llama-server-manager.js), owned
  // by the runtime-shutdown controller; null until main wires it.
  getLlamaServerManager = () => null,
  getCurrentSystemStatsPayload,
  buildFeatureStatePayload,
  getOverlayRef = () => null,
  setOverlayRef = () => {},
  isCometOverlayEnabled = () => false,
  createCometOverlay = () => null,
  handleCometOverlayToggle = () => null,
  normalizeCometOverlayPresencePayload = (payload) => payload,
  getDiagnosticLogService = () => logStore,
  getProcessLogWriter = () => null,
  getLogRedactionPrefixes = () => [],
  trashItemImpl = null,
  showItemInFolderImpl = null,
  openPathImpl = null,
  sendBridgeEvent = () => {},
  workspaceSnapshotStore = null,
  getDisplayMediaSourceHandler = null,
  authorizeWorkspaceSender = null,
  versionedTempRecoveryStarter = startVersionedWorkspaceTempRecovery,
  spellcheckSessionRef = null,
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
  registerWorkspaceIpcHandlers(ipcMain, shellConfigService, {
    authorization: workspaceAuthorization,
    getRootContext: () => backendService.workspaceRootCoordinator?.captureContext?.() || null,
  });
  // W2-2 background-job chips: snapshot + kill. Kill dispatches an OS
  // pid-tree kill, so both handlers sit behind the trusted-sender
  // authorizer like the rest of the workspace-mutating surface.
  registerIpcInvokeHandlers(ipcMain, {
    'backgroundJobs.getState': () =>
      backendService.backgroundJobTracker?.getState?.() || { jobs: [], generatedAt: '' },
    'backgroundJobs.kill': (_, jobId) =>
      backendService.backgroundJobTracker?.killJob?.(jobId)
      || { ok: false, reason: 'unavailable' },
  }, workspaceAuthorization);
  registerIpcInvokeHandlers(ipcMain, {
    'chat.hasPendingUserQuestions': (_, questionRef) =>
      backendService.hasPendingUserQuestions(questionRef),
    'chat.answerUserQuestions': (_, questionRef, payload) =>
      backendService.answerUserQuestions(questionRef, payload),
    'chat.declineUserQuestions': (_, questionRef) =>
      backendService.declineUserQuestions(questionRef),
  }, workspaceAuthorization);
  // These owners are constructed later because they depend on the terminal /
  // watcher composition. Their providers stay lazy so services registered
  // earlier cannot silently fall back to legacy root or file access.
  let workspaceRootCoordinator = null;
  let versionedWorkspaceFileService = null;
  const workspaceIdeService = new WorkspaceIdeService({
    configService: shellConfigService,
    logger: log,
    trashItemImpl,
    showItemInFolderImpl,
    openPathImpl,
    snapshotStore: workspaceSnapshotStore,
    rootContextProvider: () => workspaceRootCoordinator,
    gitServiceProvider: () => workspaceGitService,
  });
  const workspaceImportService = new WorkspaceImportService({
    rootContextProvider: () => workspaceRootCoordinator,
    isQolEnabled: () => backendService?.featureFlags?.workspace_explorer_qol === true,
    isImportEnabled: () => backendService?.featureFlags?.workspace_external_import === true,
    sendProgress: (payload) => sendBridgeEvent('workspaceFs.onImportProgress', payload),
    logger: log,
  });
  const workspaceIdeWatcher = createWorkspaceIdeWatcher({
    getRoot: () => String(shellConfigService.getToolsWorkspaceRoot?.() || ''),
    getContext: () => backendService.workspaceRootCoordinator?.captureContext?.() || {
      rootPath: String(shellConfigService.getToolsWorkspaceRoot?.() || ''),
      rootId: null,
      generation: 0,
      phase: 'ready',
    },
    service: workspaceIdeService,
    emitChange: (payload) => sendBridgeEvent('workspaceFs.onChange', payload),
    // External git ops (commit/checkout/branch-switch) touch only `.git`, which
    // the file watcher ignores; this dedicated signal refreshes the renderer git
    // store so the tree/statusbar/gutter decorations don't go stale.
    emitGitMeta: (payload) => sendBridgeEvent('workspaceFs.onGitMetaChange', payload),
    // WIDE-028: typed watcher lifecycle push so the renderer watch-controller
    // can reset its ownership latch and retry after a silent native error.
    emitLifecycle: (payload) => sendBridgeEvent('workspaceFs.onWatchLifecycle', payload),
    logger: log,
  });
  // workspaceGit.* SCM namespace, gated by the default-on workspace_git flag
  // read live off the backend service's resolved feature flags.
  const workspaceGitService = new WorkspaceGitService({
    configService: shellConfigService,
    featureFlagProvider: () => backendService.featureFlags,
    rootContextProvider: () => backendService.workspaceRootCoordinator || null,
    logger: log,
    trashItemImpl,
  });
  // Reachable from the Electron tool bridge (electron-tool-bridge.js) as
  // `service.workspaceGitService`, where `service` is this same backendService
  // instance threaded through startManagedSidecarChatStream ->
  // buildManagedSidecarChatSendOptions -> executeElectronToolRequest. This lets
  // the sidecar-internal "__jenny_git_checkpoint" op reach createCheckpoint()
  // before any chat turn runs, without adding a new constructor param.
  backendService.workspaceGitService = workspaceGitService;
  registerWorkspaceGitIpcHandlers(ipcMain, workspaceGitService, workspaceAuthorization);
  // workspaceFileMap.* namespace: interactive dependency-graph "Map" tab,
  // gated by the default-on workspace_file_map flag (renderer-side gate —
  // registration here is unconditional, matching the house pattern). Reuses
  // the already-constructed workspaceIdeService/workspaceGitService so file
  // enumeration/reads and co-change history share the same root-scoped,
  // fail-soft primitives as the rest of the Workspace IDE surface.
  const workspaceFileMapService = new WorkspaceFileMapService({
    ideService: workspaceIdeService,
    gitService: workspaceGitService,
    versionedFileServiceProvider: () => versionedWorkspaceFileService,
    logger: log,
  });
  registerWorkspaceFileMapIpcHandlers(ipcMain, workspaceFileMapService, workspaceAuthorization);
  // workspaceTestRunner.* namespace, gated by the default-on workspace_test_runner
  // flag read live off the backend service's resolved feature flags. Per-workspace
  // -root config + history live in userData and follow the active root.
  const workspaceTestRunnerService = createWorkspaceTestRunnerWiring({
    app,
    shellConfigService,
    featureFlagProvider: () => backendService.featureFlags,
    // S13: live run-state push to the Home widget (workspaceTestRunner.onStateChanged).
    sendBridgeEvent,
    log,
  });
  registerWorkspaceTestRunnerIpcHandlers(ipcMain, workspaceTestRunnerService, workspaceAuthorization);
  // The model-facing `verify` tool runs the user's own saved Test Runner
  // configurations through this same service. It is created here, after
  // runtime-service-composition built the tool executor, so it is attached
  // rather than constructor-injected.
  if (toolExecutor && typeof toolExecutor.attachWorkspaceTestRunnerService === 'function') {
    toolExecutor.attachWorkspaceTestRunnerService(workspaceTestRunnerService);
  }
  const workspaceTerminalService = new WorkspaceTerminalService({
    configService: shellConfigService,
    sendBridgeEvent,
    logger: log,
  });
  registerIpcInvokeHandlers(ipcMain, {
    'workspaceTerminal.start': () => workspaceTerminalService.start(),
    'workspaceTerminal.write': (_, payload) => workspaceTerminalService.write(payload),
    'workspaceTerminal.signal': (_, payload) => workspaceTerminalService.signal(payload),
    'workspaceTerminal.kill': (_, payload) => workspaceTerminalService.kill(payload),
  }, workspaceAuthorization);
  // workspacePty.* namespace: real ConPTY terminal, gated by the default-ON
  // workspace_pty_terminal flag read live off the backend service's resolved
  // feature flags (env `JENNY_ENABLE_WORKSPACE_PTY_TERMINAL=0` rolls back to the
  // legacy line terminal). Flag posture lives inside the service; registration
  // here is unconditional, matching the house pattern.
  const workspacePtyService = new WorkspacePtyService({
    configService: shellConfigService,
    featureFlagProvider: () => backendService.featureFlags,
    sendBridgeEvent,
    logger: log,
  });
  registerWorkspacePtyIpcHandlers(ipcMain, workspacePtyService, workspaceAuthorization);
  // workspaceRunTask.* namespace: UIUX-014 main-owned run-task identity/exit.
  const workspaceRunTaskService = new WorkspaceRunTaskService({ configService: shellConfigService, sendBridgeEvent, logger: log });
  registerIpcInvokeHandlers(ipcMain, {
    'workspaceRunTask.start': (_, payload) => workspaceRunTaskService.start(payload),
    'workspaceRunTask.kill': (_, payload) => workspaceRunTaskService.kill(payload),
  }, workspaceAuthorization);
  const workspaceRootRuntime = createWorkspaceRootRuntime({
    configService: shellConfigService,
    dialog,
    getOwnerWindow: getMainWindow,
    backendService,
    watcher: workspaceIdeWatcher,
    terminalService: workspaceTerminalService,
    ptyService: workspacePtyService,
    testRunnerService: workspaceTestRunnerService,
    runTaskService: workspaceRunTaskService,
    logger: log,
  });
  workspaceRootCoordinator = workspaceRootRuntime.coordinator;
  backendService.workspaceRootCoordinator = workspaceRootCoordinator;
  const workspaceRootExternalTransitionBroker = new WorkspaceRootExternalTransitionBroker({
    sendRequest: (payload) => {
      const ownerWindow = getMainWindow?.();
      if (!ownerWindow
        || (typeof ownerWindow.isDestroyed === 'function' && ownerWindow.isDestroyed())) {
        return false;
      }
      sendBridgeEvent('workspaceRoot.onExternalTransitionRequested', payload);
      return true;
    },
    cancelTransition: (payload) => workspaceRootCoordinator.cancel(payload),
    logger: log,
  });
  backendService.workspaceRootTransitionBroker = workspaceRootExternalTransitionBroker;
  const mainLifecycle = getMainLifecycle?.();
  if (typeof mainLifecycle?.registerShutdownTask === 'function') {
    mainLifecycle.registerShutdownTask(() => modelTuningService.dispose());
    mainLifecycle.registerShutdownTask(() => engineTuningService.dispose());
    mainLifecycle.registerShutdownTask(() => workspaceRootExternalTransitionBroker.dispose());
  } else if (typeof app?.once === 'function') {
    app.once('will-quit', () => {
      modelTuningService.dispose();
      engineTuningService.dispose();
      void workspaceRootExternalTransitionBroker.dispose();
    });
  }
  versionedWorkspaceFileService = new VersionedWorkspaceFileService({
    rootContext: workspaceRootCoordinator,
    writeObserver: workspaceIdeWatcher.writeObserver,
    logger: log,
  });
  void versionedTempRecoveryStarter({ rootContext: workspaceRootCoordinator, logger: log });
  backendService.versionedWorkspaceFileService = versionedWorkspaceFileService;
  registerWorkspaceFsIpcHandlers(ipcMain, workspaceIdeService, {
    watcher: workspaceIdeWatcher,
    versionedFileService: versionedWorkspaceFileService,
    importService: workspaceImportService,
    authorization: workspaceAuthorization,
  });
  registerWorkspaceRootIpcHandlers(ipcMain, {
    getState: () => getWorkspaceRootStatePayload(shellConfigService, workspaceRootCoordinator),
    captureContext: () => workspaceRootCoordinator.captureContext(),
    prepareChoose: () => workspaceRootCoordinator.prepareChoose(),
    prepareClear: () => workspaceRootCoordinator.prepareClear(),
    commit: (payload) => workspaceRootCoordinator.commit(payload),
    cancel: (payload) => workspaceRootCoordinator.cancel(payload),
    respondExternalTransition: (payload) => workspaceRootExternalTransitionBroker.respond(payload),
    authorization: workspaceAuthorization,
  });
  // displayMediaPicker.respond: renderer's answer to a pending
  // session.setDisplayMediaRequestHandler request (see
  // services/main/display-media-source-handler.js). Guarded against a missing
  // getter for older test callers that construct registerMainIpcHandlers
  // without it.
  registerIpcInvokeHandlers(ipcMain, {
    'displayMediaPicker.respond': (_event, requestId, sourceId) => {
      const handler = getDisplayMediaSourceHandler && getDisplayMediaSourceHandler();
      return handler ? handler.resolvePick(requestId, sourceId) : false;
    },
  });
  // Belt-and-braces orphan guard: graceful quit now runs through the main
  // lifecycle's awaited shutdown task list, so the async piped-terminal tree
  // kill can finish before app.exit(). The app.once fallback keeps standalone
  // test/composition callers covered when no lifecycle is present. Both
  // services are ALSO returned below so main.js can thread them into
  // stopRuntimeBeforeQuit → disposeWorkspaceProcesses (runtime-shutdown.js);
  // the two paths coexist safely — both dispose() implementations are
  // idempotent, so whichever runs second is a no-op.
  registerWorkspaceTerminalShutdownTask({
    getMainLifecycle,
    app,
    workspaceTerminalService,
    workspacePtyService,
    log,
  });
  registerGuidanceIpcHandlers(ipcMain, skillsService, tipsService);
  registerKnowledgeIpcHandlers(ipcMain, knowledgeService, {
    enabled: backendService?.featureFlags?.knowledge_layer === true,
    dialog,
    getOwnerWindow: getMainWindow,
  });
  registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService,
    log,
    enabled: backendService?.featureFlags?.ollama_tray_remediation === true,
  });
  registerLlamaServerIpcHandlers(ipcMain, {
    getManager: getLlamaServerManager,
    userDataPath: app.getPath('userData'),
    repoRoot: processRef.cwd(),
    getMainWindow,
    dialogImpl: dialog,
    log,
    getPersistedModels: () => Object.values(
      shellConfigService?.getLocalEngines?.()?.openaiCompatible?.managed?.perModel || {}
    ).map((entry) => ({ tag: entry?.tag || '', modelPath: entry?.modelPath || '' })),
    getLibraryRoots: () => (
      shellConfigService?.getLocalEngines?.()?.openaiCompatible?.managed?.libraryRoots || []
    ),
    getOllamaTags: async () => {
      const payload = await backendService.listModelsForEngine('ollama');
      return payload?.available === false ? [] : (Array.isArray(payload?.data) ? payload.data : [])
        .map((entry) => String(entry?.id || '').trim()).filter(Boolean);
    },
    getOllamaBlob: (tag) => backendService.getOllamaModelBlob(tag),
  });
  const exclusiveGpuCoordinator = backendService.exclusiveGpuCoordinator
    || new ExclusiveGpuCoordinator({ logger: log });
  backendService.exclusiveGpuCoordinator = exclusiveGpuCoordinator;
  const disposeExclusiveGpu = () => exclusiveGpuCoordinator.dispose?.();
  const gpuLifecycle = getMainLifecycle?.();
  if (typeof gpuLifecycle?.registerShutdownTask === 'function') {
    gpuLifecycle.registerShutdownTask(disposeExclusiveGpu);
  } else if (typeof app?.once === 'function') {
    app.once('will-quit', disposeExclusiveGpu);
  }
  registerPluginsRuntime(ipcMain, {
    app,
    backendService,
    processRef,
    getMainWindow,
    getMainLifecycle,
    sendBridgeEvent,
    showItemInFolderImpl,
    log,
  });
  // Composed AFTER registerPluginsRuntime so backendService.chatgptAuthService
  // (Stage 7 provider auth owner) already exists to attach the sign-out clear.
  const teardownChatgptPlanUsageIpc = registerChatGptPlanUsageIpc(ipcMain, {
    app,
    backendService,
    shellConfigService,
    sendBridgeEvent,
    log,
  });
  const chatgptPlanUsageLifecycle = getMainLifecycle?.();
  if (typeof chatgptPlanUsageLifecycle?.registerShutdownTask === 'function') {
    chatgptPlanUsageLifecycle.registerShutdownTask(teardownChatgptPlanUsageIpc);
  } else if (typeof app?.once === 'function') {
    app.once('will-quit', teardownChatgptPlanUsageIpc);
  }
  registerFeatureIpcHandlers(ipcMain, {
    getState: () => buildFeatureStatePayload(),
    updateSettings: (patch) => applyFeatureSettingsPatch(patch),
    getWebSearchSecretStatus: () => buildWebSearchSecretStatus({ backendService }),
    setWebSearchSecret: (payload) => applyWebSearchSecret({ backendService, payload }),
  });
  try {
    let sessionRef = spellcheckSessionRef;
    try {
      sessionRef ||= require('electron')?.session?.defaultSession || null;
    } catch (_error) {
      /* no electron runtime (tests): the controller degrades to one WARN */
    }
    const controller = createSpellcheckSessionController({
      sessionRef, getShellConfigService: () => shellConfigService, env: processRef?.env || process.env, log,
    });
    controller.apply();
    const spellcheckLifecycle = getMainLifecycle?.();
    if (typeof spellcheckLifecycle?.registerShutdownTask === 'function') {
      spellcheckLifecycle.registerShutdownTask(controller.dispose);
    } else if (typeof app?.once === 'function') {
      app.once('will-quit', controller.dispose);
    }
  } catch (error) {
    try {
      log('WARN', 'spellcheck.session_controller_failed', {
        message: String(error?.message || error).slice(0, 200),
      });
    } catch (_logError) {
      /* best-effort */
    }
  }
  registerClientLogIpcHandler(ipcMain, {
    getDiagnosticLogService,
    getProcessLogWriter,
    getRedactionPrefixes: getLogRedactionPrefixes,
    env: processRef?.env || process.env,
    log,
  });
  registerIpcInvokeHandlers(ipcMain, {
    'backend.getStatus': () => backendService.getBackendStatus(),
    'backend.retryStart': async () => {
      const status = await backendService.retryStart();
      if (status && status.phase === 'ready') {
        startDeferredServices();
      }
      return status;
    },
    'auth.getState': () => backendService.getAuthState(),
    'auth.updateLocalProfile': (_, payload) => backendService.updateLocalProfile(payload),
    'sessions.list': () => backendService.listSessions(),
    'sessions.create': (_, payload) => backendService.createSession(payload),
    'sessions.rename': (_, sessionId, title) => backendService.renameSession(sessionId, title),
    'sessions.delete': (_, sessionId) => backendService.deleteSession(sessionId),
    'sessions.getMessages': (_, sessionId) => backendService.getSessionMessages(sessionId),
    'sessions.setPreferences': (_, sessionId, preferences) =>
      backendService.setSessionPreferences(sessionId, preferences),
    'sessions.setMeta': (_, sessionId, meta) => backendService.setSessionMeta(sessionId, meta),
    'sessions.sweepEmpty': (_, options) => backendService.sweepEmptySessions(options),
    'sessions.updateMessage': (_, sessionId, messageId, patch) =>
      backendService.updateSessionMessage(sessionId, messageId, patch),
    'sessions.editAndTruncate': (_, sessionId, messageId, payload) =>
      backendService.editUserMessageAndTruncate(sessionId, messageId, payload),
    'sessions.exportSession': (_, sessionId) => {
      const { exportSession } = require('../backend/session-export-import');
      return exportSession(
        backendService.sessionStore,
        sessionId,
        backendService.attachmentAssetStore
      );
    },
    'sessions.importSession': (_, jsonPayload) => {
      const { importSession } = require('../backend/session-export-import');
      return importSession(
        backendService.sessionStore,
        jsonPayload,
        backendService.attachmentAssetStore,
        { shadowStore: backendService.shadowStore }
      );
    },
    'sessions.forkSession': (_, sessionId, atMessageId, options) => {
      const { forkSessionWithArtifacts } = require('../backend/session-branching');
      // Only `title` is renderer-authored; never spread the raw payload into
      // fork options (branchSessionId / artifactRewrite are internal seams).
      const requestedTitle = options && typeof options === 'object' && !Array.isArray(options)
        ? options.title
        : '';
      return forkSessionWithArtifacts(
        backendService.sessionStore,
        sessionId,
        atMessageId,
        {
          title: requestedTitle,
          shadowStore: backendService.shadowStore,
          artifactService: backendService.artifactService,
        }
      );
    },
    'templates.list': () => {
      const { SessionTemplateStore } = require('../backend/session-templates');
      return new SessionTemplateStore(shellConfigService).list();
    },
    'templates.save': (_, template) => {
      const { SessionTemplateStore } = require('../backend/session-templates');
      return new SessionTemplateStore(shellConfigService).save(template);
    },
    'templates.delete': (_, templateId) => {
      const { SessionTemplateStore } = require('../backend/session-templates');
      return new SessionTemplateStore(shellConfigService).delete(templateId);
    },
    'templates.apply': (_, templateId) => {
      const { SessionTemplateStore } = require('../backend/session-templates');
      return new SessionTemplateStore(shellConfigService).apply(
        templateId,
        backendService.sessionStore
      );
    },
    'models.list': () => backendService.listModels(),
    // Raw installed Ollama tags for the FIM completion-model picker. Scoped to
    // the ollama engine regardless of the chat engine (a FIM model is a separate
    // Ollama pull), so it reuses the sidecar's raw Ollama catalog directly instead
    // of the unified chat picker catalog and its provider entries.
    'models.listOllamaTags': () => backendService.listModelsForEngine('ollama'),
    // No ownStreamId: a user-driven activation excludes no stream, so ANY live
    // response refuses the switch (see loadModel).
    'models.load': (_, model) => backendService.loadModel(model),
    'models.unload': () => backendService.unloadModel(),
    'models.delete': (_, payload) => {
      if (!setupService) {
        return {
          status: 'failed',
          code: 'setup_unavailable',
          message: 'Setup service is unavailable.',
        };
      }
      const model = String((payload && payload.model) || '').trim();
      // Ollama tags are case-insensitive and a bare name means `:latest`, so
      // the loaded model ("gemma3") must match its list id ("gemma3:latest")
      // or the guard is defeatable. Mirrors renderer-model-library.js.
      const canonicalTag = (value) => {
        const tag = String(value || '').trim().toLowerCase();
        if (!tag) return '';
        const lastSegment = tag.slice(tag.lastIndexOf('/') + 1);
        return lastSegment.includes(':') ? tag : `${tag}:latest`;
      };
      if (model && canonicalTag(model) === canonicalTag(backendService.currentModel)) {
        return {
          status: 'failed',
          code: 'model_in_use',
          message: `"${model}" is the currently loaded model. Unload it before deleting.`,
        };
      }
      return setupService.deleteOllamaModel(payload);
    },
    'status.get': () => backendService.refreshStatusSnapshot(),
    'system.getStats': () => {
      // The renderer invokes this exactly once at boot; the 2s system:stats push
      // feeds it thereafter. Keep this unforced so cold boot never spawns a GPU probe.
      void refreshGpuMemorySample().catch(() => null);
      return getCurrentSystemStatsPayload();
    },
    'system.refreshStats': async () => {
      await refreshGpuMemorySample({ force: true, manual: true }).catch(() => null);
      return getCurrentSystemStatsPayload(null, { fresh: true });
    },
    'logs.list': () => logStore.list(),
    'diagnostics.logs.getSnapshot': (_event, options) => logStore.getSnapshot(options),
    'diagnostics.reportRendererError': require('../main-error-hardening').createRendererDiagnosticsHandler(log),
    'diagnostics.reportClientStreamMetrics': (_, payload) => {
      const { mergeClientTimingIntoTurnDiagnostic } = require('../backend/turn-diagnostic-dump');
      return mergeClientTimingIntoTurnDiagnostic({
        service: backendService,
        streamId: payload?.stream_id || payload?.streamId,
        clientTiming: payload?.client_timing || payload?.clientTiming,
      });
    },
    'diagnostics.getStartupAuditConfig': () => getStartupAuditConfig(),
    'diagnostics.reportStartupMark': createStartupAuditMarkHandler(),
    'diagnostics.reportStartupMarksBatch': createStartupAuditMarksBatchHandler(),
    'updates.getState': () => updateService.getState(),
    'updates.check': () => updateService.check(),
    'updates.download': () => updateService.download(),
    'updates.install': () => updateService.install(),
    'updates.skip': (_, version) => updateService.skip(version),
    // Personality v3. The agent NAME lives in shell-config (assistantIdentity)
    // while the note/about-you bodies live in the personality workspace, so the
    // one-call contract is composed here rather than inside either service.
    'personality.getState': () => personalityWorkspace.getState({
      agentName: readAgentName(shellConfigService),
    }),
    'personality.save': async (_, payload) => {
      const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const name = Object.prototype.hasOwnProperty.call(source, 'agentName')
        ? persistAgentName(shellConfigService, source.agentName, log)
        : { agentName: readAgentName(shellConfigService), persisted: true };
      // Files are saved either way -- a rejected rename must not discard the
      // note the user just typed -- but the result has to say the name failed.
      const result = await personalityWorkspace.save({ ...source, agentName: name.agentName });
      if (name.persisted) return result;
      return {
        ...result,
        ok: false,
        code: result?.code || PERSONALITY_ERROR_CODES.SAVE_PARTIAL_FAILURE,
        failed: [...(Array.isArray(result?.failed) ? result.failed : []), 'agentName'],
        agentName: name.agentName,
      };
    },
    'personality.clear': () => personalityWorkspace.clear({
      agentName: readAgentName(shellConfigService),
    }),
    'personality.openWorkspaceFolder': () => personalityWorkspace.openWorkspaceFolder(),
    'memory.contextFiles.getState': () => personalityWorkspace.getNotesState(),
    'memory.contextFiles.writeFile': (_, payload) => personalityWorkspace.writeNotes(payload),
    'memory.contextFiles.resetFile': () => personalityWorkspace.resetNotes(),
  });

  const { registerSaveFileHandler } = require('../save-file-handler');
  registerSaveFileHandler({
    ipcMainLike: ipcMain,
    dialog,
    getMainWindow,
    getProtectedRoots: () => [app.getPath('userData')],
    log,
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
  const windowExitGuard = createWindowExitGuard({
    getMainLifecycle,
    log,
  });

  registerAuxiliaryIpcHandlers({
    ipcMainLike: ipcMain,
    windowExitGuard,
    personalityWorkspace,
    artifactService,
    backendService,
    getProactiveStatePayload,
    shellConfigService,
    companionService,
    suggestionCache,
    getCachedOrGenerateSuggestions,
    generateCommitMessage,
    generateInlineCompletion,
    listLoadedInlineModels,
    unloadInlineModel,
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
    log,
    getMainLifecycle,
    getWindowState,
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
    homeAssistantService: backendService?.homeAssistantService || null,
    chatStreamBridge,
  });

  ipcMain.on(getBridgeChannel('comet.sendOverlayState', 'send'), (_event, data) => {
    const normalized = normalizeCometOverlayPresencePayload(data);
    const overlayRef = getOverlayRef();
    if (overlayRef && overlayRef.window && !overlayRef.window.isDestroyed()) {
      overlayRef.window.webContents.send('comet:state-changed', normalized);
    }
  });
  ipcMain.on(getBridgeChannel('comet.toggleOverlay', 'send'), (_event, data) => {
    const nextOverlayRef = handleCometOverlayToggle({
      data,
      mainWindowRef: getMainWindow(),
      currentOverlayRef: getOverlayRef(),
      isOverlayEnabled: () => isCometOverlayEnabled(),
      createOverlay: createCometOverlay,
      onOverlayDisposed: (disposedOverlay) => {
        if (getOverlayRef() === disposedOverlay) {
          setOverlayRef(null);
        }
      },
    });
    setOverlayRef(nextOverlayRef);
  });

  // Surface the terminal child-process services so the caller can dispose them
  // inside the awaited shutdown sequence (see the note by registerWorkspacePty-
  // IpcHandlers above — disposal moved off the old will-quit hook).
  return {
    workspaceIdeService,
    workspaceFileMapService,
    workspaceTerminalService,
    workspacePtyService,
    workspaceRunTaskService,
    workspaceTestRunnerService,
    versionedWorkspaceFileService,
    workspaceRootExternalTransitionBroker,
    workspaceRootCoordinator,
    workspaceRootRuntime,
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
