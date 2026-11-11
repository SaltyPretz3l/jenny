'use strict';

// The state transitions of the team member store, as pure functions over a draft
// copy of the document. Each one validates its input, mutates the draft, and
// returns what the store needs to commit it:
//   { ok: false, failure }                          refused, nothing changes
//   { ok: true, noop: true, result }                nothing to commit
//   { ok: true, audit: [...], event, result }       commit, audit first
// The store owns the commit protocol (audit, write, directory, events); this
// file owns the table in the design spec's "States and transitions".
//
// The one authorization function decides who may ask, per request. The store
// repeats the part that must never depend on wiring: only the owner admits,
// changes a role, revokes a member or revokes another person's device or
// invite; the owner is never revoked; every limit and state rule holds.

const { isPublicKey } = require('./ids');
const projects = require('./project-transitions');
const { refuse, findMember, activeActor } = require('./transition-common');
const {
  ASSIGNABLE_ROLES, LOCAL_ACTOR, LIMITS, INVITE_KINDS, isCleanText,
} = require('./member-schema');

function activeDevicesOf(doc, memberId) {
  return doc.devices.filter((device) => device.member_id === memberId && device.state === 'active');
}

function allKeys(doc) {
  return new Set([...doc.devices.map((device) => device.public_key),
    ...doc.invites.map((invite) => invite.invite_public_key)]);
}

function isLiveInvite(invite, now) {
  return invite.used_at === null && invite.revoked_at === null && invite.expires_at > now;
}

// The actor must be the active owner.
function ownerActor(doc, actorMemberId) {
  const checked = activeActor(doc, actorMemberId);
  if (!checked.ok) return checked;
  if (checked.actor.role !== 'owner') return refuse('forbidden', 'role_forbidden');
  return checked;
}

function memberEvent(kind, member, deviceIds, now) {
  return { kind, member_id: member.member_id, device_ids: deviceIds, role: member.role, at: now };
}

// The audit log fills the fields an entry leaves out.
function auditEntry(kind, fields) {
  return { kind, ...fields };
}

// ------------------------------------------------------------------ invites

function createInvite(doc, input, ctx) {
  const spec = typeof input.kind === 'string' && Object.hasOwn(INVITE_KINDS, input.kind)
    ? INVITE_KINDS[input.kind] : null;
  if (!spec) return refuse('invalid', 'team_invite_malformed');
  const ttlMs = input.ttlMs === undefined ? spec.defaultMs : input.ttlMs;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > spec.maxMs) return refuse('invalid', 'team_invite_ttl_invalid');
  if (!isPublicKey(input.invitePublicKey) || allKeys(doc).has(input.invitePublicKey)) {
    return refuse('invalid', 'team_public_key_invalid');
  }
  const local = input.kind === 'owner_first' || input.kind === 'recovery';
  if (local !== (input.actorMemberId === null)) return refuse('forbidden', local ? 'role_forbidden' : 'team_not_found');

  let role;
  let memberId = null;
  let createdBy = LOCAL_ACTOR;
  if (input.kind === 'owner_first') {
    if (doc.members.length > 0) return refuse('conflict', 'team_member_state_invalid');
    role = 'owner';
  } else if (input.kind === 'recovery') {
    const owner = doc.members.find((member) => member.role === 'owner' && member.state === 'active');
    if (!owner) return refuse('conflict', 'team_member_state_invalid');
    role = 'owner';
    memberId = owner.member_id;
  } else {
    const checked = activeActor(doc, input.actorMemberId);
    if (!checked.ok) return checked;
    createdBy = checked.actor.member_id;
    if (input.kind === 'new_member') {
      if (checked.actor.role !== 'owner') return refuse('forbidden', 'role_forbidden');
      if (!ASSIGNABLE_ROLES.includes(input.role)) return refuse('invalid', 'team_role_invalid');
      role = input.role;
    } else {
      // A live add-device invite holds one of the member's device slots, so one
      // member cannot fill the team's invite list with their own.
      const reserved = doc.invites.filter((invite) => invite.created_by === checked.actor.member_id
        && invite.member_id === checked.actor.member_id && isLiveInvite(invite, ctx.now)).length;
      if (activeDevicesOf(doc, checked.actor.member_id).length + reserved >= LIMITS.MAX_ACTIVE_DEVICES) {
        return refuse('limit', 'team_device_limit');
      }
      role = checked.actor.role;
      memberId = checked.actor.member_id;
    }
  }
  if (doc.invites.filter((invite) => isLiveInvite(invite, ctx.now)).length >= LIMITS.MAX_OUTSTANDING_INVITES) {
    return refuse('limit', 'team_invite_limit');
  }
  const invite = {
    invite_id: ctx.newId('invite'),
    invite_public_key: input.invitePublicKey,
    role,
    member_id: memberId,
    created_by: createdBy,
    created_at: ctx.now,
    expires_at: ctx.now + ttlMs,
    used_at: null,
    revoked_at: null,
  };
  doc.invites.push(invite);
  return {
    ok: true,
    audit: [auditEntry('invite_created', {
      actor_member_id: input.actorMemberId, subject_member_id: memberId, detail: `kind=${input.kind},role=${role}`,
    })],
    event: null,
    result: { invite_id: invite.invite_id, expires_at: invite.expires_at },
  };
}

// The local commands (actor exactly null, never undefined) may revoke only an
// invite a local command minted: a first-owner or recovery invite whose string
// never reached its holder.
function revokeLocalInvite(doc, input, ctx) {
  const invite = doc.invites.find((entry) => entry.invite_id === input.inviteId);
  if (!invite || invite.created_by !== LOCAL_ACTOR || !isLiveInvite(invite, ctx.now)) {
    return refuse('forbidden', 'invite_not_valid');
  }
  invite.revoked_at = ctx.now;
  return {
    ok: true,
    audit: [auditEntry('invite_revoked', { actor_member_id: null, subject_member_id: invite.member_id, detail: 'local' })],
    event: null,
    result: { invite_id: invite.invite_id },
  };
}

function revokeInvite(doc, input, ctx) {
  if (input.actorMemberId === null) return revokeLocalInvite(doc, input, ctx);
  const checked = activeActor(doc, input.actorMemberId);
  if (!checked.ok) return checked;
  const invite = doc.invites.find((entry) => entry.invite_id === input.inviteId);
  // Someone else's invite reads exactly like one that does not exist.
  const mayRevoke = invite && (checked.actor.role === 'owner' || invite.created_by === checked.actor.member_id);
  if (!mayRevoke || !isLiveInvite(invite, ctx.now)) return refuse('forbidden', 'invite_not_valid');
  invite.revoked_at = ctx.now;
  return {
    ok: true,
    audit: [auditEntry('invite_revoked', {
      actor_member_id: checked.actor.member_id, subject_member_id: invite.member_id,
    })],
    event: null,
    result: { invite_id: invite.invite_id },
  };
}

// ------------------------------------------------------------------- redeem

function inviteKind(invite) {
  if (invite.member_id === null) return invite.role === 'owner' ? 'owner_first' : 'new_member';
  return invite.created_by === LOCAL_ACTOR ? 'recovery' : 'add_device';
}

function newDevice(doc, input, memberId, ctx) {
  const device = {
    device_id: ctx.newId('device'),
    member_id: memberId,
    public_key: input.devicePublicKey,
    label: input.label,
    state: 'active',
    created_at: ctx.now,
    last_seen_at: null,
  };
  doc.devices.push(device);
  return device;
}

function redeemInput(doc, input) {
  if (!isPublicKey(input.devicePublicKey) || allKeys(doc).has(input.devicePublicKey)) {
    return refuse('invalid', 'team_public_key_invalid');
  }
  if (!isCleanText(input.label)) return refuse('invalid', 'team_label_invalid');
  return null;
}

function redeem(doc, rawInput, ctx) {
  const input = {
    ...rawInput,
    displayName: typeof rawInput.displayName === 'string' ? rawInput.displayName.normalize('NFC') : rawInput.displayName,
    label: typeof rawInput.label === 'string' ? rawInput.label.normalize('NFC') : rawInput.label,
  };
  const invite = doc.invites.find((entry) => entry.invite_id === input.inviteId);
  if (!invite || !isLiveInvite(invite, ctx.now)) return refuse('forbidden', 'invite_not_valid');
  const kind = inviteKind(invite);
  if (kind === 'owner_first' && doc.members.length > 0) return refuse('forbidden', 'invite_not_valid');
  const existing = kind === 'add_device' || kind === 'recovery' ? findMember(doc, invite.member_id) : null;
  if ((kind === 'add_device' || kind === 'recovery') && (!existing || existing.state !== 'active')) {
    return refuse('forbidden', 'invite_not_valid');
  }
  // A recovery invite is for the owner it was minted for; a transfer since then voids it.
  if (kind === 'recovery' && existing.role !== 'owner') return refuse('forbidden', 'invite_not_valid');
  const badInput = redeemInput(doc, input);
  if (badInput) return badInput;
  if ((kind === 'owner_first' || kind === 'new_member') && !isCleanText(input.displayName)) {
    return refuse('invalid', 'team_display_name_invalid');
  }
  if (kind === 'new_member'
    && doc.members.filter((member) => member.state !== 'revoked').length >= LIMITS.MAX_LIVE_MEMBERS) {
    return refuse('limit', 'team_member_limit');
  }
  if (kind === 'add_device' && activeDevicesOf(doc, existing.member_id).length >= LIMITS.MAX_ACTIVE_DEVICES) {
    return refuse('limit', 'team_device_limit');
  }
  invite.used_at = ctx.now;
  // The first owner exists now: no other owner invite may stay live.
  if (kind === 'owner_first') {
    for (const other of doc.invites) {
      if (other !== invite && other.member_id === null && other.role === 'owner' && isLiveInvite(other, ctx.now)) {
        other.revoked_at = ctx.now;
      }
    }
  }
  if (kind === 'add_device' || kind === 'recovery') return redeemForExisting(doc, { kind, input, invite, member: existing }, ctx);

  const member = {
    member_id: ctx.newId('member'),
    display_name: input.displayName,
    role: invite.role,
    state: kind === 'owner_first' ? 'active' : 'pending',
    created_at: ctx.now,
    admitted_at: kind === 'owner_first' ? ctx.now : null,
    admitted_by: null,
    revoked_at: null,
    revoked_by: null,
  };
  doc.members.push(member);
  const device = newDevice(doc, input, member.member_id, ctx);
  return {
    ok: true,
    audit: [auditEntry('invite_redeemed', {
      actor_member_id: member.member_id,
      subject_member_id: member.member_id,
      subject_device_id: device.device_id,
      name: member.display_name,
      detail: kind === 'owner_first' ? 'first_owner' : 'pending',
    })],
    event: kind === 'owner_first' ? memberEvent('admitted', member, [device.device_id], ctx.now) : null,
    result: {
      invite_id: invite.invite_id, member_id: member.member_id, device_id: device.device_id,
      role: member.role, state: member.state,
    },
  };
}

function redeemForExisting(doc, { kind, input, invite, member }, ctx) {
  const dropped = kind === 'recovery' ? activeDevicesOf(doc, member.member_id) : [];
  for (const device of dropped) device.state = 'revoked';
  const device = newDevice(doc, input, member.member_id, ctx);
  const base = { actor_member_id: member.member_id, subject_member_id: member.member_id, name: member.display_name };
  const audit = kind === 'recovery'
    ? [auditEntry('recovery_used', { ...base, detail: `revoked_devices=${dropped.length}` }),
      ...dropped.map((old) => auditEntry('device_revoked', { ...base, subject_device_id: old.device_id }))]
    : [auditEntry('invite_redeemed', { ...base, subject_device_id: device.device_id, detail: 'add_device' })];
  audit.push(auditEntry('device_added', { ...base, subject_device_id: device.device_id }));
  return {
    ok: true,
    audit,
    event: dropped.length > 0 ? memberEvent('device_revoked', member, dropped.map((old) => old.device_id), ctx.now) : null,
    result: {
      invite_id: invite.invite_id,
      member_id: member.member_id, device_id: device.device_id, role: member.role, state: member.state,
    },
  };
}

// ---------------------------------------------------------------- members

function admit(doc, input, ctx) {
  const checked = ownerActor(doc, input.actorMemberId);
  if (!checked.ok) return checked;
  const member = findMember(doc, input.memberId);
  if (!member) return refuse('forbidden', 'team_not_found');
  if (member.state !== 'pending') return refuse('conflict', 'team_member_state_invalid');
  member.state = 'active';
  member.admitted_at = ctx.now;
  member.admitted_by = checked.actor.member_id;
  const deviceIds = activeDevicesOf(doc, member.member_id).map((device) => device.device_id);
  return {
    ok: true,
    audit: [auditEntry('member_admitted', {
      actor_member_id: checked.actor.member_id, subject_member_id: member.member_id, name: member.display_name,
    })],
    event: memberEvent('admitted', member, deviceIds, ctx.now),
    result: { member_id: member.member_id },
  };
}

function setRole(doc, input, ctx) {
  const checked = ownerActor(doc, input.actorMemberId);
  if (!checked.ok) return checked;
  if (!ASSIGNABLE_ROLES.includes(input.role)) return refuse('invalid', 'team_role_invalid');
  const member = findMember(doc, input.memberId);
  if (!member) return refuse('forbidden', 'team_not_found');
  if (member.role === 'owner') return refuse('conflict', 'team_last_owner');
  if (member.state !== 'active') return refuse('conflict', 'team_member_state_invalid');
  if (member.role === input.role) return { ok: true, noop: true, result: { member_id: member.member_id, changed: false } };
  const previous = member.role;
  member.role = input.role;
  const capped = input.role === 'read_only' ? projects.capToReader(doc, member.member_id) : { projects: 0 };
  const deviceIds = activeDevicesOf(doc, member.member_id).map((device) => device.device_id);
  return {
    ok: true,
    audit: [auditEntry('role_changed', {
      actor_member_id: checked.actor.member_id,
      subject_member_id: member.member_id,
      name: member.display_name,
      detail: projects.cascadeDetail(`from=${previous},to=${member.role}`, capped),
    })],
    event: memberEvent('role_changed', member, deviceIds, ctx.now),
    result: { member_id: member.member_id, changed: true },
  };
}

// The team name: the active owner only. An unchanged name is not a write, and
// the audit entry carries the actor but never the name.
function rename(doc, input) {
  const checked = ownerActor(doc, input.actorMemberId);
  if (!checked.ok) return checked;
  if (!isCleanText(input.name)) return refuse('invalid', 'team_name_invalid');
  if (doc.team.name === input.name) return { ok: true, noop: true, result: { changed: false } };
  doc.team.name = input.name;
  return {
    ok: true,
    audit: [auditEntry('team_renamed', { actor_member_id: checked.actor.member_id })],
    event: null,
    result: { changed: true },
  };
}

// Revokes `member` and every one of its keys. Older revoked devices of the same
// member are dropped (only the devices active now are kept as revoked), and its
// unused invites die with it.
function applyRevoke(doc, member, byId, kind, ctx) {
  const droppedIds = activeDevicesOf(doc, member.member_id).map((device) => device.device_id);
  doc.devices = doc.devices.filter((device) => device.member_id !== member.member_id || device.state === 'active');
  for (const device of doc.devices) {
    if (device.member_id === member.member_id) device.state = 'revoked';
  }
  for (const invite of doc.invites) {
    if (invite.member_id === member.member_id && isLiveInvite(invite, ctx.now)) invite.revoked_at = ctx.now;
  }
  const wasPending = member.state === 'pending';
  member.state = 'revoked';
  member.revoked_at = ctx.now;
  member.revoked_by = byId;
  const left = projects.leaveAllProjects(doc, member.member_id);
  return {
    ok: true,
    audit: [auditEntry(kind, {
      actor_member_id: byId,
      subject_member_id: member.member_id,
      name: member.display_name,
      detail: projects.cascadeDetail(wasPending ? 'was=pending' : 'was=active', left),
    })],
    event: memberEvent('member_revoked', member, droppedIds, ctx.now),
    result: { member_id: member.member_id },
  };
}

function revokeMember(doc, input, ctx) {
  const checked = ownerActor(doc, input.actorMemberId);
  if (!checked.ok) return checked;
  const member = findMember(doc, input.memberId);
  if (!member) return refuse('forbidden', 'team_not_found');
  if (member.role === 'owner') return refuse('conflict', 'team_last_owner');
  if (member.state === 'revoked') return refuse('conflict', 'team_member_state_invalid');
  return applyRevoke(doc, member, checked.actor.member_id, 'member_revoked', ctx);
}

function leave(doc, input, ctx) {
  const member = typeof input.memberId === 'string' ? findMember(doc, input.memberId) : null;
  if (!member) return refuse('forbidden', 'team_not_found');
  if (member.role === 'owner') return refuse('conflict', 'team_owner_transfer_required');
  if (member.state === 'revoked') return refuse('conflict', 'team_member_state_invalid');
  return applyRevoke(doc, member, member.member_id, 'member_left', ctx);
}

function revokeDevice(doc, input, ctx) {
  const checked = activeActor(doc, input.actorMemberId);
  if (!checked.ok) return checked;
  const device = doc.devices.find((entry) => entry.device_id === input.deviceId);
  // Another member's device reads exactly like one that does not exist.
  if (!device || (checked.actor.role !== 'owner' && device.member_id !== checked.actor.member_id)) {
    return refuse('forbidden', 'team_not_found');
  }
  if (device.state === 'revoked') return refuse('conflict', 'team_member_state_invalid');
  const member = findMember(doc, device.member_id);
  device.state = 'revoked';
  return {
    ok: true,
    audit: [auditEntry('device_revoked', {
      actor_member_id: checked.actor.member_id,
      subject_member_id: member.member_id,
      subject_device_id: device.device_id,
      name: member.display_name,
    })],
    event: memberEvent('device_revoked', member, [device.device_id], ctx.now),
    result: { device_id: device.device_id },
  };
}

// One mutation swaps the two roles, so the store never holds zero or two owners.
function transferOwner(doc, input, ctx) {
  const checked = activeActor(doc, input.actorMemberId);
  if (!checked.ok) return checked;
  if (checked.actor.role !== 'owner') return refuse('forbidden', 'role_forbidden');
  const target = findMember(doc, input.memberId);
  if (!target) return refuse('forbidden', 'team_not_found');
  if (target.member_id === checked.actor.member_id || target.state !== 'active') {
    return refuse('conflict', 'team_member_state_invalid');
  }
  // An owner nobody can sign in as could only be undone by the local recovery command.
  if (activeDevicesOf(doc, target.member_id).length === 0) return refuse('conflict', 'team_member_state_invalid');
  const previousOwner = checked.actor;
  previousOwner.role = 'member';
  target.role = 'owner';
  const deviceIds = [...activeDevicesOf(doc, target.member_id), ...activeDevicesOf(doc, previousOwner.member_id)]
    .map((device) => device.device_id);
  return {
    ok: true,
    audit: [auditEntry('owner_transferred', {
      actor_member_id: previousOwner.member_id, subject_member_id: target.member_id, name: target.display_name,
    })],
    event: memberEvent('owner_transferred', target, deviceIds, ctx.now),
    result: { member_id: target.member_id },
  };
}

// `last_seen_at` is a display fact. It is written at most once a minute, with
// no audit entry and no event.
function touchDevice(doc, input, ctx) {
  const device = doc.devices.find((entry) => entry.device_id === input.deviceId);
  const stale = device && device.state === 'active'
    && (device.last_seen_at === null || ctx.now - device.last_seen_at >= LIMITS.LAST_SEEN_INTERVAL_MS);
  if (!stale) return { ok: true, noop: true, result: { written: false } };
  device.last_seen_at = ctx.now;
  return { ok: true, displayOnly: true, audit: [], event: null, result: { written: true } };
}

// ------------------------------------------------------------------ pruning

// Keeps the document inside its bounds after any committed transition: expired
// invites go, spent invites keep the newest 16, the oldest revoked members go
// beyond 56 (with their devices and invites), and so do the oldest revoked
// devices of live members beyond 56 (oldest by creation).
function prune(doc, now) {
  doc.invites = doc.invites.filter((invite) => invite.used_at !== null || invite.revoked_at !== null
    || invite.expires_at > now);
  const spent = doc.invites.filter((invite) => invite.used_at !== null || invite.revoked_at !== null)
    .sort((a, b) => (b.used_at ?? b.revoked_at) - (a.used_at ?? a.revoked_at));
  const dropInvites = new Set(spent.slice(LIMITS.MAX_RETIRED_INVITES).map((invite) => invite.invite_id));

  const revoked = doc.members.filter((member) => member.state === 'revoked')
    .sort((a, b) => a.revoked_at - b.revoked_at);
  const dropMembers = new Set(revoked.slice(0, Math.max(0, revoked.length - LIMITS.MAX_REVOKED_MEMBERS))
    .map((member) => member.member_id));
  doc.members = doc.members.filter((member) => !dropMembers.has(member.member_id));
  doc.devices = doc.devices.filter((device) => !dropMembers.has(device.member_id));
  doc.invites = doc.invites.filter((invite) => !dropInvites.has(invite.invite_id)
    && !dropMembers.has(invite.member_id));

  const live = new Set(doc.members.filter((member) => member.state !== 'revoked').map((member) => member.member_id));
  const stale = doc.devices.filter((device) => device.state === 'revoked' && live.has(device.member_id))
    .sort((a, b) => a.created_at - b.created_at);
  const dropDevices = new Set(stale.slice(0, Math.max(0, stale.length - LIMITS.MAX_REVOKED_DEVICES))
    .map((device) => device.device_id));
  if (dropDevices.size > 0) doc.devices = doc.devices.filter((device) => !dropDevices.has(device.device_id));
}

module.exports = {
  isLiveInvite,
  createInvite,
  revokeInvite,
  redeem,
  admit,
  setRole,
  revokeMember,
  leave,
  inviteKind,
  revokeDevice,
  transferOwner,
  rename,
  touchDevice,
  prune,
};
