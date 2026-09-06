const { contextBridge, ipcRenderer, webUtils } = require('electron');

const { createJennyShellBridge, getBridgeChannel } = require('./services/ipc-contract');

getBridgeChannel('diagnostics.reportRendererError', 'invoke');
// reportRendererError is exposed via the preload bridge on diagnostics:renderer-error.

contextBridge.exposeInMainWorld('jennyShell', createJennyShellBridge({
  ipcRenderer,
  localImplementations: {
    // Must run in preload: Electron 32+ removed File.path, and
    // webUtils.getPathForFile only accepts the File object on this side of
    // the context bridge. Drag-drop attachment paths depend on it.
    getPathForFile(file) {
      try {
        return webUtils.getPathForFile(file) || '';
      } catch (_error) {
        return '';
      }
    },
  },
}));
