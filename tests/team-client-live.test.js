'use strict';

// Presence and typing reach the renderer (slice 2a-4c): another member's
// `team_presence` and `team_chat_typing` events, published by the real host chat
// composition, travel the real bridge, stream, feed and connection manager to
// the chat client and come out as `presence` and `typing` pushes on team.onChat.
// This member's own typing never comes back; a typing event for a channel the
// cache does not hold, or from a member the list does not hold, is dropped; and
// neither is replayed after a reconnect. Against the in-process team host with
// the real host chat dispatcher (tests/helpers/team-chat-hook.js).

const assert = require('node:assert/strict');
const test = require('node:test');

const { attachTeamChat, commandAs } = require('./helpers/team-chat-hook');
const { createTeamClientHost, joinAs, waitUntil } = require('./helpers/team-client-host');

async function memberOnline(t) {
  const host = await createTeamClientHost(t);
  const chat = await attachTeamChat(t, host);
  const owner = await host.ownerDirect();
  const pushes = [];
  const service = host.createService({ sendChat: (payload) => pushes.push(JSON.parse(JSON.stringify(payload))) });
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  const call = (method, payload = {}) => service.handle(method, { team_id: me.teamId, ...payload });
  const opened = await call('chatOverview');
  assert.equal(opened.ok, true, JSON.stringify(opened));
  return { host, chat, owner, service, me, call, pushes, opened };
}

const ofType = (pushes, type) => pushes.filter((push) => push.type === type);

test('the overview lists both members from the host roster', async (t) => {
  const s = await memberOnline(t);
  assert.deepEqual(s.opened.members.map((member) => [member.member_id, member.display_name, member.role]).sort(),
    [[s.owner.member_id, 'Olive Owner', 'owner'], [s.me.member_id, 'Mika Member', 'member']].sort());
});

test("another member's presence change arrives as a push and patches the list", async (t) => {
  const s = await memberOnline(t);
  s.chat.onMemberStream(s.owner.member_id, s.owner.device_id, 'open');
  assert.ok(await waitUntil(() => ofType(s.pushes, 'presence').length === 1), 'the presence push arrived');
  const push = ofType(s.pushes, 'presence')[0];
  assert.deepEqual(Object.keys(push).sort(), ['last_seen_at', 'member_id', 'state', 'team_id', 'type']);
  assert.equal(push.member_id, s.owner.member_id);
  assert.equal(push.state, 'online');
  assert.match(push.last_seen_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  const listed = (await s.call('chatOverview')).members.find((member) => member.member_id === s.owner.member_id);
  assert.deepEqual({ state: listed.state, last_seen_at: listed.last_seen_at }, { state: 'online', last_seen_at: push.last_seen_at });
});

test("another member's typing arrives; this member's own typing does not", async (t) => {
  const s = await memberOnline(t);
  // Own typing first: the host publishes it to the whole channel, this member included.
  const mine = await s.call('chatTyping', { channel_id: 'chan_team' });
  assert.deepEqual(mine, { ok: true });
  assert.ok(s.host.env.commandsSeen.some((seen) => seen.operation === 'team.chat.typing'), 'the typing reached the host');
  const typed = await commandAs(s.host, s.owner, 'team.chat.typing', { channel_id: 'chan_team' });
  assert.equal(typed.ok, true, JSON.stringify(typed));
  assert.ok(await waitUntil(() => ofType(s.pushes, 'typing').length >= 1), 'the typing push arrived');
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.deepEqual(ofType(s.pushes, 'typing').map(({ team_id: _team, ...rest }) => rest), [
    { type: 'typing', channel_id: 'chan_team', thread_root_id: null, member_id: s.owner.member_id },
  ], 'only the other member typing; never this member');
});

test('typing for a channel outside the cache or a member outside the list is dropped', async (t) => {
  const s = await memberOnline(t);
  const publish = (payload) => s.host.env.core.events.publish('team_chat_typing', payload, { ephemeral: true });
  publish({ channel_id: 'chan_project_ghost', thread_root_id: null, member_id: s.owner.member_id });
  publish({ channel_id: 'chan_team', thread_root_id: null, member_id: 'member_strangerZZZ999' });
  publish({ channel_id: 'chan_team', thread_root_id: 'not-a-root', member_id: s.owner.member_id });
  // A valid one last, so the dropped ones were all drained before it.
  publish({ channel_id: 'chan_team', thread_root_id: null, member_id: s.owner.member_id });
  assert.ok(await waitUntil(() => ofType(s.pushes, 'typing').length >= 1));
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.deepEqual(ofType(s.pushes, 'typing').map((push) => [push.channel_id, push.member_id]),
    [['chan_team', s.owner.member_id]]);
  // A presence event for a member outside the list is never pushed: it asks for a resync, and the owner's state
  // arrives as a presence push or with the resync's members push.
  s.host.env.core.events.publish('team_presence', { member_id: 'member_strangerZZZ999', state: 'online',
    last_seen_at: '2026-11-11T10:00:00.000Z' }, { ephemeral: true });
  s.chat.onMemberStream(s.owner.member_id, s.owner.device_id, 'open');
  const seen = () => [...ofType(s.pushes, 'presence'), ...ofType(s.pushes, 'members').flatMap((push) => push.members)];
  assert.ok(await waitUntil(() => seen().some((member) => member.member_id === s.owner.member_id && member.state === 'online')));
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.equal(JSON.stringify(s.pushes).includes('member_strangerZZZ999'), false, 'the stranger reaches nothing');
});

test('neither presence nor typing is replayed after a reconnect', async (t) => {
  const s = await memberOnline(t);
  s.chat.onMemberStream(s.owner.member_id, s.owner.device_id, 'open');
  assert.equal((await commandAs(s.host, s.owner, 'team.chat.typing', { channel_id: 'chan_team' })).ok, true);
  assert.ok(await waitUntil(() => ofType(s.pushes, 'presence').length === 1 && ofType(s.pushes, 'typing').length === 1));
  const mark = s.pushes.length;
  const subscribes = s.host.env.subscribesSeen.length;
  s.host.dropEventStreams(s.me.device_id);
  assert.ok(await waitUntil(() => s.host.env.subscribesSeen.length > subscribes
    && s.pushes.slice(mark).some((push) => push.type === 'channels' && push.partial !== true)), 'reconnected and resynced');
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  const after = s.pushes.slice(mark);
  assert.deepEqual(after.filter((push) => push.type === 'typing' || push.type === 'presence'), [],
    'no typing or presence push after the reconnect');
  const listed = (await s.call('chatOverview')).members.find((member) => member.member_id === s.owner.member_id);
  assert.equal(listed.state, 'online', 'the overview after the reconnect carries the presence instead');
});
