'use strict';

// A stand-in for the member directory (slice 1a): one owner, two members, one
// read-only member, one pending member, one invite principal and one revoked
// member. It implements exactly the interface the authorizer reads, and lets a
// test change a device's live state while a request is awaited. Since slice 3-2
// it is a full team directory: projectRole, projectState and activeMemberIds over
// rows shaped { project_id: { state, members: { member_id: role } } }. Without
// `projects` it holds project_1, where the owner is admin, both members write and
// the read-only member reads.

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

const DEFAULT_PROJECTS = Object.freeze({
  project_1: { members: { member_owner: 'admin', member_a: 'writer', member_b: 'writer', member_ro: 'reader' } },
});

function createTeamDirectoryFixture({ projects = DEFAULT_PROJECTS } = {}) {
  const live = new Map(Object.values(SEED).map((actor) => [actor.device_id, { ...actor }]));
  let degraded = false;
  const rows = new Map(Object.entries(projects).map(([id, row]) => [id,
    { state: row.state || 'active', members: new Map(Object.entries(row.members || {})) }]));
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
    // The real directory's contract (server/team/directory.js): the stored role in an active project, or null.
    projectRole(memberId, projectId) {
      const row = rows.get(projectId);
      return row && row.state === 'active' ? row.members.get(memberId) ?? null : null;
    },
    projectState: (projectId) => rows.get(projectId)?.state ?? null,
    // The real directory's memberActor: the member's role and state from any of its devices, null when revoked.
    memberActor(memberId) {
      const found = [...live.values()].find((actor) => actor.member_id === memberId && typeof memberId === 'string');
      return found && found.state !== 'revoked' ? { member_id: found.member_id, role: found.role, state: found.state } : null;
    },
    activeMemberIds: () => [...new Set([...live.values()]
      .filter((actor) => actor.state === 'active' && actor.member_id).map((actor) => actor.member_id))],
  };
  return {
    directory,
    // Plain copies. The authorizer never trusts these objects' role or state.
    actors: Object.fromEntries(Object.entries(SEED).map(([name, actor]) => [name, { ...actor }])),
    setRole(deviceId, role) { live.get(deviceId).role = role; },
    setState(deviceId, state) { live.get(deviceId).state = state; },
    remove(deviceId) { live.delete(deviceId); },
    setDegraded(value) { degraded = value === true; },
    setProjectRole(memberId, projectId, role) {
      if (!rows.has(projectId)) rows.set(projectId, { state: 'active', members: new Map() });
      if (role === null) rows.get(projectId).members.delete(memberId);
      else rows.get(projectId).members.set(memberId, role);
    },
  };
}

module.exports = { PRINCIPALS, createTeamDirectoryFixture };
