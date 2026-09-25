'use strict';

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const {
  createTrustedSenderAuthorizer,
  unauthorizedIpcResult,
} = require('./ipc-sender-authorization');

function registerSessionRuntimeIpcHandlers(ipcMainLike, {
  applicationService,
  runtimeApplicationService = null,
  getMainWindow = () => null,
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
  return registerIpcInvokeHandlers(ipcMainLike, {
    'projects.list': (_event, payload) => applicationService.listProjects(payload),
    'projects.create': (_event, payload) => applicationService.createProject(payload),
    'projects.rename': (_event, payload) => applicationService.renameProject(payload),
    'projects.bindRoot': (_event, payload) => applicationService.bindProjectRoot(payload),
    'projects.assignSession': (_event, payload) => applicationService.assignSessionProject(payload),
    'projects.adoptWorkspace': (_event, payload) => applicationService.adoptWorkspaceSession(payload),
    'projects.delete': (_event, payload) => applicationService.deleteProject(payload),
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

module.exports = { registerSessionRuntimeIpcHandlers };
