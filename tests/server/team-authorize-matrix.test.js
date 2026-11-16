'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ClientRegistry } = require('../../server/client-registry');
const { CommandReceipts } = require('../../server/command-receipts');
const { ControlLeases } = require('../../server/control-leases');
const { createCommandRouter } = require('../../server/command-router');
const { createAssetRoutes } = require('../../server/asset-routes');
const { createArtifactRoutes } = require('../../server/artifact-routes');
const { createAuthorizer } = require('../../server/team/authorize');
const { createRouteGuard } = require('../../server/team/route-guard');
const { ACTIONS, OPERATION_ACTIONS, PRINCIPALS, RESERVED_ACTIONS, ROUTE_ACTIONS, ROUTER_ACTIONS } = require('../../server/team/operation-registry');
const { BOOT, BackendHarness, command } = require('../helpers/command-router-fixture');
const { createTeamDirectoryFixture } = require('./helpers/team-directory-fixture');

// The spec's action rows, copied so a registry change that drifts from them fails.
const { EXPECTED, OWNER_ANY, OWNER_SEEN, TEAM_PROJECT_ONLY } = require('./helpers/team-action-rows');

const LETTER = { owner: 'O', member: 'M', read_only: 'R', pending: 'P', invite: 'I', revoked: '' };
const RELATIONS = ['admin', 'writer', 'reader', 'none', 'deleting', 'general', 'unknown'];
// What a principal holds in the project of the resource, per relation: a role,
// 'deleting' (owner only, read only) or null (not visible). The owner is
// nobody in a project they did not join (E23); General and a project with no
// team row are owner only (orchestrator decisions 4 and 3); a read-only member
// is capped at reader (P4); pending, invite and revoked hold nothing.
const NONE = { admin: null, writer: null, reader: null, none: null, deleting: null, general: null, unknown: null };
const ACCESS = {
  owner: { admin: 'admin', writer: 'writer', reader: 'reader', none: null, deleting: 'deleting', general: 'admin', unknown: 'admin' },
  member: { ...NONE, admin: 'admin', writer: 'writer', reader: 'reader' },
  read_only: { ...NONE, admin: 'reader', writer: 'reader', reader: 'reader' },
  pending: NONE, invite: NONE, revoked: NONE,
};
const RANK = { reader: 1, writer: 2, admin: 3 };
const PROJECT_OF = { admin: 'project_x', writer: 'project_x', reader: 'project_x', none: 'project_x',
  deleting: 'project_del', general: 'project_general', unknown: 'project_unknown' };

// The expected reason ('ok' for allowed) for one cell, from the tables above only.
function expectedReason(principal, relation, action) {
  const [who, need, kind] = EXPECTED[action];
  if (principal === 'revoked') return 'member_revoked';
  if (!who.includes(LETTER[principal])) return principal === 'pending' ? 'member_pending' : 'role_forbidden';
  if (kind !== 'session' && kind !== 'project') return 'ok';
  // E70 (owner, 2026-11-14): on a team host no conversation is made in General, the owner's included.
  if (action === 'session.create' && relation === 'general') return 'team_project_required';
  // Slice 3-4b: an owner-any row lets the active owner act on any active project (project_x).
  if (OWNER_ANY.includes(action) && principal === 'owner' && PROJECT_OF[relation] === 'project_x') return 'ok';
  if (TEAM_PROJECT_ONLY.includes(action) && PROJECT_OF[relation] !== 'project_x') return 'team_not_found';
  const access = ACCESS[principal][relation];
  if (access === null) return 'team_not_found';
  if (need === null) return 'ok';
  if (OWNER_SEEN.includes(action) && principal === 'owner' && access !== 'deleting') return 'ok'; // slice 3-7
  const held = access === 'deleting' ? 'reader' : access;
  if (RANK[held] >= RANK[need]) return 'ok';
  if (access === 'deleting') return 'team_project_deleting';
  return need === 'admin' ? 'role_forbidden' : 'team_project_read_only';
}

// One team directory and resolver per (principal, relation): the principal's
// member id holds `relation` in project_x as stored (read-only included, so the
// cap is the authorizer's), project_del is deleting, project_general and
// project_unknown have no team row, and session_rel sits in the relation's project
// (an unknown conversation for `unknown`).
function cellFixture(principal, relation) {
  const fixture = createTeamDirectoryFixture({ projects: { project_x: { members: {} }, project_del: { state: 'deleting' } } });
  const memberId = fixture.actors[principal].member_id;
  if (RANK[relation] && memberId) fixture.setProjectRole(memberId, 'project_x', relation);
  const sessionProject = (id) => (id === 'session_rel' && relation !== 'unknown' ? PROJECT_OF[relation] : null);
  return { fixture, authorize: createAuthorizer({ directory: fixture.directory, sessionProject }).authorize };
}

function cellResource(kind, actor, relation) {
  if (kind === 'session') return { kind, id: 'session_rel' };
  if (kind === 'project') return { kind, id: PROJECT_OF[relation] };
  if (kind === 'device' || kind === 'invite') return { kind, id: actor.device_id }; // always visible to its own principal
  if (kind === 'channel') return { kind, id: 'chan_team' }; // every active member
  return { kind, id: kind === 'team' ? '' : `${kind}_1` };
}

// Every operation (both control.acquire mappings), every raw route, and each
// reserved action, as [label, action].
function everyEntry() {
  const entries = [];
  for (const [operation, entry] of Object.entries(OPERATION_ACTIONS)) {
    if (typeof entry === 'function') {
      for (const takeover of [true, false]) entries.push([`${operation} takeover=${takeover}`, entry({ takeover })]);
    } else entries.push([operation, entry]);
  }
  for (const [route, action] of Object.entries(ROUTE_ACTIONS)) entries.push([route, action]);
  for (const action of RESERVED_ACTIONS) entries.push([`reserved ${action}`, action]);
  for (const action of ROUTER_ACTIONS) entries.push([`router ${action}`, action]);
  return entries;
}

test('T1: the table names every action, and the registry matches it row for row', () => {
  assert.deepEqual(Object.keys(ACTIONS).sort(), Object.keys(EXPECTED).sort());
  for (const [action, [who, need, kind]] of Object.entries(EXPECTED)) {
    const row = ACTIONS[action];
    for (const principal of PRINCIPALS.filter((name) => name !== 'revoked')) {
      assert.equal(row[principal], who.includes(LETTER[principal]), `${action}.${principal}`);
    }
    assert.equal(row.project, need ?? 'none', `${action} project column`);
    assert.equal(row.resource, kind, `${action} resource kind`);
  }
  for (const [label, action] of everyEntry()) assert.ok(Object.hasOwn(EXPECTED, action), `${label} -> ${action} has no row`);
});

test('T1: every operation and raw route by every team state and every project relation', () => {
  let cells = 0;
  for (const principal of PRINCIPALS) {
    for (const relation of RELATIONS) {
      const { fixture, authorize } = cellFixture(principal, relation);
      const actor = fixture.actors[principal];
      for (const [label, action] of everyEntry()) {
        const want = expectedReason(principal, relation, action);
        const verdict = authorize(actor, action, cellResource(EXPECTED[action][2], actor, relation), 'req_matrix');
        const where = `${label} by ${principal} (${relation})`;
        cells += 1;
        if (want === 'ok') { assert.deepEqual(verdict, { ok: true }, where); continue; }
        assert.equal(verdict.ok, false, where);
        assert.equal(verdict.error.code, 'CMP-HOST-0003', where);
        assert.equal(verdict.error.reason, want, where);
        assert.equal(verdict.error.request_id, 'req_matrix', where);
      }
    }
  }
  assert.ok(cells > 3000, `${cells} cells`);
});

test('T1: project.assign checks the target project through the same function', () => {
  for (const relation of RELATIONS) {
    const { fixture, authorize } = cellFixture('member', relation);
    const verdict = authorize(fixture.actors.member, 'project.assign', { kind: 'project', id: PROJECT_OF[relation] });
    // E70: General is never a target on a team host.
    const want = relation === 'general' ? 'team_project_required' : expectedReason('member', relation, 'project.assign');
    assert.equal(verdict.ok ? 'ok' : verdict.error.reason, want, relation);
  }
  const { fixture, authorize } = cellFixture('member', 'writer');
  // E70 (owner, 2026-11-14): the owner, who holds General, cannot move a conversation into it either.
  assert.equal(authorize(fixture.actors.owner, 'project.assign', { kind: 'project', id: 'project_general' }).error.reason,
    'team_project_required');
  // An empty target is never "the list": it denies like a missing project.
  assert.equal(authorize(fixture.actors.member, 'project.assign', { kind: 'project', id: '' }).error.reason, 'team_not_found');
  // Any other kind for the target still reads as not existing.
  assert.equal(authorize(fixture.actors.member, 'project.assign', { kind: 'channel', id: 'chan_team' }).error.reason,
    'team_not_found');
});

test('T1: an empty id is a list for list rows, refused for session.create, and nothing for the rest', () => {
  const { fixture, authorize } = cellFixture('member', 'writer');
  const reason = (who, action, kind) => {
    const verdict = authorize(fixture.actors[who], action, { kind, id: '' });
    return verdict.ok ? 'ok' : verdict.error.reason;
  };
  for (const who of ['owner', 'member', 'read_only']) {
    assert.equal(reason(who, 'session.list', 'session'), 'ok', who);
    assert.equal(reason(who, 'project.read', 'project'), 'ok', who);
    assert.equal(reason(who, 'runtime.read', 'session'), 'ok', who);
    assert.equal(reason(who, 'events.subscribe', 'session'), 'ok', who);
  }
  // E70 (owner, 2026-11-14, replacing orchestrator decision 3): no project on session.create is refused for everyone.
  assert.equal(reason('owner', 'session.create', 'project'), 'team_project_required');
  assert.equal(reason('member', 'session.create', 'project'), 'team_project_required');
  assert.equal(reason('owner', 'project.create', 'project'), 'ok');
  assert.equal(reason('member', 'project.create', 'project'), 'ok');
  for (const [action, kind] of [['session.read', 'session'], ['session.write', 'session'], ['project.write', 'project'],
    ['project.members', 'project'], ['project.files.download', 'project']]) {
    assert.equal(reason('member', action, kind), 'team_not_found', action);
    assert.equal(reason('owner', action, kind), 'team_not_found', `${action} owner`);
  }
});

test('matrix: spot cells from the spec tables', () => {
  const { fixture, authorize } = cellFixture('member', 'writer');
  fixture.setProjectRole('member_ro', 'project_x', 'reader');
  fixture.setProjectRole('member_owner', 'project_x', 'admin');
  const ok = (who, action, kind = 'session', id = 'session_rel') => authorize(fixture.actors[who], action, { kind, id }).ok;
  assert.equal(ok('read_only', 'session.read'), true);
  assert.equal(ok('read_only', 'session.write'), false);
  assert.equal(ok('read_only', 'session.takeover'), false);
  assert.equal(ok('member', 'session.takeover'), true);
  // E5 revisited: members may control a run and delete a conversation, gated by the project role.
  assert.equal(ok('member', 'runtime.control'), true);
  assert.equal(ok('member', 'session.delete'), false, 'a writer is not a project admin');
  fixture.setProjectRole('member_a', 'project_x', 'admin');
  assert.equal(ok('member', 'session.delete'), true);
  assert.equal(ok('member', 'runtime.limits'), false);
  assert.equal(ok('member', 'permission.review', 'project', ''), false);
  assert.equal(ok('member', 'project.root', 'project', 'project_x'), false);
  assert.equal(ok('owner', 'project.root', 'project', 'project_x'), true);
  assert.equal(ok('owner', 'team.leave', 'team', ''), false, 'the owner transfers before leaving');
  assert.equal(ok('pending', 'team.status', 'team', ''), true);
  assert.equal(ok('pending', 'session.list'), false);
  assert.equal(ok('invite', 'team.join.redeem', 'invite', 'invite_1'), true);
  assert.equal(ok('invite', 'team.status', 'team', ''), false);
  assert.equal(ok('revoked', 'team.hello', 'team', ''), false);
  // Slice 2a-3b: read-only may search and report presence but not type; pending may do none.
  assert.equal(ok('read_only', 'chat.search', 'team', ''), true);
  assert.equal(ok('read_only', 'presence.set', 'team', ''), true);
  assert.equal(ok('read_only', 'chat.typing', 'channel', 'chan_team'), false);
  assert.equal(ok('member', 'chat.typing', 'channel', 'chan_team'), true);
  assert.equal(ok('member', 'chat.typing', 'channel', `chan_dm_${'a'.repeat(64)}`), false);
  assert.equal(ok('pending', 'chat.search', 'team', ''), false);
  assert.equal(ok('pending', 'presence.set', 'team', ''), false);
});

// The default fixture's conversations all sit in project_1 (owner admin, members write, read-only reads).
function authorizerFor(fixture) {
  return createAuthorizer({ directory: fixture.directory, sessionProject: () => 'project_1' }).authorize;
}

test('the role comes from the live directory, never from the object handed in', () => {
  const fixture = createTeamDirectoryFixture();
  const authorize = authorizerFor(fixture);
  const resource = { kind: 'session', id: 'session_1' };
  const claimsOwner = { ...fixture.actors.read_only, role: 'owner', state: 'active' };
  assert.equal(authorize(claimsOwner, 'session.delete', resource).error.reason, 'role_forbidden');
  fixture.setRole('device_a1', 'read_only');
  assert.equal(authorize(fixture.actors.member, 'session.write', resource).error.reason, 'role_forbidden');
  // A state the column table does not know is refused (fail closed), for the owner role too.
  fixture.setState('device_owner', 'suspended');
  assert.equal(authorize(fixture.actors.owner, 'session.list', resource).error.reason, 'role_forbidden');
  assert.equal(authorize(fixture.actors.owner, 'team.hello', { kind: 'team', id: '' }).error.reason, 'role_forbidden');
  fixture.setState('device_a1', 'revoked');
  assert.equal(authorize(fixture.actors.member, 'session.list', resource).error.reason, 'member_revoked');
  fixture.remove('device_a1');
  assert.equal(authorize(fixture.actors.member, 'session.list', resource).error.reason, 'member_revoked');
  for (const bad of [null, undefined, {}, { device_id: '' }, { device_id: 7 }, { device_id: 'device_nobody' }]) {
    assert.equal(authorize(bad, 'session.list', resource).ok, false);
  }
});

test('a degraded directory denies a member and allows the owner', () => {
  const fixture = createTeamDirectoryFixture();
  const authorize = authorizerFor(fixture);
  const resource = { kind: 'session', id: 'session_1' };
  fixture.setDegraded(true);
  const denied = authorize(fixture.actors.member, 'session.list', resource, 'req_degraded');
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'CMP-HOST-0005');
  assert.equal(denied.error.reason, 'team_unavailable');
  assert.equal(denied.error.retryable, true);
  for (const who of ['read_only', 'pending', 'invite', 'revoked']) {
    assert.equal(authorize(fixture.actors[who], 'team.hello', { kind: 'team', id: '' }).error.reason, 'team_unavailable', who);
  }
  assert.deepEqual(authorize(fixture.actors.owner, 'session.list', resource), { ok: true });
  fixture.setDegraded(false);
  assert.deepEqual(authorize(fixture.actors.member, 'session.list', resource), { ok: true });
});

test('a directory that throws fails closed', () => {
  const fixture = createTeamDirectoryFixture();
  const broken = createAuthorizer({ directory: { ...fixture.directory, liveActor() { throw new Error('boom'); } } });
  const denied = broken.authorize(fixture.actors.owner, 'session.list', { kind: 'session', id: 's' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.reason, 'team_unavailable');
  assert.throws(() => createAuthorizer({}), TypeError);
});

test('a resource that exists but is not visible answers exactly like one that does not exist', () => {
  const fixture = createTeamDirectoryFixture();
  const authorize = authorizerFor(fixture);
  const member = fixture.actors.member;
  const others = authorize(member, 'team.device.revoke', { kind: 'device', id: 'device_b1' }, 'req_same');
  const missing = authorize(member, 'team.device.revoke', { kind: 'device', id: 'device_nobody' }, 'req_same');
  assert.equal(others.ok, false);
  assert.equal(others.error.reason, 'team_not_found');
  assert.deepEqual(others, missing);
  // Its own devices stay visible; the owner sees every existing device and still not a missing one.
  assert.deepEqual(authorize(member, 'team.device.revoke', { kind: 'device', id: 'device_a2' }), { ok: true });
  assert.deepEqual(authorize(fixture.actors.owner, 'team.device.revoke', { kind: 'device', id: 'device_b1' }), { ok: true });
  assert.deepEqual(authorize(fixture.actors.owner, 'team.device.revoke', { kind: 'device', id: 'device_nobody' }, 'req_same'), missing);
  // Malformed and later-phase resources are not visible.
  assert.equal(authorize(member, 'session.read', { kind: 'planted', id: 'x' }).error.reason, 'team_not_found');
  assert.equal(authorize(member, 'session.read', { kind: 'session' }).error.reason, 'team_not_found');
  assert.equal(authorize(member, 'session.read', null).error.reason, 'team_not_found');
  assert.equal(authorize(member, 'session.read', { kind: 'channel', id: 'c' }).error.reason, 'team_not_found');
  // An invite principal sees only its own invite.
  assert.deepEqual(authorize(fixture.actors.invite, 'team.join.redeem', { kind: 'invite', id: 'invite_1' }), { ok: true });
  assert.equal(authorize(fixture.actors.invite, 'team.join.redeem', { kind: 'invite', id: 'invite_2' }).error.reason, 'team_not_found');
  // On a team directory a conversation in another project reads exactly like a missing one.
  const { fixture: team, authorize: teamAuthorize } = cellFixture('member', 'none');
  const hidden = teamAuthorize(team.actors.member, 'session.read', { kind: 'session', id: 'session_rel' }, 'req_same');
  const absent = teamAuthorize(team.actors.member, 'session.read', { kind: 'session', id: 'session_nobody' }, 'req_same');
  assert.equal(hidden.error.reason, 'team_not_found');
  assert.deepEqual(hidden, absent);
});

// ---- Router chokepoint -----------------------------------------------------

// Conversations sit in project_x, where the owner is admin, both members write
// and the read-only member reads; the resolver reads the session store.
function routerFixture(t) {
  const team = createTeamDirectoryFixture({ projects: { project_x: { members: {
    member_owner: 'admin', member_a: 'writer', member_b: 'writer', member_ro: 'reader' } } } });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-authz-'));
  const backend = new BackendHarness(root);
  const sessionProject = (id) => backend.sessionStore.getSession(id)?.project_id ?? null;
  const clients = new ClientRegistry();
  const leases = new ControlLeases();
  const receipts = new CommandReceipts({ filePath: path.join(root, 'receipts.json') });
  const eventStream = { publish() {} };
  const router = createCommandRouter({ backend, clients, leases, receipts, bootEpoch: BOOT, eventStream,
    authorize: createAuthorizer({ directory: team.directory, sessionProject }).authorize });
  const seat = {};
  for (const [name, actor] of Object.entries(team.actors)) {
    const client = clients.register(actor.device_id);
    seat[name] = { client, context: { deviceId: actor.device_id, clientToken: client.client_token,
      isAuthenticated: () => true, actor } };
  }
  t.after(() => { router.dispose(); backend.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const send = (who, operation, params = {}, extra = {}) => router.dispatch(
    command(seat[who].client, operation, params, extra), seat[who].context);
  return { team, backend, leases, router, seat, send };
}

async function newSession(f) {
  // E70: a team host makes a conversation in a named project only.
  const created = await f.send('owner', 'sessions.create', { title: 'Team', project_id: 'project_x' });
  assert.equal(created.ok, true);
  return created.session.session_id;
}

test('router: takeover by a read-only member is denied; a plain acquire by a member is allowed', async (t) => {
  const f = routerFixture(t);
  const session_id = await newSession(f);
  const ownerLease = await f.send('owner', 'control.acquire', { takeover: false }, { session_id });
  assert.equal(ownerLease.ok, true);
  const takeover = await f.send('read_only', 'control.acquire', { takeover: true }, { session_id });
  assert.equal(takeover.ok, false);
  assert.equal(takeover.error.code, 'CMP-HOST-0003');
  assert.equal(takeover.error.reason, 'role_forbidden');
  assert.equal(f.leases.get(session_id).device_id, 'device_owner', 'the lease did not move');
  const plain = await f.send('read_only', 'control.acquire', { takeover: false }, { session_id });
  assert.equal(plain.error.reason, 'role_forbidden');
  // A member may take over, and a plain acquire on a free session is allowed.
  const taken = await f.send('member', 'control.acquire', { takeover: true }, { session_id });
  assert.equal(taken.ok, true);
  assert.equal(f.leases.get(session_id).device_id, 'device_a1');
  const second = await newSession(f);
  assert.equal((await f.send('otherMember', 'control.acquire', { takeover: false }, { session_id: second })).ok, true);
});

test('router: reads and commands follow the live role on every call', async (t) => {
  const f = routerFixture(t);
  const session_id = await newSession(f);
  assert.equal((await f.send('read_only', 'sessions.list')).ok, true);
  assert.equal((await f.send('read_only', 'sessions.snapshot', {}, { session_id })).ok, true);
  assert.equal((await f.send('read_only', 'sessions.create', { title: 'x' })).error.reason, 'role_forbidden');
  assert.equal((await f.send('pending', 'sessions.list')).error.reason, 'member_pending');
  assert.equal((await f.send('invite', 'sessions.list')).error.reason, 'role_forbidden');
  assert.equal((await f.send('revoked', 'sessions.list')).error.reason, 'member_revoked');
  assert.equal((await f.send('member', 'sessions.delete', {}, { session_id })).error.reason, 'role_forbidden');
  f.team.setRole('device_a1', 'read_only');
  assert.equal((await f.send('member', 'sessions.create', { title: 'x' })).error.reason, 'role_forbidden');
  f.team.setDegraded(true);
  assert.equal((await f.send('member', 'sessions.list')).error.reason, 'team_unavailable');
  assert.equal((await f.send('owner', 'sessions.list')).ok, true);
});

test('router: the authenticated device must be the actor, and client auth still comes first', async (t) => {
  const f = routerFixture(t);
  const mismatched = { ...f.seat.member.context, actor: f.team.actors.owner };
  const denied = await f.router.dispatch(command(f.seat.member.client, 'sessions.list'), mismatched);
  assert.equal(denied.error.reason, 'role_forbidden');
  const unauthenticated = { ...f.seat.owner.context, isAuthenticated: () => false };
  const first = await f.router.dispatch(command(f.seat.owner.client, 'sessions.list'), unauthenticated);
  assert.equal(first.error.reason, 'client_unauthorized');
  const noActor = { ...f.seat.owner.context, actor: null };
  assert.equal((await f.router.dispatch(command(f.seat.owner.client, 'sessions.list'), noActor)).ok, false);
  // A team router never falls back to the constant owner: a context that lost
  // its actor denies, even for a device the directory knows as a member.
  const forgotten = { ...f.seat.member.context };
  delete forgotten.actor;
  const refused = await f.router.dispatch(command(f.seat.member.client, 'sessions.list'), forgotten);
  assert.equal(refused.error.reason, 'role_forbidden');
});

test('router: a revocation during an awaited mutation is indeterminate, not success', async (t) => {
  const f = routerFixture(t);
  const session_id = await newSession(f);
  const lease = (await f.send('member', 'control.acquire', { takeover: false }, { session_id })).lease;
  const revision = f.router.snapshot(session_id).session.revision;
  let release;
  f.backend.renameGate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { f.backend.renameEntered = resolve; });
  const pending = f.send('member', 'sessions.rename', { title: 'Renamed' },
    { session_id, control_generation: lease.generation, expected_revision: revision });
  await entered;
  f.team.setState('device_a1', 'revoked');
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'operation_indeterminate');
});

// ---- Raw-route chokepoint ----------------------------------------------------

function responseStub() {
  return {
    headers: {}, statusCode: null, body: null, destroyed: false, writableEnded: false,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body; this.writableEnded = true; },
  };
}

const SECRET = Buffer.from('team secret bytes');
const ROUTES = [
  ['attachment', '/api/v1/sessions/session_1/attachments/value_1', 'GET'],
  ['message', '/api/v1/sessions/session_1/messages/value_1', 'GET'],
  ['artifact', '/api/v1/sessions/session_1/artifacts/value_1', 'GET'],
];

function routeFixture({ onRead = () => {}, guardRequired = false } = {}) {
  const calls = { read: 0 };
  const read = async () => { calls.read += 1; await onRead(); return { ok: true, bytes: SECRET,
    attachment: { mime_type: 'text/plain', display_name: 'a.txt' },
    message: { id: 'value_1', role: 'user', content: 'team secret bytes' },
    artifact: { file_name: 'a.txt', mime_type: 'text/plain' } }; };
  const asset = createAssetRoutes({ commands: { upload: read, readAttachment: read, readMessage: read }, guardRequired });
  const artifact = createArtifactRoutes({ commands: { read }, guardRequired });
  return { calls, run: (kind, ctx) => (kind === 'artifact' ? artifact : asset)(ctx) };
}

function routeContext(team, who, pathname, method = 'GET', overrides = {}) {
  const actor = who ? team.actors[who] : null;
  return {
    request: { method, headers: {} }, response: responseStub(), pathname, deviceId: actor?.device_id || '',
    clientId: 'client_1', authorized: () => true, requestId: 'req_route', actor,
    guard: createRouteGuard({ authorize: authorizerFor(team), actor, requestId: 'req_route' }), ...overrides,
  };
}

test('routes: attachment, message and artifact reads with no actor are denied without reading', async () => {
  const team = createTeamDirectoryFixture();
  for (const [kind, pathname, method] of ROUTES) {
    const f = routeFixture();
    const ctx = routeContext(team, null, pathname, method);
    assert.equal(await f.run(kind, ctx), true, kind);
    assert.equal(ctx.response.statusCode, 403, kind);
    assert.equal(JSON.parse(ctx.response.body).error.reason, 'role_forbidden', kind);
    assert.equal(f.calls.read, 0, `${kind} did not read`);
    // An actor with no guard at all also denies; so does a context naming no device.
    const bare = routeContext(team, 'owner', pathname, method, { guard: undefined });
    await f.run(kind, bare);
    assert.equal(bare.response.statusCode, 403, `${kind} actor without guard`);
    const anonymous = routeContext(team, null, pathname, method, { guard: undefined, actor: undefined, deviceId: '' });
    await f.run(kind, anonymous);
    assert.equal(anonymous.response.statusCode, 403, `${kind} no device`);
    assert.equal(f.calls.read, 0, `${kind} still did not read`);
  }
  // Routes built for a team host deny a context that carries only a device id,
  // which the single-owner routes would treat as the owner.
  for (const [kind, pathname, method] of ROUTES) {
    const strict = routeFixture({ guardRequired: true });
    const legacy = routeContext(team, 'member', pathname, method, { guard: undefined, actor: undefined });
    await strict.run(kind, legacy);
    assert.equal(legacy.response.statusCode, 403, `${kind} team routes need a guard`);
    assert.equal(strict.calls.read, 0, `${kind} team routes did not read`);
  }
  const upload = routeFixture();
  const ctx = routeContext(team, null, '/api/v1/attachments', 'POST');
  ctx.request = { method: 'POST', headers: { 'content-type': 'text/plain' }, body: Buffer.from('x') };
  await upload.run('asset', ctx);
  assert.equal(ctx.response.statusCode, 403);
  assert.equal(upload.calls.read, 0);
});

test('routes: pending, read-only upload and revoked actors are denied; allowed roles read', async () => {
  const team = createTeamDirectoryFixture();
  for (const [kind, pathname, method] of ROUTES) {
    for (const [who, reason] of [['pending', 'member_pending'], ['invite', 'role_forbidden'], ['revoked', 'member_revoked']]) {
      const f = routeFixture();
      const ctx = routeContext(team, who, pathname, method);
      await f.run(kind, ctx);
      assert.equal(ctx.response.statusCode, 403, `${kind} ${who}`);
      assert.equal(JSON.parse(ctx.response.body).error.reason, reason);
      assert.equal(f.calls.read, 0);
    }
    for (const who of ['owner', 'member', 'read_only']) {
      const f = routeFixture();
      const ctx = routeContext(team, who, pathname, method);
      await f.run(kind, ctx);
      // The attachment route ends without writeHead, so success leaves the status unset.
      assert.ok([null, 200].includes(ctx.response.statusCode), `${kind} ${who}`);
      assert.ok(ctx.response.writableEnded, `${kind} ${who} answered`);
    }
  }
  const f = routeFixture();
  const upload = routeContext(team, 'read_only', '/api/v1/attachments', 'POST');
  upload.request = { method: 'POST', headers: { 'content-type': 'text/plain' }, body: Buffer.from('x') };
  await f.run('asset', upload);
  assert.equal(JSON.parse(upload.response.body).error.reason, 'role_forbidden');
});

for (const [change, reason, mutate] of [
  ['revoked', 'member_revoked', (team) => team.setState('device_a1', 'revoked')],
  ['moved back to pending', 'member_pending', (team) => team.setState('device_a1', 'pending')],
  ['removed', 'member_revoked', (team) => team.remove('device_a1')],
]) {
  test(`routes: an actor ${change} while a read is awaited gets a denial, not the data`, async () => {
    for (const [kind, pathname, method] of ROUTES) {
      const team = createTeamDirectoryFixture();
      const f = routeFixture({ onRead: () => mutate(team) });
      const ctx = routeContext(team, 'member', pathname, method);
      await f.run(kind, ctx);
      assert.equal(f.calls.read, 1, `${kind} did read once`);
      assert.equal(ctx.response.statusCode, 403, kind);
      assert.equal(JSON.parse(ctx.response.body).error.reason, reason, kind);
      assert.equal(String(ctx.response.body).includes('team secret'), false, `${kind} leaked`);
    }
  });
}

test('routes: a demotion during the upload body read stops the upload', async () => {
  const team = createTeamDirectoryFixture();
  let uploads = 0;
  const routes = createAssetRoutes({ commands: { upload: async () => { uploads += 1; return { ok: true }; },
    readAttachment: async () => ({ ok: false }), readMessage: async () => ({ ok: false }) } });
  const ctx = routeContext(team, 'member', '/api/v1/attachments', 'POST');
  ctx.request = { method: 'POST', headers: { 'content-type': 'text/plain' },
    async *[Symbol.asyncIterator]() { team.setRole('device_a1', 'read_only'); yield Buffer.from('x'); } };
  await routes(ctx);
  assert.equal(uploads, 0);
  assert.equal(ctx.response.statusCode, 403);
  assert.equal(JSON.parse(ctx.response.body).error.reason, 'role_forbidden');
});

test('routes: a session another member cannot see answers like a missing one', async () => {
  const team = createTeamDirectoryFixture();
  const authorize = authorizerFor(team);
  const actor = team.actors.member;
  const guard = createRouteGuard({ authorize, actor, requestId: 'req_x' });
  assert.deepEqual(guard('team.device.revoke', { kind: 'device', id: 'device_b1' }),
    guard('team.device.revoke', { kind: 'device', id: 'device_missing' }));
});

test('construction: an authorize that is present but not a function throws; omitted, it stays single-owner', (t) => {
  const [{ createIdentityCheck }, { createHostCore }] = [require('../../server/command-router-identity'), require('../../server/host-core')];
  const base = { clients: { authorize: () => true }, bootEpoch: BOOT, disposed: { value: false } };
  for (const authorize of [null, {}, 'x']) assert.throws(() => createIdentityCheck({ ...base, authorize }), /authorize/u);
  assert.equal(typeof createIdentityCheck(base), 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-authz-'));
  const router = { backend: new BackendHarness(root), clients: new ClientRegistry(), leases: new ControlLeases(), bootEpoch: BOOT,
    receipts: new CommandReceipts({ filePath: path.join(root, 'receipts.json') }), eventStream: { publish() {} }, teamCommands: { dispatch() {} } };
  t.after(() => { router.backend.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const extra of [{ authorize: null }, {}]) assert.throws(() => createCommandRouter({ ...router, ...extra }), /authorize/u);
  assert.throws(() => createHostCore({ config: {}, guardRequired: true, authorize: null }), /authorize/u);
});

test('3-4b owner any: only project.delete, only the live active owner, only an active project', () => {
  const fixture = createTeamDirectoryFixture({ projects: { project_a: { members: { member_a: 'admin' } },
    project_b: { members: { member_b: 'admin', member_ro: 'reader' } }, project_del: { state: 'deleting' } } });
  const { authorize } = createAuthorizer({ directory: fixture.directory });
  const reason = (who, action, id) => {
    const verdict = authorize(fixture.actors[who], action, { kind: 'project', id });
    return verdict.ok ? 'ok' : verdict.error.reason;
  };
  assert.equal(reason('owner', 'project.delete', 'project_b'), 'ok', 'the owner holds no row in project_b');
  assert.equal(reason('member', 'project.delete', 'project_b'), 'team_not_found', 'an admin of A on B');
  assert.equal(reason('read_only', 'project.delete', 'project_b'), 'role_forbidden');
  assert.equal(reason('otherMember', 'project.delete', 'project_b'), 'ok', 'the admin of B');
  // The flag does not leak to another row on a project the owner did not join.
  for (const action of ['project.read', 'project.write', 'project.members', 'project.members.read', 'project.audit.read']) {
    assert.equal(reason('owner', action, 'project_b'), 'team_not_found', action);
  }
  // A deleting project keeps its answer; one that does not exist reads as the owner's (no team row), as before.
  assert.equal(reason('owner', 'project.delete', 'project_del'), 'team_project_deleting');
  assert.equal(reason('owner', 'project.delete', 'project_nowhere'), 'ok');
  // Re-read live: a degraded directory, a demoted or pending owner device fall back to today's answers.
  fixture.setDegraded(true);
  assert.equal(reason('owner', 'project.delete', 'project_b'), 'team_not_found');
  fixture.setDegraded(false);
  fixture.setRole('device_owner', 'member');
  assert.equal(reason('owner', 'project.delete', 'project_b'), 'team_not_found');
  fixture.setRole('device_owner', 'owner');
  fixture.setState('device_owner', 'pending');
  assert.equal(reason('owner', 'project.delete', 'project_b'), 'member_pending');
});
