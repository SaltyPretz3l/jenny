'use strict';

// Slice 2a-3a: every team chat operation through the real router, the real
// authorizer and operation registry, the real team commands and a real chat
// store. One table drives the matrix, so an operation without a row fails.

const assert = require('node:assert/strict');
const test = require('node:test');

const { PARAM_SCHEMAS } = require('../../server/api-contract');
const { createAuthorizer } = require('../../server/team/authorize');
const { createTeamChatCommandsFixture } = require('./helpers/team-chat-commands-fixture');

const FORBIDDEN = 'CMP-HOST-0003';
const DM = `chan_dm_${'a'.repeat(64)}`;

// operation, who may (O owner, M member, R read-only), params(context, seat)
const MATRIX = [
  ['team.chat.overview', 'OMR', () => ({})],
  ['team.chat.history', 'OMR', () => ({ channel_id: 'chan_team', limit: 10 })],
  ['team.chat.sync', 'OMR', () => ({ channel_id: 'chan_team', after_rev: 0, limit: 10 })],
  ['team.chat.thread', 'OMR', (c) => ({ channel_id: 'chan_team', root_id: c.root.message_id, limit: 10 })],
  ['team.chat.post', 'OM', () => ({ channel_id: 'chan_team', text: 'hello' })],
  // Each seat edits and deletes its own message, so the author rule never decides a cell.
  ['team.chat.edit', 'OM', (c, seat) => ({ channel_id: 'chan_team', message_id: c.own[seat].message_id,
    text: 'edited', expected_rev: c.own[seat].rev })],
  ['team.chat.delete', 'OM', (c, seat) => ({ channel_id: 'chan_team', message_id: c.own[seat].message_id })],
  ['team.chat.mark_read', 'OMR', () => ({ channel_id: 'chan_team', seq: 1 })],
  ['team.chat.set_notify', 'OMR', () => ({ channel_id: 'chan_team', level: 'all' })],
  ['team.chat.follow', 'OMR', (c) => ({ channel_id: 'chan_team', root_id: c.root.message_id, on: true })],
  // Slice 2a-3b: read-only may search and report presence, not type.
  ['team.chat.search', 'OMR', () => ({ query: 'root', limit: 5 })],
  ['team.chat.typing', 'OM', () => ({ channel_id: 'chan_team' })],
  ['team.presence.set', 'OMR', () => ({ state: 'idle' })],
];

test('the matrix covers every team.chat operation and the presence report in the closed vocabulary', () => {
  const chatOperations = Object.keys(PARAM_SCHEMAS)
    .filter((operation) => operation.startsWith('team.chat.') || operation.startsWith('team.presence.'));
  assert.deepEqual(chatOperations.sort(), MATRIX.map(([operation]) => operation).sort());
  assert.equal(chatOperations.length, 13);
});

test('matrix: every chat operation by owner, member, read-only, pending, invite principal and revoked device', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const root = await f.post(f.seats.owner, 'root');
  const own = {};
  for (const seat of ['owner', 'alice']) own[seat] = await f.post(f.seats[seat], `mine ${seat}`);
  // Seats that may not post still need ids for their rows; the call is refused before the store.
  for (const seat of ['rae', 'pat', 'invite', 'revoked']) own[seat] = root;
  const context = { root, own };
  const letters = { owner: 'O', alice: 'M', rae: 'R', pat: 'P', invite: 'I', revoked: 'X' };
  const denied = { P: 'member_pending', X: 'member_revoked' };
  let allowed = 0;
  for (const [seat, letter] of Object.entries(letters)) {
    for (const [operation, who, params] of MATRIX) {
      const answer = await f.send(f.seats[seat], operation, params(context, seat));
      const expected = who.includes(letter) ? 'ok' : (denied[letter] || 'role_forbidden');
      assert.equal(f.reasonOf(answer), expected, `${seat} ${operation}`);
      if (expected === 'ok') { allowed += 1; continue; }
      assert.equal(answer.error.code, FORBIDDEN, `${seat} ${operation}`);
      assert.match(answer.error.request_id, /^request_\d+$/u, `${seat} ${operation}`);
    }
  }
  // Owner and member: all thirteen. Read-only: the four reads, the three read-state
  // writes, search and the presence report.
  assert.equal(allowed, 13 + 13 + 9);
});

test('a refused command reaches no store: a read-only post leaves the channel unchanged', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const before = f.chat.store.channelInfo('chan_team');
  const answer = await f.send(f.seats.rae, 'team.chat.post', { channel_id: 'chan_team', text: 'nope' });
  assert.equal(answer.error.reason, 'role_forbidden', 'the spec reason team_chat_read_only is not used');
  assert.deepEqual(f.chat.store.channelInfo('chan_team'), before);
  assert.deepEqual(f.chatEvents(), []);
});

test('a direct, an unknown and a not-yet-created project channel answer exactly alike for owner and member', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const strip = (answer) => {
    assert.equal(answer.ok, false);
    const { request_id: requestId, ...rest } = answer.error;
    assert.match(requestId, /^request_\d+$/u);
    return rest;
  };
  const expected = { code: FORBIDDEN, reason: 'team_chat_not_found', retryable: false };
  for (const seat of ['owner', 'alice']) {
    for (const channelId of [DM, 'chan_bogus', 'chan_project_not_yet']) {
      for (const [operation, params] of [
        ['team.chat.history', { channel_id: channelId, limit: 5 }],
        ['team.chat.post', { channel_id: channelId, text: 'hi' }],
        ['team.chat.mark_read', { channel_id: channelId, seq: 1 }],
        ['team.chat.typing', { channel_id: channelId }],
        ['team.chat.search', { query: 'x', channel_id: channelId, limit: 5 }],
      ]) {
        assert.deepEqual(strip(await f.send(f.seats[seat], operation, params)), expected,
          `${seat} ${operation} ${channelId}`);
      }
    }
  }
  // The project channel passes the authorizer and gets the store's answer; the
  // direct and unknown ids are refused by the authorizer. Both read the same.
  assert.equal(f.chat.store.listChannels().channels.length, 1);
  const { authorize } = createAuthorizer({ directory: f.store.directory });
  const owner = { device_id: f.seats.owner.device_id };
  assert.deepEqual(authorize(owner, 'chat.read', { kind: 'channel', id: 'chan_project_not_yet' }), { ok: true });
  assert.equal(authorize(owner, 'chat.read', { kind: 'channel', id: DM }, 'r').error.reason, 'team_chat_not_found');
  assert.equal(authorize(owner, 'chat.read', { kind: 'session', id: 'chan_team' }, 'r').error.reason,
    'team_chat_not_found', 'the wrong kind for a channel action');
  assert.equal(authorize(owner, 'team.members.list', { kind: 'channel', id: 'chan_team' }, 'r').error.reason,
    'team_not_found');
});

test('a direct channel that exists in the store is still refused, the owner included', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  assert.equal((await f.chat.store.createChannel({ channelId: DM })).ok, true);
  for (const seat of ['owner', 'alice']) {
    for (const [operation, params] of [
      ['team.chat.history', { channel_id: DM, limit: 5 }],
      ['team.chat.post', { channel_id: DM, text: 'hi' }],
    ]) {
      assert.equal(f.reasonOf(await f.send(f.seats[seat], operation, params)), 'team_chat_not_found', `${seat} ${operation}`);
    }
    const overview = await f.send(f.seats[seat], 'team.chat.overview');
    assert.deepEqual(overview.channels.map((channel) => channel.channel_id), ['chan_team'], seat);
  }
  assert.equal(f.chat.store.channelInfo(DM).last_seq, 0);
  assert.equal(f.chat.channelAudience(DM).size, 0);
  assert.equal(f.chat.channelAudience('chan_team').has(f.seats.pat.member_id), false, 'a pending member is outside');
  assert.equal(f.chat.channelAudience('chan_team').has(f.seats.rae.member_id), true);
});

test('a forged message or thread root id answers team_chat_not_found and changes nothing', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const forged = 'msg_00000000000000000000000000';
  const before = f.chat.store.channelInfo('chan_team');
  for (const [operation, params] of [
    ['team.chat.edit', { channel_id: 'chan_team', message_id: forged, text: 'x', expected_rev: 1 }],
    ['team.chat.delete', { channel_id: 'chan_team', message_id: forged }],
    ['team.chat.post', { channel_id: 'chan_team', text: 'x', thread_root_id: forged }],
    ['team.chat.thread', { channel_id: 'chan_team', root_id: forged, limit: 5 }],
    ['team.chat.follow', { channel_id: 'chan_team', root_id: forged, on: true }],
    ['team.chat.typing', { channel_id: 'chan_team', thread_root_id: forged }],
  ]) {
    const answer = await f.send(f.seats.alice, operation, params);
    assert.equal(f.reasonOf(answer), 'team_chat_not_found', operation);
  }
  assert.deepEqual(f.chat.store.channelInfo('chan_team'), before);
  assert.deepEqual(f.chatEvents(), []);
  // A thread root from another channel is not a root here (slice 2a-3b typing).
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_alpha' })).ok, true);
  const elsewhere = await f.send(f.seats.alice, 'team.chat.post', { channel_id: 'chan_project_alpha', text: 'root' });
  const typing = await f.send(f.seats.bob, 'team.chat.typing', { channel_id: 'chan_team',
    thread_root_id: elsewhere.message_id });
  assert.equal(f.reasonOf(typing), 'team_chat_not_found');
  assert.equal(f.published.filter((entry) => entry.type === 'team_chat_typing').length, 0);
});

test('a command whose device has no live actor is refused, never served as the owner', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  // The router hands the chat dispatcher a device the directory does not know.
  const answer = await f.chat.commands.dispatch(
    f.command(f.seats.owner.auth, 'team.chat.post', { channel_id: 'chan_team', text: 'ghost' }),
    { deviceId: 'device_nobody' }, { canAdmit: () => true, publish: () => {} });
  assert.equal(answer.error.reason, 'role_forbidden');
  for (const context of [undefined, {}, { deviceId: '' }, { deviceId: f.seats.pat.device_id },
    { deviceId: f.seats.invite.device_id }, { deviceId: f.seats.revoked.device_id }]) {
    const refused = await f.chat.commands.dispatch(
      f.command(f.seats.owner.auth, 'team.chat.overview', {}), context, { canAdmit: () => true, publish: () => {} });
    assert.equal(refused.error.reason, 'role_forbidden', JSON.stringify(context));
  }
  assert.equal(f.chat.store.channelInfo('chan_team').last_seq, 0);
  assert.deepEqual(f.chatEvents(), []);
});

test('a missing guard fails closed: no canAdmit refuses a post, no publish refuses a mutation', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const cmd = () => f.command(f.seats.owner.auth, 'team.chat.post', { channel_id: 'chan_team', text: 'x' });
  const context = { deviceId: f.seats.owner.device_id };
  const noAdmit = await f.chat.commands.dispatch(cmd(), context, { publish: () => {} });
  assert.equal(noAdmit.error.reason, 'disk_pressure');
  const noPublish = await f.chat.commands.dispatch(cmd(), context, { canAdmit: () => true });
  assert.equal(noPublish.ok, false);
  assert.equal(f.chat.store.channelInfo('chan_team').last_seq, 0);
});
