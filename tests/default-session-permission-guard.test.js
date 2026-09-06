'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ALLOWED_PERMISSIONS,
  buildAllowedSet,
  installDefaultSessionPermissionGuard,
  normalizePermission,
} = require('../services/main/default-session-permission-guard');

// A minimal Electron-Session stand-in that captures the installed handlers so
// tests can drive them directly (mirrors the fake session in
// tests/browser-session-service.test.js).
function createFakeSession() {
  return {
    permissionRequestHandler: null,
    permissionCheckHandler: null,
    devicePermissionHandler: null,
    setPermissionRequestHandler(handler) {
      this.permissionRequestHandler = handler || null;
    },
    setPermissionCheckHandler(handler) {
      this.permissionCheckHandler = handler || null;
    },
    setDevicePermissionHandler(handler) {
      this.devicePermissionHandler = handler || null;
    },
    // Helpers for the assertions below.
    requestPermission(permission) {
      let result;
      this.permissionRequestHandler({}, permission, (granted) => {
        result = granted;
      });
      return result;
    },
    checkPermission(permission) {
      return this.permissionCheckHandler({}, permission);
    },
  };
}

test('an unlisted permission is denied on both request and check', () => {
  const session = createFakeSession();
  const installed = installDefaultSessionPermissionGuard({ session });
  assert.equal(installed, true);

  // The core contract: anything not on the allowlist is denied.
  for (const permission of [
    'media', // camera / microphone
    'geolocation',
    'notifications',
    'midi',
    'midiSysex',
    'hid',
    'serial',
    'usb',
    'openExternal',
    'pointerLock',
    'fullscreen',
    'unknown',
    '',
  ]) {
    assert.equal(
      session.requestPermission(permission),
      false,
      `request for "${permission}" must be denied`
    );
    assert.equal(
      session.checkPermission(permission),
      false,
      `check for "${permission}" must be denied`
    );
  }
});

test('genuinely-needed permissions on the allowlist are granted', () => {
  const session = createFakeSession();
  installDefaultSessionPermissionGuard({ session });

  for (const permission of DEFAULT_ALLOWED_PERMISSIONS) {
    assert.equal(session.requestPermission(permission), true, `request "${permission}" allowed`);
    assert.equal(session.checkPermission(permission), true, `check "${permission}" allowed`);
  }
  // Screen capture + clipboard are exactly what the renderer uses today.
  assert.deepEqual(
    [...DEFAULT_ALLOWED_PERMISSIONS].sort(),
    ['clipboard-read', 'clipboard-sanitized-write', 'display-capture'],
    'allowlist should only cover screen-capture + clipboard'
  );
});

test('the allowlist match is case- and whitespace-insensitive', () => {
  const session = createFakeSession();
  installDefaultSessionPermissionGuard({ session });
  assert.equal(session.requestPermission('  Display-Capture '), true);
  assert.equal(session.checkPermission('CLIPBOARD-READ'), true);
  // ...but a near-miss is still denied.
  assert.equal(session.requestPermission('displaycapture'), false);
});

test('the device permission handler denies all device selection', () => {
  const session = createFakeSession();
  installDefaultSessionPermissionGuard({ session });
  assert.equal(typeof session.devicePermissionHandler, 'function');
  assert.equal(session.devicePermissionHandler({ deviceType: 'hid' }), false);
  assert.equal(session.devicePermissionHandler({ deviceType: 'serial' }), false);
});

test('a denied request is logged (redacted), an allowed one is not', () => {
  const session = createFakeSession();
  const logs = [];
  installDefaultSessionPermissionGuard({
    session,
    log: (level, event, details) => logs.push({ level, event, details }),
  });

  const deniedCount = () => logs.filter((entry) => entry.event === 'session.permission_denied').length;

  session.requestPermission('media');
  const denied = logs.find((entry) => entry.event === 'session.permission_denied');
  assert.ok(denied, 'a denial diagnostic should be emitted');
  assert.equal(denied.details.permission, 'media');
  assert.equal(denied.level, 'WARN');

  // Granting an allowlisted permission must not emit a denial diagnostic.
  const before = deniedCount();
  session.requestPermission('display-capture');
  assert.equal(deniedCount(), before, 'an allowlisted permission must never be logged as denied');
});

test('a custom allowlist is honored; the empty allowlist denies everything', () => {
  const custom = createFakeSession();
  installDefaultSessionPermissionGuard({ session: custom, allowedPermissions: ['geolocation'] });
  assert.equal(custom.requestPermission('geolocation'), true);
  assert.equal(custom.requestPermission('display-capture'), false);

  const locked = createFakeSession();
  installDefaultSessionPermissionGuard({ session: locked, allowedPermissions: [] });
  for (const permission of DEFAULT_ALLOWED_PERMISSIONS) {
    assert.equal(locked.requestPermission(permission), false, `[] allowlist denies "${permission}"`);
  }
});

test('install fails closed (returns false, no throw) on an unusable session', () => {
  assert.equal(installDefaultSessionPermissionGuard({ session: null }), false);
  assert.equal(installDefaultSessionPermissionGuard({ session: {} }), false);
  assert.equal(installDefaultSessionPermissionGuard(), false);
});

test('a session without check/device handlers still installs the request guard', () => {
  // Older/partial Session shims may only expose setPermissionRequestHandler.
  let captured = null;
  const partial = {
    setPermissionRequestHandler(handler) {
      captured = handler;
    },
  };
  const installed = installDefaultSessionPermissionGuard({ session: partial });
  assert.equal(installed, true);
  assert.equal(typeof captured, 'function');
  let granted;
  captured({}, 'media', (value) => {
    granted = value;
  });
  assert.equal(granted, false);
});

test('exported helpers normalize and build the allowlist set', () => {
  assert.equal(normalizePermission('  Media '), 'media');
  const set = buildAllowedSet(['A', ' b ', '']);
  assert.deepEqual([...set].sort(), ['a', 'b']);
  // Non-array falls back to the default allowlist.
  assert.deepEqual([...buildAllowedSet(null)].sort(), [...DEFAULT_ALLOWED_PERMISSIONS].sort());
});
