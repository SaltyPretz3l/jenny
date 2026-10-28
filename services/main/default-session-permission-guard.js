'use strict';

/*
 * default-session-permission-guard.js — deny-by-default web-permission handler
 * for Electron's DEFAULT session (the session the main app window uses).
 *
 * Out of the box Electron GRANTS every renderer permission request — camera,
 * microphone, geolocation, notifications, MIDI-sysex, WebHID / WebSerial /
 * WebUSB device access, and so on. The main window loads local app UI, but the
 * markdown, code, and HTML-artifact previews it renders are authored by the
 * model and the user, i.e. untrusted content running with that same
 * default-allow posture. The isolated browser-tool partition already denies
 * everything it can (services/browser-session-service.js); this module extends
 * the identical deny-by-default stance to session.defaultSession.
 *
 * The handler shapes mirror browser-session-service.js exactly
 * (callback(false) on request, () => false on check/device). Anything the app
 * genuinely needs is opt-in through an explicit allowlist:
 *   - 'display-capture'         — the composer "capture screen" attachment
 *                                 (renderer/features/renderer-attachment-event-utils.js
 *                                 calls navigator.mediaDevices.getDisplayMedia()).
 *   - 'clipboard-read'          — navigator.clipboard.readText() (paste-from-clipboard).
 *   - 'clipboard-sanitized-write' — navigator.clipboard.writeText() (copy actions).
 *
 * Microphone ('media') is never on the allowlist. Dictation (row 84) gets it
 * through a narrower gate instead: while the dictation flag is on, an
 * audio-only request from the main window's own main frame on the app page
 * (index.html) is granted; video, subframes (the jenny-artifact:// preview),
 * other webContents and navigated pages stay denied. Camera, geolocation,
 * notifications, MIDI, and all device access stay DENIED.
 */

const { trustedMainFrameUrl, MAIN_DOCUMENT_PATH } = require('./ipc-sender-authorization');

const MICROPHONE_PERMISSION = 'media';

// Electron's canonical permission strings the main window legitimately uses.
const DEFAULT_ALLOWED_PERMISSIONS = Object.freeze([
  'display-capture',
  'clipboard-read',
  'clipboard-sanitized-write',
]);

function normalizePermission(value) {
  return String(value || '').trim().toLowerCase();
}

function buildAllowedSet(allowedPermissions = DEFAULT_ALLOWED_PERMISSIONS) {
  const list = Array.isArray(allowedPermissions)
    ? allowedPermissions
    : DEFAULT_ALLOWED_PERMISSIONS;
  return new Set(list.map(normalizePermission).filter(Boolean));
}

function onlyAudio(mediaTypes) {
  return Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio');
}

/*
 * The dictation gate. `mediaTypes` is the request's details.mediaTypes, or the
 * check's single details.mediaType wrapped in an array. Fails closed on any throw.
 */
function isTrustedMicrophoneRequest({ webContents, details, mediaTypes, getMainWindow, isMicrophoneEnabled, documentPath }) {
  try {
    if (typeof isMicrophoneEnabled !== 'function' || isMicrophoneEnabled() !== true) return false;
    if (!onlyAudio(mediaTypes)) return false;
    const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (!mainWindow || mainWindow.isDestroyed?.() === true) return false;
    const expected = mainWindow.webContents;
    if (!expected || !webContents || webContents !== expected || expected.isDestroyed?.() === true) return false;
    if (details?.isMainFrame !== true) return false;
    return trustedMainFrameUrl(details.requestingUrl, documentPath)
      && trustedMainFrameUrl(expected.getURL?.(), documentPath);
  } catch (_error) {
    return false;
  }
}

/**
 * Install the deny-by-default permission handlers on an Electron session.
 *
 * @param {object} options
 * @param {object} options.session               An Electron Session (e.g. session.defaultSession).
 * @param {string[]} [options.allowedPermissions] Explicit allowlist; defaults to
 *   DEFAULT_ALLOWED_PERMISSIONS. Pass [] to deny everything.
 * @param {function(string,string,object=):void} [options.log] Redacted logger.
 * @param {function():object|null} [options.getMainWindow] The main BrowserWindow, for the dictation gate.
 * @param {function():boolean} [options.isMicrophoneEnabled] True while the dictation flag is on.
 * @param {string} [options.expectedDocumentPath] The app page the microphone request must come from.
 * @returns {boolean} true if the guard was installed, false if the session was unusable.
 */
function installDefaultSessionPermissionGuard({
  session,
  allowedPermissions = DEFAULT_ALLOWED_PERMISSIONS,
  log = () => {},
  getMainWindow = null,
  isMicrophoneEnabled = null,
  expectedDocumentPath = MAIN_DOCUMENT_PATH,
} = {}) {
  const targetSession =
    session && typeof session.setPermissionRequestHandler === 'function' ? session : null;
  if (!targetSession) {
    return false;
  }

  const allowed = buildAllowedSet(allowedPermissions);
  allowed.delete(MICROPHONE_PERMISSION);
  const isAllowed = (permission) => allowed.has(normalizePermission(permission));
  const microphoneGate = (webContents, details, mediaTypes) => isTrustedMicrophoneRequest({
    webContents, details, mediaTypes, getMainWindow, isMicrophoneEnabled, documentPath: expectedDocumentPath,
  });

  targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const granted = isAllowed(permission)
      || (normalizePermission(permission) === MICROPHONE_PERMISSION && microphoneGate(webContents, details, details?.mediaTypes));
    if (!granted) {
      // Redaction (AGENTS.md §7): the permission name is not sensitive, but keep
      // it bounded and log nothing else about the requesting page.
      log('WARN', 'session.permission_denied', {
        permission: normalizePermission(permission).slice(0, 80),
        surface: 'request',
      });
    }
    if (typeof callback === 'function') {
      callback(granted);
    }
  });

  if (typeof targetSession.setPermissionCheckHandler === 'function') {
    targetSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => isAllowed(permission)
      || (normalizePermission(permission) === MICROPHONE_PERMISSION
        && microphoneGate(webContents, details, details?.mediaType ? [details.mediaType] : [])));
  }

  if (typeof targetSession.setDevicePermissionHandler === 'function') {
    // WebHID / WebSerial / WebUSB device selection — nothing is ever device-permitted.
    targetSession.setDevicePermissionHandler(() => false);
  }

  log('INFO', 'session.permission_guard_installed', {
    allowed: Array.from(allowed).sort(),
  });
  return true;
}

module.exports = {
  DEFAULT_ALLOWED_PERMISSIONS,
  buildAllowedSet,
  installDefaultSessionPermissionGuard,
  isTrustedMicrophoneRequest,
  normalizePermission,
};
