'use strict';
// The Settings > Tools backends that main owns: the command sandbox and the
// optional PDF reading add-on and image engine. All use the trusted-sender authorizer.
const { registerCommandSandboxIpc } = require('./command-sandbox-ipc-registration');
const { registerPdfAddonIpc } = require('./pdf-addon-ipc-registration');
const { registerImageEngineIpc } = require('./image-engine-ipc-registration');

function registerToolsSettingsIpc(ipcMain, {
  backendService, authorization, dialog = null, getMainWindow = () => null, userDataPath = '',
}) {
  registerCommandSandboxIpc(ipcMain, { service: backendService.commandSandbox, authorization });
  registerPdfAddonIpc(ipcMain, { service: backendService.pdfAddon, authorization });
  // A missing dialog keeps the registration's Electron default instead of null.
  registerImageEngineIpc(ipcMain, { backendService, authorization, dialogImpl: dialog || undefined, getMainWindow, userDataPath });
}

module.exports = { registerToolsSettingsIpc };
