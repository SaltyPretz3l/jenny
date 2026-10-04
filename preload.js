const { contextBridge, ipcRenderer, webUtils } = require('electron');

const { createJennyShellBridge, getBridgeChannel } = require('./services/ipc-contract');

getBridgeChannel('diagnostics.reportRendererError', 'invoke');
// reportRendererError is exposed via the preload bridge on diagnostics:renderer-error.
const PREPARE_DROPPED_PATHS_CHANNEL = getBridgeChannel('attachments.prepareDroppedPaths', 'invoke');

// Must run in preload: Electron 32+ removed File.path, and
// webUtils.getPathForFile only accepts the File object on this side of
// the context bridge. Drag-drop attachment paths depend on it.
function getPathForFile(file) {
  try {
    return webUtils.getPathForFile(file) || '';
  } catch (_error) {
    return '';
  }
}

contextBridge.exposeInMainWorld('jennyShell', createJennyShellBridge({
  ipcRenderer,
  localImplementations: {
    getPathForFile,
    // Only a File the user dropped (or picked) has a path; one the page built
    // itself resolves to '' and is skipped, so the page cannot name a path here.
    prepareDroppedFiles(files, scope) {
      const paths = Array.from(files || [], (file) => getPathForFile(file)).filter(Boolean);
      return ipcRenderer.invoke(PREPARE_DROPPED_PATHS_CHANNEL, paths, scope);
    },
  },
}));
