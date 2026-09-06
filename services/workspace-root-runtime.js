'use strict';

const {
  WorkspaceRootCoordinator,
  defaultNormalizeRootPath,
} = require('./workspace-root-coordinator');
const {
  TRANSACTION_APPLY_REASON,
  TRANSACTION_ROLLBACK_REASON,
} = require('./workspace-root-change-reasons');

function workspaceRootRuntimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function currentConfiguredRoot(configService) {
  return String(configService?.getToolsWorkspaceRoot?.() || '').trim();
}

function persistConfiguredRoot(configService, context, reason) {
  if (!configService) {
    throw workspaceRootRuntimeError(
      'workspace_root_config_unavailable',
      'Workspace root persistence is unavailable.'
    );
  }
  const normalizedExpected = context.rootPath ? defaultNormalizeRootPath(context.rootPath) : '';
  const current = currentConfiguredRoot(configService);
  const normalizedCurrent = current ? defaultNormalizeRootPath(current) : '';
  if (normalizedCurrent === normalizedExpected) return;
  if (context.rootPath) {
    configService.setToolsWorkspaceRoot(context.rootPath, { reason });
  } else {
    configService.clearToolsWorkspaceRoot({ reason });
  }
  const persisted = currentConfiguredRoot(configService);
  const normalizedPersisted = persisted ? defaultNormalizeRootPath(persisted) : '';
  if (normalizedPersisted !== normalizedExpected) {
    throw workspaceRootRuntimeError(
      'workspace_root_persistence_refused',
      'Workspace root persistence refused the transition.'
    );
  }
}

function participant({ id, reason, isActive, terminate }) {
  return {
    id,
    getBlocker: async () => (await isActive()) ? { reason } : null,
    terminate,
  };
}

function registerRuntimeParticipants(coordinator, {
  terminalService = null,
  ptyService = null,
  testRunnerService = null,
  runTaskService = null,
} = {}) {
  const unregister = [];
  if (terminalService) {
    unregister.push(coordinator.registerParticipant(participant({
      id: 'workspace_terminal',
      reason: 'terminal_active',
      isActive: () => terminalService.hasSession?.() === true,
      terminate: async () => terminalService.kill?.({}),
    })));
  }
  if (ptyService) {
    unregister.push(coordinator.registerParticipant(participant({
      id: 'workspace_pty',
      reason: 'pty_active',
      isActive: () => (
        ptyService.isRunning?.() === true || ptyService.hasSession?.() === true
      ),
      terminate: async () => ptyService.kill?.({}),
    })));
  }
  if (testRunnerService) {
    unregister.push(coordinator.registerParticipant(participant({
      id: 'workspace_test_runner',
      reason: 'test_run_active',
      isActive: () => Boolean(testRunnerService.getState?.()?.activeRun),
      terminate: async () => {
        if (typeof testRunnerService.abortAndWait === 'function') {
          return testRunnerService.abortAndWait();
        }
        return testRunnerService.abort?.();
      },
    })));
  }
  if (runTaskService) {
    // UIUX-014: a run task is pinned to the root it was spawned under (no
    // cross-root output/exit reattribution), so a root switch mid-run must
    // kill it rather than orphan it against a now-unreachable cwd.
    unregister.push(coordinator.registerParticipant(participant({
      id: 'workspace_run_task',
      reason: 'run_task_active',
      isActive: () => runTaskService.hasActiveTask?.() === true,
      terminate: async () => runTaskService.kill?.({}),
    })));
  }
  return () => {
    for (const remove of unregister.reverse()) remove();
  };
}

function createWorkspaceRootRuntime({
  configService,
  dialog,
  getOwnerWindow = () => null,
  backendService = null,
  watcher = null,
  terminalService = null,
  ptyService = null,
  testRunnerService = null,
  runTaskService = null,
  logger = null,
  coordinatorOptions = {},
} = {}) {
  if (!configService) {
    throw new TypeError('createWorkspaceRootRuntime requires configService');
  }
  let watcherShouldRun = false;
  const coordinator = new WorkspaceRootCoordinator({
    ...coordinatorOptions,
    initialRootPath: currentConfiguredRoot(configService),
    chooseTarget: async () => {
      if (!dialog || typeof dialog.showOpenDialog !== 'function') {
        throw workspaceRootRuntimeError(
          'workspace_root_dialog_unavailable',
          'Workspace root selection is unavailable.'
        );
      }
      const result = await dialog.showOpenDialog(getOwnerWindow(), {
        title: 'Choose Workspace Root',
        properties: ['openDirectory'],
      });
      const selectedPath = Array.isArray(result?.filePaths) ? result.filePaths[0] : '';
      return {
        canceled: result?.canceled === true || !selectedPath,
        path: selectedPath || '',
      };
    },
    applyRootPath: async (context) => {
      persistConfiguredRoot(configService, context, TRANSACTION_APPLY_REASON);
    },
    restoreRootPath: async (context) => {
      persistConfiguredRoot(configService, context, TRANSACTION_ROLLBACK_REASON);
    },
    refreshManagedRoot: async (context) => {
      if (typeof backendService?.refreshManagedConfig === 'function') {
        await backendService.refreshManagedConfig(`workspace_root_${context.reason}`);
      }
    },
    stopRootServices: async (context) => {
      const running = watcher?.isRunning?.() === true;
      if (context.reason === 'commit') {
        watcherShouldRun = running;
      } else if (running) {
        watcherShouldRun = true;
      }
      if (running) await watcher.stop();
    },
    startRootServices: async (context) => {
      if (!watcherShouldRun) return;
      if (!context.rootPath) {
        watcherShouldRun = false;
        return;
      }
      await watcher.start(context);
      watcherShouldRun = false;
    },
    logger: typeof logger === 'function'
      ? (level, event, details) => logger(String(level).toUpperCase(), event, details)
      : null,
  });
  const unregisterParticipants = registerRuntimeParticipants(coordinator, {
    terminalService,
    ptyService,
    testRunnerService,
    runTaskService,
  });
  return {
    coordinator,
    dispose: unregisterParticipants,
  };
}

module.exports = {
  TRANSACTION_APPLY_REASON,
  TRANSACTION_ROLLBACK_REASON,
  createWorkspaceRootRuntime,
};
