'use strict';

// Slice 3-3 (docs/plans/TEAM_PROJECTS_SPEC.md "Events", P7): on a team host every
// session-scoped event carries `bucket: 'session:<id>'` and the audience of the
// members who may read that conversation; the stream predicate re-checks the
// conversation on every delivery and on replay. The single-owner host is unchanged.
// Seats: the owner (not in P), Alice (P's admin), Bob (in no project), Rae
// (read-only, reader in P) and Carl (writer in P).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

// The command router's `publish` wrapper, as the services/host dispatchers receive it.
// Patched before the router loads (through the fixtures below); this file runs in its own process.
const suggested = require('../../services/host/suggested-changes-commands');
let dispatcherPublish = null;
const originalSuggested = suggested.createSuggestedChangesCommandDispatcher;
suggested.createSuggestedChangesCommandDispatcher = (options) => {
  dispatcherPublish = options.result.publish;
  return originalSuggested(options);
};

const { MemberStore } = require('../../server/team/member-store');
const { Response, dataFrames } = require('./helpers/session-scope-fixture');
const { TEAM_NAME, createTeamHostFixture, randomKey } = require('./helpers/team-host-fixture');
const { createTeamHttpFixture, waitUntil } = require('./helpers/team-http-fixture');
const { LOCAL_COMMAND } = require('../../server/team/member-schema');

const PROJECT = 'project_shared_p';
const SESSION_TYPES = ['session_changed', 'chat_stream', 'decision_changed'];

// [event_type, session_id] for every session-carrying frame a stream received.
const sessionFrames = (frames) => dataFrames(frames).filter((frame) => typeof frame.session_id === 'string')
  .map((frame) => [frame.event_type, frame.session_id]);

async function seedTeam(fx) {
  const store = new MemberStore({ userDataPath: fx.profile, hostPublicKey: fx.hostPublicKey, teamName: TEAM_NAME });
  const must = (value, what) => { if (!value.ok) throw new Error(`${what} failed: ${value.error.reason}`); return value; };
  const join = async (kind, name, { actor = LOCAL_COMMAND, role = 'member' } = {}) => {
    const created = must(await store.createInvite({ kind, actorMemberId: actor,
      ...(kind === 'new_member' ? { role } : {}), invitePublicKey: randomKey() }), 'invite');
    const seat = must(await store.redeem({ inviteId: created.invite_id, devicePublicKey: randomKey(),
      displayName: name, label: 'Laptop' }), 'redeem');
    if (kind === 'new_member') must(await store.admit({ actorMemberId: actor, memberId: seat.member_id }), 'admit');
    return seat;
  };
  const owner = await join('owner_first', 'Olive Owner');
  const alice = await join('new_member', 'Alice', { actor: owner.member_id });
  const bob = await join('new_member', 'Bob', { actor: owner.member_id });
  const rae = await join('new_member', 'Rae', { actor: owner.member_id, role: 'read_only' });
  const carl = await join('new_member', 'Carl', { actor: owner.member_id });
  must(await store.createProject({ actorMemberId: alice.member_id, projectId: PROJECT }), 'project');
  for (const [seat, role] of [[rae, 'reader'], [carl, 'writer']]) {
    must(await store.addProjectMember({ actorMemberId: alice.member_id, projectId: PROJECT,
      memberId: seat.member_id, role }), 'project member');
  }
  return { owner, alice, bob, rae, carl };
}

async function teamHost(t) {
  const fx = createTeamHostFixture(t);
  const seats = await seedTeam(fx);
  await fx.start();
  const context = fx.context();
  const backend = fx.backends[0].backend;
  const inProject = backend.sessionStore.createSession({ title: 'Secret plan title' }).id;
  assert.ok(backend.sessionStore.updateSession(inProject, { project_id: PROJECT }));
  const inGeneral = backend.sessionStore.createSession({ title: 'General title' }).id;
  const actor = (who) => ({ member_id: seats[who].member_id, device_id: seats[who].device_id });
  // A member stream; the default cursor is the stream's current one (a client that just took a snapshot).
  const attach = (who, { cursor = context.events.cursor, identity = context.sessionScope.identity(actor(who)) } = {}) => {
    const response = new Response();
    context.events.subscribe({ response, deviceId: seats[who].device_id, authorized: () => true,
      bootEpoch: context.bootEpoch, cursor, identity });
    return response;
  };
  const clients = {};
  const send = (who, operation, params = {}, extra = {}) => {
    clients[who] ??= context.clients.register(seats[who].device_id);
    return context.router.dispatch({ api_version: 1, operation, request_id: `request_${crypto.randomUUID()}`,
      client_id: clients[who].client_id, boot_epoch: context.bootEpoch, params, ...extra },
    { deviceId: seats[who].device_id, clientToken: clients[who].client_token, isAuthenticated: () => true,
      actor: actor(who) });
  };
  // One event of each session-scoped kind for a conversation, through the three backend paths.
  let streamCount = 0;
  const publishAll = (sessionId) => {
    context.events.publish('session_changed', { session_id: sessionId, revision: 'r1', reason: 'renamed' });
    streamCount += 1;
    const streamId = `stream_${streamCount}`;
    backend.emit('chat-stream', { type: 'started', sessionId, streamId });
    backend.emit('chat-stream', { type: 'tool_approval_withdrawn', sessionId, streamId, approvalId: 'approval_1' });
  };
  const stored = () => context.events.events.events;
  const memberIds = (...who) => new Set(who.map((name) => seats[name].member_id));
  const storeMust = async (promise) => { const value = await promise; assert.equal(value.ok, true, JSON.stringify(value)); };
  // Takes the control lease and deletes the conversation through the router, as `who`.
  const remove = async (who, sessionId) => {
    const lease = await send(who, 'control.acquire', { takeover: false }, { session_id: sessionId });
    assert.equal(lease.ok, true, JSON.stringify(lease));
    const answer = await send(who, 'sessions.delete', {}, { session_id: sessionId,
      control_generation: lease.lease.generation, expected_revision: context.router.snapshot(sessionId).session.revision });
    assert.equal(answer.ok, true, JSON.stringify(answer));
  };
  return { fx, context, backend, seats, attach, send, remove, publishAll, stored, memberIds, storeMust, inProject, inGeneral };
}

const expectedFor = (sessionId) => SESSION_TYPES.map((type) => [type, sessionId]);

test('a member with a role in P receives its session events; a member outside P receives none, live or replayed', async (t) => {
  const h = await teamHost(t);
  const live = { alice: h.attach('alice'), rae: h.attach('rae'), carl: h.attach('carl'), bob: h.attach('bob') };
  h.publishAll(h.inProject);
  for (const who of ['alice', 'rae', 'carl']) assert.deepEqual(sessionFrames(live[who].frames), expectedFor(h.inProject), who);
  assert.deepEqual(sessionFrames(live.bob.frames), [], 'bob, live');
  assert.deepEqual(sessionFrames(h.attach('bob', { cursor: 0 }).frames), [], 'bob, replay from 0');
  assert.deepEqual(sessionFrames(h.attach('alice', { cursor: 0 }).frames), expectedFor(h.inProject), 'alice, replay');
  assert.doesNotMatch(JSON.stringify(h.fx.logs), /Secret plan title|Alice|Carl/);
});

test('the owner, not in P, receives nothing for P and receives General', async (t) => {
  const h = await teamHost(t);
  const owner = h.attach('owner');
  const alice = h.attach('alice');
  h.publishAll(h.inProject);
  h.publishAll(h.inGeneral);
  assert.deepEqual(sessionFrames(owner.frames), expectedFor(h.inGeneral));
  assert.deepEqual(sessionFrames(h.attach('owner', { cursor: 0 }).frames), expectedFor(h.inGeneral), 'replay');
  assert.deepEqual(sessionFrames(alice.frames), expectedFor(h.inProject), 'General is not a member conversation');
});

test('a member removed from P stops receiving at once, including events already stored', async (t) => {
  const h = await teamHost(t);
  const carl = h.attach('carl');
  h.publishAll(h.inProject);
  assert.equal(sessionFrames(carl.frames).length, 3);
  await h.storeMust(h.context.store.removeProjectMember({ actorMemberId: h.seats.alice.member_id, projectId: PROJECT,
    memberId: h.seats.carl.member_id }));
  h.publishAll(h.inProject);
  assert.equal(sessionFrames(carl.frames).length, 3, 'nothing delivered after the removal');
  assert.deepEqual(sessionFrames(h.attach('carl', { cursor: 0 }).frames), [], 'stored events are not replayed');
});

test('a revoked member receives nothing more, live or replayed', async (t) => {
  const h = await teamHost(t);
  const identity = h.context.sessionScope.identity({ member_id: h.seats.rae.member_id, device_id: h.seats.rae.device_id });
  const rae = h.attach('rae', { identity });
  h.publishAll(h.inProject);
  assert.equal(sessionFrames(rae.frames).length, 3);
  await h.storeMust(h.context.store.revokeMember({ actorMemberId: h.seats.owner.member_id, memberId: h.seats.rae.member_id }));
  h.publishAll(h.inProject);
  assert.equal(sessionFrames(rae.frames).length, 3);
  // The identity captured before the revoke, replayed from 0: the predicate re-reads the directory.
  assert.deepEqual(sessionFrames(h.attach('rae', { cursor: 0, identity }).frames), []);
});

test('a member added to P later does not get events published before they joined', async (t) => {
  const h = await teamHost(t);
  h.publishAll(h.inProject);
  await h.storeMust(h.context.store.addProjectMember({ actorMemberId: h.seats.alice.member_id, projectId: PROJECT,
    memberId: h.seats.bob.member_id, role: 'writer' }));
  const bob = h.attach('bob', { cursor: 0 });
  assert.deepEqual(sessionFrames(bob.frames), [], 'stored audience excludes a later member');
  h.publishAll(h.inProject);
  assert.deepEqual(sessionFrames(bob.frames), expectedFor(h.inProject), 'events after joining arrive');
});

test('every publish site stores the session bucket and the project audience', async (t) => {
  const h = await teamHost(t);
  const last = () => h.stored()[h.stored().length - 1];
  const check = (type, sessionId, audience, what) => {
    const entry = last();
    assert.equal(entry.type, type, what);
    assert.equal(entry.stream, `session:${sessionId}`, what);
    assert.deepEqual(entry.audience, audience, what);
  };
  const inP = h.memberIds('alice', 'rae', 'carl');
  // A router command.
  const acquired = await h.send('alice', 'control.acquire', { takeover: false }, { session_id: h.inProject });
  assert.equal(acquired.ok, true, JSON.stringify(acquired));
  check('control_changed', h.inProject, inP, 'router command');
  // A services/host dispatcher's publish (the wrapper every dispatcher is handed).
  assert.equal(typeof dispatcherPublish, 'function');
  dispatcherPublish('session_changed', { session_id: h.inGeneral, revision: 'r2', reason: 'suggested_changes' });
  check('session_changed', h.inGeneral, h.memberIds('owner'), 'dispatcher publish');
  // The backend's chat stream and its decision withdrawal.
  h.backend.emit('chat-stream', { type: 'started', sessionId: h.inProject, streamId: 'stream_site' });
  check('chat_stream', h.inProject, inP, 'chat_stream');
  h.backend.emit('chat-stream', { type: 'user_questions_withdrawn', sessionId: h.inProject, streamId: 'stream_site',
    questionRef: 'question_1' });
  check('decision_changed', h.inProject, inP, 'decision withdrawal');
});

test('fail closed on the team host: no session id, an unlisted type, own options or a missing audience drop the event', async (t) => {
  const h = await teamHost(t);
  const streams = ['owner', 'alice', 'bob', 'rae', 'carl'].map((who) => h.attach(who));
  const before = h.context.events.cursor;
  h.context.events.publish('session_changed', { revision: 'r1', reason: 'renamed' });
  h.context.events.publish('surprise_event', { session_id: h.inGeneral });
  h.context.events.publish('session_changed', { session_id: h.inGeneral }, { bucket: 'host' });
  h.context.events.publish('team_chat_message', { channel_id: 'chan_team', session_id: h.inGeneral });
  h.context.events.publish('chat_stream', { session_id: 'a:b', stream_id: 'stream_x', event: { type: 'started' } });
  assert.equal(h.context.events.cursor, before, 'nothing was stored');
  for (const response of streams) assert.deepEqual(dataFrames(response.frames), []);
  const dropped = h.fx.logs.filter((entry) => entry.event === 'team.event.dropped').map((entry) => entry.fields);
  assert.deepEqual(dropped.map((fields) => fields.event_type),
    ['session_changed', 'surprise_event', 'session_changed', 'team_chat_message', 'chat_stream']);
  for (const fields of dropped) assert.deepEqual(Object.keys(fields).sort(), ['event_type', 'reason']);
});

test('chat events keep the audience their publisher gave them', async (t) => {
  const h = await teamHost(t);
  const audience = h.memberIds('bob');
  h.context.events.publish('team_chat_message', { channel_id: 'chan_team' }, { audience, bucket: 'teamchat:chan_team' });
  const entry = h.stored()[h.stored().length - 1];
  assert.equal(entry.stream, 'teamchat:chan_team');
  assert.deepEqual(entry.audience, audience);
});

// The real team HTTP layer: openEvents hands the stream the host's session scope.
test('through the team HTTP layer, a member stream gets its project conversation and not another', async (t) => {
  const env = await createTeamHttpFixture(t);
  const seeded = await env.seed();
  const created = await env.store.createProject({ actorMemberId: seeded.member.member_id, projectId: PROJECT });
  assert.equal(created.ok, true, JSON.stringify(created));
  const sessionStore = env.fx.backends[0].backend.sessionStore;
  const inProject = sessionStore.createSession({ title: 'In P' }).id;
  assert.ok(sessionStore.updateSession(inProject, { project_id: PROJECT }));
  const open = async (key) => {
    const client = env.client(key);
    assert.equal((await client.hello()).status, 200);
    const auth = await client.registerClient();
    const stream = await client.openStream(auth);
    assert.equal(stream.status, 200);
    return stream;
  };
  const member = await open(seeded.member.key);
  const reader = await open(seeded.readOnly.key);
  env.core.events.publish('session_changed', { session_id: inProject, revision: 'r1', reason: 'renamed' });
  assert.ok(await waitUntil(() => sessionFrames(member.frames).length === 1), 'the member in P receives it');
  assert.deepEqual(sessionFrames(member.frames), [['session_changed', inProject]]);
  assert.deepEqual(sessionFrames(reader.frames), [], 'a member outside P does not');
});

// Slice 3-3 review item 1: a deleted conversation's event goes to the project it was in.
const deletedFrames = (response) => dataFrames(response.frames).filter((frame) => frame.state === 'deleted')
  .map((frame) => frame.session_id);

// The capture is taken before the conversation leaves the index, as deleteSession does. Through the
// router a member's delete of a project conversation answers operation_indeterminate today (its
// post-await identity check re-reads the deleted conversation as General; "3-3 as built", known limits),
// so this case drives the capture and the delete directly; the General case below goes through the router.
test('a deleted project conversation reaches the other members of P, live and replayed, and nobody else', async (t) => {
  const h = await teamHost(t);
  const live = Object.fromEntries(['owner', 'bob', 'rae', 'carl'].map((who) => [who, h.attach(who)]));
  const capture = h.context.events.captureScope(h.inProject);
  assert.equal((await h.backend.deleteSession(h.inProject)).deleted, true);
  h.context.events.publish('session_changed', { session_id: h.inProject, state: 'deleted' }, capture);
  for (const who of ['rae', 'carl']) assert.deepEqual(deletedFrames(live[who]), [h.inProject], `${who} live`);
  for (const who of ['owner', 'bob']) assert.deepEqual(deletedFrames(live[who]), [], `${who} live`);
  const entry = h.stored().at(-1);
  assert.equal(entry.stream, `project:${PROJECT}`);
  assert.deepEqual(entry.audience, h.memberIds('alice', 'rae', 'carl'));
  assert.deepEqual(deletedFrames(h.attach('carl', { cursor: 0 })), [h.inProject], 'carl replay');
  assert.deepEqual(deletedFrames(h.attach('bob', { cursor: 0 })), [], 'bob replay');
  assert.deepEqual(deletedFrames(h.attach('owner', { cursor: 0 })), [], 'owner replay');
  // Removed from P after the delete: the stored event is not replayed to them.
  await h.storeMust(h.context.store.removeProjectMember({ actorMemberId: h.seats.alice.member_id, projectId: PROJECT,
    memberId: h.seats.carl.member_id }));
  assert.deepEqual(deletedFrames(h.attach('carl', { cursor: 0 })), [], 'carl replay after removal');
});

test('a deleted General conversation reaches the owner alone', async (t) => {
  const h = await teamHost(t);
  const owner = h.attach('owner');
  const alice = h.attach('alice');
  await h.remove('owner', h.inGeneral);
  assert.deepEqual(deletedFrames(owner), [h.inGeneral]);
  assert.deepEqual(deletedFrames(alice), []);
  // deleteSession captured the scope before the delete: the project bucket, not the session one.
  assert.equal(h.stored().at(-1).stream, 'project:project_general');
  assert.deepEqual(h.stored().at(-1).audience, h.memberIds('owner'));
});

test('session options the scope did not issue are dropped, as is a capture for another conversation', async (t) => {
  const h = await teamHost(t);
  const bob = h.attach('bob');
  const before = h.context.events.cursor;
  h.context.events.publish('session_changed', { session_id: h.inProject, state: 'deleted' },
    { audience: h.memberIds('bob'), bucket: `project:${PROJECT}` });
  h.context.events.publish('session_changed', { session_id: h.inProject, state: 'deleted' },
    Object.freeze({ audience: h.memberIds('bob'), bucket: `project:${PROJECT}` }));
  const otherCapture = h.context.events.captureScope(h.inGeneral);
  h.context.events.publish('session_changed', { session_id: h.inProject, state: 'deleted' }, otherCapture);
  assert.equal(h.context.events.cursor, before, 'nothing was stored');
  assert.deepEqual(dataFrames(bob.frames), []);
});
