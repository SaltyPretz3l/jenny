'use strict';

/* chatMessages.* IPC registration and desktop composition (row 59 checkpoint 4):
 * the descriptor-backed channels, the trusted-sender gate, raw-payload forwarding to
 * the service-owned closed schema, the failure envelope when the service is absent
 * or throws, the admission-reconcile adapter and the live wiring against a
 * backend-shaped object (rail invalidation, bridge event, startup reconciliation). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { registerChatMessagingIpc, METHODS } = require('../services/main/chat-messaging-ipc-registration');
const { createAdmissionReconciler } = require('../services/chat-messaging-wiring');
const { JENNY_SHELL_BRIDGE_DESCRIPTORS } = require('../services/ipc-contract');
const { MESSAGE_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const mailFixtures = require('./helpers/session-mail-fixtures');
const { createFixture } = require('./helpers/chat-messaging-service-fixture');

const CHANNELS = {
  listRecipients: 'chat-messages:list-recipients',
  prepare: 'chat-messages:prepare',
  send: 'chat-messages:send',
  retry: 'chat-messages:retry',
  cancel: 'chat-messages:cancel',
  list: 'chat-messages:list',
  markRead: 'chat-messages:mark-read',
  setContextDisposition: 'chat-messages:set-context-disposition',
  discard: 'chat-messages:discard',
  confirmRestored: 'chat-messages:confirm-restored',
  createGrant: 'chat-messages:create-grant',
  revokeGrant: 'chat-messages:revoke-grant',
  setReporting: 'chat-messages:set-reporting',
};
const ADMISSION_MODULE = path.resolve(__dirname, '../services/backend/session-mail-admission.js');

function register({ allow = true, service } = {}) {
  const handlers = new Map();
  registerChatMessagingIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    backendService: { chatMessages: service },
    authorization: { authorize: () => allow },
  });
  return { handlers, invoke: (channel, payload) => handlers.get(channel)({ sender: {} }, payload) };
}

test('exactly the thirteen descriptor-backed invoke channels are registered, and onChanged is a subscription', () => {
  const { handlers } = register({ service: {} });
  assert.deepEqual([...handlers.keys()].sort(), Object.values(CHANNELS).sort());
  assert.equal(Object.keys(METHODS).length, 13);
  for (const [method, channel] of Object.entries(CHANNELS)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[`chatMessages.${method}`], { kind: 'invoke', channel });
  }
  assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS['chatMessages.onChanged'], { kind: 'subscribe', channel: 'chat-messages:changed' });
});

test('an untrusted sender reaches no service method', async () => {
  const calls = [];
  const service = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, args]); return { ok: true }; } });
  const denied = register({ allow: false, service });
  for (const channel of Object.values(CHANNELS)) {
    const result = await denied.invoke(channel, { schema_version: 1 });
    assert.equal(result.ok, false);
    assert.notEqual(result.schema_version, 1);
  }
  assert.equal(calls.length, 0);
});

test('payloads reach the service raw and its envelope returns unchanged', async () => {
  const calls = [];
  const service = Object.fromEntries(Object.values(METHODS).map((name) => [name, async (raw) => {
    calls.push([name, raw]);
    return { schema_version: 1, ok: true };
  }]));
  const { invoke } = register({ service });
  const hostile = { schema_version: 1, operation_id: '../../x', extra: { deep: [1] } };
  assert.deepEqual(await invoke(CHANNELS.send, hostile), { schema_version: 1, ok: true });
  await invoke(CHANNELS.createGrant, undefined);
  assert.deepEqual(calls.map(([name]) => name), ['send', 'createGrant']);
  assert.equal(calls[0][1], hostile, 'no coercion or copying before the service validates');
});

test('a missing service and a throwing service answer the common failure envelope without exception text', async () => {
  const expected = {
    schema_version: 1, ok: false, error_code: CODES.UNAVAILABLE, reason: 'unavailable', retryable: false, current_revision: null,
  };
  assert.deepEqual(await register({ service: undefined }).invoke(CHANNELS.send, {}), expected);
  const throwing = { send: async () => { throw new Error('secret path C:\\Users\\x'); } };
  const result = await register({ service: throwing }).invoke(CHANNELS.send, {});
  assert.deepEqual(result, expected);
  assert.doesNotMatch(JSON.stringify(result), /secret|Users/u);
});

test('the service composes against a backend-shaped object: send over IPC, bridge event, rail invalidation, startup reconcile', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('Source');
  const dst = f.sessionId('Dest');
  const { invoke } = register({ service: f.service });
  const prepared = await invoke(CHANNELS.prepare, {
    schema_version: 1, source_session_id: src, destination_session_id: dst, body: 'over the wire', gesture_id: f.gesture(),
  });
  assert.equal(prepared.ok, true);
  assert.equal(f.events.length > 0, true);
  const sent = await invoke(CHANNELS.send, { schema_version: 1, operation_id: prepared.operation_id });
  assert.equal(sent.operation.state, 'delivered');
  const list = await invoke(CHANNELS.list, { schema_version: 1, session_id: dst, direction: 'inbox' });
  assert.equal(list.items[0].envelope.body, 'over the wire');
  assert.equal(list.counts.unread, 1);
  assert.ok(f.events.some((event) => event.session_id === dst), 'the bridge event announces the destination');
  assert.ok(f.coordination.includes(dst), 'the session rail is invalidated for the destination');
  const reread = await invoke(CHANNELS.markRead, { schema_version: 1, session_id: dst, message_ids: [list.items[0].message_id] });
  assert.equal(reread.updated_count, 1);
  assert.doesNotThrow(() => f.service.reconcileOnStartup());
});

test('the admission reconcile adapter is a logged no-op when the module or export is missing', (t) => {
  const logs = [];
  const backend = { sessionStore: {} };
  const original = require.cache[ADMISSION_MODULE];
  t.after(() => {
    if (original) require.cache[ADMISSION_MODULE] = original;
    else delete require.cache[ADMISSION_MODULE];
  });
  // Present module without the export: skipped, warned once.
  require.cache[ADMISSION_MODULE] = { id: ADMISSION_MODULE, filename: ADMISSION_MODULE, loaded: true, exports: {} };
  if (fs.existsSync(ADMISSION_MODULE)) {
    const reconcile = createAdmissionReconciler(backend, (...args) => logs.push(args));
    assert.equal(reconcile('sess_a'), false);
    assert.equal(reconcile('sess_a'), false);
    assert.deepEqual(logs.map((entry) => [entry[1], entry[2]]), [['chat_messaging.admission_reconcile_unavailable', { reason: 'export_missing' }]]);
    // The export is called with the object form and a changed-count result raises the invalidation hint.
    const calls = [];
    require.cache[ADMISSION_MODULE].exports = {
      reconcileAdmissionSnapshots: (args) => { calls.push(args); return { finalized: 1, released: 0 }; },
    };
    assert.equal(createAdmissionReconciler(backend, () => {})('sess_a'), true);
    assert.deepEqual(calls, [{ sessionStore: backend.sessionStore, sessionId: 'sess_a' }]);
    require.cache[ADMISSION_MODULE].exports = { reconcileAdmissionSnapshots: () => ({ finalized: 0, released: 0 }) };
    assert.equal(createAdmissionReconciler(backend, () => {})('sess_a'), false);
  }
});

test('startup reconciliation hands a reserved snapshot to the real admission module, which releases it to queued', async (t) => {
  if (!fs.existsSync(ADMISSION_MODULE)) { t.skip('session-mail-admission is not present'); return; }
  const f = createFixture(t);
  // Re-compose with the real admission adapter instead of the fixture's recording fake.
  const { createChatMessagingService } = require('../services/chat-messaging-wiring');
  const service = createChatMessagingService({ backendService: f.backend, scheduleReconcile: false, serviceOptions: { notifierOptions: { intervalMs: 0 } } });
  t.after(() => service.dispose());
  const dst = f.sessionId('Dest');
  const snapshot = mailFixtures.makeSnapshot(1, { state: 'reserved', turn_id: 'turn_1' });
  const record = mailFixtures.makeInbox(1, {
    context: { state: 'reserved', turn_id: 'turn_1', snapshot_id: snapshot.snapshot_id },
  }, { destination: { session_id: dst } });
  f.store._updateSessionRecord(dst, {
    session_mail: { ...mailFixtures.emptyMail(), next_receive_sequence: 2, inbox: [record], admission_snapshots: [snapshot] },
    coordination_revision: 1,
  }, { bumpUpdatedAt: false });
  service.reconcileOnStartup();
  assert.equal(f.mail(dst).inbox[0].context.state, 'queued', 'no context row exists, so the reservation is released');
});
