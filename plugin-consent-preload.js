'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jennyPluginConsent', Object.freeze({
  initialize: () => ipcRenderer.invoke('plugin-consent:initialize'),
  decide: (payload) => ipcRenderer.invoke('plugin-consent:decide', payload),
}));
