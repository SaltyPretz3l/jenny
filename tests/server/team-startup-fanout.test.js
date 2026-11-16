'use strict';

// Team slice 1c-1b: the revoke fan-out, the owner bootstrap, stop, the seam's
// limits and redaction. Same fakes as team-startup.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { keyPairFromSeed, parseInvite } = require('../../server/team/invites');
const { MemberStore } = require('../../server/team/member-store');
const { PROJECT_AUDIT_FILE } = require('../../server/team/project-audit');
const { createProjectFolders } = require('../../server/team/project-folders');
const { createPoolComposition } = require('../../server/team/pool-composition');
const { createTeamBoards } = require('../../server/team/boards/team-boards');
const { startSweeps } = require('../../server/team/sweep-timer');
const { waitFor } = require('./helpers/fake-team-transport');
const { startMountedHost } = require('./helpers/team-engine-mount-fixture');
const { createTeamHostFixture } = require('./helpers/team-host-fixture');

// A missing fan-out guard or a hang fails its own test instead of the whole file.
const BOUNDED = Object.freeze({ timeout: 15_000 });

async function startWithMember(t, extraOptions = {}) {
  const fx = createTeamHostFixture(t);
  const client = fx.client();
  const seeded = await fx.seedMembers(client.deviceKey);
  const parent = fx.newParent();
  const host = await fx.start(parent, extraOptions);
  const conn = await fx.connect(client);
  const closed = new Promise((resolve) => conn.onClose(resolve));
  await waitFor(() => fx.logs.some((entry) => entry.event === 'team.bridge.connection_admitted'));
  const context = fx.context();
  const deviceId = seeded.member.device_id;
  const clientAuth = context.clients.register(deviceId);
  const lease = context.leases.acquire('session_one', clientAuth.client_id, deviceId);
  const revoked = [];
  const originalRevoke = context.events.revokeDevice.bind(context.events);
  context.events.revokeDevice = (id) => { revoked.push(id); originalRevoke(id); };
  return { fx, host, parent, context, seeded, deviceId, closed, lease, revoked };
}

test('revoking a device closes its connection, clients, leases and streams and tells the parent', BOUNDED, async (t) => {
  const { fx, context, parent, seeded, deviceId, closed, revoked } = await startWithMember(t);
  assert.equal(context.clients.clients.size, 1);
  const result = await context.store.revokeDevice({ actorMemberId: seeded.owner.member_id, deviceId });
  assert.equal(result.ok, true);
  assert.deepEqual(await closed, { refused: true });
  const dropped = fx.logs.filter((entry) => entry.event === 'team.bridge.dropped');
  assert.deepEqual(dropped.map((entry) => entry.fields), [{ connections: 1 }], 'the fan-out dropped the device key');
  assert.equal(context.clients.clients.size, 0);
  assert.equal(context.leases.get('session_one'), null);
  assert.deepEqual(revoked, [deviceId]);
  assert.deepEqual(parent.sent.at(-1), { type: 'membership_changed', kind: 'device_revoked', member_id: seeded.member.member_id });
  assert.equal(context.directory.isDegraded(), false);
});

test('a subscriber that throws marks the store degraded and the later subscribers still run', BOUNDED, async (t) => {
  const { fx, context, parent, seeded, deviceId, closed, revoked } = await startWithMember(t);
  context.clients.revokeDevice = () => { throw new Error('boom'); };
  const result = await context.store.revokeDevice({ actorMemberId: seeded.owner.member_id, deviceId });
  assert.equal(result.ok, true);
  assert.deepEqual(await closed, { refused: true }, 'the bridge subscriber ran before the failing one');
  assert.equal(context.leases.get('session_one'), null);
  assert.deepEqual(revoked, [deviceId]);
  assert.equal(parent.sent.at(-1).kind, 'device_revoked');
  assert.equal(context.directory.isDegraded(), true);
  assert.equal(fx.logs.filter((entry) => entry.event === 'team_membership.subscriber_failed').length, 1);
});

test('a role change revokes leases only; revoking a member covers every device', BOUNDED, async (t) => {
  const { context, parent, seeded, deviceId, closed } = await startWithMember(t);
  const changed = await context.store.setRole({ actorMemberId: seeded.owner.member_id,
    memberId: seeded.member.member_id, role: 'read_only' });
  assert.equal(changed.ok, true);
  assert.equal(context.leases.get('session_one'), null);
  assert.equal(context.clients.clients.size, 1, 'a role change keeps the client');
  assert.equal(parent.sent.at(-1).kind, 'role_changed');
  const removed = await context.store.revokeMember({ actorMemberId: seeded.owner.member_id, memberId: seeded.member.member_id });
  assert.equal(removed.ok, true);
  assert.deepEqual(await closed, { refused: true });
  assert.equal(context.clients.clients.size, 0);
  assert.equal(context.directory.liveActor(deviceId), null);
  assert.deepEqual(parent.sent.at(-1), { type: 'membership_changed', kind: 'member_revoked', member_id: seeded.member.member_id });
});

test('an owner transfer drops the previous owner\'s control leases and keeps the new owner\'s', async (t) => {
  const { context, seeded } = await startWithMember(t);
  const ownerDevice = seeded.owner.device_id;
  const ownerClient = context.clients.register(ownerDevice);
  context.leases.acquire('session_owner', ownerClient.client_id, ownerDevice);
  assert.notEqual(context.leases.get('session_owner'), null);
  const moved = await context.store.transferOwner({ actorMemberId: seeded.owner.member_id, memberId: seeded.member.member_id });
  assert.equal(moved.ok, true);
  assert.equal(context.leases.get('session_owner'), null);
  assert.notEqual(context.leases.get('session_one'), null, 'the new owner keeps theirs');
});

// Review sweeps, second run (X3b-F01): the scratch test turned around. A member mints an add-device invite for a key
// it holds, dials twice with it (the key's share) and revokes it, 32 times: every revoke frees its two slots.
test('X3b-F01: 32 mint, dial twice, revoke rounds leave the bridge room for a member; a member revoke frees the rest', { timeout: 60_000 }, async (t) => {
  const fx = createTeamHostFixture(t);
  const device = fx.client();
  const seeded = await fx.seedMembers(device.deviceKey);
  await fx.start(fx.newParent());
  const { store } = fx.context();
  const memberId = seeded.member.member_id;
  const admitted = (kind) => fx.logs.filter((entry) => entry.event === 'team.bridge.connection_admitted'
    && entry.fields.kind === kind).length;
  const mintAndDial = async () => {
    const holder = fx.client();
    const created = await store.createInvite({ kind: 'add_device', actorMemberId: memberId, invitePublicKey: holder.deviceKey });
    assert.equal(created.ok, true, created.error?.reason);
    const before = admitted('invite');
    const conns = [await fx.connect(holder), await fx.connect(holder)];
    await waitFor(() => admitted('invite') === before + 2);
    return { created, closed: conns.map((conn) => new Promise((resolve) => conn.onClose(resolve))) };
  };
  for (let round = 0; round < 32; round += 1) {
    const { created, closed } = await mintAndDial();
    assert.equal((await store.revokeInvite({ actorMemberId: memberId, inviteId: created.invite_id })).ok, true);
    const ended = await Promise.race([Promise.all(closed).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000))]);
    assert.equal(ended, true, `round ${round}: the revoked invite's connections are closed`);
  }
  const back = await fx.connect(device);
  const outcome = await Promise.race([new Promise((resolve) => back.onClose(() => resolve('closed'))),
    waitFor(() => admitted('device') === 1).then(() => 'admitted')]);
  assert.equal(outcome, 'admitted', 'a member dial after the 32 rounds is admitted, not turned away at the cap');
  // Two live invites with both their connections; the owner revokes the member: the cascade closes all four.
  const left = [await mintAndDial(), await mintAndDial()];
  assert.equal((await store.revokeMember({ actorMemberId: seeded.owner.member_id, memberId })).ok, true);
  assert.equal(await Promise.race([Promise.all(left.flatMap((entry) => entry.closed)).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000))]), true, 'the member revoke freed what was left');
});

// ------------------------------------------------------------ the pool

const engineTurn = (principal, extra = {}) => ({ memberId: principal.member_id, model: 'alpha', ...extra });
const chatTurn = (principal, sessionId) => ({ sessionId, projectId: null, memberId: principal.member_id,
  model: 'alpha', wantsVision: false });
const liveOf = (m, principal) => m.liveLeases().filter((lease) => lease.member_id === principal.member_id);
const isForbidden = (error) => error.reason === 'role_forbidden';

test('the pool asks the host authorizer about a real project conversation', BOUNDED, async (t) => {
  const m = await startMountedHost(t);
  const seats = await m.seed();
  m.node({ slots: 4 });
  const project = 'project_pool_p';
  assert.equal((await m.store.createProject({ actorMemberId: seats.member.member_id, projectId: project })).ok, true);
  const sessionStore = m.fx.backends[0].backend.sessionStore;
  const inProject = sessionStore.createSession({ title: 'In P' }).id;
  assert.ok(sessionStore.updateSession(inProject, { project_id: project }));
  const held = await m.pool.turnRoute.acquire(chatTurn(seats.member, inProject));
  assert.match(held.token, /^[A-Za-z0-9_-]{43}$/u, 'a project member gets a turn lease for its conversation');
  held.release({ ok: true });
  const requested = m.scheduler.listLeases().length;
  await assert.rejects(m.pool.turnRoute.acquire(chatTurn(seats.second, inProject)), isForbidden);
  assert.equal(m.scheduler.listLeases().length, requested, 'refused before any lease is requested');
  await assert.rejects(m.pool.turnRoute.acquire(chatTurn(seats.member, 'session_unknown')), isForbidden);
  (await m.pool.turnRoute.acquire(chatTurn(seats.owner, 'session_unknown'))).release({ ok: true });
});

for (const [label, change] of [
  ['member_revoked', (store, seats) => store.revokeMember({ actorMemberId: seats.owner.member_id,
    memberId: seats.member.member_id })],
  ['a role change to read-only', (store, seats) => store.setRole({ actorMemberId: seats.owner.member_id,
    memberId: seats.member.member_id, role: 'read_only' })],
]) {
  test(`${label} ends the member's pool leases and running job; another member's lease stays`, BOUNDED, async (t) => {
    const m = await startMountedHost(t);
    const seats = await m.seed();
    const { nodeId } = m.node();
    const active = await m.pool.engineRoute.acquire(engineTurn(seats.member));
    const { job } = m.scheduler.createJob(active.lease.lease_id, { requestBytes: Buffer.from('{}') });
    m.scheduler.claim(nodeId, 1);
    const queued = m.pool.engineRoute.acquire(engineTurn(seats.member, { engineKey: 'K'.repeat(43) }));
    const owner = m.pool.engineRoute.acquire(engineTurn(seats.owner));
    await waitFor(() => m.scheduler.listLeases().length === 3);
    assert.equal((await change(m.store, seats)).ok, true);
    await assert.rejects(queued, isForbidden);
    assert.deepEqual(liveOf(m, seats.member), []);
    assert.equal(m.scheduler.getJob(job.job_id).state, 'cancelled');
    assert.equal((await owner).lease.state, 'active', 'the owner\'s queued lease takes the freed slot');
  });
}

test('an owner transfer ends the previous owner\'s turn leases; the new owner\'s and an engine lease stay', BOUNDED, async (t) => {
  const m = await startMountedHost(t);
  const seats = await m.seed();
  m.node();
  // An unknown conversation is General: the owner's alone, so the transfer takes it away.
  await m.pool.turnRoute.acquire(chatTurn(seats.owner, 'session_general_1'));
  const queued = m.pool.turnRoute.acquire(chatTurn(seats.owner, 'session_general_2'));
  const incoming = m.pool.engineRoute.acquire(engineTurn(seats.member));
  const bystander = m.pool.engineRoute.acquire(engineTurn(seats.second));
  await waitFor(() => m.scheduler.listLeases().length === 4);
  const moved = await m.store.transferOwner({ actorMemberId: seats.owner.member_id, memberId: seats.member.member_id });
  assert.equal(moved.ok, true);
  assert.deepEqual(liveOf(m, seats.owner), [], 'both of the previous owner\'s turn leases ended');
  assert.equal(liveOf(m, seats.member).length, 1, 'the new owner keeps theirs');
  assert.equal(liveOf(m, seats.second).length, 1, 'an engine lease has no conversation to lose');
  await assert.rejects(queued, isForbidden);
  const first = await Promise.race([incoming, bystander]);
  assert.equal(first.lease.state, 'active', 'the freed slot goes to a lease still allowed');
});

test('the team host wires shared projects: a create through the router, its event, a pool recheck per member change', BOUNDED, async (t) => {
  let rechecks = 0;
  const counting = (input) => {
    const pool = createPoolComposition(input);
    return Object.freeze({ ...pool, recheckLeases: () => { rechecks += 1; return pool.recheckLeases(); } });
  };
  const m = await startMountedHost(t, { extra: { createPool: counting } });
  const { member, second } = await m.seed();
  const auth = m.context.clients.register(member.device_id);
  const created = await m.context.router.dispatch({ api_version: 1, operation: 'team.project.create',
    request_id: 'request_wired_create', client_id: auth.client_id, boot_epoch: m.context.bootEpoch, params: { name: 'Wired' } },
  { deviceId: member.device_id, clientToken: auth.client_token, isAuthenticated: () => true,
    actor: { member_id: member.member_id, device_id: member.device_id } });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.channel, true, 'the host\'s own chat store made the channel');
  assert.equal(m.context.events.events.events.filter((entry) => entry.type === 'team_project_changed').length, 1);
  const projectId = created.project_id;
  const before = rechecks;
  assert.equal((await m.store.addProjectMember({ actorMemberId: member.member_id, projectId, memberId: second.member_id,
    role: 'writer' })).ok, true);
  assert.equal(rechecks, before + 1);
  assert.equal((await m.store.removeProjectMember({ actorMemberId: second.member_id, projectId,
    memberId: second.member_id })).ok, true, 'a leave');
  assert.equal(rechecks, before + 2);
  assert.equal(m.context.directory.isDegraded(), false);
});

// Slice 3-6b: the real start opens the project audit before it serves (a file refused for its content is
// set aside by then) and the revoke fan-out drops a revoked device's viewing records.
test('the team host opens the project audit at start and drops the viewing records of a revoked device', BOUNDED, async (t) => {
  const m = await startMountedHost(t, { before: (fx) => fs.writeFileSync(path.join(fx.profile, PROJECT_AUDIT_FILE), 'not json') });
  const names = fs.readdirSync(m.fx.profile).filter((name) => name.startsWith('team-project-audit'));
  assert.equal(names.includes(PROJECT_AUDIT_FILE), false, 'the refused file is no longer the live log');
  assert.equal(names.length, 1, `set aside under a kept name: ${names}`);
  assert.equal(m.context.approvals.audit().floorSeq(), 1, 'a fresh log is open');
  const { member, second } = await m.seed();
  const { viewers } = m.context.approvals;
  const conversation = 'sess_1800000000000_aaaaaaaaaaaa';
  assert.equal(viewers.touch(conversation, member.device_id), true);
  assert.equal(viewers.touch(conversation, second.device_id), true);
  assert.equal((await m.store.revokeDevice({ actorMemberId: member.member_id, deviceId: member.device_id })).ok, true);
  assert.equal(viewers.isViewing(conversation, member.device_id), false);
  assert.equal(viewers.isViewing(conversation, second.device_id), true, 'another device is untouched');
});

test('a pool subscriber that throws marks the store degraded and the other subscribers still run', BOUNDED, async (t) => {
  const broken = (input) => Object.freeze({ ...createPoolComposition(input),
    recheckLeases: () => { throw new Error('boom'); } });
  const m = await startMountedHost(t, { withParent: true, extra: { createPool: broken } });
  const seats = await m.seed();
  const deviceId = seats.member.device_id;
  const clientAuth = m.context.clients.register(deviceId);
  m.context.leases.acquire('session_one', clientAuth.client_id, deviceId);
  const removed = await m.store.revokeMember({ actorMemberId: seats.owner.member_id, memberId: seats.member.member_id });
  assert.equal(removed.ok, true);
  assert.equal(m.context.leases.get('session_one'), null);
  assert.equal(m.context.clients.clients.size, 0);
  assert.equal(m.parent.sent.at(-1).kind, 'member_revoked');
  assert.equal(m.context.directory.isDegraded(), true);
  assert.equal(m.fx.logs.filter((entry) => entry.event === 'team_membership.subscriber_failed').length, 1);
});

test('--team-init on an empty store sends one owner invite after ready that names the host', async (t) => {
  const fx = createTeamHostFixture(t);
  const parent = fx.newParent();
  await fx.start(parent, { teamInit: true });
  assert.deepEqual(parent.sentTypes(), ['ready', 'reach', 'owner_invite']);
  const parsed = parseInvite(parent.sent[2].invite);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.host_public_key, fx.hostPublicKey);
  assert.deepEqual(parsed.hints, ['192.0.2.7:4242', '[2001:db8::7]:4242']);
  assert.equal(fx.context().store.snapshot().invites.length, 1);
});

test('--team-init with a member already present mints nothing, says owner_exists, and needs a parent channel', async (t) => {
  const fx = createTeamHostFixture(t);
  await fx.seedMembers(fx.client().deviceKey);
  const parent = fx.newParent();
  await fx.start(parent, { teamInit: true });
  assert.deepEqual(parent.sentTypes(), ['ready', 'reach', 'owner_exists']);
  assert.deepEqual(parent.sent.at(-1), { type: 'owner_exists' });

  const bare = createTeamHostFixture(t);
  await assert.rejects(bare.start(null, { teamInit: true }), (error) => error.reason === 'team_parent_required');
  assert.equal(bare.lock.acquired, 0, 'refused before the profile lock');
});

test('the parent stop message stops the host, sends stopped last and releases the lock once', async (t) => {
  const fx = createTeamHostFixture(t);
  const parent = fx.newParent();
  const host = await fx.start(parent);
  parent.emit({ type: 'stop' });
  await host.stopped;
  assert.deepEqual(parent.sentTypes(), ['ready', 'reach', 'stopped']);
  assert.equal(fx.lock.released, 1);
  assert.equal(fx.context().isReady(), false);
  assert.equal(await fx.isListening(host.port), false);
  assert.deepEqual(fx.backends[0].calls, ['start', 'stop', 'dispose']);
  const again = host.stop();
  assert.equal(again, host.stop());
  assert.equal(again, host.stopped);
  await again;
  assert.equal(fx.lock.released, 1);
  assert.deepEqual(parent.sentTypes(), ['ready', 'reach', 'stopped']);
});

test('losing the profile lock stops the host', async (t) => {
  const fx = createTeamHostFixture(t);
  const parent = fx.newParent();
  const host = await fx.start(parent);
  fx.lock.onLost();
  await host.stopped;
  assert.deepEqual(parent.sentTypes(), ['ready', 'reach', 'stopped']);
  assert.equal(fx.logs.filter((entry) => entry.event === 'team.profile_lock_lost').length, 1);
  assert.equal(fx.lock.released, 1);
  assert.equal(await fx.isListening(host.port), false);
});

test('a child whose exit is unconfirmed keeps the lock and reports the failure', async (t) => {
  const fx = createTeamHostFixture(t);
  const parent = fx.newParent();
  const unconfirmed = () => {
    const composition = fx.createBackend();
    composition.stop = async () => ({ exitConfirmed: false });
    return composition;
  };
  const host = await fx.start(parent, { createBackend: unconfirmed });
  await assert.rejects(host.stop(), (error) => error.message === 'host_child_exit_unconfirmed');
  assert.equal(fx.lock.released, 0);
  assert.deepEqual(parent.sent.at(-1), { type: 'error', reason: 'host_child_exit_unconfirmed' });
  assert.equal(parent.sentTypes().includes('stopped'), false);
});

test('a stop that arrives while the key is awaited cancels the start cleanly', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  const parent = fx.newParent();
  const starting = fx.start(parent, { keyTimeoutMs: 5000 });
  await waitFor(() => fx.lock.acquired === 1);
  parent.emit({ type: 'stop' });
  await assert.rejects(starting, (error) => error.reason === 'team_start_cancelled');
  assert.deepEqual(parent.sent, [{ type: 'stopped' }]);
  assert.equal(fx.lock.released, 1);
  assert.equal(fx.contexts.length, 0);
});

test('the seam carries exactly the agreed names and the team limits', async (t) => {
  const fx = createTeamHostFixture(t);
  await fx.start();
  const context = fx.context();
  // `approvals` (slice 3-6b) and `models` (slice 6-3): read by the start-up tests only; the listener ignores them.
  assert.deepEqual(Object.keys(context).sort(), [
    'addresses', 'approvals', 'assetRoutes', 'authorize', 'bootEpoch', 'bootSecret', 'bulkStreams', 'clients', 'config', 'directory', 'dropKey',
    'events', 'invites', 'isReady', 'leases', 'logger', 'models', 'notifyMembership', 'onMemberStream', 'resourceLimits', 'router',
    'sessionScope', 'store',
  ]);
  assert.equal(typeof context.sessionScope.identity, 'function', 'the event stream identity re-checks sessions (slice 3-3)');
  assert.equal(typeof context.onMemberStream, 'function', 'presence hears each member stream (slice 2a-3b)');
  assert.equal(Object.isFrozen(context), true);
  assert.equal(context.clients.capacity, 64);
  assert.equal(context.clients.perDeviceCapacity, 4);
  assert.equal(context.events.events.maxClients, 64);
  assert.equal(context.resourceLimits.maxConcurrentRequests, 64);
  assert.equal(context.bootSecret.length, 32);
  assert.deepEqual(context.addresses(), ['192.0.2.7:4242', '[2001:db8::7]:4242']);
  assert.equal(context.dropKey('not-a-key'), 0);
  assert.equal(context.dropKey(fx.hostPublicKey), 0);
  assert.doesNotThrow(() => context.notifyMembership('admitted', 'member_none'), 'no parent means nothing is sent');
});

test('the host key is zeroed on stop and no log line or parent message leaks a secret or a name', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  const client = fx.client();
  const seeded = await fx.seedMembers(client.deviceKey);
  const parent = fx.newParent();
  const starting = fx.start(parent, { teamInit: true });
  parent.emit({ type: 'start', host_key: fx.hostKey });
  const host = await starting;
  await fx.connect(client);
  await waitFor(() => fx.logs.some((entry) => entry.event === 'team.bridge.connection_admitted'));
  const context = fx.context();
  await context.store.revokeDevice({ actorMemberId: seeded.owner.member_id, deviceId: seeded.member.device_id });
  const secret = Buffer.from(context.bootSecret);
  await host.stop();
  assert.equal(context.bootSecret.every((byte) => byte === 0), true, 'the boot secret was zeroed');
  assert.equal(secret.some((byte) => byte !== 0), true);
  const logText = fx.logText();
  const parentText = JSON.stringify(parent.sent);
  const forbidden = [fx.hostKey, fx.teamName, 'Mika', 'Olive', '192.0.2.7', secret.toString('hex'), secret.toString('base64url')];
  for (const needle of forbidden) assert.equal(logText.includes(needle), false, `log leaks ${needle}`);
  assert.equal(parentText.includes(fx.hostKey), false);
  assert.equal(parent.sent.some((message) => message.type === 'owner_invite'), false, 'the store already had members');
  assert.equal(logText.includes('jteam1_'), false);
});

test('the owner invite string appears on the parent channel and in no log line', async (t) => {
  const fx = createTeamHostFixture(t);
  const parent = fx.newParent();
  await fx.start(parent, { teamInit: true });
  const { invite } = parent.sent.find((message) => message.type === 'owner_invite');
  assert.equal(invite.startsWith('jteam1_'), true);
  assert.equal(fx.logText().includes(invite), false);
  assert.equal(fx.logText().includes('jteam1_'), false);
  assert.equal(fx.logText().includes(fx.teamName), false);
});

// ------------------------------------------------------------ --team-recover

test('--team-recover sends one owner invite after ready that redeems as a recovery', async (t) => {
  const fx = createTeamHostFixture(t);
  const client = fx.client();
  const seeded = await fx.seedMembers(client.deviceKey);
  const parent = fx.newParent();
  await fx.start(parent, { teamRecover: true });
  assert.deepEqual(parent.sentTypes(), ['ready', 'reach', 'owner_invite']);
  const { invite } = parent.sent[2];
  const parsed = parseInvite(invite);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.host_public_key, fx.hostPublicKey);
  assert.deepEqual(parsed.hints, ['192.0.2.7:4242', '[2001:db8::7]:4242']);
  assert.equal(fx.logText().includes(invite), false);
  assert.equal(fx.logText().includes('jteam1_'), false);

  const { store } = fx.context();
  const { publicKey } = keyPairFromSeed(Buffer.from(parsed.invite_secret_key, 'base64url'));
  const minted = store.snapshot().invites.find((entry) => entry.invite_public_key === publicKey);
  assert.equal(minted.role, 'owner');
  assert.equal(minted.member_id, seeded.owner.member_id);
  assert.equal(minted.expires_at - minted.created_at, 15 * 60_000);
  const redeemed = await store.redeem({ inviteId: minted.invite_id, devicePublicKey: fx.client().deviceKey,
    displayName: 'ignored', label: 'New laptop' });
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.member_id, seeded.owner.member_id);
  assert.equal(store.listDevices(seeded.owner.member_id).find((d) => d.device_id === seeded.owner.device_id).state,
    'revoked');
});

test('--team-recover needs a parent channel and an owner; with no owner the start fails with the store reason', async (t) => {
  const bare = createTeamHostFixture(t);
  await bare.seedMembers(bare.client().deviceKey);
  await assert.rejects(bare.start(null, { teamRecover: true }), (error) => error.reason === 'team_parent_required');
  assert.equal(bare.lock.acquired, 0, 'refused before the profile lock');

  const empty = createTeamHostFixture(t);
  const parent = empty.newParent();
  await assert.rejects(empty.start(parent, { teamRecover: true }),
    (error) => error.reason === 'team_member_state_invalid');
  assert.deepEqual(parent.sentTypes(), ['ready', 'reach', 'error']);
  assert.deepEqual(parent.sent[2], { type: 'error', reason: 'team_member_state_invalid' });
  assert.equal(empty.lock.released, 1);
  assert.equal(empty.context().store.snapshot()?.invites.length ?? 0, 0);
});

// Slice 3-4b: a host with `projects_root`, an in-memory application project service that binds roots.
function projectsHost(t) {
  const fx = createTeamHostFixture(t);
  const projectsRoot = path.join(fs.realpathSync.native(fx.root), 'team-host', 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fx.writeConfig({ team: { projects_root: projectsRoot } });
  const records = new Map();
  let next = 0;
  const app = {
    records,
    createProject: ({ name }) => {
      const id = `project_${String(next += 1).padStart(32, '0')}`;
      records.set(id, { id, name, root_path: null, root_revision: 0 });
      return { ok: true, project: { ...records.get(id) } };
    },
    bindProjectRoot: ({ project_id: id, root_path: rootPath, expected_root_revision: expected }) => {
      const record = records.get(id);
      if (!record || record.root_revision !== expected) return { ok: false, error: { reason: 'stale_root_revision' } };
      Object.assign(record, { root_path: rootPath, root_revision: expected + 1 });
      return { ok: true, project: { ...record } };
    },
    listProjects: () => ({ ok: true, projects: [...records.values()].map((record) => ({ ...record })) }),
  };
  // The record remover is the backend's projectService, beside (not inside) the application service.
  const projectService = { remove: (id) => (records.delete(id) ? { ok: true } : { ok: false, reason: 'project_not_found' }) };
  const createBackend = (options) => {
    const composition = fx.createBackend(options);
    Object.assign(composition.backend, { projectApplicationService: app, projectService });
    return composition;
  };
  const openStore = () => new MemberStore({ userDataPath: fx.profile, hostPublicKey: fx.hostPublicKey, teamName: fx.teamName });
  return { fx, app, projectsRoot, trashRoot: path.join(path.dirname(projectsRoot), 'trash'), createBackend, openStore };
}

test('3-4b: the host makes its trash, reconciles before ready, and a create through the router binds a folder', BOUNDED, async (t) => {
  const p = projectsHost(t);
  const seeded = await p.fx.seedMembers(p.fx.client().deviceKey);
  // Left by a crash: a record with no team row, and a team row with no channel and no folder.
  const stranded = p.app.createProject({ name: 'Stranded' }).project.id;
  const halfMade = p.app.createProject({ name: 'Half' }).project.id;
  const store = p.openStore();
  assert.equal((await store.createProject({ actorMemberId: seeded.member.member_id, projectId: halfMade })).ok, true);
  const host = await p.fx.start(null, { createBackend: p.createBackend });
  assert.equal(fs.statSync(p.trashRoot).isDirectory(), true, 'the trash beside the projects root');
  assert.equal(p.app.records.has(stranded), false);
  assert.equal(p.app.records.get(halfMade).root_path, path.join(p.projectsRoot, halfMade));
  const line = p.fx.logs.find((entry) => entry.event === 'team_project.reconciled');
  assert.deepEqual([line.fields.records, line.fields.channels, line.fields.folders], [1, 1, 1]);
  const context = p.fx.context();
  const kinds = context.store.audit.read({ limit: 100 }).entries.filter((entry) => entry.kind === 'project_reconciled');
  assert.equal(kinds.length, 3);
  const auth = context.clients.register(seeded.member.device_id);
  const caller = { deviceId: seeded.member.device_id, clientToken: auth.client_token, isAuthenticated: () => true,
    actor: { member_id: seeded.member.member_id, device_id: seeded.member.device_id } };
  const send = (operation, requestId, params) => context.router.dispatch({ api_version: 1, operation, request_id: requestId,
    client_id: auth.client_id, boot_epoch: context.bootEpoch, params }, caller);
  const created = await send('team.project.create', 'request_rooted_create', { name: 'Rooted' });
  assert.deepEqual([created.ok, created.folder, created.channel], [true, true, true]);
  assert.equal(fs.statSync(path.join(p.projectsRoot, created.project_id)).isDirectory(), true);
  assert.equal(p.fx.logText().includes(p.projectsRoot), false);
  // Row 151 T1: the host's deleter has the board store, so the project's boards go with it (D29).
  const seededBoards = createTeamBoards({ userDataPath: fs.realpathSync.native(p.fx.profile) });
  assert.equal((await seededBoards.create({ projectId: created.project_id, actor: seeded.member.member_id, name: 'Plan' })).ok, true);
  const boardFolder = path.join(p.fx.profile, 'team-boards', created.project_id);
  assert.equal(fs.readdirSync(boardFolder).length, 2, 'a document and the index');
  const deleted = await send('team.project.delete', 'request_rooted_delete', { project_id: created.project_id });
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(fs.existsSync(boardFolder), false);
  await host.stop();
});

test('row 151 T1: a host with no projects_root still sweeps deleted boards on its timer, and stop clears it', BOUNDED, async (t) => {
  const fx = createTeamHostFixture(t);
  const stage = fs.mkdtempSync(path.join(fs.realpathSync.native(fx.profile), 'board-stage-')); // made aside, moved in whole
  const early = createTeamBoards({ userDataPath: stage, clock: () => Date.now() - 8 * 24 * 60 * 60 * 1000 });
  const expired = async (projectId) => {
    const board = (await early.create({ projectId, actor: 'member_seed', name: 'Old' })).board;
    assert.equal((await early.remove({ projectId, boardId: board.id, actor: 'member_seed' })).ok, true);
    fs.mkdirSync(path.join(fx.profile, 'team-boards'), { recursive: true });
    fs.renameSync(path.join(stage, 'team-boards', projectId), path.join(fx.profile, 'team-boards', projectId));
    return path.join(fx.profile, 'team-boards', projectId, `${board.id}.json`);
  };
  const host = await fx.start(null, { sweepIntervalMs: 5 });
  const document = await expired('project_swept'); // it arrives after the start: only a later tick can remove it
  await waitFor(() => !fs.existsSync(document));
  await host.stop();
  assert.equal(fx.logs.some((entry) => entry.event === 'team.board_sweep_failed'), false);
  const later = await expired('project_later');
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.equal(fs.existsSync(later), true, 'no sweep runs after stop');
});

test('row 151 T1: one sweep that hangs or throws does not hold the others, and none is started twice', BOUNDED, async () => {
  const calls = { hung: 0, thrown: 0, quick: 0 };
  const warned = [];
  const timer = startSweeps({ intervalMs: 5, warn: (event) => warned.push(event), tasks: [
    ['hung_failed', () => { calls.hung += 1; return new Promise(() => {}); }],
    ['thrown_failed', () => { calls.thrown += 1; throw new Error('boom'); }],
    ['quick_failed', async () => { calls.quick += 1; }]] });
  await waitFor(() => calls.quick >= 3 && calls.thrown >= 3);
  clearInterval(timer);
  const atStop = { ...calls };
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(calls, atStop, 'a cleared timer starts nothing');
  assert.equal(calls.hung, 1);
  assert.deepEqual([...new Set(warned)], ['thrown_failed']);
});

test('3-4b: the sweep is not awaited by start or stop, runs again on its timer, and stop clears the timer', BOUNDED, async (t) => {
  const p = projectsHost(t);
  // A sweep that never settles: ready and stop do not wait for it.
  const hung = { calls: 0 };
  const hanging = (input) => ({ ...createProjectFolders(input), sweepTrash: () => { hung.calls += 1; return new Promise(() => {}); } });
  const first = await p.fx.start(null, { createBackend: p.createBackend, createFolders: hanging, sweepIntervalMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(hung.calls, 1, 'a running sweep is never started twice');
  await first.stop();
  // A sweep that settles runs on each tick until stop, then never again.
  const quick = { calls: 0 };
  const settling = (input) => ({ ...createProjectFolders(input), sweepTrash: async () => { quick.calls += 1; return { ok: true }; } });
  const second = await p.fx.start(null, { createBackend: p.createBackend, createFolders: settling, sweepIntervalMs: 5 });
  await waitFor(() => quick.calls >= 3);
  await second.stop();
  const atStop = quick.calls;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(quick.calls, atStop, 'the timer is cleared at stop');
});

test('3-4b: a host with no projects_root starts with no folder module work and no sweep', BOUNDED, async (t) => {
  const fx = createTeamHostFixture(t);
  const swept = { calls: 0 };
  const counting = (input) => {
    assert.deepEqual([input.projectsRoot, input.trashRoot], [null, null]);
    return { ...createProjectFolders(input), sweepTrash: async () => { swept.calls += 1; return { ok: true }; } };
  };
  const host = await fx.start(null, { createFolders: counting, sweepIntervalMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(swept.calls, 0);
  await host.stop();
});
