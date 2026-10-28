'use strict';

// Mid-turn mail (row 70 W2a): reserve -> push -> consume -> settle/finish or release.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { createSessionMailStore } = require('../services/backend/session-mail-store');
const { SidecarClient } = require('../services/backend/sidecar-client');
const { ESTIMATOR_ID, reserveMidTurnMail } = require('../services/backend/session-mail-admission');
const {
  acceptMailConsumedNotification, attachMidTurnMail, finishMidTurnMail, markConsumed, pushMidTurnMail,
  releaseMidTurnMailForStream, settleMidTurnMail,
} = require('../services/backend/session-mail-mid-turn');
const F = require('./helpers/session-mail-fixtures');

const ACK = { schema_version: 1, producer_tools: [], context_kinds: ['session_message'], session_messages: true, mid_turn_mail: true };

async function negotiatedClient(capabilities = ACK) {
  const client = new SidecarClient();
  client.process = {};
  client.request = async () => ({ runtime_inference_admission_version: 1, chat_workspace_version: 1, chat_workspace_capabilities: capabilities });
  await client.initialize();
  client.sent = [];
  client.notifySessionMailArrived = (params) => {
    client.sent.push(params);
    return client.sendResult !== false;
  };
  return client;
}

async function setup(t, { inbox = [F.makeInbox(1), F.makeInbox(2), F.makeInbox(3)], capabilities } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mail-mid-turn-'));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
  t.after(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const session = store.createSession({ title: 'Destination' });
  const mailStore = createSessionMailStore(store);
  assert.equal(mailStore.mutate(session.id, ({ mail }) => ({
    mail: { ...mail, inbox: [...mail.inbox, ...inbox], next_receive_sequence: Math.max(mail.next_receive_sequence, ...inbox.map((r) => r.receive_sequence + 1)) },
  })).ok, true);
  const logs = [];
  const notified = [];
  const sidecarClient = await negotiatedClient(capabilities);
  store.getActiveTurn = (id) => (id === session.id ? { request_id: 'stream_1', stream_id: 'stream_1', turn_id: 'turn_1' } : null);
  const service = {
    sessionStore: store,
    sidecarClient,
    activeStreams: new Map([['stream_1', {}]]),
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    chatMessages: { notify: (id) => notified.push(id) },
  };
  const ctx = { service, resolvedSessionId: session.id, streamId: 'stream_1', turnId: 'turn_1' };
  attachMidTurnMail(ctx);
  const mail = () => mailStore.read(session.id).mail;
  const states = () => mail().inbox.map((record) => record.context.state);
  return { store, id: session.id, service, ctx, logs, notified, mail, states, sidecarClient };
}

const ids = (...ns) => ns.map((n) => F.uuid(n));

test('reserve: exactly the named queued records under one reserved snapshot, rows built for the turn', async (t) => {
  const env = await setup(t, { inbox: [F.makeInbox(1), F.makeInbox(2), F.makeInbox(3, { context: { state: 'excluded_by_user', changed_at: F.iso() } })] });
  const reserved = reserveMidTurnMail({ sessionStore: env.store, sessionId: env.id, turnId: 'turn_1', messageIds: ids(2, 1, 3, 9), now: F.iso(5000) });
  assert.equal(reserved.ok, true);
  assert.deepEqual(reserved.rows.map((row) => row.id), [`ctx_${F.uuid(1)}`, `ctx_${F.uuid(2)}`], 'FIFO; non-queued and unknown ids skipped');
  assert.ok(reserved.rows.every((row) => row.role === 'context' && row.turn_id === 'turn_1' && row.kind === 'session_message'));
  assert.deepEqual(env.states(), ['reserved', 'reserved', 'excluded_by_user']);
  const snapshot = env.mail().admission_snapshots.find((entry) => entry.snapshot_id === reserved.snapshot_id);
  assert.equal(snapshot.state, 'reserved');
  assert.equal(snapshot.turn_id, 'turn_1');
  assert.equal(snapshot.cutoff_receive_sequence, 2);
  assert.equal(snapshot.deferred_count, 0);
  assert.equal(snapshot.deferred_reason, null);
  assert.equal(snapshot.estimator_id, ESTIMATOR_ID);
  assert.deepEqual(snapshot.entries.map((entry) => entry.message_id), ids(1, 2));
  assert.equal(env.store.getSession(env.id).messages.some((m) => m.role === 'context'), false, 'nothing enters the transcript yet');
  const none = reserveMidTurnMail({ sessionStore: env.store, sessionId: env.id, turnId: 'turn_1', messageIds: ids(1, 2) });
  assert.deepEqual([none.ok, none.reason], [false, 'nothing_queued']);
});

test('push without the negotiated capability is refused and reserves nothing', async (t) => {
  const { mid_turn_mail: _omitted, ...withoutMidTurn } = ACK;
  const env = await setup(t, { capabilities: withoutMidTurn });
  assert.deepEqual(pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1) }), { ok: false, reason: 'unsupported' });
  assert.deepEqual(env.states(), ['queued', 'queued', 'queued']);
  assert.equal(env.sidecarClient.sent.length, 0);
});

test('push without a live managed turn is refused', async (t) => {
  const env = await setup(t);
  env.service.activeStreams.clear();
  assert.equal(pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1) }).reason, 'no_active_managed_turn');
  env.service.activeStreams.set('stream_1', {});
  env.store.getActiveTurn = () => ({ request_id: 'stream_2', stream_id: 'stream_2' });
  assert.equal(pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1) }).reason, 'no_active_managed_turn');
  assert.equal(pushMidTurnMail(env.service, { sessionId: 'other', messageIds: ids(1) }).reason, 'no_active_managed_turn');
  assert.deepEqual(env.states(), ['queued', 'queued', 'queued']);
});

test('push sends {session_id, request_id, rows} through the client and records the reservation', async (t) => {
  const env = await setup(t);
  const pushed = pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1, 2) });
  assert.equal(pushed.ok, true);
  assert.deepEqual(pushed.message_ids, ids(1, 2));
  assert.equal(env.sidecarClient.sent.length, 1);
  const [params] = env.sidecarClient.sent;
  assert.deepEqual(Object.keys(params).sort(), ['requestId', 'rows', 'sessionId']);
  assert.equal(params.sessionId, env.id);
  assert.equal(params.requestId, 'stream_1');
  assert.deepEqual(params.rows.map((row) => Object.keys(row).sort()), [
    ['content', 'kind', 'role', 'session_message'], ['content', 'kind', 'role', 'session_message']]);
  assert.equal(params.rows[0].content, 'hello 1');
  assert.ok(env.ctx.midTurnMail.reserved.has(pushed.snapshot_id));
  assert.deepEqual(env.states(), ['reserved', 'reserved', 'queued']);
  assert.ok(env.notified.includes(env.id));
  assert.ok(env.logs.every((entry) => !JSON.stringify(entry.details).includes('hello')), 'no body in diagnostics');
});

test('a send failure releases the reservation and refuses transport_unavailable', async (t) => {
  const env = await setup(t);
  env.sidecarClient.sendResult = false;
  assert.deepEqual(pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1) }), { ok: false, reason: 'transport_unavailable' });
  assert.deepEqual(env.states(), ['queued', 'queued', 'queued']);
  assert.equal(env.mail().admission_snapshots.length, 0);
  assert.equal(env.ctx.midTurnMail.reserved.size, 0);
});

test('consume then settle: rows in reservation order, finalized included with ctx_ canonical ids', async (t) => {
  const env = await setup(t);
  pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1, 2) });
  pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(3) });
  assert.equal(acceptMailConsumedNotification(env.ctx, { message_ids: ids(3, 2, 1) }), 3);
  const settled = settleMidTurnMail(env.ctx);
  assert.deepEqual(settled.rows.map((row) => row.id), [`ctx_${F.uuid(1)}`, `ctx_${F.uuid(2)}`, `ctx_${F.uuid(3)}`]);
  assert.deepEqual(env.states(), ['reserved', 'reserved', 'reserved'], 'finalized only after a durable settle');
  finishMidTurnMail(env.ctx, { handled: true, result: { durableTerminal: true } }, { now: F.iso(9000) });
  const mail = env.mail();
  assert.deepEqual(mail.inbox.map((record) => record.context.state), ['included', 'included', 'included']);
  mail.inbox.forEach((record, index) => {
    assert.equal(record.context.canonical_message_id, `ctx_${F.uuid(index + 1)}`);
    assert.equal(record.context.turn_id, 'turn_1');
  });
  assert.ok(mail.admission_snapshots.every((snapshot) => snapshot.state === 'published'));
  assert.deepEqual(settleMidTurnMail(env.ctx), { rows: [] }, 'a second settle returns no rows');
});

test('a partly consumed snapshot finalizes the consumed record and returns its sibling to queued', async (t) => {
  const env = await setup(t);
  const pushed = pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1, 2) });
  markConsumed(env.ctx, ids(2));
  assert.deepEqual(settleMidTurnMail(env.ctx).rows.map((row) => row.id), [`ctx_${F.uuid(2)}`]);
  finishMidTurnMail(env.ctx, { handled: true, result: { durableTerminal: true } });
  assert.deepEqual(env.states(), ['queued', 'included', 'queued']);
  const snapshot = env.mail().admission_snapshots.find((entry) => entry.snapshot_id === pushed.snapshot_id);
  assert.deepEqual(snapshot.entries.map((entry) => entry.message_id), ids(2));
});

test('settle without consume releases to queued and returns no rows', async (t) => {
  const env = await setup(t);
  pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1, 2) });
  assert.deepEqual(settleMidTurnMail(env.ctx), { rows: [] });
  assert.deepEqual(env.states(), ['queued', 'queued', 'queued']);
  assert.equal(env.mail().admission_snapshots.length, 0);
  assert.deepEqual(settleMidTurnMail(env.ctx), { rows: [] });
  assert.equal(pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1) }).reason, 'no_active_managed_turn', 'a settled stream takes no more mail');
});

test('a settle that is not durable leaves the reservation for the reconcile; one that never ran releases', async (t) => {
  const env = await setup(t);
  pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1) });
  markConsumed(env.ctx, ids(1));
  settleMidTurnMail(env.ctx);
  finishMidTurnMail(env.ctx, { handled: true, result: { durableTerminal: false } });
  assert.deepEqual(env.states(), ['reserved', 'queued', 'queued']);

  const other = await setup(t);
  pushMidTurnMail(other.service, { sessionId: other.id, messageIds: ids(1) });
  markConsumed(other.ctx, ids(1));
  settleMidTurnMail(other.ctx);
  finishMidTurnMail(other.ctx, { handled: false, result: null });
  assert.deepEqual(other.states(), ['queued', 'queued', 'queued']);
});

test('markConsumed ignores ids this stream never reserved', async (t) => {
  const env = await setup(t);
  pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1) });
  assert.equal(markConsumed(env.ctx, [F.uuid(2), 'nope']), 0);
  assert.ok(env.logs.some((entry) => entry.event === 'chat.session_mail_mid_turn_unknown_consumed' && entry.details.count === 2));
  for (const bad of [{}, { message_ids: 'x' }, { message_ids: [1] }, { message_ids: Array.from({ length: 17 }, (_, i) => `m${i}`) }]) {
    assert.equal(acceptMailConsumedNotification(env.ctx, bad), 0, JSON.stringify(bad));
  }
  assert.deepEqual(settleMidTurnMail(env.ctx), { rows: [] });
});

test('a non-settle end and a superseding stream release every reservation, consumed or not', async (t) => {
  const env = await setup(t);
  pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1) });
  markConsumed(env.ctx, ids(1));
  assert.equal(releaseMidTurnMailForStream(env.ctx, 'cancelled'), 1);
  assert.deepEqual(env.states(), ['queued', 'queued', 'queued']);
  assert.equal(releaseMidTurnMailForStream(env.ctx, 'cancelled'), 0, 'idempotent');

  const next = { service: env.service, resolvedSessionId: env.id, streamId: 'stream_1', turnId: 'turn_1' };
  attachMidTurnMail(next);
  pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(2) });
  assert.deepEqual(env.states(), ['queued', 'reserved', 'queued']);
  attachMidTurnMail({ service: env.service, resolvedSessionId: env.id, streamId: 'stream_9', turnId: 'turn_9' });
  assert.deepEqual(env.states(), ['queued', 'queued', 'queued'], 'the abandoned stream handed its mail back');
});

test('pushMidTurnMail mirrors the sidecar per-turn bound: over-budget mail is not sent and waits for the settle wake', async (t) => {
  const big = (n, ch) => F.makeInbox(n, {}, { body: ch.repeat(15000) });
  const env = await setup(t, { inbox: [big(1, 'a'), big(2, 'b'), F.makeInbox(3), F.makeInbox(4)] });
  assert.equal(pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(1) }).ok, true);
  assert.equal(env.sidecarClient.sent.length, 1);
  // The second 15,000-character body would take the turn past 32 KiB of wire JSON: released, not sent.
  assert.deepEqual(pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(2) }), { ok: false, reason: 'turn_mail_budget' });
  assert.equal(env.sidecarClient.sent.length, 1);
  assert.deepEqual(env.states(), ['reserved', 'queued', 'queued', 'queued']);
  assert.ok(env.logs.some((entry) => entry.event === 'chat.session_mail_mid_turn_released' && entry.details.reason === 'turn_mail_budget'));
  // A small message still fits.
  assert.equal(pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(3) }).ok, true);
  assert.equal(env.sidecarClient.sent.length, 2);
  assert.equal(env.ctx.midTurnMail.acceptedRows, 2);
  // A failed send charges nothing.
  const bytesBefore = env.ctx.midTurnMail.acceptedBytes;
  env.sidecarClient.sendResult = false;
  assert.deepEqual(pushMidTurnMail(env.service, { sessionId: env.id, messageIds: ids(4) }), { ok: false, reason: 'transport_unavailable' });
  assert.equal(env.ctx.midTurnMail.acceptedRows, 2);
  assert.equal(env.ctx.midTurnMail.acceptedBytes, bytesBefore);
  // The row cap refuses before any reserve.
  const fresh = await setup(t);
  fresh.ctx.midTurnMail.acceptedRows = 16;
  assert.deepEqual(pushMidTurnMail(fresh.service, { sessionId: fresh.id, messageIds: ids(1) }), { ok: false, reason: 'turn_mail_budget' });
  assert.equal(fresh.sidecarClient.sent.length, 0);
  assert.deepEqual(fresh.states(), ['queued', 'queued', 'queued']);
});
