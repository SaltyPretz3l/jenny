'use strict';

/* suggestedChanges.* IPC (row 35): the trusted-sender gate, and the payload
 * shaping the service relies on: a decision from the allowed set, a revision
 * only when it is an integer, force only when it is exactly true. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerSuggestedChangesIpc } = require('../services/main/suggested-changes-ipc-registration');

function setup({ allow = true } = {}) {
  const handlers = new Map();
  const calls = [];
  const service = new Proxy({}, {
    get: (_target, name) => (args) => { calls.push([name, args]); return { ok: true }; },
  });
  registerSuggestedChangesIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    backendService: { suggestedChanges: service },
    authorization: { authorize: () => allow },
  });
  return { calls, invoke: (channel, payload) => handlers.get(channel)({ sender: {} }, payload) };
}

test('accept passes the shown revision and force only when it is exactly true', async () => {
  const f = setup();
  await f.invoke('suggested-changes:accept', { sessionId: 's1', id: 'sc_1', revision: 2, force: true });
  await f.invoke('suggested-changes:accept', { sessionId: 's1', id: 'sc_1', revision: '2', force: 'yes' });
  assert.deepEqual(f.calls, [
    ['accept', { sessionId: 's1', id: 'sc_1', revision: 2, force: true }],
    ['accept', { sessionId: 's1', id: 'sc_1', revision: null, force: false }],
  ]);
});

test('decide accepts ungroup and refuses anything outside the decision set', async () => {
  const f = setup();
  assert.deepEqual(await f.invoke('suggested-changes:decide', { sessionId: 's1', id: 'sc_1', decision: 'ungroup' }), { ok: true });
  assert.deepEqual(await f.invoke('suggested-changes:decide', { sessionId: 's1', id: 'sc_1', decision: 'apply' }), { ok: false, error: 'invalid_decision' });
  assert.deepEqual(f.calls.map(([name, args]) => [name, args.decision]), [['decide', 'ungroup']]);
});

test('an untrusted sender and a missing session reach nothing', async () => {
  const denied = setup({ allow: false });
  assert.equal((await denied.invoke('suggested-changes:accept', { sessionId: 's1', id: 'sc_1', revision: 1 })).ok, false);
  assert.equal(denied.calls.length, 0);
  const f = setup();
  assert.deepEqual(await f.invoke('suggested-changes:list', {}), { ok: false, error: 'invalid_session' });
});
