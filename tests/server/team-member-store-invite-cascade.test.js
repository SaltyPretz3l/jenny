'use strict';

// The R01 review fixes to the team member store (row 123, JEN-064):
//   A  an invite never outlives the authority that minted it,
//   B  a reconcile that could not be written is owed, not dropped,
//   C  the input rule for names the owner admits by, and taken names,
//   D  one backup of the old file before a schema upgrade can overwrite it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createFixture } = require('./helpers/team-store-fixture');
const { LOCAL_COMMAND } = require('../../server/team/member-schema');
const { writeJson: durableWriteJson } = require('../../services/host/durable-json');

function reasonOf(result) {
  assert.equal(result.ok, false, 'expected a failure');
  return result.error.reason;
}

async function team(t, overrides = {}) {
  const fx = createFixture(t);
  const store = fx.openStore(overrides);
  const owner = await fx.bootstrapOwner(store);
  return { fx, store, owner };
}

function mint(fx, store, actorMemberId, kind, extra = {}) {
  return store.createInvite({ kind, actorMemberId, invitePublicKey: fx.nextKey(`invite-${kind}`), ...extra });
}

function redeem(fx, store, inviteId, displayName = 'Someone New') {
  const key = fx.nextKey('redeemer');
  return store.redeem({ inviteId, devicePublicKey: key, displayName, label: 'Laptop' }).then((result) => ({ result, key }));
}

// Gone everywhere a holder could use it: the live check, the directory and redeem.
async function assertDead(fx, store, invite) {
  assert.equal(store.isInviteLive(invite.invite_id), false, 'not live');
  assert.equal(store.directory.liveActor(invite.invite_id), null, 'does not resolve');
  assert.notEqual(store.getInvite(invite.invite_id).revoked_at, null, 'revoked, not spent');
  const { result } = await redeem(fx, store, invite.invite_id);
  assert.equal(reasonOf(result), 'invite_not_valid');
}

// ------------------------------------------------------------------ A: cascades

test('A1: a device revoke kills the add-device invites its member minted; others keep theirs', async (t) => {
  const { fx, store, owner } = await team(t);
  const mel = await fx.joinMember(store, owner.member_id, { displayName: 'Mel' });
  const sam = await fx.joinMember(store, owner.member_id, { displayName: 'Sam' });
  const melInvite = await mint(fx, store, mel.member_id, 'add_device');
  const samInvite = await mint(fx, store, sam.member_id, 'add_device');
  const ownerInvite = await mint(fx, store, owner.member_id, 'new_member', { role: 'member' });
  assert.equal(melInvite.ok && samInvite.ok && ownerInvite.ok, true);

  assert.equal((await store.revokeDevice({ actorMemberId: owner.member_id, deviceId: mel.device_id })).ok, true);
  await assertDead(fx, store, melInvite);
  assert.equal(store.isInviteLive(samInvite.invite_id), true, 'another member keeps theirs');
  assert.equal(store.isInviteLive(ownerInvite.invite_id), true, "the owner's new-member invite stays");
});

test('A1: a member revoking their own device kills their add-device invites too', async (t) => {
  const { fx, store, owner } = await team(t);
  const mel = await fx.joinMember(store, owner.member_id, { displayName: 'Mel' });
  const phone = await fx.addDevice(store, mel.member_id);
  assert.equal(phone.ok, true);
  const minted = await mint(fx, store, mel.member_id, 'add_device');
  assert.equal((await store.revokeDevice({ actorMemberId: mel.member_id, deviceId: mel.device_id })).ok, true);
  await assertDead(fx, store, minted);
  assert.notEqual(store.directory.resolveActor(phone.key), null, 'the other device stays');
});

test('A2: a recovery redeem kills every invite made by or for the owner and every other recovery invite', async (t) => {
  const { fx, store, owner } = await team(t);
  const addDevice = await mint(fx, store, owner.member_id, 'add_device');
  const newMember = await mint(fx, store, owner.member_id, 'new_member', { role: 'member' });
  const recovery = await mint(fx, store, LOCAL_COMMAND, 'recovery');
  const spare = await mint(fx, store, LOCAL_COMMAND, 'recovery');
  assert.equal(addDevice.ok && newMember.ok && recovery.ok && spare.ok, true);

  const { result: recovered, key: recoveredKey } = await redeem(fx, store, recovery.invite_id);
  assert.equal(recovered.ok, true);
  assert.equal(store.directory.resolveActor(owner.key), null, 'the old owner device is revoked');
  assert.equal(store.directory.resolveActor(recoveredKey).role, 'owner');

  const live = store.snapshot().invites.filter((invite) => store.isInviteLive(invite.invite_id));
  assert.deepEqual(live.map((invite) => invite.invite_id), [], 'none, the spare recovery invite included (R10-F03)');
  await assertDead(fx, store, newMember);
  // Today its redeemer resolves with role "owner" after a completed recovery.
  const { result: back, key: thiefKey } = await redeem(fx, store, addDevice.invite_id);
  assert.equal(reasonOf(back), 'invite_not_valid');
  assert.equal(store.directory.resolveActor(thiefKey), null);
});

test('A3: a new-member invite dies with the transfer of the ownership that minted it', async (t) => {
  const { fx, store, owner } = await team(t);
  const next = await fx.joinMember(store, owner.member_id, { displayName: 'Next' });
  const kept = await mint(fx, store, owner.member_id, 'new_member', { role: 'member' });
  const ownAddDevice = await mint(fx, store, owner.member_id, 'add_device');
  assert.equal(kept.ok && ownAddDevice.ok, true);

  assert.equal((await store.transferOwner({ actorMemberId: owner.member_id, memberId: next.member_id })).ok, true);
  assert.equal(store.isInviteLive(kept.invite_id), false, 'not live right after the transfer');
  assert.equal(store.isInviteLive(ownAddDevice.invite_id), true, 'their own add-device invite stays');

  assert.equal((await store.revokeMember({ actorMemberId: next.member_id, memberId: owner.member_id })).ok, true);
  await assertDead(fx, store, kept);
  assert.equal(store.isInviteLive(ownAddDevice.invite_id), false);
});

test('A4: each cascade writes its count in the detail, commits once and bumps the revision once', async (t) => {
  let writes = 0;
  const { fx, store, owner } = await team(t, {
    writeJson(filePath, value) { writes += 1; durableWriteJson(filePath, value); },
  });
  const mel = await fx.joinMember(store, owner.member_id, { displayName: 'Mel' });
  const next = await fx.joinMember(store, owner.member_id, { displayName: 'Next' });

  async function step(run) {
    const rev = store.rev();
    const seq = store.audit.read({ order: 'newest', limit: 1 }).entries[0].seq;
    writes = 0;
    const result = await run();
    assert.equal(result.ok, true);
    assert.equal(writes, 1, 'one document write');
    assert.equal(store.rev(), rev + 1, 'one revision');
    const added = store.audit.read({ cursor: seq }).entries;
    assert.ok(added.every((entry) => entry.store_rev === rev + 1));
    return added;
  }

  await mint(fx, store, mel.member_id, 'add_device');
  const deviceEntries = await step(() => store.revokeDevice({ actorMemberId: owner.member_id, deviceId: mel.device_id }));
  assert.deepEqual(deviceEntries.map((entry) => [entry.kind, entry.detail]), [['device_revoked', 'revoked_invites=1']]);

  await mint(fx, store, owner.member_id, 'new_member', { role: 'member' });
  await mint(fx, store, owner.member_id, 'new_member', { role: 'read_only' });
  const transferEntries = await step(() => store.transferOwner({ actorMemberId: owner.member_id, memberId: next.member_id }));
  assert.deepEqual(transferEntries.map((entry) => [entry.kind, entry.detail]), [['owner_transferred', 'revoked_invites=2']]);

  await mint(fx, store, owner.member_id, 'add_device');
  const revokeEntries = await step(() => store.revokeMember({ actorMemberId: next.member_id, memberId: owner.member_id }));
  assert.deepEqual(revokeEntries.map((entry) => [entry.kind, entry.detail]), [['member_revoked', 'was=active,revoked_invites=1']]);

  await mint(fx, store, next.member_id, 'add_device');
  await mint(fx, store, next.member_id, 'new_member', { role: 'member' });
  const recovery = await mint(fx, store, LOCAL_COMMAND, 'recovery');
  const recoveryEntries = await step(() => redeem(fx, store, recovery.invite_id).then(({ result }) => result));
  assert.equal(recoveryEntries[0].kind, 'recovery_used');
  assert.equal(recoveryEntries[0].detail, 'revoked_devices=1,revoked_invites=2');
});

test('A5: revoking an owner device also kills the owner\'s new-member invites', async (t) => {
  const { fx, store, owner } = await team(t);
  assert.equal((await fx.addDevice(store, owner.member_id)).ok, true);
  const newMember = await mint(fx, store, owner.member_id, 'new_member', { role: 'member' });
  const revoked = await store.revokeDevice({ actorMemberId: owner.member_id, deviceId: owner.device_id });
  assert.equal(revoked.ok, true);
  await assertDead(fx, store, newMember);
  const entry = store.audit.read({ order: 'newest', limit: 1 }).entries[0];
  assert.deepEqual([entry.kind, entry.detail], ['device_revoked', 'revoked_invites=1']);
});

test('A6: an owner transfer also kills the previous owner\'s local recovery invite', async (t) => {
  const { fx, store, owner } = await team(t);
  const next = await fx.joinMember(store, owner.member_id, { displayName: 'Next' });
  const recovery = await mint(fx, store, LOCAL_COMMAND, 'recovery');
  assert.equal((await store.transferOwner({ actorMemberId: owner.member_id, memberId: next.member_id })).ok, true);
  assert.equal(store.isInviteLive(recovery.invite_id), false);
  const entry = store.audit.read({ order: 'newest', limit: 1 }).entries[0];
  assert.deepEqual([entry.kind, entry.detail], ['owner_transferred', 'revoked_invites=1']);
});

test('A7: a full invite list never refuses the local recovery invite; a ninth member-minted one is refused', async (t) => {
  const { fx, store, owner } = await team(t);
  for (let index = 0; index < 8; index += 1) {
    assert.equal((await mint(fx, store, owner.member_id, 'new_member', { role: 'member' })).ok, true);
  }
  // The call shape server/team/recovery.js uses.
  const recovery = await store.createInvite({ kind: 'recovery', actorMemberId: LOCAL_COMMAND, invitePublicKey: fx.nextKey('rec') });
  assert.equal(recovery.ok, true);
  assert.equal(reasonOf(await mint(fx, store, owner.member_id, 'new_member', { role: 'member' })), 'team_invite_limit');
  assert.equal(fx.openStore().isInviteLive(recovery.invite_id), true, 'the document with nine live invites loads');
});

test('A8: a store file gone missing while the audit log proves a history fails closed and rewrites nothing', async (t) => {
  const { fx, store, owner } = await team(t);
  await fx.joinMember(store, owner.member_id);
  assert.ok(store.rev() >= 3);
  fs.rmSync(fx.memberFile);
  const audit = fs.readFileSync(fx.auditFile);
  assert.equal(reasonOf(fx.newStore().open()), 'team_unavailable');
  assert.deepEqual(fs.readFileSync(fx.auditFile), audit);
  assert.equal(fs.existsSync(fx.memberFile), false);
});

// An audit readJson that throws EBUSY for its first `count` reads.
function busyAuditReads(count) {
  const state = { left: count };
  const { readJson } = require('../../services/host/durable-json');
  return {
    state,
    auditOptions: {
      readJson(filePath, options) {
        if (state.left > 0) { state.left -= 1; throw Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'open' }); }
        return readJson(filePath, options);
      },
    },
  };
}

test('A8: a missing store file with an audit log busy for one read refuses the open, breaks nothing, and the next open decides', async (t) => {
  const { fx, store, owner } = await team(t);
  await fx.joinMember(store, owner.member_id);
  assert.ok(store.rev() >= 3);
  fs.rmSync(fx.memberFile);
  const audit = fs.readFileSync(fx.auditFile);
  const { auditOptions } = busyAuditReads(1);
  const reopened = fx.newStore({ auditOptions });
  assert.equal(reasonOf(reopened.open()), 'team_unavailable');
  assert.equal(fs.existsSync(fx.memberFile), false, 'no members file is created');
  assert.deepEqual(fs.readFileSync(fx.auditFile), audit);
  assert.equal(fx.logs.some((entry) => entry.event === 'team_store.broken'), false, 'the store is not broken');
  // The scanner let go: the log proves a history, so the lost file is refused for good.
  assert.equal(reasonOf(reopened.open()), 'team_unavailable');
  assert.ok(fx.logs.some((entry) => entry.event === 'team_store.broken' && entry.fields.cause === 'store_missing'));
  assert.deepEqual(fs.readFileSync(fx.auditFile), audit);
  assert.equal(fs.existsSync(fx.memberFile), false);
});

test('A8: a missing store file with a busy but empty audit log opens as new once the log is readable', (t) => {
  const fx = createFixture(t);
  const { auditOptions } = busyAuditReads(1);
  const store = fx.newStore({ auditOptions });
  assert.equal(reasonOf(store.open()), 'team_unavailable');
  assert.deepEqual(store.open(), { ok: true });
  assert.equal(store.rev(), 0);
});

test('A8: a torn first commit still opens as a new store and marks its entry not applied', async (t) => {
  const fx = createFixture(t);
  // The process dies after the first change's audit write: one entry, store_rev 1.
  const crashing = fx.openStore({ writeJson() { /* lost */ } });
  assert.equal((await mint(fx, crashing, LOCAL_COMMAND, 'owner_first')).ok, true);
  const reopened = fx.openStore();
  assert.equal(reopened.rev(), 0);
  assert.deepEqual(reopened.audit.read({ cursor: 0 }).entries.map((entry) => [entry.store_rev, entry.applied]), [[1, false]]);
});

// ---------------------------------------------------------------- B: reconcile

// A device revoke whose audit entry landed and whose document write was lost.
async function lostRevoke(t) {
  const { fx, store, owner } = await team(t);
  const mel = await fx.joinMember(store, owner.member_id, { displayName: 'Mel' });
  const rev = store.rev();
  const crashing = fx.openStore({ writeJson() { /* lost */ } });
  assert.equal((await crashing.revokeDevice({ actorMemberId: owner.member_id, deviceId: mel.device_id })).ok, true);
  return { fx, owner, mel, rev };
}

function failingAudit(failures) {
  const state = { left: failures };
  return {
    state,
    auditOptions: {
      writeJson(filePath, value) {
        if (state.left > 0) { state.left -= 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }
        durableWriteJson(filePath, value);
      },
    },
  };
}

test('B1: a reconcile whose write failed on open runs again before the next audited change', async (t) => {
  const { fx, owner, mel, rev } = await lostRevoke(t);
  const { auditOptions } = failingAudit(1);
  const restarted = fx.openStore({ auditOptions });
  assert.equal(restarted.rev(), rev, 'the revoke never happened');
  assert.ok(fx.logs.some((entry) => entry.event === 'team_store.audit_unavailable'));

  const created = await mint(fx, restarted, owner.member_id, 'new_member', { role: 'member' });
  assert.equal(created.ok, true);
  const later = fx.openStore();
  const tail = later.audit.read({ cursor: 0 }).entries.slice(-2).map((entry) => [entry.kind, entry.store_rev, entry.applied]);
  assert.deepEqual(tail, [['device_revoked', rev + 1, false], ['invite_created', rev + 1, true]]);
  assert.notEqual(later.directory.resolveActor(mel.key), null, 'the device still resolves');
});

test('B2: while the owed reconcile cannot be written, an audited change is refused and nothing is written', async (t) => {
  const { fx, owner, rev } = await lostRevoke(t);
  const { state, auditOptions } = failingAudit(Infinity);
  const restarted = fx.openStore({ auditOptions });
  const members = fs.readFileSync(fx.memberFile);
  const audit = fs.readFileSync(fx.auditFile);
  const events = [];
  restarted.onMembershipChange((event) => events.push(event));

  const refused = await mint(fx, restarted, owner.member_id, 'new_member', { role: 'member' });
  assert.equal(reasonOf(refused), 'team_store_failed');
  assert.equal(restarted.rev(), rev);
  assert.deepEqual(fs.readFileSync(fx.memberFile), members);
  assert.deepEqual(fs.readFileSync(fx.auditFile), audit);
  assert.deepEqual(events, []);

  state.left = 0;
  assert.equal((await mint(fx, restarted, owner.member_id, 'new_member', { role: 'member' })).ok, true);
});

test('B3: a display-only commit cannot advance the revision past an owed reconcile', async (t) => {
  const { fx, owner, mel, rev } = await lostRevoke(t);
  const { state, auditOptions } = failingAudit(2);
  const restarted = fx.openStore({ auditOptions });
  const members = fs.readFileSync(fx.memberFile);
  // The reconcile still cannot be written: the touch is skipped, quietly.
  const skipped = await restarted.touchDevice(owner.device_id);
  assert.equal(reasonOf(skipped), 'team_store_failed');
  assert.equal(restarted.rev(), rev);
  assert.deepEqual(fs.readFileSync(fx.memberFile), members);
  assert.notEqual(restarted.directory.resolveActor(owner.key), null, 'the store is not broken');
  assert.equal(state.left, 0);
  // Now it lands first, then the touch commits.
  assert.equal((await restarted.touchDevice(owner.device_id)).ok, true);
  assert.equal(restarted.rev(), rev + 1);
  assert.equal((await mint(fx, restarted, owner.member_id, 'new_member', { role: 'member' })).ok, true);
  const later = fx.openStore();
  const lost = later.audit.read({ cursor: 0 }).entries.find((entry) => entry.kind === 'device_revoked');
  assert.deepEqual([lost.store_rev, lost.applied], [rev + 1, false]);
  assert.notEqual(later.directory.resolveActor(mel.key), null);
});

test('B4: an owed reconcile retried on request traffic logs when its state changes, not per attempt', async (t) => {
  const { fx, owner } = await lostRevoke(t);
  const { state, auditOptions } = failingAudit(Infinity);
  const start = fx.logs.length;
  const restarted = fx.openStore({ auditOptions });
  const opened = fx.logs.length;
  for (let index = 0; index < 50; index += 1) {
    assert.equal(reasonOf(await restarted.touchDevice(owner.device_id)), 'team_store_failed');
  }
  const since = (from, event) => fx.logs.slice(from).filter((entry) => entry.event === event).length;
  assert.equal(since(start, 'team_store.audit_unavailable'), 1, 'one line when it starts failing');
  assert.equal(since(start, 'team_audit.write_failed'), 1);
  assert.deepEqual(fx.logs.slice(opened).filter((entry) => entry.level === 'ERROR'), [], 'the touches add no ERROR line');
  state.left = 0;
  assert.equal((await restarted.touchDevice(owner.device_id)).ok, true);
  assert.equal(since(opened, 'team_store.audit_reconciled'), 1, 'one line when it lands');
});

// An audit writeJson that, `left` times, either lands the file then throws or throws before writing.
function unknownAuditWrites({ lands }) {
  const state = { left: 0 };
  return {
    state,
    auditOptions: {
      writeJson(filePath, value) {
        if (state.left > 0) {
          state.left -= 1;
          if (lands) durableWriteJson(filePath, value);
          throw Object.assign(new Error('directory sync'), { code: 'EIO' });
        }
        durableWriteJson(filePath, value);
      },
    },
  };
}

test('B5: an audit append that landed and then threw is marked not applied before the next commit', async (t) => {
  const { fx, owner } = await team(t);
  const { state, auditOptions } = unknownAuditWrites({ lands: true });
  const store = fx.openStore({ auditOptions });
  const rev = store.rev();
  const members = fs.readFileSync(fx.memberFile);
  state.left = 1;
  assert.equal(reasonOf(await mint(fx, store, owner.member_id, 'new_member', { role: 'member' })), 'team_store_failed');
  assert.deepEqual(fs.readFileSync(fx.memberFile), members, 'the members file is unchanged');
  assert.equal(store.rev(), rev);
  assert.equal((await mint(fx, store, owner.member_id, 'new_member', { role: 'member' })).ok, true);
  const tail = fx.openStore().audit.read({ cursor: 0 }).entries.slice(-2);
  assert.deepEqual(tail.map((entry) => [entry.kind, entry.store_rev, entry.applied]),
    [['invite_created', rev + 1, false], ['invite_created', rev + 1, true]], 'the ghost reads as not applied');
  assert.ok(tail[1].seq > tail[0].seq, 'the real entry takes a new seq');
});

test('B5: an audit append that threw before it wrote marks nothing and writes nothing extra', async (t) => {
  const { fx, owner } = await team(t);
  const { state, auditOptions } = unknownAuditWrites({ lands: false });
  const store = fx.openStore({ auditOptions });
  const before = store.audit.read({ cursor: 0 }).entries.length;
  const audit = fs.readFileSync(fx.auditFile);
  state.left = 1;
  assert.equal(reasonOf(await mint(fx, store, owner.member_id, 'new_member', { role: 'member' })), 'team_store_failed');
  assert.deepEqual(fs.readFileSync(fx.auditFile), audit);
  assert.equal((await mint(fx, store, owner.member_id, 'new_member', { role: 'member' })).ok, true);
  const entries = fx.openStore().audit.read({ cursor: 0 }).entries;
  assert.equal(entries.length, before + 1);
  assert.equal(entries.every((entry) => entry.applied), true);
  assert.equal(fx.logs.some((entry) => entry.event === 'team_audit.unapplied_marked'), false);
});

// ------------------------------------------------------------------- C: names

test('C1: the input rule refuses blank and hidden names and keeps emoji and script joiners', () => {
  const { isInputText, isCleanText } = require('../../server/team/member-schema');
  for (const name of ['\u{3164}', '\u{2800}', '\u{115F}', '\u{1160}', '\u{FFA0}', 'Olive Owner\u{AD}', 'Olive Owner\u{FE0F}',
    'Olive Owner\u{E0041}', 'Sam\u{FE0E}']) {
    assert.equal(isInputText(name), false, JSON.stringify(name));
  }
  for (const name of ['\u{2764}\u{FE0F} Sam', '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} family', '\u{645}\u{6CC}\u{200C}\u{62E}\u{648}\u{627}\u{647}\u{645}',
    '#\u{FE0F}\u{20E3} Team', 'Olive Owner', 'Zo\u{EB}', '\u{845B}\u{E0100}\u{57CE}', '\u{9F8D}\u{FE00} Lin',
    '\u{2764}\u{FE0E} Sam', '\u{1F600}\u{FE0E}']) {
    assert.equal(isInputText(name), true, JSON.stringify(name));
    assert.equal(isCleanText(name), true);
  }
  for (const name of ['Sam\u{E0100}', 'Olive\u{FE00}', 'Olive\u{FE0E} Owner', '\u{E0100}Lin']) {
    assert.equal(isInputText(name), false, `a variation selector after no Han or emoji base: ${JSON.stringify(name)}`);
  }
  assert.equal(isInputText('Olive\u{200B}Owner'), false, 'everything isCleanText refuses');
});

test('C1: the name rules hold no literal invisible character a formatter could drop', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../server/team/member-schema.js'), 'utf8');
  const wide = [...source].filter((ch) => ch.charCodeAt(0) > 127);
  assert.deepEqual(wide, [], 'member-schema.js is ASCII: write code points as escapes');
});

test('C1: redeem, labels and the team name go through the input rule', async (t) => {
  const { fx, store, owner } = await team(t);
  const invite = await mint(fx, store, owner.member_id, 'new_member', { role: 'member' });
  const blank = await redeem(fx, store, invite.invite_id, '\u{3164}');
  assert.equal(reasonOf(blank.result), 'team_display_name_invalid');
  const label = await store.redeem({
    inviteId: invite.invite_id, devicePublicKey: fx.nextKey('d'), displayName: 'Mel', label: 'Laptop\u{AD}',
  });
  assert.equal(reasonOf(label), 'team_label_invalid');
  assert.equal(reasonOf(await store.rename({ actorMemberId: owner.member_id, name: '\u{2800}' })), 'team_name_invalid');
  assert.equal(store.isInviteLive(invite.invite_id), true, 'a refused redeem burns nothing');
});

test('C2: a display name equal to a live member\'s is refused; a revoked member\'s name is free', async (t) => {
  const { fx, store, owner } = await team(t);
  const pending = await fx.joinMember(store, owner.member_id, { displayName: 'Pat Pending', admit: false });
  await fx.joinMember(store, owner.member_id, { displayName: 'Anna Stra\u{DF}e' });
  await fx.joinMember(store, owner.member_id, { displayName: '\u{3A3}\u{3BF}\u{3C6}\u{3BF}\u{3C3}' });
  for (const name of ['Olive Owner\u{2800}', 'Olive\u{2800}Owner', 'ANNA STRASSE', '\u{3A3}\u{3BF}\u{3C6}\u{3BF}\u{3C2}',
    'Olive Owner', 'olive OWNER','Olive Ow\u{200D}ner', 'Olive  Owner', '\u{FF2F}live Owner', 'pat pending']) {
    const invite = await mint(fx, store, owner.member_id, 'new_member', { role: 'member' });
    const { result } = await redeem(fx, store, invite.invite_id, name);
    assert.equal(reasonOf(result), 'team_display_name_taken', JSON.stringify(name));
    assert.equal(store.isInviteLive(invite.invite_id), true, 'a taken name keeps the invite (E79)');
    assert.equal((await store.revokeInvite({ actorMemberId: owner.member_id, inviteId: invite.invite_id })).ok, true);
  }
  assert.equal((await store.revokeMember({ actorMemberId: owner.member_id, memberId: pending.member_id })).ok, true);
  const invite = await mint(fx, store, owner.member_id, 'new_member', { role: 'member' });
  const { result } = await redeem(fx, store, invite.invite_id, 'Pat Pending');
  assert.equal(result.ok, true, 'the name of a revoked member may be taken');
});

test('C3: a stored document holding a name the input rule refuses still loads', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const doc = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
  doc.members[0].display_name = 'Olive Owner\u{AD}';
  doc.devices[0].label = '\u{3164}';
  doc.team.name = 'Atelier\u{FE0F}';
  fs.writeFileSync(fx.memberFile, JSON.stringify(doc));
  const reopened = fx.openStore();
  assert.equal(reopened.getMember(owner.member_id).display_name, 'Olive Owner\u{AD}');
  assert.equal(reopened.teamName(), 'Atelier\u{FE0F}');
  assert.notEqual(reopened.directory.resolveActor(owner.key), null);
});

// ----------------------------------------------------------------- D: backup

async function schemaOneFile(t) {
  const fx = createFixture(t);
  await fx.bootstrapOwner(fx.openStore());
  const doc = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
  delete doc.projects;
  delete doc.team.model;
  for (const invite of doc.invites) delete invite.name_refusals;
  doc.schema_version = 1;
  fs.writeFileSync(fx.memberFile, JSON.stringify(doc, null, 2));
  return { fx, before: fs.readFileSync(fx.memberFile) };
}

function backupsIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.bak'));
}

test('D1: opening a schema 1 file writes exactly one backup of the old bytes, once', async (t) => {
  const { fx, before } = await schemaOneFile(t);
  const store = fx.openStore();
  assert.deepEqual(backupsIn(fx.dir), ['team-members.json.v1.bak']);
  const backup = path.join(fx.dir, 'team-members.json.v1.bak');
  assert.deepEqual(fs.readFileSync(backup), before, 'the old bytes, as they were');
  assert.deepEqual(fs.readFileSync(fx.memberFile), before, 'opening does not rewrite the store');

  const first = fs.statSync(backup, { bigint: true });
  fx.openStore();
  assert.deepEqual(backupsIn(fx.dir), ['team-members.json.v1.bak'], 'a second open writes no second one');
  const second = fs.statSync(backup, { bigint: true });
  assert.deepEqual([second.ino, second.mtimeNs], [first.ino, first.mtimeNs], 'an existing backup is not rewritten');

  const owner = store.snapshot().members[0];
  assert.equal((await mint(fx, store, owner.member_id, 'new_member', { role: 'member' })).ok, true);
  assert.deepEqual(fs.readFileSync(backup), before, 'the old backup is unchanged after the commit');
});

test('D2: a backup that differs from the file read fails the open closed and nothing is overwritten', async (t) => {
  const { fx, before } = await schemaOneFile(t);
  const backup = path.join(fx.dir, 'team-members.json.v1.bak');
  fs.writeFileSync(backup, ''); // a create that a crash cut short
  assert.equal(reasonOf(fx.newStore().open()), 'team_unavailable');
  assert.ok(fx.logs.some((entry) => entry.event === 'team_store.broken' && entry.fields.stage === 'backup'));
  assert.deepEqual(fs.readFileSync(fx.memberFile), before);
  assert.equal(fs.readFileSync(backup).length, 0, 'the planted backup is left for a person');
});

test('D2: a left-over temporary backup is replaced and the final name appears complete', async (t) => {
  const { fx, before } = await schemaOneFile(t);
  const backup = path.join(fx.dir, 'team-members.json.v1.bak');
  fs.writeFileSync(`${backup}.tmp`, 'torn');
  fx.openStore();
  assert.deepEqual(fs.readFileSync(backup), before);
  assert.equal(fs.existsSync(`${backup}.tmp`), false);
});

test('D2: the real backup writer refuses a linked source and bytes that are not the document read', async (t) => {
  const { writeBackupOnce } = require('../../server/team/member-store');
  const { fx } = await schemaOneFile(t);
  const backup = path.join(fx.dir, 'team-members.json.v1.bak');
  const stored = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
  const options = { maxBytes: 256 * 1024, expected: stored };
  assert.throws(() => writeBackupOnce(fx.memberFile, backup, { ...options, expected: { ...stored, rev: stored.rev + 1 } }),
    /backup_source_changed/u);
  fs.linkSync(fx.memberFile, path.join(fx.dir, 'second-name.json'));
  assert.throws(() => writeBackupOnce(fx.memberFile, backup, options), /backup_source_invalid/u);
  assert.deepEqual(backupsIn(fx.dir), []);
});

test('D1: a failed backup write fails the open and leaves the original file untouched', async (t) => {
  const { fx, before } = await schemaOneFile(t);
  const store = fx.newStore({ writeBackup() { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } });
  assert.equal(reasonOf(store.open()), 'team_unavailable');
  assert.equal(store.directory.resolveActor(fx.key('owner-device-1')), null, 'nobody resolves');
  assert.equal(reasonOf(await store.rename({ actorMemberId: 'member_x', name: 'New' })), 'team_unavailable');
  assert.deepEqual(fs.readFileSync(fx.memberFile), before);
  assert.deepEqual(backupsIn(fx.dir), []);
  assert.ok(fx.logs.some((entry) => entry.event === 'team_store.broken' && entry.fields.stage === 'backup'));

  fx.openStore();
  assert.deepEqual(backupsIn(fx.dir), ['team-members.json.v1.bak'], 'the next start writes it');
});

test('D1: no backup for a store that needed no upgrade', async (t) => {
  const fx = createFixture(t);
  await fx.bootstrapOwner(fx.openStore());
  fx.openStore();
  assert.deepEqual(backupsIn(fx.dir), []);
});
// D3 (the schema 2 to 3 upgrade) lives in team-member-store.test.js beside the schema 4 upgrade (E79).
