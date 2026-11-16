'use strict';

// Order and event rules of the chat client's live state: the presence owed after
// a reconnect never holds the network loop; a changed member list reaches the
// renderer even when a channel sync then fails; typing that arrives during a
// resync is dropped, not buffered; a presence event that changes nothing, or
// fails its checks, is not pushed; the read positions of other members
// (`team_chat_read`) and the row fields `reads` and `pin_count` follow the
// overview and the events. Against the real host chat composition behind a fake
// connection manager.

const assert = require('node:assert/strict');
const test = require('node:test');

const { REACTION_EMOJI } = require('../services/host/team-chat-emoji');
const { ME, OTHER, setupChatClient, settleChats } = require('./helpers/team-chat-fake-host');

const setup = (t, hostOptions) => setupChatClient(t, { host: hostOptions, prefix: 'jenny-team-chat-order-' });

const turn = () => new Promise((resolve) => { setImmediate(resolve); });

// Polls `predicate` on real time for up to `ms`; true once it holds.
async function within(ms, predicate) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  return false;
}

const timeout = (ms) => new Promise((resolve) => { setTimeout(() => resolve('timed out'), ms).unref(); });

test('a presence answer held open after a reconnect does not hold the outbox or an open', async (t) => {
  const s = await setup(t);
  assert.equal((await s.call('chatOverview')).ok, true);
  assert.deepEqual(await s.call('presenceSet', { state: 'idle' }), { ok: true });
  s.manager.setState('reconnecting');
  await settleChats(s.chats, s.teamId, s.timers);
  const queued = await s.call('chatPost', { channel_id: 'chan_team', text: 'queued while away' });
  assert.equal(queued.ok, true);
  let release = null;
  s.manager.hook = async ({ operation, dispatch }) => (operation === 'team.presence.set'
    ? new Promise((resolve) => { release = () => resolve(dispatch()); }) : null);
  s.manager.setState('online');
  try {
    const sent = await within(3000, () => s.ofType('outbox').some((push) => push.settled
      .some((item) => item.entry_id === queued.entry_id && item.ok)));
    assert.ok(sent, 'the outbox sent while the presence answer was held');
    const opened = await Promise.race([s.call('chatHistory', { channel_id: 'chan_team' }), timeout(3000)]);
    assert.equal(opened.ok, true, `the open completed: ${JSON.stringify(opened)}`);
    assert.ok(release, 'the owed presence was sent');
  } finally {
    release?.();
  }
  await settleChats(s.chats, s.teamId, s.timers);
  assert.deepEqual(s.manager.calls.filter((call) => call.operation === 'team.presence.set').map((call) => call.params.state),
    ['idle', 'idle']);
});

test('a changed member list reaches the renderer even when a channel sync then fails', async (t) => {
  const s = await setup(t);
  assert.equal((await s.call('chatOverview')).ok, true);
  assert.equal((await s.call('chatHistory', { channel_id: 'chan_team' })).ok, true);
  await settleChats(s.chats, s.teamId, s.timers);
  s.host.members.push({ member_id: 'member_thirdCCC333', device_id: 'device_thirdCCC333', role: 'member',
    display_name: 'Tove Third' });
  s.manager.paused = true;
  await s.host.postAs(OTHER, 'missed while paused');
  s.manager.paused = false;
  s.manager.hook = async ({ operation }) => {
    if (operation === 'team.chat.sync') throw new Error('sync fault');
    return null;
  };
  s.event('resync_required', {});
  await settleChats(s.chats, s.teamId, s.timers);
  assert.ok(s.manager.calls.some((call) => call.operation === 'team.chat.sync'), 'the channel sync ran and failed');
  const last = s.ofType('members').at(-1);
  assert.ok(last, 'a members push');
  assert.deepEqual(last.members.map((member) => member.member_id).sort(),
    [OTHER.member_id, 'member_meAAAA1111', 'member_thirdCCC333'].sort());
});

test('typing during a resync is dropped, never pushed afterwards and never counted toward the buffer', async (t) => {
  const s = await setup(t);
  let release = null;
  s.manager.hook = async ({ operation, dispatch }) => (operation === 'team.chat.overview' && !release
    ? new Promise((resolve) => { release = () => resolve(dispatch()); }) : null);
  const opened = s.call('chatOverview');
  assert.ok(await within(3000, () => release !== null), 'the first overview is held');
  const typing = { channel_id: 'chan_team', thread_root_id: null, member_id: OTHER.member_id };
  for (let n = 0; n < 1000; n += 1) s.event('team_chat_typing', typing);
  await turn();
  await turn();
  for (let n = 0; n < 1001; n += 1) s.event('team_chat_typing', typing);
  await turn();
  await turn();
  s.event('team_presence', { member_id: OTHER.member_id, state: 'online', last_seen_at: '2026-11-11T10:00:00.000Z' });
  await turn();
  release();
  assert.equal((await opened).ok, true);
  await settleChats(s.chats, s.teamId, s.timers);
  assert.deepEqual(s.ofType('typing'), [], 'no typing pushed after the resync');
  assert.equal(s.manager.calls.filter((call) => call.operation === 'team.chat.overview').length, 1,
    'the typing did not overflow the buffer into a second resync');
  assert.deepEqual(s.ofType('presence').map((push) => push.member_id), [OTHER.member_id], 'presence stays buffered');
});

test('a presence event that changes nothing, or fails its checks, is not pushed', async (t) => {
  const s = await setup(t);
  assert.equal((await s.call('chatOverview')).ok, true);
  const online = { member_id: OTHER.member_id, state: 'online', last_seen_at: '2026-11-11T10:00:00.000Z' };
  s.event('team_presence', online);
  await s.chats.idle(s.teamId);
  s.event('team_presence', online);
  s.event('team_presence', { ...online, state: 'busy' });
  s.event('team_presence', { ...online, last_seen_at: 'x' });
  await s.chats.idle(s.teamId);
  assert.equal(s.ofType('presence').length, 1, 'one push for one change');
  s.event('team_presence', { ...online, state: 'away' });
  await s.chats.idle(s.teamId);
  assert.deepEqual(s.ofType('presence').map((push) => push.state), ['online', 'away']);
});

// ------------------------------------------------------------------ read positions and row fields

const THIRD = Object.freeze({ member_id: 'member_thirdCCC333', device_id: 'device_thirdCCC333', role: 'member',
  display_name: 'Tove Third' });
const rowOf = (answer, id = 'chan_team') => answer.channels.find((row) => row.channel_id === id);
const readEvent = (s, payload) => s.event('team_chat_read', { channel_id: 'chan_team', member_id: OTHER.member_id, seq: 3, ...payload });
const overviewCount = (s) => s.manager.ops().filter((op) => op === 'team.chat.overview').length;
// The host's overview with extra fields on the chan_team row.
const withRowFields = (fields) => async ({ operation, dispatch }) => {
  if (operation !== 'team.chat.overview') return null;
  const answer = await dispatch();
  return { ...answer, channels: answer.channels.map((row) => (row.channel_id === 'chan_team' ? { ...row, ...fields } : row)) };
};

// The overview of a host that sends neither `reads` nor `pin_count`: the fields are taken out of every row.
const withoutRowFields = async ({ operation, dispatch }) => {
  if (operation !== 'team.chat.overview') return null;
  const answer = await dispatch();
  return { ...answer, channels: answer.channels.map(({ reads, pin_count: pinCount, ...row }) => row) };
};

// A post the client does not see as an event: returns the event the host would have published for it.
async function unseenPost(s, text) {
  s.manager.paused = true;
  const posted = await s.host.postAs(OTHER, text);
  s.manager.paused = false;
  const page = await s.host.dispatch(ME, 'team.chat.history', { channel_id: 'chan_team', limit: 100 });
  const overview = await s.host.dispatch(ME, 'team.chat.overview', {});
  return { channel_id: 'chan_team', channel_rev: rowOf(overview).rev, message: page.messages.find((m) => m.id === posted.message_id) };
}

test('rows carry reads and pin_count from the overview, [] and null when the host sends none, and the host emoji list', async (t) => {
  const s = await setup(t);
  s.manager.hook = withoutRowFields;
  const plain = await s.call('chatOverview');
  assert.equal(plain.ok, true, JSON.stringify(plain));
  for (const row of plain.channels) {
    assert.deepEqual(row.reads, [], row.channel_id);
    assert.equal(row.pin_count, null, row.channel_id);
  }
  assert.deepEqual(plain.reaction_emoji, [...REACTION_EMOJI]);
  const first = s.ofType('channels')[0];
  assert.ok(first && first.channels.every((row) => row.reads.length === 0 && row.pin_count === null), 'the push has them too');
});

test("rows carry the host's own reads and pin_count: [] and 0 before anything is read or pinned", async (t) => {
  const s = await setup(t);
  const plain = await s.call('chatOverview');
  assert.equal(plain.ok, true, JSON.stringify(plain));
  for (const row of plain.channels) {
    assert.deepEqual(row.reads, [], row.channel_id);
    assert.equal(row.pin_count, 0, row.channel_id);
  }
});

test('reads from the overview are sorted by member id and keep listed members other than this one', async (t) => {
  const s = await setup(t, { members: [ME, OTHER, THIRD] });
  s.manager.hook = withRowFields({ pin_count: 2, reads: [{ member_id: THIRD.member_id, seq: 4 },
    { member_id: 'member_unlistedDDD444', seq: 9 }, { member_id: OTHER.member_id, seq: 3 }] });
  const answer = await s.call('chatOverview');
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(rowOf(answer).reads, [{ member_id: OTHER.member_id, seq: 3 }, { member_id: THIRD.member_id, seq: 4 }]);
  assert.equal(rowOf(answer).pin_count, 2);
  assert.deepEqual(rowOf(s.ofType('channels')[0]).reads, rowOf(answer).reads, 'the channels push carries them too');
  assert.equal(rowOf(s.ofType('channels')[0]).pin_count, 2);
  readEvent(s, { member_id: THIRD.member_id, seq: 6 });
  await s.chats.idle(s.teamId);
  assert.deepEqual(rowOf(await s.call('chatOverview')).reads,
    [{ member_id: OTHER.member_id, seq: 3 }, { member_id: THIRD.member_id, seq: 6 }], 'still no entry for the unlisted member');
});

test('malformed reads or pin_count in the overview row leave [] and null, never a guess', async (t) => {
  const s = await setup(t);
  s.manager.hook = withRowFields({ pin_count: 51, reads: [{ member_id: OTHER.member_id, seq: 3, extra: 1 }] });
  const row = rowOf(await s.call('chatOverview'));
  assert.deepEqual(row.reads, []);
  assert.equal(row.pin_count, null);
});

test("team_chat_read from another listed member updates that channel's reads and pushes the row; no resync", async (t) => {
  const s = await setup(t);
  assert.equal((await s.call('chatOverview')).ok, true);
  const overviews = overviewCount(s);
  const pushed = s.ofType('channels').length;
  readEvent(s, { seq: 3 });
  await s.chats.idle(s.teamId);
  assert.equal(overviewCount(s), overviews, 'an event with no channel_rev causes no resync');
  assert.equal(s.ofType('channels').length, pushed + 1);
  const push = s.ofType('channels').at(-1);
  assert.equal(push.partial, true);
  assert.deepEqual(push.channels.map((row) => [row.channel_id, row.reads]), [['chan_team', [{ member_id: OTHER.member_id, seq: 3 }]]]);
  assert.deepEqual(rowOf(await s.call('chatOverview')).reads, [{ member_id: OTHER.member_id, seq: 3 }]);
  readEvent(s, { seq: 5 });
  await s.chats.idle(s.teamId);
  assert.deepEqual(rowOf(await s.call('chatOverview')).reads, [{ member_id: OTHER.member_id, seq: 5 }], 'a higher position replaces it');
});

test("this member's own team_chat_read does what an answered read does", async (t) => {
  const s = await setup(t);
  await s.host.postAs(OTHER, 'one');
  await s.host.postAs(OTHER, 'two');
  const before = rowOf(await s.call('chatOverview'));
  assert.equal(before.unread, 2);
  const pushed = s.ofType('channels').length;
  readEvent(s, { member_id: ME.member_id, seq: before.last_seq });
  await s.chats.idle(s.teamId);
  const row = rowOf(await s.call('chatOverview'));
  assert.equal(row.last_read_seq, before.last_seq);
  assert.equal(row.unread, 0);
  assert.equal(s.ofType('channels').length, pushed + 1, 'the row is pushed');
  assert.deepEqual(row.reads, [], 'this member is not in their own reads');
  readEvent(s, { member_id: ME.member_id, seq: 1 });
  await s.chats.idle(s.teamId);
  assert.equal(rowOf(await s.call('chatOverview')).last_read_seq, 1, 'their own mark-unread moves the position down');
});

test('team_chat_read for an unknown channel or member, a lower or equal seq, an extra key or a bad shape changes nothing', async (t) => {
  const s = await setup(t);
  assert.equal((await s.call('chatOverview')).ok, true);
  readEvent(s, { seq: 4 });
  await s.chats.idle(s.teamId);
  const snapshot = JSON.stringify(s.chats.cacheOf(s.teamId).channels);
  const pushed = s.ofType('channels').length;
  const overviews = overviewCount(s);
  const ignored = [
    { channel_id: 'chan_project_nowhere' }, { member_id: 'member_nobodyZZZ999' }, { seq: 3 }, { seq: 4 }, { extra: 1 },
    { seq: -1 }, { seq: '9' }, { seq: 1.5 }, { channel_id: 'general' }, { member_id: 7 },
  ];
  for (const payload of ignored) readEvent(s, { seq: 9, ...payload });
  s.manager.deliver({ event_type: 'team_chat_read', cursor: s.host.nextCursor(), boot_epoch: s.host.bootEpoch(),
    channel_id: 'chan_team', member_id: OTHER.member_id });
  await s.chats.idle(s.teamId);
  assert.equal(JSON.stringify(s.chats.cacheOf(s.teamId).channels), snapshot);
  assert.equal(s.ofType('channels').length, pushed, 'nothing pushed');
  assert.equal(overviewCount(s), overviews, 'and nothing resynced');
});

test('pin_count follows message and channel events that carry an integer 0 to 50, and is kept otherwise; a resync replaces it', async (t) => {
  const s = await setup(t);
  s.manager.hook = withRowFields({ pin_count: 1, reads: [{ member_id: OTHER.member_id, seq: 2 }] });
  assert.equal(rowOf(await s.call('chatOverview')).pin_count, 1);
  const pinCount = async () => rowOf(await s.call('chatOverview')).pin_count;
  const withPins = async (value) => {
    const event = await unseenPost(s, `post for ${String(value)}`);
    s.event('team_chat_message', { ...event, ...(value === undefined ? {} : { pin_count: value }) });
    await s.chats.idle(s.teamId);
    return pinCount();
  };
  const pushed = s.ofType('channels').length;
  assert.equal(await withPins(3), 3, 'a message event sets it');
  assert.equal(s.ofType('channels').length, pushed + 1, 'and the row is pushed');
  assert.equal(await withPins(undefined), 3, 'an event without it leaves the held value');
  for (const bad of [51, -1, '4', 2.5, null]) assert.equal(await withPins(bad), 3, `bad value ${String(bad)}`);
  assert.equal(await withPins(0), 0, 'zero is a count');
  const rev = rowOf(await s.call('chatOverview')).rev;
  s.event('team_chat_channel', { channel_id: 'chan_team', channel_rev: rev + 1, reason: 'archived', floor_seq: 0, pin_count: 5 });
  await s.chats.idle(s.teamId);
  assert.equal(await pinCount(), 5, 'a channel event sets it');
  s.manager.hook = null;
  s.event('resync_required', { reason: 'replay_unavailable' });
  await settleChats(s.chats, s.teamId, s.timers);
  const after = rowOf(await s.call('chatOverview'));
  assert.equal(after.pin_count, 0, 'a resync replaces pin_count with the host\'s own');
  assert.deepEqual(after.reads, [], 'and reads');
});

test('a team_chat_read from a member the list does not hold changes nothing and pushes nothing', async (t) => {
  const s = await setup(t);
  assert.equal((await s.call('chatOverview')).ok, true);
  assert.equal(s.chats.cacheOf(s.teamId).members.some((member) => member.member_id === THIRD.member_id), false);
  const snapshot = JSON.stringify(s.chats.cacheOf(s.teamId).channels);
  const pushed = s.ofType('channels').length;
  readEvent(s, { member_id: THIRD.member_id, seq: 5 });
  await s.chats.idle(s.teamId);
  assert.equal(JSON.stringify(s.chats.cacheOf(s.teamId).channels), snapshot);
  assert.deepEqual(rowOf(await s.call('chatOverview')).reads, []);
  assert.equal(s.ofType('channels').length, pushed, 'nothing pushed');
});

// Two posts the client has not seen as events, the channel opened at the later revision: the events then arrive level
// with the channel (the later) or one revision behind it (the earlier).
async function levelSetup(t) {
  const s = await setup(t);
  assert.equal((await s.call('chatOverview')).ok, true);
  const behind = await unseenPost(s, 'earlier');
  const level = await unseenPost(s, 'later');
  assert.equal(level.channel_rev, behind.channel_rev + 1);
  assert.equal((await s.call('chatHistory', { channel_id: 'chan_team' })).ok, true);
  assert.equal(rowOf(await s.call('chatOverview')).rev, level.channel_rev, 'the open raised the channel revision');
  return { s, behind, level };
}

test('a message event level with the channel sets pin_count and is pushed; one revision behind never does', async (t) => {
  const { s, behind, level } = await levelSetup(t);
  const pinCount = async () => rowOf(await s.call('chatOverview')).pin_count;
  assert.equal(await pinCount(), 0, 'the count the host sent');
  const pushed = s.ofType('channels').length;
  s.event('team_chat_message', { ...behind, pin_count: 9 });
  await s.chats.idle(s.teamId);
  assert.equal(await pinCount(), 0, 'an older event never sets it');
  const pushedBehind = s.ofType('channels').length;
  s.event('team_chat_message', { ...level, pin_count: 4 });
  await s.chats.idle(s.teamId);
  assert.equal(await pinCount(), 4, 'a level event does');
  assert.equal(s.ofType('channels').length, pushedBehind + 1, 'and the row is pushed');
  assert.ok(pushedBehind >= pushed);
  assert.equal(rowOf(s.ofType('channels').at(-1)).pin_count, 4);
});

test('a channel event level with the channel sets pin_count and is pushed; one revision behind never does', async (t) => {
  const { s, behind, level } = await levelSetup(t);
  const pinCount = async () => rowOf(await s.call('chatOverview')).pin_count;
  const channelEvent = (rev, count) => s.event('team_chat_channel', { channel_id: 'chan_team', channel_rev: rev,
    reason: 'pruned', floor_seq: 0, pin_count: count });
  assert.equal(await pinCount(), 0, 'the count the host sent');
  channelEvent(behind.channel_rev, 9);
  await s.chats.idle(s.teamId);
  assert.equal(await pinCount(), 0, 'an older event never sets it');
  const pushedBehind = s.ofType('channels').length;
  channelEvent(level.channel_rev, 6);
  await s.chats.idle(s.teamId);
  assert.equal(await pinCount(), 6, 'a level event does');
  assert.equal(s.ofType('channels').length, pushedBehind + 1, 'and the row is pushed');
  assert.equal(rowOf(s.ofType('channels').at(-1)).pin_count, 6);
});

// Fault: a presence event for a member admitted since the overview was ignored, so the host's own Jenny showed a
// connected member offline until some later resync.
test('presence for a member the cache does not list brings one overview and a members push that lists them', async (t) => {
  const s = await setup(t);
  assert.equal((await s.call('chatOverview')).ok, true);
  await settleChats(s.chats, s.teamId, s.timers);
  const before = overviewCount(s);
  s.host.members.push(THIRD);
  s.host.chat.onMemberStream(THIRD.member_id, THIRD.device_id, 'open');
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(overviewCount(s), before + 1, 'one overview read');
  const listed = s.ofType('members').at(-1)?.members.find((member) => member.member_id === THIRD.member_id);
  assert.equal(listed?.state, 'online', 'the members push lists them with the state the host reports');
});

// Fault: a member no overview lists (or a hostile host naming one) driving a resync per event, or a loop.
test('presence that keeps naming a member no overview lists reads no more overviews than the floor allows', async (t) => {
  let clock = 1_000_000;
  const s = await setupChatClient(t, { prefix: 'jenny-team-chat-order-', now: () => clock });
  assert.equal((await s.call('chatOverview')).ok, true);
  await s.chats.idle(s.teamId);
  const before = overviewCount(s);
  const ghost = { member_id: 'member_ghostGGG777', state: 'online', last_seen_at: '2026-11-11T10:00:00.000Z' };
  for (let n = 0; n < 10; n += 1) {
    clock += 100;
    s.event('team_presence', ghost);
    await s.chats.idle(s.teamId);
  }
  assert.equal(overviewCount(s), before, 'held by the floor');
  assert.equal(s.timers.pending(), 1, 'one floor timer for all ten');
  s.timers.fire();
  await s.chats.idle(s.teamId);
  assert.equal(overviewCount(s), before + 1, 'one overview for the floor window');
  assert.equal(s.timers.pending(), 0, 'nothing more scheduled: no loop');
  clock += 1500;
  for (let n = 0; n < 10; n += 1) s.event('team_presence', ghost);
  await s.chats.idle(s.teamId);
  s.timers.fire();
  await s.chats.idle(s.teamId);
  assert.equal(overviewCount(s), before + 2, 'the next window asks once more');
  assert.equal(s.timers.pending(), 0, 'and again nothing is left scheduled');
  assert.deepEqual(s.ofType('presence'), []);
});

// Fault: presence that arrives while a resync is in flight or waiting on its retry lost once it succeeds.
test('presence that arrives while a resync is pending is not lost once the resync succeeds', async (t) => {
  const s = await setup(t);
  assert.equal((await s.call('chatOverview')).ok, true);
  await settleChats(s.chats, s.teamId, s.timers);
  const stateOf = () => s.chats.cacheOf(s.teamId).members.find((member) => member.member_id === OTHER.member_id).state;
  let release = null;
  s.manager.hook = async ({ operation, dispatch }) => {
    if (operation !== 'team.chat.overview' || release) return null;
    const stale = await dispatch();
    await new Promise((resolve) => { release = resolve; });
    return stale;
  };
  s.event('resync_required', {});
  await s.chats.idle(s.teamId);
  s.timers.fire(); // past the resync floor
  assert.ok(await within(3000, () => release !== null), 'an overview answered before the change is held');
  s.host.chat.onMemberStream(OTHER.member_id, OTHER.device_id, 'open');
  await turn();
  release();
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(stateOf(), 'online', 'buffered and applied after the stale overview');
  s.manager.hook = async ({ operation }) => (operation === 'team.chat.overview'
    ? { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } } : null);
  s.event('resync_required', {});
  await s.chats.idle(s.teamId);
  s.timers.fire(); // past the resync floor: the resync runs and fails
  await s.chats.idle(s.teamId);
  assert.equal(s.timers.pending(), 1, 'the failed resync waits on its retry timer');
  s.host.chat.presence.setIdle(OTHER.member_id, OTHER.device_id, true);
  await s.chats.idle(s.teamId);
  s.manager.hook = null;
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(stateOf(), 'away', 'the retry that succeeds carries the change');
});
