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
const { invokeVersionedWorkspaceFile } = require('./workspace-file-ipc-result');

function registerWorkspaceIpcHandlers(
  ipcMainLike,
  configService,
  { authorization = {}, getRootContext = () => null } = {}
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
  registerIpcInvokeHandlers(ipcMainLike, {
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
    'workspaceFs.readFileBase64': (_, payload) => workspaceIdeService.readFileBase64(payload),
    'workspaceFs.stat': (_, payload) => workspaceIdeService.stat(payload),
    'workspaceFs.writeFile': (_, payload) => workspaceIdeService.writeFile(payload),
    'workspaceFs.readText': (_, payload) => (
      invokeVersionedWorkspaceFile(versionedFileService, 'readText', payload)
    ),
    'workspaceFs.readImage': (_, payload) => (
      invokeVersionedWorkspaceFile(versionedFileService, 'readImage', payload)
    ),
    'workspaceFs.writeText': (_, payload) => (
      invokeVersionedWorkspaceFile(versionedFileService, 'writeText', payload)
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
    'workspaceGit.stage': (_, payload) => workspaceGitService.stage(payload),
    'workspaceGit.unstage': (_, payload) => workspaceGitService.unstage(payload),
    'workspaceGit.commit': (_, payload) => workspaceGitService.commit(payload),
    'workspaceGit.discardFile': (_, payload) => workspaceGitService.discardFile(payload),
    'workspaceGit.checkout': (_, payload) => workspaceGitService.checkout(payload),
    'workspaceGit.stash': (_, payload) => workspaceGitService.stash(payload),
    'workspaceGit.undoLastCommit': (_, payload) => workspaceGitService.undoLastCommit(payload),
  }, authorization);
}

function registerWorkspacePtyIpcHandlers(ipcMainLike, workspacePtyService, authorization = {}) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'workspacePty.spawn': (_, payload) => workspacePtyService.spawn(payload),
    'workspacePty.write': (_, payload) => workspacePtyService.write(payload),
    'workspacePty.resize': (_, payload) => workspacePtyService.resize(payload),
    'workspacePty.kill': (_, payload) => workspacePtyService.kill(payload),
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
    'workspaceTestRunner.listConfigs': () => testRunnerService.listConfigs(),
    'workspaceTestRunner.run': (_event, payload) => testRunnerService.run(payload),
    'workspaceTestRunner.abort': () => testRunnerService.abort(),
    'workspaceTestRunner.saveConfigs': (_event, configs) => testRunnerService.saveConfigs(configs),
    'workspaceTestRunner.getState': () => testRunnerService.getState(),
  }, authorization);
}

function registerWorkspaceTerminalShutdownTask({
  getMainLifecycle = null,
  app = null,
  workspaceTerminalService,
  workspacePtyService,
  log = null,
} = {}) {
  const logEvent = typeof log === 'function' ? log : () => {};
  const disposeOne = async (service, eventName) => {
    if (!service || typeof service.dispose !== 'function') {
      return;
    }
    try {
      await service.dispose();
    } catch (error) {
      logEvent('WARN', eventName, {
        message: String(error?.message || error || ''),
      });
    }
  };
  const disposeAll = () => Promise.all([
    disposeOne(workspaceTerminalService, 'workspace_terminal.shutdown_dispose_failed'),
    disposeOne(workspacePtyService, 'workspace_pty.shutdown_dispose_failed'),
  ]).then(() => undefined);

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
