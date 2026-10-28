'use strict';

const { installDefaultSessionPermissionGuard } = require('./default-session-permission-guard');
const { createDisplayMediaSourceHandler } = require('./display-media-source-handler');
const { createArtifactFrameProtocol } = require('../artifact-frame-protocol');
const { buildFeatureFlags } = require('../feature-flags');

// Chromium on Windows serves file://host/... (and file:////host/...) over SMB,
// handing the user's NTLM hash to whatever host model-authored content names.
// The pattern's host part is ignored for file: URLs, so this matches every
// file: request of the listed types; app pages and local images (host-less
// file:///) still pass. Scripts and stylesheets are left out: the app loads
// hundreds of its own over file: at startup, each listener call is a blocking
// hop to the main process, and the CSP already pins them to the bundle.
// Only Electron's filter vocabulary is accepted: an unknown token such as
// 'other' (a details.resourceType, not a filter type) throws "Invalid type"
// and aborts backend start.
const FILE_REQUEST_FILTER = Object.freeze({
  urls: ['file://*/*'],
  types: ['mainFrame', 'subFrame', 'image', 'font', 'object', 'xhr', 'ping', 'cspReport', 'media', 'webSocket'],
});

function isRemoteFileUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch (_error) {
    return true;
  }
  if (parsed.protocol !== 'file:') return false;
  const host = parsed.hostname.toLowerCase();
  return (host !== '' && host !== 'localhost') || /^\/(?:[\\/]|%5c|%2f)/i.test(parsed.pathname);
}

/**
 * Cancel every file: request on the session that names a remote host. Electron
 * keeps one onBeforeRequest listener per session; nothing else registers one on
 * the default session (the browser tool filters its own partitions).
 */
function installRemoteFileRequestFilter({ session, log = () => {} }) {
  if (!session?.webRequest || typeof session.webRequest.onBeforeRequest !== 'function') return false;
  session.webRequest.onBeforeRequest(FILE_REQUEST_FILTER, (details, callback) => {
    if (!isRemoteFileUrl(details?.url)) {
      callback({});
      return;
    }
    log('WARN', 'session.remote_file_request_blocked', {
      resourceType: String(details?.resourceType || '').slice(0, 40),
    });
    callback({ cancel: true });
  });
  return true;
}

/**
 * Everything main.js pins on session.defaultSession at app-ready, in order:
 * the deny-by-default web-permission guard (before the main window loads any
 * model/user-authored content — Electron's out-of-the-box behavior grants
 * camera/mic/geolocation/etc.), the remote file:// request filter, the
 * display-media source picker, and the
 * jenny-artifact:// one-shot document protocol for the sandboxed HTML preview
 * frame. The artifact scheme's privileges are registered separately at module
 * load in main.js (registerArtifactFramePrivilegedScheme) because Electron
 * rejects privileged-scheme registration once the app is ready.
 *
 * Returns the display-media handler so main.js can thread it into IPC
 * registration and the awaited shutdown disposal path.
 */
function installDefaultSessionWiring({
  session, desktopCapturer, ipcMain, sendBridgeEvent, log, authorization = {}, getMainWindow = null, getShellConfigService = null, env = process.env,
}) {
  // Dictation's microphone gate reads the flag (user override included) on every request, so turning
  // dictation off in Settings closes the microphone without a restart.
  const isMicrophoneEnabled = () => typeof getShellConfigService === 'function'
    && buildFeatureFlags(env, getShellConfigService()?.getState?.()?.featureOverrides || {}).dictation !== false;
  installDefaultSessionPermissionGuard({ session, log, getMainWindow, isMicrophoneEnabled });
  installRemoteFileRequestFilter({ session, log });
  const displayMediaSourceHandler = createDisplayMediaSourceHandler({
    desktopCapturer,
    sendToRenderer: (payload) => sendBridgeEvent('displayMediaPicker.onRequest', payload),
    sendCancel: (payload) => sendBridgeEvent('displayMediaPicker.onCancel', payload),
    log,
  });
  displayMediaSourceHandler.installHandler(session);
  createArtifactFrameProtocol({ log }).install({ sessionRef: session, ipcMainLike: ipcMain, authorization });
  return { displayMediaSourceHandler };
}

module.exports = { installDefaultSessionWiring, installRemoteFileRequestFilter, isRemoteFileUrl };
