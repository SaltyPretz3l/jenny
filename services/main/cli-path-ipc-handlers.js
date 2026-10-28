'use strict';

const { registerIpcInvokeHandlers } = require('../ipc-contract');

// cli.path.*: the Settings "Command-line tool" row. Every handler ignores its
// arguments: the bin directory comes from the packaged layout in main, never
// from the renderer.
function registerCliPathIpcHandlers(ipcMain, { service, authorization } = {}) {
  if (!service) return [];
  return registerIpcInvokeHandlers(ipcMain, {
    'cli.path.getState': () => service.getState(),
    'cli.path.install': () => service.install(),
    'cli.path.remove': () => service.remove(),
  }, authorization);
}

module.exports = { registerCliPathIpcHandlers };
