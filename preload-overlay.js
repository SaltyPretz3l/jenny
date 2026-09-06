/* preload-overlay.js — IPC bridge for overlay companion window. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayBridge', {
  onStateChanged: (callback) => {
    ipcRenderer.on('comet:state-changed', (_event, data) => callback(data));
  },
  onDispose: (callback) => {
    ipcRenderer.on('comet:dispose', () => callback());
  },
});
