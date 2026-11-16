'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { createFixture } = require('./helpers/team-store-fixture');
const { LOCAL_COMMAND } = require('../../server/team/member-schema');
const { mintOwnerInvite, mintRecoveryInvite } = require('../../server/team/owner-bootstrap');
const {
  MAX_INVITE_CHARS, SLOT_MS, createInviteService, encodeInvite, keyPairFromSeed, parseInvite,
} = require('../../server/team/invites');

function setup(t) {
  const fx = createFixture(t);
  const store = fx.openStore();
  const invites = createInviteService({
    store, clock: fx.clock, randomBytes: fx.randomBytes, logger: fx.logger,
  });
  return { fx, store, invites };
}

async function ownerWithService(t) {
  const context = setup(t);
  const created = await context.invites.create({ kind: 'owner_first', actorMemberId: LOCAL_COMMAND });
  assert.equal(created.ok, true);
  const revealed = context.invites.reveal(created.invite_id);
  assert.equal(revealed.ok, true);
  const owner = { key: context.fx.nextKey('owner-device') };
  const redeemed = await context.invites.redeem({
    inviteId: created.invite_id, devicePublicKey: owner.key, displayName: 'Olive Owner', label: 'Owner laptop',
  });
  assert.equal(redeemed.ok, true);
  return { ...context, owner: { ...owner, member_id: redeemed.member_id, device_id: redeemed.device_id } };
}

const NOT_VALID = { ok: false, error: { code: 'CMP-HOST-0003', reason: 'invite_not_valid', retryable: false } };

// ---------------------------------------------------------------- the string

test('the invite string round-trips: host key, secret key and up to four hints', (t) => {
  const fx = createFixture(t);
  const secret = fx.key('secret');
  const hints = ['192.168.1.20:41234', '[fd00::1234:5678]:9000', '10.0.0.7:1', '[2001:db8::]:65535'];
  const encoded = encodeInvite({ hostPublicKey: fx.hostKey, inviteSecretKey: secret, hints });
  assert.equal(encoded.ok, true);
  assert.ok(encoded.invite.startsWith('jteam1_'));
  assert.ok(encoded.invite.length <= MAX_INVITE_CHARS);
  const parsed = parseInvite(encoded.invite);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.host_public_key, fx.hostKey);
  assert.equal(parsed.invite_secret_key, secret);
  assert.deepEqual(parsed.hints, hints);
  assert.match(parsed.team_id, /^team_/u);
  // No hints is fine, too.
  assert.deepEqual(parseInvite(encodeInvite({ hostPublicKey: fx.hostKey, inviteSecretKey: secret }).invite).hints, []);
});

test('four IPv6 hints still fit in 256 characters; five hints and bad hints are refused', (t) => {
  const fx = createFixture(t);
  const hints = Array.from({ length: 4 }, (_unused, index) => `[2001:db8:1:2:3:4:5:${index + 1}]:5000${index}`);
  const full = encodeInvite({ hostPublicKey: fx.hostKey, inviteSecretKey: fx.key('s'), hints });
  assert.equal(full.ok, true);
  assert.ok(full.invite.length <= MAX_INVITE_CHARS);
  for (const bad of [
    [...hints, '10.0.0.1:1'],
    ['10.0.0.1'],
    ['10.0.0.1:0'],
    ['10.0.0.1:65536'],
    ['999.0.0.1:80'],
    ['01.0.0.1:80'],
    ['example.com:80'],
    ['[fe80::1%eth0]:80'],
    ['[::ffff:1.2.3.4]:80'],
    [42],
  ]) {
    const result = encodeInvite({ hostPublicKey: fx.hostKey, inviteSecretKey: fx.key('s'), hints: bad });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.error.reason, 'team_invite_malformed');
  }
});

test('a corrupted checksum, truncation, wrong prefix or junk is refused as team_invite_malformed', (t) => {
  const fx = createFixture(t);
  const { invite } = encodeInvite({
    hostPublicKey: fx.hostKey, inviteSecretKey: fx.key('s'), hints: ['192.168.1.20:41234'],
  });
  const flip = (text, index) => {
    const chars = [...text];
    chars[index] = chars[index] === 'A' ? 'B' : 'A';
    return chars.join('');
  };
  const cases = [
    flip(invite, 12),
    flip(invite, invite.length - 1),
    invite.slice(0, -2),
    invite.slice(0, -1),
    `${invite}A`,
    invite.replace('jteam1_', 'jteam2_'),
    `x${invite}`,
    invite.replace('jteam1_', ''),
    'jteam1_',
    'jteam1_!!!!',
    `jteam1_${'A'.repeat(300)}`,
    '',
    null,
    42,
    { invite },
  ];
  for (const bad of cases) {
    const result = parseInvite(bad);
    assert.equal(result.ok, false, String(bad).slice(0, 30));
    assert.equal(result.error.reason, 'team_invite_malformed');
    assert.equal(result.error.code, 'CMP-HOST-0001');
    assert.equal(JSON.stringify(result).includes(String(invite)), false, 'the failure does not echo the string');
  }
});

// ---------------------------------------------------------------- the service

test('create returns only an id and an expiry; the store keeps the public key, never the secret', async (t) => {
  const { fx, store, invites } = await ownerWithService(t);
  const created = await invites.create({
    kind: 'new_member', actorMemberId: store.snapshot().members[0].member_id, role: 'read_only',
  });
  assert.deepEqual(Object.keys(created).sort(), ['expires_at', 'invite_id', 'ok']);
  assert.equal(created.expires_at, fx.clock() + 24 * 60 * 60 * 1000);
  const revealed = invites.reveal(created.invite_id);
  const parsed = parseInvite(revealed.invite);
  const record = store.getInvite(created.invite_id);
  assert.equal(record.role, 'read_only');
  assert.equal(keyPairFromSeed(Buffer.from(parsed.invite_secret_key, 'base64url')).publicKey, record.invite_public_key);
  const disk = fs.readFileSync(fx.memberFile, 'utf8') + fs.readFileSync(fx.auditFile, 'utf8');
  assert.equal(disk.includes(parsed.invite_secret_key), false, 'the secret never reaches the disk');
  assert.equal(disk.includes(revealed.invite), false);
  assert.equal(JSON.stringify(store.snapshot()).includes(parsed.invite_secret_key), false);
  assert.equal(parsed.host_public_key, store.hostPublicKey());
});

test('reveal returns the invite string once; a second reveal and an unknown id fail the same way', async (t) => {
  const { store, invites, owner } = await ownerWithService(t);
  const created = await invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  assert.equal(invites.pendingSlots(), 1);
  const first = invites.reveal(created.invite_id);
  assert.equal(first.ok, true);
  assert.equal(parseInvite(first.invite).ok, true);
  assert.equal(invites.pendingSlots(), 0, 'the slot is cleared by the reveal');
  const second = invites.reveal(created.invite_id);
  const unknown = invites.reveal('invite_neverexisted');
  assert.deepEqual(second, NOT_VALID);
  assert.deepEqual(unknown, NOT_VALID);
  assert.deepEqual(invites.reveal(undefined), NOT_VALID);
  assert.equal(store.isInviteLive(created.invite_id), true, 'the invite itself is still redeemable');
});

test('an unrevealed slot expires after ten minutes and a lost slot looks like an unknown id', async (t) => {
  const { fx, invites, owner } = await ownerWithService(t);
  const created = await invites.create({ kind: 'add_device', actorMemberId: owner.member_id });
  fx.advance(SLOT_MS - 1);
  assert.equal(invites.pendingSlots(), 1);
  fx.advance(2);
  assert.deepEqual(invites.reveal(created.invite_id), NOT_VALID);
  assert.equal(invites.pendingSlots(), 0);
  // A fresh service (host restart) has no slots at all.
  const restarted = createInviteService({ store: setup(t).store, clock: fx.clock, randomBytes: fx.randomBytes });
  assert.deepEqual(restarted.reveal(created.invite_id), NOT_VALID);
});

test('a revoked, redeemed or expired invite cannot be revealed', async (t) => {
  const { fx, invites, owner } = await ownerWithService(t);
  const revoked = await invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  assert.equal((await invites.revoke({ actorMemberId: owner.member_id, inviteId: revoked.invite_id })).ok, true);
  assert.deepEqual(invites.reveal(revoked.invite_id), NOT_VALID);

  const used = await invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  const redeemed = await invites.redeem({
    inviteId: used.invite_id, devicePublicKey: fx.nextKey(), displayName: 'Rae', label: 'Desk',
  });
  assert.equal(redeemed.ok, true);
  assert.deepEqual(invites.reveal(used.invite_id), NOT_VALID);

  const short = await invites.create({ kind: 'add_device', actorMemberId: owner.member_id, ttlMs: 60_000 });
  fx.advance(61_000);
  assert.deepEqual(invites.reveal(short.invite_id), NOT_VALID);
});

test('create refuses bad hints and passes the store failures through', async (t) => {
  const { invites, owner } = await ownerWithService(t);
  const badHints = await invites.create({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', hints: ['not an address'],
  });
  assert.equal(badHints.error.reason, 'team_invite_malformed');
  const fiveHints = await invites.create({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', hints: Array(5).fill('10.0.0.1:80'),
  });
  assert.equal(fiveHints.error.reason, 'team_invite_malformed');
  const tooLong = await invites.create({
    kind: 'add_device', actorMemberId: owner.member_id, ttlMs: 16 * 60 * 1000,
  });
  assert.equal(tooLong.error.reason, 'team_invite_ttl_invalid');
  assert.equal(invites.pendingSlots(), 0, 'a refused create leaves no slot');
});

// ------------------------------------------------------- redeem and burn

test('redeem burns the invite: two concurrent redeems let exactly one win', async (t) => {
  const { fx, store, invites, owner } = await ownerWithService(t);
  const created = await invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  const attempt = (name) => invites.redeem({
    inviteId: created.invite_id, devicePublicKey: fx.nextKey(), displayName: name, label: 'Desk',
  });
  const results = await Promise.all([attempt('First Rae'), attempt('Second Rae')]);
  const won = results.filter((result) => result.ok);
  const lost = results.filter((result) => !result.ok);
  assert.equal(won.length, 1);
  assert.deepEqual(lost, [NOT_VALID]);
  assert.equal(store.snapshot().members.length, 2, 'owner plus exactly one new member');
  assert.equal(store.getInvite(created.invite_id).used_at, fx.clock());
  // And a later retry of the winner is refused too.
  assert.deepEqual(await attempt('Third Rae'), NOT_VALID);
});

test('redeem is single-use across many concurrent attempts on all invite kinds', async (t) => {
  const { fx, store, invites, owner } = await ownerWithService(t);
  const device = await invites.create({ kind: 'add_device', actorMemberId: owner.member_id });
  const results = await Promise.all(Array.from({ length: 6 }, () => invites.redeem({
    inviteId: device.invite_id, devicePublicKey: fx.nextKey(), displayName: 'x', label: 'Phone',
  })));
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(store.snapshot().devices.length, 2);
});

test('an invite key is admitted while live and refused once used, revoked or expired', async (t) => {
  const { fx, store, invites, owner } = await ownerWithService(t);
  const publicKeyOf = (invite) => keyPairFromSeed(
    Buffer.from(parseInvite(invites.reveal(invite.invite_id).invite).invite_secret_key, 'base64url'),
  ).publicKey;

  const live = await invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  const liveKey = publicKeyOf(live);
  assert.equal(store.directory.admitKind(liveKey), 'invite');
  assert.deepEqual(store.directory.resolveActor(liveKey), {
    member_id: null, device_id: live.invite_id, role: 'invite', state: 'pending',
  });
  assert.deepEqual(store.directory.liveActor(live.invite_id), store.directory.resolveActor(liveKey));
  assert.equal(store.directory.isDeviceActive(live.invite_id), false, 'an invite is not a device');

  await invites.redeem({
    inviteId: live.invite_id, devicePublicKey: fx.nextKey(), displayName: 'Rae', label: 'Desk',
  });
  assert.equal(store.directory.admitKind(liveKey), null);
  assert.equal(store.directory.resolveActor(liveKey), null);

  const revoked = await invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  const revokedKey = publicKeyOf(revoked);
  await invites.revoke({ actorMemberId: owner.member_id, inviteId: revoked.invite_id });
  assert.equal(store.directory.admitKind(revokedKey), null);

  const expiring = await invites.create({ kind: 'add_device', actorMemberId: owner.member_id });
  const expiringKey = publicKeyOf(expiring);
  assert.equal(store.directory.admitKind(expiringKey), 'invite');
  fx.advance(16 * 60 * 1000);
  assert.equal(store.directory.admitKind(expiringKey), null, 'expired invites stop admitting without a mutation');
  assert.equal(store.directory.liveActor(expiring.invite_id), null);
});

test('the first owner joins through the service and the owner invite is then dead', async (t) => {
  const { fx, store, invites } = setup(t);
  const first = await invites.create({ kind: 'owner_first', actorMemberId: LOCAL_COMMAND });
  assert.equal(first.expires_at, fx.clock() + 15 * 60 * 1000);
  const second = await invites.create({ kind: 'owner_first', actorMemberId: LOCAL_COMMAND });
  assert.equal(second.ok, true);
  const redeemed = await invites.redeem({
    inviteId: first.invite_id, devicePublicKey: fx.nextKey(), displayName: 'Olive Owner', label: 'Owner laptop',
  });
  assert.equal(redeemed.role, 'owner');
  assert.equal(redeemed.state, 'active');
  assert.equal(store.getMember(redeemed.member_id).admitted_by, null);
  assert.deepEqual(invites.reveal(second.invite_id), NOT_VALID, 'the second owner invite died with the first owner');
  assert.equal((await invites.create({ kind: 'owner_first', actorMemberId: LOCAL_COMMAND })).error.reason, 'team_member_state_invalid');
});

// Review round two (R10-F03).
test('a recovery redeem leaves no other recovery invite live, whoever minted it', async (t) => {
  const { fx, store, invites, owner } = await ownerWithService(t);
  const first = await invites.create({ kind: 'recovery', actorMemberId: LOCAL_COMMAND });
  const second = await invites.create({ kind: 'recovery', actorMemberId: LOCAL_COMMAND });
  const used = await invites.redeem({
    inviteId: second.invite_id, devicePublicKey: fx.nextKey(), displayName: 'Olive Owner', label: 'Owner new desk',
  });
  assert.equal(used.ok, true, JSON.stringify(used));
  assert.equal(store.isInviteLive(first.invite_id), false, 'the other recovery invite died with the recovery');
  assert.deepEqual(await invites.redeem({
    inviteId: first.invite_id, devicePublicKey: fx.nextKey(), displayName: 'x', label: 'Someone else',
  }), NOT_VALID);
  const active = store.snapshot().devices.filter((device) => device.member_id === owner.member_id && device.state === 'active');
  assert.deepEqual(active.map((device) => device.label), ['Owner new desk']);
});

const TAKEN = { ok: false, error: { code: 'CMP-HOST-0004', reason: 'team_display_name_taken', retryable: false } };
const auditTail = (fx, n) => JSON.parse(fs.readFileSync(fx.auditFile, 'utf8')).entries.slice(-n);

// Owner decision E79 (reverses the round-two fix for R10-F04): a taken name keeps the invite live, the holder types
// another name. A refusal that keeps an invite live for another reason still says nothing of who is in the team.
test('E79: a taken display name is refused with its own reason, keeps the invite live, and another name joins on it', async (t) => {
  const { fx, store, invites, owner } = await ownerWithService(t);
  const attempt = (inviteId, name) => invites.redeem({ inviteId, devicePublicKey: fx.nextKey(), displayName: name, label: 'Probe' });
  const probe = await invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  assert.deepEqual(await attempt(probe.invite_id, 'olive owner'), TAKEN);
  assert.equal(store.isInviteLive(probe.invite_id), true, 'the taken name did not spend the invite');
  const [entry] = auditTail(fx, 1);
  assert.deepEqual([entry.kind, entry.actor_member_id, entry.name, entry.detail],
    ['invite_name_taken', null, null, `invite=${probe.invite_id},refusals=1`], 'one entry: the invite id, never the name');
  const joined = await attempt(probe.invite_id, 'Nobody Here');
  assert.equal(joined.ok, true, 'the same invite joins under a free name');
  assert.equal(store.isInviteLive(probe.invite_id), false);
  for (let i = 1; i < 7; i += 1) await fx.joinMember(store, owner.member_id, { displayName: `Person ${i}` });
  const full = await invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  const answers = [await attempt(full.invite_id, 'Olive Owner'), await attempt(full.invite_id, 'Free Name')];
  assert.deepEqual(answers[0], answers[1], 'a full team answers a taken and a free name byte for byte alike');
  assert.equal(answers[0].error.reason, 'team_member_limit');
  assert.equal(store.isInviteLive(full.invite_id), true);
});

// E79 keeps R10-F04 bounded: five taken-name refusals per invite, counted on the host and kept across a restart.
test('E79: five taken names per invite; the sixth spends it and answers invite_not_valid; the count survives a restart', async (t) => {
  const { fx, invites, owner } = await ownerWithService(t);
  const probe = await invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  // A count the caller sends is ignored: only the host's own record counts.
  const attempt = (service, name) => service.redeem({ inviteId: probe.invite_id, devicePublicKey: fx.nextKey(), displayName: name,
    label: 'Probe', nameRefusals: 0, name_refusals: 0 });
  for (let i = 1; i <= 3; i += 1) assert.deepEqual(await attempt(invites, 'OLIVE OWNER'), TAKEN, `refusal ${i}`);
  const restarted = fx.openStore(); // a host restart: the count is read back from the invite on disk
  assert.equal(restarted.getInvite(probe.invite_id).name_refusals, 3);
  const again = createInviteService({ store: restarted, clock: fx.clock, randomBytes: fx.randomBytes, logger: fx.logger });
  for (let i = 4; i <= 5; i += 1) assert.deepEqual(await attempt(again, 'Olive Owner'), TAKEN, `refusal ${i}`);
  assert.equal(restarted.isInviteLive(probe.invite_id), true, 'five refusals keep the invite');
  assert.deepEqual(await attempt(again, 'Olive Owner'), NOT_VALID, 'the sixth spends it and reads like an invalid invite');
  assert.equal(restarted.isInviteLive(probe.invite_id), false);
  assert.deepEqual(await attempt(again, 'Free Name'), NOT_VALID, 'a spent invite joins no one');
  const entries = auditTail(fx, 6).filter((entry) => entry.kind === 'invite_name_taken');
  assert.deepEqual(entries.map((entry) => entry.detail), [1, 2, 3, 4, 5, 6].map((n) => `invite=${probe.invite_id},refusals=${n}`
    + (n === 6 ? ',spent' : '')));
  assert.equal(JSON.stringify(entries).toLowerCase().includes('olive'), false, 'no name tried is kept');
});

// ----------------------------------------------------------- redaction

test('no log line or failure payload carries a display name, key or invite string', async (t) => {
  const { fx, store, invites, owner } = await ownerWithService(t);
  const secrets = [];
  const failures = [];
  const keep = (result) => { if (!result.ok) failures.push(result); return result; };

  const created = await invites.create({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', hints: ['192.168.77.12:41999'],
  });
  const revealed = invites.reveal(created.invite_id);
  secrets.push(revealed.invite, parseInvite(revealed.invite).invite_secret_key);
  const deviceKey = fx.nextKey('secret-device');
  secrets.push(deviceKey, '192.168.77.12', 'Zelda Quixote', 'Quixote Tablet', owner.key, 'Olive Owner');
  keep(invites.reveal(created.invite_id));
  keep(await invites.redeem({
    inviteId: created.invite_id, devicePublicKey: deviceKey, displayName: 'Zelda Quixote', label: 'Quixote Tablet',
  }));
  keep(await invites.redeem({
    inviteId: created.invite_id, devicePublicKey: deviceKey, displayName: 'Zelda Quixote', label: 'Quixote Tablet',
  }));
  const again = await invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  keep(await invites.redeem({
    inviteId: again.invite_id, devicePublicKey: owner.key, displayName: 'Zelda Quixote', label: 'Quixote Tablet',
  }));
  keep(await invites.redeem({
    inviteId: again.invite_id, devicePublicKey: fx.nextKey(), displayName: ' bad ', label: 'Quixote Tablet',
  }));
  keep(parseInvite(`${revealed.invite.slice(0, -3)}AAA`));
  const member = store.snapshot().members.find((entry) => entry.display_name === 'Zelda Quixote');
  keep(await store.admit({ actorMemberId: owner.member_id, memberId: member.member_id }));
  keep(await store.admit({ actorMemberId: owner.member_id, memberId: member.member_id }));
  keep(await store.revokeMember({ actorMemberId: owner.member_id, memberId: owner.member_id }));
  parseInvite('jteam1_garbage');
  fx.newStore({ hostPublicKey: fx.key('other-host') }).open();

  assert.ok(failures.length >= 5);
  const haystack = JSON.stringify({ logs: fx.logs, failures });
  assert.ok(fx.logs.length > 0, 'the run did log');
  for (const secret of secrets) assert.equal(haystack.includes(secret), false, `leaked ${secret.slice(0, 12)}`);
  for (const line of fx.logs) {
    for (const value of Object.values(line.fields)) {
      assert.ok(['string', 'number', 'boolean'].includes(typeof value) || value === null);
      if (typeof value === 'string') assert.ok(value.length <= 40, 'log fields are short ids and reasons');
    }
  }
});

// ------------------------------------------------------------ determinism

test('seeded random bytes make the whole invite reproducible', async (t) => {
  const first = await ownerWithService(t);
  const second = await ownerWithService(t);
  const publicKeys = (context) => context.store.snapshot().invites.map((invite) => invite.invite_public_key);
  assert.deepEqual(publicKeys(first), publicKeys(second));
  assert.equal(first.owner.member_id, second.owner.member_id);
});

// Slice 5-3. Fault: a malformed version 2 part kept in the slot (and only failing at reveal). A valid part
// revealed as version 2 is covered by team-invite-v2.test.js (team commands).
test('create refuses a malformed version 2 part before anything is stored', async (t) => {
  const { store, invites } = await ownerWithService(t);
  const actorMemberId = store.snapshot().members[0].member_id;
  const before = store.snapshot().invites.length;
  for (const internet of [
    { hostName: null, relayUrl: null }, { hostName: 'team.example.net', relayUrl: null, relayToken: null },
    { hostName: null, relayUrl: 'http://relay.example.net', relayToken: null },
    { hostName: null, relayUrl: null, relayToken: 'orphan' }, 'on',
  ]) {
    const created = await invites.create({ kind: 'new_member', actorMemberId, role: 'member', internet });
    assert.equal(created.error.reason, 'team_invite_malformed', JSON.stringify(internet));
  }
  assert.equal(store.snapshot().invites.length, before, 'nothing stored');
});

// Slice 5-3 review item 11 (independent review X1-F01). Fault: a created slot that is never revealed
// keeping its secret in memory until the next create or reveal, or a slot timer left behind.
test('an unrevealed slot is cleared after SLOT_MS with no other call; no timer outlives a slot', async (t) => {
  const fx = createFixture(t);
  const live = new Map();
  let next = 0;
  const timers = {
    setTimeout(fn, ms) { next += 1; const id = next; live.set(id, { fn, ms }); return id; },
    clearTimeout(id) { live.delete(id); },
  };
  const invites = createInviteService({ store: fx.openStore(), clock: fx.clock, randomBytes: fx.randomBytes, timers });
  const first = await invites.create({ kind: 'owner_first', actorMemberId: LOCAL_COMMAND });
  assert.equal(invites.pendingSlots(), 1);
  assert.deepEqual([...live.values()].map((entry) => entry.ms), [SLOT_MS]);
  const [[id, { fn }]] = [...live.entries()];
  live.delete(id);
  fn();
  assert.equal(invites.pendingSlots(), 0, 'gone with no create or reveal');
  assert.equal(invites.reveal(first.invite_id).ok, false);
  const owner = await invites.redeem({ inviteId: first.invite_id, devicePublicKey: fx.nextKey('owner-device'),
    displayName: 'Olive Owner', label: 'Owner laptop' });
  assert.equal(owner.ok, true);
  const add = () => invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  const redeemed = await add();
  assert.equal((await invites.redeem({ inviteId: redeemed.invite_id, devicePublicKey: fx.nextKey('mika-device'),
    displayName: 'Mika Member', label: 'Phone' })).ok, true);
  assert.equal(live.size, 0, 'redeem cleared its timer');
  const revoked = await add();
  assert.equal((await invites.revoke({ actorMemberId: owner.member_id, inviteId: revoked.invite_id })).ok, true);
  assert.equal(live.size, 0, 'revoke cleared its timer');
  const revealed = await add();
  assert.equal(invites.reveal(revealed.invite_id).ok, true);
  assert.equal(live.size, 0, 'reveal cleared its timer');
  await add();
  await add();
  assert.equal(live.size, 2);
  invites.dispose();
  assert.deepEqual([live.size, invites.pendingSlots()], [0, 0], 'dispose clears every slot and timer');
});

// ------------------------------------------------------ the local command

test('create has no default actor: an owner invite needs the local command marker', async (t) => {
  const { store, invites } = setup(t);
  assert.equal((await invites.create({ kind: 'owner_first' })).error.reason, 'role_forbidden');
  assert.equal((await invites.create({ kind: 'recovery' })).error.reason, 'role_forbidden');
  const owner = await mintOwnerInvite({ store, invites });
  assert.equal(owner.minted, true, 'the local command still mints the first owner invite');
  assert.equal(store.isInviteLive(owner.invite_id), true);
});

test('a live invite principal, forwarded as the team commands forward it, is not the local command', async (t) => {
  const { store, invites, owner } = await ownerWithService(t);
  const recovery = await mintRecoveryInvite({ invites });
  assert.equal(recovery.minted, true, 'the local command still mints a recovery invite');
  const pending = await invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  const actor = store.directory.liveActor(pending.invite_id);
  assert.deepEqual([actor.role, actor.member_id], ['invite', null], 'the real directory actor of a live invite');
  const revoked = await invites.revoke({ actorMemberId: actor.member_id, inviteId: recovery.invite_id });
  assert.equal(revoked.error.reason, 'team_not_found');
  assert.equal(store.isInviteLive(recovery.invite_id), true, 'the recovery invite is still live');
  for (const kind of ['owner_first', 'recovery']) {
    assert.equal((await invites.create({ kind, actorMemberId: actor.member_id })).ok, false, kind);
  }
  assert.equal((await invites.revoke({ actorMemberId: LOCAL_COMMAND, inviteId: recovery.invite_id })).ok, true);
});
