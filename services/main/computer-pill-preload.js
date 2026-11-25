'use strict';

/* services/main/computer-pill-preload.js: the preload of the computer-use frame and pill (row 196, C6).
 *
 * Sandboxed and self-contained (it requires only electron, so it needs no bundle). It exposes the pill's two
 * answers, its size and the state push, and nothing else. The calls carry no chat id: main answers for the
 * chat the pill is showing and accepts them only from the pill's own document
 * (services/computer-use/turn-overlay.js). */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jennyComputerPill', Object.freeze({
  resume: () => ipcRenderer.invoke('computer-pill:resume'),
  stop: () => ipcRenderer.invoke('computer-pill:stop'),
  size: (width, height) => ipcRenderer.invoke('computer-pill:size', { width: Number(width), height: Number(height) }),
  onState: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, view) => listener(view);
    ipcRenderer.on('computer-pill:state', wrapped);
    return () => ipcRenderer.removeListener('computer-pill:state', wrapped);
  },
}));
