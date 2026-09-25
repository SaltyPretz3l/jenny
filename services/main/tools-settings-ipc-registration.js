'use strict';
// The Settings > Tools backends that main owns: the command sandbox and the
// optional PDF reading add-on. Both use the workspace trusted-sender authorizer.
const { registerCommandSandboxIpc } = require('./command-sandbox-ipc-registration');
const { registerPdfAddonIpc } = require('./pdf-addon-ipc-registration');

function registerToolsSettingsIpc(ipcMain, { backendService, authorization }) {
  registerCommandSandboxIpc(ipcMain, { service: backendService.commandSandbox, authorization });
  registerPdfAddonIpc(ipcMain, { service: backendService.pdfAddon, authorization });
}

module.exports = { registerToolsSettingsIpc };
