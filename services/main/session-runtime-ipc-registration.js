'use strict';

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { t } = require('../i18n-main');
const {
  createTrustedSenderAuthorizer,
  unauthorizedIpcResult,
} = require('./ipc-sender-authorization');

// "Locate folder" / "Change folder": the folder picker belongs to main, so a
// renderer can name a project but never a path (see
// services/projects/workspace-project-switch.js).
function createProjectFolderPicker({ dialog = null, getMainWindow = () => null } = {}) {
  if (!dialog || typeof dialog.showOpenDialog !== 'function') return null;
  return async ({ defaultPath } = {}) => {
    const options = {
      title: t('main.dialog.projectFolder.choose', 'Choose project folder'),
      properties: ['openDirectory'],
      ...(typeof defaultPath === 'string' && defaultPath ? { defaultPath } : {}),
    };
    const owner = getMainWindow?.();
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const selectedPath = Array.isArray(result?.filePaths) ? String(result.filePaths[0] || '') : '';
    return { canceled: result?.canceled === true || !selectedPath, path: selectedPath };
  };
}

function registerSessionRuntimeIpcHandlers(ipcMainLike, {
  applicationService,
  runtimeApplicationService = null,
  getMainWindow = () => null,
  dialog = null,
  shell = null,
  log = () => {},
  authorization = null,
} = {}) {
  if (!applicationService) {
    throw new TypeError('registerSessionRuntimeIpcHandlers requires applicationService.');
  }
  const ipcAuthorization = authorization || {
    authorize: createTrustedSenderAuthorizer({ getMainWindow, log }),
    unauthorizedResult: unauthorizedIpcResult,
  };
  const pickFolder = createProjectFolderPicker({ dialog, getMainWindow });
  return registerIpcInvokeHandlers(ipcMainLike, {
    // Desktop: the status-bearing list (folder_exists, is_current); the
    // synchronous listProjects stays for hosted commands.
    'projects.list': (_event, payload) => (
      typeof applicationService.listProjectsWithStatus === 'function'
        ? applicationService.listProjectsWithStatus(payload)
        : applicationService.listProjects(payload)
    ),
    'projects.create': (_event, payload) => applicationService.createProject(payload),
    'projects.rename': (_event, payload) => applicationService.renameProject(payload),
    'projects.bindRoot': (_event, payload) => applicationService.bindProjectRoot(payload),
    'projects.assignSession': (_event, payload) => applicationService.assignSessionProject(payload),
    'projects.adoptWorkspace': (_event, payload) => applicationService.adoptWorkspaceSession(payload),
    'projects.delete': (_event, payload) => applicationService.deleteProject(payload),
    'projects.chooseRoot': (_event, payload) => applicationService.chooseProjectRoot(payload, { pickFolder }),
    // shell.openPath resolves '' on success, else an error string.
    'projects.revealFolder': (_event, payload) => applicationService.revealProjectFolder(payload, {
      openFolder: shell && typeof shell.openPath === 'function' ? (folder) => shell.openPath(folder) : null,
    }),
    'permissionReview.getState': (_event, payload) => (
      applicationService.getPermissionReviewState(payload)
    ),
    'permissionReview.resolve': (_event, payload) => (
      applicationService.resolvePermissionReview(payload)
    ),
    ...(runtimeApplicationService ? {
      'sessionRuntime.start': (_event, payload) => runtimeApplicationService.start(payload),
      'sessionRuntime.submit': (_event, payload) => runtimeApplicationService.submit(payload),
      'sessionRuntime.resume': (_event, payload) => runtimeApplicationService.resume(payload),
      'sessionRuntime.pause': (_event, payload) => runtimeApplicationService.pause(payload),
      'sessionRuntime.cancel': (_event, payload) => runtimeApplicationService.cancel(payload),
      'sessionRuntime.updatePending': (_event, payload) => runtimeApplicationService.updatePending(payload),
      'sessionRuntime.updateLimits': (_event, payload) => runtimeApplicationService.updateLimits(payload),
      'sessionRuntime.getResult': (_event, payload) => runtimeApplicationService.getResult(payload),
      'sessionRuntime.getSnapshot': (_event, payload) => runtimeApplicationService.getSnapshot(payload),
      'sessionRuntime.getWork': (_event, payload) => runtimeApplicationService.getWork(payload),
    } : {}),
  }, ipcAuthorization);
}

module.exports = { createProjectFolderPicker, registerSessionRuntimeIpcHandlers };
