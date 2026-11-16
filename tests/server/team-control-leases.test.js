'use strict';

// Slice 3-7: the control lease on a team host. The lease names the member who drives
// (`member_id`, team host only), a takeover during a running turn needs the
// `session.takeover_running` row unless it is the holder's own member, and a project member
// change drops that member's leases in the project's conversations. The single-owner host
// keeps its lease exactly as it was.

const assert = require('node:assert/strict');
const test = require('node:test');

const { ControlLeases, projectLeaseRevoker } = require('../../server/control-leases');
const { createAuthorizer } = require('../../server/team/authorize');
const { ACTIONS, RESERVED_ACTIONS, ROUTER_ACTIONS } = require('../../server/team/operation-registry');
const { subscribeProjectChanges } = require('../../server/team/team-project-commands');
const { createFixture, command, createSession } = require('../helpers/command-router-fixture');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');
const { createTeamDirectoryFixture } = require('./helpers/team-directory-fixture');
const { dataFrames } = require('./helpers/session-scope-fixture');
const { randomKey } = require('./helpers/team-host-fixture');
const { startMountedHost } = require('./helpers/team-engine-mount-fixture');

const BOUNDED = Object.freeze({ timeout: 30_000 });
// Every display name, project name and prompt the fixtures use: none may reach a log, failure or event.
const NAMES = ['Olive Owner', 'Alice', 'Bob', 'Carl', 'Rae', 'Pia', 'Apollo', 'Zephyr', 'Laptop', 'Phone', 'secret prompt'];

const controlFrames = (response) => dataFrames(response.frames).filter((frame) => frame.event_type === 'control_changed');

// A running turn whose user message `starter` wrote (slice 3-5's author), or no member author (null).
function startTurn(store, sessionId, starter = null) {
  const now = new Date().toISOString();
  assert.ok(store.appendMessage(sessionId, { id: 'message_turn', role: 'user', content: 'secret prompt',
    ...(starter ? { author: { kind: 'member', member_id: starter } } : {}) }));
  store.setActiveTurn(sessionId, { request_id: 'stream_turn', stream_id: 'stream_turn', user_message_id: 'message_turn',
    started_at: now, last_event_at: now, status: 'awaiting_assistant' });
  assert.ok(store.peekActiveTurn(sessionId), 'the turn is running');
  assert.equal(store.peekSessionMessages(sessionId).at(-1).author?.member_id ?? null, starter);
}

// Project P (Alice admin, Carl and Bob writers, Rae reader), project Q (Bob admin, Carl writer),
// three conversations in P, one in Q and one in General (the owner's).
async function setup(t, options = {}) {
  let leaseClock = Date.now();
  const h = await createTeamProjectFixture(t, { ...options, leaseNow: () => leaseClock });
  const P = await h.sharedProject('Apollo');
  const add = (who, project, member, role) => h.ok(h.send(who, 'team.project.members.add',
    { project_id: project, member_id: h.seats[member].member_id, role }), `add ${member}`);
  await add('alice', P, 'bob', 'writer');
  const Q = (await h.ok(h.send('bob', 'team.project.create', { name: 'Zephyr' }))).project_id;
  await add('bob', Q, 'carl', 'writer');
  const create = async (who, projectId) => (await h.ok(h.send(who, 'sessions.create',
    { title: 'Conversation', ...(projectId ? { project_id: projectId } : {}) }), `${who} create`)).session.session_id;
  const answers = [];
  // Every answer a test reads goes through here, so the redaction check sees it.
  const record = async (promise) => { const answer = await promise; answers.push(answer); return answer; };
  const take = (who, sessionId, takeover = false) => record(h.send(who, 'control.acquire', { takeover }, { session_id: sessionId }));
  const registered = new Map();
  // A command from a seat (a second device, or a context with no actor) rather than a fixture name.
  const sendAs = (seat, operation, params, extra, { actor = { member_id: seat.member_id, device_id: seat.device_id } } = {}) => {
    if (!registered.has(seat.device_id)) registered.set(seat.device_id, h.clients.register(seat.device_id));
    const auth = registered.get(seat.device_id);
    return record(h.core.router.dispatch({ api_version: 1, operation, request_id: `request_${Math.random().toString(36).slice(2)}`,
      client_id: auth.client_id, boot_epoch: h.core.bootEpoch, params, ...extra },
    { deviceId: seat.device_id, clientToken: auth.client_token, isAuthenticated: () => true, ...(actor ? { actor } : {}) }));
  };
  return {
    h, P, Q, answers, take, sendAs, store: h.backend.sessionStore,
    sP: await create('alice', P), sP2: await create('alice', P), sP3: await create('alice', P),
    // A General conversation is seeded in the store: on a team host sessions.create makes none (E70).
    sQ: await create('bob', Q), sG: h.backend.sessionStore.createSession({ title: 'Conversation' }).id,
    member: (who) => h.seats[who].member_id,
    expireLeases: () => { leaseClock += 60_000; },
  };
}

// Random ids (base64url, 12 characters or more) are cut out first: one can contain a short name such as "Bob".
function assertNoNames(text, where) {
  const words = text.replace(/[A-Za-z0-9_-]{12,}/g, ' ');
  for (const name of NAMES) assert.equal(words.includes(name), false, `${where} carries ${name}`);
}

async function secondDevice(h, who) {
  const created = await h.store.createInvite({ kind: 'add_device', actorMemberId: h.seats[who].member_id,
    invitePublicKey: randomKey() });
  assert.equal(created.ok, true, JSON.stringify(created));
  const seat = await h.store.redeem({ inviteId: created.invite_id, devicePublicKey: randomKey(), label: 'Phone' });
  assert.equal(seat.ok, true, JSON.stringify(seat));
  return { member_id: h.seats[who].member_id, device_id: seat.device_id };
}

// ---- The lease record (unit) -------------------------------------------------

test('a lease records the member only when given one, and a re-acquire keeps it', () => {
  const leases = new ControlLeases();
  const team = leases.acquire('session_a', 'client_a', 'device_a', false, 'member_alpha');
  assert.equal(team.member_id, 'member_alpha');
  const again = leases.acquire('session_a', 'client_a', 'device_a', false, 'member_alpha');
  assert.equal(again.generation, team.generation);
  assert.equal(again.member_id, 'member_alpha');
  const single = leases.acquire('session_b', 'client_b', 'device_b');
  assert.deepEqual(Object.keys(single).sort(), ['client_id', 'device_id', 'expires_at', 'generation']);
  assert.equal(Object.hasOwn(leases.heartbeat('session_b', 'client_b', 'device_b', single.generation), 'member_id'), false);
});

test('revokeMember filters by member before asking where a conversation is, and a throwing lookup drops', () => {
  const leases = new ControlLeases();
  leases.acquire('session_a', 'client_a', 'device_a', false, 'member_alpha');
  leases.acquire('session_b', 'client_b', 'device_b', false, 'member_alpha');
  leases.acquire('session_c', 'client_c', 'device_c', false, 'member_beta');
  leases.acquire('session_d', 'client_d', 'device_d');
  const asked = [];
  const dropped = leases.revokeMember('member_alpha', (id) => { asked.push(id); return id === 'session_a'; });
  assert.equal(dropped, 1);
  assert.deepEqual(asked.sort(), ['session_a', 'session_b'], 'only that member\'s leases were looked up');
  assert.equal(leases.get('session_a'), null);
  assert.notEqual(leases.get('session_b'), null);
  assert.equal(leases.revokeMember('member_alpha', () => { throw new Error('index gone'); }), 1, 'a throw drops');
  assert.equal(leases.get('session_b'), null);
  assert.notEqual(leases.get('session_c'), null);
  assert.notEqual(leases.get('session_d'), null);
  for (const bad of ['', null, undefined, 7]) assert.equal(leases.revokeMember(bad, () => true), 0);
  assert.equal(leases.revokeMember('member_beta', 'not a function'), 0);
  assert.notEqual(leases.get('session_c'), null);
});

test('the project revoker drops each named member\'s leases in that project only', () => {
  const leases = new ControlLeases();
  const where = { session_p: 'project_p', session_q: 'project_q', session_g: null };
  leases.acquire('session_p', 'client_1', 'device_1', false, 'member_a');
  leases.acquire('session_q', 'client_2', 'device_2', false, 'member_a');
  leases.acquire('session_g', 'client_3', 'device_3', false, 'member_a');
  const revoke = projectLeaseRevoker({ leases, sessionProject: (id) => where[id] ?? null });
  revoke('project_p', ['member_a', 'member_b', 42]);
  assert.equal(leases.get('session_p'), null);
  assert.notEqual(leases.get('session_q'), null);
  assert.notEqual(leases.get('session_g'), null);
  assert.doesNotThrow(() => revoke('project_p', 'not a list'));
});

// ---- The row -------------------------------------------------------------------

test('session.takeover_running: a project admin, or the active owner on a conversation they can see', () => {
  const row = ACTIONS['session.takeover_running'];
  assert.equal(row.project, 'admin');
  assert.equal(row.resource, 'session');
  assert.equal(row.ownerSeen, true);
  assert.deepEqual(Object.entries(ACTIONS).filter(([, value]) => value.ownerSeen === true).map(([action]) => action),
    ['session.takeover_running']);
  assert.deepEqual(ROUTER_ACTIONS, ['session.takeover_running']);
  assert.equal(RESERVED_ACTIONS.includes('session.takeover_running'), false);
  const fixture = createTeamDirectoryFixture({ projects: { project_x: { members: {} }, project_del: { state: 'deleting' } } });
  const where = { session_x: 'project_x', session_del: 'project_del', session_none: 'project_none' };
  const { authorize } = createAuthorizer({ directory: fixture.directory, sessionProject: (id) => where[id] ?? null });
  const reason = (who, id) => {
    const verdict = authorize(fixture.actors[who], 'session.takeover_running', { kind: 'session', id });
    return verdict.ok ? 'ok' : verdict.error.reason;
  };
  assert.equal(reason('owner', 'session_x'), 'team_not_found', 'the owner has not joined project_x');
  fixture.setProjectRole(fixture.actors.owner.member_id, 'project_x', 'writer');
  assert.equal(reason('owner', 'session_x'), 'ok', 'joined as a writer');
  fixture.setProjectRole(fixture.actors.member.member_id, 'project_x', 'writer');
  assert.equal(reason('member', 'session_x'), 'role_forbidden');
  fixture.setProjectRole(fixture.actors.member.member_id, 'project_x', 'admin');
  assert.equal(reason('member', 'session_x'), 'ok');
  assert.equal(reason('owner', 'session_general'), 'ok', 'General');
  assert.equal(reason('owner', 'session_none'), 'ok', 'a project with no team row');
  assert.equal(reason('owner', 'session_del'), 'team_project_deleting');
  assert.equal(reason('member', 'session_general'), 'team_not_found');
  assert.equal(authorize(null, 'session.takeover_running', { kind: 'session', id: 'session_x' }).ok, false);
  const blind = createAuthorizer({ directory: fixture.directory }).authorize;
  assert.equal(blind(fixture.actors.member, 'session.takeover_running', { kind: 'session', id: 'session_x' }).error.reason,
    'team_not_found', 'no lookup: General, the owner\'s alone');
});

// ---- member_id on the lease and the event --------------------------------------

test('a member\'s lease carries their member_id; control_changed carries it to the project only, live and replayed', BOUNDED, async (t) => {
  const s = await setup(t);
  const live = { alice: s.h.attach('alice'), rae: s.h.attach('rae'), owner: s.h.attach('owner') };
  const cursor = s.h.core.events.cursor;
  const taken = await s.take('carl', s.sP);
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.equal(taken.lease.member_id, s.member('carl'));
  assert.deepEqual(controlFrames(live.alice).map((frame) => frame.member_id), [s.member('carl')]);
  assert.deepEqual(controlFrames(live.rae).map((frame) => frame.member_id), [s.member('carl')], 'a reader sees who drives');
  assert.deepEqual(controlFrames(live.owner), [], 'the owner has not joined');
  assert.deepEqual(controlFrames(s.h.attach('alice', { cursor })).map((frame) => frame.member_id), [s.member('carl')]);
  assert.deepEqual(controlFrames(s.h.attach('owner', { cursor })), []);
  const snapshot = await s.h.ok(s.h.send('alice', 'sessions.snapshot', {}, { session_id: s.sP }));
  assert.equal(snapshot.snapshot.control.member_id, s.member('carl'));
  const beat = await s.h.ok(s.h.send('carl', 'control.heartbeat', {}, { session_id: s.sP, control_generation: taken.lease.generation }));
  assert.equal(beat.lease.member_id, s.member('carl'));
  await s.h.ok(s.h.send('carl', 'control.release', {}, { session_id: s.sP, control_generation: taken.lease.generation }));
  const released = controlFrames(live.alice).at(-1);
  assert.equal(released.state, 'released');
  assert.equal(Object.hasOwn(released, 'member_id'), false, 'the released publish carries no member');
  assertNoNames(JSON.stringify([s.answers, live.alice.frames, s.h.logText()]), 'lease event');
});

test('a team actor without a valid member id is refused a lease and nothing changes', BOUNDED, async (t) => {
  const s = await setup(t);
  const seat = s.h.seats.carl;
  const answer = await s.sendAs(seat, 'control.acquire', { takeover: false }, { session_id: s.sP },
    { actor: { member_id: 'not a member id', device_id: seat.device_id } });
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'member_author_required');
  assert.equal(s.h.leases.get(s.sP), null);
});

// ---- The turn rule ---------------------------------------------------------------

// Carl holds sP and started its running turn.
async function heldDuringTurn(t, options) {
  const s = await setup(t, options);
  const held = await s.take('carl', s.sP);
  assert.equal(held.ok, true, JSON.stringify(held));
  startTurn(s.store, s.sP, s.member('carl'));
  const turn = s.store.peekActiveTurn(s.sP);
  const unchanged = (where) => {
    assert.deepEqual(s.h.leases.get(s.sP), held.lease, `${where}: the holder's lease and generation`);
    assert.deepEqual(s.store.peekActiveTurn(s.sP), turn, `${where}: the turn`);
  };
  return { ...s, held, turn, unchanged };
}

function assertTurnActive(answer, where) {
  assert.equal(answer.ok, false, `${where}: ${JSON.stringify(answer)}`);
  assert.equal(answer.error.code, 'CMP-HOST-0004', where);
  assert.equal(answer.error.reason, 'control_turn_active', where);
  assert.equal(answer.error.retryable, false, where);
}

test('during a running turn a writer\'s takeover is refused control_turn_active and nothing changes', BOUNDED, async (t) => {
  const s = await heldDuringTurn(t);
  assertTurnActive(await s.take('bob', s.sP, true), 'takeover');
  s.unchanged('writer');
  // A plain acquire of a held conversation cannot make the caller the holder: unavailable, retryable, as before.
  const plain = await s.take('bob', s.sP, false);
  assert.equal(plain.error.reason, 'control_lease_unavailable');
  assert.equal(plain.error.retryable, true);
  s.unchanged('plain acquire');
  assertNoNames(JSON.stringify([s.answers, s.h.logText()]), 'turn refusal');
});

// The rule guards the turn, not the lease: however the starter's lease went, a writer cannot take the conversation.
for (const [label, drop] of [
  ['the starter\'s lease expired', (s) => s.expireLeases()],
  ['the starter released', (s) => s.h.ok(s.h.send('carl', 'control.release', {},
    { session_id: s.sP, control_generation: s.held.lease.generation }))],
  ['a revocation dropped the starter\'s lease', (s) => s.h.ok(s.h.send('alice', 'team.project.members.remove',
    { project_id: s.P, member_id: s.member('carl') }))],
]) {
  test(`during a running turn, after ${label}, a writer's plain acquire is refused and so is their cancel`, BOUNDED, async (t) => {
    const s = await heldDuringTurn(t);
    await drop(s);
    assert.equal(s.h.leases.get(s.sP), null);
    assertTurnActive(await s.take('bob', s.sP, false), 'plain acquire');
    assertTurnActive(await s.take('bob', s.sP, true), 'takeover');
    assert.equal(s.h.leases.get(s.sP), null, 'nothing changed');
    const snapshot = await s.h.ok(s.h.send('bob', 'sessions.snapshot', {}, { session_id: s.sP }));
    const cancel = await s.h.send('bob', 'chat.cancel', { stream_id: 'stream_turn' },
      { session_id: s.sP, control_generation: s.held.lease.generation, expected_revision: snapshot.snapshot.session.revision });
    assert.equal(cancel.error.reason, 'control_lease_required', 'the writer holds no lease to cancel with');
    assert.deepEqual(s.store.peekActiveTurn(s.sP), s.turn);
  });
}

test('during a running turn its starter takes control back from another device, also from an admin who took over', BOUNDED, async (t) => {
  const s = await heldDuringTurn(t);
  const phone = await secondDevice(s.h, 'carl');
  const back = await s.sendAs(phone, 'control.acquire', { takeover: true }, { session_id: s.sP });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.lease.device_id, phone.device_id);
  assert.equal(back.lease.member_id, s.member('carl'));
  const admin = await s.h.ok(s.take('alice', s.sP, true), 'admin takes over');
  assert.equal(admin.lease.member_id, s.member('alice'));
  const again = await s.take('carl', s.sP, true);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.lease.member_id, s.member('carl'), 'the starter takes their own turn back from the admin');
  s.expireLeases();
  assert.equal((await s.take('carl', s.sP, false)).ok, true, 'a plain acquire of their own turn once free');
});

test('during a running turn a project admin and the joined owner acquire the free conversation; the admin cancels the turn', BOUNDED, async (t) => {
  const s = await setup(t);
  const holder = await s.h.ok(s.take('carl', s.sP));
  const snapshot = await s.h.ok(s.h.send('carl', 'sessions.snapshot', {}, { session_id: s.sP }));
  const sent = await s.h.ok(s.h.send('carl', 'chat.send', { prompt: 'secret prompt' },
    { session_id: s.sP, control_generation: holder.lease.generation, expected_revision: snapshot.snapshot.session.revision }));
  const streamId = s.store.peekActiveTurn(s.sP).stream_id;
  assert.ok(streamId, JSON.stringify(sent));
  s.expireLeases();
  const admin = await s.take('alice', s.sP, false);
  assert.equal(admin.ok, true, JSON.stringify(admin));
  const revision = (await s.h.ok(s.h.send('alice', 'sessions.snapshot', {}, { session_id: s.sP }))).snapshot.session.revision;
  const cancel = await s.h.send('alice', 'chat.cancel', { stream_id: streamId },
    { session_id: s.sP, control_generation: admin.lease.generation, expected_revision: revision });
  assert.equal(cancel.ok, true, JSON.stringify(cancel));
  assert.equal(cancel.cancelled, true, 'the admin stopped the running turn');
  // The joined owner, as a writer, on another running turn.
  await s.h.ok(s.h.send('owner', 'team.project.join', { project_id: s.P, role: 'writer' }), 'join');
  startTurn(s.store, s.sP2, s.member('carl'));
  const owner = await s.take('owner', s.sP2, false);
  assert.equal(owner.ok, true, JSON.stringify(owner));
  assert.equal(owner.lease.member_id, s.member('owner'));
});

test('a running turn with no member author exempts nobody; a turn lookup that throws refuses', BOUNDED, async (t) => {
  const s = await setup(t);
  startTurn(s.store, s.sP2, null);
  assertTurnActive(await s.take('carl', s.sP2, false), 'no author');
  assert.equal((await s.take('alice', s.sP2, false)).ok, true, 'the stronger row still passes');
  s.store.peekActiveTurn = () => { throw new Error('index gone'); };
  assertTurnActive(await s.take('bob', s.sP3, false), 'a throwing lookup is a running turn');
  assert.equal(s.h.leases.get(s.sP3), null);
});

test('during a running turn a project admin takes over', BOUNDED, async (t) => {
  const s = await heldDuringTurn(t);
  const answer = await s.take('alice', s.sP, true);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.lease.member_id, s.member('alice'));
  assert.ok(answer.lease.generation > s.held.lease.generation);
});

test('during a running turn the owner takes over in a project they joined, even as a writer', BOUNDED, async (t) => {
  const s = await heldDuringTurn(t);
  const outside = await s.take('owner', s.sP, true);
  assert.equal(outside.ok, false);
  assert.equal(outside.error.reason, 'team_not_found', 'not joined: it reads as not existing');
  const nowhere = await s.take('alice', 'session_nowhere', true);
  assert.equal(nowhere.error.reason, outside.error.reason, 'the answer a member gets for a conversation that does not exist');
  s.unchanged('owner outside');
  await s.h.ok(s.h.send('owner', 'team.project.join', { project_id: s.P, role: 'writer' }), 'join');
  s.unchanged('owner joined');
  const answer = await s.take('owner', s.sP, true);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.lease.member_id, s.member('owner'));
});

test('during a running turn the owner takes over in General', BOUNDED, async (t) => {
  const s = await setup(t);
  // General is the owner's alone; a lease another member holds there is planted (one left from before a role change).
  const planted = s.h.leases.acquire(s.sG, 'client_planted', 'device_planted', false, s.member('alice'));
  startTurn(s.store, s.sG, s.member('alice'));
  const answer = await s.take('owner', s.sG, true);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.lease.member_id, s.member('owner'));
  assert.ok(answer.lease.generation > planted.generation);
});

test('during a running turn a reader, a pending member, a removed member and a missing actor get today\'s answer', BOUNDED, async (t) => {
  const s = await heldDuringTurn(t);
  const reader = await s.take('rae', s.sP, true);
  assert.equal(reader.error.reason, 'role_forbidden', 'a team read-only member has no takeover column');
  s.unchanged('reader');
  const pending = await s.take('pia', s.sP, true);
  assert.equal(pending.error.reason, 'member_pending');
  s.unchanged('pending');
  const missing = await s.sendAs(s.h.seats.bob, 'control.acquire', { takeover: true }, { session_id: s.sP }, { actor: null });
  assert.equal(missing.error.reason, 'role_forbidden');
  s.unchanged('missing actor');
  // Bob leaves P (removed by Alice) and stays an admin of Q: a member of another project.
  await s.h.ok(s.h.send('alice', 'team.project.members.remove', { project_id: s.P, member_id: s.member('bob') }));
  const removed = await s.take('bob', s.sP, true);
  assert.equal(removed.error.reason, 'team_not_found');
  s.unchanged('removed, and a member of another project');
});

test('with no running turn a writer takes over as today, and a takeover of a free conversation is an acquire', BOUNDED, async (t) => {
  const s = await setup(t);
  await s.h.ok(s.take('carl', s.sP));
  const answer = await s.take('bob', s.sP, true);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.lease.member_id, s.member('bob'));
  const free = await s.take('bob', s.sP2, true);
  assert.equal(free.ok, true, JSON.stringify(free));
  assert.equal(free.lease.member_id, s.member('bob'));
});

test('a forged conversation id from another project, with or without takeover, answers as today and changes nothing', BOUNDED, async (t) => {
  const s = await setup(t);
  const held = await s.h.ok(s.take('bob', s.sQ));
  startTurn(s.store, s.sQ, s.member('bob'));
  for (const takeover of [true, false]) {
    const answer = await s.take('alice', s.sQ, takeover);
    assert.equal(answer.error.reason, 'team_not_found', `takeover=${takeover}`);
    assert.deepEqual(s.h.leases.get(s.sQ), held.lease);
  }
});

// ---- Revocation on a project change ---------------------------------------------

// What refuses the holder afterwards: a re-roled holder still passes the identity check, so the missing lease
// answers; a removed one, or one in a deleting project, is refused by the identity check first.
for (const [label, change, aliceKeeps, refusal] of [
  ['a re-role (upward)', (s) => s.h.ok(s.h.send('alice', 'team.project.members.setRole',
    { project_id: s.P, member_id: s.member('carl'), role: 'admin' })), true, 'control_lease_required'],
  ['a removal', (s) => s.h.ok(s.h.send('alice', 'team.project.members.remove',
    { project_id: s.P, member_id: s.member('carl') })), true, 'team_not_found'],
  ['the project going to deleting', async (s) => assert.equal((await s.h.store.markProjectDeleting(
    { actorMemberId: s.member('alice'), projectId: s.P })).ok, true), false, 'team_not_found'],
]) {
  test(`${label} drops that member's leases in that project's conversations only`, BOUNDED, async (t) => {
    const s = await setup(t, { projectsRoot: true });
    const carlP = await s.h.ok(s.take('carl', s.sP));
    await s.h.ok(s.take('carl', s.sP2));
    const carlQ = await s.h.ok(s.take('carl', s.sQ));
    const alice = await s.h.ok(s.take('alice', s.sP3));
    const carlGeneral = s.h.leases.acquire(s.sG, 'client_planted', 'device_planted', false, s.member('carl'));
    const revision = (await s.h.ok(s.h.send('carl', 'sessions.snapshot', {}, { session_id: s.sP }))).snapshot.session.revision;
    const live = s.h.attach('alice');
    const cursor = s.h.core.events.cursor;
    await change(s);
    assert.equal(s.h.leases.get(s.sP), null);
    assert.equal(s.h.leases.get(s.sP2), null);
    assert.deepEqual(s.h.leases.get(s.sQ), carlQ.lease, 'another project');
    assert.deepEqual(s.h.leases.get(s.sG), carlGeneral, 'General');
    assert.deepEqual(s.h.leases.get(s.sP3), aliceKeeps ? alice.lease : null, 'another member in the same project');
    const beat = await s.h.send('carl', 'control.heartbeat', {}, { session_id: s.sP, control_generation: carlP.lease.generation });
    assert.equal(beat.error.reason, refusal);
    const write = await s.h.send('carl', 'sessions.rename', { title: 'Renamed' },
      { session_id: s.sP, control_generation: carlP.lease.generation, expected_revision: revision });
    assert.equal(write.error?.reason, refusal, JSON.stringify(write));
    // Silent, like revokeDevice: nothing published for the revocation.
    assert.deepEqual(s.h.core.events.events.events.slice(cursor).filter((entry) => entry.type === 'control_changed'), []);
    assertNoNames(JSON.stringify([s.answers, beat, write, s.h.logText(), controlFrames(live)]), label);
    assert.equal(JSON.stringify([s.answers, beat, write, s.h.logText(), live.frames]).includes(s.h.roots.projectsRoot), false);
  });
}

test('a removal during the turn the member drives drops the lease; the removed member is refused by identity, not the lease', BOUNDED, async (t) => {
  const s = await heldDuringTurn(t);
  await s.h.ok(s.h.send('alice', 'team.project.members.remove', { project_id: s.P, member_id: s.member('carl') }));
  assert.equal(s.h.leases.get(s.sP), null);
  const cancel = await s.h.send('carl', 'chat.cancel', { stream_id: 'stream_turn' },
    { session_id: s.sP, control_generation: s.held.lease.generation, expected_revision: 'any' });
  assert.equal(cancel.error.reason, 'team_not_found');
});

test('the byte search: the refused and revoked paths carry no name, prompt or path', BOUNDED, async (t) => {
  const s = await setup(t, { projectsRoot: true });
  const live = { alice: s.h.attach('alice'), bob: s.h.attach('bob') };
  const holder = await s.h.ok(s.take('carl', s.sP));
  const revision = (await s.h.ok(s.h.send('carl', 'sessions.snapshot', {}, { session_id: s.sP }))).snapshot.session.revision;
  await s.h.ok(s.h.send('carl', 'chat.send', { prompt: 'secret prompt' },
    { session_id: s.sP, control_generation: holder.lease.generation, expected_revision: revision }));
  assertTurnActive(await s.take('bob', s.sP, true), 'refused');
  await s.h.ok(s.h.send('alice', 'team.project.members.remove', { project_id: s.P, member_id: s.member('carl') }));
  assertTurnActive(await s.take('bob', s.sP, false), 'refused after the revocation');
  const bytes = JSON.stringify([s.answers, s.h.logText(), controlFrames(live.alice), controlFrames(live.bob)]);
  assertNoNames(bytes, 'refused and revoked paths');
  assert.equal(bytes.includes(s.h.roots.projectsRoot), false, 'a project path');
  assert.ok(s.h.roots.projectsRoot.length > 3);
});

test('a revocation callback that throws never reaches the store, and the announce still happens', () => {
  const calls = { announce: 0, revoke: 0 };
  const logs = [];
  let listener = null;
  const store = { onProjectChange(fn) { listener = fn; return () => {}; } };
  subscribeProjectChanges({ store, announce: () => { calls.announce += 1; }, logger: { log: (...args) => logs.push(args) },
    revokeLeases: () => { calls.revoke += 1; throw new Error('Carl in Apollo'); } });
  for (const reason of ['members', 'deleting', 'deleted']) {
    assert.doesNotThrow(() => listener({ project_id: 'project_x', reason, member_ids: ['member_a'] }));
  }
  listener({ project_id: 'project_x', reason: 'renamed', member_ids: ['member_a'] });
  assert.deepEqual(calls, { announce: 4, revoke: 3 });
  assertNoNames(JSON.stringify(logs), 'revoke failure log');
});

// ---- team-main.js wiring -------------------------------------------------------

test('the team host wires the revocation: a project removal drops the removed member\'s control lease', BOUNDED, async (t) => {
  const m = await startMountedHost(t);
  const { member, second } = await m.seed();
  const router = m.context.router;
  const registered = new Map();
  const send = (seat, operation, params = {}, extra = {}) => {
    if (!registered.has(seat.device_id)) registered.set(seat.device_id, m.context.clients.register(seat.device_id));
    const auth = registered.get(seat.device_id);
    return router.dispatch({ api_version: 1, operation, request_id: `request_${Math.random().toString(36).slice(2)}`,
      client_id: auth.client_id, boot_epoch: m.context.bootEpoch, params, ...extra },
    { deviceId: seat.device_id, clientToken: auth.client_token, isAuthenticated: () => true,
      actor: { member_id: seat.member_id, device_id: seat.device_id } });
  };
  const must = async (promise) => { const answer = await promise; assert.equal(answer.ok, true, JSON.stringify(answer)); return answer; };
  const projectId = (await must(send(member, 'team.project.create', { name: 'Wired' }))).project_id;
  await must(send(member, 'team.project.members.add', { project_id: projectId, member_id: second.member_id, role: 'writer' }));
  const sessionId = (await must(send(member, 'sessions.create', { title: 'Wired', project_id: projectId }))).session.session_id;
  const lease = (await must(send(second, 'control.acquire', { takeover: false }, { session_id: sessionId }))).lease;
  assert.equal(lease.member_id, second.member_id);
  await must(send(member, 'team.project.members.remove', { project_id: projectId, member_id: second.member_id }));
  assert.equal(m.context.leases.get(sessionId), null);
  assert.equal(m.context.directory.isDegraded(), false);
});

// ---- The single-owner host -------------------------------------------------------

test('single-owner: a lease has no member_id key, the event none, and a takeover during a turn still succeeds', async (t) => {
  const f = createFixture();
  t.after(() => f.close());
  const sessionId = await createSession(f);
  const lease = await f.router.dispatch(command(f.a, 'control.acquire', { takeover: false }, { session_id: sessionId }), f.contextA);
  assert.equal(lease.ok, true);
  assert.deepEqual(Object.keys(lease.lease).sort(), ['client_id', 'device_id', 'expires_at', 'generation']);
  const event = f.eventStream.events.filter((entry) => entry.type === 'control_changed').at(-1);
  assert.equal(Object.hasOwn(event.payload, 'member_id'), false);
  startTurn(f.backend.sessionStore, sessionId);
  const taken = await f.router.dispatch(command(f.b, 'control.acquire', { takeover: true }, { session_id: sessionId }), f.contextB);
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.equal(Object.hasOwn(taken.lease, 'member_id'), false);
  assert.equal(Object.hasOwn(f.router.snapshot(sessionId).control, 'member_id'), false);
});
