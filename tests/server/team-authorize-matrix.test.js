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
const { ACTIONS, PRINCIPALS } = require('../../server/team/operation-registry');
const { BOOT, BackendHarness, command } = require('../helpers/command-router-fixture');
const { createTeamDirectoryFixture } = require('./helpers/team-directory-fixture');

const COLUMN_OF = { owner: 'owner', member: 'member', read_only: 'read_only', pending: 'pending', invite: 'invite' };
const REASON_WHEN_DENIED = { revoked: 'member_revoked', pending: 'member_pending' };

function resourceFor(kind, actor) {
  if (kind === 'device' || kind === 'invite') return { kind, id: actor.device_id }; // always visible to its own principal
  if (kind === 'channel') return { kind, id: 'chan_team' }; // visible to every active member
  return { kind, id: kind === 'team' ? '' : `${kind}_1` };
}

function authorizerFor(fixture) { return createAuthorizer({ directory: fixture.directory }).authorize; }

test('matrix: every action by owner, member, read-only, pending, invite and revoked', () => {
  const fixture = createTeamDirectoryFixture();
  const authorize = authorizerFor(fixture);
  assert.equal(Object.keys(ACTIONS).length >= 30, true);
  for (const [action, row] of Object.entries(ACTIONS)) {
    for (const principal of PRINCIPALS) {
      const actor = fixture.actors[principal];
      const allowed = principal !== 'revoked' && row[COLUMN_OF[principal]] === true;
      const verdict = authorize(actor, action, resourceFor(row.resource, actor), 'req_matrix');
      const label = `${action} by ${principal}`;
      if (allowed) {
        assert.deepEqual(verdict, { ok: true }, label);
        continue;
      }
      assert.equal(verdict.ok, false, label);
      assert.equal(verdict.error.code, 'CMP-HOST-0003', label);
      assert.equal(verdict.error.reason, REASON_WHEN_DENIED[principal] || 'role_forbidden', label);
      assert.equal(verdict.error.request_id, 'req_matrix', label);
    }
  }
});

test('matrix: spot cells from the spec tables', () => {
  const fixture = createTeamDirectoryFixture();
  const authorize = authorizerFor(fixture);
  const ok = (who, action, kind = 'session', id = 'session_1') => authorize(fixture.actors[who], action, { kind, id }).ok;
  assert.equal(ok('read_only', 'session.read'), true);
  assert.equal(ok('read_only', 'session.write'), false);
  assert.equal(ok('read_only', 'session.takeover'), false);
  assert.equal(ok('member', 'session.takeover'), true);
  assert.equal(ok('member', 'runtime.control'), false);
  assert.equal(ok('member', 'session.delete'), false);
  assert.equal(ok('member', 'project.root', 'project', 'project_1'), false);
  assert.equal(ok('owner', 'project.root', 'project', 'project_1'), true);
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

test('the role comes from the live directory, never from the object handed in', () => {
  const fixture = createTeamDirectoryFixture();
  const authorize = authorizerFor(fixture);
  const resource = { kind: 'session', id: 'session_1' };
  const claimsOwner = { ...fixture.actors.read_only, role: 'owner', state: 'active' };
  assert.equal(authorize(claimsOwner, 'session.delete', resource).error.reason, 'role_forbidden');
  fixture.setRole('device_a1', 'read_only');
  assert.equal(authorize(fixture.actors.member, 'session.write', resource).error.reason, 'role_forbidden');
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
  // Sessions and projects are visible to every active member in Phase 1.
  assert.deepEqual(authorize(member, 'session.read', { kind: 'session', id: 'anything' }), { ok: true });
  // Malformed and later-phase resources are not visible.
  assert.equal(authorize(member, 'session.read', { kind: 'planted', id: 'x' }).error.reason, 'team_not_found');
  assert.equal(authorize(member, 'session.read', { kind: 'session' }).error.reason, 'team_not_found');
  assert.equal(authorize(member, 'session.read', null).error.reason, 'team_not_found');
  assert.equal(authorize(member, 'session.read', { kind: 'channel', id: 'c' }).error.reason, 'team_not_found');
  // An invite principal sees only its own invite.
  assert.deepEqual(authorize(fixture.actors.invite, 'team.join.redeem', { kind: 'invite', id: 'invite_1' }), { ok: true });
  assert.equal(authorize(fixture.actors.invite, 'team.join.redeem', { kind: 'invite', id: 'invite_2' }).error.reason, 'team_not_found');
});

// ---- Router chokepoint -----------------------------------------------------

function routerFixture(t) {
  const team = createTeamDirectoryFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-authz-'));
  const backend = new BackendHarness(root);
  const clients = new ClientRegistry();
  const leases = new ControlLeases();
  const receipts = new CommandReceipts({ filePath: path.join(root, 'receipts.json') });
  const eventStream = { publish() {} };
  const router = createCommandRouter({ backend, clients, leases, receipts, bootEpoch: BOOT, eventStream,
    authorize: authorizerFor(team) });
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
  const created = await f.send('owner', 'sessions.create', { title: 'Team' });
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
