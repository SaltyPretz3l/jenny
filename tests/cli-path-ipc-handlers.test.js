'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerCliPathIpcHandlers } = require('../services/main/cli-path-ipc-handlers');
const { getBridgeChannel, listBridgeMethodPaths } = require('../services/ipc-contract');

test('the cli.path contract is exactly three invoke methods', () => {
  assert.deepEqual(listBridgeMethodPaths().filter((methodPath) => methodPath.startsWith('cli.')),
    ['cli.path.getState', 'cli.path.install', 'cli.path.remove']);
  assert.equal(getBridgeChannel('cli.path.getState', 'invoke'), 'cli:path:get-state');
  assert.equal(getBridgeChannel('cli.path.install', 'invoke'), 'cli:path:install');
  assert.equal(getBridgeChannel('cli.path.remove', 'invoke'), 'cli:path:remove');
});

test('cli.path handlers deny untrusted senders and never pass renderer arguments to the service', async () => {
  const handlers = new Map();
  const calls = [];
  const service = {
    getState: (...args) => { calls.push(['getState', args]); return { ok: true, onPath: false }; },
    install: (...args) => { calls.push(['install', args]); return { ok: true, changed: true }; },
    remove: (...args) => { calls.push(['remove', args]); return { ok: true, changed: false }; },
  };
  const channels = registerCliPathIpcHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    service,
    authorization: { authorize: (event) => event?.trusted === true },
  });
  assert.deepEqual(channels.sort(), ['cli:path:get-state', 'cli:path:install', 'cli:path:remove']);

  assert.equal(handlers.get('cli:path:install')({ trusted: false }).authorized, false);
  assert.equal(calls.length, 0);

  assert.deepEqual(await handlers.get('cli:path:get-state')({ trusted: true }, { binDir: 'C:\\evil' }), { ok: true, onPath: false });
  assert.deepEqual(await handlers.get('cli:path:install')({ trusted: true }, 'C:\\evil'), { ok: true, changed: true });
  assert.deepEqual(await handlers.get('cli:path:remove')({ trusted: true }, { path: 'x' }), { ok: true, changed: false });
  assert.deepEqual(calls, [['getState', []], ['install', []], ['remove', []]]);
});

test('no service means nothing is registered', () => {
  const handlers = new Map();
  assert.deepEqual(registerCliPathIpcHandlers({ handle: (channel, fn) => handlers.set(channel, fn) }, {}), []);
  assert.equal(handlers.size, 0);
});
