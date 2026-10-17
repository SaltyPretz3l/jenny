'use strict';

// The addressed-message store (row 59 checkpoint 4): one cached read of a chat's inbox and
// outbox, a revision guard, coalesced onChanged refetches, action envelopes and an absent bridge.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatMessagesStore, EMPTY_COUNTS } = require('../renderer/chat/renderer-chat-messages-store');
const { inboxItem, outboxItem, makeBridge, flush, makeTimers } = require('./helpers/chat-messages-fixtures');

const SID = 'session-1';

test('a first lookup is checking, reads inbox and outbox once, then serves the cache', async () => {
  const item = inboxItem({ context: { state: 'queued' } });
  const bridge = makeBridge({ [SID]: { inbox: [item], outbox: [outboxItem()], counts: { queued: 1, unread: 1, pending_delivery: 1 } } });
  const store = createChatMessagesStore({ getBridge: () => bridge });
  const seen = [];
  store.subscribe((event) => seen.push(event));
  assert.equal(store.stateKey(SID), '');
  assert.equal(store.lookup(SID).status, 'checking');
  assert.equal(store.lookup(SID).status, 'checking');
  await flush();
  const listCalls = bridge.calls.filter((call) => call.method === 'list');
  assert.equal(listCalls.length, 2);
  assert.deepEqual(listCalls.map((call) => call.request.direction).sort(), ['inbox', 'outbox']);
  assert.equal(listCalls[0].request.schema_version, 1);
  assert.equal(listCalls[0].request.session_id, SID);
  const ready = store.lookup(SID);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.inbox.length, 1);
  assert.equal(ready.outbox.length, 1);
  assert.equal(ready.counts.queued, 1);
  assert.equal(ready.counts.pending_delivery, 1);
  assert.equal(bridge.calls.filter((call) => call.method === 'list').length, 2);
  assert.match(store.stateKey(SID), /^chat-messages:\d+$/u);
  assert.equal(store.stateKey('other'), '');
  assert.ok(seen.length >= 1 && seen.every((event) => event.sessionId === SID));
});

test('without the bridge the store is unavailable, empty and never throws', async () => {
  const store = createChatMessagesStore({ getBridge: () => null });
  const view = store.lookup(SID);
  assert.equal(view.status, 'unavailable');
  assert.deepEqual(view.inbox, []);
  assert.deepEqual(view.counts, { ...EMPTY_COUNTS });
  assert.equal(store.isAvailable(), false);
  assert.equal(typeof store.watch(SID), 'function');
  const result = await store.markRead(SID, ['x']);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unavailable');
  await store.refresh(SID);
  store.dispose();
});

test('a list that throws leaves the chat unavailable', async () => {
  const bridge = makeBridge({});
  bridge.list = async () => { throw new Error('boom'); };
  const store = createChatMessagesStore({ getBridge: () => bridge });
  store.lookup(SID);
  await flush();
  assert.equal(store.lookup(SID).status, 'unavailable');
});

test('an older revision never overwrites a newer read', async () => {
  const bridge = makeBridge({ [SID]: { inbox: [inboxItem()], counts: { queued: 1 }, revision: 5 } });
  const store = createChatMessagesStore({ getBridge: () => bridge });
  store.lookup(SID);
  await flush();
  bridge.data[SID] = { inbox: [], counts: { queued: 0 }, revision: 3 };
  await store.refresh(SID);
  assert.equal(store.lookup(SID).inbox.length, 1, 'the revision 3 answer is older than the cached revision 5');
  bridge.data[SID] = { inbox: [], counts: { queued: 0 }, revision: 6 };
  await store.refresh(SID);
  assert.equal(store.lookup(SID).inbox.length, 0);
});

test('a change event refetches a watched chat once per coalesced beat and drops an unwatched one', async () => {
  const timers = makeTimers();
  const bridge = makeBridge({ [SID]: { inbox: [], counts: {}, revision: 1 }, other: { inbox: [], counts: {}, revision: 1 } });
  const store = createChatMessagesStore({ getBridge: () => bridge, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  const release = store.watch(SID);
  store.lookup('other');
  await flush();
  const before = bridge.calls.length;
  bridge.data[SID] = { inbox: [inboxItem()], counts: { queued: 1, unread: 1 }, revision: 2 };
  bridge.emit({ session_id: SID });
  bridge.emit({ session_id: SID });
  bridge.emit({ session_id: 'other' });
  assert.equal(timers.queue.length, 1, 'a watched chat coalesces; an unwatched one is simply dropped');
  timers.run();
  await flush();
  assert.equal(bridge.calls.length - before, 2, 'one inbox and one outbox read');
  assert.equal(store.lookup(SID).counts.queued, 1);
  release();
  release();
});

test('mark read, disposition, discard, retry and cancel send closed requests and re-read on success', async () => {
  const messageId = '11111111-1111-4111-8111-111111111111';
  const bridge = makeBridge({ [SID]: { inbox: [inboxItem({ message_id: messageId })], counts: { unread: 1, queued: 1 }, revision: 1 } });
  const store = createChatMessagesStore({ getBridge: () => bridge });
  store.lookup(SID);
  await flush();
  const reads = () => bridge.calls.filter((call) => call.method === 'list').length;
  const afterFirst = reads();
  await store.markRead(SID, [messageId, messageId, '']);
  const mark = bridge.calls.find((call) => call.method === 'markRead');
  assert.deepEqual(mark.request, { schema_version: 1, session_id: SID, message_ids: [messageId] });
  assert.ok(reads() > afterFirst, 'a successful action re-reads');
  await store.setDisposition(SID, messageId, 'excluded_by_user');
  assert.deepEqual(bridge.calls.find((call) => call.method === 'setContextDisposition').request,
    { schema_version: 1, session_id: SID, message_ids: [messageId], disposition: 'excluded_by_user' });
  await store.discard(SID, messageId);
  assert.deepEqual(bridge.calls.find((call) => call.method === 'discard').request, { schema_version: 1, session_id: SID, message_ids: [messageId] });
  await store.retry(SID, 'op-1');
  await store.cancel(SID, 'op-1');
  assert.deepEqual(bridge.calls.find((call) => call.method === 'retry').request, { schema_version: 1, operation_id: 'op-1' });
  assert.deepEqual(bridge.calls.find((call) => call.method === 'cancel').request, { schema_version: 1, operation_id: 'op-1' });
});

test('mark read caps one call at 100 ids and an empty set makes no call', async () => {
  const bridge = makeBridge({});
  const store = createChatMessagesStore({ getBridge: () => bridge });
  const ids = Array.from({ length: 130 }, (_value, index) => `id-${index}`);
  await store.markRead(SID, ids);
  assert.equal(bridge.calls.find((call) => call.method === 'markRead').request.message_ids.length, 100);
  const before = bridge.calls.length;
  const empty = await store.markRead(SID, []);
  assert.equal(empty.ok, true);
  assert.equal(bridge.calls.length, before);
});

test('a failed action returns the envelope untouched and does not re-read; a second tap while busy is refused', async () => {
  const failure = { schema_version: 1, ok: false, code: 'CMP-MESSAGE-0012', reason: 'busy', retryable: true };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = makeBridge({ [SID]: { inbox: [inboxItem()], revision: 1 } }, {
    responses: { discard: async () => { await gate; return failure; } },
  });
  const store = createChatMessagesStore({ getBridge: () => bridge });
  store.lookup(SID);
  await flush();
  const reads = bridge.calls.filter((call) => call.method === 'list').length;
  const first = store.discard(SID, 'm1');
  assert.equal(store.isBusy('msg:m1'), true);
  const second = await store.discard(SID, 'm1');
  assert.equal(second.ok, false);
  release();
  assert.deepEqual(await first, failure);
  assert.equal(store.isBusy('msg:m1'), false);
  assert.equal(bridge.calls.filter((call) => call.method === 'list').length, reads);
  assert.equal(bridge.calls.filter((call) => call.method === 'discard').length, 1);
});

test('dispose releases the subscription and clears listeners', async () => {
  const bridge = makeBridge({ [SID]: { inbox: [], revision: 1 } });
  const store = createChatMessagesStore({ getBridge: () => bridge });
  store.lookup(SID);
  await flush();
  assert.equal(bridge.hasListener(), true);
  store.dispose();
  assert.equal(bridge.hasListener(), false);
});

test('the inbox follows the cursor so arrivals past the first page are seen (review P2-3)', async () => {
  const receipts = Array.from({ length: 101 }, (_, i) => inboxItem({ receive_sequence: i + 1, context: { state: 'discarded' } }));
  const arrival = inboxItem({ receive_sequence: 102, read_at: null, context: { state: 'queued' } });
  const all = [...receipts, arrival];
  const bridge = makeBridge({}, {
    responses: {
      list: (request) => {
        if (request.direction !== 'inbox') return { schema_version: 1, ok: true, items: [], next_cursor: null, revision: 4, counts: {} };
        const start = request.cursor ? Number(request.cursor) : 0;
        const items = all.slice(start, start + request.limit);
        const next = start + request.limit < all.length ? String(start + request.limit) : null;
        return { schema_version: 1, ok: true, items, next_cursor: next, revision: 4, counts: { unread: 1 } };
      },
    },
  });
  const store = createChatMessagesStore({ getBridge: () => bridge });
  store.lookup(SID);
  await flush();
  const inboxCalls = bridge.calls.filter((call) => call.method === 'list' && call.request.direction === 'inbox');
  assert.equal(inboxCalls.length, 2);
  assert.equal(inboxCalls[1].request.cursor, '100');
  const ready = store.lookup(SID);
  assert.equal(ready.inbox.length, 102);
  assert.equal(ready.inbox[101].receive_sequence, 102);
});

test('createGrant and revokeGrant send the frozen requests, a fresh gesture id per call, and re-read nothing', async () => {
  const bridge = makeBridge({}, { responses: { createGrant: (request) => ({ schema_version: 1, ok: true, grant: { grant_id: 'g-1', purpose: request.purpose } }), revokeGrant: { schema_version: 1, ok: true, grant: { grant_id: 'g-1' } } } });
  let n = 0;
  const store = createChatMessagesStore({ getBridge: () => bridge, randomUUID: () => `gesture-${(n += 1)}` });
  const first = await store.createGrant(SID, 'dest-1', 'Share results');
  const second = await store.createGrant(SID, 'dest-1', 'Share results');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const creates = bridge.calls.filter((call) => call.method === 'createGrant').map((call) => call.request);
  assert.deepEqual(creates[0], { schema_version: 1, source_session_id: SID, destination_session_id: 'dest-1', purpose: 'Share results', gesture_id: 'gesture-1' });
  assert.equal(creates[1].gesture_id, 'gesture-2');
  const revoked = await store.revokeGrant(SID, 'g-1');
  assert.equal(revoked.ok, true);
  assert.deepEqual(bridge.calls.find((call) => call.method === 'revokeGrant').request, { schema_version: 1, source_session_id: SID, grant_id: 'g-1' });
  assert.equal(bridge.calls.filter((call) => call.method === 'list').length, 0, 'a grant changes no inbox or outbox row');
});

test('a grant action is single-flight, validates its ids and answers unavailable without the bridge', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = makeBridge({}, { responses: { createGrant: () => gate.then(() => ({ schema_version: 1, ok: true, grant: { grant_id: 'g-1' } })) } });
  const store = createChatMessagesStore({ getBridge: () => bridge });
  const pending = store.createGrant(SID, 'dest-1', 'why');
  const duplicate = await store.createGrant(SID, 'dest-1', 'why');
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'busy');
  release();
  assert.equal((await pending).ok, true);
  assert.equal(bridge.calls.filter((call) => call.method === 'createGrant').length, 1);
  assert.equal((await store.createGrant('', 'dest-1', 'why')).reason, 'invalid_request');
  assert.equal((await store.revokeGrant(SID, '')).reason, 'invalid_request');
  const bare = createChatMessagesStore({ getBridge: () => null });
  assert.equal((await bare.createGrant(SID, 'dest-1', 'why')).reason, 'unavailable');
  assert.equal((await bare.revokeGrant(SID, 'g-1')).reason, 'unavailable');
});
