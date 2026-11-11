'use strict';

// The one authorization function (TEAM_MEMBERSHIP_SPEC M6). It is pure over the
// directory's current state: the actor handed in only names a device, and the
// role and state are read fresh from the directory on every call. Anything it
// does not know denies. Failures are hostFailure objects that carry no key,
// display name or address.

const { hostFailure } = require('../api-contract');
const { ACTIONS } = require('./operation-registry');
const { channelKind } = require('../../services/host/team-chat-schema');

const SINGLE_OWNER_MEMBER_ID = 'member_single_owner';
const ROLE_COLUMNS = new Set(['owner', 'member', 'read_only']);
const CHAT_BUCKET = 'teamchat:';

function singleOwnerActor(deviceId) {
  return Object.freeze({ member_id: SINGLE_OWNER_MEMBER_ID, device_id: deviceId, role: 'owner', state: 'active' });
}

// Hosted mode with one owner: every authenticated session is the constant owner.
function createSingleOwnerDirectory() {
  const liveActor = (deviceId) => (typeof deviceId === 'string' && deviceId ? singleOwnerActor(deviceId) : null);
  return Object.freeze({
    resolveActor: () => null,
    liveActor,
    isDeviceActive: (deviceId) => liveActor(deviceId) !== null,
    isDegraded: () => false,
  });
}

// The channel rule (TEAM_CHAT_SPEC "Audience"), used for authorization, for
// the audience of every chat event and for the stream predicate: the team
// channel and project channels are open to every active member (per-project
// audiences are Phase 3); a direct channel is open to nobody until slice 2d,
// the owner included; any other id names no channel.
function isSharedChannel(channelId) {
  const kind = channelKind(channelId);
  return kind === 'team' || kind === 'project';
}

// A channel's audience: a Set of active member ids, empty when the channel is
// not shared or the directory cannot list members (fail closed, never everyone).
function channelMembers(directory, channelId) {
  if (!isSharedChannel(channelId) || typeof directory?.activeMemberIds !== 'function') return new Set();
  return new Set(directory.activeMemberIds());
}

// The event-stream bucket of a channel; the stream predicate below reads it back.
function chatBucket(channelId) {
  return `${CHAT_BUCKET}${channelId}`;
}

// The one place that decides whether a resource is visible to an actor. Phase 3
// adds project roles here and nowhere else.
function isVisible(directory, live, resource) {
  const isOwner = live.role === 'owner';
  switch (resource.kind) {
    case 'team':
    case 'member':
    case 'session':
    case 'project':
      return true;
    case 'device': {
      const target = directory.liveActor(resource.id);
      return Boolean(target) && (isOwner || (live.member_id !== null && target.member_id === live.member_id));
    }
    case 'invite':
      return isOwner || resource.id === live.device_id;
    case 'channel':
      return live.state === 'active' && isSharedChannel(resource.id);
    default:
      return isOwner; // engine and node have no rows yet
  }
}

function principalColumn(live) {
  if (live.role === 'invite') return 'invite';
  if (live.state === 'pending') return 'pending';
  if (live.state === 'active' && ROLE_COLUMNS.has(live.role)) return live.role;
  return null;
}

function createAuthorizer({ directory } = {}) {
  for (const method of ['liveActor', 'isDegraded']) {
    if (!directory || typeof directory[method] !== 'function') {
      throw new TypeError('Authorizer requires a member directory.');
    }
  }

  function authorize(actor, action, resource, requestId = '') {
    const forbid = (reason) => hostFailure('forbidden', reason, requestId);
    try {
      if (!actor || typeof actor !== 'object' || typeof actor.device_id !== 'string' || !actor.device_id) {
        return forbid('role_forbidden');
      }
      const live = directory.liveActor(actor.device_id);
      const activeOwner = Boolean(live) && live.role === 'owner' && live.state === 'active';
      if (!activeOwner && directory.isDegraded()) return hostFailure('unavailable', 'team_unavailable', requestId, true);
      // A device the directory no longer knows is a revoked one.
      if (!live || live.state === 'revoked') return forbid('member_revoked');
      const row = typeof action === 'string' && Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
      if (!row) return forbid('role_forbidden');
      const column = principalColumn(live);
      if (!column || row[column] !== true) return forbid(column === 'pending' ? 'member_pending' : 'role_forbidden');
      if (!resource || resource.kind !== row.resource || typeof resource.id !== 'string'
        || !isVisible(directory, live, resource)) {
        // The wrong kind for this action, and not visible, read exactly like not existing.
        return forbid(row.resource === 'channel' ? 'team_chat_not_found' : 'team_not_found');
      }
      return { ok: true };
    } catch (_error) {
      return hostFailure('unavailable', 'team_unavailable', requestId, true);
    }
  }

  return Object.freeze({ authorize });
}

// The identity a team event stream carries (slice 2a-2's `subscribe`). The
// predicate re-reads the device's live actor on every delivery: it must be
// active, not cut off by a degraded directory, have that member id and, for a
// chat bucket, see the channel by the rule above. An invite principal (no
// member id) gets no identity, so it receives no audience-scoped event.
function streamIdentity(directory, actor) {
  const memberId = actor?.member_id;
  const deviceId = actor?.device_id;
  if (typeof memberId !== 'string' || !memberId || typeof deviceId !== 'string' || !deviceId) return undefined;
  const mayReceive = (candidate, scope) => {
    const live = directory.liveActor(deviceId);
    if (!live || live.state !== 'active' || live.member_id !== candidate) return false;
    if (live.role !== 'owner' && directory.isDegraded()) return false;
    const bucket = typeof scope?.bucket === 'string' ? scope.bucket : '';
    return !bucket.startsWith(CHAT_BUCKET)
      || isVisible(directory, live, { kind: 'channel', id: bucket.slice(CHAT_BUCKET.length) });
  };
  return Object.freeze({ memberId, mayReceive });
}

let singleOwnerAuthorizer = null;
function getSingleOwnerAuthorizer() {
  if (!singleOwnerAuthorizer) singleOwnerAuthorizer = createAuthorizer({ directory: createSingleOwnerDirectory() });
  return singleOwnerAuthorizer;
}

module.exports = {
  SINGLE_OWNER_MEMBER_ID, channelMembers, chatBucket, createAuthorizer, createSingleOwnerDirectory,
  getSingleOwnerAuthorizer, isVisible, singleOwnerActor, streamIdentity,
};
