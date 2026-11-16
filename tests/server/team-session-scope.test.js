'use strict';

// Slice 3-3 session scope, unit level: BackendEvents over a stand-in backend and the
// team directory fixture (owner, two members, a read-only member, a pending member;
// project_1 holds the owner as admin, both members as writers and the read-only
// member as reader). Covers the fail-closed cases, the per-pass project lookup memo,
// the drop log and the single-owner parity.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { BackendEvents } = require('../../server/backend-events');
const { createEventScope } = require('../../server/team/event-scope');
const { createTeamDirectoryFixture } = require('./helpers/team-directory-fixture');
const { createUnitHost, dataFrames } = require('./helpers/session-scope-fixture');

const IN_PROJECT = (id) => (id.startsWith('p1_') ? 'project_1' : null);
const framesOf = (h) => Object.fromEntries(Object.entries(h.streams)
  .map(([memberId, { response }]) => [memberId, dataFrames(response.frames).length]));

test('a sessionProject that throws denies everyone: no audience, no delivery, no capture, an unavailable answer', () => {
  const fixture = createTeamDirectoryFixture();
  const h = createUnitHost(fixture, () => { throw new Error('index unavailable'); });
  h.events.publish('session_changed', { session_id: 'session_1', revision: 'r1' });
  const entry = h.stored().at(-1);
  assert.equal(entry.stream, 'session:session_1');
  assert.deepEqual(entry.audience, new Set());
  for (const count of Object.values(framesOf(h))) assert.equal(count, 0);
  assert.deepEqual(h.sessionScope.audience('session_1'), new Set());
  assert.deepEqual(h.sessionScope.capture('session_1').audience, new Set());
  for (const who of ['owner', 'member']) {
    const answer = h.authorize(fixture.actors[who], 'session.read', { kind: 'session', id: 'session_1' });
    assert.equal(answer.error?.reason, 'team_unavailable', who);
  }
  const identity = h.sessionScope.identity(fixture.actors.owner);
  assert.equal(identity.mayReceive('member_owner', { type: 'session_changed', bucket: 'session:session_1' }), false);
  h.events.dispose();
});

test('a missing resolver and a null answer stay General, the owner alone', () => {
  for (const resolver of [undefined, () => null]) {
    const h = createUnitHost(createTeamDirectoryFixture(), resolver);
    h.events.publish('session_changed', { session_id: 'session_1', revision: 'r1' });
    assert.deepEqual(h.stored().at(-1).audience, new Set(['member_owner']));
    assert.deepEqual(framesOf(h), { member_owner: 1, member_a: 0, member_b: 0, member_ro: 0 });
    h.events.dispose();
  }
});

test('a team directory with no project roles gives nobody', () => {
  const fixture = createTeamDirectoryFixture();
  delete fixture.directory.projectRole;
  const h = createUnitHost(fixture, () => 'project_1');
  h.events.publish('session_changed', { session_id: 'session_1', revision: 'r1' });
  assert.deepEqual(h.stored().at(-1).audience, new Set());
  for (const count of Object.values(framesOf(h))) assert.equal(count, 0);
  h.events.dispose();
});

test('General with no active owner publishes an empty audience, never a broadcast', () => {
  const fixture = createTeamDirectoryFixture();
  fixture.setState('device_owner', 'pending');
  const h = createUnitHost(fixture, () => null);
  h.events.publish('session_changed', { session_id: 'session_general', revision: 'r1' });
  const entry = h.stored().at(-1);
  assert.ok(entry.audience instanceof Set, 'a Set, not null (null is a broadcast)');
  assert.equal(entry.audience.size, 0);
  assert.equal(entry.stream, 'session:session_general');
  assert.ok(Object.keys(h.streams).length >= 3, 'the active members are listening');
  for (const count of Object.values(framesOf(h))) assert.equal(count, 0);
  h.events.dispose();
});

test('a malformed session id is dropped as session_id_missing, for chat_stream and session_changed alike', () => {
  const h = createUnitHost(createTeamDirectoryFixture(), IN_PROJECT);
  const before = h.events.cursor;
  for (const sessionId of ['a:b', 'x'.repeat(129), ' p1_leading', '']) {
    h.events.publish('chat_stream', { session_id: sessionId, stream_id: 'stream_1', event: { type: 'started' } });
    h.events.publish('session_changed', { session_id: sessionId, revision: 'r1' });
  }
  assert.equal(h.events.cursor, before, 'nothing was stored');
  for (const count of Object.values(framesOf(h))) assert.equal(count, 0);
  assert.deepEqual(h.dropLogs(), [{ event_type: 'chat_stream', reason: 'session_id_missing' },
    { event_type: 'session_changed', reason: 'session_id_missing' }], 'logged once per type and reason');
  assert.deepEqual(h.events.droppedEvents(), { 'chat_stream:session_id_missing': 4, 'session_changed:session_id_missing': 4 });
  h.events.dispose();
});

test('a degraded directory stops session delivery and replay for a non-owner; the owner keeps them', () => {
  const fixture = createTeamDirectoryFixture();
  const h = createUnitHost(fixture, IN_PROJECT);
  fixture.setDegraded(true);
  h.events.publish('session_changed', { session_id: 'p1_conversation', revision: 'r1' });
  assert.deepEqual(framesOf(h), { member_owner: 1, member_a: 0, member_b: 0, member_ro: 0 });
  assert.equal(dataFrames(h.attach(fixture.actors.member, { cursor: 0 }).frames).length, 0, 'no replay while degraded');
  fixture.setDegraded(false);
  assert.equal(dataFrames(h.attach(fixture.actors.member, { cursor: 0 }).frames).length, 1, 'replay once recovered');
  h.events.dispose();
});

test('a pending member who holds a project role receives nothing', () => {
  const fixture = createTeamDirectoryFixture();
  fixture.setProjectRole('member_pending', 'project_1', 'writer');
  const h = createUnitHost(fixture, IN_PROJECT);
  const pending = h.attach(fixture.actors.pending);
  h.events.publish('session_changed', { session_id: 'p1_conversation', revision: 'r1' });
  assert.equal(h.stored().at(-1).audience.has('member_pending'), false);
  assert.equal(dataFrames(pending.frames).length, 0);
  assert.equal(dataFrames(h.attach(fixture.actors.pending, { cursor: 0 }).frames).length, 0);
  h.events.dispose();
});

test('one project lookup per publish and one per conversation per replay; none outlives the call', () => {
  const fixture = createTeamDirectoryFixture();
  let lookups = 0;
  let project = 'project_1';
  const h = createUnitHost(fixture, (id) => { lookups += 1; return id.startsWith('p1_') ? project : null; });
  lookups = 0;
  h.backend.emit('chat-stream', { type: 'started', sessionId: 'p1_one', streamId: 'stream_1' });
  assert.equal(lookups, 1, 'one chat_stream to every stream: one lookup');
  assert.deepEqual(framesOf(h), { member_owner: 1, member_a: 1, member_b: 1, member_ro: 1 });
  for (let n = 0; n < 3; n += 1) {
    h.events.publish('session_changed', { session_id: 'p1_one', revision: `r${n}` });
    h.events.publish('session_changed', { session_id: 'p1_two', revision: `r${n}` });
  }
  lookups = 0;
  const replayed = h.attach(fixture.actors.member, { cursor: 0 });
  assert.equal(dataFrames(replayed.frames).length, 7);
  assert.equal(lookups, 2, 'a replay of seven events for two conversations: two lookups');
  // The next call looks again and sees the changed project.
  project = 'project_elsewhere';
  h.events.publish('session_changed', { session_id: 'p1_one', revision: 'r9' });
  assert.deepEqual(h.stored().at(-1).audience, new Set(['member_owner']), 'a project with no team row is the owner\'s');
  h.events.dispose();
});

test('a throw is remembered for the pass: one lookup, and nobody receives', () => {
  let lookups = 0;
  const h = createUnitHost(createTeamDirectoryFixture(), () => { lookups += 1; throw new Error('index unavailable'); });
  lookups = 0;
  h.backend.emit('chat-stream', { type: 'started', sessionId: 'p1_one', streamId: 'stream_1' });
  assert.equal(lookups, 1);
  for (const count of Object.values(framesOf(h))) assert.equal(count, 0);
  h.events.dispose();
});

test('a scope whose audience is not a Set drops the event as audience_unavailable', () => {
  const logs = [];
  const scope = createEventScope({ sessionScope: { audience: () => null },
    logger: (level, event, fields) => logs.push(fields) });
  assert.equal(scope('session_changed', { session_id: 'session_1' }), null);
  assert.deepEqual(logs, [{ event_type: 'session_changed', reason: 'audience_unavailable' }]);
});

test('the drop table is bounded: 64 keys, then one other key; each key logs once', () => {
  const logs = [];
  const scope = createEventScope({ sessionScope: { audience: () => new Set() },
    logger: (level, event, fields) => logs.push(fields) });
  for (let n = 0; n < 70; n += 1) {
    scope(`surprise_${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`, {});
    scope(`surprise_${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`, {});
  }
  const counts = scope.dropCounts();
  assert.equal(Object.keys(counts).length, 65);
  assert.equal(counts.other, 12);
  assert.equal(counts['surprise_aa:event_type_unlisted'], 2);
  assert.equal(logs.length, 65, 'one log per key, and one for other');
  assert.deepEqual(logs.at(-1), { event_type: 'other', reason: 'drop_table_full' });
});

test('the single-owner host stores a session event exactly as before and issues no capture', () => {
  const backend = new EventEmitter();
  const events = new BackendEvents({ backend, bootEpoch: 'boot' });
  assert.equal(events.captureScope('session_1'), undefined);
  events.publish('session_changed', { session_id: 'session_1', state: 'deleted' }, events.captureScope('session_1'));
  backend.emit('chat-stream', { type: 'started', sessionId: 'session_1', streamId: 'stream_1' });
  const [changed, streamed] = events.events.events;
  assert.equal(changed.stream, 'host');
  assert.equal(changed.audience, null);
  assert.equal(streamed.stream, 'stream_1');
  assert.equal(streamed.audience, null);
  assert.deepEqual(events.droppedEvents(), {});
  events.dispose();
});

test('a capture is frozen, bound to its conversation, and changing its visible set widens nothing', () => {
  const h = createUnitHost(createTeamDirectoryFixture(), IN_PROJECT);
  const capture = h.sessionScope.capture('p1_gone');
  assert.equal(Object.isFrozen(capture), true);
  assert.equal(capture.bucket, 'project:project_1');
  capture.audience.add('member_pending');
  assert.deepEqual(h.sessionScope.redeem(capture, 'p1_gone').audience, new Set(['member_owner', 'member_a', 'member_b', 'member_ro']));
  assert.equal(h.sessionScope.redeem(capture, 'p1_other'), null, 'bound to the conversation it was taken for');
  assert.equal(h.sessionScope.redeem({ ...capture }, 'p1_gone'), null, 'a copy is not a capture');
  h.events.dispose();
});

test('a stored audience event under a bucket the predicate does not know is never delivered', () => {
  const fixture = createTeamDirectoryFixture();
  const h = createUnitHost(fixture, () => null);
  const start = h.events.cursor;
  const audience = new Set(['member_a']);
  // The same project-channel message under the chat bucket and under one the predicate does not know.
  h.events.publish('team_chat_message', { channel_id: 'chan_project_1', n: 1 }, { audience, bucket: 'teamchat:chan_project_1' });
  h.events.publish('team_chat_message', { channel_id: 'chan_project_1', n: 2 }, { audience, bucket: 'chat:chan_project_1' });
  assert.deepEqual(dataFrames(h.streams.member_a.response.frames).map((frame) => frame.n), [1], 'live: unknown means denied');
  const identity = h.sessionScope.identity(fixture.actors.member);
  assert.equal(identity.mayReceive('member_a', { type: 'team_chat_message', bucket: 'chat:x' }), false);
  assert.equal(identity.mayReceive('member_a', { type: 'team_chat_message', bucket: 'host' }), false, 'a forgotten bucket');
  assert.equal(identity.mayReceive('member_a', { type: 'team_presence', bucket: 'host' }), true, 'presence stays');
  assert.deepEqual(dataFrames(h.attach(fixture.actors.member, { cursor: start }).frames).map((frame) => frame.n), [1]);
  fixture.setProjectRole('member_a', 'project_1', null); // member_a leaves the project
  assert.deepEqual(dataFrames(h.attach(fixture.actors.member, { cursor: start }).frames), [], 'nothing is replayed');
  // The ephemeral, bucketless presence event still flows.
  h.events.publish('team_presence', { member_id: 'member_b', state: 'online' }, { audience, ephemeral: true });
  assert.equal(dataFrames(h.streams.member_a.response.frames).at(-1).event_type, 'team_presence');
  h.events.dispose();
});
