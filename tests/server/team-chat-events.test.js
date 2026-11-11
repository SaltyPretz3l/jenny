'use strict';

// Slice 2a-3a: team chat events through the real team HTTP layer, the real
// event stream, router, authorizer and chat store. A member's stream carries
// its identity; the stream predicate re-reads live membership and the channel
// rule on every delivery, live and on replay.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { command } = require('../helpers/command-router-fixture');
const { streamIdentity } = require('../../server/team/authorize');
const { createTeamHttpFixture, pause, waitUntil } = require('./helpers/team-http-fixture');
const { createTeamChatCommandsFixture } = require('./helpers/team-chat-commands-fixture');

const DM_BUCKET = `teamchat:chan_dm_${'b'.repeat(64)}`;

// Hello, a client, and an open stream for one device key.
async function connect(env, key) {
  const client = env.client(key);
  assert.equal((await client.hello()).status, 200);
  const auth = await client.registerClient();
  assert.equal(auth.response.status, 200);
  const stream = await client.openStream(auth);
  assert.equal(stream.status, 200);
  const send = async (operation, params = {}) => {
    const body = { ...command(auth, operation, params), boot_epoch: env.context.bootEpoch };
    const answer = await client.request('POST', '/api/v1/commands',
      { body, headers: { 'X-Client-Token': auth.client_token } });
    return answer.json;
  };
  return { client, auth, stream, send };
}

const chatFrames = (stream) => stream.frames.join('').split('\n')
  .filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
  .filter((frame) => typeof frame.event_type === 'string' && frame.event_type.startsWith('team_chat_'));

// Every publish on the host stream, with its options.
function recordPublishes(env) {
  const calls = [];
  const original = env.core.events.publish.bind(env.core.events);
  env.core.events.publish = (type, payload, options) => {
    calls.push({ type, options });
    return original(type, payload, options);
  };
  return calls;
}

async function setup(t) {
  const env = await createTeamHttpFixture(t, { withChat: true });
  const calls = recordPublishes(env);
  const seeded = await env.seed();
  return { env, calls, seeded };
}

function assertEveryChatPublishHasAudience(calls) {
  const chat = calls.filter((call) => call.type.startsWith('team_chat_'));
  assert.ok(chat.length > 0);
  for (const call of chat) {
    assert.ok(call.options?.audience instanceof Set, `${call.type} without an audience`);
    assert.match(call.options.bucket, /^teamchat:chan_/u);
  }
}

test('an active member stream receives a post; a reply delivers the reply and the updated root', async (t) => {
  const { env, calls, seeded } = await setup(t);
  const owner = await connect(env, seeded.owner.key);
  const member = await connect(env, seeded.member.key);
  const posted = await owner.send('team.chat.post', { channel_id: 'chan_team', text: 'root message' });
  assert.equal(posted.ok, true);
  assert.equal(await waitUntil(() => chatFrames(member.stream).length === 1), true);
  const [first] = chatFrames(member.stream);
  assert.equal(first.event_type, 'team_chat_message');
  const reply = await member.send('team.chat.post', { channel_id: 'chan_team', text: 'a reply',
    thread_root_id: posted.message_id });
  assert.equal(reply.ok, true);
  assert.equal(await waitUntil(() => chatFrames(owner.stream).length === 3), true);
  const frames = chatFrames(owner.stream);
  for (const frame of frames) {
    assert.equal(frame.event_type, 'team_chat_message');
    assert.equal(frame.channel_id, 'chan_team');
    assert.equal(frame.message.channel_id, 'chan_team');
  }
  const ids = frames.map((frame) => frame.message.id);
  assert.deepEqual(ids, [posted.message_id, reply.message_id, posted.message_id],
    'the reply, then its root again');
  assert.equal(frames[1].message.thread_root_id, posted.message_id);
  assert.equal(frames[2].message.reply_count, 1);
  assert.equal(frames[1].channel_rev, reply.rev);
  assert.equal(frames[2].channel_rev, reply.rev);
  assert.equal(first.message.text, 'root message');
  // A read-only member receives the channel too; a pending member has no stream at all.
  assertEveryChatPublishHasAudience(calls);
});

test('a second device of a revoked member receives nothing live and nothing on replay', async (t) => {
  const { env, calls, seeded } = await setup(t);
  const second = await env.redeemDirect({ kind: 'add_device', actor: seeded.member.member_id, name: 'x',
    label: 'Phone' });
  const owner = await connect(env, seeded.owner.key);
  const phone = await connect(env, second.key);
  const early = await owner.send('team.chat.post', { channel_id: 'chan_team', text: 'before revocation' });
  assert.equal(early.ok, true);
  assert.equal(await waitUntil(() => chatFrames(phone.stream).length === 1), true);
  const identity = streamIdentity(env.store.directory, { member_id: second.member_id, device_id: second.device_id });
  assert.equal(identity.memberId, seeded.member.member_id);
  const revoked = await owner.send('team.member.revoke', { member_id: seeded.member.member_id });
  assert.equal(revoked.ok, true);
  const late = await owner.send('team.chat.post', { channel_id: 'chan_team', text: 'after revocation' });
  assert.equal(late.ok, true);
  await pause(100);
  assert.equal(chatFrames(phone.stream).length, 1, 'nothing live after the revocation');
  // Replay from the start with the identity that device's stream carried.
  const response = Object.assign(new EventEmitter(), { frames: [], writableLength: 0, write(frame) { this.frames.push(frame); },
    destroy() {} });
  const unsubscribe = env.core.events.subscribe({ response, deviceId: second.device_id, authorized: () => true,
    bootEpoch: env.context.bootEpoch, cursor: 0, identity });
  assert.equal(chatFrames({ frames: response.frames }).length, 0, 'nothing on replay');
  unsubscribe?.();
  assertEveryChatPublishHasAudience(calls);
});

test('a teamchat:chan_dm bucket is not delivered even with a full audience', async (t) => {
  const { env, seeded } = await setup(t);
  const owner = await connect(env, seeded.owner.key);
  const member = await connect(env, seeded.member.key);
  const everyone = new Set([seeded.owner.member_id, seeded.member.member_id, seeded.readOnly.member_id]);
  env.core.events.publish('team_chat_message', { channel_id: 'chan_dm_x', probe: 'dm_probe' },
    { audience: everyone, bucket: DM_BUCKET });
  env.core.events.publish('team_chat_message', { channel_id: 'chan_team', probe: 'team_probe' },
    { audience: everyone, bucket: 'teamchat:chan_team' });
  assert.equal(await waitUntil(() => member.stream.frames.join('').includes('team_probe')), true);
  assert.equal(await waitUntil(() => owner.stream.frames.join('').includes('team_probe')), true);
  for (const stream of [owner.stream, member.stream]) assert.equal(stream.frames.join('').includes('dm_probe'), false);
});

test('a stream opened before a member is demoted to read-only still receives chat events', async (t) => {
  const { env, calls, seeded } = await setup(t);
  const owner = await connect(env, seeded.owner.key);
  const member = await connect(env, seeded.member.key);
  const demoted = await owner.send('team.member.setRole', { member_id: seeded.member.member_id, role: 'read_only' });
  assert.equal(demoted.ok, true);
  const posted = await owner.send('team.chat.post', { channel_id: 'chan_team', text: 'after demotion' });
  assert.equal(posted.ok, true);
  assert.equal(await waitUntil(() => chatFrames(member.stream).length === 1), true);
  const refused = await member.send('team.chat.post', { channel_id: 'chan_team', text: 'cannot' });
  assert.equal(refused.error.reason, 'role_forbidden');
  assertEveryChatPublishHasAudience(calls);
});

test('the stream identity follows the live directory and the channel rule', async (t) => {
  const { env, seeded } = await setup(t);
  const { directory } = env.store;
  const identity = streamIdentity(directory, seeded.member);
  const scope = (bucket) => ({ type: 'team_chat_message', bucket });
  assert.equal(identity.memberId, seeded.member.member_id);
  assert.equal(identity.mayReceive(seeded.member.member_id, scope('teamchat:chan_team')), true);
  assert.equal(identity.mayReceive(seeded.member.member_id, scope('teamchat:chan_project_p1')), true);
  assert.equal(identity.mayReceive(seeded.member.member_id, scope(DM_BUCKET)), false);
  assert.equal(identity.mayReceive(seeded.member.member_id, scope('teamchat:chan_bogus')), false);
  assert.equal(identity.mayReceive(seeded.owner.member_id, scope('teamchat:chan_team')), false, 'another member id');
  assert.equal(streamIdentity(directory, { member_id: null, device_id: seeded.invite.inviteId }), undefined);
  const pending = streamIdentity(directory, seeded.pending);
  assert.equal(pending.mayReceive(seeded.pending.member_id, scope('teamchat:chan_team')), false);
  const ownerOnly = streamIdentity(directory, seeded.owner);
  assert.equal(ownerOnly.mayReceive(seeded.owner.member_id, scope(DM_BUCKET)), false, 'not even the owner');
});

test('the worst-case record (16,000 four-byte characters, ten earlier versions) arrives as a message frame', async (t) => {
  const { env, calls, seeded } = await setup(t);
  const owner = await connect(env, seeded.owner.key);
  const member = await connect(env, seeded.member.key);
  // Exactly 16,000 code points, 63,994 UTF-8 bytes each.
  const version = (n) => `${String(n).padStart(2, '0')}${'\u{1F600}'.repeat(15_998)}`;
  const posted = await owner.send('team.chat.post', { channel_id: 'chan_team', text: version(0) });
  assert.equal(posted.ok, true);
  let rev = posted.rev;
  for (let n = 1; n <= 10; n += 1) {
    const edited = await owner.send('team.chat.edit', { channel_id: 'chan_team', message_id: posted.message_id,
      text: version(n), expected_rev: rev });
    assert.equal(edited.ok, true, `edit ${n}`);
    rev = edited.rev;
  }
  const record = env.chat.store.getMessage('chan_team', posted.message_id).message;
  assert.equal(record.edits.length, 10);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) > 512 * 1024, 'the stored record is over the frame limit');
  assert.equal(await waitUntil(() => chatFrames(member.stream).length === 11, { attempts: 250 }), true);
  // A fresh stream opens with `replay_unavailable`; an oversized event would add `event_size_limit`.
  assert.equal(member.stream.frames.join('').includes('event_size_limit'), false);
  const last = chatFrames(member.stream).at(-1);
  assert.equal(last.event_type, 'team_chat_message');
  assert.equal(last.channel_rev, rev);
  assert.equal(last.message.text, version(10));
  assert.ok(last.message.edits.length > 0 && last.message.edits.length < 10);
  assert.equal(last.message.edits.at(-1).text, version(9), 'the newest earlier version is kept');
  assert.ok(Buffer.byteLength(JSON.stringify(last.message)) <= 256 * 1024);
  assertEveryChatPublishHasAudience(calls);
});

// ------------------------------------------------------------ typing (slice 2a-3b)

test('typing: the channel audience only, ephemeral, at most one per 3 s per device, roots resolved', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, bob, owner } = f.seats;
  const typingEvents = () => f.published.filter((entry) => entry.type === 'team_chat_typing');
  const root = await f.post(owner, 'root');
  const reply = await f.post(bob, 'reply', { thread_root_id: root.message_id });

  assert.equal((await f.send(alice, 'team.chat.typing', { channel_id: 'chan_team' })).ok, true);
  const [first] = typingEvents();
  assert.deepEqual(first.payload, { channel_id: 'chan_team', thread_root_id: null, member_id: alice.member_id });
  assert.equal(first.options.ephemeral, true);
  assert.equal(first.options.bucket, 'teamchat:chan_team');
  assert.deepEqual([...first.options.audience].sort(), [...f.chat.channelAudience('chan_team')].sort());
  // The fixture's revoked seat is a revoked device of an active member, so only the pending member is outside.
  assert.equal(first.options.audience.has(f.seats.pat.member_id), false, 'a pending member is outside');

  // An early repeat from the same device answers ok and publishes nothing; another member is not held.
  assert.equal((await f.send(alice, 'team.chat.typing', { channel_id: 'chan_team' })).ok, true);
  assert.equal(typingEvents().length, 1);
  assert.equal((await f.send(bob, 'team.chat.typing', { channel_id: 'chan_team', thread_root_id: reply.message_id })).ok,
    true);
  assert.equal(typingEvents()[1].payload.thread_root_id, root.message_id, 'a reply id names its thread root');
  f.fx.advance(3_000);
  assert.equal((await f.send(alice, 'team.chat.typing', { channel_id: 'chan_team' })).ok, true);
  assert.equal(typingEvents().length, 3);

  // Never stored: the store did not change and nothing went to a replayable bucket.
  assert.ok(typingEvents().every((entry) => entry.options.ephemeral === true));
  assert.equal(f.chat.store.channelInfo('chan_team').last_seq, 2);
});

test('typing in an archived channel is refused and publishes nothing', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_old' })).ok, true);
  assert.equal((await f.chat.store.archiveChannel({ channelId: 'chan_project_old' })).ok, true);
  const answer = await f.send(f.seats.alice, 'team.chat.typing', { channel_id: 'chan_project_old' });
  assert.equal(f.reasonOf(answer), 'team_chat_archived');
  assert.equal(f.published.filter((entry) => entry.type === 'team_chat_typing').length, 0);
});

test('typing reaches member streams live and is absent from replay after a reconnect', async (t) => {
  const { env, calls, seeded } = await setup(t);
  const owner = await connect(env, seeded.owner.key);
  const member = await connect(env, seeded.member.key);
  assert.equal((await member.send('team.chat.typing', { channel_id: 'chan_team' })).ok, true);
  assert.equal(await waitUntil(() => chatFrames(owner.stream).some((frame) => frame.event_type === 'team_chat_typing')),
    true);
  member.client.close();
  const again = await connect(env, seeded.member.key);
  const response = Object.assign(new EventEmitter(), { frames: [], writableLength: 0, write(frame) { this.frames.push(frame); },
    destroy() {} });
  const identity = streamIdentity(env.store.directory, seeded.member);
  const unsubscribe = env.core.events.subscribe({ response, deviceId: seeded.member.device_id, authorized: () => true,
    bootEpoch: env.context.bootEpoch, cursor: 0, identity });
  unsubscribe?.();
  assert.equal(chatFrames({ frames: response.frames }).some((frame) => frame.event_type === 'team_chat_typing'), false);
  assert.equal(chatFrames(again.stream).some((frame) => frame.event_type === 'team_chat_typing'), false);
  assertEveryChatPublishHasAudience(calls);
});

test('a typing repeat inside 3 s answers ok without touching the store read path; roots resolve from memory', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice, owner } = f.seats;
  const root = await f.post(owner, 'root');
  const params = { channel_id: 'chan_team', thread_root_id: root.message_id };
  const store = f.chat.store;
  const touched = [];
  for (const name of ['ensureLoaded', 'getMessage', 'rootIdOf', 'history', 'segmentBefore']) {
    const original = store[name];
    if (typeof original !== 'function') continue;
    store[name] = function spy(...args) { touched.push(name); return original.apply(this, args); };
  }
  assert.equal((await f.send(alice, 'team.chat.typing', params)).ok, true);
  assert.equal(touched.includes('getMessage'), false, 'the root is resolved without reading its record');
  touched.length = 0;
  assert.equal((await f.send(alice, 'team.chat.typing', params)).ok, true);
  assert.deepEqual(touched, [], 'a refused repeat reads nothing');
  assert.equal(f.published.filter((entry) => entry.type === 'team_chat_typing').length, 1);
});
