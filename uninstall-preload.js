'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { UNINSTALL_CHANNELS } = require('./services/data-lifecycle/uninstall-contract');

function subscribe(channel, listener) {
  if (typeof listener !== 'function') throw new TypeError('Progress listener must be a function.');
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('jennyUninstall', Object.freeze({
  getOverview: () => ipcRenderer.invoke(UNINSTALL_CHANNELS.getOverview),
  chooseArchiveDestination: () => ipcRenderer.invoke(UNINSTALL_CHANNELS.chooseArchiveDestination),
  createArchive: (options) => ipcRenderer.invoke(UNINSTALL_CHANNELS.createArchive, options),
  previewWorkspaceArchive: () => ipcRenderer.invoke(UNINSTALL_CHANNELS.previewWorkspaceArchive),
  prepareRemoval: (options) => ipcRenderer.invoke(UNINSTALL_CHANNELS.prepareRemoval, options),
  cancel: (operationId) => ipcRenderer.invoke(UNINSTALL_CHANNELS.cancel, operationId),
  complete: (removalMode) => ipcRenderer.invoke(UNINSTALL_CHANNELS.complete, removalMode),
  onProgress: (listener) => subscribe(UNINSTALL_CHANNELS.progress, listener),
}));
