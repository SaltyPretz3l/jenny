'use strict';

const { installDefaultSessionPermissionGuard } = require('./default-session-permission-guard');
const { createDisplayMediaSourceHandler } = require('./display-media-source-handler');
const { createArtifactFrameProtocol } = require('../artifact-frame-protocol');

/**
 * Everything main.js pins on session.defaultSession at app-ready, in order:
 * the deny-by-default web-permission guard (before the main window loads any
 * model/user-authored content — Electron's out-of-the-box behavior grants
 * camera/mic/geolocation/etc.), the display-media source picker, and the
 * jenny-artifact:// one-shot document protocol for the sandboxed HTML preview
 * frame. The artifact scheme's privileges are registered separately at module
 * load in main.js (registerArtifactFramePrivilegedScheme) because Electron
 * rejects privileged-scheme registration once the app is ready.
 *
 * Returns the display-media handler so main.js can thread it into IPC
 * registration and the awaited shutdown disposal path.
 */
function installDefaultSessionWiring({ session, desktopCapturer, ipcMain, sendBridgeEvent, log }) {
  installDefaultSessionPermissionGuard({ session, log });
  const displayMediaSourceHandler = createDisplayMediaSourceHandler({
    desktopCapturer,
    sendToRenderer: (payload) => sendBridgeEvent('displayMediaPicker.onRequest', payload),
    sendCancel: (payload) => sendBridgeEvent('displayMediaPicker.onCancel', payload),
    log,
  });
  displayMediaSourceHandler.installHandler(session);
  createArtifactFrameProtocol({ log }).install({ sessionRef: session, ipcMainLike: ipcMain });
  return { displayMediaSourceHandler };
}

module.exports = { installDefaultSessionWiring };
