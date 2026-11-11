'use strict';

// Team chat store (row 123 slice 2a-1): documents, segments, revisions,
// threads, idempotency, paging and read state. Retention and torn writes live
// in team-chat-retention.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  ALICE, BOB, ALICE_DEVICE, BOB_DEVICE, createChatFixture, seeded, assertFailure,
} = require('./helpers/team-chat-fixture');
const { LIMITS, SCHEMA_VERSION } = require('../../services/host/team-chat-schema');
const { turn } = require('./helpers/team-chat-timers');

const INVALID = 'CMP-HOST-0001';
const FORBIDDEN = 'CMP-HOST-0003';
const CONFLICT = 'CMP-HOST-0004';
const PERSISTENCE = 'CMP-HOST-0006';

// ------------------------------------------------------------ schema refusal

test('an unknown or newer schema version fails closed and rewrites nothing', async (t) => {
  for (const [file, version] of [['index.json', 2], ['chan_team/channel.json', 99], ['chan_team/seg-1.json', 2],
    ['chan_team/read.json', 7]]) {
    const { fx, store } = await seeded(t);
    await fx.postOk(store);
    await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: 1 });
    const doc = fx.readDoc(file);
    doc.schema_version = version;
    fx.writeDoc(file, doc);
    const before = fx.snapshotTree();
    const reopened = new (store.constructor)({ profileDir: fx.profileDir, fileOps: fx.fileOps });
    const touch = file.endsWith('read.json')
      ? () => reopened.readState('chan_team', ALICE)
      : () => reopened.history('chan_team', { limit: 10 });
    const opened = reopened.open();
    assertFailure(opened.ok ? touch() : opened, PERSISTENCE, 'team_chat_schema_unsupported');
    assertFailure(await reopened.post({ channelId: 'chan_team', actorId: ALICE, deviceId: ALICE_DEVICE,
      requestId: 'r_after', text: 'x' }), PERSISTENCE, 'team_chat_schema_unsupported');
    assert.deepEqual(fx.snapshotTree(), before, `${file} v${version}: nothing rewritten`);
  }
});

test('a malformed, oversized or unknown-field document fails closed as store_failed', async (t) => {
  const cases = [
    ['index.json', '{"schema_version":1,'],
    ['index.json', JSON.stringify({ schema_version: 1, channels: [], extra: 1 })],
    ['chan_team/channel.json', 'x'.repeat(LIMITS.CHANNEL_MAX_BYTES + 1)],
    ['chan_team/seg-1.json', JSON.stringify({ schema_version: 1, channel_id: 'chan_team', n: 1, messages: [{}] })],
    ['chan_team/seg-1.json', '[]'],
  ];
  for (const [file, content] of cases) {
    const { fx, store } = await seeded(t);
    await fx.postOk(store);
    fx.writeDoc(file, content);
    const before = fx.snapshotTree();
    const reopened = new (store.constructor)({ profileDir: fx.profileDir, fileOps: fx.fileOps });
    const opened = reopened.open();
    assertFailure(opened.ok ? reopened.history('chan_team', { limit: 5 }) : opened, PERSISTENCE, 'team_chat_store_failed');
    assert.deepEqual(fx.snapshotTree(), before);
  }
});

// ------------------------------------------------------------ seq and rev

test('seq and rev are assigned in order under concurrent posts', async (t) => {
  const { fx, store } = await seeded(t);
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => fx.post(store, { text: `m${i}` })));
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(results.map((r) => r.seq), Array.from({ length: 40 }, (_, i) => i + 1));
  const revs = results.map((r) => r.rev);
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b));
  assert.equal(new Set(revs).size, 40);
  assert.equal(new Set(results.map((r) => r.message_id)).size, 40);
  assert.ok(results.every((r) => /^msg_[0-9A-HJKMNP-TV-Z]{26}$/u.test(r.message_id)));
  const info = store.channelInfo('chan_team');
  assert.equal(info.last_seq, 40);
  assert.equal(info.rev, revs[39]);
});

test('a post rewrites only the head segment and channel.json', async (t) => {
  const { fx, store } = await seeded(t);
  await fx.postOk(store);
  assert.deepEqual(fx.takeWrites(), ['chan_team/seg-1.json', 'chan_team/channel.json']);
  await fx.postOk(store);
  assert.deepEqual(fx.takeWrites(), ['chan_team/seg-1.json', 'chan_team/channel.json']);
});

test('the head segment rolls over at 500 messages', async (t) => {
  const { fx, store } = await seeded(t);
  for (let i = 0; i < LIMITS.SEGMENT_MAX_MESSAGES; i += 1) await fx.postOk(store, { text: `m${i}` });
  assert.equal(fx.readDoc('chan_team/seg-1.json').messages.length, 500);
  fx.takeWrites();
  const next = await fx.postOk(store);
  assert.deepEqual(fx.takeWrites(), ['chan_team/seg-2.json', 'chan_team/channel.json']);
  assert.equal(fx.readDoc('chan_team/seg-2.json').messages[0].id, next.message_id);
  assert.deepEqual(fx.readDoc('chan_team/channel.json').segments.map((s) => s.n), [1, 2]);
});

test('the head segment rolls over before it would cross 1 MiB', async (t) => {
  const { fx, store } = await seeded(t);
  const big = 'é'.repeat(LIMITS.TEXT_MAX_CHARS);
  let posts = 0;
  while (fx.readDoc('chan_team/channel.json').segments.length < 2) {
    await fx.postOk(store, { text: big });
    posts += 1;
  }
  const first = fs.statSync(path.join(fx.chatDir, 'chan_team', 'seg-1.json')).size;
  assert.ok(first <= LIMITS.SEGMENT_MAX_BYTES, `seg-1 is ${first} bytes`);
  assert.ok(posts < 500);
  assert.equal(fx.readDoc('chan_team/seg-2.json').messages.length, 1);
});

// ------------------------------------------------------------ edit and delete

test('edit and delete rewrite the one segment holding the message and stamp rev', async (t) => {
  const { fx, store } = await seeded(t, { segmentMaxMessages: 2 });
  const first = await fx.postOk(store, { text: 'first' });
  await fx.postOk(store);
  await fx.postOk(store);
  fx.takeWrites();
  const edited = await store.edit({ channelId: 'chan_team', actorId: ALICE, deviceId: ALICE_DEVICE,
    requestId: 'e1', messageId: first.message_id, text: 'first, fixed', expectedRev: first.rev });
  assert.equal(edited.ok, true);
  assert.deepEqual(fx.takeWrites(), ['chan_team/seg-1.json', 'chan_team/channel.json']);
  const message = store.getMessage('chan_team', first.message_id).message;
  assert.equal(message.text, 'first, fixed');
  assert.equal(message.rev, edited.rev);
  assert.equal(edited.rev, store.channelInfo('chan_team').rev);
  assert.deepEqual(message.edits.map((e) => e.text), ['first']);
  assert.ok(message.edited_at);
  assertFailure(await store.edit({ channelId: 'chan_team', actorId: ALICE, deviceId: ALICE_DEVICE,
    requestId: 'e2', messageId: first.message_id, text: 'again', expectedRev: first.rev }), CONFLICT, 'team_chat_stale');
  const deleted = await store.delete({ channelId: 'chan_team', actorId: BOB, deviceId: BOB_DEVICE,
    requestId: 'd1', messageId: first.message_id });
  assert.equal(deleted.ok, true);
  assert.ok(deleted.rev > edited.rev);
  assert.deepEqual(fx.takeWrites(), ['chan_team/seg-1.json', 'chan_team/channel.json']);
});

test('a delete clears text, edits, reactions, attachments and refs and keeps the tombstone', async (t) => {
  const { fx, store } = await seeded(t);
  const posted = await fx.postOk(store, { text: 'secret', refs: [{ kind: 'conversation', session_id: 'sess_1' }],
    mentions: [BOB] });
  await store.edit({ channelId: 'chan_team', actorId: ALICE, deviceId: ALICE_DEVICE, requestId: 'e1',
    messageId: posted.message_id, text: 'secret two', expectedRev: posted.rev });
  const deleted = await store.delete({ channelId: 'chan_team', actorId: ALICE, deviceId: ALICE_DEVICE,
    requestId: 'd1', messageId: posted.message_id });
  const message = store.getMessage('chan_team', posted.message_id).message;
  assert.equal(message.text, '');
  assert.deepEqual(message.edits, []);
  assert.deepEqual(message.reactions, {});
  assert.deepEqual(message.attachments, []);
  assert.deepEqual(message.refs, []);
  assert.deepEqual(message.deleted, { by: ALICE, at: message.deleted.at });
  assert.equal(message.rev, deleted.rev);
  assert.equal(JSON.stringify(fx.readDoc('chan_team/seg-1.json')).includes('secret'), false);
  // Deleting again changes nothing; editing a tombstone answers not found.
  fx.takeWrites();
  const again = await store.delete({ channelId: 'chan_team', actorId: ALICE, deviceId: ALICE_DEVICE,
    requestId: 'd2', messageId: posted.message_id });
  assert.equal(again.rev, deleted.rev);
  assert.deepEqual(fx.takeWrites(), []);
  assertFailure(await store.edit({ channelId: 'chan_team', actorId: ALICE, deviceId: ALICE_DEVICE, requestId: 'e3',
    messageId: posted.message_id, text: 'x', expectedRev: deleted.rev }), FORBIDDEN, 'team_chat_not_found');
});

test('an archived channel refuses posts and edits and still reads', async (t) => {
  const { fx, store } = await seeded(t);
  const posted = await fx.postOk(store);
  assert.equal((await store.archiveChannel({ channelId: 'chan_team' })).ok, true);
  assert.equal(store.channelInfo('chan_team').archived, true);
  assertFailure(await fx.post(store), FORBIDDEN, 'team_chat_archived');
  assertFailure(await store.edit({ channelId: 'chan_team', actorId: ALICE, deviceId: ALICE_DEVICE, requestId: 'e',
    messageId: posted.message_id, text: 'x', expectedRev: posted.rev }), FORBIDDEN, 'team_chat_archived');
  assertFailure(await fx.del(store, { messageId: posted.message_id }), FORBIDDEN, 'team_chat_archived');
  assert.equal((await store.markRead({ channelId: 'chan_team', actorId: BOB, seq: 1 })).last_read_seq, 1);
  assert.equal(store.history('chan_team', { limit: 5 }).messages.length, 1);
  assert.equal(fx.openStore().getMessage('chan_team', posted.message_id).message.deleted, null);
  assert.deepEqual(fx.openStore().listChannels().channels.map((c) => [c.channel_id, c.archived]), [['chan_team', true]]);
});

// ------------------------------------------------------------ threads

test('a reply to a reply attaches to the root and maintains reply_count and last_reply_at', async (t) => {
  const { fx, store } = await seeded(t, { segmentMaxMessages: 2 });
  const root = await fx.postOk(store, { text: 'root' });
  await fx.postOk(store);
  fx.advance(1000);
  const reply = await fx.postOk(store, { threadRootId: root.message_id, text: 'r1' });
  fx.advance(1000);
  const nested = await fx.postOk(store, { threadRootId: reply.message_id, text: 'r2' });
  const nestedMessage = store.getMessage('chan_team', nested.message_id).message;
  assert.equal(nestedMessage.thread_root_id, root.message_id);
  const rootMessage = store.getMessage('chan_team', root.message_id).message;
  assert.equal(rootMessage.reply_count, 2);
  assert.equal(rootMessage.last_reply_at, nestedMessage.created_at);
  assert.equal(rootMessage.rev, nested.rev);
  const thread = store.thread('chan_team', { rootId: root.message_id, limit: 10 });
  assert.deepEqual(thread.replies.map((m) => m.id), [reply.message_id, nested.message_id]);
  assert.equal(thread.root.id, root.message_id);
  const history = store.history('chan_team', { limit: 10 });
  assert.equal(history.messages.some((m) => m.thread_root_id !== null), false);
  assertFailure(await fx.post(store, { threadRootId: 'msg_00000000000000000000000000' }), FORBIDDEN,
    'team_chat_not_found');
});

// ------------------------------------------------------------ idempotency

test('idempotency: the same request id returns the first result and writes nothing', async (t) => {
  const { fx, store } = await seeded(t);
  const input = { requestId: 'req_same', text: 'once' };
  const first = await fx.postOk(store, input);
  fx.takeWrites();
  const second = await fx.postOk(store, input);
  assert.equal(second.message_id, first.message_id);
  assert.equal(second.seq, first.seq);
  assert.equal(second.rev, first.rev);
  assert.equal(second.replayed, true);
  assert.deepEqual(fx.takeWrites(), []);
  assert.equal(store.channelInfo('chan_team').last_seq, 1);
  assertFailure(await fx.post(store, { requestId: 'req_same', text: 'changed' }), CONFLICT, 'request_payload_changed');
  // The key is the device and the request id: another device may reuse the id.
  const other = await fx.postOk(store, { requestId: 'req_same', text: 'once', deviceId: BOB_DEVICE });
  assert.notEqual(other.message_id, first.message_id);
  // Entries survive a reopen and expire after 24 h.
  const reopened = fx.openStore();
  assert.equal((await fx.postOk(reopened, input)).message_id, first.message_id);
  fx.advance(LIMITS.REQUEST_TTL_MS + 1);
  assert.notEqual((await fx.postOk(reopened, input)).message_id, first.message_id);
});

test('idempotency entries are bounded to the last 512 per channel', async (t) => {
  const { fx, store } = await seeded(t);
  for (let i = 0; i < LIMITS.REQUESTS_MAX + 3; i += 1) await fx.postOk(store, { requestId: `bulk_${i}`, text: 'x' });
  assert.equal(fx.readDoc('chan_team/channel.json').requests.length, LIMITS.REQUESTS_MAX);
  const replay = await fx.postOk(store, { requestId: `bulk_${LIMITS.REQUESTS_MAX + 2}`, text: 'x' });
  assert.equal(replay.replayed, true);
});

test('idempotency: an edit and a delete replay their first result', async (t) => {
  const { fx, store } = await seeded(t);
  const posted = await fx.postOk(store);
  const editInput = { requestId: 'edit_once', messageId: posted.message_id, text: 'v2', expectedRev: posted.rev };
  const edited = await fx.edit(store, editInput);
  fx.takeWrites();
  const editAgain = await fx.edit(store, editInput);
  assert.deepEqual([editAgain.ok, editAgain.rev, editAgain.replayed], [true, edited.rev, true]);
  const delInput = { requestId: 'del_once', messageId: posted.message_id };
  const deleted = await fx.del(store, delInput);
  fx.takeWrites();
  const delAgain = await fx.del(fx.openStore(), delInput);
  assert.deepEqual([delAgain.ok, delAgain.rev, delAgain.replayed], [true, deleted.rev, true]);
  assert.deepEqual(fx.takeWrites(), []);
});

test('idempotency: another actor on the same device and request id never gets the first result', async (t) => {
  const { fx, store } = await seeded(t);
  await fx.postOk(store, { requestId: 'shared', text: 'mine' });
  assertFailure(await fx.post(fx.openStore(), { requestId: 'shared', text: 'mine', actorId: BOB }), CONFLICT,
    'request_payload_changed');
});

test('idempotency: refs with reordered keys replay', async (t) => {
  const { fx, store } = await seeded(t);
  const first = await fx.postOk(store, { requestId: 'refs', refs: [{ kind: 'file', project_id: 'project_a', path: 'a.js', line: 1 }] });
  const again = await fx.postOk(fx.openStore(), { requestId: 'refs',
    refs: [{ line: 1, path: 'a.js', project_id: 'project_a', kind: 'file' }] });
  assert.equal(again.message_id, first.message_id);
  assert.equal(again.replayed, true);
});

test('a retry of a post committed before the channel was archived gets its first result', async (t) => {
  const { fx, store } = await seeded(t);
  const first = await fx.postOk(store, { requestId: 'before_archive' });
  await store.archiveChannel({ channelId: 'chan_team' });
  const again = await fx.postOk(fx.openStore(), { requestId: 'before_archive' });
  assert.equal(again.message_id, first.message_id);
});

test('following a thread twice the same way writes nothing', async (t) => {
  const { fx, store } = await seeded(t);
  const root = await fx.postOk(store);
  await store.follow({ channelId: 'chan_team', actorId: BOB, rootId: root.message_id, on: true });
  fx.takeWrites();
  assert.equal((await store.follow({ channelId: 'chan_team', actorId: BOB, rootId: root.message_id, on: true })).ok, true);
  assert.deepEqual(fx.takeWrites(), []);
  assert.deepEqual(fx.openStore().readState('chan_team', BOB).followed, [{ root_id: root.message_id, on: true }]);
});

// ------------------------------------------------------------ paging

test('history pages across segments, newest page first, and stops at floor_seq', async (t) => {
  const { fx, store } = await seeded(t, { segmentMaxMessages: 3 });
  for (let i = 1; i <= 10; i += 1) await fx.postOk(store, { text: `m${i}` });
  const page = store.history('chan_team', { limit: 4 });
  assert.deepEqual(page.messages.map((m) => m.seq), [7, 8, 9, 10]);
  assert.equal(page.has_more, true);
  const older = store.history('chan_team', { beforeSeq: 7, limit: 4 });
  assert.deepEqual(older.messages.map((m) => m.seq), [3, 4, 5, 6]);
  const oldest = store.history('chan_team', { beforeSeq: 3, limit: 4 });
  assert.deepEqual(oldest.messages.map((m) => m.seq), [1, 2]);
  assert.equal(oldest.has_more, false);
  assertFailure(store.history('chan_team', { limit: 101 }), INVALID, 'team_chat_request_invalid');
});

test('changedAfter returns every change after a revision, ordered, never splitting a revision', async (t) => {
  const { fx, store } = await seeded(t, { segmentMaxMessages: 2 });
  const a = await fx.postOk(store, { text: 'a' });
  const b = await fx.postOk(store, { text: 'b' });
  const mark = store.channelInfo('chan_team').rev;
  await fx.postOk(store, { text: 'c' });
  await store.edit({ channelId: 'chan_team', actorId: ALICE, deviceId: ALICE_DEVICE, requestId: 'e', messageId: a.message_id,
    text: 'a2', expectedRev: a.rev });
  const reply = await fx.postOk(store, { threadRootId: b.message_id, text: 'r' });
  const all = store.changedAfter('chan_team', { afterRev: mark, limit: 200 });
  // Ordered by rev, then seq: the reply stamps itself and its root with one rev.
  assert.deepEqual(all.messages.map((m) => m.text), ['c', 'a2', 'b', 'r']);
  assert.deepEqual(all.messages.map((m) => m.rev), [mark + 1, mark + 2, mark + 3, mark + 3]);
  assert.equal(all.channel_rev, reply.rev);
  assert.equal(all.more, false);
  // The reply and its root share one revision: a page never ends between them.
  const page = store.changedAfter('chan_team', { afterRev: mark + 2, limit: 1 });
  assert.deepEqual(page.messages.map((m) => m.rev), [reply.rev, reply.rev]);
  assert.equal(page.more, false);
  assert.equal(store.changedAfter('chan_team', { afterRev: reply.rev, limit: 5 }).messages.length, 0);
});

// ------------------------------------------------------------ read state

test('read state is raised, never past last_seq, lowered only by unread, and survives reopen', async (t) => {
  const { fx, store } = await seeded(t);
  for (let i = 0; i < 5; i += 1) await fx.postOk(store);
  fx.takeWrites();
  assert.equal((await store.markRead({ channelId: 'chan_team', actorId: BOB, seq: 3 })).last_read_seq, 3);
  assert.deepEqual(fx.takeWrites(), ['chan_team/read.json']);
  assert.equal((await store.markRead({ channelId: 'chan_team', actorId: BOB, seq: 2 })).last_read_seq, 3);
  assert.equal((await store.markRead({ channelId: 'chan_team', actorId: BOB, seq: 999 })).last_read_seq, 5);
  assert.equal((await store.markRead({ channelId: 'chan_team', actorId: BOB, seq: 2, unread: true })).last_read_seq, 1);
  assert.equal(fx.openStore().readState('chan_team', BOB).last_read_seq, 1);
  assert.equal(store.readState('chan_team', ALICE).last_read_seq, 0);
  assert.equal(store.readState('chan_team', ALICE).notify, 'mentions');
  assert.equal((await store.setNotify({ channelId: 'chan_team', actorId: BOB, level: 'none' })).level, 'none');
  assertFailure(await store.setNotify({ channelId: 'chan_team', actorId: BOB, level: 'loud' }), INVALID,
    'team_chat_request_invalid');
  // Bounded: at most 64 member entries, the least recently updated dropped first.
  for (let i = 0; i < LIMITS.MEMBERS_MAX; i += 1) {
    fx.advance(1);
    await store.markRead({ channelId: 'chan_team', actorId: `member_m${i}`, seq: 1 });
  }
  const members = store.readStates('chan_team').members.map((m) => m.member_id);
  assert.equal(members.length, LIMITS.MEMBERS_MAX);
  assert.equal(members.includes(BOB), false);
  assert.equal(members.includes('member_m63'), true);
});

test('followed threads are capped at 200, oldest dropped first', async (t) => {
  const { fx, store } = await seeded(t);
  const roots = [];
  for (let i = 0; i < LIMITS.FOLLOWED_MAX + 1; i += 1) roots.push((await fx.postOk(store)).message_id);
  for (const rootId of roots) {
    assert.equal((await store.follow({ channelId: 'chan_team', actorId: BOB, rootId, on: true })).ok, true);
  }
  const followed = store.readState('chan_team', BOB).followed;
  assert.equal(followed.length, LIMITS.FOLLOWED_MAX);
  assert.equal(followed.some((f) => f.root_id === roots[0]), false);
  assert.equal(followed.at(-1).root_id, roots.at(-1));
  assertFailure(await store.follow({ channelId: 'chan_team', actorId: BOB, rootId: 'msg_00000000000000000000000000',
    on: true }), FORBIDDEN, 'team_chat_not_found');
});

// ------------------------------------------------------------ bounds

test('every message bound is refused at the bound plus one', async (t) => {
  const { fx, store } = await seeded(t);
  const member = (i) => `member_m${i}`;
  const ref = (i) => ({ kind: 'file', project_id: 'project_abc', path: `src/f${i}.js`, line: i + 1 });
  assert.equal((await fx.post(store, { text: 'a'.repeat(LIMITS.TEXT_MAX_CHARS) })).ok, true);
  assertFailure(await fx.post(store, { text: 'a'.repeat(LIMITS.TEXT_MAX_CHARS + 1) }), INVALID, 'team_chat_text_invalid');
  assertFailure(await fx.post(store, { text: '   ' }), INVALID, 'team_chat_text_invalid');
  assertFailure(await fx.post(store, { text: 'bell\u0007' }), INVALID, 'team_chat_text_invalid');
  const mentions = Array.from({ length: LIMITS.MENTIONS_MAX }, (_, i) => member(i));
  assert.equal((await fx.post(store, { mentions })).ok, true);
  assertFailure(await fx.post(store, { mentions: [...mentions, 'jenny'] }), INVALID, 'team_chat_request_invalid');
  const refs = Array.from({ length: LIMITS.REFS_MAX }, (_, i) => ref(i));
  assert.equal((await fx.post(store, { refs })).ok, true);
  assertFailure(await fx.post(store, { refs: [...refs, ref(99)] }), INVALID, 'team_chat_ref_invalid');
  assertFailure(await fx.post(store, { refs: [{ kind: 'file', project_id: 'project_abc', path: 'a\u0000b', line: null }] }),
    INVALID, 'team_chat_ref_invalid');
  // Edit history keeps the newest 10: the eleventh edit drops the oldest.
  const posted = await fx.postOk(store, { text: 'v0' });
  let rev = posted.rev;
  for (let i = 1; i <= LIMITS.EDITS_MAX + 1; i += 1) {
    rev = (await store.edit({ channelId: 'chan_team', actorId: ALICE, deviceId: ALICE_DEVICE, requestId: `ed${i}`,
      messageId: posted.message_id, text: `v${i}`, expectedRev: rev })).rev;
  }
  const edits = store.getMessage('chan_team', posted.message_id).message.edits;
  assert.equal(edits.length, LIMITS.EDITS_MAX);
  assert.equal(edits[0].text, 'v1');
  // A stored record past a bound is refused on load.
  const seg = fx.readDoc('chan_team/seg-1.json');
  const record = seg.messages.find((m) => m.id === posted.message_id);
  record.edits.push({ text: 'extra', edited_at: record.created_at });
  fx.writeDoc('chan_team/seg-1.json', seg);
  assertFailure(new (store.constructor)({ profileDir: fx.profileDir }).history('chan_team', { limit: 1 }),
    PERSISTENCE, 'team_chat_store_failed');
});

test('a missing or malformed actor, device or request id is refused, never defaulted', async (t) => {
  const { fx, store } = await seeded(t);
  for (const patch of [{ actorId: undefined }, { actorId: 'owner' }, { deviceId: '' }, { requestId: 'a b' },
    { actorId: 'member_x/../y' }]) {
    assertFailure(await fx.post(store, patch), INVALID, 'team_chat_request_invalid');
  }
  assertFailure(await store.markRead({ channelId: 'chan_team', seq: 1 }), INVALID, 'team_chat_request_invalid');
  assert.equal(store.channelInfo('chan_team').last_seq, 0);
});

// ------------------------------------------------------------ path safety

test('a hostile channel id never reaches the file system', async (t) => {
  const fx = createChatFixture(t);
  const touched = [];
  const spy = {
    readJson: (p, o) => { touched.push(p); return fx.fileOps.readJson(p, o); },
    writeJson: (p, v) => { touched.push(p); return fx.fileOps.writeJson(p, v); },
    removeFile: (p) => { touched.push(p); return fx.fileOps.removeFile(p); },
  };
  const store = fx.openStore({ fileOps: spy, assertSafePath: (p) => touched.push(`guard:${p}`) });
  touched.length = 0;
  const hostile = ['../escape', 'chan_team/../../x', 'chan_..', 'CON', 'chan_project_a\\b', 'chan_team\u0000',
    `chan_project_${'a'.repeat(129)}`, 'chan_dm_xyz', 'chan_Team', '__proto__', 'chan_project_'];
  for (const channelId of hostile) {
    assertFailure(await store.createChannel({ channelId }), FORBIDDEN, 'team_chat_not_found');
    assertFailure(await fx.post(store, { channelId }), FORBIDDEN, 'team_chat_not_found');
    assertFailure(store.history(channelId, { limit: 1 }), FORBIDDEN, 'team_chat_not_found');
    assertFailure(await store.markRead({ channelId, actorId: ALICE, seq: 1 }), FORBIDDEN, 'team_chat_not_found');
  }
  assert.deepEqual(touched, []);
  // Ids that differ only by case would share one directory on Windows.
  await fx.createChannel(store, 'chan_project_abc');
  assertFailure(await store.createChannel({ channelId: 'chan_project_ABC' }), INVALID, 'team_chat_request_invalid');
});

test('a junction or link in the store path fails closed', { skip: process.platform !== 'win32' && 'junctions are a Windows case' }, async (t) => {
  const fx = createChatFixture(t);
  const elsewhere = fs.mkdtempSync(path.join(fx.profileDir, 'elsewhere-'));
  fs.writeFileSync(path.join(elsewhere, 'index.json'), JSON.stringify({ schema_version: SCHEMA_VERSION, channels: [] }));
  fs.symlinkSync(elsewhere, fx.chatDir, 'junction');
  const store = new (require('../../services/host/team-chat-store').TeamChatStore)({ profileDir: fx.profileDir });
  assertFailure(store.open(), PERSISTENCE, 'team_chat_store_failed');
});

// ------------------------------------------------------------ first load (slice 2a-3b)

// Ten messages in five segments of chan_team, one in another channel, then a
// fresh store on the same profile with a hand-driven scheduler and a count of
// the segment files each channel reads.
async function largeChannel(t) {
  const fx = createChatFixture(t, { limits: { segmentMaxMessages: 2 } });
  const writer = fx.openStore();
  await fx.createChannel(writer);
  await fx.createChannel(writer, 'chan_project_other');
  for (let i = 0; i < 10; i += 1) await fx.postOk(writer, { text: `m${i}` });
  await fx.postOk(writer, { channelId: 'chan_project_other', text: 'other' });
  await writer.settled();
  const gates = [];
  const segmentReads = { chan_team: 0, chan_project_other: 0 };
  // `failing` names one segment file whose read fails transiently while set.
  const reads = { failing: null };
  const store = fx.openStore({
    yieldTo: () => new Promise((resolve) => { gates.push(resolve); }),
    fileOps: { ...fx.fileOps, readJson(filePath, options) {
      const [channel, name] = path.relative(fx.chatDir, filePath).split(path.sep);
      if (name && name.startsWith('seg-')) segmentReads[channel] += 1;
      if (reads.failing === `${channel}/${name}`) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fx.fileOps.readJson(filePath, options);
    } },
  });
  const release = async (done) => {
    for (let i = 0; i < 100 && !done(); i += 1) {
      gates.shift()?.();
      await turn();
    }
  };
  return { fx, store, gates, segmentReads, release, reads };
}

test('the first load yields between segments: another channel is answered while a large one loads', async (t) => {
  const { store, gates, segmentReads, release } = await largeChannel(t);
  const first = store.ensureLoaded('chan_team');
  const second = store.ensureLoaded('chan_team');
  assert.equal(first, second, 'concurrent first accesses share one load');
  assert.equal(store.isLoading('chan_team'), true);
  assert.equal(gates.length, 1, 'parked after the first segment');
  assert.equal(segmentReads.chan_team, 1);

  const other = store.history('chan_project_other', { limit: 5 });
  assert.deepEqual(other.messages.map((message) => message.text), ['other'], 'answered during the load');
  assert.equal(store.isLoading('chan_team'), true, 'the large channel is still loading');

  await release(() => !store.isLoading('chan_team'));
  await first;
  assert.equal(segmentReads.chan_team, 5, 'one read per segment: one load');
  assert.deepEqual(store.history('chan_team', { limit: 2 }).messages.map((message) => message.text), ['m8', 'm9']);
  assert.equal(segmentReads.chan_team, 5, 'the loaded index serves the read (the head is in memory)');
});

test('a post during the first load waits for it and lands after it with the next seq', async (t) => {
  const { fx, store, release } = await largeChannel(t);
  const loading = store.ensureLoaded('chan_team');
  let posted = null;
  const pending = fx.post(store, { text: 'during the load' }).then((result) => { posted = result; return result; });
  await turn();
  await turn();
  assert.equal(posted, null, 'the post waits for the load');
  await release(() => posted !== null);
  await loading;
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.seq, 11);
  assert.equal(store.history('chan_team', { limit: 1 }).messages[0].text, 'during the load');
  assert.equal(fx.openStore().channelInfo('chan_team').last_seq, 11);
});

test('a retention pass and settled() wait for a load in flight', async (t) => {
  const { store, release } = await largeChannel(t);
  void store.ensureLoaded('chan_team');
  let swept = false;
  let settled = false;
  const sweep = store.applyRetention().then((result) => { swept = result.ok; });
  const drained = store.settled().then(() => { settled = true; });
  await turn();
  assert.deepEqual([swept, settled], [false, false]);
  await release(() => swept && settled);
  await Promise.all([sweep, drained]);
  assert.deepEqual([swept, settled], [true, true]);
});

test('a synchronous read during the load wins; the stepwise load is dropped unassigned', async (t) => {
  const { store, release } = await largeChannel(t);
  const loading = store.ensureLoaded('chan_team');
  const read = store.history('chan_team', { limit: 100 });
  assert.equal(read.messages.length, 10);
  const info = store.channelInfo('chan_team');
  await release(() => !store.isLoading('chan_team'));
  await loading;
  assert.deepEqual(store.channelInfo('chan_team'), info);
  assert.equal(store.history('chan_team', { limit: 100 }).messages.length, 10);
});

test('an already deleted message answers its tombstone and says so; a failed post after a prune carries the prune', async (t) => {
  const { fx, store } = await seeded(t, { segmentMaxMessages: 1, maxAgeMs: 60_000 });
  const first = await fx.postOk(store, { text: 'old one' });
  const deleted = await fx.del(store, { messageId: first.message_id });
  assert.equal(deleted.already_deleted, undefined);
  const again = await fx.del(store, { messageId: first.message_id });
  assert.deepEqual([again.ok, again.rev, again.already_deleted], [true, deleted.rev, true]);

  for (let i = 0; i < 3; i += 1) await fx.postOk(store, { text: `old ${i}` });
  fx.advance(120_000);
  fx.control.failWrite = (relative) => relative.startsWith('chan_team/seg-');
  const failed = await fx.post(store, { text: 'needs room' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.reason, 'team_chat_store_failed');
  assert.ok(Array.isArray(failed.pruned) && failed.pruned.length === 1, 'the committed prune is reported');
  assert.equal(failed.pruned[0].channel_id, 'chan_team');
  assert.equal(failed.pruned[0].floor_seq, store.channelInfo('chan_team').floor_seq);
});

test('a kept load failure expires after a few seconds and a new load drops it; the next read loads again', async (t) => {
  const { fx, store, release, reads } = await largeChannel(t);
  // A failed stepwise load, never followed by a read that takes its failure.
  reads.failing = 'chan_team/seg-3.json';
  const failed = store.ensureLoaded('chan_team');
  await release(() => !store.isLoading('chan_team'));
  await failed;
  reads.failing = null; // the disk recovered
  fx.advance(10_000);
  const later = store.history('chan_team', { limit: 2 });
  assert.equal(later.ok, true, 'an old failure is not answered hours later');
  assert.deepEqual(later.messages.map((message) => message.text), ['m8', 'm9']);

  // A second store: a new load of the channel drops the failure kept from the last one.
  const second = await largeChannel(t);
  second.reads.failing = 'chan_team/seg-3.json';
  await Promise.all([second.store.ensureLoaded('chan_team'), second.release(() => !second.store.isLoading('chan_team'))]);
  second.reads.failing = null;
  const again = second.store.ensureLoaded('chan_team');
  assert.equal(second.store.isLoading('chan_team'), true, 'a new load is in flight');
  assert.equal(second.store.history('chan_team', { limit: 2 }).ok, true, 'the new load dropped the kept failure');
  await Promise.all([again, second.release(() => !second.store.isLoading('chan_team'))]);
});
