'use strict';

// Slice 2a-3b: team presence. The module with an injected timer facility and
// clock (no wall time), then through the real team HTTP layer, event stream,
// router and chat host: stream open and close, the presence report, the
// overview's members, and ephemeral events absent from replay.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { command } = require('../helpers/command-router-fixture');
const { REVOKE_EVENT_KINDS } = require('../../server/team/membership-events');
const { createTeamPresence } = require('../../services/host/team-presence');
const { createTeamHttpFixture, waitUntil } = require('./helpers/team-http-fixture');
const { fakeTimers } = require('./helpers/team-chat-timers');

const BASE = Date.UTC(2026, 10, 10, 12, 0, 0);

function setup({ active = ['member_a', 'member_b', 'member_c'] } = {}) {
  const timers = fakeTimers();
  const published = [];
  const roster = { active };
  const presence = createTeamPresence({ activeMemberIds: () => roster.active, timers,
    clock: () => BASE + timers.now(), publish: (type, payload, options) => published.push({ type, payload, options }) });
  const states = (memberId) => published.filter((entry) => entry.payload.member_id === memberId)
    .map((entry) => entry.payload.state);
  return { timers, published, presence, roster, states };
}

test('online on the first stream, still online while a second device stays, offline 30 s after the last closes', () => {
  const { timers, published, presence, states } = setup();
  presence.streamChanged('member_a', 'device_a1', 'open');
  assert.deepEqual(states('member_a'), ['online']);
  const [event] = published;
  assert.equal(event.type, 'team_presence');
  assert.deepEqual(Object.keys(event.payload).sort(), ['last_seen_at', 'member_id', 'state']);
  assert.equal(event.payload.last_seen_at, new Date(BASE).toISOString());
  assert.equal(event.options.ephemeral, true);
  assert.deepEqual([...event.options.audience].sort(), ['member_a', 'member_b', 'member_c']);
  assert.equal(event.options.bucket, undefined);

  presence.streamChanged('member_a', 'device_a2', 'open');
  presence.streamChanged('member_a', 'device_a1', 'close');
  timers.advance(60_000);
  assert.deepEqual(states('member_a'), ['online'], 'the second device keeps the member online');
  presence.streamChanged('member_a', 'device_a2', 'close');
  assert.deepEqual(presence.stateOf('member_a').state, 'online', 'not offline at once');
  timers.advance(29_999);
  assert.deepEqual(states('member_a'), ['online']);
  timers.advance(1);
  assert.deepEqual(states('member_a'), ['online', 'offline']);
  assert.deepEqual(presence.stateOf('member_a'), { state: 'offline',
    last_seen_at: new Date(BASE + 60_000).toISOString() });
  assert.equal(timers.pending.size, 0);
});

test('a stream reopened within 30 s cancels the offline change', () => {
  const { timers, presence, states } = setup();
  presence.streamChanged('member_a', 'device_a1', 'open');
  presence.streamChanged('member_a', 'device_a1', 'close');
  timers.advance(10_000);
  presence.streamChanged('member_a', 'device_a1', 'open');
  timers.advance(60_000);
  assert.deepEqual(states('member_a'), ['online']);
  assert.equal(timers.pending.size, 0);
});

test('away when every streaming device reports idle, and back with active', () => {
  const { presence, states } = setup();
  presence.streamChanged('member_a', 'device_a1', 'open');
  presence.streamChanged('member_a', 'device_a2', 'open');
  presence.setIdle('member_a', 'device_a1', true);
  assert.deepEqual(states('member_a'), ['online'], 'one device still active');
  presence.setIdle('member_a', 'device_a2', true);
  assert.deepEqual(states('member_a'), ['online', 'away']);
  presence.setIdle('member_a', 'device_a2', true);
  assert.deepEqual(states('member_a'), ['online', 'away'], 'a repeat changes nothing');
  presence.setIdle('member_a', 'device_a1', false);
  assert.deepEqual(states('member_a'), ['online', 'away', 'online']);
  presence.setIdle('member_b', 'device_b1', true);
  assert.equal(presence.stateOf('member_b').state, 'offline', 'a device with no stream has no state to change');
});

test('members who are not active are not tracked and reach nobody', () => {
  const { presence, published, roster } = setup({ active: ['member_a'] });
  presence.streamChanged('member_pending', 'device_p', 'open');
  assert.deepEqual(published, []);
  presence.streamChanged('member_a', 'device_a1', 'open');
  roster.active = [];
  presence.streamChanged('member_a', 'device_a1', 'close');
  assert.equal(presence.size().members, 0, 'a revoked member leaves the table');
  assert.deepEqual(published.map((entry) => [...entry.options.audience]), [['member_a']]);
});

test('the table is bounded and dispose leaves no timer behind', () => {
  const ids = Array.from({ length: 70 }, (_, i) => `member_${i}`);
  const { timers, presence, published } = setup({ active: ids });
  for (const id of ids) presence.streamChanged(id, `device_${id}`, 'open');
  assert.equal(presence.size().members, 64);
  for (let i = 0; i < 20; i += 1) presence.streamChanged('member_0', `device_extra_${i}`, 'open');
  for (const id of ids.slice(0, 10)) presence.streamChanged(id, `device_${id}`, 'close');
  assert.equal(timers.pending.size, 9, 'member_0 still streams on its extra devices');
  assert.ok([...timers.pending.values()].every((handle) => handle.unrefed), 'every timer is unref\'d');
  presence.dispose();
  assert.equal(timers.pending.size, 0);
  assert.deepEqual(presence.size(), { members: 0, timers: 0, offline: 0 });
  const count = published.length;
  presence.streamChanged('member_1', 'device_member_1', 'open');
  timers.advance(60_000);
  assert.equal(published.length, count, 'nothing after dispose');
});

// ------------------------------------------------------------ through the host

async function connect(env, key) {
  const client = env.client(key);
  assert.equal((await client.hello()).status, 200);
  const auth = await client.registerClient();
  const stream = await client.openStream(auth);
  assert.equal(stream.status, 200);
  const send = async (operation, params = {}) => {
    const body = { ...command(auth, operation, params), boot_epoch: env.context.bootEpoch };
    return (await client.request('POST', '/api/v1/commands', { body, headers: { 'X-Client-Token': auth.client_token } }))
      .json;
  };
  return { client, auth, stream, send };
}

const framesOf = (stream, type) => stream.frames.join('').split('\n').filter((line) => line.startsWith('data: '))
  .map((line) => JSON.parse(line.slice(6))).filter((frame) => frame.event_type === type);

test('through the host: streams drive presence, the overview lists members, nothing ephemeral replays', async (t) => {
  const env = await createTeamHttpFixture(t, { withChat: true });
  const seeded = await env.seed();
  const owner = await connect(env, seeded.owner.key);
  const member = await connect(env, seeded.member.key);
  assert.equal(await waitUntil(() => framesOf(owner.stream, 'team_presence')
    .some((frame) => frame.member_id === seeded.member.member_id && frame.state === 'online')), true);

  const overview = await member.send('team.chat.overview');
  assert.equal(overview.ok, true);
  const byId = Object.fromEntries(overview.members.map((entry) => [entry.member_id, entry]));
  assert.deepEqual(Object.keys(byId).sort(),
    [seeded.owner.member_id, seeded.member.member_id, seeded.readOnly.member_id].sort(), 'active members only');
  assert.deepEqual(Object.keys(byId[seeded.owner.member_id]).sort(),
    ['display_name', 'last_seen_at', 'member_id', 'role', 'state']);
  assert.equal(byId[seeded.owner.member_id].display_name, 'Olive Owner');
  assert.equal(byId[seeded.owner.member_id].role, 'owner');
  assert.equal(byId[seeded.member.member_id].state, 'online');
  assert.equal(byId[seeded.readOnly.member_id].state, 'offline');
  assert.equal(JSON.stringify(overview).includes(seeded.member.key), false, 'no key data');

  assert.equal((await member.send('team.presence.set', { state: 'idle' })).ok, true);
  assert.equal(await waitUntil(() => framesOf(owner.stream, 'team_presence')
    .some((frame) => frame.member_id === seeded.member.member_id && frame.state === 'away')), true);
  assert.equal((await member.send('team.chat.typing', { channel_id: 'chan_team' })).ok, true);
  assert.equal(await waitUntil(() => framesOf(owner.stream, 'team_chat_typing').length === 1), true);
  const [typing] = framesOf(owner.stream, 'team_chat_typing');
  assert.deepEqual([typing.channel_id, typing.thread_root_id, typing.member_id],
    ['chan_team', null, seeded.member.member_id]);

  // Replay from the start: presence and typing were never stored.
  const response = Object.assign(new EventEmitter(), { frames: [], writableLength: 0,
    write(frame) { this.frames.push(frame); }, destroy() {} });
  const unsubscribe = env.core.events.subscribe({ response, deviceId: seeded.owner.device_id, authorized: () => true,
    bootEpoch: env.context.bootEpoch, cursor: 0,
    identity: { memberId: seeded.owner.member_id, mayReceive: () => true } });
  unsubscribe?.();
  assert.deepEqual(framesOf({ frames: response.frames }, 'team_presence'), []);
  assert.deepEqual(framesOf({ frames: response.frames }, 'team_chat_typing'), []);
});

test('a refused stream never reports to presence: unknown client, wrong token, rejected subscribe', async (t) => {
  const env = await createTeamHttpFixture(t, { withChat: true });
  const seeded = await env.seed();
  const client = env.client(seeded.member.key);
  assert.equal((await client.hello()).status, 200);
  // Client capacity: the device's fifth client is refused, so it has no id to stream with.
  const registered = [];
  for (let i = 0; i < 5; i += 1) registered.push(await client.registerClient());
  assert.equal(registered[4].client_id, undefined, 'the fifth client is refused');
  const auth = registered[0];
  const unknown = await client.openStream({ client_id: 'f'.repeat(32), client_token: auth.client_token });
  const wrongToken = await client.openStream({ client_id: auth.client_id, client_token: 'x'.repeat(43) });
  const events = env.core.events.events; // the EventStream behind the backend events
  const capacity = events.maxClients;
  events.maxClients = events.clients.size;
  const rejected = await client.openStream(auth);
  events.maxClients = capacity;
  assert.deepEqual([unknown.status, wrongToken.status], [403, 403]);
  assert.notEqual(rejected.status, 200, 'the event stream refused the subscriber');
  assert.deepEqual(env.memberStreamCalls, [], 'no open and no close for a refused stream');
  assert.equal(env.chat.presence.stateOf(seeded.member.member_id).state, 'offline');

  const admitted = await client.openStream(auth);
  assert.equal(admitted.status, 200);
  assert.deepEqual(env.memberStreamCalls, [[seeded.member.member_id, seeded.member.device_id, 'open']]);
});

test('a device revoked through HTTP goes offline in presence and leaves no timer behind', async (t) => {
  const timers = fakeTimers();
  const env = await createTeamHttpFixture(t, { withChat: true, chatTimers: timers });
  const seeded = await env.seed();
  // The revoke fan-out as team-main.js wires it: a revoked device's streams close.
  const unsubscribe = env.store.onMembershipChange((event) => {
    if (REVOKE_EVENT_KINDS.has(event.kind)) for (const id of event.device_ids) env.core.events.revokeDevice(id);
  });
  t.after(() => unsubscribe());
  const phone = await env.redeemDirect({ kind: 'add_device', actor: seeded.member.member_id, name: 'x', label: 'Phone' });
  const owner = await connect(env, seeded.owner.key);
  await connect(env, phone.key);
  const presence = env.chat.presence;
  assert.equal(presence.stateOf(seeded.member.member_id).state, 'online');

  assert.equal((await owner.send('team.device.revoke', { device_id: phone.device_id })).ok, true);
  assert.equal(await waitUntil(() => env.memberStreamCalls.some(([, deviceId, change]) => deviceId === phone.device_id
    && change === 'close')), true, 'the revoked device\'s stream closed');
  assert.equal(presence.size().timers, 1, 'the offline delay is pending');
  timers.advance(30_000);
  assert.equal(presence.stateOf(seeded.member.member_id).state, 'offline');
  assert.deepEqual(presence.size(), { members: 1, timers: 0, offline: 1 }, 'only the owner is tracked; no timer left');
  assert.equal([...timers.pending.values()].some((handle) => handle.ms === 30_000), false);
});
