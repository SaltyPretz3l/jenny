'use strict';

// Slice 1h: the local owner invites. `team-init` and `team-recover` run with the
// server stopped, take the profile lock, mint through the real invite service
// over the real member store and print the string once on a terminal.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parseInvite, keyPairFromSeed } = require('../../server/team/invites');
const { MemberStore } = require('../../server/team/member-store');
const {
  createOutputStream, createTeamHostFixture, randomKey, writeSingleOwnerConfig,
} = require('./helpers/team-host-fixture');

const MINUTE = 60_000;
const INTERFACES = () => ({
  eth0: [{ family: 'IPv4', address: '192.168.1.20', internal: false },
    { family: 'IPv6', address: 'fe80::1', internal: false }],
  wlan0: [{ family: 4, address: '10.0.0.5', internal: false }],
  lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
});

const terminal = (options = {}) => createOutputStream({ isTTY: true, ...options });

function mint(fx, kind, extra = {}) {
  const logs = [];
  const output = extra.output ?? terminal();
  const { mintLocalOwnerInvite } = require('../../server/team/recovery');
  const run = mintLocalOwnerInvite({
    kind, configPath: fx.configPath, output, acquireProfileImpl: fx.acquireProfileImpl,
    networkInterfaces: INTERFACES, logger: (...entry) => logs.push(entry), ...extra,
  });
  return run.then((result) => ({ result, output, logs }));
}

// Every file under a directory, by relative path, as bytes.
function snapshotFiles(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(root, full)] = fs.readFileSync(full);
    }
  };
  walk(root);
  return files;
}

function invitesIn(text) {
  return text.match(/jteam1_[A-Za-z0-9_-]+/gu) ?? [];
}

function storeAt(fx, clock) {
  const store = new MemberStore({ userDataPath: fx.profile, hostPublicKey: fx.hostPublicKey, teamName: fx.teamName, clock });
  assert.equal(store.open().ok, true);
  return store;
}

function inviteIdOf(store, parsed) {
  const { publicKey } = keyPairFromSeed(Buffer.from(parsed.invite_secret_key, 'base64url'));
  return store.snapshot().invites.find((invite) => invite.invite_public_key === publicKey).invite_id;
}

// The invite string and its secret appear nowhere but the terminal.
function assertOnlyOnTerminal(fx, { result, output, logs }, invite) {
  const parsed = parseInvite(invite);
  assert.equal(invitesIn(output.text()).length, 1, 'printed exactly once');
  assert.equal(output.text().split(invite).length, 2);
  const secret = parsed.invite_secret_key;
  for (const text of [JSON.stringify(logs), JSON.stringify(result)]) {
    assert.equal(text.includes(invite), false);
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes('jteam1_'), false);
  }
  const raw = Buffer.from(secret, 'base64url');
  for (const root of [fx.profile, fx.secrets]) {
    for (const [name, bytes] of Object.entries(snapshotFiles(root))) {
      assert.equal(bytes.includes(invite), false, name);
      assert.equal(bytes.includes(secret), false, name);
      assert.equal(bytes.includes(raw), false, name);
    }
  }
  for (const [, , fields] of logs) assert.equal(JSON.stringify(fields ?? {}).includes(fx.teamName), false);
}

test('team-init on an empty store prints one owner invite that redeems until 15 minutes', async (t) => {
  const fx = createTeamHostFixture(t, { directPort: 4242 });
  const t0 = Date.now();
  const minted = await mint(fx, 'owner_first', { clock: () => t0 });
  assert.equal(minted.result.ok, true);
  assert.equal(minted.result.expires_at, t0 + 15 * MINUTE);
  assert.equal(fx.lock.acquired, 1);
  assert.equal(fx.lock.released, 1);
  const [invite] = invitesIn(minted.output.text());
  assertOnlyOnTerminal(fx, minted, invite);
  const parsed = parseInvite(invite);
  assert.equal(parsed.host_public_key, fx.hostPublicKey);
  assert.deepEqual(parsed.hints, ['192.168.1.20:4242', '10.0.0.5:4242']);
  assert.match(minted.output.text(), new RegExp(new Date(t0 + 15 * MINUTE).toISOString(), 'u'));

  const late = storeAt(fx, () => t0 + 15 * MINUTE);
  const input = { inviteId: inviteIdOf(late, parsed), devicePublicKey: randomKey(), displayName: 'Olive', label: 'Laptop' };
  assert.equal((await late.redeem(input)).error.reason, 'invite_not_valid');
  const inTime = storeAt(fx, () => t0 + 15 * MINUTE - 1);
  const redeemed = await inTime.redeem(input);
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.role, 'owner');
  assert.equal(redeemed.state, 'active');
});

test('team-recover revokes the owner\'s other devices and adds the new one', async (t) => {
  const fx = createTeamHostFixture(t);
  const { owner, member } = await fx.seedMembers(randomKey());
  const t0 = Date.now();
  const minted = await mint(fx, 'recovery', { clock: () => t0 });
  assert.equal(minted.result.ok, true);
  const [invite] = invitesIn(minted.output.text());
  assertOnlyOnTerminal(fx, minted, invite);
  const parsed = parseInvite(invite);
  assert.deepEqual(parsed.hints, [], 'direct_port is null: no hints');
  assert.match(minted.output.text(), /no address hints/iu);
  assert.equal(minted.output.text().includes(fx.teamName), false);

  const store = storeAt(fx, () => t0 + 15 * MINUTE - 1);
  const redeemed = await store.redeem({ inviteId: inviteIdOf(store, parsed), devicePublicKey: randomKey(),
    displayName: 'ignored', label: 'New laptop' });
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.member_id, owner.member_id);
  const devices = store.listDevices(owner.member_id);
  assert.deepEqual(devices.map((device) => [device.device_id, device.state]),
    [[owner.device_id, 'revoked'], [redeemed.device_id, 'active']]);
  assert.equal(store.listDevices(member.member_id)[0].state, 'active');
  const kinds = store.audit.read({ limit: 100 }).entries.map((entry) => entry.kind);
  assert.equal(kinds.includes('recovery_used'), true);
  const expired = storeAt(fx, () => t0 + 15 * MINUTE);
  assert.equal(expired.isInviteLive(redeemed.invite_id), false);
});

test('a recovery invite is invite_not_valid at 15 minutes', async (t) => {
  const fx = createTeamHostFixture(t, { directPort: 4242 });
  await fx.seedMembers(randomKey());
  const t0 = Date.now();
  const minted = await mint(fx, 'recovery', { clock: () => t0 });
  const parsed = parseInvite(invitesIn(minted.output.text())[0]);
  assert.deepEqual(parsed.hints, ['192.168.1.20:4242', '10.0.0.5:4242']);
  const store = storeAt(fx, () => t0 + 15 * MINUTE);
  const answer = await store.redeem({ inviteId: inviteIdOf(store, parsed), devicePublicKey: randomKey(),
    displayName: 'ignored', label: 'New laptop' });
  assert.equal(answer.error.reason, 'invite_not_valid');
});

test('team-init refuses when a member exists and team-recover refuses on an empty store', async (t) => {
  const seeded = createTeamHostFixture(t);
  await seeded.seedMembers(randomKey());
  const before = snapshotFiles(seeded.profile);
  const init = await mint(seeded, 'owner_first');
  assert.deepEqual(init.result, { ok: false, reason: 'team_member_state_invalid' });
  assert.deepEqual(snapshotFiles(seeded.profile), before);
  assert.equal(init.output.text(), '');
  assert.equal(seeded.lock.released, seeded.lock.acquired);

  const empty = createTeamHostFixture(t);
  const recover = await mint(empty, 'recovery');
  assert.deepEqual(recover.result, { ok: false, reason: 'team_member_state_invalid' });
  assert.deepEqual(snapshotFiles(empty.profile), {});
  assert.equal(recover.output.text(), '');
  assert.equal(empty.lock.released, 1);
});

test('a held profile lock refuses with nothing minted, printed or rewritten', async (t) => {
  const fx = createTeamHostFixture(t);
  await fx.seedMembers(randomKey());
  const before = snapshotFiles(fx.profile);
  const held = () => {
    throw Object.assign(new Error('Profile is locked or locking is unavailable.'), { code: 'CMP-HOST-0004', reason: 'profile_locked' });
  };
  const refused = await mint(fx, 'recovery', { acquireProfileImpl: held });
  assert.deepEqual(refused.result, { ok: false, reason: 'team_profile_locked' });
  assert.deepEqual(snapshotFiles(fx.profile), before);
  assert.equal(refused.output.text(), '');
});

test('the real profile lock: a held lock refuses, and a mint lets the lock go', {
  skip: process.platform !== 'win32' && 'the POSIX lock needs the Python flock helper',
}, async (t) => {
  const fx = createTeamHostFixture(t);
  const { acquireConfiguredProfile } = require('../../server/host-core');
  // The real lock claims the profile for the server first (a profile with data
  // and no claim reads as a desktop profile); then the team is seeded.
  await (await acquireConfiguredProfile(fx.configPath)).lock.release();
  await fx.seedMembers(randomKey());
  const holder = await acquireConfiguredProfile(fx.configPath);
  const before = snapshotFiles(fx.profile);
  const refused = await mint(fx, 'recovery', { acquireProfileImpl: undefined });
  assert.deepEqual(refused.result, { ok: false, reason: 'team_profile_locked' });
  assert.deepEqual(snapshotFiles(fx.profile), before);
  assert.equal(refused.output.text(), '');
  await holder.lock.release();

  const first = await mint(fx, 'recovery', { acquireProfileImpl: undefined });
  assert.equal(first.result.ok, true);
  const second = await acquireConfiguredProfile(fx.configPath);
  await second.lock.release();
});

test('an output that is not a terminal refuses before the lock and before anything is minted', async (t) => {
  const fx = createTeamHostFixture(t);
  await fx.seedMembers(randomKey());
  const before = snapshotFiles(fx.profile);
  for (const kind of ['recovery', 'owner_first']) {
    const piped = await mint(fx, kind, { output: terminal({ isTTY: false }) });
    assert.deepEqual(piped.result, { ok: false, reason: 'team_tty_required' });
    assert.equal(piped.output.text(), '');
  }
  const none = await mint(fx, 'recovery', { output: null });
  assert.deepEqual(none.result, { ok: false, reason: 'team_tty_required' });
  assert.equal(fx.lock.acquired, 0);
  assert.deepEqual(snapshotFiles(fx.profile), before);
});

test('a wrong config or key is refused with nothing rewritten and the lock released', async (t) => {
  const fx = createTeamHostFixture(t);
  await fx.seedMembers(randomKey());
  const before = snapshotFiles(fx.profile);
  const goodKey = fs.readFileSync(fx.keyFile);
  const cases = [
    ['parent_channel config', () => fx.writeConfig({ source: 'parent_channel' }), 'team_key_source_invalid'],
    ['missing key file', () => fs.rmSync(fx.keyFile), 'team_host_key_invalid'],
    ['malformed key file', () => fx.writeKeyFile('not-a-key'), 'team_host_key_invalid'],
    ['short key', () => fx.writeKeyFile(Buffer.alloc(16, 1).toString('base64url')), 'team_host_key_invalid'],
    ['a key the store does not know', () => fx.writeKeyFile(randomKey()), 'team_host_key_mismatch'],
  ];
  for (const [label, arrange, reason] of cases) {
    fx.writeConfig();
    fs.writeFileSync(fx.keyFile, goodKey);
    arrange();
    for (const kind of ['recovery', 'owner_first']) {
      const refused = await mint(fx, kind);
      assert.deepEqual(refused.result, { ok: false, reason }, `${label} ${kind}`);
      assert.equal(refused.output.text(), '', label);
      assert.deepEqual(snapshotFiles(fx.profile), before, label);
      assert.equal(fx.lock.released, fx.lock.acquired, label);
    }
  }
  const single = writeSingleOwnerConfig(fx.root);
  const noTeam = await mint(fx, 'recovery', { configPath: single });
  assert.deepEqual(noTeam.result, { ok: false, reason: 'team_config_required' });
  assert.equal(fx.lock.released, fx.lock.acquired);
  const unknownKind = await mint(fx, 'add_device');
  assert.equal(unknownKind.result.ok, false);
});

test('the lock is released when the mint throws, and a throwing logger changes nothing', async (t) => {
  const fx = createTeamHostFixture(t);
  await fx.seedMembers(randomKey());
  const before = snapshotFiles(fx.profile);
  const thrown = await mint(fx, 'recovery', { randomBytes: () => { throw new Error('entropy gone'); } });
  assert.deepEqual(thrown.result, { ok: false, reason: 'team_unavailable' });
  assert.equal(fx.lock.acquired, 1);
  assert.equal(fx.lock.released, 1);
  assert.deepEqual(snapshotFiles(fx.profile), before);
  assert.equal(thrown.output.text(), '');

  const loud = await mint(fx, 'recovery', { logger: () => { throw new Error('log sink down'); } });
  assert.equal(loud.result.ok, true);
  assert.equal(invitesIn(loud.output.text()).length, 1);
  assert.equal(fx.lock.released, fx.lock.acquired);
});

test('only a busy lock reads as team_profile_locked: other lock refusals are team_unavailable', async (t) => {
  const fx = createTeamHostFixture(t);
  await fx.seedMembers(randomKey());
  const before = snapshotFiles(fx.profile);
  const throwing = (error) => () => { throw error; };
  const cases = [
    // services/host/profile-ownership.js ownershipError: CONFLICT with no reason.
    Object.assign(new Error('desktop_profile_requires_import'), { code: 'CMP-HOST-0004' }),
    Object.assign(new Error('invalid_host_profile'), { code: 'CMP-HOST-0004' }),
    Object.assign(new Error('Profile lock could not be created.'), { code: 'CMP-HOST-0005' }),
    new Error('anything else'),
  ];
  for (const error of cases) {
    const refused = await mint(fx, 'recovery', { acquireProfileImpl: throwing(error) });
    assert.deepEqual(refused.result, { ok: false, reason: 'team_unavailable' }, error.message);
    assert.equal(refused.output.text(), '');
  }
  assert.deepEqual(snapshotFiles(fx.profile), before);
});

test('the real lock on a profile the server never claimed answers team_unavailable', {
  skip: process.platform !== 'win32' && 'the POSIX lock needs the Python flock helper',
}, async (t) => {
  const fx = createTeamHostFixture(t);
  // Store files and no server claim: the ownership check reads it as a desktop profile.
  await fx.seedMembers(randomKey());
  const before = snapshotFiles(fx.profile);
  const refused = await mint(fx, 'recovery', { acquireProfileImpl: undefined });
  assert.deepEqual(refused.result, { ok: false, reason: 'team_unavailable' });
  assert.deepEqual(snapshotFiles(fx.profile), before);
});

test('a failed print revokes the invite it minted: nothing live is left and no log holds the string', async (t) => {
  const fx = createTeamHostFixture(t);
  await fx.seedMembers(randomKey());
  const output = terminal({ failWrites: true });
  const failed = await mint(fx, 'recovery', { output });
  assert.deepEqual(failed.result, { ok: false, reason: 'team_unavailable' });
  assert.equal(fx.lock.released, fx.lock.acquired);
  const store = storeAt(fx, Date.now);
  const minted = store.snapshot().invites.filter((invite) => invite.role === 'owner' && invite.member_id !== null);
  assert.equal(minted.length, 1);
  assert.notEqual(minted[0].revoked_at, null, 'the unprinted invite was revoked');
  assert.equal(store.snapshot().invites.some((invite) => store.isInviteLive(invite.invite_id)), false);
  const kinds = store.audit.read({ limit: 100 }).entries.map((entry) => entry.kind);
  assert.equal(kinds.at(-1), 'invite_revoked');
  assert.equal(JSON.stringify(failed.logs).includes('jteam1_'), false);

  // The first-owner kind on an empty team, where no member exists to revoke it.
  const empty = createTeamHostFixture(t);
  const first = await mint(empty, 'owner_first', { output: terminal({ failWrites: true }) });
  assert.deepEqual(first.result, { ok: false, reason: 'team_unavailable' });
  const emptyStore = storeAt(empty, Date.now);
  assert.equal(emptyStore.snapshot().invites.length, 1);
  assert.equal(emptyStore.isInviteLive(emptyStore.snapshot().invites[0].invite_id), false);
});

test('the local revoke (actor exactly null) reaches only an invite a local command minted', async (t) => {
  const fx = createTeamHostFixture(t);
  const { owner } = await fx.seedMembers(randomKey());
  const store = storeAt(fx, Date.now);
  const member = await store.createInvite({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member',
    invitePublicKey: randomKey() });
  assert.equal(member.ok, true);
  for (const actorMemberId of [null, undefined]) {
    const refused = await store.revokeInvite({ actorMemberId, inviteId: member.invite_id });
    assert.equal(refused.ok, false, String(actorMemberId));
  }
  assert.equal(store.isInviteLive(member.invite_id), true);
  const local = await store.createInvite({ kind: 'recovery', actorMemberId: null, invitePublicKey: randomKey() });
  assert.equal((await store.revokeInvite({ actorMemberId: undefined, inviteId: local.invite_id })).ok, false);
  assert.equal((await store.revokeInvite({ actorMemberId: null, inviteId: local.invite_id })).ok, true);
  assert.equal((await store.revokeInvite({ actorMemberId: null, inviteId: local.invite_id })).error.reason,
    'invite_not_valid', 'a spent or revoked invite cannot be revoked again');
});

test('a config that changes between the preflight and the locked load is re-checked and the lock let go', async (t) => {
  const fx = createTeamHostFixture(t);
  await fx.seedMembers(randomKey());
  const before = snapshotFiles(fx.profile);
  const swapThenLock = (swap) => (input) => { swap(); return fx.acquireProfileImpl(input); };

  const toParent = await mint(fx, 'recovery', { acquireProfileImpl: swapThenLock(() => fx.writeConfig({ source: 'parent_channel' })) });
  assert.deepEqual(toParent.result, { ok: false, reason: 'team_key_source_invalid' });
  assert.equal(fx.lock.acquired, 1);
  assert.equal(fx.lock.released, 1);

  fx.writeConfig();
  const dropTeam = () => {
    const source = JSON.parse(fs.readFileSync(fx.configPath, 'utf8'));
    delete source.team;
    fs.writeFileSync(fx.configPath, JSON.stringify({ ...source, schema_version: 2, port: 8080,
      browser_access_mode: 'localhost_http', canonical_origin: 'http://127.0.0.1:8080' }));
  };
  const noTeam = await mint(fx, 'recovery', { acquireProfileImpl: swapThenLock(dropTeam) });
  assert.deepEqual(noTeam.result, { ok: false, reason: 'team_config_required' });
  assert.equal(fx.lock.acquired, 2);
  assert.equal(fx.lock.released, 2);
  assert.equal(noTeam.output.text(), '');
  assert.deepEqual(snapshotFiles(fx.profile), before);
});
