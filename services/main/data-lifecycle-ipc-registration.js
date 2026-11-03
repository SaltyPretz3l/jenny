'use strict';

const path = require('path');
const os = require('os');

const { DATA_ERROR_CODES } = require('../backend/error-codes');
const { DataLifecycleService, REMOVAL_CHOICES } = require('../data-lifecycle/data-lifecycle-service');
const { describeRestoreCandidate } = require('../data-lifecycle/restore-service');
const { cleanupJennyData } = require('../data-lifecycle/cleanup-service');
const { StorageUsageService } = require('../data-lifecycle/storage-usage');
const { CATEGORY_IDS, isCategoryId } = require('../data-lifecycle/storage-usage-registry');
const { appImagePath, resolveLinuxPackageKind } = require('../linux-package-kind');
const {
  dataLifecycleFailure,
  dataLifecycleResult,
  unauthorizedDataLifecycleResult,
} = require('../data-lifecycle/data-lifecycle-result');
const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { t } = require('../i18n-main');
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

const STORAGE_REQUEST_KEYS = Object.freeze({
  preview: ['categoryId'],
  clear: ['categoryId', 'previewToken', 'confirmCount'],
  reveal: ['categoryId'],
});
const MAX_PREVIEW_TOKEN_LENGTH = 128;
const MAX_CONFIRM_COUNT = 1_000_000;

// "Your data" requests carry a category id (closed set) and, for a clear, the
// preview token and the typed chat count. Anything else, including any extra
// key, is refused: the renderer never names a path.
function normalizeStorageRequest(payload, kind) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const allowed = STORAGE_REQUEST_KEYS[kind];
  if (Object.keys(payload).some((key) => !allowed.includes(key))) return null;
  if (!isCategoryId(payload.categoryId)) return null;
  const request = { categoryId: payload.categoryId };
  if (kind !== 'clear') return request;
  if (typeof payload.previewToken !== 'string' || !payload.previewToken
    || payload.previewToken.length > MAX_PREVIEW_TOKEN_LENGTH) return null;
  request.previewToken = payload.previewToken;
  if (payload.confirmCount !== undefined) {
    if (!Number.isSafeInteger(payload.confirmCount) || payload.confirmCount < 0
      || payload.confirmCount > MAX_CONFIRM_COUNT) return null;
    request.confirmCount = payload.confirmCount;
  }
  return request;
}

// getStorageUsage takes nothing (measure every category) or { categoryIds } with
// 1..7 closed category ids (measure just those). Any other shape or key is refused.
function normalizeUsageRequest(payload) {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (Object.keys(payload).some((key) => key !== 'categoryIds')) return null;
  const ids = payload.categoryIds;
  if (ids === undefined) return {};
  if (!Array.isArray(ids) || !ids.length || ids.length > CATEGORY_IDS.length || !ids.every(isCategoryId)) return null;
  return { categoryIds: [...new Set(ids)] };
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
  return async ({ choice, removeWorkspaceData, workspaceRemovalScope, workspaceRoot, removeSkills = false }) => {
    await flush();
    await stop();
    if (choice === REMOVAL_CHOICES.APP_ONLY) return { ok: true, status: 'data_preserved' };
    return cleanupData({
      ...cleanupOptions,
      workspaceRoot,
      removeWorkspaceData,
      workspaceRemovalScope,
      removeSkills: removeSkills === true,
      includeUserData: false,
    });
  };
}

async function launchOfficialRemovalEntry({
  platform,
  isPackaged,
  shellLike,
  env = process.env,
  execPath = process.execPath,
} = {}) {
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
  if (platform === 'linux' && isPackaged) {
    const packageOptions = { platform, env, execPath };
    if (resolveLinuxPackageKind(packageOptions) === 'appimage') {
      return dataLifecycleResult('manual_file_removal_required', {
        instructions: `Delete the Jenny AppImage file (${appImagePath(packageOptions)}) to remove the app. Your data in ~/.config/jenny and ~/.companion stays until you delete it.`,
      });
    }
    return dataLifecycleResult('package_manager_required', {
      instructions: 'Remove the package with your package manager, for example: sudo apt remove jenny. Your data in ~/.config/jenny and ~/.companion stays until you delete it.',
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
  storageUsage = null,
  storageUsageEnabled = () => true,
} = {}) {
  if (!service) throw new TypeError('registerDataLifecycleIpcHandlers requires service.');
  const authorization = {
    authorize: createTrustedSenderAuthorizer({ getMainWindow, log }),
    unauthorizedResult: unauthorizedDataLifecycleResult,
  };
  const withStorageUsage = (task) => noThrow(() => {
    if (!storageUsage) return invalid('storage_usage_unavailable');
    if (!storageUsageEnabled()) return invalid('feature_disabled');
    return task(storageUsage);
  });
  const storageRequest = (kind, run) => (_event, payload) => withStorageUsage((usage) => {
    const request = normalizeStorageRequest(payload, kind);
    return request ? run(usage, request) : invalid();
  });
  const channels = registerIpcInvokeHandlers(ipcMainLike, {
    'dataLifecycle.getStorageUsage': (_event, payload) => withStorageUsage((usage) => {
      const request = normalizeUsageRequest(payload);
      return request ? usage.getStorageUsage(request) : invalid();
    }),
    'dataLifecycle.previewClear': storageRequest('preview', (usage, request) => usage.previewClear(request)),
    'dataLifecycle.clearCategory': storageRequest('clear', (usage, request) => usage.clearCategory(request)),
    'dataLifecycle.revealCategory': storageRequest('reveal', (usage, request) => usage.revealCategory(request)),
    'dataLifecycle.getOverview': () => noThrow(() => service.getOverview()),
    'dataLifecycle.chooseArchiveDestination': () => noThrow(async () => {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        title: t('main.dialog.dataLifecycle.chooseArchiveFolder', 'Choose Jenny archive folder'),
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
        title: t('main.dialog.dataLifecycle.chooseArchive', 'Choose a Jenny archive'),
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
  // Tests pass a temp home: a removal run here deletes the runtime children.
  homeDir = os.homedir(),
} = {}) {
  const { session, shell } = require('electron');
  const userDataPath = app.getPath('userData');
  const runtimePath = path.join(homeDir, '.companion');
  const service = new DataLifecycleService({
    userDataPath,
    documentsPath: app.getPath('documents'),
    runtimePath,
    appVersion: typeof app.getVersion === 'function' ? app.getVersion() : '',
    sessionStore: backendService.sessionStore,
    attachmentStore,
    shellConfigService,
    workspaceRootCoordinator,
    runtimeArchivePort: backendService.sessionRuntime,
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
  const storageUsage = new StorageUsageService({
    userDataPath,
    runtimePath,
    getWorkspaceRoot: () => service.getWorkspaceRoot(),
    sessionStore: backendService.sessionStore,
    deleteChat: typeof backendService.deleteSession === 'function'
      ? (sessionId) => backendService.deleteSession(sessionId)
      : null,
    // Chromium owns its cache directories: clear them through the session, never by removal.
    clearBrowserCaches: session ? async () => {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData({ storages: ['shadercache', 'cachestorage'] });
    } : null,
    openPath: shell?.openPath ? (target) => shell.openPath(target) : null,
    getTrackedJobIds: () => {
      const state = backendService.backgroundJobTracker?.getState?.();
      return Array.isArray(state?.jobs) ? state.jobs.map((job) => job.jobId) : null;
    },
    acquireWorkspaceLease: () => workspaceRootCoordinator?.acquireOperation?.({ kind: 'mutation', cancellable: false })
      || { acquired: true },
    logger: log,
  });
  const registration = registerDataLifecycleIpcHandlers(ipcMainLike, {
    service,
    storageUsage,
    storageUsageEnabled: () => backendService.featureFlags?.data_usage_page !== false,
    dialog,
    getMainWindow,
    sendBridgeEvent,
    log,
    launchUninstallAssistant: () => launchOfficialRemovalEntry({
      platform: process.platform,
      isPackaged: app.isPackaged,
      shellLike: shell,
      env: process.env,
      execPath: process.execPath,
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
  normalizeStorageRequest,
  normalizeUsageRequest,
  normalizeWorkspaceRestoreOptions,
  noThrow,
  registerDataLifecycleIpcHandlers,
  registerDataLifecycleRuntime,
};
