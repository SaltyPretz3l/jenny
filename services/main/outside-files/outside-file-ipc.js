'use strict';

// IPC for files opened from outside the Workspace (row 137). Every handler
// runs under the trusted-sender authorizer and names a grant id; results go
// through the versioned-file result wrapper, so codes, messages and detail
// keys are bounded and path-free exactly as Workspace file results are.

const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const { invokeVersionedWorkspaceFile } = require('../workspace-file-ipc-result');
const { prepareAttachmentEntries } = require('../../attachment-service');
const { isChildPath } = require('../../backend/path-utils');
const { createAttachmentIpcHandlers } = require('../attachment-ipc-handlers');
const { t } = require('../../i18n-main');
const { OutsideFileService } = require('./outside-file-service');

// The same text/code list the registration offers (build/installer.nsh).
const PICKER_EXTENSIONS = Object.freeze([
  'md', 'markdown', 'mdx', 'txt', 'text', 'log', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'mts', 'cts',
  'py', 'pyi', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'lua', 'sh',
  'bash', 'zsh', 'ps1', 'psm1', 'sql', 'mmd', 'mermaid', 'graphql', 'gql', 'proto',
]);

function captureWorkspaceRoot(workspaceRootCoordinator) {
  const context = workspaceRootCoordinator?.captureContext?.();
  return context && context.phase === 'ready' ? String(context.rootPath || '') : '';
}

function registerOutsideFileIpc(ipcMain, {
  app,
  backendService,
  shellConfigService,
  dialog,
  getMainWindow,
  attachmentAssetStore,
  processRef = process,
  showItemInFolderImpl = null,
  sendBridgeEvent = () => {},
  workspaceRootCoordinator = null,
  workspaceAuthorization,
  log = () => {},
  serviceFactory = (options) => new OutsideFileService(options),
} = {}) {
  // "Attach File to Chat" takes the dropped-file path: the user chose this
  // file, so it gets the picker's rules (sensitive-path denylist, size and
  // count caps) rather than the project-root check.
  const attachmentHandlers = createAttachmentIpcHandlers({
    backendService, shellConfigService, dialog, getMainWindow,
    prepareAttachmentEntries, attachmentAssetStore, processRef, isChildPath, log,
  });
  const service = serviceFactory({
    userDataPath: app?.getPath ? app.getPath('userData') : '',
    getWorkspaceRoot: () => captureWorkspaceRoot(workspaceRootCoordinator),
    sendBridgeEvent,
    showItemInFolder: typeof showItemInFolderImpl === 'function' ? showItemInFolderImpl : null,
    attachPaths: (paths, scope) => attachmentHandlers['attachments.prepareDroppedPaths'](null, paths, scope),
    pickFiles: async () => {
      if (!dialog || typeof dialog.showOpenDialog !== 'function') return [];
      const result = await dialog.showOpenDialog(getMainWindow?.(), {
        title: t('main.dialog.outsideFiles.title', 'Open File'),
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: t('main.dialog.outsideFiles.textFiles', 'Text and code'), extensions: [...PICKER_EXTENSIONS] },
          { name: t('main.dialog.attachments.allFiles', 'All files'), extensions: ['*'] },
        ],
      });
      return result && !result.canceled && Array.isArray(result.filePaths) ? result.filePaths : [];
    },
    log,
  });

  const run = (method) => (_event, payload) => invokeVersionedWorkspaceFile(service, method, payload && typeof payload === 'object' ? payload : {});
  registerIpcInvokeHandlers(ipcMain, {
    'outsideFiles.takePending': () => service.takePending(),
    'outsideFiles.readText': run('readText'),
    'outsideFiles.writeText': run('writeText'),
    'outsideFiles.readImage': run('readImage'),
    'outsideFiles.setOpenSet': run('setOpenSet'),
    'outsideFiles.reveal': run('reveal'),
    'outsideFiles.attach': run('attach'),
    'outsideFiles.pick': run('pick'),
  }, workspaceAuthorization);
  return { service };
}

module.exports = { PICKER_EXTENSIONS, registerOutsideFileIpc };
