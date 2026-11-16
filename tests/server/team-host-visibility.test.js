'use strict';

// Slice 3-2 wiring: an in-process team host built by startTeamHost resolves a
// conversation's project from its own session store, so the one authorization
// function sees project membership. Seats: the owner (not in P), Alice (P's
// admin, who created it), Bob (in no project), Rae (read-only, reader in P) and
// Carl (writer in P, revoked mid-test). One conversation sits in P, one in General.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { MemberStore } = require('../../server/team/member-store');
const { createRouteGuard } = require('../../server/team/route-guard');
const { TEAM_NAME, createTeamHostFixture, randomKey } = require('./helpers/team-host-fixture');
const { LOCAL_COMMAND } = require('../../server/team/member-schema');

const PROJECT = 'project_shared_p';

// The team written before the host starts, through the member store the host then opens.
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
  // Through the host's own session store: one conversation in P, one left in General.
  const sessionStore = fx.backends[0].backend.sessionStore;
  const inProject = sessionStore.createSession({ title: 'In P' }).id;
  assert.ok(sessionStore.updateSession(inProject, { project_id: PROJECT }));
  const inGeneral = sessionStore.createSession({ title: 'In General' }).id;
  const clients = {};
  const send = (who, operation, params = {}, extra = {}) => {
    const seat = seats[who];
    clients[who] ??= context.clients.register(seat.device_id);
    const actor = { member_id: seat.member_id, device_id: seat.device_id };
    const requestId = `request_${crypto.randomUUID()}`;
    return context.router.dispatch({ api_version: 1, operation, request_id: requestId,
      client_id: clients[who].client_id, boot_epoch: context.bootEpoch, params, ...extra },
    { deviceId: seat.device_id, clientToken: clients[who].client_token, isAuthenticated: () => true, actor,
      guard: createRouteGuard({ authorize: context.authorize, actor, requestId }) });
  };
  // One raw GET as the team HTTP layer hands it to the host's route chain: { handled, status, json }.
  const get = async (who, pathname) => {
    const actor = { member_id: seats[who].member_id, device_id: seats[who].device_id };
    const sent = { status: null, chunks: [] };
    const response = { headersSent: false, setHeader() {}, once() {}, destroy() {},
      writeHead(status) { sent.status = status; response.headersSent = true; },
      end(chunk) { if (chunk) sent.chunks.push(Buffer.from(chunk)); } };
    const handled = await context.assetRoutes({ request: { method: 'GET', headers: {}, resume() {} }, response, pathname,
      deviceId: actor.device_id, requestId: 'request_get', actor, authorized: () => true,
      guard: createRouteGuard({ authorize: context.authorize, actor, requestId: 'request_get' }) });
    return { handled, status: sent.status, json: JSON.parse(Buffer.concat(sent.chunks).toString('utf8') || 'null') };
  };
  const forget = (who) => { delete clients[who]; };
  return { fx, context, seats, send, get, forget, inProject, inGeneral };
}

const reason = (answer) => (answer.ok ? 'ok' : answer.error.reason);
const withoutRequestId = (answer) => ({ ...answer, error: { ...answer.error, request_id: '' } });
const listed = async (h, who) => {
  const answer = await h.send(who, 'sessions.list');
  assert.equal(answer.ok, true, `${who}: ${JSON.stringify(answer)}`);
  return answer.sessions.map((row) => row.session_id);
};

test('a member with a role in P reads its conversation, and the list shows it and not General', async (t) => {
  const h = await teamHost(t);
  assert.equal(reason(await h.send('alice', 'sessions.snapshot', {}, { session_id: h.inProject })), 'ok');
  const rows = await listed(h, 'alice');
  assert.equal(rows.includes(h.inProject), true);
  assert.equal(rows.includes(h.inGeneral), false);
});

test('a member with no role in P is refused its conversation exactly like a missing one', async (t) => {
  const h = await teamHost(t);
  const hidden = await h.send('bob', 'sessions.snapshot', {}, { session_id: h.inProject });
  const missing = await h.send('bob', 'sessions.snapshot', {}, { session_id: 'session_does_not_exist' });
  assert.equal(reason(hidden), 'team_not_found');
  assert.deepEqual(withoutRequestId(hidden), withoutRequestId(missing));
  assert.deepEqual(await listed(h, 'bob'), []);
});

test('the owner, not in P, is refused its conversation and still reads General (E23)', async (t) => {
  const h = await teamHost(t);
  assert.equal(reason(await h.send('owner', 'sessions.snapshot', {}, { session_id: h.inProject })), 'team_not_found');
  assert.equal(reason(await h.send('owner', 'sessions.snapshot', {}, { session_id: h.inGeneral })), 'ok');
  assert.deepEqual(await listed(h, 'owner'), [h.inGeneral]);
});

test('a read-only member in P reads its conversation and is refused a write', async (t) => {
  const h = await teamHost(t);
  assert.equal(reason(await h.send('rae', 'sessions.snapshot', {}, { session_id: h.inProject })), 'ok');
  const write = await h.send('rae', 'sessions.rename', { title: 'Mine' }, { session_id: h.inProject,
    control_generation: 1, expected_revision: h.context.router.snapshot(h.inProject).session.revision });
  assert.equal(reason(write), 'role_forbidden');
  assert.equal(reason(await h.send('rae', 'control.acquire', { takeover: false }, { session_id: h.inProject })),
    'role_forbidden');
});

test('a member revoked after the conversation exists is refused', async (t) => {
  const h = await teamHost(t);
  assert.equal(reason(await h.send('carl', 'sessions.snapshot', {}, { session_id: h.inProject })), 'ok');
  const revoked = await h.context.store.revokeMember({ actorMemberId: h.seats.owner.member_id,
    memberId: h.seats.carl.member_id });
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  // Revocation drops the device's client; a client registered afterwards reaches authorize.
  assert.equal(reason(await h.send('carl', 'sessions.snapshot', {}, { session_id: h.inProject })),
    'client_unauthorized');
  h.forget('carl');
  assert.equal(reason(await h.send('carl', 'sessions.snapshot', {}, { session_id: h.inProject })), 'member_revoked');
});

test('row 151 T2: the started host answers the board commands and the snapshot route by project role', async (t) => {
  const h = await teamHost(t);
  const made = await h.send('alice', 'team.board.create', { project_id: PROJECT, name: 'Roadmap' });
  assert.equal(made.ok, true, JSON.stringify(made));
  assert.equal(made.board.created_by, h.seats.alice.member_id);
  const target = { project_id: PROJECT, board_id: made.board.id };
  const card = { id: crypto.randomUUID(), kind: 'note', x: 0, y: 0, data: { text: 'from Carl' } };
  const batch = () => ({ batch_id: `b-${crypto.randomUUID()}`, ops: [{ op: 'card.add', card: { ...card, id: crypto.randomUUID() } }] });
  const applied = await h.send('carl', 'team.board.apply', { ...target, batch: batch() });
  assert.deepEqual([applied.ok, applied.rev, applied.applied?.actor], [true, 1, h.seats.carl.member_id], JSON.stringify(applied));
  assert.equal(reason(await h.send('rae', 'team.board.apply', { ...target, batch: batch() })), 'role_forbidden');
  assert.equal(reason(await h.send('carl', 'team.board.delete', target)), 'role_forbidden');
  for (const who of ['bob', 'owner']) {
    assert.equal(reason(await h.send(who, 'team.board.list', { project_id: PROJECT })), 'team_not_found', who);
    assert.equal(reason(await h.send(who, 'team.board.apply', { ...target, batch: batch() })), 'team_not_found', who);
    const refused = await h.get(who, `/api/v1/projects/${PROJECT}/boards/${made.board.id}`);
    assert.deepEqual([refused.handled, refused.json.ok, refused.json.error.reason], [true, false, 'team_not_found'], who);
  }
  assert.deepEqual((await h.send('rae', 'team.board.list', { project_id: PROJECT })).boards.map((board) => [board.id, board.rev]),
    [[made.board.id, 1]]);
  const read = await h.get('rae', `/api/v1/projects/${PROJECT}/boards/${made.board.id}`);
  assert.deepEqual([read.handled, read.status, read.json.rev, Object.keys(read.json.board.cards).length], [true, 200, 1, 1]);
  assert.equal(reason(await h.send('alice', 'team.board.delete', target)), 'ok');
  assert.equal((await h.get('rae', `/api/v1/projects/${PROJECT}/boards/${made.board.id}`)).json.error.reason, 'team_board_not_found');
  // The log names operations and reasons, never a board's name or a card's text.
  const log = JSON.stringify(h.fx.logs);
  assert.match(log, /team_board\.command_answered/u);
  assert.equal(log.includes('Roadmap') || log.includes('from Carl'), false);
});
