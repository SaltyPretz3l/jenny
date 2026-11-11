'use strict';

// Shared fixture for the team member store tests: a temporary user-data
// directory, a mutable clock, deterministic random bytes, deterministic public
// keys and a log sink. Production modules are required lazily so a missing
// module fails the test that needs it.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const START_MS = 1_800_000_000_000;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest();
}

function createFixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-store-'));
  if (t && typeof t.after === 'function') t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let nowMs = options.start ?? START_MS;
  let randomCounter = 0;
  let keyCounter = 0;
  const logs = [];

  const fx = {
    dir,
    logs,
    memberFile: path.join(dir, 'team-members.json'),
    auditFile: path.join(dir, 'team-audit.json'),
    clock: () => nowMs,
    advance(ms) { nowMs += ms; return nowMs; },
    logger(level, event, fields) { logs.push({ level, event, fields: fields ?? {} }); },
    randomBytes(size) {
      const out = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const block = sha256(`random-${randomCounter++}`);
        block.copy(out, offset, 0, Math.min(block.length, size - offset));
        offset += block.length;
      }
      return out;
    },
    key(label) {
      return sha256(`key-${label}`).toString('base64url');
    },
    nextKey(prefix = 'k') {
      keyCounter += 1;
      return fx.key(`${prefix}-${keyCounter}`);
    },
    get hostKey() { return fx.key('host'); },
    storeOptions(overrides = {}) {
      return {
        userDataPath: dir,
        hostPublicKey: fx.hostKey,
        teamName: 'Atelier',
        clock: fx.clock,
        randomBytes: fx.randomBytes,
        logger: fx.logger,
        ...overrides,
      };
    },
    newStore(overrides = {}) {
      const { MemberStore } = require('../../../server/team/member-store');
      return new MemberStore(fx.storeOptions(overrides));
    },
    openStore(overrides = {}) {
      const store = fx.newStore(overrides);
      const opened = store.open();
      if (!opened.ok) throw new Error(`fixture store did not open: ${opened.error.reason}`);
      return store;
    },
    // First owner through the owner_first invite, as the local command mints it.
    async bootstrapOwner(store, displayName = 'Olive Owner') {
      const key = fx.nextKey('owner-device');
      const invitePublicKey = fx.nextKey('owner-invite');
      const created = await store.createInvite({
        kind: 'owner_first', actorMemberId: null, invitePublicKey,
      });
      if (!created.ok) throw new Error(`owner invite failed: ${created.error.reason}`);
      const redeemed = await store.redeem({
        inviteId: created.invite_id, devicePublicKey: key, displayName, label: 'Owner laptop',
      });
      if (!redeemed.ok) throw new Error(`owner redeem failed: ${redeemed.error.reason}`);
      return { member_id: redeemed.member_id, device_id: redeemed.device_id, key, invite_id: created.invite_id };
    },
    // A member who joined with a new-member invite; admitted unless told otherwise.
    async joinMember(store, ownerId, {
      displayName = 'Member', role = 'member', admit = true, label = 'Laptop',
    } = {}) {
      const key = fx.nextKey('device');
      const created = await store.createInvite({
        kind: 'new_member', actorMemberId: ownerId, role, invitePublicKey: fx.nextKey('invite'),
      });
      if (!created.ok) throw new Error(`member invite failed: ${created.error.reason}`);
      const redeemed = await store.redeem({
        inviteId: created.invite_id, devicePublicKey: key, displayName, label,
      });
      if (!redeemed.ok) throw new Error(`member redeem failed: ${redeemed.error.reason}`);
      if (admit) {
        const admitted = await store.admit({ actorMemberId: ownerId, memberId: redeemed.member_id });
        if (!admitted.ok) throw new Error(`admit failed: ${admitted.error.reason}`);
      }
      return { member_id: redeemed.member_id, device_id: redeemed.device_id, key };
    },
    async addDevice(store, memberId, label = 'Phone') {
      const key = fx.nextKey('device');
      const created = await store.createInvite({
        kind: 'add_device', actorMemberId: memberId, invitePublicKey: fx.nextKey('invite'),
      });
      if (!created.ok) return created;
      const redeemed = await store.redeem({
        inviteId: created.invite_id, devicePublicKey: key, displayName: 'ignored', label,
      });
      return redeemed.ok ? { ...redeemed, key } : redeemed;
    },
    // One person in every team state the project rules care about: the owner,
    // full members M, A, T and X, read-only R, pending P and revoked V.
    async buildTeam(store) {
      const owner = await fx.bootstrapOwner(store);
      const ids = { O: owner.member_id };
      for (const [label, options] of [['M', {}], ['A', {}], ['T', {}], ['X', {}],
        ['R', { role: 'read_only' }], ['P', { admit: false }], ['V', {}]]) {
        ids[label] = (await fx.joinMember(store, owner.member_id, { displayName: `Person ${label}`, ...options })).member_id;
      }
      const revoked = await store.revokeMember({ actorMemberId: owner.member_id, memberId: ids.V });
      if (!revoked.ok) throw new Error(`revoke failed: ${revoked.error.reason}`);
      return ids;
    },
  };
  return fx;
}

// The owner invariant, read from the public snapshot: no members means no
// owner; any member means exactly one owner and that owner is active.
function assertOwnerInvariant(assert, store) {
  const doc = store.snapshot();
  const owners = doc.members.filter((member) => member.role === 'owner');
  if (doc.members.length === 0) {
    assert.equal(owners.length, 0, 'an empty store has no owner');
    return;
  }
  assert.equal(owners.length, 1, 'exactly one owner');
  assert.equal(owners[0].state, 'active', 'the owner is active');
}

module.exports = { createFixture, assertOwnerInvariant, START_MS };
