'use strict';

// Team chat store (row 123 slice 2a-1): retention by count, age and total
// bytes, threads pruned with their roots, the storage limit, and recovery from
// a crash between two file writes for every write order the store uses.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  ALICE, ALICE_DEVICE, DAY_MS, createChatFixture, seeded, assertFailure,
} = require('./helpers/team-chat-fixture');
const retention = require('../../services/host/team-chat-retention');

const FORBIDDEN = 'CMP-HOST-0003';
const PERSISTENCE = 'CMP-HOST-0006';
const LIMIT = 'CMP-HOST-0007';

const segExists = (fx, channel, n) => fs.existsSync(path.join(fx.chatDir, channel, `seg-${n}.json`));

// ------------------------------------------------------------ limits table

test('the retention limits are the spec numbers and can only be lowered', () => {
  assert.equal(retention.RETENTION_LIMITS.maxMessages, 50000);
  assert.equal(retention.RETENTION_LIMITS.maxAgeMs, 365 * DAY_MS);
  assert.equal(retention.RETENTION_LIMITS.treeMaxBytes, 2 * 1024 ** 3);
  assert.throws(() => retention.resolveLimits({ maxMessages: 50001 }), /limit/u);
  assert.throws(() => retention.resolveLimits({ treeMaxBytes: 0 }), /limit/u);
  assert.throws(() => retention.resolveLimits({ unknown: 1 }), /limit/u);
  assert.equal(retention.resolveLimits({ maxMessages: 10 }).maxMessages, 10);
});

// ------------------------------------------------------------ count and age

test('retention by count removes whole oldest segments and raises floor_seq', async (t) => {
  const { fx, store } = await seeded(t, { maxMessages: 6, segmentMaxMessages: 2 });
  for (let i = 1; i <= 6; i += 1) assert.deepEqual((await fx.postOk(store, { text: `m${i}` })).pruned, []);
  const seventh = await fx.postOk(store, { text: 'm7' });
  assert.equal(seventh.pruned.length, 1);
  const report = seventh.pruned[0];
  assert.equal(report.channel_id, 'chan_team');
  assert.equal(report.reason, 'pruned');
  assert.equal(report.floor_seq, 3);
  assert.equal(report.segments_removed, 1);
  assert.equal(report.messages_removed, 2);
  assert.equal(typeof report.channel_rev, 'number');
  assert.equal(segExists(fx, 'chan_team', 1), false);
  const info = store.channelInfo('chan_team');
  assert.equal(info.floor_seq, 3);
  assert.equal(info.message_count, 5);
  assert.deepEqual(store.history('chan_team', { limit: 100 }).messages.map((m) => m.seq), [3, 4, 5, 6, 7]);
  assert.ok(seventh.rev > report.channel_rev, 'the prune is its own revision, before the post');
  assert.equal(fx.openStore().channelInfo('chan_team').floor_seq, 3);
});

test('retention by age removes segments whose newest message is older than the limit', async (t) => {
  const { fx, store } = await seeded(t, { segmentMaxMessages: 2 });
  await fx.postOk(store, { text: 'old1' });
  await fx.postOk(store, { text: 'old2' });
  fx.advance(365 * DAY_MS + 1);
  // The rolling post keeps the head it rolls past; the next sweep removes it.
  assert.deepEqual((await fx.postOk(store, { text: 'new' })).pruned, []);
  const first = await store.applyRetention();
  assert.equal(first.pruned[0].segments_removed, 1);
  assert.equal(fx.openStore().channelInfo('chan_team').floor_seq, 3);
  // A sweep with nothing old removes nothing; a later sweep catches an aged non-head segment.
  assert.deepEqual((await store.applyRetention()).pruned, []);
  await fx.postOk(store);
  await fx.postOk(store);
  fx.advance(365 * DAY_MS + 1);
  const swept = await store.applyRetention();
  assert.equal(swept.pruned.length, 1);
  assert.equal(swept.pruned[0].floor_seq, 5);
});

// ------------------------------------------------------------ total bytes

test('retention by total bytes prunes the oldest segments across channels', async (t) => {
  const text = 'x'.repeat(1000);
  const probe = await seeded(t, { segmentMaxMessages: 2 });
  await probe.fx.createChannel(probe.store, 'chan_project_abc');
  for (let i = 0; i < 6; i += 1) await probe.fx.postOk(probe.store, { channelId: 'chan_project_abc', text });
  const filled = probe.store.totalBytes();
  const store = probe.fx.openStore({ limits: { segmentMaxMessages: 2, treeMaxBytes: filled + 1500 } });
  let pruned = [];
  for (let i = 0; i < 10 && pruned.length === 0; i += 1) {
    probe.fx.advance(1000);
    pruned = (await probe.fx.postOk(store, { text })).pruned;
    assert.ok(store.totalBytes() <= filled + 1500, 'the tree never exceeds its limit');
  }
  assert.equal(pruned[0].channel_id, 'chan_project_abc');
  assert.equal(pruned[0].floor_seq, 3);
  assert.equal(segExists(probe.fx, 'chan_project_abc', 1), false);
});

test('a post fails with team_chat_storage_limit only when pruning cannot make room', async (t) => {
  const text = 'y'.repeat(1000);
  const probe = await seeded(t);
  await probe.fx.postOk(probe.store, { text });
  const one = probe.store.totalBytes();
  const store = probe.fx.openStore({ limits: { treeMaxBytes: one + 500 } });
  const before = probe.fx.snapshotTree();
  assertFailure(await probe.fx.post(store, { text }), LIMIT, 'team_chat_storage_limit');
  assert.deepEqual(probe.fx.snapshotTree(), before, 'a refused post writes nothing');
  assert.equal(store.channelInfo('chan_team').last_seq, 1);
  // The same tree with a prunable (non-head) segment makes room instead of failing.
  await probe.fx.postOk(probe.fx.openStore({ limits: { segmentMaxMessages: 1 } }), { text });
  const two = probe.fx.openStore().totalBytes();
  const roomy = probe.fx.openStore({ limits: { treeMaxBytes: two + 500, segmentMaxMessages: 1 } });
  const ok = await probe.fx.postOk(roomy, { text });
  assert.equal(ok.pruned.length, 1);
});

// ------------------------------------------------------------ threads

test('a thread root is pruned with its replies, and stays pruned after reopen', async (t) => {
  const { fx, store } = await seeded(t, { maxMessages: 4, segmentMaxMessages: 2 });
  const root = await fx.postOk(store, { text: 'root' });
  await fx.postOk(store, { text: 'x' });
  const reply = await fx.postOk(store, { threadRootId: root.message_id, text: 'reply' });
  await fx.postOk(store, { text: 'y' });
  const fifth = await fx.postOk(store, { text: 'z' });
  assert.equal(fifth.pruned[0].floor_seq, 3);
  assert.equal(fifth.pruned[0].replies_removed, 1);
  for (const s of [store, fx.openStore({ limits: { maxMessages: 4, segmentMaxMessages: 2 } })]) {
    assert.equal(s.getMessage('chan_team', reply.message_id).message, null);
    assertFailure(s.thread('chan_team', { rootId: root.message_id, limit: 5 }), FORBIDDEN, 'team_chat_not_found');
    assert.equal(s.changedAfter('chan_team', { afterRev: 0, limit: 50 }).messages.some((m) => m.id === reply.message_id),
      false);
    assertFailure(await fx.post(s, { threadRootId: reply.message_id }), FORBIDDEN, 'team_chat_not_found');
  }
});

// ------------------------------------------------------------ torn writes

test('torn post: head segment written, channel.json not: the message is absent and a retry creates it once', async (t) => {
  const { fx, store } = await seeded(t);
  await fx.postOk(store, { text: 'one' });
  fx.control.crashAfter = 1;
  assertFailure(await fx.post(store, { requestId: 'torn', text: 'two' }), PERSISTENCE, 'team_chat_store_failed');
  fx.control.crashAfter = null;
  const committedRev = fx.readDoc('chan_team/channel.json').rev;
  assert.ok(fx.readDoc('chan_team/seg-1.json').messages[1].rev > committedRev, 'the torn message is on disk');
  const reopened = fx.openStore();
  assert.equal(reopened.channelInfo('chan_team').last_seq, 1);
  assert.equal(reopened.channelInfo('chan_team').rev, committedRev, 'a dropped message leaves the revision alone');
  assert.equal(reopened.history('chan_team', { limit: 10 }).messages.length, 1);
  const retried = await fx.postOk(reopened, { requestId: 'torn', text: 'two' });
  assert.equal(retried.seq, 2);
  assert.equal(retried.replayed, false);
  assert.equal(retried.rev, committedRev + 1);
  assert.deepEqual(fx.readDoc('chan_team/seg-1.json').messages.map((m) => m.text), ['one', 'two']);
});

test('torn roll-over: an unreferenced new segment is ignored, then replaced', async (t) => {
  const { fx, store } = await seeded(t, { segmentMaxMessages: 1 });
  await fx.postOk(store, { text: 'one' });
  fx.control.crashAfter = 1;
  await fx.post(store, { text: 'lost' });
  fx.control.crashAfter = null;
  assert.equal(segExists(fx, 'chan_team', 2), true);
  const reopened = fx.openStore({ limits: { segmentMaxMessages: 1 } });
  assert.equal(reopened.channelInfo('chan_team').last_seq, 1);
  await fx.postOk(reopened, { text: 'two' });
  assert.deepEqual(fx.readDoc('chan_team/seg-2.json').messages.map((m) => m.text), ['two']);
});

test('torn reply: root segment updated, channel.json not: reply absent, root count corrected, no rev reused', async (t) => {
  for (const crashAfter of [1, 2]) {
    const { fx, store } = await seeded(t, { segmentMaxMessages: 1 });
    const root = await fx.postOk(store, { text: 'root' });
    fx.control.crashAfter = crashAfter;
    await fx.post(store, { threadRootId: root.message_id, text: 'reply' });
    fx.control.crashAfter = null;
    const reopened = fx.openStore({ limits: { segmentMaxMessages: 1 } });
    const rootNow = reopened.getMessage('chan_team', root.message_id).message;
    assert.equal(rootNow.reply_count, 0);
    assert.equal(rootNow.last_reply_at, null);
    assert.equal(reopened.channelInfo('chan_team').last_seq, 1);
    assert.ok(reopened.channelInfo('chan_team').rev >= rootNow.rev);
    const next = await fx.postOk(reopened, { text: 'after' });
    assert.ok(next.rev > rootNow.rev, `crashAfter ${crashAfter}: a new change never reuses a torn revision`);
  }
});

test('torn edit: the edited segment rolls forward and its revision is never reused', async (t) => {
  const { fx, store } = await seeded(t);
  const posted = await fx.postOk(store, { text: 'before' });
  fx.control.crashAfter = 1;
  await store.edit({ channelId: 'chan_team', actorId: ALICE, deviceId: ALICE_DEVICE, requestId: 'e',
    messageId: posted.message_id, text: 'after', expectedRev: posted.rev });
  fx.control.crashAfter = null;
  const reopened = fx.openStore();
  const message = reopened.getMessage('chan_team', posted.message_id).message;
  assert.equal(message.text, 'after');
  assert.equal(reopened.channelInfo('chan_team').rev, message.rev);
  assert.ok((await fx.postOk(reopened)).rev > message.rev);
  assert.equal(reopened.changedAfter('chan_team', { afterRev: posted.rev, limit: 10 }).messages[0].text, 'after');
});

test('torn prune: channel.json committed, old segment not yet removed: ignored, then swept', async (t) => {
  const { fx, store } = await seeded(t, { maxMessages: 2, segmentMaxMessages: 1 });
  await fx.postOk(store);
  await fx.postOk(store);
  fx.control.failRemove = true;
  const result = await fx.post(store);
  fx.control.failRemove = false;
  assert.equal(result.ok, true, 'an unremoved pruned file does not fail the post');
  assert.equal(segExists(fx, 'chan_team', 1), true);
  const reopened = fx.openStore({ limits: { maxMessages: 2, segmentMaxMessages: 1 } });
  assert.equal(reopened.channelInfo('chan_team').floor_seq, 2);
  await fx.postOk(reopened);
  assert.equal(segExists(fx, 'chan_team', 1), false, 'the stray is swept by the next commit');
});

test('torn create: channel.json written, index.json not: the channel is absent and can be created again', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  await fx.createChannel(store);
  fx.control.crashAfter = 1;
  assertFailure(await store.createChannel({ channelId: 'chan_project_p1' }), PERSISTENCE, 'team_chat_store_failed');
  fx.control.crashAfter = null;
  const reopened = fx.openStore();
  assertFailure(reopened.history('chan_project_p1', { limit: 1 }), FORBIDDEN, 'team_chat_not_found');
  assert.equal((await reopened.createChannel({ channelId: 'chan_project_p1' })).created, true);
});

test('a failed first write leaves the store usable; a failed later write fails closed until reopen', async (t) => {
  const { fx, store } = await seeded(t);
  fx.control.failWrite = (file) => file.endsWith('seg-1.json');
  assertFailure(await fx.post(store), PERSISTENCE, 'team_chat_store_failed');
  fx.control.failWrite = null;
  assert.equal((await fx.postOk(store)).seq, 1, 'nothing was committed, so seq 1 is still free');
  fx.control.failWrite = (file) => file.endsWith('channel.json');
  assertFailure(await fx.post(store), PERSISTENCE, 'team_chat_store_failed');
  fx.control.failWrite = null;
  assertFailure(await fx.post(store), PERSISTENCE, 'team_chat_store_failed');
  assertFailure(store.history('chan_team', { limit: 1 }), PERSISTENCE, 'team_chat_store_failed');
  assert.equal(fx.openStore().channelInfo('chan_team').last_seq, 1);
});
