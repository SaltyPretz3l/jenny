'use strict';

// changePictures.* IPC: before and after pictures of the pages a change
// touched. Every handler sits behind the trusted-sender authorizer. The
// renderer names a chat, a turn and that turn's change records; the service
// validates all of it, resolves the workspace from the chat's own authority
// and answers picture URLs and workspace-relative paths only. No file bytes,
// no workspace path, no git ref and no git output cross this seam. Desktop
// only: the hosted host has no hidden browser and registers nothing here.

const { registerIpcInvokeHandlers } = require('../ipc-contract');

const METHODS = Object.freeze({
  'changePictures.capture': 'capture',
  'changePictures.captureWorkingTree': 'captureWorkingTree',
  'changePictures.list': 'list',
});
const STORE_FOLDER = 'change-pictures';

function createLazyChangePicturesService({ app, backendService, browserSessionService, snapshotStore, log }) {
  let service = null;
  return () => {
    if (service) return service;
    if (!browserSessionService || !snapshotStore || !backendService?.projectAuthority) return null;
    const path = require('path');
    const { createChangePicturesService } = require('../change-pictures/change-pictures-service');
    const { createChangePictureStore } = require('../change-pictures/picture-store');
    const { findAffectedPages } = require('../change-pictures/page-finder');
    const { createWorkingTreeLoader } = require('../change-pictures/working-tree');
    const captureAuthority = (sessionId) => backendService.projectAuthority.captureSession(sessionId);
    service = createChangePicturesService({
      browserSessionService,
      snapshotStore,
      pictureStore: createChangePictureStore({
        rootDir: path.join(app.getPath('userData'), STORE_FOLDER),
        logger: log,
      }),
      findAffectedPages,
      resolveWorkspaceRoot: (sessionId) => captureAuthority(sessionId)?.root_path || '',
      loadWorkingTree: createWorkingTreeLoader({
        resolveGitService: (sessionId) => backendService.resolveProjectWorkspaceServices(
          captureAuthority(sessionId), { sessionId }
        )?.workspaceGitService || null,
      }),
      isEnabled: () => backendService.hostMode !== 'server' && backendService.featureFlags?.change_pictures !== false,
      logger: log,
    });
    return service;
  };
}

function registerChangePicturesIpc(ipcMain, {
  app,
  backendService,
  browserSessionService = null,
  snapshotStore = null,
  authorization,
  log = () => {},
  getService = createLazyChangePicturesService({ app, backendService, browserSessionService, snapshotStore, log }),
}) {
  const handlers = {};
  for (const [methodPath, serviceMethod] of Object.entries(METHODS)) {
    handlers[methodPath] = async (_event, raw) => {
      try {
        const service = getService();
        if (!service) return { ok: false, reason: 'unavailable' };
        return await service[serviceMethod](raw);
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
    };
  }
  return registerIpcInvokeHandlers(ipcMain, handlers, authorization);
}

module.exports = { STORE_FOLDER, createLazyChangePicturesService, registerChangePicturesIpc };
