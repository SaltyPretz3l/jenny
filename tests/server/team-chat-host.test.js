'use strict';

// Slice 2a-3a review: the chat host's lifecycle on a real chat store. Shutdown
// drains the store's write chain and refuses later commands; retention runs
// publish their prune reports with an audience.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTeamChatCommandsFixture } = require('./helpers/team-chat-commands-fixture');
const { fakeTimers, turn } = require('./helpers/team-chat-timers');

test('dispose waits for a post already queued and then refuses every chat command', async (t) => {
  const f = await createTeamChatCommandsFixture(t);
  const { alice } = f.seats;
  // Ten posts queue on the store's write chain before dispose; it outlasts a few ticks.
  const pending = Array.from({ length: 10 }, (_, i) => f.send(alice, 'team.chat.post',
    { channel_id: 'chan_team', text: `in flight ${i}` }));
  await f.chat.dispose();
  assert.equal(f.chat.store.channelInfo('chan_team').last_seq, 10, 'every queued post landed before dispose resolved');
  for (const answer of await Promise.all(pending)) assert.equal(answer.ok, true);

  const before = f.chat.store.channelInfo('chan_team');
  const published = f.published.length;
  for (const [operation, params] of [
    ['team.chat.post', { channel_id: 'chan_team', text: 'too late' }],
    ['team.chat.mark_read', { channel_id: 'chan_team', seq: 1 }],
    ['team.chat.history', { channel_id: 'chan_team', limit: 5 }],
    ['team.chat.overview', {}],
  ]) {
    const answer = await f.send(alice, operation, params);
    assert.equal(answer.ok, false, operation);
    assert.equal(answer.error.reason, 'team_unavailable', operation);
    assert.match(answer.error.request_id, /^request_\d+$/u, operation);
  }
  assert.deepEqual(f.chat.store.channelInfo('chan_team'), before);
  assert.equal(f.chat.store.readState('chan_team', alice.member_id).last_read_seq, 0, 'read state untouched');
  assert.equal(f.published.length, published);
});

test('dispose during a retention run waits for the run, its events included', async (t) => {
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 1, maxAgeMs: 60_000 } });
  for (let i = 0; i < 3; i += 1) await f.post(f.seats.alice, `old ${i}`);
  f.fx.advance(120_000);
  const before = f.chatEvents().length;
  const run = f.chat.runRetention();
  let finished = false;
  run.then(() => { finished = true; });
  await f.chat.dispose();
  assert.equal(finished, true, 'dispose resolved after the retention run');
  assert.ok(f.chatEvents().length > before, 'the run published before dispose resolved');
});

test('a retention run publishes team_chat_channel with the channel audience and bucket', async (t) => {
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 1, maxAgeMs: 60_000 } });
  for (let i = 0; i < 3; i += 1) await f.post(f.seats.alice, `old ${i}`);
  const floor = f.chat.store.channelInfo('chan_team').floor_seq;
  f.fx.advance(120_000);
  const before = f.chatEvents().length;
  await f.chat.runRetention();
  const events = f.chatEvents().slice(before);
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.type, 'team_chat_channel');
    assert.deepEqual(Object.keys(event.payload).sort(), ['channel_id', 'channel_rev', 'floor_seq', 'reason']);
    assert.equal(event.payload.reason, 'pruned');
    assert.ok(event.payload.floor_seq > floor);
    assert.equal(event.options.bucket, 'teamchat:chan_team');
    assert.ok(event.options.audience instanceof Set);
    assert.equal(event.options.audience.has(f.seats.alice.member_id), true);
    assert.equal(event.options.audience.has(f.seats.pat.member_id), false);
  }
});

// ------------------------------------------------------------ slice 2a-3b

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hostFailure } = require('../../server/api-contract');
const { createTeamChatHost } = require('../../services/host/team-chat-host');

function bareHost(t, options = {}) {
  const profileDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-chat-host-')));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const directory = { liveActor: () => ({ member_id: 'member_a', device_id: 'device_a', role: 'owner', state: 'active' }),
    activeMemberIds: () => ['member_a'], isDegraded: () => false };
  const logs = [];
  const timers = fakeTimers();
  const chat = createTeamChatHost({ profileDir, directory, timers, retentionIntervalMs: 0,
    logger: (level, event, fields) => logs.push({ level, event, fields }), ...options });
  t.after(() => chat.dispose());
  const overview = () => chat.commands.dispatch({ operation: 'team.chat.overview', params: {}, request_id: 'req_1' },
    { deviceId: 'device_a' }, {});
  return { chat, timers, logs, overview };
}

test('a transient failure creating chan_team at start is retried with backoff until it succeeds', async (t) => {
  const { chat, timers, overview } = bareHost(t);
  const create = chat.store.createChannel.bind(chat.store);
  let calls = 0;
  chat.store.createChannel = (input) => {
    calls += 1;
    return calls <= 2 ? Promise.resolve(hostFailure('persistence', 'team_chat_store_failed')) : create(input);
  };
  assert.deepEqual(await chat.start(), { ok: false });
  assert.equal((await overview()).error.reason, 'team_chat_store_failed', 'chat answers the failure meanwhile');
  assert.equal(await timers.fire(), 1_000);
  assert.equal(chat.failure().error.reason, 'team_chat_store_failed');
  assert.equal(await timers.fire(), 2_000, 'the delay doubles');
  assert.equal(calls, 3);
  assert.equal(chat.failure(), null);
  const answer = await overview();
  assert.deepEqual(answer.channels.map((channel) => channel.channel_id), ['chan_team']);
  assert.equal(timers.pending.size, 0, 'no retry left behind');
});

test('the start retry is bounded, skips a latched store, and dispose clears it', async (t) => {
  const bounded = bareHost(t);
  bounded.chat.store.createChannel = () => Promise.resolve(hostFailure('persistence', 'team_chat_store_failed'));
  await bounded.chat.start();
  const delays = [];
  while (bounded.timers.pending.size > 0) delays.push(await bounded.timers.fire());
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000]);

  const latched = bareHost(t);
  latched.chat.store.brokenReason = () => 'team_chat_store_failed';
  latched.chat.store.createChannel = () => Promise.resolve(hostFailure('persistence', 'team_chat_store_failed'));
  await latched.chat.start();
  assert.equal(latched.timers.pending.size, 0, 'a latched store is not retried');

  const schema = bareHost(t);
  schema.chat.store.createChannel = () => Promise.resolve(hostFailure('persistence', 'team_chat_schema_unsupported'));
  await schema.chat.start();
  assert.equal(schema.timers.pending.size, 0, 'a schema refusal is not retried');

  const disposed = bareHost(t);
  disposed.chat.store.createChannel = () => Promise.resolve(hostFailure('persistence', 'team_chat_store_failed'));
  await disposed.chat.start();
  assert.equal(disposed.timers.pending.size, 1);
  await disposed.chat.dispose();
  assert.equal(disposed.timers.pending.size, 0);
});

test('through the dispatcher: another channel answers while a large channel loads; dispose waits for it', async (t) => {
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 2 } });
  const { alice } = f.seats;
  assert.equal((await f.chat.store.createChannel({ channelId: 'chan_project_other' })).ok, true);
  for (let i = 0; i < 10; i += 1) await f.post(alice, `m${i}`);
  assert.equal((await f.send(alice, 'team.chat.post', { channel_id: 'chan_project_other', text: 'other' })).ok, true);
  await f.chat.store.settled();
  // A second host on the same profile: its channels are not loaded yet.
  const gates = [];
  const fresh = createTeamChatHost({ profileDir: f.fx.dir, directory: f.store.directory, clock: f.fx.clock,
    storeLimits: { segmentMaxMessages: 2 }, retentionIntervalMs: 0, publish: () => {},
    storeYield: () => new Promise((resolve) => { gates.push(resolve); }) });
  t.after(() => fresh.dispose());
  assert.deepEqual(await fresh.start(), { ok: true });
  const context = { deviceId: alice.device_id };
  const send = (operation, params) => fresh.commands.dispatch({ operation, params, request_id: `req_${operation}` },
    context, { canAdmit: () => true, publish: () => {} });
  let large = null;
  const pending = send('team.chat.history', { channel_id: 'chan_team', limit: 3 }).then((answer) => { large = answer; });
  await turn();
  assert.equal(fresh.store.isLoading('chan_team'), true);
  const other = await send('team.chat.history', { channel_id: 'chan_project_other', limit: 3 });
  assert.deepEqual(other.messages.map((message) => message.text), ['other']);
  assert.equal(large, null, 'the large channel is still loading');

  let disposed = false;
  const disposing = fresh.dispose().then(() => { disposed = true; });
  await turn();
  assert.equal(disposed, false, 'dispose waits for the command parked on the load');
  for (let i = 0; i < 100 && !disposed; i += 1) { gates.shift()?.(); await turn(); }
  await Promise.all([pending, disposing]);
  assert.deepEqual(large.messages.map((message) => message.text), ['m7', 'm8', 'm9']);
});

test('dispose waits for a search parked between segments before it resolves', async (t) => {
  const gates = [];
  const f = await createTeamChatCommandsFixture(t, { storeLimits: { segmentMaxMessages: 5 },
    searchOptions: { yieldTo: () => new Promise((resolve) => { gates.push(resolve); }) } });
  for (let i = 0; i < 20; i += 1) await f.post(f.seats.alice, `line ${i}`);
  const searching = f.send(f.seats.alice, 'team.chat.search', { query: 'absent', limit: 5 });
  for (let i = 0; i < 20 && gates.length === 0; i += 1) await turn();
  assert.equal(gates.length, 1, 'the search is parked');
  let disposed = false;
  const disposing = f.chat.dispose().then(() => { disposed = true; });
  for (let i = 0; i < 5; i += 1) await turn();
  assert.equal(disposed, false, 'no store write is queued, yet dispose waits for the search');
  for (let i = 0; i < 100 && !disposed; i += 1) { gates.shift()?.(); await turn(); }
  await disposing;
  assert.equal((await searching).ok, true);
});
