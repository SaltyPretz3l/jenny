'use strict';

// new-test-file: the channel-management client surface (row 173): custom channel rows in the chat cache and the four
// online-only channel operations, which no existing client test file covers.
//
// The cache is exercised directly (rows and events); the four IPC methods run through the real chat client behind
// the fake manager of tests/helpers/team-chat-fake-host.js with scripted host answers, because the host's operations
// are a separate slice.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createChatCache } = require('../services/team/chat-cache');
const { validatePayload } = require('../services/team/ipc-methods');
const { ME, setupChatClient, settleChats } = require('./helpers/team-chat-fake-host');

const CHAN = 'chan_c_abcdefghijklmnop';
const OTHER_CHAN = 'chan_c_qrstuvwxyz234567';
const OWNER = 'member_ownerCCC333';
const AT = '2026-11-16T10:00:00.000Z';

const baseRow = (channelId, kind, extra = {}) => ({ channel_id: channelId, kind, archived: false, rev: 4, last_seq: 2, floor_seq: 1,
  last_read_seq: 2, notify: 'mentions', unread: 0, unread_capped: false, mention: false, threads: [], reads: [], pin_count: 0, ...extra });
const FIELDS = () => ({ name: 'ideas', topic: 'Half-baked things', created_by: OWNER, archived_by: null,
  changes: [{ kind: 'created', by: OWNER, at: AT, seq_after: 0 },
    { kind: 'renamed', by: OWNER, at: AT, seq_after: 1, from: 'idea', to: 'ideas' },
    { kind: 'topic', by: OWNER, at: AT, seq_after: 2 }] });
const channelRow = (extra = {}) => baseRow(CHAN, 'channel', { ...FIELDS(), ...extra });
const teamRow = (extra = {}) => baseRow('chan_team', 'team', extra);

const loaded = (rows) => {
  const cache = createChatCache({ memberId: ME.member_id });
  assert.equal(cache.setOverview(rows), true);
  return cache;
};
const listed = (cache, channelId) => cache.channelList().find((row) => row.channel_id === channelId);

test('a channel row keeps name, topic, creator, archiver and changes, and hands the renderer its own copy', () => {
  const cache = loaded([teamRow(), channelRow()]);
  const row = cache.channel(CHAN);
  assert.deepEqual([row.kind, row.name, row.topic, row.created_by, row.archived_by], ['channel', 'ideas', 'Half-baked things', OWNER, null]);
  assert.deepEqual(row.changes, FIELDS().changes);
  const copy = listed(cache, CHAN);
  assert.deepEqual(copy.changes, FIELDS().changes);
  copy.changes[0].kind = 'archived';
  copy.changes.push({});
  assert.deepEqual(cache.channel(CHAN).changes, FIELDS().changes, 'a pushed row shares nothing with the cache');
});

test('a team row from an older host gets the defaults; a project row keeps no channel fields', () => {
  const cache = loaded([teamRow(), baseRow('chan_project_p1', 'project', { name: 'ignored', topic: 'ignored', changes: 'ignored' })]);
  const team = listed(cache, 'chan_team');
  assert.deepEqual([team.name, team.topic, team.created_by, team.archived_by, team.changes], [null, '', null, null, []]);
  const project = listed(cache, 'chan_project_p1');
  for (const key of ['name', 'topic', 'created_by', 'archived_by', 'changes']) assert.equal(Object.hasOwn(project, key), false, key);
  const full = loaded([teamRow({ name: 'team', topic: 'Everyone', created_by: null, archived_by: null, changes: [] })]);
  assert.deepEqual([listed(full, 'chan_team').name, listed(full, 'chan_team').topic], ['team', 'Everyone']);
});

test('a present channel field of the wrong shape makes the row invalid, as any wrong field does', () => {
  const change = { kind: 'created', by: OWNER, at: AT, seq_after: 0 };
  const renamed = { kind: 'renamed', by: OWNER, at: AT, seq_after: 1, from: 'a', to: 'b' };
  const bad = [
    { name: '' }, { name: 'x'.repeat(41) }, { name: 7 }, { name: undefined }, { topic: 'x'.repeat(251) }, { topic: null },
    { created_by: 'someone' }, { created_by: undefined }, { archived_by: 3 }, { archived_by: 'not a member' },
    { changes: 'none' }, { changes: Array.from({ length: 11 }, () => change) }, { changes: [null] },
    { changes: [{ ...change, kind: 'deleted' }] }, { changes: [{ ...change, by: 'x' }] }, { changes: [{ ...change, at: 'yesterday' }] },
    { changes: [{ ...change, seq_after: -1 }] }, { changes: [{ ...change, extra: 1 }] }, { changes: [{ ...change, from: 'a', to: 'b' }] },
    { changes: [{ kind: 'renamed', by: OWNER, at: AT, seq_after: 1 }] }, { changes: [{ ...renamed, to: '' }] },
    { changes: [{ ...renamed, from: 'x'.repeat(41) }] }, { changes: [{ kind: 'topic', by: OWNER, at: AT }] },
  ];
  for (const [index, change_] of bad.entries()) {
    const row = channelRow(); // an undefined value is a present key with the wrong shape
    Object.assign(row, change_);
    const cache = loaded([teamRow(), row]);
    assert.equal(cache.channel(CHAN), null, `case ${index}: ${JSON.stringify(change_).slice(0, 60)}`);
    assert.ok(cache.channel('chan_team'), 'the other rows are kept');
  }
  const ten = Array.from({ length: 10 }, () => change);
  assert.ok(loaded([channelRow({ changes: ten, name: 'x'.repeat(40), topic: 'y'.repeat(250) })]).channel(CHAN), 'the bounds themselves pass');
  assert.ok(loaded([channelRow({ name: '\u{1F600}'.repeat(40) })]).channel(CHAN), 'a name counts code points, not UTF-16 units');
  assert.equal(loaded([channelRow({ name: '\u{1F600}'.repeat(41) })]).channel(CHAN), null);
});

const event = (reason, rev, extra = {}) => ({ event_type: 'team_chat_channel', channel_id: CHAN, reason, channel_rev: rev, ...extra });
const eventFields = (extra = {}) => ({ ...FIELDS(), ...extra });

test('applyChannel: updated replaces the fields at the next revision and leaves archived alone', () => {
  const cache = loaded([channelRow()]);
  const next = { name: 'ideas2', topic: '', created_by: OWNER, archived_by: null,
    changes: [...FIELDS().changes, { kind: 'renamed', by: OWNER, at: AT, seq_after: 2, from: 'ideas', to: 'ideas2' }] };
  assert.deepEqual(cache.applyChannel(event('updated', 5, next)), { status: 'applied', reload: false });
  const row = cache.channel(CHAN);
  assert.deepEqual([row.rev, row.name, row.topic, row.archived], [5, 'ideas2', '', false]);
  assert.equal(row.changes.length, 4);
});

test('applyChannel: archived and unarchived flip the flag, replace the fields and move the revision', () => {
  const cache = loaded([channelRow()]);
  const archived = eventFields({ archived_by: OWNER, changes: [...FIELDS().changes, { kind: 'archived', by: OWNER, at: AT, seq_after: 2 }] });
  assert.equal(cache.applyChannel(event('archived', 5, archived)).status, 'applied');
  assert.deepEqual([cache.channel(CHAN).archived, cache.channel(CHAN).archived_by, cache.channel(CHAN).rev], [true, OWNER, 5]);
  assert.equal(cache.applyChannel(event('unarchived', 6, eventFields({ changes: [] }))).status, 'applied');
  assert.deepEqual([cache.channel(CHAN).archived, cache.channel(CHAN).archived_by, cache.channel(CHAN).changes, cache.channel(CHAN).rev], [false, null, [], 6]);
  const team = loaded([teamRow({ name: 'team' })]);
  assert.equal(team.applyChannel({ event_type: 'team_chat_channel', channel_id: 'chan_team', reason: 'updated', channel_rev: 5,
    ...eventFields({ name: 'team', topic: 'Hello', created_by: null }) }).status, 'applied');
  assert.equal(team.channel('chan_team').topic, 'Hello');
  // An event older than the held revision never replaces what a later one set.
  assert.equal(team.applyChannel({ event_type: 'team_chat_channel', channel_id: 'chan_team', reason: 'updated', channel_rev: 3,
    ...eventFields({ name: 'team', topic: 'Stale', created_by: null }) }).status, 'applied');
  assert.equal(team.channel('chan_team').topic, 'Hello');
});

test('applyChannel: a skipped revision, a wrong shape or an unknown row is a gap and changes nothing', () => {
  const cache = loaded([channelRow()]);
  const before = JSON.stringify(cache.channel(CHAN));
  assert.equal(cache.applyChannel(event('updated', 6, eventFields({ name: 'later' }))).status, 'gap', 'rev skips one');
  assert.equal(cache.applyChannel(event('archived', 5, eventFields({ changes: [{ kind: 'nope' }] }))).status, 'gap', 'bad changes');
  assert.equal(cache.applyChannel(event('unarchived', 5, eventFields({ name: '' }))).status, 'gap', 'bad name');
  assert.equal(cache.applyChannel({ ...event('updated', 5, eventFields()), channel_id: OTHER_CHAN }).status, 'gap', 'not cached');
  assert.equal(cache.applyChannel({ ...event('created', 1, eventFields()), channel_id: OTHER_CHAN }).status, 'gap', 'created for an uncached row');
  assert.equal(JSON.stringify(cache.channel(CHAN)), before);
  const project = loaded([baseRow('chan_project_p1', 'project')]);
  assert.equal(project.applyChannel({ event_type: 'team_chat_channel', channel_id: 'chan_project_p1', reason: 'updated', channel_rev: 5,
    ...eventFields() }).status, 'gap', 'a project row has no channel fields to update');
});

test('applyChannel: an event that names only some fields replaces those and keeps the rest', () => {
  const cache = loaded([channelRow()]);
  assert.equal(cache.applyChannel(event('archived', 5, { archived_by: OWNER })).status, 'applied');
  const row = cache.channel(CHAN);
  assert.deepEqual([row.archived, row.archived_by, row.name, row.topic, row.changes], [true, OWNER, 'ideas', 'Half-baked things', FIELDS().changes]);
  assert.equal(cache.applyChannel(event('updated', 6, { topic: 7 })).status, 'gap', 'a present field must still be well shaped');
});

test('applyChannel: removed drops the row and its open entry', () => {
  const cache = loaded([teamRow(), channelRow()]);
  assert.equal(cache.openChannel(CHAN, { messages: [], channel_rev: 4, has_more: false }), true);
  assert.equal(cache.isOpen(CHAN), true);
  const result = cache.applyChannel(event('removed', 5));
  assert.equal(result.status, 'applied');
  assert.equal(result.removed, true);
  assert.equal(cache.channel(CHAN), null);
  assert.equal(cache.isOpen(CHAN), false);
  assert.deepEqual(cache.channelList().map((row) => row.channel_id), ['chan_team']);
  assert.equal(cache.applyChannel(event('removed', 6)).status, 'gap', 'a second removal names an uncached row');
});

// ----------------------------------------------------------------------------- the client

const overviewWith = (rows) => async ({ operation, dispatch }) => {
  if (operation !== 'team.chat.overview') return null;
  const answer = await dispatch();
  return { ...answer, channels: [...answer.channels, ...rows] };
};

test('a channel row from the overview reaches the renderer push with its fields; events then move it', async (t) => {
  const s = await setupChatClient(t);
  s.manager.hook = overviewWith([channelRow()]);
  const answer = await s.call('chatOverview');
  assert.equal(answer.ok, true);
  const row = answer.channels.find((entry) => entry.channel_id === CHAN);
  assert.deepEqual([row.name, row.topic, row.created_by, row.archived_by], ['ideas', 'Half-baked things', OWNER, null]);
  await settleChats(s.chats, s.teamId, s.timers);
  const pushed = s.ofType('channels').at(-1).channels.find((entry) => entry.channel_id === CHAN);
  assert.deepEqual(pushed.changes, FIELDS().changes);

  s.pushes.length = 0;
  s.event('team_chat_channel', { channel_id: CHAN, reason: 'updated', channel_rev: 5, ...eventFields({ topic: 'New topic' }) });
  await s.chats.idle(s.teamId);
  const touched = s.ofType('channels').at(-1);
  assert.equal(touched.partial, true);
  assert.equal(touched.channels.find((entry) => entry.channel_id === CHAN).topic, 'New topic');
});

test('a removed event drops the row and pushes the full channel list', async (t) => {
  const s = await setupChatClient(t);
  s.manager.hook = overviewWith([channelRow()]);
  await s.call('chatOverview');
  await s.call('chatHistory', { channel_id: 'chan_team' });
  await settleChats(s.chats, s.teamId, s.timers);
  s.pushes.length = 0;
  s.event('team_chat_channel', { channel_id: CHAN, reason: 'removed', channel_rev: 5 });
  await s.chats.idle(s.teamId);
  const pushes = s.ofType('channels');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].partial, undefined, 'the whole list, not a partial');
  assert.deepEqual(pushes[0].channels.map((entry) => entry.channel_id), ['chan_team']);
  assert.equal(s.chats.cacheOf(s.teamId).channels.some((entry) => entry.channel_id === CHAN), false);
});

const METHODS = [
  ['chatChannelCreate', 'team.chat.channel_create', { name: 'ideas', topic: 'Half-baked things' }, { ok: true, channel_id: CHAN, rev: 1 }],
  ['chatChannelCreate', 'team.chat.channel_create', { name: 'ideas' }, { ok: true, channel_id: CHAN, rev: 0 }],
  ['chatChannelUpdate', 'team.chat.channel_update', { channel_id: CHAN, name: 'ideas2', expected_rev: 4 }, { ok: true, rev: 5 }],
  ['chatChannelUpdate', 'team.chat.channel_update', { channel_id: 'chan_team', topic: '', expected_rev: 0 }, { ok: true, rev: 1 }],
  ['chatChannelArchive', 'team.chat.channel_archive', { channel_id: CHAN, on: true }, { ok: true, rev: 5 }],
  ['chatChannelArchive', 'team.chat.channel_archive', { channel_id: CHAN, on: false }, { ok: true, rev: 6 }],
  ['chatChannelDelete', 'team.chat.channel_delete', { channel_id: CHAN }, { ok: true }],
];

async function ready(t) {
  const s = await setupChatClient(t);
  assert.equal((await s.call('chatOverview')).ok, true);
  await settleChats(s.chats, s.teamId, s.timers);
  return s;
}
const overviewCalls = (s) => s.sent('team.chat.overview').length;
// A create waits for its row through the client's paced resync: the call runs while the manual timers fire.
async function settledCall(s, method, payload) {
  const pending = s.call(method, payload);
  await settleChats(s.chats, s.teamId, s.timers);
  return pending;
}

test('each channel method sends its host operation with the payload unchanged and answers the host result', async (t) => {
  for (const [method, operation, payload, answer] of METHODS) {
    const s = await ready(t);
    s.manager.hook = async ({ operation: sent }) => (sent === operation ? answer : null);
    const result = await settledCall(s, method, payload);
    assert.deepEqual(result, answer, `${method} ${JSON.stringify(payload)}`);
    assert.deepEqual(s.sent(operation).map((call) => call.params), [payload]);
  }
});

test('a success asks one overview resync; a refusal passes through unchanged and asks none', async (t) => {
  for (const [method, operation, payload, answer] of METHODS) {
    const s = await ready(t);
    s.manager.hook = async ({ operation: sent }) => (sent === operation ? answer : null);
    const before = overviewCalls(s);
    assert.equal((await settledCall(s, method, payload)).ok, true);
    await settleChats(s.chats, s.teamId, s.timers);
    assert.equal(overviewCalls(s) - before, 1, `${method} resynced once`);
  }
  const refusal = { ok: false, error: { code: 'CMP-HOST-0001', reason: 'team_chat_channel_name_taken' } };
  const s = await ready(t);
  s.manager.hook = async ({ operation }) => (operation.startsWith('team.chat.channel_') ? refusal : null);
  const before = overviewCalls(s);
  for (const [method, , payload] of METHODS) assert.deepEqual(await settledCall(s, method, payload), refusal, method);
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(overviewCalls(s), before, 'a refusal asks no resync');
});

test('a hostile success answer is refused and a host failure carries only its code and reason', async (t) => {
  const s = await ready(t);
  const answers = {
    'team.chat.channel_create': { ok: true, channel_id: '../etc', rev: 1 },
    'team.chat.channel_update': { ok: true, rev: 'x' },
    'team.chat.channel_archive': { ok: true },
  };
  s.manager.hook = async ({ operation }) => answers[operation] || null;
  for (const [method, , payload] of METHODS.filter(([, operation]) => answers[operation])) {
    const answer = await settledCall(s, method, payload);
    assert.equal(answer.ok, false, method);
    assert.equal(answer.error.reason, 'team_chat_answer_invalid', method);
  }
  s.manager.hook = async () => ({ ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_chat_channel_fixed', secret: 'leak', retryable: false } });
  const failed = await s.call('chatChannelDelete', { channel_id: 'chan_team' });
  assert.deepEqual(failed, { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_chat_channel_fixed' } });
});

test('a payload of the wrong shape is refused before anything is sent', async (t) => {
  const s = await ready(t);
  const before = s.manager.calls.length;
  const bad = [
    ['chatChannelCreate', {}], ['chatChannelCreate', { name: '' }], ['chatChannelCreate', { name: 'x'.repeat(161) }], ['chatChannelCreate', { name: 5 }],
    ['chatChannelCreate', { name: 'a', topic: 'x'.repeat(1001) }], ['chatChannelCreate', { name: 'a', topic: 3 }],
    ['chatChannelCreate', { name: 'a', extra: 1 }], ['chatChannelCreate', { name: 'a', channel_id: CHAN }],
    ['chatChannelUpdate', { channel_id: CHAN, name: 'a' }], ['chatChannelUpdate', { channel_id: CHAN, name: 'a', expected_rev: -1 }],
    ['chatChannelUpdate', { channel_id: CHAN, name: 'a', expected_rev: 1.5 }], ['chatChannelUpdate', { channel_id: 'general', name: 'a', expected_rev: 1 }],
    ['chatChannelUpdate', { channel_id: CHAN, expected_rev: 1 }], ['chatChannelUpdate', { channel_id: CHAN, name: '', expected_rev: 1 }],
    ['chatChannelUpdate', { channel_id: CHAN, topic: 'x'.repeat(1001), expected_rev: 1 }],
    ['chatChannelArchive', { channel_id: CHAN }], ['chatChannelArchive', { channel_id: CHAN, on: 'yes' }],
    ['chatChannelArchive', { channel_id: 'chan_c_SHORT', on: true }], ['chatChannelArchive', { channel_id: CHAN, on: true, extra: 1 }],
    ['chatChannelDelete', {}], ['chatChannelDelete', { channel_id: 'general' }], ['chatChannelDelete', { channel_id: CHAN, on: true }],
  ];
  for (const [method, payload] of bad) {
    const answer = await settledCall(s, method, payload);
    assert.equal(answer.ok, false, `${method} ${JSON.stringify(payload)}`);
    assert.equal(answer.error.code, 'invalid_request', method);
    assert.equal(validatePayload(method, { team_id: s.teamId, ...payload }).ok, false, `validatePayload ${method}`);
  }
  assert.equal(s.manager.calls.length, before, 'nothing reached the host');
});

test('offline the four methods are refused as not connected and send nothing', async (t) => {
  for (const state of ['pending', 'reconnecting']) {
    const s = await ready(t);
    s.manager.state = state;
    const before = s.manager.calls.length;
    for (const [method, , payload] of METHODS) {
      const answer = await settledCall(s, method, payload);
      assert.equal(answer.ok, false, `${state} ${method}`);
      assert.equal(answer.error.reason, 'team_not_connected', `${state} ${method}`);
    }
    assert.equal(s.manager.calls.length, before, `${state}: no command reached the manager`);
  }
});

test('the four methods never enter the outbox and are never retried', async (t) => {
  const s = await ready(t);
  let attempts = 0;
  s.manager.hook = async ({ operation }) => {
    if (!operation.startsWith('team.chat.channel_')) return null;
    attempts += 1;
    return { ok: false, error: { code: 'CMP-HOST-0005', reason: 'team_chat_rate_limit', retryable: true } };
  };
  for (const [method, , payload] of METHODS) {
    const answer = await settledCall(s, method, payload);
    assert.equal(answer.ok, false, method);
  }
  await settleChats(s.chats, s.teamId, s.timers);
  assert.equal(attempts, METHODS.length, 'one send per call, no retry');
  assert.equal(s.ofType('outbox').filter((push) => push.outbox.length > 0).length, 0, 'the outbox never held an entry');
  assert.deepEqual((await s.call('chatOverview')).outbox, []);
});
