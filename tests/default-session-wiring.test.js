/**
 * services/main/default-session-wiring.js — the app-ready composite that pins
 * the deny-by-default permission guard, the display-media source picker, and
 * the jenny-artifact:// one-shot document protocol on one Electron session.
 * Uses fake session/desktopCapturer/ipcMain seams; the individual owners have
 * their own deep suites (default-session-permission-guard.test.js,
 * display-media-source-handler.test.js, artifact-frame-protocol.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createTrustedSenderAuthorizer, unauthorizedIpcResult } = require('../services/main/ipc-sender-authorization');

const { installDefaultSessionWiring } = require('../services/main/default-session-wiring');

function makeFakeSession() {
  const calls = { permissionRequest: 0, permissionCheck: 0, displayMedia: 0, protocolHandle: [] };
  return {
    calls,
    setPermissionRequestHandler() { calls.permissionRequest += 1; },
    setPermissionCheckHandler() { calls.permissionCheck += 1; },
    setDevicePermissionHandler() {},
    setDisplayMediaRequestHandler() { calls.displayMedia += 1; },
    protocol: {
      handle(scheme) { calls.protocolHandle.push(scheme); },
    },
  };
}

test('installs guard, display-media handler, and artifact protocol on the given session', () => {
  const session = makeFakeSession();
  const ipcChannels = [];
  const logs = [];

  const { displayMediaSourceHandler } = installDefaultSessionWiring({
    session,
    desktopCapturer: { getSources: async () => [] },
    ipcMain: { handle: (channel) => ipcChannels.push(channel) },
    sendBridgeEvent: () => {},
    log: (level, event) => logs.push(event),
  });

  assert.equal(session.calls.permissionRequest, 1, 'permission request handler installed');
  assert.equal(session.calls.displayMedia, 1, 'display-media request handler installed');
  assert.deepEqual(session.calls.protocolHandle, ['jenny-artifact'], 'artifact protocol registered on the session');
  assert.ok(ipcChannels.includes('artifact-frame:stage'), 'artifact staging invoke handler registered');
  assert.ok(logs.includes('session.permission_guard_installed'), 'guard install logged');

  assert.ok(displayMediaSourceHandler, 'display-media handler returned for IPC + shutdown threading');
  assert.equal(typeof displayMediaSourceHandler.resolvePick, 'function');
  assert.equal(typeof displayMediaSourceHandler.dispose, 'function');
  displayMediaSourceHandler.dispose();
});

test('session wiring forwards authorization to artifact staging before storage', (t) => {
  const protocolModule = require('../services/artifact-frame-protocol');
  const instance = protocolModule.createArtifactFrameProtocol();
  t.after(() => instance.dispose());
  t.mock.method(protocolModule, 'createArtifactFrameProtocol', () => instance);
  const wiringPath = require.resolve('../services/main/default-session-wiring');
  const cachedWiring = require.cache[wiringPath];
  delete require.cache[wiringPath];
  t.after(() => { require.cache[wiringPath] = cachedWiring; });
  const wiring = require('../services/main/default-session-wiring');
  const handlers = new Map();
  const url = pathToFileURL(path.resolve(__dirname, '..', 'index.html')).href;
  const mainFrame = { url };
  const webContents = { id: 7, mainFrame, getURL: () => url };
  const mainWindow = { webContents };
  const { displayMediaSourceHandler } = wiring.installDefaultSessionWiring({
    session: makeFakeSession(),
    desktopCapturer: { getSources: async () => [] },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    sendBridgeEvent: () => {},
    log: () => {},
    authorization: {
      authorize: createTrustedSenderAuthorizer({ getMainWindow: () => mainWindow }),
      unauthorizedResult: unauthorizedIpcResult,
    },
  });
  t.after(() => displayMediaSourceHandler.dispose());
  const handler = handlers.get('artifact-frame:stage');
  for (const event of [
    { sender: { id: 8 }, senderFrame: { url } },
    { sender: webContents, senderFrame: { url } },
  ]) {
    assert.deepEqual(handler(event, '<p>blocked</p>'), unauthorizedIpcResult());
  }
  assert.equal(instance.entryCount(), 0);
  assert.equal(handler({ sender: webContents, senderFrame: mainFrame }, '<p>allowed</p>').ok, true);
  assert.equal(instance.entryCount(), 1);
});
