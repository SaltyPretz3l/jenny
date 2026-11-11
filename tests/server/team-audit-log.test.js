'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createFixture } = require('./helpers/team-store-fixture');
const { AUDIT_KINDS, AUDIT_LIMITS, AuditLog } = require('../../server/team/audit-log');

function entry(overrides = {}) {
  return { kind: 'invite_created', store_rev: 1, detail: 'kind=new_member,role=member', ...overrides };
}

function openLog(fx, options = {}) {
  return new AuditLog({
    filePath: fx.auditFile, clock: fx.clock, logger: fx.logger, ...options,
  });
}

function auditKinds(store) {
  return store.audit.read({ cursor: 0, limit: 100 }).entries.map((item) => item.kind);
}

const dead = () => { throw Object.assign(new Error('disk gone'), { code: 'EIO' }); };

// ------------------------------------------------------------------ paging

test('read pages at most 100 entries, oldest first, with a cursor', (t) => {
  const fx = createFixture(t);
  const log = openLog(fx);
  for (let batch = 0; batch < 15; batch += 1) {
    assert.equal(log.append(Array.from({ length: 8 }, () => entry())).ok, true);
  }
  const first = log.read({ cursor: 0, limit: 1000 });
  assert.equal(first.entries.length, 100);
  assert.equal(first.entries[0].seq, 1);
  assert.equal(first.next_cursor, 100);
  const second = log.read({ cursor: first.next_cursor, limit: 100 });
  assert.equal(second.entries.length, 20);
  assert.equal(second.entries[0].seq, 101);
  assert.equal(second.next_cursor, null);
  assert.equal(log.read({ cursor: 0, limit: 3 }).entries.length, 3);
  assert.equal(log.read({ cursor: 120, limit: 10 }).entries.length, 0);
  for (const bad of [{ cursor: -1 }, { cursor: 1.5 }, { cursor: 'x' }, { limit: 0 }, { limit: 'many' }]) {
    const result = log.read(bad);
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, 'team_cursor_invalid');
  }
  // Returned entries are copies.
  first.entries[0].kind = 'tampered';
  assert.equal(log.read({ cursor: 0, limit: 1 }).entries[0].kind, 'invite_created');
});

test('entries have exactly the documented fields and persist across a reopen', (t) => {
  const fx = createFixture(t);
  const log = openLog(fx);
  log.append([entry({
    kind: 'member_admitted', actor_member_id: 'member_actorXXXXXXXXXXXXXX', name: 'Mina', store_rev: 4,
  })]);
  const [saved] = openLog(fx).read({ cursor: 0 }).entries;
  assert.deepEqual(Object.keys(saved), [
    'seq', 'at', 'kind', 'actor_member_id', 'subject_member_id', 'subject_device_id', 'name', 'detail',
    'store_rev', 'applied', 'project_id',
  ]);
  assert.equal(saved.at, fx.clock());
  assert.equal(saved.applied, true);
  assert.equal(saved.store_rev, 4);
  assert.equal(saved.subject_member_id, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(fx.auditFile, 'utf8')).schema_version, 2);
});

test('entries never hold a key, an address or an invite string; bad entries are refused', (t) => {
  const fx = createFixture(t);
  const log = openLog(fx);
  for (const bad of [
    entry({ detail: fx.key('a-device') }),
    entry({ detail: `see ${fx.key('a-device')}` }),
    entry({ detail: 'jteam1_AAAA' }),
    entry({ detail: 'jteamaddr1_AAAA' }),
    entry({ detail: 'x'.repeat(161) }),
    entry({ detail: 'new\nline' }),
    entry({ kind: 'made_up' }),
    entry({ actor_member_id: 'not-an-id' }),
    entry({ name: ' padded' }),
    entry({ store_rev: -1 }),
    entry({ store_rev: undefined }),
  ]) {
    assert.throws(() => log.append([bad]), TypeError);
  }
  assert.throws(() => log.append([]), TypeError);
  assert.throws(() => log.append(Array.from({ length: 9 }, () => entry())), TypeError);
  assert.equal(fs.existsSync(fx.auditFile), false, 'refused entries write nothing');
  assert.ok(AUDIT_KINDS.includes('recovery_used') && AUDIT_KINDS.includes('team_renamed') && AUDIT_KINDS.length === 12);
});

// ------------------------------------------------------------------ bounds

test('the floor moves when the entry bound is reached; seq keeps counting', (t) => {
  const fx = createFixture(t);
  const log = openLog(fx, { maxEntries: 5 });
  for (let index = 0; index < 8; index += 1) log.append([entry({ store_rev: index + 1 })]);
  const page = log.read({ cursor: 0, limit: 100 });
  assert.deepEqual(page.entries.map((item) => item.seq), [4, 5, 6, 7, 8]);
  assert.equal(page.floor_seq, 4);
  assert.equal(log.floorSeq(), 4);
  assert.equal(log.append([entry({ store_rev: 9 })]).seqs[0], 9);
  assert.equal(openLog(fx, { maxEntries: 5 }).floorSeq(), 5, 'the floor is recorded on disk');
});

test('the byte bound drops the oldest entries too, and the file stays inside it', (t) => {
  const fx = createFixture(t);
  const maxBytes = 3000;
  const log = openLog(fx, { maxBytes });
  for (let index = 0; index < 40; index += 1) log.append([entry({ store_rev: index + 1, name: 'Mina Quixote' })]);
  const size = fs.statSync(fx.auditFile).size;
  assert.ok(size <= maxBytes, `file is ${size} bytes`);
  const page = log.read({ cursor: 0 });
  assert.ok(page.entries.length < 40 && page.entries.length > 3);
  assert.equal(page.entries.at(-1).seq, 40);
  assert.equal(page.floor_seq, page.entries[0].seq);
  assert.ok(page.floor_seq > 1);
});

test('at the real limit of 5,000 entries one more append drops exactly the oldest', (t) => {
  const fx = createFixture(t);
  const entries = Array.from({ length: AUDIT_LIMITS.MAX_ENTRIES }, (_unused, index) => ({
    seq: index + 1, at: 1, kind: 'invite_created', actor_member_id: null, subject_member_id: null,
    subject_device_id: null, name: null, detail: null, store_rev: 1, applied: true,
  }));
  fs.writeFileSync(fx.auditFile, JSON.stringify({
    schema_version: 1, floor_seq: 1, next_seq: AUDIT_LIMITS.MAX_ENTRIES + 1, entries,
  }));
  const log = openLog(fx);
  assert.equal(log.append([entry({ store_rev: 2 })]).ok, true);
  const doc = JSON.parse(fs.readFileSync(fx.auditFile, 'utf8'));
  assert.equal(doc.entries.length, 5000);
  assert.equal(doc.floor_seq, 2);
  assert.equal(doc.entries.at(-1).seq, 5001);
  assert.ok(fs.statSync(fx.auditFile).size <= AUDIT_LIMITS.MAX_BYTES);
});

// ----------------------------------------------------------- strict load

test('an unreadable or invalid audit log is never rewritten and refuses appends', (t) => {
  const cases = [
    Buffer.from([0x00, 0xff, 0x80]),
    '[]',
    JSON.stringify({ schema_version: 3, floor_seq: 1, next_seq: 1, entries: [] }),
    JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 1, entries: [], extra: true }),
    JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 2, entries: [{ seq: 1 }] }),
    JSON.stringify({ schema_version: 1, floor_seq: 3, next_seq: 2, entries: [] }),
  ];
  for (const bytes of cases) {
    const fx = createFixture(t);
    fs.writeFileSync(fx.auditFile, bytes);
    const log = openLog(fx);
    const refused = log.append([entry()]);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.reason, 'team_unavailable');
    assert.equal(log.read({ cursor: 0 }).error.reason, 'team_unavailable');
    assert.equal(log.reconcile(0).error.reason, 'team_unavailable');
    assert.deepEqual(fs.readFileSync(fx.auditFile), Buffer.from(bytes));
  }
});

test('a broken audit log refuses member mutations and leaves the member store unchanged', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const before = fs.readFileSync(fx.memberFile);
  const garbage = Buffer.from('not json at all');
  fs.writeFileSync(fx.auditFile, garbage);
  const broken = fx.openStore();
  const result = await broken.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'team_unavailable');
  assert.deepEqual(fs.readFileSync(fx.memberFile), before);
  assert.deepEqual(fs.readFileSync(fx.auditFile), garbage);
  assert.equal(broken.rev(), store.rev());
  assert.ok(broken.directory.resolveActor(owner.key), 'reads keep working');
});

// -------------------------------------------------------------- audit first

test('every committed mutation has an audit entry stamped with the revision it produced', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const last = () => store.audit.read({ cursor: 0, limit: 100 }).entries.at(-1);
  assert.equal(last().store_rev, store.rev());

  const joined = await fx.joinMember(store, owner.member_id, { displayName: 'Mina', admit: false });
  assert.equal(last().store_rev, store.rev());
  assert.equal(last().kind, 'invite_redeemed');
  await store.admit({ actorMemberId: owner.member_id, memberId: joined.member_id });
  assert.deepEqual([last().kind, last().store_rev, last().name], ['member_admitted', store.rev(), 'Mina']);
  await store.setRole({ actorMemberId: owner.member_id, memberId: joined.member_id, role: 'read_only' });
  assert.equal(last().kind, 'role_changed');
  assert.equal(last().detail, 'from=member,to=read_only');
  const phone = await fx.addDevice(store, joined.member_id);
  assert.equal(last().kind, 'device_added');
  assert.equal(last().subject_device_id, phone.device_id);
  await store.revokeDevice({ actorMemberId: joined.member_id, deviceId: phone.device_id });
  assert.equal(last().kind, 'device_revoked');
  await store.transferOwner({ actorMemberId: owner.member_id, memberId: joined.member_id });
  assert.equal(last().kind, 'owner_transferred');
  assert.equal(last().actor_member_id, owner.member_id);
  assert.equal(last().subject_member_id, joined.member_id);
  const spare = await store.createInvite({
    kind: 'new_member', actorMemberId: joined.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  await store.revokeInvite({ actorMemberId: joined.member_id, inviteId: spare.invite_id });
  assert.equal(last().kind, 'invite_revoked');
  const leaver = await fx.joinMember(store, joined.member_id, { displayName: 'Leo' });
  await store.leave({ memberId: leaver.member_id });
  assert.equal(last().kind, 'member_left');
  await store.revokeMember({ actorMemberId: joined.member_id, memberId: owner.member_id });
  assert.equal(last().kind, 'member_revoked');
  assert.ok(last().applied);

  // Refused mutations and last_seen touches write no audit entry.
  const count = store.audit.read({ cursor: 0 }).entries.length;
  await store.revokeMember({ actorMemberId: joined.member_id, memberId: joined.member_id });
  await store.touchDevice(joined.device_id);
  assert.equal(store.audit.read({ cursor: 0 }).entries.length, count);

  const kinds = new Set(auditKinds(store));
  for (const kind of ['invite_created', 'invite_redeemed', 'invite_revoked', 'member_admitted', 'role_changed',
    'member_revoked', 'member_left', 'device_added', 'device_revoked', 'owner_transferred']) {
    assert.ok(kinds.has(kind), kind);
  }
  const disk = fs.readFileSync(fx.auditFile, 'utf8');
  for (const key of [owner.key, joined.key, phone.key]) assert.equal(disk.includes(key), false, 'no key on disk');
});

test('recovery writes recovery_used, a device_revoked per dropped device and device_added', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  await fx.addDevice(store, owner.member_id, 'Tablet');
  const minted = await store.createInvite({ kind: 'recovery', actorMemberId: null, invitePublicKey: fx.nextKey() });
  assert.equal(store.audit.read({ cursor: 0 }).entries.at(-1).actor_member_id, null);
  const before = store.audit.read({ cursor: 0 }).entries.length;
  await store.redeem({
    inviteId: minted.invite_id, devicePublicKey: fx.nextKey(), displayName: 'x', label: 'New PC',
  });
  const added = store.audit.read({ cursor: 0 }).entries.slice(before);
  assert.deepEqual(added.map((item) => item.kind), ['recovery_used', 'device_revoked', 'device_revoked', 'device_added']);
  assert.equal(added[0].detail, 'revoked_devices=2');
  assert.equal(new Set(added.map((item) => item.store_rev)).size, 1, 'one mutation, one revision');
});

test('audit written, commit skipped: reopening marks the entry not applied and the store is unchanged', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const rev = store.rev();
  const before = fs.readFileSync(fx.memberFile);

  // The process dies after the audit write and before the member document lands:
  // the injected writer reports success and writes nothing.
  const crashing = fx.openStore({ writeJson() { /* the commit never happens */ } });
  const result = await crashing.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(fs.readFileSync(fx.memberFile), before);
  const written = crashing.audit.read({ cursor: 0 }).entries.at(-1);
  assert.equal(written.kind, 'invite_created');
  assert.equal(written.store_rev, rev + 1);
  assert.equal(written.applied, true, 'until the reboot nobody knows');

  const reopened = fx.openStore();
  assert.equal(reopened.rev(), rev);
  assert.deepEqual(reopened.snapshot(), store.snapshot(), 'the member store is unchanged');
  const entries = reopened.audit.read({ cursor: 0 }).entries;
  assert.equal(entries.at(-1).kind, 'invite_created');
  assert.equal(entries.at(-1).applied, false);
  assert.ok(entries.slice(0, -1).every((item) => item.applied), 'earlier entries stay applied');

  // A second reopen does not change anything, and a later real mutation reusing
  // the same revision is applied while the lost entry stays marked.
  assert.equal(fx.openStore().audit.read({ cursor: 0 }).entries.at(-1).applied, false);
  const created = await reopened.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  assert.equal(created.ok, true);
  const again = fx.openStore().audit.read({ cursor: 0 }).entries;
  assert.deepEqual(again.slice(-2).map((item) => [item.kind, item.store_rev, item.applied]), [
    ['invite_created', rev + 1, false],
    ['invite_created', rev + 1, true],
  ]);
});

test('a first-owner commit lost before the file exists is marked not applied on open', async (t) => {
  const fx = createFixture(t);
  const crashing = fx.openStore({ writeJson() { /* lost */ } });
  const owner = await fx.bootstrapOwner(crashing);
  assert.ok(owner.member_id);
  assert.equal(fs.existsSync(fx.memberFile), false);
  const reopened = fx.openStore();
  assert.equal(reopened.rev(), 0);
  assert.equal(reopened.snapshot().members.length, 0);
  const entries = reopened.audit.read({ cursor: 0 }).entries;
  assert.ok(entries.length >= 1);
  assert.ok(entries.every((item) => item.applied === false));
});

test('an audit write failure refuses the mutation and nothing else changes', async (t) => {
  const fx = createFixture(t);
  let failing = false;
  const store = fx.openStore({
    auditOptions: {
      writeJson(filePath, value) {
        if (failing) dead();
        return require('../../services/host/durable-json').writeJson(filePath, value);
      },
    },
  });
  const owner = await fx.bootstrapOwner(store);
  const rev = store.rev();
  const before = fs.readFileSync(fx.memberFile);
  const events = [];
  store.onMembershipChange((event) => events.push(event));

  failing = true;
  const joined = await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  assert.equal(joined.ok, false);
  assert.equal(joined.error.reason, 'team_store_failed');
  assert.equal(joined.error.code, 'CMP-HOST-0006');
  const revoke = await store.transferOwner({ actorMemberId: owner.member_id, memberId: 'member_nobody' });
  assert.equal(revoke.error.reason, 'team_not_found', 'validation failures still come first');
  assert.equal(store.rev(), rev);
  assert.deepEqual(fs.readFileSync(fx.memberFile), before);
  assert.deepEqual(events, []);
  assert.ok(store.directory.resolveActor(owner.key), 'the store is not broken by an audit failure');

  failing = false;
  const retried = await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  assert.equal(retried.ok, true);
  assert.equal(store.rev(), rev + 1);
});

test('an audit write failure on a membership change leaves state, directory and events untouched', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  fs.rmSync(fx.auditFile);
  fs.mkdirSync(fx.auditFile); // the audit path is now a directory: reads and writes both fail
  const events = [];
  const reopened = fx.openStore();
  reopened.onMembershipChange((event) => events.push(event));
  const result = await reopened.revokeMember({ actorMemberId: owner.member_id, memberId: joined.member_id });
  assert.equal(result.ok, false);
  assert.ok(['team_unavailable', 'team_store_failed'].includes(result.error.reason));
  assert.equal(reopened.getMember(joined.member_id).state, 'active');
  assert.ok(reopened.directory.resolveActor(joined.key));
  assert.deepEqual(events, []);
});

test('assertSafePath guards the audit log reads and writes', (t) => {
  const fx = createFixture(t);
  const seen = [];
  const log = openLog(fx, { assertSafePath(filePath) { seen.push(path.basename(filePath)); } });
  log.append([entry()]);
  assert.deepEqual([...new Set(seen)], ['team-audit.json']);
  assert.ok(seen.length >= 2);
  const blocked = openLog(fx, { assertSafePath() { throw new Error('junction'); } });
  assert.equal(blocked.append([entry()]).error.reason, 'team_unavailable');
});

// ------------------------------------------------- schema 2 (slice 3-1)

function project(overrides = {}) {
  return entry({ kind: 'project_created', project_id: 'project_p1', detail: 'role=admin', ...overrides });
}

test('a schema 1 audit file loads, reads and is written as schema 2 by its first append', (t) => {
  const fx = createFixture(t);
  const v1 = {
    seq: 1, at: 1, kind: 'member_admitted', actor_member_id: null, subject_member_id: null,
    subject_device_id: null, name: 'Mina', detail: null, store_rev: 3, applied: true,
  };
  fs.writeFileSync(fx.auditFile, JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 2, entries: [v1] }));
  const before = fs.readFileSync(fx.auditFile);
  const log = openLog(fx);
  assert.deepEqual(log.read({ cursor: 0 }).entries, [{ ...v1, project_id: null }]);
  assert.deepEqual(fs.readFileSync(fx.auditFile), before, 'reading never writes');
  assert.equal(log.reconcile(3).marked, 0);
  assert.equal(log.append([project({ store_rev: 4 })]).ok, true);
  const doc = JSON.parse(fs.readFileSync(fx.auditFile, 'utf8'));
  assert.equal(doc.schema_version, 2);
  assert.deepEqual(doc.entries.map((item) => [item.seq, item.kind, item.project_id, item.name]),
    [[1, 'member_admitted', null, 'Mina'], [2, 'project_created', 'project_p1', null]]);
});

test('a schema 1 audit file with a schema 2 key or a project kind is refused and left alone', (t) => {
  const base = {
    seq: 1, at: 1, kind: 'member_admitted', actor_member_id: null, subject_member_id: null,
    subject_device_id: null, name: null, detail: null, store_rev: 1, applied: true,
  };
  for (const bad of [{ ...base, project_id: null }, { ...base, kind: 'project_created' }]) {
    const fx = createFixture(t);
    const bytes = JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 2, entries: [bad] });
    fs.writeFileSync(fx.auditFile, bytes);
    assert.equal(openLog(fx).append([entry()]).error.reason, 'team_unavailable');
    assert.equal(fs.readFileSync(fx.auditFile, 'utf8'), bytes);
  }
});

test('project entries carry a project id and ids only; membership entries carry none', (t) => {
  const fx = createFixture(t);
  const log = openLog(fx);
  for (const bad of [
    project({ project_id: undefined }),
    project({ project_id: 'project_general' }),
    project({ project_id: 'not a project' }),
    project({ name: 'Mina' }),
    project({ subject_device_id: 'device_AAAAAAAAAAAAAAAAAAAAAA' }),
    entry({ project_id: 'project_p1' }),
  ]) {
    assert.throws(() => log.append([bad]), TypeError);
  }
  assert.equal(fs.existsSync(fx.auditFile), false);
  for (const kind of ['project_created', 'project_member_added', 'project_role_changed', 'project_member_removed',
    'project_owner_self_added', 'project_deleting', 'project_deleted', 'project_reconciled']) {
    assert.equal(log.append([project({ kind })]).ok, true, kind);
  }
});

test('the entry bound and floor_seq hold with project kinds', (t) => {
  const fx = createFixture(t);
  const log = openLog(fx, { maxEntries: 5 });
  for (let index = 0; index < 4; index += 1) {
    log.append([project({ store_rev: index + 1 }), entry({ store_rev: index + 1 })]);
  }
  const page = log.read({ cursor: 0 });
  assert.deepEqual(page.entries.map((item) => item.seq), [4, 5, 6, 7, 8]);
  assert.equal(page.floor_seq, 4);
  assert.deepEqual(page.entries.map((item) => item.project_id), [null, 'project_p1', null, 'project_p1', null]);
  assert.equal(openLog(fx, { maxEntries: 5 }).floorSeq(), 4);
});

test('read newest first pages backwards from the newest entry, at most 100 at a time', (t) => {
  const fx = createFixture(t);
  const log = openLog(fx);
  for (let batch = 0; batch < 15; batch += 1) log.append(Array.from({ length: 8 }, () => entry()));
  const first = log.read({ order: 'newest', limit: 1000 });
  assert.equal(first.entries.length, 100);
  assert.deepEqual([first.entries[0].seq, first.entries.at(-1).seq, first.next_cursor], [120, 21, 21]);
  const second = log.read({ order: 'newest', cursor: first.next_cursor, limit: 100 });
  assert.deepEqual(second.entries.map((item) => item.seq), [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6,
    5, 4, 3, 2, 1]);
  assert.equal(second.next_cursor, null);
  assert.deepEqual(log.read({ order: 'newest', cursor: 3 }).entries.map((item) => item.seq), [2, 1]);
  assert.deepEqual(log.read({ order: 'newest', limit: 2 }).entries.map((item) => item.seq), [120, 119]);
  assert.equal(log.read({ order: 'sideways' }).error.reason, 'team_cursor_invalid');
  assert.equal(log.read({ order: 'newest', cursor: -1 }).error.reason, 'team_cursor_invalid');
  first.entries[0].kind = 'tampered';
  assert.equal(log.read({ order: 'newest', limit: 1 }).entries[0].kind, 'invite_created', 'pages are copies');
});

test('a reconcile that upgrades a schema 1 file at the byte cap stays inside it and stays readable', (t) => {
  const fx = createFixture(t);
  const id = (prefix, index) => `${prefix}_${String(index).padStart(64, 'A')}`;
  const v1 = (seq, storeRev) => ({
    seq, at: 1, kind: 'role_changed', actor_member_id: id('member', seq), subject_member_id: id('member', seq + 1),
    subject_device_id: id('device', seq), name: 'Mina Quixote Lindqvist-Arbuthnot Smith', detail: 'abc.'.repeat(40),
    store_rev: storeRev, applied: true,
  });
  const header = Buffer.byteLength(JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 100000, entries: [] }), 'utf8');
  const perEntry = Buffer.byteLength(JSON.stringify(v1(10000, 1)), 'utf8') + 1;
  const count = Math.floor((AUDIT_LIMITS.MAX_BYTES - header - 64) / perEntry);
  assert.ok(count < AUDIT_LIMITS.MAX_ENTRIES && count * 19 > 64, 'the upgrade alone would pass the cap');
  const entries = Array.from({ length: count }, (_unused, index) => v1(10000 + index, index >= count - 3 ? 9 : 1));
  fs.writeFileSync(fx.auditFile, JSON.stringify({ schema_version: 1, floor_seq: 1, next_seq: 10000 + count, entries }));
  assert.ok(fs.statSync(fx.auditFile).size <= AUDIT_LIMITS.MAX_BYTES, 'the schema 1 file loads');

  const reconciled = openLog(fx).reconcile(1);
  assert.deepEqual([reconciled.ok, reconciled.marked], [true, 3]);
  assert.ok(fs.statSync(fx.auditFile).size <= AUDIT_LIMITS.MAX_BYTES, `file is ${fs.statSync(fx.auditFile).size} bytes`);
  const reopened = openLog(fx);
  const tail = reopened.read({ order: 'newest', limit: 3 });
  assert.equal(tail.ok, true, 'the log is still readable');
  assert.deepEqual(tail.entries.map((item) => item.applied), [false, false, false]);
  assert.ok(tail.floor_seq > 10000, 'the oldest entries were dropped to fit');
  assert.equal(JSON.parse(fs.readFileSync(fx.auditFile, 'utf8')).schema_version, 2);
});
