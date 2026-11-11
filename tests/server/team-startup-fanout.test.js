'use strict';

// Team slice 1c-1b: the revoke fan-out, the owner bootstrap, stop, the seam's
// limits and redaction. Same fakes as team-startup.test.js.

const assert = require('node:assert/strict');
const test = require('node:test');

const { keyPairFromSeed, parseInvite } = require('../../server/team/invites');
const { waitFor } = require('./helpers/fake-team-transport');
const { createTeamHostFixture } = require('./helpers/team-host-fixture');

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

test('revoking a device closes its connection, clients, leases and streams and tells the parent', async (t) => {
  const { context, parent, seeded, deviceId, closed, revoked } = await startWithMember(t);
  assert.equal(context.clients.clients.size, 1);
  const result = await context.store.revokeDevice({ actorMemberId: seeded.owner.member_id, deviceId });
  assert.equal(result.ok, true);
  assert.deepEqual(await closed, { refused: true });
  assert.equal(context.clients.clients.size, 0);
  assert.equal(context.leases.get('session_one'), null);
  assert.deepEqual(revoked, [deviceId]);
  assert.deepEqual(parent.sent.at(-1), { type: 'membership_changed', kind: 'device_revoked', member_id: seeded.member.member_id });
  assert.equal(context.directory.isDegraded(), false);
});

test('a subscriber that throws marks the store degraded and the later subscribers still run', async (t) => {
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

test('a role change revokes leases only; revoking a member covers every device', async (t) => {
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

test('--team-init on an empty store sends one owner invite after ready that names the host', async (t) => {
  const fx = createTeamHostFixture(t);
  const parent = fx.newParent();
  await fx.start(parent, { teamInit: true });
  assert.deepEqual(parent.sentTypes(), ['ready', 'owner_invite']);
  const parsed = parseInvite(parent.sent[1].invite);
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
  assert.deepEqual(parent.sentTypes(), ['ready', 'owner_exists']);
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
  assert.deepEqual(parent.sentTypes(), ['ready', 'stopped']);
  assert.equal(fx.lock.released, 1);
  assert.equal(fx.context().isReady(), false);
  assert.equal(await fx.isListening(host.port), false);
  assert.deepEqual(fx.backends[0].calls, ['start', 'stop', 'dispose']);
  const again = host.stop();
  assert.equal(again, host.stop());
  assert.equal(again, host.stopped);
  await again;
  assert.equal(fx.lock.released, 1);
  assert.deepEqual(parent.sentTypes(), ['ready', 'stopped']);
});

test('losing the profile lock stops the host', async (t) => {
  const fx = createTeamHostFixture(t);
  const parent = fx.newParent();
  const host = await fx.start(parent);
  fx.lock.onLost();
  await host.stopped;
  assert.deepEqual(parent.sentTypes(), ['ready', 'stopped']);
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
  assert.deepEqual(Object.keys(context).sort(), [
    'addresses', 'assetRoutes', 'authorize', 'bootEpoch', 'bootSecret', 'clients', 'config', 'directory', 'dropKey',
    'events', 'invites', 'isReady', 'leases', 'logger', 'notifyMembership', 'onMemberStream', 'resourceLimits', 'router',
    'store',
  ]);
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
  assert.deepEqual(parent.sentTypes(), ['ready', 'owner_invite']);
  const { invite } = parent.sent[1];
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
  assert.deepEqual(parent.sentTypes(), ['ready', 'error']);
  assert.deepEqual(parent.sent[1], { type: 'error', reason: 'team_member_state_invalid' });
  assert.equal(empty.lock.released, 1);
  assert.equal(empty.context().store.snapshot()?.invites.length ?? 0, 0);
});
