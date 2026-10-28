'use strict';
// The Settings > Tools backends that main owns: the command sandbox and the
// optional PDF reading add-on, image engine, managed NInfer runtime and dictation. All use
// the trusted-sender authorizer.
const { registerCommandSandboxIpc } = require('./command-sandbox-ipc-registration');
const { registerPdfAddonIpc } = require('./pdf-addon-ipc-registration');
const { registerImageEngineIpc } = require('./image-engine-ipc-registration');
const { registerNinferIpc } = require('./ninfer-ipc-registration');
const { registerDictationIpc } = require('./dictation-ipc-registration');

function registerToolsSettingsIpc(ipcMain, {
  backendService, authorization, dialog = null, getMainWindow = () => null, userDataPath = '',
}) {
  registerCommandSandboxIpc(ipcMain, { service: backendService.commandSandbox, authorization });
  registerPdfAddonIpc(ipcMain, { service: backendService.pdfAddon, authorization });
  // A missing dialog keeps the registration's Electron default instead of null.
  registerImageEngineIpc(ipcMain, { backendService, authorization, dialogImpl: dialog || undefined, getMainWindow, userDataPath });
  registerNinferIpc(ipcMain, { backendService, authorization });
  // Push-to-talk dictation: the speech model download plus the audio calls. The
  // flag and the sidecar client are read per call, not captured at registration.
  registerDictationIpc(ipcMain, {
    service: backendService.dictation,
    authorization,
    getClient: () => backendService.sidecarClient || null,
    isEnabled: () => backendService.featureFlags?.dictation !== false,
    openExternal: (url) => require('electron').shell.openExternal(url),
    log: (level, event, fields) => backendService._emitServiceLog?.(level, event, fields),
  });
}

module.exports = { registerToolsSettingsIpc };
