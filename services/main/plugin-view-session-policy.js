'use strict';

const { PLUGIN_VIEW_SCHEME } = require('./plugin-view-protocol');

function installPluginViewSessionPolicy(session, artifactDigest) {
  if (!session) throw new TypeError('plugin view session is required');
  session.setPermissionCheckHandler?.(() => false);
  session.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
  session.setDevicePermissionHandler?.(() => false);
  session.setDisplayMediaRequestHandler?.((_request, callback) => callback({}));
  session.setFileSystemAccessRequestHandler?.((_webContents, _details, callback) => callback('deny'));
  session.webRequest?.onBeforeRequest?.((details, callback) => {
    let allowed;
    try {
      const url = new URL(details.url);
      allowed = url.protocol === `${PLUGIN_VIEW_SCHEME}:` && url.hostname === artifactDigest;
    } catch (_error) { allowed = false; }
    callback({ cancel: !allowed });
  });
  session.on?.('will-download', (event) => event.preventDefault());
  return session;
}

async function clearPluginViewSession(session) {
  if (!session) return;
  await session.clearData?.({
    dataTypes: ['cookies', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'cache'],
  });
  await session.clearStorageData?.();
  await session.clearCache?.();
  await session.closeAllConnections?.();
}

module.exports = { installPluginViewSessionPolicy, clearPluginViewSession };
