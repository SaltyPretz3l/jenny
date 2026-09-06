'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  installPluginViewSessionPolicy,
  clearPluginViewSession,
} = require('../../../services/main/plugin-view-session-policy');

const DIGEST = 'a'.repeat(64);

test('the isolated session denies permissions, downloads, files, and cross-digest requests', async () => {
  const calls = [];
  const session = {
    setPermissionCheckHandler(fn) { assert.equal(fn(), false); },
    setPermissionRequestHandler(fn) { fn(null, 'camera', (allowed) => assert.equal(allowed, false)); },
    setDevicePermissionHandler(fn) { assert.equal(fn(), false); },
    setDisplayMediaRequestHandler(fn) { fn({}, (value) => assert.deepEqual(value, {})); },
    setFileSystemAccessRequestHandler(fn) { fn(null, {}, (value) => assert.equal(value, 'deny')); },
    webRequest: { onBeforeRequest(fn) { this.handler = fn; } },
    on(name, fn) { if (name === 'will-download') { const event = { preventDefault: () => calls.push('download') }; fn(event); } },
    clearData: async (options) => calls.push(['data', options]),
    clearStorageData: async () => calls.push('storage'),
    clearCache: async () => calls.push('cache'),
    closeAllConnections: async () => calls.push('connections'),
  };
  installPluginViewSessionPolicy(session, DIGEST);
  const allowed = (url) => new Promise((resolve) => session.webRequest.handler({ url }, ({ cancel }) => resolve(!cancel)));
  assert.equal(await allowed(`jenny-plugin-view://${DIGEST}/view/index.html`), true);
  assert.equal(await allowed(`jenny-plugin-view://${'b'.repeat(64)}/view/index.html`), false);
  assert.equal(await allowed('https://example.test/'), false);
  await clearPluginViewSession(session);
  assert.deepEqual(calls, [
    'download',
    ['data', { dataTypes: [
      'cookies', 'fileSystems', 'indexedDB', 'localStorage', 'serviceWorkers', 'cache',
    ] }],
    'storage',
    'cache',
    'connections',
  ]);
});
