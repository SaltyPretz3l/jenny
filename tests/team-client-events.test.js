'use strict';

// The member client's event feed and command request ids (team slice 2a-4a),
// against the real in-process team host through the real bridge supervisors and
// the fake bridge child: host events reach `manager.onEvent` listeners in order,
// exactly once, across a dropped link (resumed with Last-Event-ID) and a host
// restart (resync_required); an invalid frame drops the stream and the next one
// asks for a resync; the remembered id is cleared on stop, leave and revoke; a
// caller's request id survives the re-register retry; and the admin rate-limit
// hold does not block team.chat.* operations.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createConnectionManager } = require('../services/team/connection-manager');
const { createDeviceKeyStore } = require('../services/team/device-key-store');
const { createEventFeed } = require('../services/team/event-feed');
const { loadClientFile, saveClientFile } = require('../services/team/client-file');
const { createTeamClientHost, joinAs, pause, waitUntil } = require('./helpers/team-client-host');

const MARKER = 'payload-marker-never-logged';

function countingTimers() {
  const live = new Set();
  const delays = [];
  return {
    live, delays,
    setTimeout(fn, ms) {
      delays.push(ms);
      const handle = setTimeout(() => { live.delete(handle); fn(); }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout(handle) { live.delete(handle); clearTimeout(handle); },
  };
}

// An admitted member (or the first owner with `owner: false`) whose own connection manager is online,
// with a recorder subscribed before the start so the first frame is seen too.
async function onlineMember(t, { owner: withOwner = true, managerOptions = {} } = {}) {
  const host = await createTeamClientHost(t);
  const owner = withOwner ? await host.ownerDirect() : null;
  const first = host.createService();
  const me = await joinAs(host, first, withOwner ? { owner } : {});
  await host.waitForState(me.teamId, 'online');
  await first.stopAll();
  const record = loadClientFile(host.userData, me.teamId).record;
  const logs = [];
  const timers = countingTimers();
  const manager = createConnectionManager({
    record, deviceKeys: createDeviceKeyStore({ getSecureStore: () => host.secureStore }),
    saveRecord: (next) => saveClientFile(host.userData, next),
    log: (level, event, fields) => logs.push({ level, event, fields }), spawnChild: host.memberSpawner,
    appVersion: '1.6.1', backoff: { initialMs: 20, maxMs: 80 }, timers, ...managerOptions,
  });
  t.after(() => manager.stop());
  const seen = [];
  manager.onEvent((event) => seen.push(event));
  manager.start();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'online' && seen.length > 0), 'online with a first event');
  return { host, owner, me, manager, logs, timers, seen };
}

const ofType = (events, type) => events.filter((event) => event.event_type === type);
const frame = (id, body) => `id: ${id}\nevent: jenny\ndata: ${JSON.stringify(body)}\n\n`;

test('a first stream with no cursor starts with resync_required; host events then arrive in order', async (t) => {
  const { host, manager, seen, logs } = await onlineMember(t);
  const epoch = host.env.core.bootEpoch;
  assert.equal(seen[0].event_type, 'resync_required');
  assert.equal(seen[0].reason, 'replay_unavailable');
  assert.equal(seen[0].boot_epoch, epoch);
  assert.equal(host.env.subscribesSeen.at(-1).bootEpoch, null, 'the first stream sent no Last-Event-ID');
  for (const n of [1, 2, 3]) host.publishEvent('team_test_event', { n, note: MARKER });
  assert.ok(await waitUntil(() => ofType(seen, 'team_test_event').length === 3));
  const got = ofType(seen, 'team_test_event');
  assert.deepEqual(got.map((event) => event.n), [1, 2, 3]);
  assert.deepEqual(got.map((event) => event.cursor), [got[0].cursor, got[0].cursor + 1, got[0].cursor + 2]);
  assert.ok(got.every((event) => event.boot_epoch === epoch));
  assert.ok(Object.isFrozen(got[0]), 'listeners share one frozen event');
  assert.equal(manager.eventCursor(), got[2].cursor);
  const text = JSON.stringify(logs);
  assert.ok(!text.includes(MARKER), 'no payload in a log');
  assert.ok(!text.includes(`${epoch}:`), 'no full event id in a log');
});

test('two listeners both receive events; one unsubscribing leaves the other', async (t) => {
  const { host, manager } = await onlineMember(t);
  const a = [];
  const b = [];
  const offA = manager.onEvent((event) => a.push(event.n));
  manager.onEvent((event) => b.push(event.n));
  host.publishEvent('team_test_event', { n: 1 });
  assert.ok(await waitUntil(() => a.length === 1 && b.length === 1));
  offA();
  offA();
  host.publishEvent('team_test_event', { n: 2 });
  assert.ok(await waitUntil(() => b.length === 2));
  await pause(50);
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, [1, 2]);
});

test('a listener that throws does not stop the next listener, the next event or the stream', async (t) => {
  const { host, manager, seen, logs } = await onlineMember(t);
  manager.onEvent(() => { throw new Error(`boom ${MARKER}`); });
  const after = [];
  manager.onEvent((event) => after.push(event.n));
  host.publishEvent('team_test_event', { n: 1, note: MARKER });
  host.publishEvent('team_test_event', { n: 2, note: MARKER });
  assert.ok(await waitUntil(() => after.length === 2));
  assert.deepEqual(after, [1, 2]);
  assert.equal(ofType(seen, 'team_test_event').length, 2);
  assert.equal(manager.snapshot().state, 'online');
  assert.equal(manager.resources().streams, 1);
  const failures = logs.filter((line) => line.event === 'team.events.listener_failed');
  assert.equal(failures.length, 2);
  assert.ok(!JSON.stringify(logs).includes(MARKER), 'neither the payload nor the thrown text is logged');
});

test('after a dropped link, events published while away arrive exactly once, resumed by Last-Event-ID', async (t) => {
  const { host, me, manager, seen } = await onlineMember(t);
  const epoch = host.env.core.bootEpoch;
  host.publishEvent('team_test_event', { n: 1 });
  assert.ok(await waitUntil(() => ofType(seen, 'team_test_event').length === 1));
  const cursor = manager.eventCursor();
  const subscribes = host.env.subscribesSeen.length;
  host.holdDials();
  host.dropEventStreams(me.device_id);
  assert.ok(await waitUntil(() => manager.snapshot().state !== 'online'), 'the member saw the link drop');
  host.publishEvent('team_test_event', { n: 2 });
  host.publishEvent('team_test_event', { n: 3 });
  host.releaseDials();
  assert.ok(await waitUntil(() => ofType(seen, 'team_test_event').length >= 3));
  await pause(100);
  assert.deepEqual(ofType(seen, 'team_test_event').map((event) => event.n), [1, 2, 3]);
  assert.equal(ofType(seen, 'resync_required').length, 1, 'the replay needed no resync');
  const resumed = host.env.subscribesSeen.slice(subscribes);
  assert.equal(resumed.length, 1);
  assert.deepEqual(resumed[0], { bootEpoch: epoch, cursor });
});

test('a frame at or below the remembered cursor is dropped without closing the stream', async (t) => {
  const { host, manager, seen } = await onlineMember(t);
  const epoch = host.env.core.bootEpoch;
  host.publishEvent('team_test_event', { n: 1 });
  assert.ok(await waitUntil(() => ofType(seen, 'team_test_event').length === 1));
  const cursor = manager.eventCursor();
  const subscribes = host.env.subscribesSeen.length;
  host.writeRawToStreams(frame(`${epoch}:${cursor}`, { event_type: 'team_test_event', n: 99, cursor, boot_epoch: epoch }));
  host.publishEvent('team_test_event', { n: 2 });
  assert.ok(await waitUntil(() => ofType(seen, 'team_test_event').length === 2));
  assert.deepEqual(ofType(seen, 'team_test_event').map((event) => event.n), [1, 2]);
  assert.equal(host.env.subscribesSeen.length, subscribes, 'the stream stayed open');
});

test('a host restart (new boot epoch) delivers resync_required and the feed continues', async (t) => {
  const { host, manager, seen } = await onlineMember(t);
  const oldEpoch = host.env.core.bootEpoch;
  host.publishEvent('team_test_event', { n: 1 });
  assert.ok(await waitUntil(() => ofType(seen, 'team_test_event').length === 1));
  const cursor = manager.eventCursor();
  await host.restartHost();
  const newEpoch = host.env.core.bootEpoch;
  assert.notEqual(newEpoch, oldEpoch);
  assert.ok(await waitUntil(() => ofType(seen, 'resync_required').some((event) => event.boot_epoch === newEpoch)),
    'resync_required from the new host');
  assert.deepEqual(host.env.subscribesSeen.at(-1), { bootEpoch: oldEpoch, cursor }, 'the old id was offered');
  host.publishEvent('team_test_event', { n: 2 });
  assert.ok(await waitUntil(() => ofType(seen, 'team_test_event').length === 2));
  const last = ofType(seen, 'team_test_event')[1];
  assert.equal(last.boot_epoch, newEpoch);
  assert.equal(manager.eventCursor(), last.cursor);
});

for (const [name, bytes] of [
  ['a frame whose data is not JSON', () => 'id: x:1\nevent: jenny\ndata: not json\n\n'],
  ['a frame whose id does not match its data', (epoch) => frame(`${epoch}:9999`,
    { event_type: 'team_test_event', cursor: 10000, boot_epoch: epoch })],
  ['bytes that are not UTF-8', () => Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0xff, 0x0a, 0x0a])],
]) {
  test(`${name} closes the stream and the next connection carries no Last-Event-ID`, async (t) => {
    const { host, manager, seen, logs } = await onlineMember(t);
    host.publishEvent('team_test_event', { n: 1 });
    assert.ok(await waitUntil(() => ofType(seen, 'team_test_event').length === 1));
    const subscribes = host.env.subscribesSeen.length;
    host.writeRawToStreams(bytes(host.env.core.bootEpoch));
    assert.ok(await waitUntil(() => host.env.subscribesSeen.length > subscribes && manager.snapshot().state === 'online'
      && ofType(seen, 'resync_required').length === 2), 'reconnected and resynced');
    assert.equal(host.env.subscribesSeen[subscribes].bootEpoch, null, 'no Last-Event-ID after an invalid frame');
    assert.equal(ofType(seen, 'team_test_event').length, 1, 'the invalid frame was not delivered');
    const rejected = logs.filter((line) => line.event === 'team.events.frame_rejected');
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].fields.reason, /^event_frame_[a-z_]+$/u);
  });
}

test('stop clears the remembered id and leaves no child, timer or socket', async (t) => {
  const { host, manager, seen, timers } = await onlineMember(t);
  host.publishEvent('team_test_event', { n: 1 });
  assert.ok(await waitUntil(() => ofType(seen, 'team_test_event').length === 1));
  assert.equal(typeof manager.eventCursor(), 'number');
  await manager.stop();
  assert.equal(manager.eventCursor(), null);
  assert.deepEqual(manager.resources(), { bridges: 0, timers: 0, sockets: 0, streams: 0 });
  assert.equal(timers.live.size, 0);
  assert.equal(host.liveMemberChildren().length, 0);
  const count = seen.length;
  host.publishEvent('team_test_event', { n: 2 });
  await pause(50);
  assert.equal(seen.length, count, 'nothing is delivered after stop');
});

test('leave clears the remembered id', async (t) => {
  const { manager } = await onlineMember(t);
  assert.equal(typeof manager.eventCursor(), 'number');
  assert.deepEqual(await manager.leave(), { ok: true });
  assert.equal(manager.eventCursor(), null);
});

test('the terminal revoked state clears the remembered id', async (t) => {
  const { host, owner, me, manager } = await onlineMember(t);
  assert.equal(typeof manager.eventCursor(), 'number');
  assert.equal((await host.env.store.revokeMember({ actorMemberId: owner.member_id, memberId: me.member_id })).ok, true);
  assert.ok(await waitUntil(() => manager.snapshot().state === 'revoked'));
  assert.equal(manager.eventCursor(), null);
});

test('a caller request id is sent on the first attempt and on the re-register retry', async (t) => {
  const { host, me, manager } = await onlineMember(t);
  host.env.context.clients.revokeDevice(me.device_id);
  const from = host.env.commandsSeen.length;
  const answer = await manager.command('team.members.list', {}, { requestId: 'req_fixed_0001' });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const sent = host.env.commandsSeen.slice(from).filter((entry) => entry.operation === 'team.members.list');
  assert.equal(sent.length, 2, 'refused at identity, then retried once');
  assert.deepEqual(sent.map((entry) => entry.request_id), ['req_fixed_0001', 'req_fixed_0001']);
});

test('without a caller id the two attempts carry different ids, as before', async (t) => {
  const { host, me, manager } = await onlineMember(t);
  host.env.context.clients.revokeDevice(me.device_id);
  const from = host.env.commandsSeen.length;
  const answer = await manager.command('team.members.list', {});
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const sent = host.env.commandsSeen.slice(from).filter((entry) => entry.operation === 'team.members.list');
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].request_id, sent[1].request_id);
});

test('an invalid caller request id is refused before any request is sent', async (t) => {
  const { host, manager } = await onlineMember(t);
  const from = host.env.commandsSeen.length;
  for (const requestId of ['', 'has space', 'x'.repeat(129), 'dot.ted', 42, null]) {
    const answer = await manager.command('team.members.list', {}, { requestId });
    assert.equal(answer.ok, false, String(requestId));
    assert.equal(answer.error.code, 'invalid_request');
    assert.equal(answer.error.reason, 'team_request_id_invalid');
  }
  assert.equal(host.env.commandsSeen.length, from, 'nothing reached the host');
  assert.equal((await manager.command('team.members.list', {}, { requestId: 'A'.repeat(128) })).ok, true);
});

test('the admin rate-limit hold does not block team.chat.* operations', async (t) => {
  const { host, manager } = await onlineMember(t, { owner: false });
  let limited = null;
  for (let index = 0; index < 31 && !limited; index += 1) {
    const answer = await manager.command('team.invite.list', {});
    if (!answer.ok && answer.error.reason === 'team_rate_limit') limited = answer;
  }
  assert.ok(limited, 'the host rate-limits after 30 calls');
  const from = host.env.commandsSeen.length;
  const held = await manager.command('team.members.list', {});
  assert.equal(held.error.reason, 'team_rate_limit');
  assert.equal(host.env.commandsSeen.length, from, 'the admin command was held in main');
  await manager.command('team.chat.post', { channel_id: 'chan_team', text: 'hello' });
  assert.deepEqual(host.env.commandsSeen.slice(from).map((entry) => entry.operation), ['team.chat.post'],
    'the chat operation reached the host');
});

test('team_chat_rate_limit is passed through with no hold', async (t) => {
  const { host, manager } = await onlineMember(t, { owner: false });
  host.env.commandHook = (command) => (command.operation.startsWith('team.chat.')
    ? { ok: false, error: { code: 'CMP-HOST-0007', kind: 'limit', reason: 'team_chat_rate_limit', retryable: true,
      request_id: command.request_id } }
    : null);
  const first = await manager.command('team.chat.post', { channel_id: 'chan_team', text: 'one' });
  assert.equal(first.error.reason, 'team_chat_rate_limit');
  const from = host.env.commandsSeen.length;
  await manager.command('team.chat.post', { channel_id: 'chan_team', text: 'two' });
  assert.equal((await manager.command('team.members.list', {})).ok, true);
  assert.deepEqual(host.env.commandsSeen.slice(from).map((entry) => entry.operation),
    ['team.chat.post', 'team.members.list']);
});

test('the feed refuses malformed frames, never guesses a cursor, and accepts a new boot epoch', () => {
  const lines = [];
  const feed = createEventFeed({ log: (level, event, fields) => lines.push({ event, fields }) });
  const got = [];
  feed.onEvent((event) => got.push(event));
  const ok = (epoch, cursor, extra = {}) => ({ id: `${epoch}:${cursor}`, event: 'jenny',
    data: JSON.stringify({ event_type: 'team_test_event', cursor, boot_epoch: epoch, ...extra }) });
  assert.equal(feed.lastEventId(), null);
  assert.deepEqual(feed.accept(ok('epoch_a', 4)), { ok: true, delivered: true, eventType: 'team_test_event' });
  assert.equal(feed.lastEventId(), 'epoch_a:4');
  assert.deepEqual(feed.accept(ok('epoch_a', 4)), { ok: true, delivered: false });
  assert.deepEqual(feed.accept(ok('epoch_a', 2)), { ok: true, delivered: false });
  assert.deepEqual(feed.accept(ok('epoch_b', 0)), { ok: true, delivered: true, eventType: 'team_test_event' });
  assert.equal(feed.lastEventId(), 'epoch_b:0');
  const bad = [
    { id: 'epoch_b:1', event: 'jenny', data: '[1]' },
    { id: 'epoch_b:1', event: 'jenny', data: 'null' },
    { id: 'epoch_b:1', event: 'other', data: ok('epoch_b', 1).data },
    { id: null, event: 'jenny', data: ok('epoch_b', 1).data },
    { id: 'epoch_b:1', event: 'jenny', data: null },
    ok('epoch_b', 1, { event_type: 7 }),
    ok('epoch_b', 1, { event_type: 'Bad Type' }),
    { ...ok('epoch_b', 1), data: JSON.stringify({ event_type: 'x', cursor: 1.5, boot_epoch: 'epoch_b' }) },
    { ...ok('epoch_b', 1), data: JSON.stringify({ event_type: 'x', cursor: -1, boot_epoch: 'epoch_b' }) },
    { ...ok('epoch_b', 1), data: JSON.stringify({ event_type: 'x', cursor: 2 ** 53, boot_epoch: 'epoch_b' }) },
    { ...ok('epoch_b', 1), data: JSON.stringify({ event_type: 'x', cursor: 1, boot_epoch: 5 }) },
    { ...ok('epoch_b', 1), data: JSON.stringify({ event_type: 'x', cursor: 1, boot_epoch: 'has space' }) },
    { ...ok('epoch_b', 1), id: 'epoch_c:1' },
  ];
  for (const entry of bad) {
    feed.accept(ok('epoch_b', 5));
    const result = feed.accept(entry);
    assert.equal(result.ok, false, JSON.stringify(entry));
    assert.match(result.reason, /^event_frame_[a-z_]+$/u);
    assert.equal(feed.lastEventId(), null, 'an invalid frame clears the remembered id');
  }
  assert.ok(got.every((event) => event.event_type === 'team_test_event'), 'no invalid frame was delivered');
  feed.clear();
  assert.equal(feed.cursor(), null);
  assert.equal(lines.length, 0, 'the feed itself logs nothing on a refusal; the manager does');
});

test('consecutive rejected frames back off exponentially; one valid event resets the count', async (t) => {
  const { host, manager, seen, timers } = await onlineMember(t,
    { managerOptions: { backoff: { initialMs: 20, maxMs: 1000 }, random: () => 0 } });
  const rejectOnce = async () => {
    const subscribes = host.env.subscribesSeen.length;
    const resyncs = ofType(seen, 'resync_required').length;
    const delays = timers.delays.length;
    host.writeRawToStreams('id: x:1\nevent: jenny\ndata: not json\n\n');
    assert.ok(await waitUntil(() => host.env.subscribesSeen.length > subscribes && manager.snapshot().state === 'online'
      && ofType(seen, 'resync_required').length > resyncs), 'reconnected and resynced');
    return timers.delays.slice(delays);
  };
  assert.deepEqual([await rejectOnce(), await rejectOnce(), await rejectOnce()], [[40], [80], [160]],
    'each rejection doubles the delay; the resync_required on each new stream does not reset it');
  host.publishEvent('team_test_event', { n: 1 });
  assert.ok(await waitUntil(() => ofType(seen, 'team_test_event').length === 1));
  assert.deepEqual(await rejectOnce(), [40], 'a delivered event reset the count');
});

test('a host that goes silent is detected by the stream idle timer and the manager reconnects', async (t) => {
  const eventTimers = countingTimers();
  const { host, manager } = await onlineMember(t, { managerOptions: { eventIdleMs: 150, eventTimers } });
  const subscribes = host.env.subscribesSeen.length;
  assert.ok(await waitUntil(() => host.env.subscribesSeen.length >= subscribes + 2 && manager.snapshot().state === 'online'),
    'silent streams were dropped and replaced');
  assert.ok(eventTimers.delays.length > 0 && eventTimers.delays.every((ms) => ms === 150));
  await manager.stop();
  assert.equal(eventTimers.live.size, 0, 'stop leaves no idle timer');
});

test('a stream that only heartbeats stays open past several idle intervals', async (t) => {
  const eventTimers = countingTimers();
  const { host, manager } = await onlineMember(t, { managerOptions: { eventIdleMs: 150, eventTimers } });
  const subscribes = host.env.subscribesSeen.length;
  const beat = setInterval(() => host.writeRawToStreams(': heartbeat\n\n'), 40);
  t.after(() => clearInterval(beat));
  await pause(700);
  clearInterval(beat);
  assert.equal(host.env.subscribesSeen.length, subscribes, 'the same stream stayed open');
  assert.equal(manager.snapshot().state, 'online');
  assert.equal(eventTimers.live.size, 1, 'one idle timer while the stream is open');
  await manager.stop();
  assert.equal(eventTimers.live.size, 0, 'stop leaves no idle timer');
});

test('the host constants hold: a 64-character event type arrives; an oversized event arrives as resync_required', async (t) => {
  const { host, seen } = await onlineMember(t);
  const longType = 'a'.repeat(64);
  host.publishEvent(longType, { n: 1 });
  assert.ok(await waitUntil(() => ofType(seen, longType).length === 1), 'a 64-character type is delivered');
  host.publishEvent('team_test_event', { blob: 'x'.repeat(600 * 1024) });
  assert.ok(await waitUntil(() => ofType(seen, 'resync_required').some((event) => event.reason === 'event_size_limit')),
    'the host replaced the oversized event with resync_required');
  assert.equal(ofType(seen, 'team_test_event').length, 0);
});

test('a hello that answers for another team clears the remembered id', async (t) => {
  const { host, me, manager } = await onlineMember(t);
  assert.equal(typeof manager.eventCursor(), 'number');
  host.env.store.teamId = () => 'team_someone_else';
  t.after(() => { delete host.env.store.teamId; });
  host.dropEventStreams(me.device_id);
  assert.ok(await waitUntil(() => manager.snapshot().reason === 'team_identity_mismatch'));
  assert.equal(manager.eventCursor(), null);
});

test('a frame nested deeper than the bound is refused without a throw and clears the position', () => {
  const feed = createEventFeed();
  const got = [];
  feed.onEvent((event) => got.push(event));
  const nest = (levels) => `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`;
  const deep = (cursor, levels) => ({ id: `e:${cursor}`, event: 'jenny',
    data: `{"event_type":"team_test_event","cursor":${cursor},"boot_epoch":"e","n":${nest(levels)}}` });
  // The event object is level 1, so 31 nested objects inside it make 32 levels: the bound.
  assert.equal(feed.accept(deep(1, 31)).delivered, true);
  const over = feed.accept(deep(2, 32));
  assert.deepEqual(over, { ok: false, reason: 'event_frame_too_deep' });
  assert.equal(feed.lastEventId(), null);
  feed.accept(deep(3, 31));
  let huge;
  assert.doesNotThrow(() => { huge = feed.accept(deep(4, 100_000)); });
  assert.equal(huge.ok, false);
  assert.equal(feed.lastEventId(), null, 'the position is cleared, never moved past the refused frame');
  assert.deepEqual(got.map((event) => event.cursor), [1, 3]);
});
