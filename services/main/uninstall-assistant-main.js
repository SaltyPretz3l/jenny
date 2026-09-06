'use strict';

const os = require('os');
const path = require('path');

const { AttachmentAssetStore } = require('../attachment-asset-store');
const { DATA_ERROR_CODES } = require('../backend/error-codes');
const { ElectronSessionStore } = require('../backend/electron-session-store');
const { DataLifecycleService, REMOVAL_CHOICES } = require('../data-lifecycle/data-lifecycle-service');
const {
  dataLifecycleFailure,
  dataLifecycleResult,
  unauthorizedDataLifecycleResult,
} = require('../data-lifecycle/data-lifecycle-result');
const { UNINSTALL_CHANNELS, UNINSTALL_EXIT_CODES } = require('../data-lifecycle/uninstall-contract');
const { ShellConfigService } = require('../shell-config-service');
const { createRemovalPreparation, normalizeArchiveOptions } = require('./data-lifecycle-ipc-registration');
const { createTrustedSenderAuthorizer } = require('./ipc-sender-authorization');

const UNINSTALL_DOCUMENT_PATH = path.resolve(__dirname, '..', '..', 'uninstall.html');

function isUninstallAssistantMode(argv = process.argv) {
  return Array.isArray(argv) && argv.includes('--uninstall-assistant');
}

function normalizeRemovalOptions(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const choice = String(source.choice || '');
  if (!Object.values(REMOVAL_CHOICES).includes(choice)) return null;
  const confirmation = typeof source.confirmation === 'string' && source.confirmation.length <= 64
    ? source.confirmation
    : '';
  const archive = choice === REMOVAL_CHOICES.ARCHIVE_AND_REMOVE
    ? normalizeArchiveOptions(source.archive)
    : null;
  if (choice === REMOVAL_CHOICES.ARCHIVE_AND_REMOVE && !archive) return null;
  return {
    choice,
    confirmation,
    archive,
    removeWorkspaceData: source.removeWorkspaceData === true,
  };
}

function exitCodeForRemovalMode(mode) {
  if (mode === REMOVAL_CHOICES.APP_ONLY) return UNINSTALL_EXIT_CODES.APP_ONLY;
  if (mode === REMOVAL_CHOICES.ARCHIVE_AND_REMOVE) return UNINSTALL_EXIT_CODES.ARCHIVE_AND_REMOVE;
  if (mode === REMOVAL_CHOICES.PERMANENT) return UNINSTALL_EXIT_CODES.PERMANENT;
  return UNINSTALL_EXIT_CODES.HELPER_FAILURE;
}

function createUninstallAssistantWindow({
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  service,
  rootDir,
  parent = 'app',
  log = () => {},
} = {}) {
  let authorizedRemovalMode = '';
  let committed = false;
  let completionRequested = false;
  const window = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 640,
    minHeight: 520,
    show: false,
    title: 'Uninstall Jenny',
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(rootDir, 'uninstall-preload.bundle.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const authorize = createTrustedSenderAuthorizer({
    getMainWindow: () => window,
    expectedDocumentPath: UNINSTALL_DOCUMENT_PATH,
    log,
  });
  const handle = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!authorize(event, { methodPath: channel })) return unauthorizedDataLifecycleResult();
      try {
        return await handler(...args);
      } catch (error) {
        const code = /^CMP-DATA-\d{4}$/.test(String(error?.code || ''))
          ? String(error.code)
          : DATA_ERROR_CODES.INVALID_REQUEST;
        const reason = String(error?.reason || 'handler_failed').slice(0, 80);
        log('WARN', 'uninstall_assistant.handler_failed', {
          channel,
          code,
          reason,
        });
        return dataLifecycleFailure({ code, reason });
      }
    });
  };
  handle(UNINSTALL_CHANNELS.getOverview, () => service.getOverview());
  handle(UNINSTALL_CHANNELS.chooseArchiveDestination, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose Jenny archive folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled || !result.filePaths?.[0]
      ? dataLifecycleResult('canceled', { destinationRoot: '' })
      : dataLifecycleResult('selected', { destinationRoot: result.filePaths[0] });
  });
  handle(UNINSTALL_CHANNELS.createArchive, (payload) => {
    const options = normalizeArchiveOptions(payload);
    return options ? service.createArchive(options) : dataLifecycleFailure({ code: DATA_ERROR_CODES.INVALID_REQUEST, reason: 'invalid_request' });
  });
  handle(UNINSTALL_CHANNELS.previewWorkspaceArchive, () => service.previewWorkspaceArchive());
  handle(UNINSTALL_CHANNELS.prepareRemoval, async (payload) => {
    const options = normalizeRemovalOptions(payload);
    if (!options) return dataLifecycleFailure({ code: DATA_ERROR_CODES.INVALID_REQUEST, reason: 'invalid_request' });
    const result = await service.prepareRemoval(options);
    if (result.ok && result.status === 'cleanup_authorized') {
      committed = true;
      authorizedRemovalMode = result.removalMode;
    }
    return result;
  });
  handle(UNINSTALL_CHANNELS.cancel, (operationId) => service.cancel(operationId));
  handle(UNINSTALL_CHANNELS.complete, (removalMode) => {
    if (!committed || removalMode !== authorizedRemovalMode) {
      return dataLifecycleFailure({ code: DATA_ERROR_CODES.INVALID_REQUEST, reason: 'cleanup_not_authorized' });
    }
    const exitCode = exitCodeForRemovalMode(authorizedRemovalMode);
    completionRequested = true;
    setImmediate(() => app.exit(exitCode));
    return dataLifecycleResult('closing', { exitCode });
  });
  const progressListener = (payload) => {
    if (!window.isDestroyed()) window.webContents.send(UNINSTALL_CHANNELS.progress, payload);
  };
  service.on('progress', progressListener);
  window.on('close', (event) => {
    if (committed || service.activeOperation) event.preventDefault();
  });
  window.on('closed', () => {
    service.removeListener('progress', progressListener);
    if (!committed) app.exit(UNINSTALL_EXIT_CODES.CANCEL);
  });
  window.webContents.on('render-process-gone', () => {
    if (!completionRequested) app.exit(UNINSTALL_EXIT_CODES.HELPER_FAILURE);
  });
  window.once('ready-to-show', () => window.show());
  const portableAppearance = service.preferencesStore?.read?.()?.appearance || { paletteId: 'obsidian' };
  const loadPromise = window.loadFile(UNINSTALL_DOCUMENT_PATH, { query: {
    parent: String(parent || 'app').slice(0, 24),
    jennyAppearance: JSON.stringify(portableAppearance),
  } });
  if (loadPromise && typeof loadPromise.catch === 'function') {
    void loadPromise.catch(() => {
      log('WARN', 'uninstall_assistant.document_load_failed', { reason: 'document_load_failed' });
      app.exit(UNINSTALL_EXIT_CODES.HELPER_FAILURE);
    });
  }
  return window;
}

async function runStandaloneUninstallAssistant({ app, BrowserWindow, ipcMain, dialog, nativeImage, rootDir } = {}) {
  const lock = app.requestSingleInstanceLock({ mode: 'uninstall-assistant' });
  if (!lock) {
    app.exit(UNINSTALL_EXIT_CODES.HELPER_FAILURE);
    return null;
  }
  await app.whenReady();
  const userDataPath = app.getPath('userData');
  const runtimePath = path.join(os.homedir(), '.companion');
  const sessionStore = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  const service = new DataLifecycleService({
    userDataPath,
    documentsPath: app.getPath('documents'),
    runtimePath,
    appVersion: app.getVersion(),
    sessionStore,
    attachmentStore: new AttachmentAssetStore({ rootDir: path.join(userDataPath, 'attachments'), nativeImage }),
    shellConfigService: new ShellConfigService({ userDataPath, resourcesPath: process.resourcesPath }),
    prepareForRemoval: createRemovalPreparation({
      flush: () => sessionStore.flushAsync(),
      cleanupOptions: {
        userDataPath,
        runtimePath,
      },
    }),
  });
  return createUninstallAssistantWindow({
    app, BrowserWindow, ipcMain, dialog, service, rootDir, parent: 'installer',
  });
}

module.exports = {
  UNINSTALL_DOCUMENT_PATH,
  createUninstallAssistantWindow,
  exitCodeForRemovalMode,
  isUninstallAssistantMode,
  normalizeRemovalOptions,
  runStandaloneUninstallAssistant,
};
