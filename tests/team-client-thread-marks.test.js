'use strict';

// Row 123 slice E59 in main: each followed thread's own unread count in the chat cache (from the overview, raised by
// a live reply in a followed thread, cleared by a thread mark's answer), the thread mark's own coalescer, and an
// older host. Against the real host chat composition behind a fake connection manager, on an injected clock.

const assert = require('node:assert/strict');
const test = require('node:test');

const { ME, OTHER, createChatFakeHost, startChats, tempDir, writeMembership } = require('./helpers/team-chat-fake-host');
const { createFakeTimers } = require('./helpers/fake-timers');
const counts = require('../services/team/chat-thread-counts');

async function setup(t, { overview = null } = {}) {
  const host = await createChatFakeHost(t);
  const userData = tempDir(t, 'jenny-team-thread-marks-');
  const teamId = writeMembership(userData).team_id;
  const timers = createFakeTimers();
  const started = startChats(t, host, { userData, teamId, timers, now: timers.now });
  const s = { host, teamId, ...started };
  s.call = (method, payload = {}) => s.chats.handle(method, { team_id: teamId, ...payload });
  s.sent = (operation) => s.manager.calls.filter((call) => call.operation === operation);
  s.row = () => s.chats.cacheOf(teamId).channels.find((channel) => channel.channel_id === 'chan_team');
  s.settle = async () => { for (let round = 0; round < 5; round += 1) await s.chats.idle(teamId); };
  s.reply = (member, root, text, extra = {}) => host.postAs(member, text, { thread_root_id: root.message_id, ...extra });
  s.hostMark = (params) => host.dispatch(ME, 'team.chat.mark_read', { channel_id: 'chan_team', ...params });
  if (overview) s.manager.hook = async ({ operation, dispatch }) => (operation === 'team.chat.overview' ? overview(await dispatch()) : null);
  return s;
}

const thread = (root, unread, mention = false) => ({ root_id: root.message_id, unread, mention });

test('the overview\'s thread counts are held; a channel read to the end keeps them', async (t) => {
  const s = await setup(t);
  const root = await s.host.postAs(ME, 'my root');
  await s.reply(OTHER, root, 'one');
  const last = await s.reply(OTHER, root, `<@${ME.member_id}> two`);
  await s.hostMark({ seq: last.seq });
  assert.equal((await s.call('chatOverview')).ok, true);
  assert.deepEqual([s.row().unread, s.row().mention, s.row().threads], [2, true, [thread(root, 2, true)]]);
  // Another timeline message, then this member reads the channel to the end: only the timeline message clears.
  const timeline = await s.host.postAs(OTHER, 'timeline');
  await s.settle();
  assert.equal(s.row().unread, 3);
  assert.deepEqual(await s.call('chatMarkRead', { channel_id: 'chan_team', seq: timeline.seq }),
    { ok: true, last_read_seq: timeline.seq });
  assert.deepEqual([s.row().unread, s.row().mention, s.row().threads], [2, true, [thread(root, 2, true)]]);
});

test('a live reply in a followed thread raises the thread and the channel; in another thread nothing', async (t) => {
  const s = await setup(t);
  const mine = await s.host.postAs(ME, 'my root');
  const theirs = await s.host.postAs(OTHER, 'their root');
  await s.hostMark({ seq: theirs.seq });
  assert.equal((await s.call('chatOverview')).ok, true);
  assert.deepEqual([s.row().unread, s.row().threads], [0, []]);
  // The cache never saw `mine` (no channel opened): the root event the host sends after the reply teaches it.
  await s.reply(OTHER, mine, 'a reply to you');
  await s.reply(OTHER, theirs, 'a reply in a thread you do not follow');
  await s.settle();
  assert.deepEqual([s.row().unread, s.row().threads], [1, [thread(mine, 1)]]);
  const pushed = s.pushes.filter((push) => push.type === 'channels' && push.partial).at(-1);
  assert.deepEqual(pushed.channels[0].threads, [thread(mine, 1)], 'the renderer hears of it');
  // A reply that names you starts the follow and counts at once; the reply held back for that thread came before
  // you were named, so it does not count (the host's follow starts at the naming reply too: E59 fix 21).
  await s.reply(OTHER, theirs, `<@${ME.member_id}> now you`);
  await s.settle();
  assert.deepEqual([s.row().unread, s.row().mention], [2, true]);
  assert.deepEqual(s.row().threads, [thread(mine, 1), thread(theirs, 1, true)]);
  const overview = (await s.host.dispatch(ME, 'team.chat.overview', {})).channels[0];
  assert.deepEqual([overview.unread, overview.threads.length], [2, 2], 'the host counts the same');
  // Your own reply never counts.
  await s.host.postAs(ME, 'mine', { thread_root_id: mine.message_id });
  await s.settle();
  assert.equal(s.row().unread, 2);
});

test('a thread mark clears its thread, lowers the channel and leaves the channel mark alone', async (t) => {
  const s = await setup(t);
  const root = await s.host.postAs(ME, 'root');
  const other = await s.host.postAs(ME, 'other root');
  await s.reply(OTHER, root, `<@${ME.member_id}> one`);
  const last = await s.reply(OTHER, root, 'two');
  await s.reply(OTHER, other, 'three');
  assert.equal((await s.call('chatOverview')).ok, true);
  await s.call('chatMarkRead', { channel_id: 'chan_team', seq: last.seq + 1 });
  assert.deepEqual([s.row().unread, s.row().mention], [3, true]);
  const answer = await s.call('chatMarkRead', { channel_id: 'chan_team', seq: last.seq, thread_root_id: root.message_id });
  assert.deepEqual(answer, { ok: true, last_read_seq: last.seq + 1, thread_read_seq: last.seq });
  assert.deepEqual(s.sent('team.chat.mark_read').at(-1).params,
    { channel_id: 'chan_team', seq: last.seq, thread_root_id: root.message_id });
  assert.deepEqual([s.row().unread, s.row().mention, s.row().last_read_seq], [1, false, last.seq + 1]);
  assert.deepEqual(s.row().threads, [thread(other, 1)]);
  // The next overview agrees with the host.
  s.timers.tick(5000);
  assert.equal((await s.call('chatOverview')).ok, true);
});

test('thread marks are coalesced on their own window and never delay a channel mark', async (t) => {
  const s = await setup(t);
  const root = await s.host.postAs(ME, 'root');
  const replies = [];
  for (let n = 1; n <= 3; n += 1) replies.push(await s.reply(OTHER, root, `reply ${n}`));
  assert.equal((await s.call('chatOverview')).ok, true);
  const marks = () => s.sent('team.chat.mark_read').map((call) => [call.params.seq, call.params.thread_root_id || null]);
  const mark = (seq) => s.call('chatMarkRead', { channel_id: 'chan_team', seq, thread_root_id: root.message_id });
  assert.equal((await mark(replies[0].seq)).thread_read_seq, replies[0].seq, 'the first goes at once');
  const held = [mark(replies[2].seq), mark(replies[1].seq)];
  const channel = await s.call('chatMarkRead', { channel_id: 'chan_team', seq: 1 });
  assert.deepEqual(channel, { ok: true, last_read_seq: 1 }, 'a channel mark goes at once inside the thread window');
  assert.deepEqual(marks(), [[replies[0].seq, root.message_id], [1, null]]);
  s.timers.tick(2000);
  for (const answer of await Promise.all(held)) assert.equal(answer.thread_read_seq, replies[2].seq);
  assert.deepEqual(marks().slice(2), [[replies[2].seq, root.message_id]], 'one trailing send with the highest seq');
  assert.deepEqual(s.row().threads, []);
  // A lost answer changes nothing; the next mark goes again.
  await s.reply(OTHER, root, 'four');
  await s.settle();
  s.manager.hook = async ({ operation, params }) => (operation === 'team.chat.mark_read' && params.thread_root_id
    ? { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } } : null);
  s.timers.tick(2000);
  assert.equal((await mark(replies[2].seq + 5)).ok, false);
  assert.deepEqual(s.row().threads, [thread(root, 1)]);
  s.manager.hook = null;
  s.timers.tick(2000);
  assert.equal((await mark(replies[2].seq + 5)).ok, true);
  assert.deepEqual(s.row().threads, []);
});

test('an older host (no thread list) shows no thread counts and a live reply raises nothing', async (t) => {
  const s = await setup(t, { overview: (answer) => ({ ...answer,
    channels: answer.channels.map(({ threads: _threads, ...row }) => row) }) });
  const root = await s.host.postAs(ME, 'root');
  await s.reply(OTHER, root, 'one');
  await s.hostMark({ seq: 99 });
  assert.equal((await s.call('chatOverview')).ok, true);
  assert.equal(Object.hasOwn(s.row(), 'threads'), false);
  const before = s.row().unread;
  await s.reply(OTHER, root, 'two');
  await s.settle();
  assert.deepEqual([s.row().unread, Object.hasOwn(s.row(), 'threads')], [before, false]);
  // Reading the channel to the end zeroes the row as before.
  await s.host.postAs(OTHER, 'timeline');
  await s.settle();
  await s.call('chatMarkRead', { channel_id: 'chan_team', seq: 999 });
  assert.equal(s.row().unread, 0);
});

test('a hostile thread list is held empty; a follow answer teaches the cache', async (t) => {
  const s = await setup(t, { overview: (answer) => ({ ...answer,
    channels: answer.channels.map((row) => ({ ...row, threads: [{ root_id: '<b>x</b>', unread: 1, mention: false }] })) }) });
  const root = await s.host.postAs(OTHER, 'their root');
  assert.equal((await s.call('chatOverview')).ok, true);
  assert.deepEqual(s.row().threads, []);
  assert.deepEqual(await s.call('chatFollow', { channel_id: 'chan_team', root_id: root.message_id, on: true }),
    { ok: true, root_id: root.message_id, on: true });
  await s.reply(OTHER, root, 'now it counts');
  await s.settle();
  assert.deepEqual(s.row().threads, [thread(root, 1)]);
  const page = await s.call('chatThread', { channel_id: 'chan_team', root_id: root.message_id });
  assert.deepEqual([page.following, typeof page.read_seq], [true, 'number']);
});

test('an answered unfollow takes the thread\'s count and mention off the row and tells the renderer', async (t) => {
  const s = await setup(t);
  const root = await s.host.postAs(ME, 'root');
  await s.reply(OTHER, root, `<@${ME.member_id}> one`);
  const last = await s.reply(OTHER, root, 'two');
  await s.hostMark({ seq: last.seq });
  assert.equal((await s.call('chatOverview')).ok, true);
  assert.deepEqual([s.row().unread, s.row().mention, s.row().threads], [2, true, [thread(root, 2, true)]]);
  const pushes = s.pushes.length;
  assert.equal((await s.call('chatFollow', { channel_id: 'chan_team', root_id: root.message_id, on: false })).ok, true);
  assert.deepEqual([s.row().unread, s.row().mention, s.row().threads], [0, false, []]);
  assert.ok(s.pushes.slice(pushes).some((push) => push.type === 'channels' && push.partial), 'the renderer hears of it');
  s.timers.tick(5000);
  assert.equal((await s.call('chatOverview')).ok, true);
  assert.deepEqual([s.row().unread, s.row().threads], [0, []], 'the host agrees');
});

test('a thread the row does not list: its page and its mark take its replies off the row\'s count', async (t) => {
  // The host lists at most 20 threads a row; here it lists none, as past that bound.
  const s = await setup(t, { overview: (answer) => ({ ...answer, channels: answer.channels.map((row) => ({ ...row, threads: [] })) }) });
  const root = await s.host.postAs(ME, 'root');
  await s.reply(OTHER, root, 'one');
  const last = await s.reply(OTHER, root, `<@${ME.member_id}> two`);
  await s.hostMark({ seq: last.seq });
  assert.equal((await s.call('chatOverview')).ok, true);
  assert.deepEqual([s.row().unread, s.row().mention, s.row().threads], [2, true, []]);
  const page = await s.call('chatThread', { channel_id: 'chan_team', root_id: root.message_id });
  assert.equal(page.read_seq, 0, 'pinned where the channel mark stood');
  const answer = await s.call('chatMarkRead', { channel_id: 'chan_team', seq: last.seq, thread_root_id: root.message_id });
  assert.equal(answer.thread_read_seq, last.seq);
  assert.deepEqual([s.row().unread, s.row().mention], [0, false]);
});

// ------------------------------------------------------------ the pure transitions (chat-thread-counts.js)

const ROOT = (n) => `msg_${String(n).padStart(26, '0')}`;
const SELF = ME.member_id;
const row = (over = {}) => ({ channel_id: 'chan_team', unread: 0, mention: false, unread_capped: false, last_read_seq: 0,
  last_seq: 0, threads: new Map(), own_mention: false, ...over });
const replyRecord = (root, seq, over = {}) => ({ id: ROOT(9000 + seq), seq, thread_root_id: ROOT(root), deleted: null,
  author: { kind: 'member', member_id: OTHER.member_id }, mentions: [], ...over });
const knowsAll = () => { const known = counts.createFollowKnowledge(); known.follows = () => true; known.implicit = () => {}; return known; };

test('the row holds at most 20 threads; a thread past it still counts and its mark still takes it off', () => {
  assert.equal(counts.THREADS_MAX, 20);
  const list = Array.from({ length: 21 }, (_, n) => ({ root_id: ROOT(n), unread: 1, mention: false }));
  assert.equal(counts.heldThreads({ threads: list }).size, 0, 'a list past the bound is held empty');
  const channel = row();
  const known = knowsAll();
  for (let n = 0; n < 21; n += 1) counts.countReply(channel, replyRecord(n, n + 1), SELF, known);
  assert.deepEqual([channel.unread, counts.publicThreads(channel).length, channel.overflow.size], [21, 20, 1]);
  assert.equal(counts.clearThread(channel, ROOT(20), 21), true);
  assert.deepEqual([channel.unread, channel.overflow.size], [20, 0]);
});

test('a thread keeps at most 100 live replies and the row counts only those kept', () => {
  assert.equal(counts.LIVE_MAX, 100);
  const channel = row();
  const known = knowsAll();
  for (let seq = 1; seq <= 101; seq += 1) counts.countReply(channel, replyRecord(1, seq), SELF, known);
  assert.deepEqual([channel.unread, channel.threads.get(ROOT(1)).live.length], [100, 100]);
});

test('replies in threads not yet known wait for at most 64 roots; the knowledge holds at most 200 roots', () => {
  assert.deepEqual([counts.PENDING_MAX, counts.KNOWN_MAX], [64, 200]);
  const channel = row();
  const known = counts.createFollowKnowledge();
  for (let n = 0; n < 65; n += 1) counts.countReply(channel, replyRecord(n, n + 1), SELF, known);
  assert.deepEqual([channel.pending.size, channel.pending.has(ROOT(0)), channel.unread], [64, false, 0]);
  for (let n = 0; n < 201; n += 1) known.learn('chan_team', ROOT(n), true, false);
  assert.deepEqual([known.follows('chan_team', ROOT(0)), known.follows('chan_team', ROOT(1))], [undefined, true]);
});

test('own_mention: the overview flag is the timeline\'s unless a thread also names you', () => {
  const held = (mention) => new Map([[ROOT(1), { base_unread: 1, base_mention: mention, live: [] }]]);
  assert.equal(counts.ownMentionOf({ mention: false }, held(true)), false);
  assert.equal(counts.ownMentionOf({ mention: true }, null), true, 'an older host: the flag is the row\'s own');
  assert.equal(counts.ownMentionOf({ mention: true }, held(true)), null, 'cannot tell');
  assert.equal(counts.ownMentionOf({ mention: true }, held(false)), true);
});

test('a thread mark never clears a mention the timeline holds; a read thread clears its own while the timeline is unread', () => {
  const threads = () => new Map([[ROOT(1), { base_unread: 1, base_mention: true, live: [] }]]);
  const timelineNamed = row({ unread: 2, mention: true, last_read_seq: 1, last_seq: 5, threads: threads(), own_mention: true });
  counts.clearThread(timelineNamed, ROOT(1), 5);
  assert.deepEqual([timelineNamed.unread, timelineNamed.mention], [1, true]);
  const unknown = row({ unread: 2, mention: true, last_read_seq: 1, last_seq: 5, threads: threads(), own_mention: null });
  counts.clearThread(unknown, ROOT(1), 5);
  assert.equal(unknown.mention, true, 'null is taken as true');
  const threadOnly = row({ unread: 2, mention: true, last_read_seq: 1, last_seq: 5, threads: threads(), own_mention: false });
  counts.clearThread(threadOnly, ROOT(1), 5);
  assert.deepEqual([threadOnly.unread, threadOnly.mention], [1, false], 'the timeline message is still unread, unnamed');
});
