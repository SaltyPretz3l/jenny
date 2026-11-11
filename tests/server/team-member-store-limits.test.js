'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createFixture, assertOwnerInvariant } = require('./helpers/team-store-fixture');

function failureOf(result) {
  assert.equal(result.ok, false, 'expected a failure');
  return result.error;
}

// ------------------------------------------------------------------- limits

test('at most eight members, active or pending, owner included', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  for (let index = 0; index < 7; index += 1) {
    await fx.joinMember(store, owner.member_id, { displayName: `Member ${index}`, admit: index % 2 === 0 });
  }
  assert.equal(store.snapshot().members.length, 8);
  const created = await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  const refused = await store.redeem({
    inviteId: created.invite_id, devicePublicKey: fx.nextKey(), displayName: 'Ninth', label: 'Desk',
  });
  const error = failureOf(refused);
  assert.equal(error.reason, 'team_member_limit');
  assert.equal(error.code, 'CMP-HOST-0007');
  // A revoked member frees a slot.
  const members = store.snapshot().members.filter((member) => member.role === 'member');
  await store.revokeMember({ actorMemberId: owner.member_id, memberId: members[0].member_id });
  const accepted = await store.redeem({
    inviteId: created.invite_id, devicePublicKey: fx.nextKey(), displayName: 'Ninth', label: 'Desk',
  });
  assert.equal(accepted.ok, true);
  assertOwnerInvariant(assert, store);
});

test('at most three active devices per member; a revoked device frees a slot', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  const second = await fx.addDevice(store, joined.member_id);
  const third = await fx.addDevice(store, joined.member_id);
  assert.equal(second.ok && third.ok, true);
  const refused = await store.createInvite({
    kind: 'add_device', actorMemberId: joined.member_id, invitePublicKey: fx.nextKey(),
  });
  assert.equal(failureOf(refused).reason, 'team_device_limit');
  assert.equal(failureOf(refused).code, 'CMP-HOST-0007');
  await store.revokeDevice({ actorMemberId: joined.member_id, deviceId: second.device_id });
  assert.equal((await fx.addDevice(store, joined.member_id)).ok, true);
});

test('a live add-device invite holds a device slot, so a member cannot mint more than they can use', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  const mint = () => store.createInvite({
    kind: 'add_device', actorMemberId: joined.member_id, invitePublicKey: fx.nextKey(),
  });
  // One device and two live invites fill the three slots.
  const early = [await mint(), await mint()];
  assert.deepEqual(early.map((invite) => invite.ok), [true, true]);
  assert.equal(failureOf(await mint()).reason, 'team_device_limit');
  // Revoking an invite, or letting one expire, frees its slot.
  await store.revokeInvite({ actorMemberId: joined.member_id, inviteId: early[0].invite_id });
  const third = await mint();
  assert.equal(third.ok, true);
  for (const invite of [early[1], third]) {
    const redeemed = await store.redeem({
      inviteId: invite.invite_id, devicePublicKey: fx.nextKey(), displayName: 'x', label: 'Dev',
    });
    assert.equal(redeemed.ok, true);
  }
  assert.equal(failureOf(await mint()).reason, 'team_device_limit');
  // Another member's invites never count against this one.
  const other = await fx.joinMember(store, owner.member_id, { displayName: 'Other' });
  assert.equal((await store.createInvite({
    kind: 'add_device', actorMemberId: other.member_id, invitePublicKey: fx.nextKey(),
  })).ok, true);
});

test('at most eight outstanding invites; revoking or using one frees a slot', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const ids = [];
  for (let index = 0; index < 8; index += 1) {
    const created = await store.createInvite({
      kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
    });
    assert.equal(created.ok, true);
    ids.push(created.invite_id);
  }
  const ninth = await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  assert.equal(failureOf(ninth).reason, 'team_invite_limit');
  assert.equal(failureOf(ninth).code, 'CMP-HOST-0007');
  await store.revokeInvite({ actorMemberId: owner.member_id, inviteId: ids[0] });
  const again = await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  assert.equal(again.ok, true);
  // Expired invites no longer count.
  fx.advance(8 * 24 * 60 * 60 * 1000);
  const fresh = await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  assert.equal(fresh.ok, true);
});

test('invite expiry defaults and maxima per kind', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const hour = 60 * 60 * 1000;
  const minute = 60 * 1000;
  const member = await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  assert.equal(member.expires_at, fx.clock() + 24 * hour);
  const week = await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', ttlMs: 7 * 24 * hour,
    invitePublicKey: fx.nextKey(),
  });
  assert.equal(week.expires_at, fx.clock() + 7 * 24 * hour);
  assert.equal(failureOf(await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', ttlMs: 7 * 24 * hour + 1,
    invitePublicKey: fx.nextKey(),
  })).reason, 'team_invite_ttl_invalid');
  const device = await store.createInvite({
    kind: 'add_device', actorMemberId: owner.member_id, invitePublicKey: fx.nextKey(),
  });
  assert.equal(device.expires_at, fx.clock() + 15 * minute);
  assert.equal(failureOf(await store.createInvite({
    kind: 'add_device', actorMemberId: owner.member_id, ttlMs: 16 * minute, invitePublicKey: fx.nextKey(),
  })).reason, 'team_invite_ttl_invalid');
  assert.equal(failureOf(await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'owner', invitePublicKey: fx.nextKey(),
  })).reason, 'team_role_invalid');
  assert.equal(failureOf(await store.createInvite({
    kind: 'new_member', actorMemberId: joinedNobody(), role: 'member', invitePublicKey: fx.nextKey(),
  })).reason, 'team_not_found');
});

function joinedNobody() { return 'member_nobody'; }

test('a non-owner cannot mint a new-member invite', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  assert.equal(failureOf(await store.createInvite({
    kind: 'new_member', actorMemberId: joined.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  })).reason, 'role_forbidden');
});

test('revoked members are kept up to 56, the oldest pruned with their devices', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const first = await fx.joinMember(store, owner.member_id, { displayName: 'First Gone' });
  await store.revokeMember({ actorMemberId: owner.member_id, memberId: first.member_id });
  const gone = [first];
  for (let index = 0; index < 56; index += 1) {
    fx.advance(1000);
    const joined = await fx.joinMember(store, owner.member_id, { displayName: `Gone ${index}` });
    await store.revokeMember({ actorMemberId: owner.member_id, memberId: joined.member_id });
    gone.push(joined);
  }
  const doc = store.snapshot();
  assert.equal(doc.members.filter((member) => member.state === 'revoked').length, 56);
  assert.equal(store.getMember(first.member_id), null, 'the oldest revoked member was pruned');
  assert.equal(doc.devices.some((device) => device.device_id === first.device_id), false,
    'with their devices');
  assert.ok(store.getMember(gone.at(-1).member_id));
  assert.equal(store.directory.resolveActor(first.key), null);
  assertOwnerInvariant(assert, store);
});

test('revoked devices of live members are kept up to 56, the oldest pruned', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  const ids = [];
  for (let index = 0; index < 58; index += 1) {
    fx.advance(1000);
    const added = await fx.addDevice(store, joined.member_id, `Phone ${index}`);
    assert.equal(added.ok, true);
    await store.revokeDevice({ actorMemberId: joined.member_id, deviceId: added.device_id });
    ids.push(added.device_id);
  }
  const revoked = store.snapshot().devices.filter((device) => device.state === 'revoked');
  assert.equal(revoked.length, 56);
  assert.equal(revoked.some((device) => device.device_id === ids[0]), false);
  assert.equal(revoked.some((device) => device.device_id === ids.at(-1)), true);
});

test('last_seen_at is persisted at most once a minute', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const device = () => store.snapshot().devices.find((entry) => entry.device_id === owner.device_id);
  assert.equal(device().last_seen_at, null);
  const first = await store.touchDevice(owner.device_id);
  assert.equal(first.written, true);
  const stamp = device().last_seen_at;
  assert.equal(stamp, fx.clock());
  fx.advance(59_000);
  assert.equal((await store.touchDevice(owner.device_id)).written, false);
  assert.equal(device().last_seen_at, stamp);
  fx.advance(1000);
  assert.equal((await store.touchDevice(owner.device_id)).written, true);
  assert.equal(device().last_seen_at, fx.clock());
  assert.equal((await store.touchDevice('device_unknown')).written, false);
});

// ------------------------------------------------------------- strict load

function writeDoc(fx, mutate) {
  const store = fx.openStore();
  return fx.bootstrapOwner(store).then((owner) => {
    const doc = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
    mutate(doc, owner);
    fs.writeFileSync(fx.memberFile, JSON.stringify(doc));
  });
}

async function assertBroken(fx, expectedReason, { storeOverrides } = {}) {
  const before = fs.readFileSync(fx.memberFile);
  const store = fx.newStore(storeOverrides);
  const opened = store.open();
  assert.equal(opened.ok, false);
  assert.equal(opened.error.reason, expectedReason);
  // Every later call fails closed with the same reason, and nothing is rewritten.
  assert.equal(store.snapshot(), null);
  assert.equal(store.directory.resolveActor(fx.key('anything')), null);
  const attempt = await store.createInvite({
    kind: 'owner_first', actorMemberId: null, invitePublicKey: fx.nextKey(),
  });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.error.reason, expectedReason);
  assert.deepEqual(fs.readFileSync(fx.memberFile), before, 'file bytes unchanged');
}

test('strict load: garbage bytes break the store with team_unavailable and rewrite nothing', async (t) => {
  const fx = createFixture(t);
  fs.writeFileSync(fx.memberFile, Buffer.from([0x00, 0xff, 0x7b, 0x22, 0x80]));
  await assertBroken(fx, 'team_unavailable');
});

test('strict load: a non-object root and truncated JSON break the store', async (t) => {
  const fx = createFixture(t);
  fs.writeFileSync(fx.memberFile, '[1,2,3]');
  await assertBroken(fx, 'team_unavailable');
  fs.writeFileSync(fx.memberFile, '{"schema_version":1,"rev":');
  await assertBroken(fx, 'team_unavailable');
});

test('strict load: a file over the 256 KiB read cap breaks the store', async (t) => {
  const fx = createFixture(t);
  fs.writeFileSync(fx.memberFile, JSON.stringify({ pad: 'x'.repeat(300 * 1024) }));
  await assertBroken(fx, 'team_unavailable');
});

test('strict load: an unknown field at any level breaks the store', async (t) => {
  const mutations = [
    (doc) => { doc.surprise = true; },
    (doc) => { doc.members[0].nickname = 'x'; },
    (doc) => { doc.devices[0].extra = 1; },
    (doc) => { doc.team.extra = 1; },
    (doc) => { doc.invites[0].extra = 1; },
  ];
  for (const mutate of mutations) {
    const fx = createFixture(t);
    await writeDoc(fx, mutate);
    await assertBroken(fx, 'team_unavailable');
  }
});

test('strict load: a newer or unknown schema_version is unsupported and the bytes stay', async (t) => {
  for (const version of [3, 99, 0]) {
    const fx = createFixture(t);
    await writeDoc(fx, (doc) => { doc.schema_version = version; doc.future_field = { a: 1 }; });
    await assertBroken(fx, 'team_store_schema_unsupported');
  }
});

test('strict load: a bad field value breaks the store', async (t) => {
  const mutations = [
    (doc) => { doc.members[0].role = 'admin'; },
    (doc) => { doc.members[0].state = 'ghost'; },
    (doc) => { doc.members[0].member_id = 'nope'; },
    (doc) => { doc.members[0].display_name = ' padded'; },
    (doc) => { doc.devices[0].public_key = 'short'; },
    (doc) => { doc.devices[0].member_id = 'member_missing'; },
    (doc) => { doc.rev = -1; },
    (doc) => { doc.rev = 1.5; },
    (doc) => { doc.team.team_id = 'team_AAAAAAAAAAAAAAAAAAAAAA'; },
  ];
  for (const mutate of mutations) {
    const fx = createFixture(t);
    await writeDoc(fx, mutate);
    await assertBroken(fx, 'team_unavailable');
  }
});

test('strict load: the owner invariant is checked on load', async (t) => {
  const twoOwners = createFixture(t);
  await writeDoc(twoOwners, (doc) => {
    doc.members.push({ ...doc.members[0], member_id: 'member_SecondOwnerXXXXXXXXXX' });
  });
  await assertBroken(twoOwners, 'team_unavailable');

  const noOwner = createFixture(t);
  await writeDoc(noOwner, (doc) => { doc.members[0].role = 'member'; });
  await assertBroken(noOwner, 'team_unavailable');

  const revokedOwner = createFixture(t);
  await writeDoc(revokedOwner, (doc) => {
    doc.members[0].state = 'revoked';
    doc.members[0].revoked_at = 1;
    doc.members[0].revoked_by = doc.members[0].member_id;
    doc.devices[0].state = 'revoked';
  });
  await assertBroken(revokedOwner, 'team_unavailable');
});

test('strict load: duplicate keys or ids and limit violations break the store', async (t) => {
  const duplicateKey = createFixture(t);
  await writeDoc(duplicateKey, (doc, owner) => {
    doc.devices.push({ ...doc.devices[0], device_id: 'device_AnotherDeviceXXXXXXXX' });
    assert.equal(doc.devices[0].member_id, owner.member_id, 'the copied device is the owner device');
  });
  await assertBroken(duplicateKey, 'team_unavailable');

  const tooManyDevices = createFixture(t);
  await writeDoc(tooManyDevices, (doc) => {
    for (let index = 0; index < 3; index += 1) {
      doc.devices.push({
        ...doc.devices[0], device_id: `device_Extra${index}XXXXXXXXXXXXXX`, public_key: tooManyDevices.key(`extra-${index}`),
      });
    }
  });
  await assertBroken(tooManyDevices, 'team_unavailable');
});

test('opening with a different host key fails with team_host_key_mismatch and rewrites nothing', async (t) => {
  const fx = createFixture(t);
  await writeDoc(fx, () => {});
  await assertBroken(fx, 'team_host_key_mismatch', { storeOverrides: { hostPublicKey: fx.key('another-host') } });
  const opened = fx.newStore().open();
  assert.equal(opened.ok, true, 'the right key still opens');
});

test('a missing host key or user data path is a programming error, not a silent default', (t) => {
  const fx = createFixture(t);
  const { MemberStore } = require('../../server/team/member-store');
  assert.throws(() => new MemberStore({ ...fx.storeOptions(), hostPublicKey: 'short' }),
    { name: 'TypeError', message: /host public key/u });
  assert.throws(() => new MemberStore({ ...fx.storeOptions(), userDataPath: 'relative/dir' }),
    { name: 'TypeError', message: /absolute userDataPath/u });
  assert.equal(fs.existsSync(fx.memberFile), false, 'a refused construction writes nothing');
});

test('a reopened store sees exactly what was committed', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id, { displayName: 'Mina' });
  const reopened = fx.openStore();
  assert.deepEqual(reopened.snapshot(), store.snapshot());
  assert.equal(reopened.rev(), store.rev());
  assert.equal(reopened.directory.resolveActor(joined.key).role, 'member');
});

// ------------------------------------------------------------ durability

test('a crash between the temporary write and the rename leaves the old document readable', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const before = fs.readFileSync(fx.memberFile);
  const rev = store.rev();

  const crashing = fx.openStore({
    writeJson(filePath, value) {
      // The process dies after the temporary file is written, before the rename.
      fs.writeFileSync(path.join(path.dirname(filePath), '.host-crashed.tmp'), JSON.stringify(value));
      throw Object.assign(new Error('power loss'), { code: 'EIO' });
    },
  });
  const result = await crashing.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  assert.equal(failureOf(result).reason, 'team_store_failed');
  assert.equal(failureOf(result).code, 'CMP-HOST-0006');
  assert.deepEqual(fs.readFileSync(fx.memberFile), before);
  // The writer is now broken and fails closed; reads and writes alike.
  assert.equal(failureOf(await crashing.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  })).reason, 'team_unavailable');

  const reopened = fx.openStore();
  assert.equal(reopened.rev(), rev);
  assert.equal(reopened.getMember(owner.member_id).role, 'owner');
  assert.deepEqual(reopened.snapshot(), store.snapshot());
});

test('a real rename failure inside the durable write keeps the old document and cleans the temp file', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const before = fs.readFileSync(fx.memberFile);
  const originalRename = fs.renameSync;
  // Only the member document's rename fails, so the audit entry is written first.
  fs.renameSync = (from, to) => {
    if (path.basename(to) === 'team-members.json') throw Object.assign(new Error('rename blocked'), { code: 'EPERM' });
    return originalRename(from, to);
  };
  let result;
  try {
    result = await store.createInvite({
      kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
    });
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(failureOf(result).reason, 'team_store_failed');
  assert.deepEqual(fs.readFileSync(fx.memberFile), before);
  assert.deepEqual(fs.readdirSync(fx.dir).filter((name) => name.endsWith('.tmp')), []);
  assert.equal(store.rev(), null, 'a failed write marks the store broken');
  const reopened = fx.openStore();
  assert.equal(reopened.snapshot().invites.length, 1, 'only the burned owner invite: the new invite never landed');
  const entries = reopened.audit.read({ cursor: 0, limit: 100 }).entries;
  assert.equal(entries.at(-1).kind, 'invite_created');
  assert.equal(entries.at(-1).applied, false, 'the audit entry for the lost change is marked not applied');
});

test('assertSafePath is called before every read and write when injected', async (t) => {
  const fx = createFixture(t);
  const seen = [];
  const store = fx.openStore({ assertSafePath(filePath) { seen.push(path.basename(filePath)); } });
  await fx.bootstrapOwner(store);
  assert.ok(seen.includes('team-members.json'));
  assert.ok(seen.includes('team-audit.json'));
  assert.ok(seen.length >= 4, 'reads and writes both guarded');

  const blocked = fx.newStore({ assertSafePath() { throw new Error('junction'); } });
  const opened = blocked.open();
  assert.equal(opened.ok, false);
  assert.equal(opened.error.reason, 'team_unavailable');
});

test('mutations are serialized: concurrent calls never interleave', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const created = await Promise.all(Array.from({ length: 8 }, () => store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  })));
  assert.deepEqual(created.map((entry) => entry.ok), Array(8).fill(true));
  assert.equal(new Set(created.map((entry) => entry.invite_id)).size, 8);
  assert.equal(store.snapshot().invites.filter((invite) => invite.used_at === null).length, 8);
  const ninth = await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  assert.equal(failureOf(ninth).reason, 'team_invite_limit');
});

test('the team copy of the project id pattern and General id match the application store', () => {
  const { PROJECT_ID_PATTERN, GENERAL_PROJECT_ID, isProjectId } = require('../../server/team/member-schema');
  const application = require('../../services/projects/project-schema');
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'projects', 'project-schema.js'), 'utf8');
  const literal = /const PROJECT_ID_RE = \/(.+)\/([a-z]*);/u.exec(source);
  assert.ok(literal, 'the application pattern is still a literal named PROJECT_ID_RE');
  assert.deepEqual([PROJECT_ID_PATTERN.source, PROJECT_ID_PATTERN.flags], [literal[1], literal[2]]);
  assert.equal(GENERAL_PROJECT_ID, application.GENERAL_PROJECT_ID);
  for (const id of ['project_a', 'project_0123456789abcdef0123456789abcdef', `project_${'x'.repeat(128)}`,
    `project_${'x'.repeat(129)}`, 'project_', 'project_a.b', 'Project_a', 'project_a/../b']) {
    assert.equal(isProjectId(id), application.normalizeProjectId(id) === id && id !== GENERAL_PROJECT_ID, id);
  }
  assert.equal(isProjectId(GENERAL_PROJECT_ID), false, 'General is never a team project');
});
