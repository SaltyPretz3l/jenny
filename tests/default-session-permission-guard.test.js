'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ALLOWED_PERMISSIONS,
  buildAllowedSet,
  installDefaultSessionPermissionGuard,
  normalizePermission,
} = require('../services/main/default-session-permission-guard');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { MAIN_DOCUMENT_PATH } = require('../services/main/ipc-sender-authorization');

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

// ── Dictation microphone gate (row 84) ──────────────────────────────────────

const APP_URL = pathToFileURL(MAIN_DOCUMENT_PATH).href;

function createMicHarness({ enabled = true, url = APP_URL } = {}) {
  const webContents = { isDestroyed: () => false, getURL: () => url };
  const mainWindow = { isDestroyed: () => false, webContents };
  const state = { enabled };
  const session = createFakeSession();
  installDefaultSessionPermissionGuard({
    session,
    getMainWindow: () => mainWindow,
    isMicrophoneEnabled: () => state.enabled,
  });
  const request = (details, contents = webContents) => {
    let granted;
    session.permissionRequestHandler(contents, 'media', (value) => { granted = value; }, details);
    return granted;
  };
  const check = (details, contents = webContents) => session.permissionCheckHandler(contents, 'media', 'file:///', details);
  return { session, webContents, mainWindow, state, request, check };
}

const audioFromApp = (extra = {}) => ({ isMainFrame: true, requestingUrl: APP_URL, mediaTypes: ['audio'], ...extra });

test('dictation: an audio request from the app page in the main window is granted', () => {
  const mic = createMicHarness();
  assert.equal(mic.request(audioFromApp()), true);
  assert.equal(mic.check({ isMainFrame: true, requestingUrl: APP_URL, mediaType: 'audio' }), true);
});

test('dictation: the microphone closes as soon as the flag is off', () => {
  const mic = createMicHarness();
  mic.state.enabled = false;
  assert.equal(mic.request(audioFromApp()), false);
  assert.equal(mic.check({ isMainFrame: true, requestingUrl: APP_URL, mediaType: 'audio' }), false);
});

test('dictation: video, mixed or missing media types are denied', () => {
  const mic = createMicHarness();
  for (const mediaTypes of [['video'], ['audio', 'video'], [], undefined, 'audio']) {
    assert.equal(mic.request(audioFromApp({ mediaTypes })), false, `mediaTypes ${JSON.stringify(mediaTypes)}`);
  }
  for (const mediaType of ['video', 'unknown', undefined]) {
    assert.equal(mic.check({ isMainFrame: true, requestingUrl: APP_URL, mediaType }), false, `check ${mediaType}`);
  }
});

test('dictation: subframes, other pages and other webContents are denied', () => {
  const mic = createMicHarness();
  assert.equal(mic.request(audioFromApp({ isMainFrame: false })), false, 'subframe (artifact preview)');
  assert.equal(mic.request(audioFromApp({ requestingUrl: 'jenny-artifact://frame/abc' })), false, 'artifact scheme');
  assert.equal(mic.request(audioFromApp({ requestingUrl: pathToFileURL(path.join(path.dirname(MAIN_DOCUMENT_PATH), 'other.html')).href })), false, 'another local page');
  assert.equal(mic.request(audioFromApp({ requestingUrl: 'https://example.com/' })), false, 'remote page');
  assert.equal(mic.request(audioFromApp(), { isDestroyed: () => false, getURL: () => APP_URL }), false, 'another webContents');
  assert.equal(mic.request(audioFromApp(), null), false, 'no webContents');
});

test('dictation: a main window that navigated away or is gone is denied', () => {
  const navigated = createMicHarness({ url: 'https://example.com/' });
  assert.equal(navigated.request(audioFromApp()), false);
  const gone = createMicHarness();
  gone.mainWindow.isDestroyed = () => true;
  assert.equal(gone.request(audioFromApp()), false);
});

test('dictation: the gate fails closed when its inputs throw or are missing', () => {
  const throwing = createFakeSession();
  installDefaultSessionPermissionGuard({
    session: throwing,
    getMainWindow: () => { throw new Error('boom'); },
    isMicrophoneEnabled: () => true,
  });
  let granted;
  throwing.permissionRequestHandler({}, 'media', (value) => { granted = value; }, audioFromApp());
  assert.equal(granted, false);

  const noGate = createFakeSession();
  installDefaultSessionPermissionGuard({ session: noGate });
  noGate.permissionRequestHandler({}, 'media', (value) => { granted = value; }, audioFromApp());
  assert.equal(granted, false);
});

test('dictation: listing media in a custom allowlist never grants it wholesale', () => {
  const session = createFakeSession();
  installDefaultSessionPermissionGuard({ session, allowedPermissions: ['media'] });
  assert.equal(session.requestPermission('media'), false);
  assert.equal(session.checkPermission('media'), false);
});
