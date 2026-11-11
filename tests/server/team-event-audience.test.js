'use strict';

// Slice 2a-2 (docs/plans/TEAM_CHAT_SPEC.md "Events"): an audience on the host event
// stream. One rule decides delivery for live send and for replay; it fails closed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Capture the command router's `publish` wrapper through a dispatcher factory it is handed.
// This file runs in its own process, so patching the export before the router loads is local.
const suggested = require('../../services/host/suggested-changes-commands');
let routerPublish = null;
const originalSuggested = suggested.createSuggestedChangesCommandDispatcher;
suggested.createSuggestedChangesCommandDispatcher = (options) => {
  routerPublish = options.result.publish;
  return originalSuggested(options);
};

const { EventStream } = require('../../server/event-stream');
const { BackendEvents } = require('../../server/backend-events');
const { openEventStream } = require('../../server/http-server');
const { ClientRegistry } = require('../../server/client-registry');
const { CommandReceipts } = require('../../server/command-receipts');
const { ControlLeases } = require('../../server/control-leases');
const { createCommandRouter } = require('../../server/command-router');

const ALICE = 'member_alice';
const BOB = 'member_bob';
const SECRET = 'project-plan-secret';

class Response extends EventEmitter {
  constructor() { super(); this.frames = []; this.writableLength = 0; this.destroyed = false; }
  write(frame) { this.frames.push(frame); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

const everyone = () => true;
const identityFor = (memberId, mayReceive = everyone) => ({ memberId, mayReceive });

// The default cursor is the stream's current one: a client that just took a snapshot.
function attach(events, { deviceId, identity, cursor = events.cursor, bootEpoch = 'boot' } = {}) {
  const response = new Response();
  const unsubscribe = events.subscribe({ response, deviceId: deviceId || identity?.memberId || 'owner',
    authorized: () => true, bootEpoch, cursor, ...(identity === undefined ? {} : { identity }) });
  return { response, unsubscribe };
}

const ids = (response) => response.frames.map((frame) => /^id: (\S+)/.exec(frame)?.[1] || null);
const types = (response) => response.frames
  .map((frame) => /^data: (.*)$/m.exec(frame)).filter(Boolean).map((match) => JSON.parse(match[1]).event_type);
const joined = (response) => response.frames.join('');

test('live send reaches only audience members; a no-audience event reaches everyone', () => {
  const events = new EventStream({ bootEpoch: 'boot' });
  const alice = attach(events, { identity: identityFor(ALICE) });
  const bob = attach(events, { identity: identityFor(BOB) });
  const owner = attach(events, {});
  events.publish('team_chat_message', { channel_id: 'chan_x', text: SECRET }, { audience: new Set([ALICE]) });
  events.publish('session_changed', { session_id: 's' });
  assert.deepEqual(types(alice.response), ['team_chat_message', 'session_changed']);
  assert.deepEqual(types(bob.response), ['session_changed']);
  assert.deepEqual(types(owner.response), ['session_changed'], 'no member id: no audience-scoped event');
  assert.doesNotMatch(joined(bob.response) + joined(owner.response), new RegExp(SECRET));
  events.dispose();
});

test('replay applies the same rule as live send', () => {
  const events = new EventStream({ bootEpoch: 'boot' });
  events.publish('team_chat_message', { text: SECRET }, { audience: new Set([ALICE]), bucket: 'teamchat:chan_x' });
  events.publish('session_changed', { session_id: 's' });
  const alice = attach(events, { identity: identityFor(ALICE), cursor: 0 });
  const bob = attach(events, { identity: identityFor(BOB), cursor: 0 });
  const owner = attach(events, { cursor: 0 });
  assert.deepEqual(types(alice.response), ['team_chat_message', 'session_changed']);
  assert.deepEqual(types(bob.response), ['session_changed']);
  assert.deepEqual(types(owner.response), ['session_changed']);
  events.dispose();
});

test('current membership is re-checked: a removed member, a throwing or missing predicate get nothing', () => {
  const events = new EventStream({ bootEpoch: 'boot' });
  let aliceIsMember = true;
  const scopes = [];
  const predicate = (memberId, scope) => { scopes.push([memberId, scope]); return aliceIsMember; };
  const live = attach(events, { identity: identityFor(ALICE, predicate) });
  const throwing = attach(events, { identity: identityFor(ALICE, () => { throw new Error('directory_degraded'); }) });
  const missing = attach(events, { identity: { memberId: ALICE } });
  const truthy = attach(events, { identity: identityFor(ALICE, () => 'yes') });
  const audience = new Set([ALICE]);
  events.publish('team_chat_message', { text: SECRET }, { audience, bucket: 'teamchat:chan_x' });
  assert.equal(live.response.frames.length, 1);
  assert.deepEqual(scopes[0], [ALICE, { type: 'team_chat_message', bucket: 'teamchat:chan_x' }],
    'the predicate sees the member and the scope, never the payload');
  for (const { response } of [throwing, missing, truthy]) assert.equal(response.frames.length, 0);
  aliceIsMember = false;
  events.publish('team_chat_message', { text: 'after removal' }, { audience });
  assert.equal(live.response.frames.length, 1, 'removed mid-stream: nothing live');
  const replay = attach(events, { identity: identityFor(ALICE, predicate), cursor: 0 });
  assert.equal(replay.response.frames.length, 0, 'removed after store: nothing on replay');
  for (const identity of [identityFor(ALICE, () => { throw new Error('x'); }), { memberId: ALICE }, identityFor(ALICE, () => 1)]) {
    assert.equal(attach(events, { identity, cursor: 0 }).response.frames.length, 0);
  }
  events.dispose();
});

test('the audience is copied at publish, so a caller mutating its set cannot widen a stored event', () => {
  const events = new EventStream({ bootEpoch: 'boot' });
  const audience = new Set([ALICE]);
  events.publish('team_chat_message', { text: SECRET }, { audience });
  audience.add(BOB);
  assert.equal(attach(events, { identity: identityFor(BOB), cursor: 0 }).response.frames.length, 0);
  events.dispose();
});

test('an empty audience reaches nobody, live or replayed', () => {
  const events = new EventStream({ bootEpoch: 'boot' });
  const alice = attach(events, { identity: identityFor(ALICE) });
  const owner = attach(events, {});
  events.publish('team_chat_message', { text: SECRET }, { audience: new Set() });
  assert.equal(alice.response.frames.length + owner.response.frames.length, 0);
  assert.equal(attach(events, { identity: identityFor(ALICE), cursor: 0 }).response.frames.length, 0);
  assert.equal(attach(events, { cursor: 0 }).response.frames.length, 0);
  events.dispose();
});

test('a malformed audience, bucket, ephemeral flag or option is a refused publish, never a broadcast', () => {
  const events = new EventStream({ bootEpoch: 'boot' });
  const owner = attach(events, {});
  const alice = attach(events, { identity: identityFor(ALICE) });
  const tooMany = new Set(Array.from({ length: 65 }, (_value, index) => `member_m${index}`));
  const refused = [
    { audience: [ALICE] }, { audience: null }, { audience: undefined }, { audience: new Set(['alice']) },
    { audience: new Set([42]) }, { audience: new Set([`member_${'x'.repeat(65)}`]) }, { audience: { has: () => true } },
    { audience: tooMany }, { bucket: undefined }, { bucket: '' }, { bucket: 'bad bucket' }, { bucket: 7 },
    { ephemeral: 'yes' }, { ephemeral: undefined }, { scope: 'all' }, null, [], 'audience',
  ];
  for (const options of refused) {
    assert.throws(() => events.publish('team_chat_message', { text: SECRET }, options),
      /invalid_publish_options|invalid_event_audience|invalid_event_bucket/, JSON.stringify(options ?? null));
  }
  assert.equal(events.cursor, 0, 'a refused publish takes no cursor');
  assert.equal(events.events.length, 0);
  assert.equal(owner.response.frames.length + alice.response.frames.length, 0);
  // An absent options argument, or an empty options object, is the unchanged broadcast.
  events.publish('session_changed', { session_id: 's' });
  events.publish('session_changed', { session_id: 's' }, {});
  assert.equal(owner.response.frames.length, 2);
  events.dispose();
});

test('ephemeral events go out live (audience-filtered) and are never stored for replay', () => {
  const events = new EventStream({ bootEpoch: 'boot' });
  const alice = attach(events, { identity: identityFor(ALICE) });
  const bob = attach(events, { identity: identityFor(BOB) });
  events.publish('team_chat_typing', { channel_id: 'chan_x', member_id: ALICE }, { audience: new Set([ALICE]), ephemeral: true });
  events.publish('team_presence', { member_id: ALICE, state: 'online' }, { ephemeral: true });
  assert.deepEqual(types(alice.response), ['team_chat_typing', 'team_presence']);
  assert.deepEqual(types(bob.response), ['team_presence']);
  assert.equal(events.events.length, 0);
  assert.equal(events.bytes, 0);
  assert.equal(attach(events, { identity: identityFor(ALICE), cursor: 0 }).response.frames.length, 0);
  events.publish('session_changed', { session_id: 's' });
  const resumed = attach(events, { identity: identityFor(ALICE), cursor: 1 });
  assert.deepEqual(types(resumed.response), ['session_changed'], 'resume across an ephemeral cursor works');
  events.dispose();
});

test('bucket picks the replay bucket and the per-bucket, byte and count bounds still hold with audiences', () => {
  const audience = new Set([ALICE]);
  const content = 'x'.repeat(300);
  const sized = new EventStream({ bootEpoch: 'boot', streamBytes: 1000 });
  sized.publish('team_chat_message', { stream_id: 'same', content }, { audience, bucket: 'teamchat:chan_a' });
  sized.publish('team_chat_message', { stream_id: 'same', content }, { audience, bucket: 'teamchat:chan_a' });
  sized.publish('team_chat_message', { stream_id: 'same', content }, { audience, bucket: 'teamchat:chan_b' });
  assert.deepEqual([...sized.streamSizes.keys()].sort(), ['teamchat:chan_a', 'teamchat:chan_b']);
  assert.equal(sized.floor, 0, 'two buckets under their cap evict nothing (one shared key would)');
  assert.equal(attach(sized, { identity: identityFor(ALICE), cursor: 0 }).response.frames.length, 3);
  sized.publish('team_chat_message', { content }, { audience, bucket: 'teamchat:chan_a' });
  assert.equal(sized.floor > 0, true, 'a bucket over its cap still trims');
  sized.dispose();

  // The audience counts toward the stored bytes.
  const plain = new EventStream({ bootEpoch: 'boot' });
  const scoped = new EventStream({ bootEpoch: 'boot' });
  plain.publish('team_chat_message', { content }, { bucket: 'teamchat:chan_a' });
  scoped.publish('team_chat_message', { content }, { bucket: 'teamchat:chan_a', audience: new Set([ALICE, BOB]) });
  assert.equal(scoped.bytes - plain.bytes, ALICE.length + BOB.length);
  plain.dispose(); scoped.dispose();

  const counted = new EventStream({ bootEpoch: 'boot' });
  for (let index = 0; index < 4100; index += 1) counted.publish('team_chat_message', { n: index }, { audience, bucket: 'teamchat:chan_a' });
  assert.equal(counted.events.length, 4096);
  assert.equal(counted.floor, 4);
  counted.dispose();

  const total = new EventStream({ bootEpoch: 'boot', maxBytes: 2000 });
  for (let index = 0; index < 10; index += 1) total.publish('team_chat_message', { content }, { audience, bucket: `teamchat:chan_${index}` });
  assert.equal(total.bytes <= 2000, true);
  assert.equal(total.floor > 0, true);
  total.dispose();
});

test('a filtered subscriber never receives a hidden event id, and resume from what it saw works', () => {
  const events = new EventStream({ bootEpoch: 'boot' });
  const bob = attach(events, { identity: identityFor(BOB) });
  events.publish('session_changed', { session_id: 's' });
  events.publish('team_chat_message', { text: SECRET }, { audience: new Set([ALICE]) });
  assert.deepEqual(ids(bob.response), ['boot:1'], 'the last event id Bob holds is the last event he saw');
  events.publish('session_changed', { session_id: 's' });
  assert.deepEqual(ids(bob.response), ['boot:1', 'boot:3']);
  const resumed = attach(events, { identity: identityFor(BOB), cursor: 1 });
  assert.deepEqual(ids(resumed.response), ['boot:3']);
  assert.deepEqual(types(attach(events, { identity: identityFor(BOB), cursor: 3 }).response), []);
  // A gap resync carries only its reason: no hidden type, bucket or payload.
  const resync = attach(events, { identity: identityFor(BOB), bootEpoch: 'prior', cursor: 1 });
  assert.deepEqual(types(resync.response), ['resync_required']);
  assert.doesNotMatch(joined(resync.response), /team_chat_message|teamchat|project-plan/);
  // An oversized audience event becomes a resync frame that keeps the same audience.
  const owner = attach(events, {});
  events.publish('team_chat_message', { text: 'y'.repeat(600 * 1024) }, { audience: new Set([ALICE]) });
  assert.equal(bob.response.frames.length, 2);
  assert.equal(owner.response.frames.length, 0);
  assert.equal(attach(events, { identity: identityFor(BOB), cursor: 3 }).response.frames.length, 0);
  assert.deepEqual(types(attach(events, { identity: identityFor(ALICE), cursor: 3 }).response), ['resync_required']);
  events.dispose();
});

test('a stream closed on revocation receives nothing after the close', () => {
  const events = new EventStream({ bootEpoch: 'boot' });
  const alice = attach(events, { deviceId: 'device_alice', identity: identityFor(ALICE) });
  const audience = new Set([ALICE]);
  events.publish('team_chat_message', { text: 'before' }, { audience });
  events.revokeDevice('device_alice');
  events.publish('team_chat_message', { text: SECRET }, { audience });
  events.publish('session_changed', { session_id: 's' });
  assert.equal(alice.response.destroyed, true);
  assert.equal(alice.response.frames.length, 1);
  assert.doesNotMatch(joined(alice.response), new RegExp(SECRET));
  events.dispose();
});

test('BackendEvents passes publish options and the subscription identity through', () => {
  const backend = new EventEmitter();
  const events = new BackendEvents({ backend, bootEpoch: 'boot' });
  const alice = attach(events, { identity: identityFor(ALICE) });
  const owner = attach(events, {});
  events.publish('team_chat_message', { text: SECRET }, { audience: new Set([ALICE]), bucket: 'teamchat:chan_x' });
  assert.deepEqual(types(alice.response), ['team_chat_message']);
  assert.equal(owner.response.frames.length, 0);
  assert.throws(() => events.publish('team_chat_message', {}, { audience: [ALICE] }), /invalid_event_audience/);
  events.dispose();
});

test('openEventStream hands a caller-supplied identity to the subscription, and none when absent', () => {
  const seen = [];
  const events = { subscribe: (options) => { seen.push(options.identity); return () => {}; } };
  const clients = { attach: () => () => {} };
  const identity = identityFor(ALICE);
  for (const extra of [{ identity }, {}]) {
    const response = new Response();
    openEventStream({ request: { headers: {} }, response, requestId: 'r', deviceId: 'd', clientId: `c${seen.length}`,
      clientToken: 't', authorized: () => true, clients, events, streams: new Map(), ...extra });
  }
  assert.equal(seen[0], identity);
  assert.equal(seen[1], undefined);
});

test('the command router publish wrapper forwards options and swallows a refused publish', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-audience-router-'));
  const calls = [];
  const eventStream = { publish(type, payload, options) {
    calls.push([type, payload, options]);
    if (options?.audience && !(options.audience instanceof Set)) throw new Error('invalid_event_audience');
  } };
  const receipts = new CommandReceipts({ filePath: path.join(root, 'receipts.json') });
  const router = createCommandRouter({ backend: new EventEmitter(), clients: new ClientRegistry(), leases: new ControlLeases(),
    receipts, bootEpoch: 'boot_audience', eventStream });
  try {
    assert.equal(typeof routerPublish, 'function');
    const audience = new Set([ALICE]);
    routerPublish('team_chat_message', { channel_id: 'chan_x' }, { audience, bucket: 'teamchat:chan_x' });
    assert.deepEqual(calls[0], ['team_chat_message', { channel_id: 'chan_x' }, { audience, bucket: 'teamchat:chan_x' }]);
    assert.doesNotThrow(() => routerPublish('team_chat_message', {}, { audience: [ALICE] }));
    routerPublish('session_changed', { session_id: 's' });
    assert.deepEqual(calls[2], ['session_changed', { session_id: 's' }, undefined]);
  } finally {
    router.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
