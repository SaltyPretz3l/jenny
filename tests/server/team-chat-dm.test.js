'use strict';

// Slice 2d, host half: direct messages. Two to eight members open a private conversation on the host and only
// they can read, search or hear about it. Through the real router, authorizer, registry, chat host and store.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createAuthorizer, channelMembers, streamIdentity } = require('../../server/team/authorize');
const { SCHEMA_VERSION, CHANNEL_SCHEMA_VERSION } = require('../../services/host/team-chat-schema');
const { createChatFixture, assertFailure } = require('./helpers/team-chat-fixture');
const { createTeamDirectoryFixture } = require('./helpers/team-directory-fixture');
const { chatFrames, connectMember: connect, createTeamHttpFixture, pause, waitUntil } = require('./helpers/team-http-fixture');
const { NO_SUCH_DM, SOME_MESSAGE, bytesOf, createDmFixture, dmIdOf } = require('./helpers/team-dm-fixture');

const MARKER = 'zebra-marker-7431';
const FORBIDDEN = 'CMP-HOST-0003';

const dmChannels = (f) => f.chat.store.listChannels().channels.filter((channel) => channel.kind === 'dm');
const createdEvents = (f) => f.chatEvents().filter((event) => event.payload.reason === 'created');

// ---------------------------------------------------------------- open

test('open: two, three and eight members; the same people open the same conversation in any order', async (t) => {
  const f = await createDmFixture(t, { extras: 2 });
  const [owner, alice, bob] = ['owner', 'alice', 'bob'].map(f.id);
  assert.equal(f.sevenOthers.length, 7);
  const two = await f.opened(f.seats.owner, [alice]);
  assert.equal(two, dmIdOf([owner, alice]));
  const three = await f.opened(f.seats.owner, [bob, alice]);
  assert.equal(three, dmIdOf([owner, alice, bob]));
  assert.equal(await f.opened(f.seats.bob, [owner, alice]), three, 'from another participant');
  assert.equal(await f.opened(f.seats.alice, [bob, owner]), three, 'in another order');
  const eight = await f.opened(f.seats.owner, f.sevenOthers);
  assert.equal(eight, dmIdOf([owner, ...f.sevenOthers]));
  assert.equal(dmChannels(f).length, 3, 'three conversations, none made twice');
  assert.equal(createdEvents(f).length, 3, 'only a new conversation is announced');
});

test('open again changes nothing: no event and no revision bump', async (t) => {
  const f = await createDmFixture(t);
  const channelId = await f.opened(f.seats.owner, [f.id('alice')]);
  await f.postIn(f.seats.alice, channelId, 'first');
  const before = f.chat.store.channelInfo(channelId);
  const events = f.chatEvents().length;
  const again = await f.open(f.seats.alice, [f.id('owner')]);
  assert.deepEqual([again.ok, again.channel_id], [true, channelId]);
  assert.deepEqual(f.chat.store.channelInfo(channelId), before);
  assert.equal(f.chatEvents().length, events);
});

test('a full disk refuses a new conversation and still answers one that exists', async (t) => {
  const f = await createDmFixture(t);
  const channelId = await f.opened(f.seats.owner, [f.id('alice')]);
  f.setAdmit(false);
  const again = await f.open(f.seats.alice, [f.id('owner')]);
  assert.deepEqual([again.ok, again.channel_id], [true, channelId], 'it writes nothing, so it is not gated');
  assert.equal(f.reasonOf(await f.open(f.seats.owner, [f.id('bob')])), 'disk_pressure');
  assert.equal(dmChannels(f).length, 1);
  f.setAdmit(true);
  assert.equal((await f.open(f.seats.owner, [f.id('bob')])).ok, true);
});

test('open refuses the caller\'s own id, a duplicate, zero ids, eight ids and a read-only caller', async (t) => {
  const f = await createDmFixture(t, { extras: 2 });
  const [owner, alice] = ['owner', 'alice'].map(f.id);
  assert.equal(f.reasonOf(await f.open(f.seats.owner, [owner, alice])), 'team_chat_dm_members_invalid');
  assert.equal(f.reasonOf(await f.open(f.seats.owner, [owner])), 'team_chat_dm_members_invalid');
  assert.equal(f.reasonOf(await f.open(f.seats.owner, [alice, alice])), 'invalid_command_parameters');
  assert.equal(f.reasonOf(await f.open(f.seats.owner, [])), 'invalid_command_parameters');
  assert.equal(f.reasonOf(await f.open(f.seats.owner, [...f.sevenOthers, 'member_eighth'])), 'invalid_command_parameters',
    'seven others is the most; eight ids is too many');
  assert.equal(f.reasonOf(await f.open(f.seats.rae, [alice])), 'role_forbidden', 'read-only may not open one');
  assert.equal(dmChannels(f).length, 0, 'nothing was created');
});

test('a pending, a removed and an unknown member each refuse the whole call with one identical answer', async (t) => {
  const f = await createDmFixture(t, { extras: 1 });
  const [removed] = f.extras;
  const revoked = await f.send(f.seats.owner, 'team.member.revoke', { member_id: removed });
  assert.equal(revoked.ok, true);
  const pending = await f.fx.joinMember(f.store, f.id('owner'), { displayName: 'Waiting', admit: false });
  const answers = [];
  for (const wrong of [pending.member_id, removed, 'member_nobody_at_all']) {
    answers.push(bytesOf(await f.open(f.seats.owner, [f.id('alice'), wrong])));
  }
  assert.equal(new Set(answers).size, 1, 'the same bytes whichever id was wrong');
  assert.match(answers[0], /team_chat_dm_members_invalid/u);
  assert.doesNotMatch(answers[0], /member_/u, 'and it names no member');
  assert.equal(dmChannels(f).length, 0);
});

test('a read-only participant reads the conversation and cannot post in it', async (t) => {
  const f = await createDmFixture(t);
  const channelId = await f.opened(f.seats.owner, [f.id('rae')]);
  assert.equal((await f.postIn(f.seats.owner, channelId, 'for rae')).ok, true);
  const read = await f.send(f.seats.rae, 'team.chat.history', { channel_id: channelId, limit: 5 });
  assert.deepEqual(read.messages.map((message) => message.text), ['for rae']);
  assert.equal(f.reasonOf(await f.postIn(f.seats.rae, channelId, 'no')), 'role_forbidden');
});

test('a new conversation is announced as a created channel to its participants only', async (t) => {
  const f = await createDmFixture(t);
  const channelId = await f.opened(f.seats.owner, [f.id('alice'), f.id('rae')]);
  const [event] = createdEvents(f);
  assert.equal(event.type, 'team_chat_channel');
  assert.deepEqual(event.payload, { channel_id: channelId, reason: 'created', floor_seq: 1, channel_rev: 0, pin_count: 0 });
  assert.deepEqual([...event.options.audience].sort(), [f.id('owner'), f.id('alice'), f.id('rae')].sort());
  assert.equal(event.options.bucket, `teamchat:${channelId}`);
});

// ---------------------------------------------------------------- audience and the missing oracle

test('participants post and read; everyone else gets exactly what a conversation that does not exist gets', async (t) => {
  const f = await createDmFixture(t, { extras: 1 });
  const channelId = await f.opened(f.seats.alice, [f.id('bob')]);
  const posted = await f.postIn(f.seats.alice, channelId, `hello ${MARKER}`);
  assert.equal(posted.ok, true);
  assert.deepEqual((await f.send(f.seats.bob, 'team.chat.history', { channel_id: channelId, limit: 5 })).messages
    .map((message) => message.text), [`hello ${MARKER}`]);
  // The owner has no special reach, and Pat is an active member with write access who is not in it: both are
  // refused for the conversation alone. Rae is read-only, so her writes are refused for the role first.
  // The real list names a message that exists in the conversation, so a check that never ran would show.
  const real = f.channelOperations(channelId, posted.message_id);
  const absent = f.channelOperations(NO_SUCH_DM);
  for (const seat of ['owner', 'pat', 'rae']) {
    for (let at = 0; at < real.length; at += 1) {
      const inDm = bytesOf(await f.send(f.seats[seat], real[at][0], real[at][1]));
      const nowhere = bytesOf(await f.send(f.seats[seat], absent[at][0], absent[at][1]))
        .replaceAll(NO_SUCH_DM, channelId).replaceAll(SOME_MESSAGE, posted.message_id);
      assert.equal(inDm, nowhere, `${seat} ${real[at][0]}`);
      assert.match(inDm, seat === 'rae' ? /team_chat_not_found|role_forbidden/u : /team_chat_not_found/u,
        `${seat} ${real[at][0]} is refused`);
    }
  }
  // The conversation was not touched by any of it.
  assert.equal(f.chat.store.channelInfo(channelId).last_seq, 1);
  assert.equal(f.chat.store.channelInfo(channelId).pin_count, 0);
});

test('the overview and search never show a conversation to someone outside it', async (t) => {
  const f = await createDmFixture(t);
  const channelId = await f.opened(f.seats.alice, [f.id('bob')]);
  await f.postIn(f.seats.alice, channelId, `secret ${MARKER}`);
  await f.postIn(f.seats.alice, 'chan_team', 'a team message');
  const outsiders = ['owner', 'pat', 'rae'];
  for (const seat of outsiders) {
    const overview = JSON.stringify(await f.send(f.seats[seat], 'team.chat.overview'));
    assert.equal(overview.includes(channelId), false, `${seat} overview has no trace of the id`);
    assert.equal(overview.includes(MARKER), false);
    const wide = JSON.stringify(await f.send(f.seats[seat], 'team.chat.search', { query: MARKER, limit: 10 }));
    assert.equal(wide.includes(MARKER), false, `${seat} team-wide search finds nothing in it`);
    assert.equal(wide.includes(channelId), false);
  }
  for (const seat of ['alice', 'bob']) {
    const overview = await f.send(f.seats[seat], 'team.chat.overview');
    const row = overview.channels.find((channel) => channel.channel_id === channelId);
    assert.equal(row.kind, 'dm');
    assert.deepEqual(row.participants, [f.id('alice'), f.id('bob')].sort(), `${seat} sees who is in it`);
    assert.equal(overview.channels.find((channel) => channel.channel_id === 'chan_team').participants, undefined);
    const found = await f.send(f.seats[seat], 'team.chat.search', { query: MARKER, limit: 10 });
    assert.equal(JSON.stringify(found).includes(MARKER), true, `${seat} finds their own conversation`);
  }
});

test('nothing about a conversation reaches a log line: not its id, its text or its members', async (t) => {
  const f = await createDmFixture(t);
  const channelId = await f.opened(f.seats.alice, [f.id('bob')]);
  await f.postIn(f.seats.alice, channelId, `logged ${MARKER}`);
  await f.send(f.seats.alice, 'team.chat.react', { channel_id: channelId, message_id: f.chat.store.history(channelId,
    { limit: 5 }).messages[0].id, emoji: '\u{1F44D}', on: true });
  await f.chat.store.applyRetention();
  const text = JSON.stringify(f.fx.logs);
  assert.equal(text.includes(channelId), false);
  assert.equal(text.includes(MARKER), false);
  assert.equal(text.includes(channelId.slice(-16)), false, 'no part of the hash');
  assert.equal(f.fx.logs.some((entry) => entry.event === 'team_chat.channel_created' && entry.fields.channel_id === 'dm'), true);
});

// ---------------------------------------------------------------- the stream

test('events about a conversation reach its two participants and never the third member\'s stream', async (t) => {
  const env = await createTeamHttpFixture(t, { withChat: true });
  const seeded = await env.seed();
  const frames = ({ stream }) => chatFrames(stream);
  const owner = await connect(env, seeded.owner.key);
  const member = await connect(env, seeded.member.key);
  const third = await connect(env, seeded.readOnly.key);
  const opened = await owner.send('team.chat.dm_open', { member_ids: [seeded.member.member_id] });
  assert.equal(opened.ok, true);
  const channelId = opened.channel_id;
  const posted = await owner.send('team.chat.post', { channel_id: channelId, text: `to member ${MARKER}` });
  assert.equal((await member.send('team.chat.typing', { channel_id: channelId })).ok, true);
  assert.equal((await member.send('team.chat.pin', { channel_id: channelId, message_id: posted.message_id, on: true })).ok, true);
  const types = (who) => frames(who).filter((frame) => frame.channel_id === channelId).map((frame) => frame.event_type);
  for (const who of [owner, member]) {
    assert.equal(await waitUntil(() => types(who).includes('team_chat_channel') && types(who).includes('team_chat_typing')
      && types(who).filter((type) => type === 'team_chat_message').length >= 2), true);
  }
  await pause(200);
  assert.deepEqual(frames(third), [], 'the third member\'s stream carries no chat event about it at all');
  assert.equal(third.stream.frames.join('').includes(channelId), false);
  assert.equal(third.stream.frames.join('').includes(MARKER), false);
});

test('a participant removed from the team loses the conversation at once and hears nothing more', async (t) => {
  const env = await createTeamHttpFixture(t, { withChat: true });
  const seeded = await env.seed();
  const o = await connect(env, seeded.owner.key);
  const m = await connect(env, seeded.member.key);
  const opened = await o.send('team.chat.dm_open', { member_ids: [seeded.member.member_id, seeded.readOnly.member_id] });
  const channelId = opened.channel_id;
  assert.equal((await o.send('team.chat.post', { channel_id: channelId, text: 'before' })).ok, true);
  assert.equal(await waitUntil(() => m.stream.frames.join('').includes('before')), true);
  const seen = m.stream.frames.join('').length;
  assert.equal((await o.send('team.member.revoke', { member_id: seeded.member.member_id })).ok, true);
  assert.equal(channelMembers(env.store.directory, channelId, (id) => env.chat.store.participantsOf(id)).has(seeded.member.member_id), false);
  assert.equal((await o.send('team.chat.post', { channel_id: channelId, text: 'after' })).ok, true);
  await pause(150);
  assert.equal(m.stream.frames.join('').slice(seen).includes('after'), false, 'nothing reaches the removed member');
  // The others keep it, and the same set cannot be opened again while that member is not active.
  const kept = await o.send('team.chat.history', { channel_id: channelId, limit: 5 });
  assert.deepEqual(kept.messages.map((message) => message.text), ['before', 'after']);
  const again = await o.send('team.chat.dm_open', { member_ids: [seeded.member.member_id, seeded.readOnly.member_id] });
  assert.equal(again.error.reason, 'team_chat_dm_members_invalid');
});

test('through the real router a removed participant is refused on every call and the others keep the conversation', async (t) => {
  const f = await createDmFixture(t);
  const channelId = await f.opened(f.seats.alice, [f.id('bob'), f.id('pat')]);
  assert.equal((await f.postIn(f.seats.alice, channelId, 'before')).ok, true);
  assert.equal((await f.send(f.seats.owner, 'team.member.revoke', { member_id: f.id('bob') })).ok, true);
  for (const [operation, params] of f.channelOperations(channelId)) {
    assert.equal(f.reasonOf(await f.send(f.seats.bob, operation, params)), 'member_revoked', operation);
  }
  assert.equal(f.reasonOf(await f.open(f.seats.alice, [f.id('bob'), f.id('pat')])), 'team_chat_dm_members_invalid',
    'the same people cannot be opened again while one is not active');
  assert.deepEqual([...f.chat.channelAudience(channelId)].sort(), [f.id('alice'), f.id('pat')].sort());
  const kept = await f.send(f.seats.pat, 'team.chat.history', { channel_id: channelId, limit: 5 });
  assert.deepEqual(kept.messages.map((message) => message.text), ['before']);
});

// ---------------------------------------------------------------- the audience rule

test('the audience is the stored participants who are active now; the same id is theirs again when they are', () => {
  const fixture = createTeamDirectoryFixture();
  const { owner, member, otherMember, revoked } = fixture.actors;
  const dm = dmIdOf([member.member_id, otherMember.member_id]);
  const stored = { [dm]: [member.member_id, otherMember.member_id].sort(), [dmIdOf([owner.member_id, revoked.member_id])]: [
    owner.member_id, revoked.member_id].sort() };
  const lookup = (id) => stored[id] ?? null;
  const live = (actor) => fixture.directory.liveActor(actor.device_id);
  const { authorize } = createAuthorizer({ directory: fixture.directory, dmParticipants: lookup });
  const read = (actor, id) => authorize({ device_id: actor.device_id }, 'chat.read', { kind: 'channel', id }, 'r');
  assert.deepEqual([...channelMembers(fixture.directory, dm, lookup)].sort(), [member.member_id, otherMember.member_id].sort());
  assert.equal(read(member, dm).ok, true);
  assert.equal(read(owner, dm).error.reason, 'team_chat_not_found', 'the owner has no reach into it');
  assert.equal(streamIdentity(fixture.directory, live(member), undefined, lookup).mayReceive(member.member_id,
    { bucket: `teamchat:${dm}` }), true);
  const devices = ['device_a1', 'device_a2'];
  for (const device of devices) fixture.setState(device, 'revoked');
  assert.deepEqual([...channelMembers(fixture.directory, dm, lookup)], [otherMember.member_id]);
  assert.equal(read(member, dm).error.reason, 'member_revoked', 'and their own devices are refused');
  assert.equal(streamIdentity(fixture.directory, live(member), undefined, lookup).mayReceive(member.member_id,
    { bucket: `teamchat:${dm}` }), false, 'and nothing is delivered to them');
  for (const device of devices) fixture.setState(device, 'active');
  assert.deepEqual([...channelMembers(fixture.directory, dm, lookup)].sort(), [member.member_id, otherMember.member_id].sort(),
    'active again: theirs again');
  assert.equal(channelMembers(fixture.directory, dmIdOf([owner.member_id, revoked.member_id]), lookup).has(revoked.member_id),
    false, 'a participant who is not active is not in it');
});

test('fail closed: no lookup, a lookup that throws, an unknown id and no stored participants show it to nobody', () => {
  const fixture = createTeamDirectoryFixture();
  const { owner, member } = fixture.actors;
  const dm = dmIdOf([owner.member_id, member.member_id]);
  const ids = [owner.member_id, member.member_id].sort();
  const cases = {
    'no lookup': undefined,
    'a lookup that throws': () => { throw new Error('store gone'); },
    'an unknown id': (id) => (id === dm ? null : ids),
    'no stored participants': () => [],
    'a wrong answer': () => 'member_owner',
  };
  for (const [name, lookup] of Object.entries(cases)) {
    const { authorize } = createAuthorizer({ directory: fixture.directory, dmParticipants: lookup });
    for (const actor of [owner, member]) {
      const answer = authorize({ device_id: actor.device_id }, 'chat.read', { kind: 'channel', id: dm }, 'r');
      assert.equal(answer.error.reason, 'team_chat_not_found', `${name}: ${actor.member_id}`);
    }
    assert.equal(channelMembers(fixture.directory, dm, lookup).size, 0, name);
    assert.equal(streamIdentity(fixture.directory, owner, undefined, lookup).mayReceive(owner.member_id,
      { bucket: `teamchat:${dm}` }), false, `${name}: no stream delivery`);
  }
});

// ---------------------------------------------------------------- the stored field and its migration

test('migration: a version 1 store loads, a conversation is opened, the channel documents are version 2 and load again', async (t) => {
  const fx = createChatFixture(t);
  const first = fx.openStore();
  await fx.createChannel(first, 'chan_team');
  await fx.postOk(first);
  // Put the team channel back as version 1 wrote it: no participants key.
  const old = fx.readDoc('chan_team/channel.json');
  delete old.participants;
  old.schema_version = 1;
  fx.writeDoc('chan_team/channel.json', old);
  const store = fx.openStore();
  assert.equal(store.history('chan_team', { limit: 5 }).messages.length, 1, 'a version 1 channel is read');
  assert.equal(fx.readDoc('chan_team/channel.json').schema_version, 1, 'reading writes nothing');
  const opened = await store.openDirect({ memberIds: ['member_bob', 'member_alice'] });
  assert.deepEqual([opened.ok, opened.created], [true, true]);
  await fx.postOk(store);
  assert.equal(fx.readDoc('chan_team/channel.json').schema_version, CHANNEL_SCHEMA_VERSION, 'written forward');
  assert.equal(fx.readDoc('chan_team/channel.json').participants, null);
  const dmDoc = fx.readDoc(`${opened.channel_id}/channel.json`);
  assert.equal(dmDoc.schema_version, CHANNEL_SCHEMA_VERSION);
  assert.deepEqual(dmDoc.participants, ['member_alice', 'member_bob']);
  assert.equal(fx.readDoc('index.json').schema_version, SCHEMA_VERSION, 'the index shape did not change');
  const again = fx.openStore();
  assert.deepEqual(again.participantsOf(opened.channel_id), ['member_alice', 'member_bob']);
  assert.equal(again.participantsOf('chan_team'), null);
  assert.equal(again.history('chan_team', { limit: 5 }).messages.length, 2);
});

test('a channel document of a newer version, or with participants it may not carry, is refused and nothing is rewritten', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  const { channel_id: dm } = await store.openDirect({ memberIds: ['member_alice', 'member_bob'] });
  await fx.createChannel(store, 'chan_team');
  await fx.createChannel(store, 'chan_project_p1');
  const original = Object.fromEntries([dm, 'chan_team', 'chan_project_p1'].map((id) => [id, fx.readDoc(`${id}/channel.json`)]));
  const both = ['member_alice', 'member_bob'];
  const cases = [
    ['a newer version', dm, { schema_version: 3 }, 'team_chat_schema_unsupported'],
    ['a participant who is not in the id', dm, { participants: ['member_alice', 'member_carol'] }, 'team_chat_store_failed'],
    ['participants out of order', dm, { participants: ['member_bob', 'member_alice'] }, 'team_chat_store_failed'],
    ['one participant', dm, { participants: ['member_alice'] }, 'team_chat_store_failed'],
    ['a direct conversation without them', dm, { participants: null }, null],
    ['a team channel that names participants', 'chan_team', { participants: both }, 'team_chat_store_failed'],
    ['a project channel that names participants', 'chan_project_p1', { participants: both }, 'team_chat_store_failed'],
    ['a version 1 document that carries participants', dm, { schema_version: 1 }, 'team_chat_store_failed'],
  ];
  for (const [name, id, change, reason] of cases) {
    fx.writeDoc(`${id}/channel.json`, { ...original[id], ...change });
    const before = fx.snapshotTree();
    const reopened = fx.newStore();
    if (reason) assertFailure(reopened.open(), 'CMP-HOST-0006', reason);
    else assert.equal(reopened.open().ok, true, name);
    assert.deepEqual(fx.snapshotTree(), before, `${name}: nothing rewritten`);
    fx.writeDoc(`${id}/channel.json`, original[id]);
  }
});

test('a direct conversation cannot be made without its participants', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  fx.takeWrites();
  assertFailure(await store.createChannel({ channelId: dmIdOf(['member_alice', 'member_bob']) }), FORBIDDEN,
    'team_chat_not_found');
  assertFailure(await store.createChannel({ channelId: NO_SUCH_DM }), FORBIDDEN, 'team_chat_not_found');
  assert.deepEqual(fx.takeWrites(), [], 'nothing was written');
  assert.deepEqual(store.listChannels().channels, []);
  const opened = await store.openDirect({ memberIds: ['member_alice', 'member_bob'] });
  assert.equal(opened.created, true, 'the people can still open it');
  assert.equal(Object.isFrozen(store.participantsOf(opened.channel_id)), true, 'the stored list is shared as it is');
});

// Every log line of the chat host that carries a channel id goes through `logChannel`, so a direct conversation's
// hash is never in a log. A source check: retention in a test never reaches every one of these lines.
test('every channel_id log field in the chat host source goes through logChannel', () => {
  const dir = path.join(__dirname, '..', '..', 'services', 'host');
  const files = fs.readdirSync(dir).filter((name) => /^team-chat-.*\.js$/u.test(name));
  assert.ok(files.length >= 8);
  let seen = 0;
  for (const name of files) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\n')) {
      if (!/\b_?log\(/u.test(line) || !/channel_?[iI]d/u.test(line)) continue;
      seen += 1;
      assert.match(line, /channel_id: logChannel\(/u, `${name}: ${line.trim()}`);
    }
  }
  assert.ok(seen >= 8, 'the check found the log lines');
});

test('openDirect refuses a bad member list before it writes anything', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  fx.takeWrites();
  for (const memberIds of [undefined, [], ['member_alice'], ['member_alice', 'member_alice'], ['member_alice', 'nope'],
    Array.from({ length: 9 }, (_, at) => `member_m${at}`)]) {
    assertFailure(await store.openDirect({ memberIds }), 'CMP-HOST-0001', 'team_chat_request_invalid');
  }
  assert.deepEqual(fx.takeWrites(), []);
});
