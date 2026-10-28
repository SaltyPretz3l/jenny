const { registerIpcInvokeHandlers } = require('../ipc-contract');
const {
  isWorkspaceIdeRecord,
  normalizeWorkspaceIdeRootState,
  workspaceIdePreferencePatch,
  workspaceIdeRootPatch,
} = require('../workspace-ide-config-schema');
const {
  registerWorkspaceRootIpcHandlers: registerWorkspaceRootIpcHandlersWithDeps,
} = require('../workspace-root-ipc');
const { createWorkspaceBackupService } = require('../workspace-backup-service');
const { WORKSPACE_BACKUP_ERROR_CODES } = require('../backend/error-codes');
const { invokeVersionedWorkspaceFile } = require('./workspace-file-ipc-result');

function registerWorkspaceIpcHandlers(
  ipcMainLike,
  configService,
  {
    authorization = {},
    getRootContext = () => null,
    userDataPath = '',
    isWorkspaceBackupEnabled = () => true,
    workspaceBackupService = userDataPath ? createWorkspaceBackupService({ userDataPath }) : null,
  } = {}
) {
  const context = () => getRootContext() || {
    rootPath: '', rootId: null, generation: 0, phase: 'ready',
  };
  const statePayload = ({ touch = false } = {}) => {
    const rootContext = context();
    if (rootContext.phase !== 'ready') {
      return {
        ok: false,
        code: rootContext.phase === 'error' ? 'root_recovery_required' : 'root_transitioning',
        context: rootContext,
      };
    }
    const touchedState = touch && rootContext.rootId
      ? configService.touchWorkspaceIdeRoot(rootContext.rootId)
      : configService.getWorkspaceIdeState(rootContext.rootId || '');
    const { evictedRootCount: rawEvictedRootCount, ...state } = touchedState;
    const evictedRootCount = Number.isSafeInteger(rawEvictedRootCount) && rawEvictedRootCount > 0
      ? rawEvictedRootCount
      : 0;
    return {
      ok: true,
      context: rootContext,
      preferences: configService.getWorkspaceIdeStore().preferences,
      rootState: normalizeWorkspaceIdeRootState(state),
      ...(evictedRootCount > 0 ? { evictedRootCount } : {}),
      ...state,
    };
  };
  // Row 82 E3 hot exit backups: the root comes from main's root context (never the
  // renderer); flag-off answers before the service is touched, so nothing hits disk.
  // A write/remove also gets main's generation: the service refuses a payload whose
  // captured expectedRootId/expectedGeneration no longer match (a root switch).
  const backupCall = (method, payload, { needsPayload = true } = {}) => {
    if (!isWorkspaceBackupEnabled()) return { ok: false, code: WORKSPACE_BACKUP_ERROR_CODES.DISABLED };
    const rootContext = context();
    if (rootContext.phase !== 'ready' || !rootContext.rootId) return { ok: false, code: 'root_transitioning' };
    if (needsPayload && !isWorkspaceIdeRecord(payload)) {
      return { ok: false, code: WORKSPACE_BACKUP_ERROR_CODES.INVALID_PAYLOAD };
    }
    if (method === 'write' || method === 'remove') {
      return workspaceBackupService[method](rootContext.rootId, payload, rootContext.generation);
    }
    return needsPayload
      ? workspaceBackupService[method](rootContext.rootId, payload)
      : workspaceBackupService[method](rootContext.rootId);
  };
  registerIpcInvokeHandlers(ipcMainLike, {
    'reminders.snooze': (_, id, minutes = 10) => (
      configService.reminderNotifier?.snooze(id, minutes)
      || { id: String(id || ''), minutes, untilMs: null }
    ),
    'workspace.getState': () => configService.getWorkspaceState(),
    'workspace.updateState': (_, patch) => configService.updateWorkspaceState(patch),
    'workspaceIde.getState': () => statePayload({ touch: true }),
    'workspaceIde.updateSettings': (_, patch) => {
      const safePatch = workspaceIdePreferencePatch(patch);
      const outcome = typeof configService.tryUpdateWorkspaceIdePreferences === 'function'
        ? configService.tryUpdateWorkspaceIdePreferences(safePatch)
        : {
            updated: true,
            changed: true,
            state: configService.updateWorkspaceIdePreferences(safePatch),
          };
      return {
        updated: outcome.updated === true,
        changed: outcome.changed === true,
        code: outcome.code || '',
        ...(outcome.state || {}),
      };
    },
    'workspaceIde.updateState': (_, payload = {}) => {
      const rootContext = context();
      if (rootContext.phase !== 'ready') {
        return {
          updated: false,
          code: rootContext.phase === 'error' ? 'root_recovery_required' : 'root_transitioning',
          context: rootContext,
        };
      }
      const hasExpectedRoot = isWorkspaceIdeRecord(payload)
        && Object.prototype.hasOwnProperty.call(payload, 'expectedRootId');
      const expectedRootId = hasExpectedRoot && payload.expectedRootId === null
        ? null
        : hasExpectedRoot && typeof payload.expectedRootId === 'string'
          ? payload.expectedRootId
          : undefined;
      if (
        !isWorkspaceIdeRecord(payload)
        || !hasExpectedRoot
        || expectedRootId === undefined
        || !Number.isSafeInteger(payload.expectedGeneration)
        || payload.expectedGeneration < 0
        || (payload.preferences !== undefined && !isWorkspaceIdeRecord(payload.preferences))
        || (payload.rootState !== undefined && !isWorkspaceIdeRecord(payload.rootState))
      ) {
        return { updated: false, code: 'invalid_payload', context: rootContext };
      }
      if (
        expectedRootId !== rootContext.rootId
        || payload.expectedGeneration !== rootContext.generation
      ) {
        return { updated: false, code: 'stale_root_context', context: rootContext };
      }
      const patch = {
        ...workspaceIdePreferencePatch(payload.preferences),
        ...workspaceIdeRootPatch(payload.rootState),
      };
      const outcome = typeof configService.tryUpdateWorkspaceIdeState === 'function'
        ? configService.tryUpdateWorkspaceIdeState(rootContext.rootId || '', patch)
        : {
            updated: true,
            changed: true,
            state: configService.updateWorkspaceIdeState(rootContext.rootId || '', patch),
          };
      if (!outcome.updated) {
        return {
          updated: false,
          changed: false,
          code: outcome.code || 'config_write_blocked',
          context: rootContext,
        };
      }
      return { updated: true, context: rootContext, ...statePayload() };
    },
    ...(workspaceBackupService ? {
      'workspaceBackup.write': (_, payload) => backupCall('write', payload),
      'workspaceBackup.remove': (_, payload) => backupCall('remove', payload),
      'workspaceBackup.list': () => backupCall('list', undefined, { needsPayload: false }),
      'workspaceBackup.read': (_, payload) => backupCall('read', payload),
    } : {}),
  }, authorization);
}

function registerWorkspaceFsIpcHandlers(
  ipcMainLike,
  workspaceIdeService,
  { watcher = null, versionedFileService = null, importService = null, authorization = {} } = {}
) {
  const handlers = {
    'workspaceFs.getRootState': () => workspaceIdeService.getRootState(),
    'workspaceFs.readFile': (_, payload) => workspaceIdeService.readFile(payload),
    'workspaceFs.stat': (_, payload) => workspaceIdeService.stat(payload),
    'workspaceFs.writeFile': (_, payload) => workspaceIdeService.writeFile(payload),
    'workspaceFs.readText': (_, payload) => (
      invokeVersionedWorkspaceFile(versionedFileService, 'readText', payload)
    ),
    'workspaceFs.readImage': (_, payload) => (
      invokeVersionedWorkspaceFile(versionedFileService, 'readImage', payload)
    ),
    'workspaceFs.readDocument': (_, payload) => (
      invokeVersionedWorkspaceFile(versionedFileService, 'readDocument', payload)
    ),
    'workspaceFs.writeText': (_, payload) => (
      invokeVersionedWorkspaceFile(versionedFileService, 'writeText', payload)
    ),
    'workspaceFs.writeDocument': (_, payload) => (
      invokeVersionedWorkspaceFile(versionedFileService, 'writeDocument', payload)
    ),
    'workspaceFs.listDirectory': (_, payload) => workspaceIdeService.listDirectory(payload),
    'workspaceFs.listAllFiles': (_, payload) => workspaceIdeService.listAllFiles(payload),
    'workspaceFs.createFile': (_, payload) => workspaceIdeService.createFile(payload),
    'workspaceFs.createDirectory': (_, payload) => workspaceIdeService.createDirectory(payload),
    'workspaceFs.rename': (_, payload) => workspaceIdeService.rename(payload),
    ...(importService ? {
      'workspaceFs.copyEntry': (_, payload) => importService.copyEntry(payload),
      'workspaceFs.previewImport': (_, payload) => importService.previewImport(payload),
      'workspaceFs.importExternal': (_, payload) => importService.importExternal(payload),
      'workspaceFs.cancelImport': (_, payload) => importService.cancelImport(payload),
    } : {}),
    'workspaceFs.delete': (_, payload) => workspaceIdeService.delete(payload),
    'workspaceFs.searchInFiles': (_, payload) => workspaceIdeService.searchInFiles(payload),
    'workspaceFs.revealInFolder': (_, payload) => workspaceIdeService.revealInFolder(payload),
    'workspaceFs.openInDefaultApp': (_, payload) => workspaceIdeService.openInDefaultApp(payload),
    'workspaceFs.readPreChange': (_, payload) => workspaceIdeService.readPreChange(payload),
    'workspaceFs.watchStart': () => (watcher ? watcher.start() : { watching: false }),
    'workspaceFs.watchStop': () => (watcher ? watcher.stop() : { watching: false }),
  };
  registerIpcInvokeHandlers(ipcMainLike, handlers, authorization);
}

function registerWorkspaceRootIpcHandlers(ipcMainLike, {
  getState,
  captureContext,
  prepareChoose,
  prepareClear,
  prepareProject,
  commit,
  cancel,
  respondExternalTransition,
  authorization = {},
} = {}) {
  registerWorkspaceRootIpcHandlersWithDeps(ipcMainLike, {
    getState,
    captureContext,
    prepareChoose,
    prepareClear,
    ...(prepareProject ? { prepareProject } : {}),
    commit,
    cancel,
    respondExternalTransition,
    authorization,
  });
}

function registerWorkspaceGitIpcHandlers(ipcMainLike, workspaceGitService, authorization = {}) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'workspaceGit.getStatus': (_, payload) => workspaceGitService.getStatus(payload),
    'workspaceGit.getDiff': (_, payload) => workspaceGitService.getDiff(payload),
    'workspaceGit.getCommitDiff': (_, payload) => workspaceGitService.getCommitDiff(payload),
    'workspaceGit.getFileAtHead': (_, payload) => workspaceGitService.getFileAtHead(payload),
    'workspaceGit.getLog': (_, payload) => workspaceGitService.getLog(payload),
    'workspaceGit.getBranches': (_, payload) => workspaceGitService.getBranches(payload),
    'workspaceGit.blameRange': (_, payload) => workspaceGitService.blameRange(payload),
    'workspaceGit.checkIgnored': (_, payload) => workspaceGitService.checkIgnored(payload),
    'workspaceGit.stage': (_, payload) => workspaceGitService.stage(payload),
    'workspaceGit.unstage': (_, payload) => workspaceGitService.unstage(payload),
    'workspaceGit.commit': (_, payload) => workspaceGitService.commit(payload),
    'workspaceGit.discardFile': (_, payload) => workspaceGitService.discardFile(payload),
    'workspaceGit.checkout': (_, payload) => workspaceGitService.checkout(payload),
    'workspaceGit.stash': (_, payload) => workspaceGitService.stash(payload),
    'workspaceGit.undoLastCommit': (_, payload) => workspaceGitService.undoLastCommit(payload),
    'workspaceGit.resolveDelete': (_, payload) => workspaceGitService.resolveDelete(payload),
    // Row 82 P4 (G1/G2).
    'workspaceGit.getFileAtIndex': (_, payload) => workspaceGitService.getFileAtIndex(payload),
    'workspaceGit.getFileAtCommit': (_, payload) => workspaceGitService.getFileAtCommit(payload),
    'workspaceGit.getCommitFiles': (_, payload) => workspaceGitService.getCommitFiles(payload),
    'workspaceGit.listStashes': (_, payload) => workspaceGitService.listStashes(payload),
    'workspaceGit.getLastCommitMessage': (_, payload) => workspaceGitService.getLastCommitMessage(payload),
    'workspaceGit.deleteBranch': (_, payload) => workspaceGitService.deleteBranch(payload),
    'workspaceGit.applyPatch': (_, payload) => workspaceGitService.applyPatch(payload),
    // Row 82 cleanup G2/G3.
    'workspaceGit.blameFile': (_, payload) => workspaceGitService.blameFile(payload),
    'workspaceGit.discardFiles': (_, payload) => workspaceGitService.discardFiles(payload),
  }, authorization);
}

function registerWorkspacePtyIpcHandlers(ipcMainLike, workspacePtyService, authorization = {}) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'workspacePty.spawn': (_, payload) => workspacePtyService.spawn(payload),
    // Ids and labels only; executable paths and arguments never leave main.
    'workspacePty.listProfiles': () => workspacePtyService.listProfiles(),
    'workspacePty.write': (_, payload) => workspacePtyService.write(payload),
    'workspacePty.resize': (_, payload) => workspacePtyService.resize(payload),
    // A renderer kill names one session. kill() without an id terminates EVERY
    // session (the root switch and shutdown call it in main), so an empty id from
    // the renderer (a terminal that never started) must not reach it.
    'workspacePty.kill': (_, payload) => (String(payload?.sessionId || '')
      ? workspacePtyService.kill({ sessionId: String(payload.sessionId) })
      : { ok: true, killed: false }),
  }, authorization);
}

function registerWorkspaceFileMapIpcHandlers(ipcMainLike, workspaceFileMapService, authorization = {}) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'workspaceFileMap.getGraph': (_, payload) => workspaceFileMapService.getGraph(payload?.workspaceId),
    'workspaceFileMap.refresh': (_, payload) => workspaceFileMapService.refresh(payload?.workspaceId),
  }, authorization);
}

function registerWorkspaceTestRunnerIpcHandlers(ipcMainLike, testRunnerService, authorization = {}) {
  return registerIpcInvokeHandlers(ipcMainLike, {
    'workspaceTestRunner.run': (_event, payload) => testRunnerService.run(payload),
    'workspaceTestRunner.abort': () => testRunnerService.abort(),
    'workspaceTestRunner.saveConfigs': (_event, configs) => testRunnerService.saveConfigs(configs),
    'workspaceTestRunner.getState': () => testRunnerService.getState(),
  }, authorization);
}

function registerWorkspaceTerminalShutdownTask({
  getMainLifecycle = null,
  app = null,
  workspacePtyService,
  log = null,
} = {}) {
  const logEvent = typeof log === 'function' ? log : () => {};
  const disposeAll = async () => {
    if (!workspacePtyService || typeof workspacePtyService.dispose !== 'function') {
      return;
    }
    try {
      await workspacePtyService.dispose();
    } catch (error) {
      logEvent('WARN', 'workspace_pty.shutdown_dispose_failed', {
        message: String(error?.message || error || ''),
      });
    }
  };

  const lifecycle = typeof getMainLifecycle === 'function' ? getMainLifecycle() : null;
  if (lifecycle && typeof lifecycle.registerShutdownTask === 'function') {
    lifecycle.registerShutdownTask(disposeAll);
    return 'lifecycle';
  }
  if (app && typeof app.once === 'function') {
    app.once('will-quit', () => disposeAll());
    return 'will-quit';
  }
  return 'none';
}

module.exports = {
  registerWorkspaceFileMapIpcHandlers,
  registerWorkspaceFsIpcHandlers,
  registerWorkspaceGitIpcHandlers,
  registerWorkspacePtyIpcHandlers,
  registerWorkspaceTerminalShutdownTask,
  registerWorkspaceTestRunnerIpcHandlers,
  registerWorkspaceIpcHandlers,
  registerWorkspaceRootIpcHandlers,
};
