'use strict';

// new-test-file: row 173 adds a new surface (the four channel-management operations, the channel record's schema 3
// and its audit entries); team-chat-commands.test.js and team-chat-store.test.js sit near the line cap.
//
// Row 173 (TEAM_CHANNELS_2026-11-16.md "Host contract"): custom channels made, renamed, given a topic, archived and
// deleted through the real router, authorizer, team commands and chat dispatcher on a real member store and chat
// store, with the chat audit wired as the host composes it; and the store's schema 3 migration.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { BOOT, BackendHarness, command } = require('../helpers/command-router-fixture');
const { ClientRegistry } = require('../../server/client-registry');
const { CommandReceipts } = require('../../server/command-receipts');
const { ControlLeases } = require('../../server/control-leases');
const { createCommandRouter } = require('../../server/command-router');
const { validateCommand } = require('../../server/api-contract');
const { createAuthorizer } = require('../../server/team/authorize');
const { createInviteService } = require('../../server/team/invites');
const { createTeamCommands } = require('../../server/team/team-commands');
const { CHANNEL_SCHEMA_VERSION, LIMITS } = require('../../services/host/team-chat-schema');
const { chatAudit, chatRoster, createTeamChatHost } = require('../../services/host/team-chat-host');
const { createFixture } = require('./helpers/team-store-fixture');
const { createChatFixture, ALICE, BOB, ALICE_DEVICE } = require('./helpers/team-chat-fixture');

const CUSTOM_ID = /^chan_c_[a-z2-7]{16}$/u;
const PROFILE_KEYS = ['archived_by', 'changes', 'created_by', 'name', 'topic'];
const EVENT_KEYS = ['channel_id', 'channel_rev', 'floor_seq', 'pin_count', 'reason', ...PROFILE_KEYS].sort();

// The chat fixture of team-chat-commands.test.js, with the chat audit wired as team-main composes it (`audit: false`
// leaves it out). Seats: the owner, Alice and Bob (members), Rae (read-only).
async function channelsFixture(t, { audit = true } = {}) {
  const fx = createFixture(null);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store, 'Olive Owner');
  const alice = await fx.joinMember(store, owner.member_id, { displayName: 'Alice' });
  const bob = await fx.joinMember(store, owner.member_id, { displayName: 'Bob' });
  const rae = await fx.joinMember(store, owner.member_id, { displayName: 'Rae', role: 'read_only' });
  const invites = createInviteService({ store, clock: fx.clock, randomBytes: fx.randomBytes, logger: fx.logger });
  let chat = null;
  const { authorize } = createAuthorizer({ directory: store.directory,
    dmParticipants: (channelId) => chat?.store?.participantsOf(channelId) });
  const published = [];
  const eventStream = { publish: (type, payload, options) => published.push({ type, payload, options }) };
  chat = createTeamChatHost({ profileDir: fx.dir, directory: store.directory, logger: fx.logger, clock: fx.clock,
    randomBytes: fx.randomBytes, publish: eventStream.publish, roster: chatRoster(store),
    ...(audit ? { audit: chatAudit(store) } : {}) });
  const teamCommands = createTeamCommands({ store, invites, directory: store.directory, clock: fx.clock,
    logger: fx.logger, chat: chat.commands });
  fs.mkdirSync(path.join(fx.dir, 'backend'));
  const backend = new BackendHarness(path.join(fx.dir, 'backend'));
  const clients = new ClientRegistry();
  const router = createCommandRouter({ backend, clients, leases: new ControlLeases(),
    receipts: new CommandReceipts({ filePath: path.join(fx.dir, 'command-receipts.json') }),
    bootEpoch: BOOT, eventStream, authorize, teamCommands, canAdmit: () => true });
  await chat.start();
  const seatOf = (member) => ({ ...member, auth: clients.register(member.device_id) });
  const seats = { owner: seatOf(owner), alice: seatOf(alice), bob: seatOf(bob), rae: seatOf(rae) };
  t.after(async () => {
    await chat.dispose();
    router.dispose();
    backend.dispose();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });
  const dispatch = (seat, cmd) => router.dispatch(cmd, { deviceId: seat.device_id, clientToken: seat.auth.client_token,
    isAuthenticated: () => true, actor: { device_id: seat.device_id } });
  const send = (seat, operation, params = {}) => dispatch(seat, command(seat.auth, operation, params));
  const reasonOf = (answer) => (answer.ok ? 'ok' : answer.error.reason);
  const header = (channelId) => chat.store.channelHeader(channelId);
  const channelEvents = () => published.filter((entry) => entry.type === 'team_chat_channel');
  async function create(seat, name, topic) {
    const made = await send(seat, 'team.chat.channel_create', { name, ...(topic === undefined ? {} : { topic }) });
    assert.equal(made.ok, true, `create failed: ${JSON.stringify(made)}`);
    return made.channel_id;
  }
  const update = (seat, channelId, fields) => send(seat, 'team.chat.channel_update',
    { channel_id: channelId, expected_rev: header(channelId).rev, ...fields });
  const archive = (seat, channelId, on = true) => send(seat, 'team.chat.channel_archive', { channel_id: channelId, on });
  const remove = (seat, channelId) => send(seat, 'team.chat.channel_delete', { channel_id: channelId });
  const overviewRow = async (seat, channelId) => (await send(seat, 'team.chat.overview')).channels
    .find((row) => row.channel_id === channelId);
  return { fx, store, chat, seats, send, dispatch, reasonOf, header, published, channelEvents, create, update, archive,
    remove, overviewRow };
}

const memberIds = (f) => ['owner', 'alice', 'bob', 'rae'].map((name) => f.seats[name].member_id).sort();

test('create: every active member lists the channel with its profile; a created event reaches the team audience', async (t) => {
  const f = await channelsFixture(t);
  const { alice } = f.seats;
  const made = await f.send(alice, 'team.chat.channel_create', { name: 'Design', topic: 'Pixels and type' });
  assert.deepEqual(Object.keys(made).sort(), ['channel_id', 'ok', 'rev']);
  assert.match(made.channel_id, CUSTOM_ID);
  assert.equal(made.rev, 1);
  for (const name of ['owner', 'alice', 'bob', 'rae']) {
    const row = await f.overviewRow(f.seats[name], made.channel_id);
    assert.equal(row.kind, 'channel', name);
    assert.deepEqual([row.name, row.topic, row.created_by, row.archived, row.archived_by],
      ['Design', 'Pixels and type', alice.member_id, false, null], name);
    assert.equal(row.changes.length, 1);
    assert.deepEqual(Object.keys(row.changes[0]).sort(), ['at', 'by', 'kind', 'seq_after']);
    assert.deepEqual([row.changes[0].kind, row.changes[0].by, row.changes[0].seq_after], ['created', alice.member_id, 0]);
  }
  const team = await f.overviewRow(alice, 'chan_team');
  assert.deepEqual([team.name, team.topic, team.created_by, team.archived_by, team.changes], ['team', '', null, null, []]);
  const [event] = f.channelEvents();
  assert.deepEqual(Object.keys(event.payload).sort(), EVENT_KEYS);
  assert.deepEqual([event.payload.reason, event.payload.channel_id, event.payload.name, event.payload.channel_rev],
    ['created', made.channel_id, 'Design', 1]);
  assert.deepEqual([...event.options.audience].sort(), memberIds(f));
  assert.equal(event.options.bucket, `teamchat:${made.channel_id}`);
  // Anyone who can post in the team channel posts here; the read-only member reads it.
  assert.equal((await f.send(f.seats.bob, 'team.chat.post', { channel_id: made.channel_id, text: 'hi' })).ok, true);
  assert.equal(f.reasonOf(await f.send(f.seats.rae, 'team.chat.post', { channel_id: made.channel_id, text: 'hi' })),
    'role_forbidden');
  assert.equal((await f.send(f.seats.rae, 'team.chat.history', { channel_id: made.channel_id, limit: 5 })).messages.length, 1);
});

test('names: trimmed and collapsed; length, control, bidi and a leading # refused; taken names refused, case ignored', async (t) => {
  const f = await channelsFixture(t);
  const { owner, alice } = f.seats;
  const spaced = await f.create(alice, '  Big \t  Ideas  ');
  assert.equal(f.header(spaced).name, 'Big Ideas');
  const invalid = async (name) => {
    const answer = await f.send(alice, 'team.chat.channel_create', { name });
    assert.equal(f.reasonOf(answer), 'team_chat_channel_name_invalid', JSON.stringify(name));
    assert.equal(answer.error.code, 'CMP-HOST-0001');
  };
  await invalid('x'.repeat(LIMITS.CHANNEL_NAME_MAX + 1));
  await invalid('\u00E9'.repeat(LIMITS.CHANNEL_NAME_MAX + 1));
  await invalid('bell\u0007');
  await invalid('left\u202Eright');
  await invalid('iso\u2066late');
  await invalid('#design');
  await invalid('   ');
  assert.match(await f.create(alice, '\u00E9'.repeat(LIMITS.CHANNEL_NAME_MAX)), CUSTOM_ID);
  const design = await f.create(alice, 'Design');
  const taken = async (name) => {
    const answer = await f.send(owner, 'team.chat.channel_create', { name });
    assert.equal(f.reasonOf(answer), 'team_chat_channel_name_taken', name);
    assert.equal(answer.error.code, 'CMP-HOST-0001');
  };
  await taken('design');
  await taken('TEAM');
  assert.equal((await f.archive(alice, design)).ok, true);
  await taken('DESIGN');
  // Topics: one line, the same characters, 250 code points.
  const topic = async (value) => f.reasonOf(await f.send(alice, 'team.chat.channel_create', { name: `T${value.length}`, topic: value }));
  assert.equal(await topic('two\nlines'), 'team_chat_channel_topic_invalid');
  assert.equal(await topic('sep\u2028arated'), 'team_chat_channel_topic_invalid');
  assert.equal(await topic('y'.repeat(LIMITS.CHANNEL_TOPIC_MAX + 1)), 'team_chat_channel_topic_invalid');
  assert.equal(await topic('  padded  '), 'ok');
  assert.equal(f.header('chan_team').topic, '');
  // The wire bounds: a name past 160 UTF-16 units never reaches the host.
  assert.equal(f.reasonOf(await f.send(alice, 'team.chat.channel_create', { name: 'z'.repeat(161) })),
    'invalid_command_parameters');
});

test('cap: the 33rd live custom channel is refused; archiving one frees a place', async (t) => {
  const f = await channelsFixture(t);
  const { alice } = f.seats;
  const made = [];
  for (let i = 0; i < LIMITS.CUSTOM_CHANNELS_MAX; i += 1) made.push(await f.create(alice, `room ${i}`));
  const refused = await f.send(alice, 'team.chat.channel_create', { name: 'one too many' });
  assert.equal(f.reasonOf(refused), 'team_chat_channel_cap');
  assert.equal(refused.error.code, 'CMP-HOST-0007');
  assert.equal((await f.archive(alice, made[0])).ok, true);
  assert.match(await f.create(alice, 'one too many'), CUSTOM_ID);
  // Unarchiving makes a channel live again, so it is refused while the live cap is full.
  assert.equal(f.reasonOf(await f.archive(f.seats.owner, made[0], false)), 'team_chat_channel_cap');
  assert.equal(f.header(made[0]).archived !== null, true);
});

test('rules: owner, creator, other member and read-only member on a custom channel, #team, a project and a direct channel', async (t) => {
  const f = await channelsFixture(t);
  const { owner, alice, bob, rae } = f.seats;
  const RF = 'role_forbidden';
  const FIXED = 'team_chat_channel_fixed';
  // Create: anyone not read-only.
  assert.equal(f.reasonOf(await f.send(rae, 'team.chat.channel_create', { name: 'rae room' })), RF);
  for (const seat of [owner, alice, bob]) assert.match(await f.create(seat, `room of ${seat.member_id}`), CUSTOM_ID);
  const id = await f.create(alice, 'Design');
  const expect = async (label, rows) => {
    for (const [seat, run, reason] of rows) assert.equal(f.reasonOf(await run(seat)), reason, `${label}: ${seat.member_id}`);
  };
  await expect('rename', [[bob, (s) => f.update(s, id, { name: 'Bobs' }), RF], [rae, (s) => f.update(s, id, { name: 'Raes' }), RF],
    [alice, (s) => f.update(s, id, { name: 'Design 2' }), 'ok'], [owner, (s) => f.update(s, id, { name: 'Design 3' }), 'ok']]);
  await expect('topic', [[bob, (s) => f.update(s, id, { topic: 'b' }), RF], [rae, (s) => f.update(s, id, { topic: 'r' }), RF],
    [alice, (s) => f.update(s, id, { topic: 'a' }), 'ok'], [owner, (s) => f.update(s, id, { topic: 'o' }), 'ok']]);
  await expect('archive', [[bob, (s) => f.archive(s, id), RF], [rae, (s) => f.archive(s, id), RF],
    [alice, (s) => f.archive(s, id), 'ok']]);
  await expect('unarchive', [[alice, (s) => f.archive(s, id, false), RF], [bob, (s) => f.archive(s, id, false), RF],
    [rae, (s) => f.archive(s, id, false), RF], [owner, (s) => f.archive(s, id, false), 'ok']]);
  await expect('archive by owner', [[owner, (s) => f.archive(s, id), 'ok']]);
  await expect('delete', [[alice, (s) => f.remove(s, id), RF], [bob, (s) => f.remove(s, id), RF],
    [rae, (s) => f.remove(s, id), RF], [owner, (s) => f.remove(s, id), 'ok']]);
  // #team: never renamed, archived or deleted; its topic is the owner's.
  await expect('#team', [[owner, (s) => f.update(s, 'chan_team', { name: 'general' }), FIXED],
    [owner, (s) => f.archive(s, 'chan_team'), FIXED], [owner, (s) => f.archive(s, 'chan_team', false), FIXED],
    [owner, (s) => f.remove(s, 'chan_team'), FIXED], [alice, (s) => f.update(s, 'chan_team', { topic: 'mine' }), RF],
    [owner, (s) => f.update(s, 'chan_team', { topic: 'Everyone' }), 'ok']]);
  assert.equal(f.header('chan_team').topic, 'Everyone');
  // A project channel and a direct conversation: no operation here applies.
  assert.equal((await f.store.createProject({ actorMemberId: owner.member_id, projectId: 'project_apollo' })).ok, true);
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_apollo' })).ok, true);
  const dm = await f.send(alice, 'team.chat.dm_open', { member_ids: [bob.member_id] });
  await expect('project', [[owner, (s) => f.update(s, 'chan_project_apollo', { topic: 'x' }), FIXED],
    [owner, (s) => f.archive(s, 'chan_project_apollo'), FIXED], [owner, (s) => f.remove(s, 'chan_project_apollo'), FIXED]]);
  await expect('direct', [[alice, (s) => f.update(s, dm.channel_id, { topic: 'x' }), FIXED],
    [alice, (s) => f.archive(s, dm.channel_id), FIXED]]);
});

test('update: rename and topic records, a stale or archived update refused, the last 10 changes kept', async (t) => {
  const f = await channelsFixture(t);
  const { alice } = f.seats;
  const id = await f.create(alice, 'Design');
  await f.send(alice, 'team.chat.post', { channel_id: id, text: 'first' });
  const renamed = await f.update(alice, id, { name: 'Studio' });
  assert.deepEqual(Object.keys(renamed).sort(), ['ok', 'rev']);
  let changes = f.header(id).changes;
  const last = changes[changes.length - 1];
  assert.deepEqual([last.kind, last.by, last.seq_after, last.from, last.to], ['renamed', alice.member_id, 1, 'Design', 'Studio']);
  assert.equal((await f.update(alice, id, { topic: 'Colour' })).ok, true);
  changes = f.header(id).changes;
  assert.deepEqual(Object.keys(changes[changes.length - 1]).sort(), ['at', 'by', 'kind', 'seq_after']);
  assert.equal(changes[changes.length - 1].kind, 'topic');
  const event = f.channelEvents().at(-1);
  assert.deepEqual([event.payload.reason, event.payload.topic, event.payload.name], ['updated', 'Colour', 'Studio']);
  assert.deepEqual(Object.keys(event.payload).sort(), EVENT_KEYS);
  // A renamed channel's case-only rename is its own name, not a taken one.
  assert.equal((await f.update(alice, id, { name: 'studio' })).ok, true);
  const stale = await f.send(alice, 'team.chat.channel_update', { channel_id: id, topic: 'late', expected_rev: 1 });
  assert.equal(f.reasonOf(stale), 'team_chat_stale');
  assert.equal(stale.error.code, 'CMP-HOST-0004');
  // A message posted after the editor read the channel moves `rev` but is not a profile change: the save lands.
  const seen = f.header(id).rev;
  await f.send(f.seats.bob, 'team.chat.post', { channel_id: id, text: 'meanwhile' });
  assert.ok(f.header(id).rev > seen);
  assert.equal((await f.send(alice, 'team.chat.channel_update', { channel_id: id, topic: 'after a post', expected_rev: seen })).ok, true);
  // At least one of name and topic.
  assert.equal((await f.send(alice, 'team.chat.channel_update', { channel_id: id, expected_rev: 1 })).ok, false);
  for (let i = 0; i < 12; i += 1) assert.equal((await f.update(alice, id, { topic: `topic ${i}` })).ok, true);
  changes = f.header(id).changes;
  assert.equal(changes.length, LIMITS.CHANNEL_CHANGES_MAX);
  assert.deepEqual(changes.map((change) => change.kind), Array(10).fill('topic'));
  assert.equal((await f.archive(alice, id)).ok, true);
  assert.equal(f.reasonOf(await f.update(alice, id, { topic: 'while archived' })), 'team_chat_archived');
});

test('archive and unarchive: posts refused while archived, events carry the profile, a repeat answers ok silently', async (t) => {
  const f = await channelsFixture(t);
  const { owner, alice } = f.seats;
  const id = await f.create(alice, 'Design');
  const archived = await f.archive(alice, id);
  assert.deepEqual(Object.keys(archived).sort(), ['ok', 'rev']);
  assert.equal(f.reasonOf(await f.send(alice, 'team.chat.post', { channel_id: id, text: 'no' })), 'team_chat_archived');
  let event = f.channelEvents().at(-1);
  assert.deepEqual([event.payload.reason, event.payload.archived_by, event.payload.changes.at(-1).kind],
    ['archived', alice.member_id, 'archived']);
  assert.deepEqual(Object.keys(event.payload).sort(), EVENT_KEYS);
  const row = await f.overviewRow(owner, id);
  assert.deepEqual([row.archived, row.archived_by], [true, alice.member_id]);
  const count = f.channelEvents().length;
  assert.deepEqual(await f.archive(owner, id), { ok: true, rev: archived.rev });
  assert.equal(f.channelEvents().length, count, 'a repeat announces nothing');
  const unarchived = await f.archive(owner, id, false);
  assert.equal(unarchived.rev, archived.rev + 1);
  event = f.channelEvents().at(-1);
  assert.deepEqual([event.payload.reason, event.payload.archived_by, event.payload.changes.at(-1).kind,
    event.payload.changes.at(-1).by], ['unarchived', null, 'unarchived', owner.member_id]);
  assert.deepEqual(await f.archive(owner, id, false), { ok: true, rev: unarchived.rev });
  assert.equal(f.channelEvents().length, count + 1);
  assert.equal((await f.send(alice, 'team.chat.post', { channel_id: id, text: 'back' })).ok, true);
});

test('delete: refused while live; the owner deletes an archived channel, its files go, removed reaches the team, audited', async (t) => {
  const f = await channelsFixture(t);
  const { owner, alice } = f.seats;
  const id = await f.create(alice, 'Design');
  const staged = await f.chat.store.stageAttachment({ channelId: id, memberId: alice.member_id, name: 'a.txt',
    mime: 'text/plain', bytes: Buffer.from('attached words') });
  assert.equal(staged.ok, true);
  assert.equal((await f.send(alice, 'team.chat.post', { channel_id: id, text: 'with a file',
    attachment_ids: [staged.attachment.id] })).ok, true);
  const live = await f.remove(owner, id);
  assert.equal(f.reasonOf(live), 'team_chat_channel_live');
  assert.equal(live.error.code, 'CMP-HOST-0003');
  assert.equal((await f.archive(alice, id)).ok, true);
  assert.equal((await f.archive(owner, id, false)).ok, true);
  assert.equal((await f.archive(owner, id)).ok, true);
  const rev = f.header(id).rev;
  const chatDir = path.join(f.fx.dir, 'team-chat');
  assert.equal(fs.existsSync(path.join(chatDir, 'blobs', id)), true);
  assert.deepEqual(await f.remove(owner, id), { ok: true });
  assert.equal(fs.existsSync(path.join(chatDir, id)), false, 'the channel folder is gone');
  assert.equal(fs.existsSync(path.join(chatDir, 'blobs', id)), false, 'its attachments are gone');
  const index = JSON.parse(fs.readFileSync(path.join(chatDir, 'index.json'), 'utf8'));
  assert.deepEqual(index.channels.map((entry) => entry.channel_id), ['chan_team']);
  const event = f.channelEvents().at(-1);
  assert.deepEqual(event.payload, { channel_id: id, reason: 'removed', channel_rev: rev + 1 });
  assert.deepEqual([...event.options.audience].sort(), memberIds(f));
  assert.equal(f.reasonOf(await f.send(owner, 'team.chat.history', { channel_id: id, limit: 5 })), 'team_chat_not_found');
  assert.equal((await f.overviewRow(owner, id)), undefined);
  const audit = f.store.audit.read({ order: 'oldest' }).entries.filter((entry) => entry.kind.startsWith('chat_channel_'));
  assert.deepEqual(audit.map((entry) => [entry.kind, entry.actor_member_id, entry.name, entry.detail]), [
    ['chat_channel_archived', alice.member_id, 'Design', `channel_id=${id}`],
    ['chat_channel_unarchived', owner.member_id, 'Design', `channel_id=${id}`],
    ['chat_channel_archived', owner.member_id, 'Design', `channel_id=${id}`],
    ['chat_channel_deleted', owner.member_id, 'Design', `channel_id=${id}`],
  ]);
});

test('without the chat audit wired, a change that needs an entry is refused and changes nothing', async (t) => {
  const f = await channelsFixture(t, { audit: false });
  const id = await f.create(f.seats.alice, 'Design');
  const live = f.header(id);
  assert.equal(f.reasonOf(await f.archive(f.seats.alice, id)), 'team_unavailable');
  assert.deepEqual(f.header(id), live);
  // The host's own archive needs no entry; then unarchive and delete would, and a repeat archive would not.
  assert.equal((await f.chat.store.archiveChannel({ channelId: id })).ok, true);
  const archived = f.header(id);
  assert.equal(f.reasonOf(await f.archive(f.seats.owner, id, false)), 'team_unavailable');
  assert.equal(f.reasonOf(await f.remove(f.seats.owner, id)), 'team_unavailable');
  assert.deepEqual(await f.archive(f.seats.alice, id), { ok: true, rev: archived.rev });
  assert.deepEqual(f.header(id), archived);
  assert.equal(archived.archived_by, null);
});

test('replay: the same device and request id answers the first result for create, update and archive', async (t) => {
  const f = await channelsFixture(t);
  const { alice } = f.seats;
  const createCmd = command(alice.auth, 'team.chat.channel_create', { name: 'Design' });
  const made = await f.dispatch(alice, createCmd);
  assert.deepEqual(await f.dispatch(alice, createCmd), made);
  assert.equal(f.channelEvents().length, 1);
  assert.equal(f.chat.store.listChannels().channels.filter((info) => info.kind === 'channel').length, 1);
  assert.equal(f.reasonOf(await f.dispatch(alice, { ...createCmd, params: { name: 'Other' } })), 'request_payload_changed');
  const updateCmd = command(alice.auth, 'team.chat.channel_update', { channel_id: made.channel_id, topic: 'once',
    expected_rev: made.rev });
  const updated = await f.dispatch(alice, updateCmd);
  assert.equal(updated.ok, true);
  assert.deepEqual(await f.dispatch(alice, updateCmd), updated);
  const archiveCmd = command(alice.auth, 'team.chat.channel_archive', { channel_id: made.channel_id, on: true });
  const archived = await f.dispatch(alice, archiveCmd);
  assert.equal(archived.ok, true);
  assert.equal((await f.archive(f.seats.owner, made.channel_id, false)).ok, true);
  assert.deepEqual(await f.dispatch(alice, archiveCmd), archived, 'the retry answers its first result');
  assert.equal(f.header(made.channel_id).archived, false, 'and changes nothing');
  assert.equal(f.channelEvents().length, 4);
});

test('store: two concurrent creates of one name make one channel; the wire schemas bound every field', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  await fx.createChannel(store);
  const input = (requestId) => ({ actorId: ALICE, deviceId: ALICE_DEVICE, requestId, name: 'Design' });
  const [first, second] = await Promise.all([store.createCustomChannel(input('req_a')),
    store.createCustomChannel({ ...input('req_b'), actorId: BOB })]);
  assert.deepEqual([first.ok, second.ok], [true, false]);
  assert.equal(second.error.reason, 'team_chat_channel_name_taken');
  assert.equal(store.listChannels().channels.length, 2);
  // A custom channel never comes from the plain create.
  assert.equal((await store.createChannel({ channelId: 'chan_c_aaaaaaaaaaaaaaaa' })).ok, false);
  const valid = (operation, params) => validateCommand({ api_version: 1, operation, request_id: 'r1', client_id: 'c1',
    boot_epoch: BOOT, params }).ok;
  assert.equal(valid('team.chat.channel_create', { name: 'n', topic: 't'.repeat(1000) }), true);
  assert.equal(valid('team.chat.channel_create', { name: 'n', topic: 't'.repeat(1001) }), false);
  assert.equal(valid('team.chat.channel_create', { name: '' }), false);
  assert.equal(valid('team.chat.channel_update', { channel_id: 'chan_team', expected_rev: 0, topic: '' }), true);
  assert.equal(valid('team.chat.channel_update', { channel_id: 'chan_team', expected_rev: 0 }), false);
  assert.equal(valid('team.chat.channel_archive', { channel_id: 'chan_team', on: 'yes' }), false);
  assert.equal(valid('team.chat.channel_delete', { channel_id: 'chan_team', extra: 1 }), false);
});

test('store: a custom channel torn after its channel.json is a leftover the start pass removes; the created one loads again', async (t) => {
  const fx = createChatFixture(t);
  const store = fx.openStore();
  await fx.createChannel(store);
  const made = await store.createCustomChannel({ actorId: ALICE, deviceId: ALICE_DEVICE, requestId: 'req_made', name: 'Kept' });
  fx.control.crashAfter = 1; // channel.json lands, index.json does not
  assert.equal((await store.createCustomChannel({ actorId: ALICE, deviceId: ALICE_DEVICE, requestId: 'req_torn',
    name: 'Torn' })).ok, false);
  fx.control.crashAfter = null;
  const restarted = fx.openStore();
  const torn = fs.readdirSync(fx.chatDir).filter((name) => /^chan_c_/u.test(name) && name !== made.channel_id);
  assert.equal(torn.length, 1, 'the torn create left its folder');
  assert.deepEqual(await restarted.removeDeadProjectChannels({ isLive: () => true }), { ok: true, removed: 0, leftovers: 1 });
  assert.equal(fs.existsSync(path.join(fx.chatDir, torn[0])), false);
  const kept = restarted.channelHeader(made.channel_id);
  assert.deepEqual([kept.kind, kept.name, kept.created_by, kept.rev], ['channel', 'Kept', ALICE, 1]);
  // The torn name is free again.
  assert.equal((await restarted.createCustomChannel({ actorId: ALICE, deviceId: ALICE_DEVICE, requestId: 'req_again',
    name: 'Torn' })).ok, true);
});

test('migration: a schema 2 record loads as schema 3 with the team name and no profile; the next write stores schema 3', async (t) => {
  const fx = createChatFixture(t);
  const first = fx.openStore();
  await fx.createChannel(first);
  await fx.postOk(first);
  await fx.createChannel(first, 'chan_project_apollo');
  assert.equal((await first.archiveChannel({ channelId: 'chan_project_apollo' })).ok, true);
  const asSchema2 = (relative) => {
    const doc = fx.readDoc(relative);
    for (const key of ['name', 'topic', 'created_by', 'changes', 'profile_rev']) delete doc[key];
    if (doc.archived) doc.archived = { at: doc.archived.at };
    fx.writeDoc(relative, { ...doc, schema_version: 2 });
  };
  asSchema2('chan_team/channel.json');
  asSchema2('chan_project_apollo/channel.json');
  const store = fx.openStore();
  const team = store.channelHeader('chan_team');
  assert.deepEqual([team.name, team.topic, team.created_by, team.archived_by, team.changes], ['team', '', null, null, []]);
  const project = store.channelHeader('chan_project_apollo');
  assert.equal(project.archived, true);
  assert.equal(project.name, undefined, 'a project row carries no profile');
  assert.equal(fx.readDoc('chan_team/channel.json').schema_version, 2, 'reading writes nothing');
  await fx.postOk(store);
  const written = fx.readDoc('chan_team/channel.json');
  assert.equal(CHANNEL_SCHEMA_VERSION, 3);
  assert.deepEqual([written.schema_version, written.name, written.topic, written.created_by, written.changes],
    [3, 'team', '', null, []]);
  // A newer record is refused as a newer schema, never read as corrupt.
  const newer = fx.readDoc('chan_team/channel.json');
  fx.writeDoc('chan_team/channel.json', { ...newer, schema_version: 4 });
  assert.equal(fx.newStore().open().error.reason, 'team_chat_schema_unsupported');
});
