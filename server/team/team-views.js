'use strict';

// Shapes member store records into command answers. Nothing here reads the
// disk or decides who may see what beyond the roster and device list filters
// the spec names; the one authorization function has already run. A public key
// never leaves this file: a device is shown by its fingerprint, the first five
// bytes of SHA-256 over the raw key as ten lowercase hex characters.

const crypto = require('node:crypto');

const { PUBLIC_KEY_BYTES, decodeBase64url } = require('./ids');
const { inviteKind, isLiveInvite } = require('./member-transitions');

function fingerprintOf(publicKey) {
  const raw = decodeBase64url(publicKey, PUBLIC_KEY_BYTES);
  return raw ? crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10) : null;
}

function deviceView(device) {
  return {
    device_id: device.device_id,
    label: device.label,
    state: device.state,
    fingerprint: fingerprintOf(device.public_key),
    created_at: device.created_at,
    last_seen_at: device.last_seen_at,
  };
}

// Active devices of members who are not revoked; a revoked device is noise.
function liveDevices(doc) {
  const revoked = new Set(doc.members.filter((member) => member.state === 'revoked').map((member) => member.member_id));
  return doc.devices.filter((device) => device.state === 'active' && !revoked.has(device.member_id));
}

// The owner sees pending and active members with their devices; everybody else
// sees active members as name, role and state. Revoked members are never listed.
function rosterView(doc, { owner }) {
  const members = doc.members.filter((member) => (owner ? member.state !== 'revoked' : member.state === 'active'));
  const devices = owner ? liveDevices(doc) : [];
  return {
    team: { team_id: doc.team.team_id, name: doc.team.name },
    members: members.map((member) => {
      const base = {
        member_id: member.member_id, display_name: member.display_name, role: member.role, state: member.state,
      };
      if (!owner) return base;
      return {
        ...base,
        created_at: member.created_at,
        admitted_at: member.admitted_at,
        devices: devices.filter((device) => device.member_id === member.member_id).map(deviceView),
      };
    }),
  };
}

// The caller's own devices; the owner gets every member's.
function deviceListView(doc, { memberId, owner }) {
  return liveDevices(doc).filter((device) => owner || device.member_id === memberId).map((device) => {
    const { device_id: deviceId, ...rest } = deviceView(device);
    return { device_id: deviceId, member_id: device.member_id, ...rest };
  });
}

function inviteListView(doc, now) {
  return doc.invites.filter((invite) => isLiveInvite(invite, now)).map((invite) => ({
    invite_id: invite.invite_id,
    kind: inviteKind(invite),
    role: invite.role,
    member_id: invite.member_id,
    created_at: invite.created_at,
    expires_at: invite.expires_at,
  }));
}

module.exports = { fingerprintOf, rosterView, deviceListView, inviteListView };
