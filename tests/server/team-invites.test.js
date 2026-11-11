'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { createFixture } = require('./helpers/team-store-fixture');
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
  const created = await context.invites.create({ kind: 'owner_first' });
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
  const first = await invites.create({ kind: 'owner_first' });
  assert.equal(first.expires_at, fx.clock() + 15 * 60 * 1000);
  const second = await invites.create({ kind: 'owner_first' });
  assert.equal(second.ok, true);
  const redeemed = await invites.redeem({
    inviteId: first.invite_id, devicePublicKey: fx.nextKey(), displayName: 'Olive Owner', label: 'Owner laptop',
  });
  assert.equal(redeemed.role, 'owner');
  assert.equal(redeemed.state, 'active');
  assert.equal(store.getMember(redeemed.member_id).admitted_by, null);
  assert.deepEqual(invites.reveal(second.invite_id), NOT_VALID, 'the second owner invite died with the first owner');
  assert.equal((await invites.create({ kind: 'owner_first' })).error.reason, 'team_member_state_invalid');
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
