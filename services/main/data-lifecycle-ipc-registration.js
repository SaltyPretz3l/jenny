'use strict';

const path = require('path');
const os = require('os');

const { DATA_ERROR_CODES } = require('../backend/error-codes');
const { DataLifecycleService, REMOVAL_CHOICES } = require('../data-lifecycle/data-lifecycle-service');
const { describeRestoreCandidate } = require('../data-lifecycle/restore-service');
const { cleanupJennyData } = require('../data-lifecycle/cleanup-service');
const {
  dataLifecycleFailure,
  dataLifecycleResult,
  unauthorizedDataLifecycleResult,
} = require('../data-lifecycle/data-lifecycle-result');
const { registerIpcInvokeHandlers } = require('../ipc-contract');
const {
  createTrustedSenderAuthorizer,
} = require('./ipc-sender-authorization');

function invalid(reason = 'invalid_request') {
  return dataLifecycleFailure({ code: DATA_ERROR_CODES.INVALID_REQUEST, reason });
}

function boundedString(value, maxLength) {
  const result = typeof value === 'string' ? value : '';
  return result.length <= maxLength ? result : '';
}

function normalizeArchiveOptions(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const encrypted = source.encrypted !== false;
  const passphrase = boundedString(source.passphrase, 1024);
  const confirmation = boundedString(source.passphraseConfirmation, 1024);
  if (encrypted && (!passphrase || !confirmation)) return null;
  const destinationRoot = boundedString(source.destinationRoot, 2048);
  if (destinationRoot && !path.isAbsolute(destinationRoot)) return null;
  return {
    encrypted,
    passphrase,
    passphraseConfirmation: confirmation,
    destinationRoot,
    includeWorkspace: source.includeWorkspace === true,
    workspaceReviewId: boundedString(source.workspaceReviewId, 128),
  };
}

function normalizeRestoreOptions(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const archivePath = boundedString(source.archivePath, 2048);
  const passphrase = boundedString(source.passphrase, 1024);
  if (!archivePath || !path.isAbsolute(archivePath)) return null;
  return { archivePath, passphrase };
}

function normalizeWorkspaceRestoreOptions(payload, { requireReview = false } = {}) {
  const options = normalizeRestoreOptions(payload);
  if (!options) return null;
  const reviewId = boundedString(payload?.reviewId, 128);
  if (requireReview && !reviewId) return null;
  return { ...options, reviewId };
}

async function noThrow(task) {
  try {
    return await task();
  } catch (error) {
    return dataLifecycleFailure(error);
  }
}

function createRemovalPreparation({
  flush = async () => {},
  stop = async () => {},
  cleanupData = cleanupJennyData,
  cleanupOptions = {},
} = {}) {
  return async ({ choice, removeWorkspaceData, workspaceRoot }) => {
    await flush();
    await stop();
    if (choice === REMOVAL_CHOICES.APP_ONLY) return { ok: true, status: 'data_preserved' };
    return cleanupData({
      ...cleanupOptions,
      workspaceRoot,
      removeWorkspaceData,
      includeUserData: false,
    });
  };
}

async function launchOfficialRemovalEntry({ platform, isPackaged, shellLike } = {}) {
  if (platform === 'win32' && isPackaged) {
    await shellLike.openExternal('ms-settings:appsfeatures');
    return dataLifecycleResult('system_uninstaller_opened', {
      instructions: 'Select Jenny in Installed apps to continue.',
    });
  }
  if (platform === 'darwin' && isPackaged) {
    return dataLifecycleResult('manual_helper_required', {
      instructions: 'Run Uninstall Jenny.command from the Jenny installer disk image.',
    });
  }
  return dataLifecycleResult('clone_command_required', {
    instructions: 'Run npm run uninstall from the Jenny clone.',
  });
}

function registerDataLifecycleIpcHandlers(ipcMainLike, {
  service,
  dialog,
  getMainWindow = () => null,
  launchUninstallAssistant = async () => dataLifecycleFailure({
    code: DATA_ERROR_CODES.INVALID_REQUEST,
    reason: 'uninstall_assistant_unavailable',
  }),
  sendBridgeEvent = () => {},
  log = () => {},
} = {}) {
  if (!service) throw new TypeError('registerDataLifecycleIpcHandlers requires service.');
  const authorization = {
    authorize: createTrustedSenderAuthorizer({ getMainWindow, log }),
    unauthorizedResult: unauthorizedDataLifecycleResult,
  };
  const channels = registerIpcInvokeHandlers(ipcMainLike, {
    'dataLifecycle.getOverview': () => noThrow(() => service.getOverview()),
    'dataLifecycle.chooseArchiveDestination': () => noThrow(async () => {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Choose Jenny archive folder',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths?.[0]) {
        return dataLifecycleResult('canceled', { destinationRoot: '' });
      }
      return dataLifecycleResult('selected', { destinationRoot: result.filePaths[0] });
    }),
    'dataLifecycle.createArchive': (_event, payload) => noThrow(() => {
      const options = normalizeArchiveOptions(payload);
      return options ? service.createArchive(options) : invalid();
    }),
    'dataLifecycle.previewWorkspaceArchive': () => noThrow(() => service.previewWorkspaceArchive()),
    'dataLifecycle.findRestoreCandidates': (_event, payload) => noThrow(async () => {
      if (payload?.chooseAnother !== true) return service.findRestoreCandidates();
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: 'Choose a Jenny archive',
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths?.[0]) {
        return dataLifecycleResult('canceled', { candidates: [] });
      }
      try {
        return dataLifecycleResult('selected', { candidates: [describeRestoreCandidate(result.filePaths[0])] });
      } catch (error) {
        return dataLifecycleFailure(error);
      }
    }),
    'dataLifecycle.stageRestore': (_event, payload) => noThrow(() => {
      const options = normalizeRestoreOptions(payload);
      return options ? service.stageRestore(options) : invalid();
    }),
    'dataLifecycle.previewWorkspaceRestore': (_event, payload) => noThrow(() => {
      const options = normalizeWorkspaceRestoreOptions(payload);
      return options ? service.previewWorkspaceRestore(options) : invalid();
    }),
    'dataLifecycle.restoreWorkspace': (_event, payload) => noThrow(() => {
      const options = normalizeWorkspaceRestoreOptions(payload, { requireReview: true });
      return options ? service.restoreWorkspace(options) : invalid();
    }),
    'dataLifecycle.launchUninstallAssistant': () => noThrow(() => launchUninstallAssistant()),
    'dataLifecycle.syncPortablePreferences': (_event, payload) => noThrow(() => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid();
      return service.syncPortablePreferences(payload);
    }),
  }, authorization);
  const progressListener = (payload) => sendBridgeEvent('dataLifecycle.onProgress', payload);
  service.on('progress', progressListener);
  return {
    channels,
    dispose() {
      service.removeListener('progress', progressListener);
    },
  };
}

function registerDataLifecycleRuntime(ipcMainLike, {
  app,
  backendService,
  attachmentStore,
  shellConfigService,
  workspaceRootCoordinator = null,
  dialog,
  getMainWindow,
  sendBridgeEvent,
  log,
} = {}) {
  const { shell } = require('electron');
  const userDataPath = app.getPath('userData');
  const runtimePath = path.join(os.homedir(), '.companion');
  const service = new DataLifecycleService({
    userDataPath,
    documentsPath: app.getPath('documents'),
    runtimePath,
    appVersion: typeof app.getVersion === 'function' ? app.getVersion() : '',
    sessionStore: backendService.sessionStore,
    attachmentStore,
    shellConfigService,
    workspaceRootCoordinator,
    logger: log,
    prepareForRemoval: createRemovalPreparation({
      flush: () => backendService.sessionStore?.flushAsync?.(),
      stop: () => backendService.stop?.({ ollamaShutdownScope: 'any_local' }),
      cleanupOptions: {
        userDataPath,
        runtimePath,
      },
    }),
  });
  const registration = registerDataLifecycleIpcHandlers(ipcMainLike, {
    service,
    dialog,
    getMainWindow,
    sendBridgeEvent,
    log,
    launchUninstallAssistant: () => launchOfficialRemovalEntry({
      platform: process.platform,
      isPackaged: app.isPackaged,
      shellLike: shell,
    }),
  });
  return { ...registration, service };
}

module.exports = {
  boundedString,
  createRemovalPreparation,
  launchOfficialRemovalEntry,
  normalizeArchiveOptions,
  normalizeRestoreOptions,
  normalizeWorkspaceRestoreOptions,
  noThrow,
  registerDataLifecycleIpcHandlers,
  registerDataLifecycleRuntime,
};
