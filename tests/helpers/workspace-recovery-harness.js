'use strict';

// Shared rig for the row 34 S5 recovery tests: a real temp workspace behind a
// static root coordinator, the real IDE and git services, an injected recycle
// bin, and the workspaceRecovery IPC handlers with a stubbed sidecar.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { createTrackedTempDir } = require('./resource-cleanup');
const { registerWorkspaceRecoveryIpcHandlers } = require('../../services/workspace-recovery-ipc-handlers');
const { getBridgeChannel } = require('../../services/ipc-contract');
const { WorkspaceIdeService } = require('../../services/workspace-ide-service');
const { WorkspaceGitService } = require('../../services/workspace-git-service');
const { WorkspaceRootCoordinator } = require('../../services/workspace-root-coordinator');
const { WorkspaceRecoverySafetyCopyStore } = require('../../services/workspace-recovery-safety-copies');

const execFileAsync = promisify(execFile);

function git(cwd, args) {
  return execFileAsync('git', args, {
    cwd, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

async function createGitRepo(prefix = 'jenny-recovery-repo-') {
  const repo = createTrackedTempDir(prefix);
  await git(repo, ['init']);
  await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(repo, ['config', 'user.email', 'jenny@example.invalid']);
  await git(repo, ['config', 'user.name', 'Jenny Tests']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  return repo;
}

function createStaticRootCoordinator(rootPath) {
  return new WorkspaceRootCoordinator({
    initialRootPath: rootPath,
    normalizeRootPath: (value) => String(value || ''),
    rootIdFactory: (value) => (value ? `root:${String(value).toLowerCase()}` : null),
  });
}

// Moves the item into a private folder outside the workspace, like the OS bin.
function createTrash({ available = true } = {}) {
  const dir = createTrackedTempDir('jenny-recovery-trash-');
  const items = [];
  const trashItem = async (absolutePath) => {
    const destination = path.join(dir, `${items.length}-${path.basename(absolutePath)}`);
    fs.renameSync(absolutePath, destination);
    items.push({ from: absolutePath, to: destination });
  };
  return { dir, items, trashItem: available ? trashItem : null };
}

function createRecoveryHarness(root, {
  sidecar = async () => ({}),
  limits = undefined,
  trash = createTrash(),
  withGit = true,
  withIde = true,
  rootPathRef = null,
} = {}) {
  const currentRoot = () => (rootPathRef ? rootPathRef.value : root);
  let coordinator = createStaticRootCoordinator(currentRoot());
  const coordinatorFor = () => {
    if (coordinator.captureContext().rootPath !== currentRoot()) coordinator = createStaticRootCoordinator(currentRoot());
    return coordinator;
  };
  const configService = {
    getToolsWorkspaceRoot: () => currentRoot(),
    getState: () => ({ toolsWorkspaceRoot: currentRoot() }),
    getWorkspaceRootStatus: () => ({ state: 'ready', message: '' }),
  };
  const ideService = withIde ? new WorkspaceIdeService({
    configService,
    rootContextProvider: coordinatorFor,
    trashItemImpl: trash.trashItem,
  }) : null;
  const gitService = withGit ? new WorkspaceGitService({
    configService,
    featureFlagProvider: () => ({ workspace_git: true }),
    rootContextProvider: coordinatorFor,
    trashItemImpl: trash.trashItem,
    logger() {},
  }) : null;
  const safetyCopies = new WorkspaceRecoverySafetyCopyStore(limits ? { limits } : {});
  const handlers = new Map();
  const calls = [];
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike: { handle: (channel, handler) => handlers.set(channel, handler) },
    backendService: {
      sidecarClient: {
        request: async (method, params) => {
          calls.push({ method, params });
          return sidecar(method, params);
        },
      },
    },
    ipcAuthorization: {},
    gitService,
    ideService,
    safetyCopies,
  });
  const invoke = (methodPath, payload) => {
    const handler = handlers.get(getBridgeChannel(methodPath, 'invoke'));
    if (!handler) throw new Error(`no handler registered for ${methodPath}`);
    return handler({}, payload);
  };
  return { calls, gitService, ideService, invoke, safetyCopies, trash };
}

module.exports = {
  createGitRepo,
  createRecoveryHarness,
  createTrash,
  git,
};
