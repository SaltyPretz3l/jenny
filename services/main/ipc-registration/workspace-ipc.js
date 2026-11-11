// Builds the workspace service graph (IDE, git, pty, run tasks, watcher) and registers its IPC
// through the per-area registrars in ../workspace-ipc-registration.js.
const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const { WorkspaceIdeService } = require('../../workspace-ide-service');
const { WorkspaceImportService } = require('../../workspace-import-service');
const { VersionedWorkspaceFileService } = require('../../versioned-workspace-file-service');
const { createWorkspaceIdeWatcher } = require('../../workspace-ide-watcher');
const { WorkspaceGitService } = require('../../workspace-git-service');
const { WorkspaceFileMapService } = require('../../workspace-file-map-service');
const { WorkspacePtyService } = require('../../workspace-pty-service');
const { WorkspaceRunTaskService } = require('../../workspace-run-task-service');
const { createWorkspaceTestRunnerWiring } = require('../workspace-test-runner-wiring');
const { getWorkspaceRootStatePayload } = require('../../workspace-root-ipc');
const { prepareProjectTarget } = require('../../projects/workspace-project-switch');
const { createWorkspaceRootRuntime } = require('../../workspace-root-runtime');
const {
  WorkspaceRootExternalTransitionBroker,
} = require('../workspace-root-external-transition-broker');
const {
  registerWorkspaceFileMapIpcHandlers,
  registerWorkspaceFsIpcHandlers,
  registerWorkspaceGitIpcHandlers,
  registerWorkspacePtyIpcHandlers,
  registerWorkspaceTerminalShutdownTask,
  registerWorkspaceTestRunnerIpcHandlers,
  registerWorkspaceIpcHandlers,
  registerWorkspaceRootIpcHandlers,
} = require('../workspace-ipc-registration');

// Workspace domain IPC. registerWorkspaceStateIpcHandlers owns the workspace /
// IDE state channels and the background-jobs surface; registerWorkspaceServicesIpcHandlers
// composes the Workspace IDE owners (IDE, import, watcher, git, file map, test
// runner, PTY, run tasks, root runtime, versioned files) in their dependency
// order and registers each one's channels as it is built.

function registerWorkspaceStateIpcHandlers(ipcMain, {
  app,
  backendService,
  shellConfigService,
  workspaceAuthorization,
}) {
  registerWorkspaceIpcHandlers(ipcMain, shellConfigService, {
    authorization: workspaceAuthorization, userDataPath: app.getPath('userData'), // row 82 E3 hot exit backups
    getRootContext: () => backendService.workspaceRootCoordinator?.captureContext?.() || null, isWorkspaceBackupEnabled: () => backendService.featureFlags?.ide_hot_exit !== false,
  });
  // W2-2 background jobs: snapshot, kill (an OS pid-tree kill) and the finished-job output tail
  // (reads workspace files), all behind the trusted-sender authorizer like the workspace-mutating surface.
  registerIpcInvokeHandlers(ipcMain, {
    'backgroundJobs.getState': () =>
      backendService.backgroundJobTracker?.getState?.() || { jobs: [], generatedAt: '' },
    'backgroundJobs.kill': (_, jobId) => backendService.backgroundJobTracker?.killJob?.(jobId)
      || { ok: false, reason: 'unavailable' },
    'backgroundJobs.readOutput': (_, jobId) => backendService.backgroundJobTracker?.readOutput?.(jobId)
      || { ok: false, reason: 'unavailable' },
  }, workspaceAuthorization);
}

// Returns every owner registerMainIpcHandlers hands back, plus workspaceGitService
// for the auxiliary registrations. modelTuningService / engineTuningService are
// passed in only so their shutdown tasks keep their place in the lifecycle order.
function registerWorkspaceServicesIpcHandlers(ipcMain, {
  app,
  backendService,
  shellConfigService,
  dialog,
  getMainWindow,
  log,
  getMainLifecycle,
  toolExecutor,
  trashItemImpl,
  showItemInFolderImpl,
  openPathImpl,
  sendBridgeEvent,
  workspaceSnapshotStore,
  getDisplayMediaSourceHandler,
  versionedTempRecoveryStarter,
  modelTuningService,
  engineTuningService,
  workspaceAuthorization,
}) {
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
    emitChange: (payload) => { sendBridgeEvent('workspaceFs.onChange', payload); backendService.chatWorkspace?.handleWorkspaceChange(payload); },
    // External git ops (commit/checkout/branch-switch) touch only `.git`, which
    // the file watcher ignores; this dedicated signal refreshes the renderer git
    // store so the tree/statusbar/gutter decorations don't go stale.
    emitGitMeta: (payload) => { sendBridgeEvent('workspaceFs.onGitMetaChange', payload); backendService.chatWorkspace?.handleWorkspaceChange(payload); },
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
  // workspaceFileMap.* namespace: interactive dependency-graph "Map" tab (registration here is
  // unconditional, matching the house pattern). Reuses the already-constructed
  // workspaceIdeService/workspaceGitService so file enumeration/reads and co-change history
  // share the same root-scoped, fail-soft primitives as the rest of the Workspace IDE surface.
  const workspaceFileMapService = new WorkspaceFileMapService({
    ideService: workspaceIdeService,
    gitService: workspaceGitService,
    versionedFileServiceProvider: () => versionedWorkspaceFileService,
    logger: log,
    componentsEnabled: () => backendService.featureFlags?.file_map_components !== false,
  });
  registerWorkspaceFileMapIpcHandlers(ipcMain, workspaceFileMapService, workspaceAuthorization);
  // workspaceTestRunner.* namespace, gated by the default-on workspace_test_runner
  // flag read live off the backend service's resolved feature flags. Per-workspace
  // -root config + history live in userData and follow the active root.
  const activityWiring = require('../activity-monitor-wiring');
  const workspaceTestRunnerService = createWorkspaceTestRunnerWiring({
    activityScopeProvider: () => activityWiring.captureWorkspaceActivityScope(backendService, shellConfigService),
    app,
    shellConfigService,
    resourceAdmissionProvider: () => ({
      broker: backendService.sessionRuntime?.resourceBroker,
      pathResolver: backendService.sessionRuntime?.pathResolver,
    }),
    sidecarLaunchSpecProvider: () => {
      const manager = backendService.sidecarManager;
      const packaged = manager?.packagedSidecarLaunch;
      const packagedLaunchPending = !packaged && typeof manager?._resolvePackagedLaunch === 'function';
      if (!manager || packagedLaunchPending || (packaged && packaged.ok !== true)) return null;
      return {
        hostMode: backendService.hostMode,
        launchCommand: packaged?.ok === true ? packaged.launchCommand : manager?.launchCommand,
        launchArgs: packaged?.ok === true ? packaged.launchArgs : manager?.launchArgs || ['-m', 'sidecar'],
        cwd: manager.repoRoot,
      };
    },
    featureFlagProvider: () => backendService.featureFlags,
    // S13: live run-state push to the Home widget (workspaceTestRunner.onStateChanged).
    sendBridgeEvent,
    log,
  });
  registerWorkspaceTestRunnerIpcHandlers(ipcMain, workspaceTestRunnerService, workspaceAuthorization);
  backendService.workspaceTestRunnerService = workspaceTestRunnerService;
  const activityMonitor = activityWiring.registerActivityMonitor({ipcMain, backendService, shellConfigService,
    source:workspaceTestRunnerService, authorization:workspaceAuthorization, sendBridgeEvent});
  // The model-facing `verify` tool runs the user's own saved Test Runner
  // configurations through this same service. It is created here, after
  // runtime-service-composition built the tool executor, so it is attached
  // rather than constructor-injected.
  if (toolExecutor && typeof toolExecutor.attachWorkspaceTestRunnerService === 'function') {
    toolExecutor.attachWorkspaceTestRunnerService(workspaceTestRunnerService);
  }
  // workspacePty.* namespace: the Workspace IDE terminal (real ConPTY). The
  // piped line terminal and its workspace_pty_terminal flag were retired in
  // the post-1.2.0 sweep (S8).
  const workspacePtyService = new WorkspacePtyService({
    configService: shellConfigService,
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
    mainLifecycle.registerShutdownTask(() => activityMonitor.dispose());
    mainLifecycle.registerShutdownTask(() => modelTuningService.dispose());
    mainLifecycle.registerShutdownTask(() => engineTuningService.dispose());
    mainLifecycle.registerShutdownTask(() => workspaceRootExternalTransitionBroker.dispose());
  } else if (typeof app?.once === 'function') {
    app.once('will-quit', () => {
      activityMonitor.dispose(); modelTuningService.dispose();
      engineTuningService.dispose();
      void workspaceRootExternalTransitionBroker.dispose();
    });
  }
  versionedWorkspaceFileService = new VersionedWorkspaceFileService({
    rootContext: workspaceRootCoordinator,
    resourceAdmissionProvider: () => ({ broker: backendService.sessionRuntime?.resourceBroker,
      pathResolver: backendService.sessionRuntime?.pathResolver }),
    writeObserver: workspaceIdeWatcher.writeObserver,
    logger: log,
  });
  void versionedTempRecoveryStarter({ rootContext: workspaceRootCoordinator, logger: log });
  backendService.versionedWorkspaceFileService = versionedWorkspaceFileService;
  registerWorkspaceFsIpcHandlers(ipcMain, workspaceIdeService, {
    watcher: workspaceIdeWatcher, logger: log,
    versionedFileService: versionedWorkspaceFileService,
    importService: workspaceImportService, projectService: { get: (id) => backendService.projectService?.get?.(id) || null },
    authorization: workspaceAuthorization,
  });
  registerWorkspaceRootIpcHandlers(ipcMain, {
    getState: () => getWorkspaceRootStatePayload(shellConfigService, workspaceRootCoordinator),
    captureContext: () => workspaceRootCoordinator.captureContext(),
    prepareChoose: () => workspaceRootCoordinator.prepareChoose(),
    prepareClear: () => workspaceRootCoordinator.prepareClear(),
    // Switch project: a project id from the renderer, the path from the store.
    prepareProject: (payload) => prepareProjectTarget({
      projectService: backendService.projectService, coordinator: workspaceRootCoordinator, payload,
    }),
    commit: (payload) => workspaceRootCoordinator.commit(payload),
    cancel: (payload) => workspaceRootCoordinator.cancel(payload),
    respondExternalTransition: (payload) => workspaceRootExternalTransitionBroker.respond(payload),
    authorization: workspaceAuthorization,
  });
  // The IDE's workspace_present outcome (services/workspace-presentation-service.js).
  registerIpcInvokeHandlers(ipcMain, {
    'workspacePresentation.reportOutcome': (_event, payload) => backendService.workspacePresentationService
      ?.recordOutcome?.(payload) ?? { ok: false, reason: 'unavailable' },
  }, workspaceAuthorization);
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
  }, workspaceAuthorization);
  // Belt-and-braces orphan guard: graceful quit now runs through the main
  // lifecycle's awaited shutdown task list, so the async PTY termination can
  // finish before app.exit(). The app.once fallback keeps standalone
  // test/composition callers covered when no lifecycle is present. The
  // service is ALSO returned below so main.js can thread it into
  // stopRuntimeBeforeQuit → disposeWorkspaceProcesses (runtime-shutdown.js);
  // the two paths coexist safely — dispose() is idempotent, so whichever
  // runs second is a no-op.
  registerWorkspaceTerminalShutdownTask({
    getMainLifecycle,
    app,
    workspacePtyService,
    log,
  });
  return {
    workspaceIdeService,
    workspaceGitService,
    workspaceFileMapService,
    workspacePtyService,
    workspaceRunTaskService,
    workspaceTestRunnerService,
    versionedWorkspaceFileService,
    workspaceRootExternalTransitionBroker,
    workspaceRootCoordinator,
    workspaceRootRuntime,
  };
}

module.exports = {
  registerWorkspaceServicesIpcHandlers,
  registerWorkspaceStateIpcHandlers,
};
