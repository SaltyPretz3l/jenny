'use strict';

// performance.* bridge descriptors and renderer-side bridge (row 59 checkpoint 6). Split
// from ipc-contract.test.js, which sits at the 600-line complexity ratchet.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JENNY_SHELL_BRIDGE_DESCRIPTORS,
  createJennyShellBridge,
  getBridgeChannel,
  listBridgeMethodPaths,
} = require('../services/ipc-contract');

test('performance descriptors pin the three closed-request invokes and the invalidation subscription', () => {
  const expected = {
    'performance.getSnapshot': ['invoke', 'performance:get-snapshot'],
    'performance.updateSettings': ['invoke', 'performance:update-settings'],
    'performance.dismissWarning': ['invoke', 'performance:dismiss-warning'],
    'performance.onChanged': ['subscribe', 'performance:changed'],
  };
  for (const [methodPath, [kind, channel]] of Object.entries(expected)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[methodPath], { kind, channel });
    assert.equal(getBridgeChannel(methodPath, kind), channel);
  }
  assert.deepEqual(
    listBridgeMethodPaths().filter((methodPath) => methodPath.startsWith('performance.')),
    Object.keys(expected).sort(),
    'no pid, command or telemetry-target path is exposed to the renderer'
  );
});

test('performance bridge passes the request through and delivers invalidations until unsubscribed', async () => {
  const calls = [];
  const listeners = new Map();
  const bridge = createJennyShellBridge({ ipcRenderer: {
    invoke: async (...args) => { calls.push(args); return { ok: true }; },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
    send() {},
  } });
  const request = { schema_version: 1, session_id: 'sess_a' };
  await bridge.performance.getSnapshot(request);
  await bridge.performance.updateSettings({ schema_version: 1, show_counter: true });
  await bridge.performance.dismissWarning({ ...request, warning_id: '123e4567-e89b-42d3-a456-426614174000' });
  assert.deepEqual(calls, [
    ['performance:get-snapshot', request],
    ['performance:update-settings', { schema_version: 1, show_counter: true }],
    ['performance:dismiss-warning', { ...request, warning_id: '123e4567-e89b-42d3-a456-426614174000' }],
  ]);
  const seen = [];
  const unsubscribe = bridge.performance.onChanged((event) => seen.push(event));
  assert.equal(typeof unsubscribe, 'function');
  listeners.get('performance:changed')({}, { session_id: 'sess_a', terminal: true, scope: 'inference' });
  assert.deepEqual(seen, [{ session_id: 'sess_a', terminal: true, scope: 'inference' }]);
  unsubscribe();
  assert.equal(listeners.has('performance:changed'), false);
});
