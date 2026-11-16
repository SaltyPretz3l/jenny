'use strict';

// The chat client's throttles in main (slice 2a-4c), on an injected clock:
// chatTyping sends at most once per 3 s per channel and thread; presenceSet
// sends only a change, and the held state once after each reconnect;
// chatMarkRead is coalesced per channel to one send every 2 s carrying the
// highest seq asked for, with the trailing one flushed when the window ends,
// while `unread: true` goes at once; nothing is left running after stop.
// Against the real host chat composition behind a fake connection manager.

const assert = require('node:assert/strict');
const test = require('node:test');

const { OTHER, createChatFakeHost, startChats, tempDir, writeMembership } = require('./helpers/team-chat-fake-host');
const { createFakeTimers } = require('./helpers/fake-timers');

async function setup(t) {
  const host = await createChatFakeHost(t);
  const userData = tempDir(t, 'jenny-team-chat-throttle-');
  const teamId = writeMembership(userData).team_id;
  const timers = createFakeTimers();
  const started = startChats(t, host, { userData, teamId, timers, now: timers.now });
  const s = { host, teamId, userData, ...started };
  s.call = (method, payload = {}) => s.chats.handle(method, { team_id: teamId, ...payload });
  s.sent = (operation) => s.manager.calls.filter((call) => call.operation === operation);
  assert.equal((await s.call('chatOverview')).ok, true);
  return s;
}

async function settle(s) {
  for (let round = 0; round < 5; round += 1) await s.chats.idle(s.teamId);
}

async function reconnect(s) {
  s.manager.setState('reconnecting');
  await settle(s);
  s.manager.setState('online');
  await settle(s);
}

test('chatTyping sends at most once per 3 s per channel and thread', async (t) => {
  const s = await setup(t);
  const root = await s.host.postAs(OTHER, 'a thread root');
  const typing = () => s.sent('team.chat.typing').map((call) => call.params);
  assert.deepEqual(await s.call('chatTyping', { channel_id: 'chan_team' }), { ok: true });
  s.timers.tick(1000);
  assert.deepEqual(await s.call('chatTyping', { channel_id: 'chan_team' }), { ok: true }, 'an early repeat answers ok');
  s.timers.tick(1999);
  assert.deepEqual(await s.call('chatTyping', { channel_id: 'chan_team' }), { ok: true });
  assert.deepEqual(typing(), [{ channel_id: 'chan_team' }], 'one send inside the window');
  assert.deepEqual(await s.call('chatTyping', { channel_id: 'chan_team', thread_root_id: root.message_id }), { ok: true });
  assert.equal(typing().length, 2, 'a thread is its own key');
  s.timers.tick(1);
  assert.deepEqual(await s.call('chatTyping', { channel_id: 'chan_team' }), { ok: true });
  assert.deepEqual(typing(), [{ channel_id: 'chan_team' }, { channel_id: 'chan_team', thread_root_id: root.message_id },
    { channel_id: 'chan_team' }], 'the channel sends again once 3 s passed');
  // A channel the overview does not list is refused with nothing sent; offline sends nothing.
  const ghost = await s.call('chatTyping', { channel_id: 'chan_project_ghost' });
  assert.equal(ghost.error?.reason, 'team_chat_not_found');
  s.manager.state = 'reconnecting';
  s.timers.tick(5000);
  const offline = await s.call('chatTyping', { channel_id: 'chan_team' });
  assert.equal(offline.error?.reason, 'team_not_connected');
  assert.equal(typing().length, 3, 'nothing sent offline or for an unlisted channel');
});

test('presenceSet sends only a change, and the held state once after each reconnect', async (t) => {
  const s = await setup(t);
  const states = () => s.sent('team.presence.set').map((call) => call.params.state);
  assert.deepEqual(await s.call('presenceSet', { state: 'active' }), { ok: true });
  assert.deepEqual(await s.call('presenceSet', { state: 'active' }), { ok: true });
  assert.deepEqual(states(), ['active'], 'an unchanged state is not sent');
  assert.deepEqual(await s.call('presenceSet', { state: 'idle' }), { ok: true });
  assert.deepEqual(states(), ['active', 'idle']);
  await reconnect(s);
  assert.deepEqual(states(), ['active', 'idle', 'idle'], 'the held state once after the reconnect');
  assert.deepEqual(await s.call('presenceSet', { state: 'idle' }), { ok: true });
  assert.deepEqual(states(), ['active', 'idle', 'idle'], 'and not again');
  // Offline the state is held and nothing is sent; the reconnect sends it once.
  s.manager.setState('reconnecting');
  await settle(s);
  const offline = await s.call('presenceSet', { state: 'active' });
  assert.equal(offline.error?.reason, 'team_not_connected');
  assert.deepEqual(states(), ['active', 'idle', 'idle']);
  s.manager.setState('online');
  await settle(s);
  assert.deepEqual(states(), ['active', 'idle', 'idle', 'active']);
});

test('chatMarkRead is coalesced to the highest seq with a trailing flush; unread goes at once', async (t) => {
  const s = await setup(t);
  for (let n = 1; n <= 6; n += 1) await s.host.postAs(OTHER, `message ${n}`);
  const seqs = () => s.sent('team.chat.mark_read').map((call) => [call.params.seq, call.params.unread === true]);
  const first = await s.call('chatMarkRead', { channel_id: 'chan_team', seq: 1 });
  assert.deepEqual(first, { ok: true, last_read_seq: 1 }, 'the first read in a window goes at once');
  const three = s.call('chatMarkRead', { channel_id: 'chan_team', seq: 3 });
  const two = s.call('chatMarkRead', { channel_id: 'chan_team', seq: 2 });
  await settle(s);
  assert.deepEqual(seqs(), [[1, false]], 'held inside the window');
  s.timers.tick(1999);
  await settle(s);
  assert.deepEqual(seqs(), [[1, false]]);
  s.timers.tick(1);
  assert.deepEqual(await three, { ok: true, last_read_seq: 3 });
  assert.deepEqual(await two, { ok: true, last_read_seq: 3 }, 'every held call gets the flushed answer');
  assert.deepEqual(seqs(), [[1, false], [3, false]], 'one trailing send with the highest seq');
  s.timers.tick(2000);
  await settle(s);
  assert.deepEqual(seqs(), [[1, false], [3, false]], 'a window with nothing held sends nothing');
  // A window is open again after a send at once; a held read is dropped by an unread call, which goes at once.
  assert.equal((await s.call('chatMarkRead', { channel_id: 'chan_team', seq: 4 })).ok, true);
  const five = s.call('chatMarkRead', { channel_id: 'chan_team', seq: 5 });
  const unread = await s.call('chatMarkRead', { channel_id: 'chan_team', seq: 2, unread: true });
  assert.equal(unread.ok, true, JSON.stringify(unread));
  assert.deepEqual(await five, unread, 'the held read is answered by the unread call');
  s.timers.tick(4000);
  await settle(s);
  assert.deepEqual(seqs(), [[1, false], [3, false], [4, false], [2, true]], 'the held seq never undoes the unread');
  // Two channels have their own windows (only the team channel exists; another listed channel would be its own key).
  assert.equal(s.chats.cacheOf(s.teamId).channels.find((channel) => channel.channel_id === 'chan_team').last_read_seq,
    unread.last_read_seq);
});

test('nothing is left running after stop and a held read is answered', async (t) => {
  const s = await setup(t);
  for (let n = 1; n <= 3; n += 1) await s.host.postAs(OTHER, `message ${n}`);
  assert.equal((await s.call('chatTyping', { channel_id: 'chan_team' })).ok, true);
  assert.equal((await s.call('chatMarkRead', { channel_id: 'chan_team', seq: 1 })).ok, true);
  const held = s.call('chatMarkRead', { channel_id: 'chan_team', seq: 3 });
  await settle(s);
  assert.ok(s.timers.pending() >= 1, 'the read window is armed');
  await s.chats.stopAll();
  assert.deepEqual(await held, { ok: false, error: { code: 'CMP-TEAM-0005', reason: 'team_connection_stopped' } });
  assert.equal(s.timers.pending(), 0, 'no timer left');
  s.timers.tick(10_000);
  assert.equal(s.sent('team.chat.mark_read').length, 1, 'the held read was never sent');
});

test('a cleared team drops its held reads and their timers', async (t) => {
  const s = await setup(t);
  for (let n = 1; n <= 3; n += 1) await s.host.postAs(OTHER, `message ${n}`);
  assert.equal((await s.call('chatMarkRead', { channel_id: 'chan_team', seq: 1 })).ok, true);
  const held = s.call('chatMarkRead', { channel_id: 'chan_team', seq: 3 });
  s.manager.setState('revoked');
  await settle(s);
  assert.equal((await held).ok, false);
  assert.equal(s.timers.pending(), 0, 'no timer left after the team was cleared');
  s.timers.tick(10_000);
  assert.equal(s.sent('team.chat.mark_read').length, 1);
});

// Review round (slice 2a-4c).

test('a typing send the host refused keeps its window; one that got no answer is sent again', async (t) => {
  const s = await setup(t);
  const typing = () => s.sent('team.chat.typing').length;
  let refusal = { ok: false, error: { code: 'CMP-HOST-0003', reason: 'role_forbidden' } };
  s.manager.hook = async ({ operation }) => (operation === 'team.chat.typing' ? refusal : null);
  assert.equal((await s.call('chatTyping', { channel_id: 'chan_team' })).ok, false);
  s.timers.tick(1000);
  assert.deepEqual(await s.call('chatTyping', { channel_id: 'chan_team' }), { ok: true });
  assert.equal(typing(), 1, 'a host refusal is not sent again inside the window');
  s.timers.tick(2000);
  refusal = { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } };
  assert.equal((await s.call('chatTyping', { channel_id: 'chan_team' })).ok, false);
  assert.equal(typing(), 2);
  assert.equal((await s.call('chatTyping', { channel_id: 'chan_team' })).ok, false);
  assert.equal(typing(), 3, 'a send with no answer from the host releases the window');
});

test('a read in flight finishes before a mark-unread goes, so the cache ends at the unread position', async (t) => {
  const s = await setup(t);
  for (let n = 1; n <= 4; n += 1) await s.host.postAs(OTHER, `message ${n}`);
  let release = null;
  s.manager.hook = async ({ operation, params, dispatch }) => {
    if (operation !== 'team.chat.mark_read' || params.unread === true || release) return null;
    return new Promise((resolve) => { release = () => resolve(dispatch()); });
  };
  const read = s.call('chatMarkRead', { channel_id: 'chan_team', seq: 3 });
  await settle(s);
  const unread = s.call('chatMarkRead', { channel_id: 'chan_team', seq: 2, unread: true });
  await settle(s);
  assert.equal(s.sent('team.chat.mark_read').length, 1, 'the mark-unread waits for the read in flight');
  release();
  const readAnswer = await read;
  const unreadAnswer = await unread;
  assert.deepEqual(readAnswer, { ok: true, last_read_seq: 3 }, 'the read caller gets its own answer');
  assert.equal(unreadAnswer.ok, true);
  assert.ok(unreadAnswer.last_read_seq < 3, JSON.stringify(unreadAnswer));
  assert.deepEqual(s.sent('team.chat.mark_read').map((call) => call.params.unread === true), [false, true]);
  assert.equal(s.chats.cacheOf(s.teamId).channels.find((channel) => channel.channel_id === 'chan_team').last_read_seq,
    unreadAnswer.last_read_seq);
});

test('a refused presence send is sent again on the next ask', async (t) => {
  const s = await setup(t);
  let refuse = true;
  s.manager.hook = async ({ operation }) => (operation === 'team.presence.set' && refuse
    ? { ok: false, error: { code: 'CMP-HOST-0007', reason: 'team_chat_rate_limit' } } : null);
  assert.equal((await s.call('presenceSet', { state: 'idle' })).ok, false);
  refuse = false;
  assert.deepEqual(await s.call('presenceSet', { state: 'idle' }), { ok: true });
  assert.deepEqual(s.sent('team.presence.set').map((call) => call.params.state), ['idle', 'idle']);
});

test('chatMarkRead on a channel the overview does not list sends nothing', async (t) => {
  const s = await setup(t);
  const answer = await s.call('chatMarkRead', { channel_id: 'chan_project_ghost', seq: 1 });
  assert.equal(answer.error?.reason, 'team_chat_not_found');
  assert.equal(s.sent('team.chat.mark_read').length, 0);
});
