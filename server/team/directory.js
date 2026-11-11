'use strict';

// A pure, in-memory answer to "who is this key or device". The member store
// rebuilds it synchronously after each committed mutation (and on load). It
// never caches a role or state on a caller's object: every call reads the
// current snapshot and returns a fresh plain object.

const { isPublicKey } = require('./ids');

function createDirectory({ clock = Date.now, isDegraded = () => false } = {}) {
  let devicesByKey = new Map();
  let devicesById = new Map();
  let membersById = new Map();
  let invitesByKey = new Map();
  let invitesById = new Map();
  // member id -> Map(project id -> role), active projects only.
  let projectRolesByMember = new Map();
  // project id -> 'active' | 'deleting'.
  let projectStates = new Map();

  function rebuild(doc) {
    const members = new Map();
    for (const member of doc.members) members.set(member.member_id, { role: member.role, state: member.state });
    const byKey = new Map();
    const byId = new Map();
    for (const device of doc.devices) {
      const record = { device_id: device.device_id, member_id: device.member_id, active: device.state === 'active' };
      byId.set(device.device_id, record);
      byKey.set(device.public_key, record);
    }
    const inviteKeys = new Map();
    const inviteIds = new Map();
    for (const invite of doc.invites) {
      const record = {
        invite_id: invite.invite_id,
        expires_at: invite.expires_at,
        spent: invite.used_at !== null || invite.revoked_at !== null,
      };
      inviteKeys.set(invite.invite_public_key, record);
      inviteIds.set(invite.invite_id, record);
    }
    const projectRoles = new Map();
    const states = new Map();
    for (const project of doc.projects || []) {
      states.set(project.project_id, project.state);
      if (project.state !== 'active') continue;
      for (const entry of project.members) {
        if (!projectRoles.has(entry.member_id)) projectRoles.set(entry.member_id, new Map());
        projectRoles.get(entry.member_id).set(project.project_id, entry.role);
      }
    }
    // Swap in one step so a reader never sees half of a rebuild.
    membersById = members;
    devicesByKey = byKey;
    devicesById = byId;
    invitesByKey = inviteKeys;
    invitesById = inviteIds;
    projectRolesByMember = projectRoles;
    projectStates = states;
  }

  function actorForDevice(record) {
    if (!record || !record.active) return null;
    const member = membersById.get(record.member_id);
    if (!member || member.state === 'revoked') return null;
    return { member_id: record.member_id, device_id: record.device_id, role: member.role, state: member.state };
  }

  function inviteIsLive(record) {
    return Boolean(record) && !record.spent && record.expires_at > clock();
  }

  function actorForInvite(record) {
    if (!inviteIsLive(record)) return null;
    return { member_id: null, device_id: record.invite_id, role: 'invite', state: 'pending' };
  }

  function resolveActor(publicKey) {
    if (!isPublicKey(publicKey)) return null;
    return actorForDevice(devicesByKey.get(publicKey)) || actorForInvite(invitesByKey.get(publicKey));
  }

  function liveActor(deviceId) {
    if (typeof deviceId !== 'string') return null;
    return actorForDevice(devicesById.get(deviceId)) || actorForInvite(invitesById.get(deviceId));
  }

  // Devices only: an invite principal has no stream or client of its own.
  function isDeviceActive(deviceId) {
    return typeof deviceId === 'string' && actorForDevice(devicesById.get(deviceId)) !== null;
  }

  // Read-only: the ids of active members, in roster order (a team chat channel's audience).
  function activeMemberIds() {
    const ids = [];
    for (const [memberId, member] of membersById) if (member.state === 'active') ids.push(memberId);
    return ids;
  }

  // The member's role in an active project as stored: null when they are not in
  // it, the project is deleting or gone, or either id is unknown. The effective
  // role (team state on top) is the visibility module's job.
  function projectRole(memberId, projectId) {
    if (typeof memberId !== 'string' || typeof projectId !== 'string') return null;
    return projectRolesByMember.get(memberId)?.get(projectId) ?? null;
  }

  // 'active', 'deleting', or null for no team row: the owner sees every project
  // (E23) and a deleting one stays visible to the owner and its admins.
  function projectState(projectId) {
    return typeof projectId === 'string' ? projectStates.get(projectId) ?? null : null;
  }

  // Fresh plain rows, one per active project the member is in, in store order.
  function projectsOf(memberId) {
    const roles = typeof memberId === 'string' ? projectRolesByMember.get(memberId) : null;
    return roles ? [...roles].map(([projectId, role]) => ({ project_id: projectId, role })) : [];
  }

  function admitKind(publicKey) {
    if (!isPublicKey(publicKey)) return null;
    if (actorForDevice(devicesByKey.get(publicKey))) return 'device';
    return inviteIsLive(invitesByKey.get(publicKey)) ? 'invite' : null;
  }

  return {
    rebuild,
    resolveActor,
    liveActor,
    isDeviceActive,
    admitKind,
    activeMemberIds,
    projectRole,
    projectsOf,
    projectState,
    isDegraded: () => Boolean(isDegraded()),
  };
}

module.exports = { createDirectory };
