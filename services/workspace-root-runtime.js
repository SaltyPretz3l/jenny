'use strict';

const { t } = require('./i18n-main');

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

// The renderer-facing shape of ensureWorkspaceProject's answer. Hosted
// profiles never provision implicitly (`host_mode_server`), which is not a
// failure worth telling anyone about, so it yields no outcome at all.
function provisionedOutcome(provisioned) {
  if (provisioned?.ok === true && typeof provisioned.project?.id === 'string') {
    return { ok: true, project_id: provisioned.project.id };
  }
  const reason = typeof provisioned?.reason === 'string' && provisioned.reason
    ? provisioned.reason.slice(0, 80)
    : 'provisioning_failed';
  return reason === 'host_mode_server' ? null : { ok: false, reason };
}

function participant({ id, reason, isActive, terminate }) {
  return {
    id,
    getBlocker: async () => (await isActive()) ? { reason } : null,
    terminate,
  };
}

function registerRuntimeParticipants(coordinator, {
  ptyService = null,
  testRunnerService = null,
  runTaskService = null,
} = {}) {
  const unregister = [];
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
      isActive: () => typeof testRunnerService.hasWorkspaceRun === 'function'
        ? testRunnerService.hasWorkspaceRun() : Boolean(testRunnerService.getState?.()?.activeRun),
      terminate: async () => {
        if (typeof testRunnerService.hasWorkspaceRun === 'function' && !testRunnerService.hasWorkspaceRun()) {
          return { aborted: false };
        }
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
  let pendingRefresh = Promise.resolve();
  let lastProvisioning = null;
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
        title: t('main.dialog.workspaceRoot.choose', 'Choose Workspace Root'),
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
        // A commit re-targets the managed sidecar in the background: the
        // re-initialize takes seconds (measured 4.7 s on 2026-09-20) and the
        // root is already persisted, so the switch must not wait for it. The
        // sidecar already skips this refresh while streams are active, so it
        // tolerates lagging the root. Refreshes are chained so two quick
        // switches never re-initialize concurrently; rollback stays awaited.
        const refresh = () => backendService.refreshManagedConfig(`workspace_root_${context.reason}`);
        if (context.reason === 'commit') {
          pendingRefresh = pendingRefresh.then(refresh, refresh).catch(() => null);
        } else {
          await pendingRefresh.catch(() => null);
          await refresh();
        }
      }
      // The chosen folder is the project: provision (or find) the project bound
      // to it so new chats land there. A provisioning failure never rolls the
      // root transition back; its outcome rides on the commit result (below)
      // so the renderer can say the project could not be created, and why.
      if (context.reason === 'commit' && context.rootPath
        && typeof backendService?.ensureWorkspaceProject === 'function') {
        let outcome;
        try {
          const provisioned = await backendService.ensureWorkspaceProject(
            context.rootPath, 'workspace_root_commit'
          );
          outcome = provisionedOutcome(provisioned);
        } catch (_error) {
          // The root is already persisted; chats fall back to General until a retry.
          outcome = { ok: false, reason: 'provisioning_failed' };
        }
        lastProvisioning = { transitionId: context.transitionId, outcome };
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
  // The coordinator builds the commit result after refreshManagedRoot (where
  // provisioning runs) has finished, so the outcome recorded for this
  // transition is attached as `project_provisioning` on a committed result.
  // Every caller of workspaceRoot.commit goes through this instance method.
  const commitTransition = coordinator.commit.bind(coordinator);
  coordinator.commit = (payload) => commitTransition(payload).then((result) => {
    const recorded = lastProvisioning;
    if (!result?.committed || !recorded || !recorded.outcome
      || recorded.transitionId !== String(payload?.transitionId || '')) {
      return result;
    }
    return { ...result, project_provisioning: { ...recorded.outcome } };
  });
  const unregisterParticipants = registerRuntimeParticipants(coordinator, {
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
