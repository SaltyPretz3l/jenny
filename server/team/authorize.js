'use strict';

// The one authorization function (TEAM_MEMBERSHIP_SPEC M6). It is pure over the
// directory's current state: the actor handed in only names a device, and the
// role and state are read fresh from the directory on every call. Anything it
// does not know denies. Failures are hostFailure objects that carry no key,
// display name or address.

const { hostFailure } = require('../api-contract');
const { ACTIONS } = require('./operation-registry');
const { channelKind } = require('../../services/host/team-chat-schema');
const {
  GENERAL_PROJECT_ID, SINGLE_OWNER_DIRECTORY, channelAudience, channelVisible, isTeamDirectory, projectAccess,
  projectAudience, projectIdVisible, resourceProject, roleAtLeast,
} = require('./project-visibility');
const {
  DEFAULT_BUCKET, POOL_NODES_EVENT, PRESENCE_EVENT, PROJECT_BUCKET, PROJECT_CHANGED_EVENT, SESSION_BUCKET, TEAM_RENAMED_EVENT,
} = require('./event-scope');
// The bucketless types: presence (sent live only), the project change, whose payload is a
// project id the receiver already knows or may list, and a reason, and the GPU list (slice
// 4e, sent live only), which every active member may read with team.node.list, and the team's new name (row 201,
// live only), which every member reads at connect.
const BUCKETLESS_TYPES = new Set([PRESENCE_EVENT, PROJECT_CHANGED_EVENT, POOL_NODES_EVENT, TEAM_RENAMED_EVENT]);

const SINGLE_OWNER_MEMBER_ID = 'member_single_owner';
const ROLE_COLUMNS = new Set(['owner', 'member', 'read_only']);
const CHAT_BUCKET = 'teamchat:';
// A project id that can name a `project:` bucket.
const PROJECT_BUCKET_ID = /^[A-Za-z0-9_-]{1,128}$/;

function singleOwnerActor(deviceId) {
  return Object.freeze({ member_id: SINGLE_OWNER_MEMBER_ID, device_id: deviceId, role: 'owner', state: 'active' });
}

// Hosted mode with one owner: every authenticated session is the constant owner.
// It is the only directory marked single-owner (a non-enumerable marker, so a
// copy is not); every other directory is a team directory (slice 3-2).
function createSingleOwnerDirectory() {
  const liveActor = (deviceId) => (typeof deviceId === 'string' && deviceId ? singleOwnerActor(deviceId) : null);
  const directory = {
    resolveActor: () => null,
    liveActor,
    isDeviceActive: (deviceId) => liveActor(deviceId) !== null,
    isDegraded: () => false,
  };
  Object.defineProperty(directory, SINGLE_OWNER_DIRECTORY, { value: true });
  return Object.freeze(directory);
}

// The channel rule (TEAM_CHAT_SPEC "Audience"), used for authorization, for
// the audience of every chat event and for the stream predicate. On a team
// directory (slice 3-2, project-visibility.js) the team channel is every active
// member, a project channel is that active project's members (nobody when the
// directory has no project roles) and a direct channel (slice 2d) is its stored
// participants who are active members, from the injected `participantsOf` lookup
// (nobody without it). A custom channel (row 173) has the team channel's audience.
// The single-owner directory keeps the Phase 2 rule, where a direct channel is open
// to nobody. Any other id names no channel.
function isSharedChannel(channelId) {
  const kind = channelKind(channelId);
  return kind === 'team' || kind === 'project' || kind === 'channel';
}

// A channel's audience: a Set of active member ids, empty when the channel is
// not shared or the directory cannot list members (fail closed, never everyone).
function channelMembers(directory, channelId, participantsOf) {
  if (isTeamDirectory(directory)) return channelAudience(directory, channelId, participantsOf);
  if (!isSharedChannel(channelId) || typeof directory?.activeMemberIds !== 'function') return new Set();
  return new Set(directory.activeMemberIds());
}

// The event-stream bucket of a channel; the stream predicate below reads it back.
function chatBucket(channelId) {
  return `${CHAT_BUCKET}${channelId}`;
}

// The one place that decides whether a resource is visible to an actor. On a
// team directory, projects and conversations follow the project rule
// (project-visibility.js; `sessionProject` names a conversation's project, and
// authorize() passes the `projectId` it already resolved so one verdict rests on
// one answer); the single-owner directory sees every one, as before.
function isVisible(directory, live, resource, sessionProject, projectId, participantsOf) {
  const isOwner = live.role === 'owner';
  switch (resource.kind) {
    case 'team':
    case 'member':
      return true;
    case 'session':
    case 'project':
      return !isTeamDirectory(directory) || projectIdVisible(directory, live,
        projectId === undefined ? resourceProject(resource, sessionProject) : projectId);
    case 'device': {
      const target = directory.liveActor(resource.id);
      return Boolean(target) && (isOwner || (live.member_id !== null && target.member_id === live.member_id));
    }
    case 'invite':
      return isOwner || resource.id === live.device_id;
    case 'channel':
      return isTeamDirectory(directory) ? channelVisible(directory, live, resource.id, participantsOf)
        : live.state === 'active' && isSharedChannel(resource.id);
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

// The project-role step for a visible resource (slice 3-2): null when the row
// allows it, else the forbidden reason. Team directories only.
function projectDenial(directory, live, row, resource, projectId) {
  if (!isTeamDirectory(directory) || row.project === 'none') return null;
  if (projectId === '') {
    if (row.emptyId === 'filter') return null;
    if (row.emptyId === 'required' && resource.kind === row.resource) return 'team_project_required';
    return 'team_not_found';
  }
  const access = projectAccess(directory, live, projectId);
  if (!access) return 'team_not_found';
  if (roleAtLeast(access.role, row.project)) return null;
  if (access.deleting) return 'team_project_deleting';
  // An owner-seen row (slice 3-7): the active owner, on a conversation already visible to them, in an active project.
  if (row.ownerSeen === true && live.role === 'owner' && live.state === 'active') return null;
  return row.project === 'admin' ? 'role_forbidden' : 'team_project_read_only';
}

// `sessionProject` (slice 3-2): a synchronous (sessionId) => project id or null,
// called fresh on every check. Without it, or for a null answer, a conversation
// is unknown, which is General, the owner's alone. A throw denies everyone
// (slice 3-3 review): authorize answers team_unavailable, an audience is empty
// and a stream predicate answers false.
// Returns `authorize` and, for the team event stream (slice 3-3), `sessionScope`
// over the same directory and resolver:
// - `audience(sessionId)`: the Set of active members who may read it now (empty
//   on any failure, never everyone);
// - `capture(sessionId)`: its project now, as a frozen `{ audience, bucket:
//   'project:<id>' }` for an event published after the conversation is gone;
//   `redeem(options, sessionId)` answers the publish options for a capture this
//   scope issued for that conversation, else null;
// - `identity(actor)`: the stream identity that re-checks every delivery;
// - `pass(fn)`: runs fn with one project lookup per conversation (a throw is
//   remembered as a throw), cleared when fn returns; a nested pass reuses it.
function createAuthorizer({ directory, sessionProject, dmParticipants } = {}) {
  for (const method of ['liveActor', 'isDegraded']) {
    if (!directory || typeof directory[method] !== 'function') {
      throw new TypeError('Authorizer requires a member directory.');
    }
  }
  let memo = null;
  const lookup = typeof sessionProject !== 'function' ? sessionProject : (sessionId) => {
    if (!memo) return sessionProject(sessionId);
    const known = memo.get(sessionId);
    if (known) { if (known.threw) throw known.error; return known.value; }
    try {
      const value = sessionProject(sessionId);
      memo.set(sessionId, { value });
      return value;
    } catch (error) {
      memo.set(sessionId, { threw: true, error });
      throw error;
    }
  };

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
      const notFound = () => forbid(row.resource === 'channel' ? 'team_chat_not_found' : 'team_not_found');
      // The wrong kind for this action, and not visible, read exactly like not existing.
      if (!resource || (resource.kind !== row.resource && resource.kind !== row.target)
        || typeof resource.id !== 'string') return notFound();
      // A conversation's project is resolved once per call, for both steps.
      const projectId = isTeamDirectory(directory) ? resourceProject(resource, lookup) : null;
      // E70: General is never where a team host makes or moves a conversation, for anyone (a team directory only).
      if (row.noGeneral === true && resource.kind === 'project' && projectId === GENERAL_PROJECT_ID) {
        return forbid('team_project_required');
      }
      // A team-project row (row 151): only an active project of the team. The owner's single-host exceptions
      // (General, a project with no team row, a project being deleted) do not reach it.
      if (row.teamProject === true && !(resource.kind === 'project' && typeof directory.projectState === 'function'
        && directory.projectState(projectId) === 'active')) return notFound();
      // An owner-any row (slice 3-4b): the live active owner, a healthy directory, an active project; nothing else.
      const ownerAny = row.ownerAny === true && activeOwner && !directory.isDegraded() && resource.kind === 'project'
        && typeof directory.projectState === 'function' && directory.projectState(projectId) === 'active';
      if (!ownerAny && !isVisible(directory, live, resource, lookup, projectId, dmParticipants)) return notFound();
      const denied = ownerAny ? null : projectDenial(directory, live, row, resource, projectId);
      return denied ? forbid(denied) : { ok: true };
    } catch (_error) {
      return hostFailure('unavailable', 'team_unavailable', requestId, true);
    }
  }

  const projectOf = (sessionId) => resourceProject({ kind: 'session', id: sessionId }, lookup);
  // capture -> what it stands for; the visible capture's Set is a copy, so changing it changes nothing.
  const captures = new WeakMap();
  const sessionScope = Object.freeze({
    audience(sessionId) {
      try {
        if (typeof sessionId !== 'string' || !sessionId) return new Set();
        return projectAudience(directory, projectOf(sessionId));
      } catch (_error) {
        return new Set();
      }
    },
    capture(sessionId) {
      let held = { sessionId, audience: new Set(), bucket: PROJECT_BUCKET };
      try {
        const projectId = typeof sessionId === 'string' && sessionId ? projectOf(sessionId) : '';
        if (PROJECT_BUCKET_ID.test(projectId)) {
          held = { sessionId, audience: projectAudience(directory, projectId), bucket: `${PROJECT_BUCKET}${projectId}` };
        }
      } catch (_error) { /* an empty audience and an empty project id: nobody */ }
      const capture = Object.freeze({ audience: new Set(held.audience), bucket: held.bucket });
      captures.set(capture, held);
      return capture;
    },
    redeem(options, sessionId) {
      const held = options !== null && typeof options === 'object' ? captures.get(options) : undefined;
      return held && held.sessionId === sessionId ? { audience: new Set(held.audience), bucket: held.bucket } : null;
    },
    identity: (actor) => streamIdentity(directory, actor, lookup, dmParticipants),
    pass(fn) {
      if (memo) return fn();
      memo = new Map();
      try { return fn(); } finally { memo = null; }
    },
  });

  return Object.freeze({ authorize, sessionScope });
}

// The identity a team event stream carries (slice 2a-2's `subscribe`). The
// predicate re-reads the device's live actor on every delivery: it must be
// active, not cut off by a degraded directory, have that member id and, for a
// chat bucket, see the channel by the rule above; for a session bucket (slice
// 3-3), see the conversation through `sessionProject`; for a project bucket, have
// access to that project. Any throw answers false, never into the event stream.
// An invite principal (no member id) gets no identity, so it receives no
// audience-scoped event.
function streamIdentity(directory, actor, sessionProject, participantsOf) {
  const memberId = actor?.member_id;
  const deviceId = actor?.device_id;
  if (typeof memberId !== 'string' || !memberId || typeof deviceId !== 'string' || !deviceId) return undefined;
  const mayReceive = (candidate, scope) => {
    try {
      const live = directory.liveActor(deviceId);
      if (!live || live.state !== 'active' || live.member_id !== candidate) return false;
      if (live.role !== 'owner' && directory.isDegraded()) return false;
      const bucket = typeof scope?.bucket === 'string' ? scope.bucket : '';
      if (bucket.startsWith(SESSION_BUCKET)) {
        const id = bucket.slice(SESSION_BUCKET.length);
        return id !== '' && isVisible(directory, live, { kind: 'session', id }, sessionProject);
      }
      if (bucket.startsWith(PROJECT_BUCKET)) {
        const id = bucket.slice(PROJECT_BUCKET.length);
        return id !== '' && projectAccess(directory, live, id) !== null;
      }
      if (bucket.startsWith(CHAT_BUCKET)) {
        return isVisible(directory, live, { kind: 'channel', id: bucket.slice(CHAT_BUCKET.length) }, undefined, undefined,
          participantsOf);
      }
      // An unknown bucket is denied. The default bucket of a bucketless event carries
      // only presence, the project change and the GPU list (BUCKETLESS_TYPES above).
      return bucket === DEFAULT_BUCKET && BUCKETLESS_TYPES.has(scope?.type);
    } catch (_error) {
      return false;
    }
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
