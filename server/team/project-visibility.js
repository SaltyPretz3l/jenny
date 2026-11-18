'use strict';

// Phase 3's project rule (TEAM_PROJECTS_SPEC "Effective role" and "One
// visibility rule"), used only by isVisible(), authorize(), channelMembers() and
// the session event scope in authorize.js. Pure over the directory's current
// state: it reads directory.projectRole and directory.projectState (and, for an
// audience, activeMemberIds and memberActor) and nothing else, on every call.
// The mode is a construction fact: the single-owner directory carries
// SINGLE_OWNER_DIRECTORY and never reaches this module; every other directory
// is a team directory, and one without projectRole shows no project, no
// conversation and no project channel. Anything unknown is owner only or nobody.

const { channelKind } = require('../../services/host/team-chat-schema');
const { PROJECT_ROLES: STORED_PROJECT_ROLES } = require('./member-schema');

const GENERAL_PROJECT_ID = 'project_general';
// member-schema lists the roles highest first; ranks here run lowest first.
const PROJECT_ROLES = Object.freeze([...STORED_PROJECT_ROLES].reverse());
const CHANNEL_PREFIX = 'chan_';
// Set, non-enumerable, only by createSingleOwnerDirectory(): a copy of that
// directory does not carry it, so a copy is a team directory and closes.
const SINGLE_OWNER_DIRECTORY = Symbol('jenny.singleOwnerDirectory');

function isTeamDirectory(directory) {
  return directory?.[SINGLE_OWNER_DIRECTORY] !== true;
}

function hasProjectRoles(directory) {
  return isTeamDirectory(directory) && typeof directory?.projectRole === 'function';
}

function isActiveOwner(live) {
  return Boolean(live) && live.role === 'owner' && live.state === 'active';
}

// A project's state: 'active', 'deleting', another stored value, or null for no
// team row. A directory without projectState reads every project as active, so
// the owner exceptions below fail closed.
function projectStateOf(directory, projectId) {
  return typeof directory.projectState === 'function' ? directory.projectState(projectId) ?? null : 'active';
}

// The effective-role table: an active owner or member has the stored role or
// none (the owner has none in a project they did not join, E23); an active
// read-only member is a reader when in the project (P4); pending, invite and
// revoked principals have none.
function effectiveProjectRole(directory, live, projectId) {
  if (!live || live.state !== 'active' || typeof live.member_id !== 'string' || !live.member_id) return null;
  if (!hasProjectRoles(directory) || typeof projectId !== 'string' || !projectId) return null;
  const stored = directory.projectRole(live.member_id, projectId);
  if (!PROJECT_ROLES.includes(stored)) return null;
  if (live.role === 'read_only') return 'reader';
  return live.role === 'owner' || live.role === 'member' ? stored : null;
}

// The effective role in an active project only, whatever the directory answers
// for a project in any other state.
function activeProjectRole(directory, live, projectId) {
  if (!hasProjectRoles(directory) || typeof projectId !== 'string' || !projectId) return null;
  return projectStateOf(directory, projectId) === 'active' ? effectiveProjectRole(directory, live, projectId) : null;
}

// What the actor may do in a project, or null (not visible): the effective role
// in an active project; for the active owner, General and a project with no
// team row act as on the single-owner host and a deleting project is read only;
// any other state is nobody's.
function projectAccess(directory, live, projectId) {
  if (!hasProjectRoles(directory) || typeof projectId !== 'string' || !projectId) return null;
  if (projectId === GENERAL_PROJECT_ID) return isActiveOwner(live) ? { role: 'admin', deleting: false } : null;
  const state = projectStateOf(directory, projectId);
  if (state === 'active') {
    const role = effectiveProjectRole(directory, live, projectId);
    return role ? { role, deleting: false } : null;
  }
  if (!isActiveOwner(live)) return null;
  if (state === null) return { role: 'admin', deleting: false };
  return state === 'deleting' ? { role: 'reader', deleting: true } : null;
}

function roleAtLeast(role, minimum) {
  const need = PROJECT_ROLES.indexOf(minimum);
  return need >= 0 && PROJECT_ROLES.indexOf(role) >= need;
}

// The project a conversation is in, from the injected resolver: a non-empty
// string, else null (unknown). A missing resolver is unknown. A throw leaves
// here: the callers deny everyone (slice 3-3 review), never read it as General.
function conversationProject(sessionProject, sessionId) {
  if (typeof sessionProject !== 'function') return null;
  const projectId = sessionProject(sessionId);
  return typeof projectId === 'string' && projectId ? projectId : null;
}

// The project a resource's role is checked against: a project's own id, a
// conversation's project (unknown reads as General, which is owner only), ''
// for an empty id (list and create; the action row decides), null otherwise.
function resourceProject(resource, sessionProject) {
  if (resource.kind === 'project') return resource.id;
  if (resource.kind !== 'session') return null;
  if (resource.id === '') return '';
  return conversationProject(sessionProject, resource.id) ?? GENERAL_PROJECT_ID;
}

// isVisible() for a project or conversation resource, given its resolved project.
function projectIdVisible(directory, live, projectId) {
  if (projectId === '') return true;
  return typeof projectId === 'string' && projectAccess(directory, live, projectId) !== null;
}

function channelProject(channelId) {
  return channelKind(channelId) === 'project' ? channelId.slice(CHANNEL_PREFIX.length) : null;
}

// A direct conversation's stored participants from `participantsOf`, the injected lazy lookup (the chat store's).
// A missing lookup, a throw, an unknown id, a wrong answer and a conversation with no stored participants all give
// nobody, the owner included.
function storedParticipants(channelId, participantsOf) {
  try {
    const participants = participantsOf(channelId);
    return Array.isArray(participants) ? participants : [];
  } catch (_error) {
    return [];
  }
}

// The team channel and a custom channel (row 173) are every active member; a
// project channel is the members with an effective role in that active project; a
// direct channel is its participants who are active (storedParticipants).
function channelVisible(directory, live, channelId, participantsOf) {
  if (!live || live.state !== 'active') return false;
  const kind = channelKind(channelId);
  if (kind === 'team' || kind === 'channel') return true;
  // The asker is known to be active, so no audience set is built for a single check.
  if (kind === 'dm') return storedParticipants(channelId, participantsOf).includes(live.member_id);
  return kind === 'project' && activeProjectRole(directory, live, channelProject(channelId)) !== null;
}

// The same audience as a Set of member ids. Every id activeMemberIds() lists is
// active, so "has an effective role" is "has a stored role" (the read-only cap
// changes the level, never none-ness).
function channelAudience(directory, channelId, participantsOf) {
  if (typeof directory?.activeMemberIds !== 'function') return new Set();
  const kind = channelKind(channelId);
  if (kind === 'team' || kind === 'channel') return new Set(directory.activeMemberIds());
  if (kind === 'dm') {
    const active = new Set(directory.activeMemberIds());
    return new Set(storedParticipants(channelId, participantsOf).filter((memberId) => active.has(memberId)));
  }
  const projectId = kind === 'project' ? channelProject(channelId) : null;
  if (!projectId || !hasProjectRoles(directory) || projectStateOf(directory, projectId) !== 'active') return new Set();
  return new Set(directory.activeMemberIds().filter((memberId) => PROJECT_ROLES.includes(
    directory.projectRole(memberId, projectId))));
}

// The members a conversation's events go to (slice 3-3): every member whom
// projectAccess above admits (it refuses anyone not active), read now. Always a
// Set: when nobody qualifies it is empty (an event stream reads a null audience
// as a broadcast). Without activeMemberIds and memberActor it names nobody.
function projectAudience(directory, projectId) {
  const audience = new Set();
  if (typeof directory?.activeMemberIds !== 'function' || typeof directory?.memberActor !== 'function') return audience;
  for (const memberId of directory.activeMemberIds()) {
    const live = directory.memberActor(memberId);
    if (!live) continue;
    if (projectAccess(directory, live, projectId) !== null) audience.add(memberId);
  }
  return audience;
}

module.exports = {
  GENERAL_PROJECT_ID, PROJECT_ROLES, SINGLE_OWNER_DIRECTORY, channelAudience, channelVisible, conversationProject,
  effectiveProjectRole, isTeamDirectory, projectAccess, projectAudience, projectIdVisible, resourceProject, roleAtLeast,
};
