'use strict';

// Unit tests of the chat client's pure parts (slice 2a-4c, review round): the
// cache drops its members on clear; the read coalescer keeps one window per
// channel, unrefs its timer and answers a request after `clear` without
// opening a window; the typing gate evicts its oldest key past its bound.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createChatCache } = require('../services/team/chat-cache');
const { createTypingGate } = require('../services/team/chat-live');
const { createReadCoalescer } = require('../services/team/chat-reads');

const CHANNEL = { channel_id: 'chan_team', kind: 'team', archived: false, rev: 1, last_seq: 1, floor_seq: 0,
  last_read_seq: 0, notify: 'mentions', unread: 0, unread_capped: false, mention: false };
const MEMBER = { member_id: 'member_meAAAA1111', display_name: 'Mika Member', role: 'member', state: 'online',
  last_seen_at: null };

// Timers that only run on `fire()`; each handle records whether it was unref'd.
function recordingTimers() {
  const handles = [];
  return {
    handles,
    setTimeout(fn, ms) { const handle = { fn, ms, unrefed: false, unref() { handle.unrefed = true; } }; handles.push(handle); return handle; },
    clearTimeout(handle) { const at = handles.indexOf(handle); if (at >= 0) handles.splice(at, 1); },
    fire() { const due = handles.splice(0, handles.length); for (const handle of due) handle.fn(); },
  };
}

function coalescer(timers = recordingTimers()) {
  const sent = [];
  const reads = createReadCoalescer({ timers, failure: { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_unavailable' } },
    send: async (channelId, seq, unread) => { sent.push([channelId, seq, unread]); return { ok: true, last_read_seq: seq }; } });
  return { reads, sent, timers };
}

test('clear drops the members with the channels', () => {
  const cache = createChatCache({ memberId: MEMBER.member_id });
  assert.equal(cache.setOverview([CHANNEL]), true);
  assert.equal(cache.setMembers([MEMBER]), true);
  assert.deepEqual(cache.memberList(), [MEMBER]);
  cache.clear();
  assert.deepEqual(cache.memberList(), []);
  assert.equal(cache.hasMember(MEMBER.member_id), false);
  assert.equal(cache.loaded, false);
});

test('each channel has its own read window', async () => {
  const { reads, sent } = coalescer();
  assert.deepEqual(await reads.request('chan_team', 1, false), { ok: true, last_read_seq: 1 });
  assert.deepEqual(await reads.request('chan_project_two', 4, false), { ok: true, last_read_seq: 4 });
  assert.deepEqual(sent, [['chan_team', 1, false], ['chan_project_two', 4, false]], 'the second channel is not held');
  assert.equal(reads.size(), 2);
});

test('the read window timer is unref\'d', async () => {
  const { reads, timers } = coalescer();
  await reads.request('chan_team', 1, false);
  assert.equal(timers.handles.length, 1);
  assert.equal(timers.handles[0].unrefed, true);
  assert.equal(timers.handles[0].ms, 2000);
});

test('a request after clear answers the clear answer and opens no window', async () => {
  const { reads, sent, timers } = coalescer();
  await reads.request('chan_team', 1, false);
  const held = reads.request('chan_team', 2, false);
  const stopped = { ok: false, error: { code: 'CMP-TEAM-0005', reason: 'team_connection_stopped' } };
  reads.clear(stopped);
  assert.deepEqual(await held, stopped);
  assert.deepEqual(await reads.request('chan_team', 3, false), stopped);
  assert.deepEqual(await reads.request('chan_team', 1, true), stopped);
  assert.equal(timers.handles.length, 0, 'no timer armed after clear');
  assert.equal(reads.size(), 0);
  assert.deepEqual(sent, [['chan_team', 1, false]]);
});

test('the typing gate evicts its oldest key past its bound', () => {
  let at = 0;
  const gate = createTypingGate({ now: () => at, max: 2 });
  assert.equal(gate.allow('chan_team', 'msg_1'), true);
  at = 1;
  assert.equal(gate.allow('chan_team', 'msg_2'), true);
  at = 2;
  assert.equal(gate.allow('chan_team', 'msg_3'), true);
  assert.equal(gate.size(), 2);
  assert.equal(gate.allow('chan_team', 'msg_3'), false, 'the newest key is still held');
  assert.equal(gate.allow('chan_team', 'msg_1'), true, 'the oldest key was evicted');
  assert.equal(gate.size(), 2);
});

// Slice 2d: a direct conversation's row keeps its participants (its own copy); a dm row whose participants are
// missing, leave this member out or do not hash to its id is not listed; team rows carry none.
test('a dm row keeps its participants; a dm row with wrong participants is not listed', () => {
  const { dmChannelId } = require('../services/host/team-chat-schema');
  const me = MEMBER.member_id;
  const other = 'member_otAAAA2222';
  const stranger = 'member_stAAAA3333';
  const both = [me, other].sort();
  const dm = (participants, id = dmChannelId(both)) => ({ ...CHANNEL, channel_id: id, kind: 'dm', notify: 'all', participants });
  const cache = createChatCache({ memberId: me });
  const theirs = [other, stranger].sort();
  assert.equal(cache.setOverview([CHANNEL, dm(both), dm(undefined, dmChannelId([me, stranger])),
    dm(theirs, dmChannelId(theirs)), dm([me, stranger].sort())]), true);
  const list = cache.channelList();
  assert.deepEqual(list.map((c) => c.channel_id), ['chan_team', dmChannelId(both)]);
  assert.deepEqual(list[1].participants, both);
  assert.equal(Object.hasOwn(list[0], 'participants'), false);
  list[1].participants.push('member_tamperedZZ');
  assert.deepEqual(cache.channelList()[1].participants, both, 'the renderer gets a copy');
  assert.deepEqual(cache.channelsOf(new Set([dmChannelId(both)]))[0].participants, both);
  // A conversation's `created` is a gap only while its row is not cached (chatDmOpen's resync may come first).
  const created = (id) => ({ channel_id: id, reason: 'created', channel_rev: 1, floor_seq: 1 });
  assert.deepEqual(cache.applyChannel(created(dmChannelId(both))), { status: 'applied', reload: false });
  assert.equal(cache.applyChannel(created(dmChannelId([me, stranger]))).status, 'gap');
});

// Slice 2b-3: a project row keeps its audience (its own copy); a bad audience drops the field, never the row.
test('a project row keeps a valid audience; a bad one is dropped and the row kept', () => {
  const me = MEMBER.member_id;
  const ids = ['member_aaAAAA0001', 'member_zzAAAA0009', me].sort();
  const project = (id, audience) => ({ ...CHANNEL, channel_id: `chan_project_${id}`, kind: 'project', audience });
  const nine = Array.from({ length: 8 }, (_, n) => `member_n${n}AAAA000${n}`).concat(me).sort();
  const bad = {
    duplicate: [me, me], self: ['member_aaAAAA0001'], nonId: [me, 'not-an-id'].sort(), nine, unsorted: [...ids].reverse(),
    notList: me,
  };
  const cache = createChatCache({ memberId: me });
  assert.equal(cache.setOverview([{ ...CHANNEL, audience: ids }, project('ok', ids),
    ...Object.entries(bad).map(([name, audience]) => project(name.toLowerCase(), audience))]), true);
  const list = cache.channelList();
  assert.equal(list.length, 2 + Object.keys(bad).length, 'every row is kept');
  assert.equal(Object.hasOwn(list[0], 'audience'), false, 'an audience on a team row is an extra key: dropped');
  assert.deepEqual(list[1].audience, ids);
  for (const row of list.slice(2)) assert.equal(Object.hasOwn(row, 'audience'), false, row.channel_id);
  list[1].audience.push('member_tamperedZZ');
  assert.deepEqual(cache.channelList()[1].audience, ids, 'the renderer gets a copy');
  assert.deepEqual(cache.channelsOf(new Set(['chan_project_ok']))[0].audience, ids);
});
