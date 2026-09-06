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
 * Microphone / camera ('media'), geolocation, notifications, MIDI, and all
 * device access stay DENIED — no feature uses them today. Add 'media' here only
 * when a real voice/video feature exists (and prefer the narrowest string that
 * covers it).
 */

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

/**
 * Install the deny-by-default permission handlers on an Electron session.
 *
 * @param {object} options
 * @param {object} options.session               An Electron Session (e.g. session.defaultSession).
 * @param {string[]} [options.allowedPermissions] Explicit allowlist; defaults to
 *   DEFAULT_ALLOWED_PERMISSIONS. Pass [] to deny everything.
 * @param {function(string,string,object=):void} [options.log] Redacted logger.
 * @returns {boolean} true if the guard was installed, false if the session was unusable.
 */
function installDefaultSessionPermissionGuard({
  session,
  allowedPermissions = DEFAULT_ALLOWED_PERMISSIONS,
  log = () => {},
} = {}) {
  const targetSession =
    session && typeof session.setPermissionRequestHandler === 'function' ? session : null;
  if (!targetSession) {
    return false;
  }

  const allowed = buildAllowedSet(allowedPermissions);
  const isAllowed = (permission) => allowed.has(normalizePermission(permission));

  targetSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const granted = isAllowed(permission);
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
    targetSession.setPermissionCheckHandler((_webContents, permission) => isAllowed(permission));
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
  normalizePermission,
};
