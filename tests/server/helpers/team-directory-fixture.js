'use strict';

// A stand-in for the member directory (slice 1a): one owner, two members, one
// read-only member, one pending member, one invite principal and one revoked
// member. It implements exactly the interface the authorizer reads, and lets a
// test change a device's live state while a request is awaited.

const PRINCIPALS = Object.freeze(['owner', 'member', 'read_only', 'pending', 'invite', 'revoked']);

const SEED = Object.freeze({
  owner: { member_id: 'member_owner', device_id: 'device_owner', role: 'owner', state: 'active' },
  member: { member_id: 'member_a', device_id: 'device_a1', role: 'member', state: 'active' },
  otherMember: { member_id: 'member_b', device_id: 'device_b1', role: 'member', state: 'active' },
  read_only: { member_id: 'member_ro', device_id: 'device_ro', role: 'read_only', state: 'active' },
  pending: { member_id: 'member_pending', device_id: 'device_pending', role: 'member', state: 'pending' },
  invite: { member_id: null, device_id: 'invite_1', role: 'invite', state: 'pending' },
  revoked: { member_id: 'member_revoked', device_id: 'device_revoked', role: 'member', state: 'revoked' },
  memberSecondDevice: { member_id: 'member_a', device_id: 'device_a2', role: 'member', state: 'active' },
});

function createTeamDirectoryFixture() {
  const live = new Map(Object.values(SEED).map((actor) => [actor.device_id, { ...actor }]));
  let degraded = false;
  const directory = {
    resolveActor(publicKey) {
      const deviceId = typeof publicKey === 'string' && publicKey.startsWith('key:') ? publicKey.slice(4) : '';
      const found = live.get(deviceId);
      return found ? { ...found } : null;
    },
    liveActor(deviceId) {
      const found = live.get(deviceId);
      return found ? { ...found } : null;
    },
    isDeviceActive(deviceId) { return live.get(deviceId)?.state === 'active'; },
    isDegraded() { return degraded; },
  };
  return {
    directory,
    // Plain copies. The authorizer never trusts these objects' role or state.
    actors: Object.fromEntries(Object.entries(SEED).map(([name, actor]) => [name, { ...actor }])),
    setRole(deviceId, role) { live.get(deviceId).role = role; },
    setState(deviceId, state) { live.get(deviceId).state = state; },
    remove(deviceId) { live.delete(deviceId); },
    setDegraded(value) { degraded = value === true; },
  };
}

module.exports = { PRINCIPALS, createTeamDirectoryFixture };
