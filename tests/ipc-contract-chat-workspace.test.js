'use strict';

// Row 59 chat workspace bridges (chatWorkspace, sessionProposals, chatMessages),
// split out of ipc-contract.test.js at the 600-line test ratchet.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JENNY_SHELL_BRIDGE_DESCRIPTORS,
  createJennyShellBridge,
  getBridgeChannel,
  listBridgeMethodPaths,
} = require('../services/ipc-contract');

test('chatWorkspace descriptors pin the four closed-request invokes and the invalidation subscription', () => {
  const expected = {
    'chatWorkspace.getSummary': ['invoke', 'chat-workspace:get-summary'],
    'chatWorkspace.setView': ['invoke', 'chat-workspace:set-view'],
    'chatWorkspace.listChanges': ['invoke', 'chat-workspace:list-changes'],
    'chatWorkspace.getChangeDiff': ['invoke', 'chat-workspace:get-change-diff'],
    'chatWorkspace.onChanged': ['subscribe', 'chat-workspace:changed'],
  };
  for (const [methodPath, [kind, channel]] of Object.entries(expected)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[methodPath], { kind, channel });
    assert.equal(getBridgeChannel(methodPath, kind), channel);
  }
  assert.deepEqual(
    listBridgeMethodPaths().filter((methodPath) => methodPath.startsWith('chatWorkspace.')),
    Object.keys(expected).sort(),
    'no other chatWorkspace path (a filesystem-shaped one in particular) is exposed'
  );
});

test('chatWorkspace bridge passes the request through and delivers invalidations until unsubscribed', async () => {
  const calls = [];
  const listeners = new Map();
  const bridge = createJennyShellBridge({ ipcRenderer: {
    invoke: async (...args) => { calls.push(args); return { schema_version: 1, ok: true }; },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
    send() {},
  } });
  const request = { schema_version: 1, session_id: 'sess_a' };
  await bridge.chatWorkspace.getSummary(request);
  await bridge.chatWorkspace.getChangeDiff({ ...request, path: 'a.txt' });
  assert.deepEqual(calls, [
    ['chat-workspace:get-summary', request],
    ['chat-workspace:get-change-diff', { ...request, path: 'a.txt' }],
  ]);
  const seen = [];
  const unsubscribe = bridge.chatWorkspace.onChanged((event) => seen.push(event));
  assert.equal(typeof unsubscribe, 'function');
  listeners.get('chat-workspace:changed')({}, { schema_version: 1, session_id: 'sess_a', revision: 3 });
  assert.deepEqual(seen, [{ schema_version: 1, session_id: 'sess_a', revision: 3 }]);
  unsubscribe();
  assert.equal(listeners.has('chat-workspace:changed'), false);
});

test('sessionProposals descriptors pin the ten closed-request invokes and the invalidation subscription', () => {
  const expected = {
    'sessionProposals.get': ['invoke', 'session-proposals:get'],
    'sessionProposals.list': ['invoke', 'session-proposals:list'],
    'sessionProposals.decide': ['invoke', 'session-proposals:decide'],
    'sessionProposals.cancel': ['invoke', 'session-proposals:cancel'],
    'sessionProposals.retry': ['invoke', 'session-proposals:retry'],
    'sessionProposals.getCapabilities': ['invoke', 'session-proposals:get-capabilities'],
    'sessionProposals.setOptions': ['invoke', 'session-proposals:set-options'],
    'sessionProposals.startAll': ['invoke', 'session-proposals:start-all'],
    'sessionProposals.confirmRestored': ['invoke', 'session-proposals:confirm-restored'],
    'sessionProposals.authorizeLaunch': ['invoke', 'session-proposals:authorize-launch'],
    'sessionProposals.onChanged': ['subscribe', 'session-proposals:changed'],
  };
  for (const [methodPath, [kind, channel]] of Object.entries(expected)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[methodPath], { kind, channel });
    assert.equal(getBridgeChannel(methodPath, kind), channel);
  }
  assert.deepEqual(
    listBridgeMethodPaths().filter((methodPath) => methodPath.startsWith('sessionProposals.')),
    Object.keys(expected).sort(),
    'no other sessionProposals path is exposed'
  );
});

test('chatMessages descriptors pin the thirteen closed-request invokes and the invalidation subscription', () => {
  const expected = {
    'chatMessages.listRecipients': ['invoke', 'chat-messages:list-recipients'],
    'chatMessages.prepare': ['invoke', 'chat-messages:prepare'],
    'chatMessages.send': ['invoke', 'chat-messages:send'],
    'chatMessages.retry': ['invoke', 'chat-messages:retry'],
    'chatMessages.cancel': ['invoke', 'chat-messages:cancel'],
    'chatMessages.list': ['invoke', 'chat-messages:list'],
    'chatMessages.markRead': ['invoke', 'chat-messages:mark-read'],
    'chatMessages.setContextDisposition': ['invoke', 'chat-messages:set-context-disposition'],
    'chatMessages.discard': ['invoke', 'chat-messages:discard'],
    'chatMessages.confirmRestored': ['invoke', 'chat-messages:confirm-restored'],
    'chatMessages.createGrant': ['invoke', 'chat-messages:create-grant'],
    'chatMessages.revokeGrant': ['invoke', 'chat-messages:revoke-grant'],
    'chatMessages.setReporting': ['invoke', 'chat-messages:set-reporting'],
    'chatMessages.onChanged': ['subscribe', 'chat-messages:changed'],
  };
  for (const [methodPath, [kind, channel]] of Object.entries(expected)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[methodPath], { kind, channel });
    assert.equal(getBridgeChannel(methodPath, kind), channel);
  }
  assert.deepEqual(
    listBridgeMethodPaths().filter((methodPath) => methodPath.startsWith('chatMessages.')),
    Object.keys(expected).sort(),
    'no other chatMessages path is exposed'
  );
});

test('chatMessages bridge passes the request through and delivers invalidations until unsubscribed', async () => {
  const calls = []; const listeners = new Map();
  const bridge = createJennyShellBridge({ ipcRenderer: {
    invoke: async (...args) => { calls.push(args); return { schema_version: 1, ok: true }; },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
    send() {},
  } });
  const request = { schema_version: 1, operation_id: '11111111-1111-4111-8111-111111111111' };
  await bridge.chatMessages.send(request);
  await bridge.chatMessages.setContextDisposition({ ...request, disposition: 'queued' });
  assert.deepEqual(calls, [
    ['chat-messages:send', request],
    ['chat-messages:set-context-disposition', { ...request, disposition: 'queued' }],
  ]);
  const seen = [];
  const unsubscribe = bridge.chatMessages.onChanged((event) => seen.push(event));
  listeners.get('chat-messages:changed')({}, { schema_version: 1, session_id: 'sess_a', revision: 3 });
  assert.deepEqual(seen, [{ schema_version: 1, session_id: 'sess_a', revision: 3 }]);
  unsubscribe();
  assert.equal(listeners.has('chat-messages:changed'), false);
});

test('sessionProposals bridge passes the request through and delivers invalidations until unsubscribed', async () => {
  const calls = [];
  const listeners = new Map();
  const bridge = createJennyShellBridge({ ipcRenderer: {
    invoke: async (...args) => { calls.push(args); return { schema_version: 1, ok: true }; },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel); },
    send() {},
  } });
  const request = { schema_version: 1, session_id: 'sess_a', proposal_id: `proposal_${'a'.repeat(64)}` };
  await bridge.sessionProposals.get(request);
  await bridge.sessionProposals.getCapabilities(request);
  assert.deepEqual(calls, [
    ['session-proposals:get', request],
    ['session-proposals:get-capabilities', request],
  ]);
  const seen = [];
  const unsubscribe = bridge.sessionProposals.onChanged((event) => seen.push(event));
  listeners.get('session-proposals:changed')({}, { schema_version: 1, session_id: 'sess_a', revision: 3 });
  assert.deepEqual(seen, [{ schema_version: 1, session_id: 'sess_a', revision: 3 }]);
  unsubscribe();
  assert.equal(listeners.has('session-proposals:changed'), false);
});
