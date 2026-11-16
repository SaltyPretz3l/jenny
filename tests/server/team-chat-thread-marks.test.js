'use strict';

// Row 123 slice E59: a thread's own read mark on the host. The read state's version 2 and its upgrade, a
// channel-bottom read that no longer reads thread replies, `team.chat.mark_read` with `thread_root_id`, the rule
// for a thread followed with no mark, the follow list's bound, the overview's thread list and its bounds.

const assert = require('node:assert/strict');
const test = require('node:test');

const { overviewChannels, THREADS_PER_OVERVIEW, THREADS_PER_ROW } = require('../../services/host/team-chat-pages');
const { LIMITS, validateReadDoc } = require('../../services/host/team-chat-schema');
const marks = require('../../services/host/team-chat-thread-marks');
const { followedWith } = require('../../services/host/team-chat-read-state');
const { createChatFixture, ALICE, BOB } = require('./helpers/team-chat-fixture');
const { createTeamChatCommandsFixture } = require('./helpers/team-chat-commands-fixture');

const everyone = () => new Set([ALICE, BOB]);
const overviewOf = async (store, memberId) => (await overviewChannels(store, memberId, () => true, everyone)).channels[0];

async function storeWith(t) {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  await fx.createChannel(store);
  const say = (actorId, text = 'hello', extra = {}) => fx.postOk(store, { actorId, deviceId: `device_${actorId.slice(7)}1`,
    text, ...extra });
  return { fx, store, say };
}

// ------------------------------------------------------------ the read state's version 2

test('a version 1 read state is carried forward with null marks: nobody sees a burst of new replies', async (t) => {
  const { fx, store, say } = await storeWith(t);
  const root = await say(ALICE, 'root');
  await say(BOB, 'reply 1', { threadRootId: root.message_id });
  await say(BOB, 'reply 2', { threadRootId: root.message_id });
  await say(BOB, 'timeline');
  const other = await say(BOB, 'a root Alice follows by hand');
  await say(BOB, 'reply 3', { threadRootId: other.message_id });
  // As a 2a-1 host wrote it: Alice read to seq 4, follows `other` explicitly.
  fx.writeDoc('chan_team/read.json', { schema_version: 1, channel_id: 'chan_team', members: [{ member_id: ALICE,
    last_read_seq: 4, notify: 'mentions', followed: [{ root_id: other.message_id, on: true }], updated_at: 1 }] });
  const reopened = fx.openStore();
  const row = await overviewOf(reopened, ALICE);
  assert.deepEqual([row.unread, row.mention], [2, false], 'the root after seq 4 and reply 3; nothing before the mark');
  assert.deepEqual(row.threads, [{ root_id: other.message_id, unread: 1, mention: false }]);
  const state = reopened.readState('chan_team', ALICE);
  assert.deepEqual(state.followed, [{ root_id: other.message_id, on: true, read_seq: null }]);

  // A write carries it forward as version 2; a store reading it again accepts it (round trip).
  assert.equal((await reopened.markRead({ channelId: 'chan_team', actorId: ALICE, seq: 5 })).ok, true);
  const written = fx.readDoc('chan_team/read.json');
  assert.equal(written.schema_version, 2);
  assert.equal(validateReadDoc(written, 'chan_team').ok, true);
  const again = fx.openStore();
  assert.equal(again.readState('chan_team', ALICE).last_read_seq, 5);
  void store;
});

test('version 2 items are closed: an unfollowed thread holds no mark, an item with no choice holds one', () => {
  const doc = (followed) => ({ schema_version: 2, channel_id: 'chan_team', members: [{ member_id: ALICE, last_read_seq: 0,
    notify: 'all', followed, updated_at: 0 }] });
  const id = 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  for (const item of [{ root_id: id, on: true, read_seq: null }, { root_id: id, on: true, read_seq: 3 },
    { root_id: id, on: false, read_seq: null }, { root_id: id, on: null, read_seq: 0 }]) {
    assert.equal(validateReadDoc(doc([item]), 'chan_team').ok, true, JSON.stringify(item));
  }
  for (const item of [{ root_id: id, on: false, read_seq: 2 }, { root_id: id, on: null, read_seq: null },
    { root_id: id, on: true }, { root_id: id, on: true, read_seq: -1 }, { root_id: id, on: 'yes', read_seq: 1 },
    { root_id: id, on: true, read_seq: 1, extra: 1 }]) {
    assert.equal(validateReadDoc(doc([item]), 'chan_team').ok, false, JSON.stringify(item));
  }
  const v1 = { ...doc([{ root_id: id, on: true }]), schema_version: 1 };
  assert.equal(validateReadDoc(v1, 'chan_team').ok, true);
  assert.equal(validateReadDoc({ ...v1, members: [{ ...v1.members[0], followed: [{ root_id: id, on: true, read_seq: 1 }] }] },
    'chan_team').ok, false, 'version 1 has no marks');
});

test('the worst-case read state (64 members by 200 marked threads) fits its byte bound', () => {
  const id = (n) => `msg_${String(n).padStart(26, '0')}`;
  const doc = { schema_version: 2, channel_id: 'chan_team', members: Array.from({ length: LIMITS.MEMBERS_MAX }, (_, m) => ({
    member_id: `member_${String(m).padStart(60, 'x')}`, last_read_seq: 2_048_000, notify: 'mentions',
    followed: Array.from({ length: LIMITS.FOLLOWED_MAX }, (_, n) => ({ root_id: id(m * 1000 + n), on: true, read_seq: 2_047_999 })),
    updated_at: 1_800_000_000_000 })) };
  assert.equal(validateReadDoc(doc, 'chan_team').ok, true);
  const bytes = Buffer.byteLength(JSON.stringify(doc));
  assert.ok(bytes < LIMITS.READ_MAX_BYTES, `${bytes} bytes`);
  assert.ok(bytes > 900_000 && bytes < 960_000, `measured ${bytes} bytes (the schema comment says about 940 KB)`);
});

// ------------------------------------------------------------ channel mark and thread mark

test('a channel-bottom read leaves followed thread replies counted and their mention kept', async (t) => {
  const { store, say } = await storeWith(t);
  const root = await say(ALICE, 'root');
  await say(BOB, 'look', { threadRootId: root.message_id, mentions: [ALICE] });
  await say(BOB, 'more', { threadRootId: root.message_id });
  const timeline = await say(BOB, 'timeline');
  assert.equal((await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: timeline.seq })).changed, true);
  const row = await overviewOf(store, ALICE);
  assert.deepEqual([row.unread, row.mention, row.last_read_seq], [2, true, timeline.seq]);
  assert.deepEqual(row.threads, [{ root_id: root.message_id, unread: 2, mention: true }]);
  // The thread was pinned at the old channel mark.
  assert.deepEqual(store.readState('chan_team', ALICE).followed, [{ root_id: root.message_id, on: null, read_seq: 0 }]);
});

test('a thread mark clears that thread only and moves nothing else', async (t) => {
  const { store, say } = await storeWith(t);
  const first = await say(ALICE, 'first root');
  const second = await say(ALICE, 'second root');
  await say(BOB, 'a', { threadRootId: first.message_id });
  const lastOfFirst = await say(BOB, 'b', { threadRootId: first.message_id, mentions: [ALICE] });
  await say(BOB, 'c', { threadRootId: second.message_id });
  const timeline = await say(BOB, 'timeline');
  await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: timeline.seq });
  const marked = await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: lastOfFirst.seq,
    threadRootId: first.message_id });
  assert.deepEqual(marked, { ok: true, last_read_seq: timeline.seq, thread_read_seq: lastOfFirst.seq, changed: true });
  const row = await overviewOf(store, ALICE);
  assert.deepEqual([row.unread, row.mention, row.last_read_seq], [1, false, timeline.seq]);
  assert.deepEqual(row.threads, [{ root_id: second.message_id, unread: 1, mention: false }]);
  // Lower or equal marks change nothing; a seq past the thread's end is held to its newest reply.
  assert.equal((await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: 1, threadRootId: first.message_id })).changed, false);
  const past = await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: 9999, threadRootId: second.message_id });
  assert.equal(past.thread_read_seq, lastOfFirst.seq + 1);
  assert.equal((await overviewOf(store, ALICE)).unread, 0);
  // Both threads' replies lie under the channel mark and are read: their marks are dropped again.
  assert.deepEqual(store.readState('chan_team', ALICE).followed, []);
});

test('a mark part way into a thread keeps the replies after it unread', async (t) => {
  const { store, say } = await storeWith(t);
  const root = await say(ALICE, 'root');
  const replies = [];
  for (const text of ['a', 'b', 'c', 'd']) replies.push(await say(BOB, text, { threadRootId: root.message_id }));
  const timeline = await say(BOB, 'timeline');
  await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: timeline.seq });
  // Every reply lies under the channel mark; the thread is pinned at 0. Read to the second reply only.
  const marked = await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: replies[1].seq, threadRootId: root.message_id });
  assert.equal(marked.thread_read_seq, replies[1].seq);
  assert.deepEqual(store.readState('chan_team', ALICE).followed, [{ root_id: root.message_id, on: null, read_seq: replies[1].seq }]);
  assert.deepEqual((await overviewOf(store, ALICE)).threads, [{ root_id: root.message_id, unread: 2, mention: false }],
    'replies c and d, after the mark, stay unread');
  await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: replies[3].seq, threadRootId: root.message_id });
  assert.deepEqual(store.readState('chan_team', ALICE).followed, [], 'read to its end under the channel mark: null again');
});

test('a reply after a thread mark counts again; your own replies never count', async (t) => {
  const { store, say } = await storeWith(t);
  const root = await say(ALICE, 'root');
  const reply = await say(BOB, 'one', { threadRootId: root.message_id });
  await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: reply.seq, threadRootId: root.message_id });
  await say(ALICE, 'mine', { threadRootId: root.message_id });
  assert.equal((await overviewOf(store, ALICE)).unread, 0);
  await say(BOB, 'two', { threadRootId: root.message_id });
  assert.deepEqual((await overviewOf(store, ALICE)).threads, [{ root_id: root.message_id, unread: 1, mention: false }]);
});

test('Mark unread on the channel does not unread a thread reply', async (t) => {
  const { store, say } = await storeWith(t);
  const root = await say(ALICE, 'root');
  const reply = await say(BOB, 'one', { threadRootId: root.message_id });
  await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: reply.seq, threadRootId: root.message_id });
  const timeline = await say(BOB, 'timeline');
  await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: timeline.seq });
  assert.equal((await overviewOf(store, ALICE)).unread, 0);
  await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: root.seq, unread: true });
  const row = await overviewOf(store, ALICE);
  assert.deepEqual([row.unread, row.threads], [1, []], 'only the timeline message after the new position');
});

// ------------------------------------------------------------ a thread followed with no mark (rule 4)

test('a thread followed with no mark starts at the channel mark: its history before it never reads as new', async (t) => {
  const { store, say } = await storeWith(t);
  const root = await say(BOB, 'Bob\'s root');
  await say(BOB, 'old reply', { threadRootId: root.message_id });
  const handRoot = await say(BOB, 'another');
  await say(BOB, 'old reply too', { threadRootId: handRoot.message_id });
  const timeline = await say(BOB, 'timeline');
  await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: timeline.seq });
  // Mentioned in a new reply: only the replies after the channel mark count.
  await say(BOB, 'over here', { threadRootId: root.message_id, mentions: [ALICE] });
  let row = await overviewOf(store, ALICE);
  assert.deepEqual(row.threads, [{ root_id: root.message_id, unread: 1, mention: true }]);
  // Followed by hand: the mark starts at the channel mark as it stands.
  assert.equal((await store.follow({ channelId: 'chan_team', actorId: ALICE, rootId: handRoot.message_id, on: true })).ok, true);
  assert.equal(store.readState('chan_team', ALICE).followed.find((item) => item.root_id === handRoot.message_id).read_seq,
    timeline.seq);
  row = await overviewOf(store, ALICE);
  assert.equal(row.unread, 1);
  // A channel read past the mention keeps it: the thread is pinned where the channel mark stood.
  await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: 999 });
  row = await overviewOf(store, ALICE);
  assert.deepEqual([row.unread, row.mention], [1, true]);
});

test('unfollowing drops the mark; following again starts from the channel mark', async (t) => {
  const { store, say } = await storeWith(t);
  const root = await say(ALICE, 'root');
  await say(BOB, 'one', { threadRootId: root.message_id });
  await store.markRead({ channelId: 'chan_team', actorId: ALICE, seq: 999 });
  assert.equal((await overviewOf(store, ALICE)).unread, 1);
  await store.follow({ channelId: 'chan_team', actorId: ALICE, rootId: root.message_id, on: false });
  assert.deepEqual(store.readState('chan_team', ALICE).followed, [{ root_id: root.message_id, on: false, read_seq: null }]);
  assert.equal((await overviewOf(store, ALICE)).unread, 0);
  await store.follow({ channelId: 'chan_team', actorId: ALICE, rootId: root.message_id, on: true });
  assert.equal((await overviewOf(store, ALICE)).unread, 0, 'the reply lies under the channel mark it started at');
});

// A loaded channel state for the pure rules: `threads` is [[root n, newest reply seq]].
const id = (n) => `msg_${String(n).padStart(26, '0')}`;
function fakeState(newest, threads, members = new Map()) {
  const byId = new Map();
  const stats = new Map();
  for (const [n, last] of threads) {
    byId.set(id(n), { id: id(n), seq: n, root: null });
    if (last) stats.set(id(n), { count: 1, last_seq: last, members });
  }
  return { doc: { next_seq: newest + 1 }, byId, entries: [], threads: stats };
}
const pin = (n, readSeq) => ({ root_id: id(n), on: null, read_seq: readSeq });

test('a pruned root drops its mark at the next write; a read thread drops its mark', () => {
  const state = fakeState(10, [[1, 0]]);
  const entry = { member_id: ALICE, last_read_seq: 5, followed: [pin(1, 2), pin(2, 3)] };
  assert.deepEqual(marks.followedAfterChannelMark(state, entry, 5, 6), [],
    'id(2) is pruned; id(1) has no reply after its mark: dropped');
});

test('a thread marked ahead of the channel mark keeps its mark while a reply lies past the new channel mark', () => {
  const state = fakeState(40, [[1, 30]]);
  const entry = { member_id: ALICE, last_read_seq: 10, followed: [pin(1, 30)] };
  assert.deepEqual(marks.followedAfterChannelMark(state, entry, 10, 20), [pin(1, 30)],
    'its reply at 30 lies under its own mark but past the new channel mark 20: dropping it would unread it');
  assert.deepEqual(marks.followedAfterChannelMark(state, entry, 10, 30), [], 'read to 30: tracks the channel mark again');
});

test('following by hand keeps a mark the thread already holds', () => {
  const state = fakeState(20, [[1, 15]]);
  const entry = { member_id: ALICE, last_read_seq: 9, followed: [pin(1, 3)] };
  assert.deepEqual(followedWith(state, entry, id(1), true), [{ root_id: id(1), on: true, read_seq: 3 }]);
  assert.deepEqual(followedWith(state, { ...entry, followed: [] }, id(1), true), [{ root_id: id(1), on: true, read_seq: 9 }],
    'with none, the channel mark as it stands');
  assert.deepEqual(followedWith(state, entry, id(1), false), [{ root_id: id(1), on: false, read_seq: null }]);
});

test('the bounds: at most 50 pins, newest reply kept; a pin never pushes out an explicit choice; 200 in all', () => {
  assert.equal(marks.PINS_MAX, 50);
  const threads = Array.from({ length: 60 }, (_, n) => [n + 1, 100 + n]);
  const state = fakeState(1000, threads);
  const pins = threads.map(([n]) => pin(n, 1));
  const kept = marks.boundFollowed(state, [{ root_id: id(0), on: true, read_seq: null }, ...pins]);
  assert.equal(kept.length, 51);
  assert.equal(kept[0].root_id, id(0), 'the explicit follow stays');
  assert.deepEqual(kept.slice(1).map((item) => item.root_id), pins.slice(10).map((item) => item.root_id),
    'the ten pins whose threads have the oldest newest reply go');

  const explicit = Array.from({ length: 190 }, (_, n) => ({ root_id: id(500 + n), on: true, read_seq: null }));
  const mixed = marks.boundFollowed(state, [...pins.slice(0, 20), ...explicit]);
  assert.equal(mixed.length, LIMITS.FOLLOWED_MAX);
  assert.equal(mixed.filter((item) => item.on === true).length, 190, 'every explicit choice stays');
  assert.deepEqual(mixed.filter((item) => item.on === null).map((item) => item.root_id), pins.slice(10, 20).map((item) => item.root_id));
  const all = Array.from({ length: LIMITS.FOLLOWED_MAX + 1 }, (_, n) => ({ root_id: id(n), on: true, read_seq: null }));
  const over = marks.boundFollowed(state, [pin(900, 1), ...all]);
  assert.deepEqual([over.length, over[0].root_id, over.some((item) => item.on === null)], [LIMITS.FOLLOWED_MAX, id(1), false],
    'past 200 explicit items the pin goes first, then the oldest explicit');
});

test('a stored mark whose thread\'s newest reply lies more than 2,000 entries back goes at the next channel mark', () => {
  assert.equal(marks.PIN_REACH, 2000);
  const state = fakeState(5000, [[1, 2999], [2, 3000], [3, 100]]);
  const entry = { member_id: ALICE, last_read_seq: 10, followed: [pin(1, 2000), pin(2, 2500),
    { root_id: id(3), on: true, read_seq: 50 }] };
  assert.deepEqual(marks.followedAfterChannelMark(state, entry, 10, 11), [pin(2, 2500), { root_id: id(3), on: true, read_seq: null }],
    'the pin 2,001 entries back is dropped, the one 2,000 back stays; the explicit follow stays and tracks the channel mark');
});

// ------------------------------------------------------------ the command

test('mark_read with thread_root_id: roots only, in this channel, followed, never with unread', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { owner, alice, bob, rae } = f.seats;
  const reasonOf = (answer) => (answer.ok ? 'ok' : answer.error.reason);
  const mark = (seat, params) => f.send(seat, 'team.chat.mark_read', { channel_id: 'chan_team', ...params });
  const root = await f.post(alice, 'root');
  const reply = await f.post(bob, `<@${rae.member_id}> see`, { thread_root_id: root.message_id });
  const quiet = await f.post(bob, 'nobody else follows this');
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_side' })).ok, true);
  await f.addToProject('project_side', 'alice');
  const elsewhere = await f.send(alice, 'team.chat.post', { channel_id: 'chan_project_side', text: 'over here' });
  assert.equal(elsewhere.ok, true);

  assert.equal(reasonOf(await mark(alice, { seq: 99, thread_root_id: elsewhere.message_id })), 'team_chat_not_found');
  assert.equal(reasonOf(await mark(alice, { seq: 99, thread_root_id: 'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV' })), 'team_chat_not_found');
  assert.equal(reasonOf(await mark(alice, { seq: 99, thread_root_id: reply.message_id })), 'team_chat_not_found');
  assert.equal(reasonOf(await mark(alice, { seq: 99, thread_root_id: root.message_id, unread: true })), 'team_chat_request_invalid');
  assert.equal(reasonOf(await mark(alice, { seq: 99, thread_root_id: 'not an id!' })), 'invalid_command_parameters',
    'the closed params schema');

  const before = f.chat.store.readState('chan_team', owner.member_id);
  assert.deepEqual(await mark(owner, { seq: 99, thread_root_id: quiet.message_id }),
    { ok: true, last_read_seq: 0, thread_read_seq: null }, 'a thread the member does not follow: ok, nothing stored');
  assert.deepEqual(f.chat.store.readState('chan_team', owner.member_id), before);

  const published = f.chatEvents().length;
  assert.deepEqual(await mark(rae, { seq: 99, thread_root_id: root.message_id }),
    { ok: true, last_read_seq: 0, thread_read_seq: reply.seq }, 'a read-only member can mark; held to the newest reply');
  assert.equal(f.chatEvents().length, published, 'a thread mark is never published');
  assert.equal((await f.send(rae, 'team.chat.thread', { channel_id: 'chan_team', root_id: root.message_id, limit: 10 })).read_seq,
    reply.seq, 'the thread answer carries the member\'s own mark');
  assert.equal(reasonOf(await f.send(bob, 'team.chat.mark_read', { channel_id: 'chan_project_side', seq: 1,
    thread_root_id: elsewhere.message_id })), 'team_chat_not_found',
    'outside the channel\'s audience: the channel is not there for Bob, as for every chat method');
});

test('an older client\'s mark_read (no thread_root_id) still answers as before', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob } = f.seats;
  const root = await f.post(alice, 'root');
  await f.post(bob, 'reply', { thread_root_id: root.message_id });
  assert.deepEqual(await f.send(alice, 'team.chat.mark_read', { channel_id: 'chan_team', seq: 2 }), { ok: true, last_read_seq: 2 });
  const row = (await f.send(alice, 'team.chat.overview')).channels[0];
  assert.deepEqual(row.threads, [{ root_id: root.message_id, unread: 1, mention: false }]);
});

// ------------------------------------------------------------ the overview's thread list

test('the overview lists at most 20 threads a row and 200 an answer; the rest still count', async () => {
  const id = (c, n) => `msg_${String(c * 1000 + n).padStart(26, '0')}`;
  const channelIds = Array.from({ length: 12 }, (_, c) => `chan_project_p${c}`);
  const fake = {
    listChannels: () => ({ ok: true, channels: channelIds.map((channelId) => ({ channel_id: channelId, kind: 'project',
      archived: false, rev: 30, last_seq: 30, floor_seq: 1, broken: null, pin_count: 0 })) }),
    readState: () => ({ ok: true, last_read_seq: 0, notify: 'mentions', followed: [] }),
    ensureLoaded: async () => {},
    readPositions: () => ({ ok: true, positions: [] }),
    recentMessages: (channelId) => ({ ok: true, more: false, messages: Array.from({ length: 25 }, (_, n) => ({ seq: 30 - n,
      root_id: id(channelIds.indexOf(channelId), n), author: { kind: 'member', member_id: BOB }, mentions: [`${n === 0 ? ALICE : BOB}`],
      deleted: false })) }),
  };
  const answer = await overviewChannels(fake, ALICE, () => true, everyone);
  const rows = answer.channels;
  assert.equal(THREADS_PER_ROW, 20);
  assert.equal(THREADS_PER_OVERVIEW, 200);
  assert.deepEqual(rows.map((row) => row.threads.length), [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 0, 0]);
  assert.ok(rows.every((row) => row.unread === 25), 'every reply still counts on its row');
  assert.deepEqual(rows[0].threads[0], { root_id: id(0, 0), unread: 1, mention: true }, 'newest first');
  const threadBytes = Buffer.byteLength(JSON.stringify(rows.map((row) => row.threads)));
  assert.ok(threadBytes < 16 * 1024, `${threadBytes} bytes of thread lists`);
});

// One channel for overviewChannels, with the store calls it makes recorded.
function overviewStore(read, messages, lastSeq) {
  const calls = { loads: 0, after: [] };
  const store = {
    listChannels: () => ({ ok: true, channels: [{ channel_id: 'chan_team', kind: 'team', archived: false, rev: 1,
      last_seq: lastSeq, floor_seq: 1, broken: null, pin_count: 0 }] }),
    readState: () => ({ ok: true, member_id: ALICE, notify: 'all', ...read }),
    ensureLoaded: async () => { calls.loads += 1; },
    readPositions: () => ({ ok: true, positions: [] }),
    recentMessages: (_channelId, options) => { calls.after.push(options.afterSeq); return { ok: true, more: false, messages }; },
  };
  return { store, calls };
}

test('the overview walk starts no further back than 2,000 entries, and a read channel with no stored mark loads nothing', async () => {
  const old = overviewStore({ last_read_seq: 4990, followed: [pin(1, 3)] }, [], 5000);
  await overviewChannels(old.store, ALICE, () => true, everyone);
  assert.deepEqual(old.calls.after, [3000], 'a mark at 3 is floored at 5,000 - 2,000');
  const recent = overviewStore({ last_read_seq: 4990, followed: [pin(1, 4500)] }, [], 5000);
  await overviewChannels(recent.store, ALICE, () => true, everyone);
  assert.deepEqual(recent.calls.after, [4500]);
  const caughtUp = overviewStore({ last_read_seq: 5000, followed: [{ root_id: id(1), on: true, read_seq: null }] }, [], 5000);
  await overviewChannels(caughtUp.store, ALICE, () => true, everyone);
  assert.deepEqual([caughtUp.calls.loads, caughtUp.calls.after], [0, []], 'every stored mark null: no load, no walk');
});

test('threads with a stored mark are listed before threads that track the channel mark', async () => {
  const replyIn = (n, seq) => ({ seq, root_id: id(n), author: { kind: 'member', member_id: BOB }, mentions: [], deleted: false });
  const messages = [replyIn(2, 30), replyIn(1, 20), replyIn(3, 10)];
  const { store } = overviewStore({ last_read_seq: 5, followed: [pin(3, 4)] }, messages, 30);
  const row = (await overviewChannels(store, ALICE, () => true, everyone)).channels[0];
  assert.deepEqual(row.threads.map((thread) => thread.root_id), [id(3), id(2), id(1)],
    'id(3) holds a stored mark: first, though its reply is the oldest; the rest newest reply first');
});
