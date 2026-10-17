'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerConversationTransfer } = require('../services/main/conversation-transfer-registration');
const { getBridgeChannel } = require('../services/ipc-contract');

test('all transfer IPC is sender-gated and returns bounded errors without source/provider details', async () => {
  const handlers = new Map();
  let calls = 0;
  const registration = registerConversationTransfer({ handle: (name, fn) => handlers.set(name, fn) }, {
    backendService: {}, service: { list: async () => { calls += 1; throw Error('secret provider diagnostics'); }, dispose: async () => {} },
    authorization: { authorize: (event) => event?.trusted === true },
  });
  assert.equal(handlers.size, 5);
  const handler = handlers.get(getBridgeChannel('conversationTransfer.list'));
  assert.equal((await handler({ trusted: false }, { source: 'codex' })).authorized, false);
  assert.equal(calls, 0);
  const failed = await handler({ trusted: true }, { source: 'codex' });
  assert.equal(failed.reason, 'transfer_failed');
  assert.ok(!JSON.stringify(failed).includes('secret'));
  await registration.dispose();
});

test('open only uses the service-owned destination identity', async () => {
  const handlers = new Map();
  const urls = [];
  const id = '12345678-1234-1234-1234-123456789abc';
  registerConversationTransfer({ handle: (name, fn) => handlers.set(name, fn) }, {
    backendService: {}, authorization: { authorize: () => true }, openExternal: async (url) => urls.push(url),
    service: { open: async () => ({ ok: true, destination: 'codex', destinationId: id }) },
  });
  const result = await handlers.get(getBridgeChannel('conversationTransfer.open'))({}, { operationId: 'saved', url: 'malicious:' });
  assert.equal(result.ok, true);
  assert.deepEqual(urls, ['codex://threads/' + id]);
});
