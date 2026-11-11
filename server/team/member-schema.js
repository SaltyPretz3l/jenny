'use strict';

// The schema of team-members.json (version 2): closed-field validation of the
// whole document, the owner invariant, the limits this store owns, and the
// invite expiry table. Pure functions; nothing here touches the disk.
//
// Version 2 adds `projects`, who is in which shared project (TEAM_PROJECTS_SPEC
// P1). A version 1 document is upgraded explicitly by `upgradeDocument`: it is
// validated by the version 1 rules, gains `projects: []`, and is written as
// version 2 by the store's next commit. Anything newer fails closed.

const {
  ID_PATTERNS, isId, isPublicKey, deriveTeamId,
} = require('./ids');

const SCHEMA_VERSION = 2;
const ROLES = Object.freeze(['owner', 'member', 'read_only']);
const PROJECT_ROLES = Object.freeze(['admin', 'writer', 'reader']);
const PROJECT_STATES = Object.freeze(['active', 'deleting']);
// Copies of the application project id pattern and General's id
// (services/projects/project-schema.js, which server/team does not import); a
// test keeps them equal. General is never a team project (TEAM_PROJECTS_SPEC P9).
const PROJECT_ID_PATTERN = /^project_[A-Za-z0-9_-]{1,128}$/u;
const GENERAL_PROJECT_ID = 'project_general';
const ASSIGNABLE_ROLES = Object.freeze(['member', 'read_only']);
const MEMBER_STATES = Object.freeze(['pending', 'active', 'revoked']);
const DEVICE_STATES = Object.freeze(['active', 'revoked']);
// `created_by` of an invite minted by the local command (first owner, recovery).
const LOCAL_ACTOR = 'local';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const LIMITS = Object.freeze({
  MAX_LIVE_MEMBERS: 8,
  MAX_ACTIVE_DEVICES: 3,
  MAX_OUTSTANDING_INVITES: 8,
  MAX_REVOKED_MEMBERS: 56,
  MAX_REVOKED_DEVICES: 56,
  MAX_RETIRED_INVITES: 16,
  MAX_STORE_BYTES: 256 * 1024,
  LAST_SEEN_INTERVAL_MS: MINUTE_MS,
  MAX_NAME_CHARS: 40,
  // Hard array caps so a hostile document cannot make validation expensive.
  MAX_MEMBER_RECORDS: 8 + 56,
  MAX_DEVICE_RECORDS: 320,
  MAX_INVITE_RECORDS: 8 + 16 + 8,
  MAX_PROJECTS: 64,
});

// Expiry defaults and maxima per invite kind (design spec, Invites and joining).
const INVITE_KINDS = Object.freeze({
  new_member: { defaultMs: DAY_MS, maxMs: 7 * DAY_MS },
  add_device: { defaultMs: 15 * MINUTE_MS, maxMs: 15 * MINUTE_MS },
  owner_first: { defaultMs: 15 * MINUTE_MS, maxMs: 15 * MINUTE_MS },
  recovery: { defaultMs: 15 * MINUTE_MS, maxMs: 15 * MINUTE_MS },
});

const KEY_SETS = Object.freeze({
  document_v1: ['schema_version', 'rev', 'team', 'members', 'devices', 'invites'],
  document: ['schema_version', 'rev', 'team', 'members', 'devices', 'invites', 'projects'],
  project: ['project_id', 'created_by', 'created_at', 'state', 'members'],
  project_member: ['member_id', 'role', 'added_by', 'added_at'],
  team: ['team_id', 'host_public_key', 'name', 'created_at'],
  member: ['member_id', 'display_name', 'role', 'state', 'created_at', 'admitted_at', 'admitted_by',
    'revoked_at', 'revoked_by'],
  device: ['device_id', 'member_id', 'public_key', 'label', 'state', 'created_at', 'last_seen_at'],
  invite: ['invite_id', 'invite_public_key', 'role', 'member_id', 'created_by', 'created_at', 'expires_at',
    'used_at', 'revoked_at'],
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNullOrCount(value) {
  return value === null || isCount(value);
}

function isNullOrId(kind, value) {
  return value === null || isId(kind, value);
}

// Direction overrides, isolates and marks, and the zero-width space, word
// joiner and byte-order mark. Joiners inside emoji and scripts stay allowed.
const INVISIBLE_OR_BIDI = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;

// Display names, device labels and the team name: NFC, no control or line
// separator characters, nothing that hides or reorders the text, something
// visible, no leading or trailing space, 1 to `maxChars` characters. The owner
// admits a person by reading this text.
function isCleanText(value, maxChars = LIMITS.MAX_NAME_CHARS) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars * 2) return false;
  if (value.normalize('NFC') !== value) return false;
  if (value.trim() !== value) return false;
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) || INVISIBLE_OR_BIDI.test(value)) return false;
  if (value.replace(/[\p{Cf}\p{Z}]/gu, '').length === 0) return false;
  const length = [...value].length;
  return length >= 1 && length <= maxChars;
}

function emptyDocument({ hostPublicKey, teamName, now }) {
  return {
    schema_version: SCHEMA_VERSION,
    rev: 0,
    team: {
      team_id: deriveTeamId(hostPublicKey), host_public_key: hostPublicKey, name: teamName, created_at: now,
    },
    members: [],
    devices: [],
    invites: [],
    projects: [],
  };
}

function isProjectId(value) {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value) && value !== GENERAL_PROJECT_ID;
}

function fail(reason, schema = false) {
  return { ok: false, reason, schema };
}

function validateTeam(team) {
  if (!isPlainObject(team) || !hasExactKeys(team, KEY_SETS.team)) return false;
  if (!isPublicKey(team.host_public_key)) return false;
  if (team.team_id !== deriveTeamId(team.host_public_key)) return false;
  return isCleanText(team.name) && isCount(team.created_at);
}

function validateMember(member) {
  if (!isPlainObject(member) || !hasExactKeys(member, KEY_SETS.member)) return false;
  if (!ID_PATTERNS.member.test(member.member_id) || !isCleanText(member.display_name)) return false;
  if (!ROLES.includes(member.role) || !MEMBER_STATES.includes(member.state)) return false;
  if (!isCount(member.created_at) || !isNullOrCount(member.admitted_at) || !isNullOrCount(member.revoked_at)) return false;
  if (!isNullOrId('member', member.admitted_by) || !isNullOrId('member', member.revoked_by)) return false;
  if (member.state === 'revoked') {
    return member.revoked_at !== null && member.revoked_by !== null;
  }
  if (member.revoked_at !== null || member.revoked_by !== null) return false;
  if (member.state === 'pending') return member.admitted_at === null && member.admitted_by === null && member.role !== 'owner';
  return member.admitted_at !== null;
}

function validateDevice(device) {
  if (!isPlainObject(device) || !hasExactKeys(device, KEY_SETS.device)) return false;
  return ID_PATTERNS.device.test(device.device_id) && ID_PATTERNS.member.test(device.member_id)
    && isPublicKey(device.public_key) && isCleanText(device.label) && DEVICE_STATES.includes(device.state)
    && isCount(device.created_at) && isNullOrCount(device.last_seen_at);
}

function validateInvite(invite) {
  if (!isPlainObject(invite) || !hasExactKeys(invite, KEY_SETS.invite)) return false;
  if (!ID_PATTERNS.invite.test(invite.invite_id) || !isPublicKey(invite.invite_public_key)) return false;
  if (!ROLES.includes(invite.role) || !isNullOrId('member', invite.member_id)) return false;
  if (invite.created_by !== LOCAL_ACTOR && !ID_PATTERNS.member.test(invite.created_by)) return false;
  if (!isCount(invite.created_at) || !isCount(invite.expires_at) || invite.expires_at <= invite.created_at) return false;
  return isNullOrCount(invite.used_at) && isNullOrCount(invite.revoked_at);
}

function validateArrays(doc) {
  const { members, devices, invites } = doc;
  if (!Array.isArray(members) || !Array.isArray(devices) || !Array.isArray(invites)) return fail('shape_invalid');
  if (members.length > LIMITS.MAX_MEMBER_RECORDS || devices.length > LIMITS.MAX_DEVICE_RECORDS
    || invites.length > LIMITS.MAX_INVITE_RECORDS) return fail('record_limit_exceeded');
  if (!members.every(validateMember)) return fail('member_invalid');
  if (!devices.every(validateDevice)) return fail('device_invalid');
  if (!invites.every(validateInvite)) return fail('invite_invalid');
  return null;
}

function validateRelations(doc) {
  const byId = new Map();
  for (const member of doc.members) {
    if (byId.has(member.member_id)) return fail('duplicate_member');
    byId.set(member.member_id, member);
  }
  const deviceIds = new Set();
  const keys = new Set();
  const activeCount = new Map();
  let revokedOfLive = 0;
  for (const device of doc.devices) {
    const owner = byId.get(device.member_id);
    if (!owner || deviceIds.has(device.device_id) || keys.has(device.public_key)) return fail('device_relation_invalid');
    deviceIds.add(device.device_id);
    keys.add(device.public_key);
    if (device.state === 'active') {
      if (owner.state === 'revoked') return fail('device_relation_invalid');
      const count = (activeCount.get(owner.member_id) || 0) + 1;
      if (count > LIMITS.MAX_ACTIVE_DEVICES) return fail('device_limit_exceeded');
      activeCount.set(owner.member_id, count);
    } else if (owner.state !== 'revoked') {
      revokedOfLive += 1;
    }
  }
  if (revokedOfLive > LIMITS.MAX_REVOKED_DEVICES) return fail('device_limit_exceeded');
  const inviteIds = new Set();
  let outstanding = 0;
  for (const invite of doc.invites) {
    if (inviteIds.has(invite.invite_id) || keys.has(invite.invite_public_key)) return fail('invite_relation_invalid');
    inviteIds.add(invite.invite_id);
    keys.add(invite.invite_public_key);
    if (invite.member_id !== null && !byId.has(invite.member_id)) return fail('invite_relation_invalid');
    const live = invite.used_at === null && invite.revoked_at === null;
    if (live) outstanding += 1;
    // The first-owner invite is valid only while the store holds zero members.
    if (live && invite.role === 'owner' && invite.member_id === null && doc.members.length > 0) {
      return fail('invite_relation_invalid');
    }
  }
  if (outstanding > LIMITS.MAX_OUTSTANDING_INVITES) return fail('invite_limit_exceeded');
  return null;
}

function validateProjectMember(entry) {
  if (!isPlainObject(entry) || !hasExactKeys(entry, KEY_SETS.project_member)) return false;
  return isId('member', entry.member_id) && PROJECT_ROLES.includes(entry.role)
    && isId('member', entry.added_by) && isCount(entry.added_at);
}

function validateProject(project) {
  if (!isPlainObject(project) || !hasExactKeys(project, KEY_SETS.project)) return false;
  if (!isProjectId(project.project_id) || !isId('member', project.created_by)) return false;
  if (!isCount(project.created_at) || !PROJECT_STATES.includes(project.state)) return false;
  return Array.isArray(project.members) && project.members.length <= LIMITS.MAX_LIVE_MEMBERS
    && project.members.every(validateProjectMember);
}

// Who is in which project. A project member is an active team member, listed
// once; a read-only team member is a reader (P4). `created_by` and `added_by`
// are history and may name a member pruned since, so only their shape is checked.
function validateProjects(doc) {
  if (!Array.isArray(doc.projects)) return fail('shape_invalid');
  if (doc.projects.length > LIMITS.MAX_PROJECTS) return fail('record_limit_exceeded');
  if (!doc.projects.every(validateProject)) return fail('project_invalid');
  const teamMembers = new Map(doc.members.map((member) => [member.member_id, member]));
  const projectIds = new Set();
  for (const project of doc.projects) {
    if (projectIds.has(project.project_id)) return fail('duplicate_project');
    projectIds.add(project.project_id);
    const seen = new Set();
    for (const entry of project.members) {
      const member = teamMembers.get(entry.member_id);
      if (seen.has(entry.member_id) || !member || member.state !== 'active') return fail('project_relation_invalid');
      if (member.role === 'read_only' && entry.role !== 'reader') return fail('project_relation_invalid');
      seen.add(entry.member_id);
    }
  }
  return null;
}

// No members means no owner. Any member means exactly one owner, and the owner
// is active.
function validateOwnerInvariant(doc) {
  if (doc.members.length === 0) return null;
  const owners = doc.members.filter((member) => member.role === 'owner');
  if (owners.length !== 1 || owners[0].state !== 'active') return fail('owner_invariant');
  const live = doc.members.filter((member) => member.state !== 'revoked').length;
  const revoked = doc.members.length - live;
  if (live > LIMITS.MAX_LIVE_MEMBERS || revoked > LIMITS.MAX_REVOKED_MEMBERS) return fail('member_limit_exceeded');
  return null;
}

// Returns { ok: true } or { ok: false, reason, schema }. `schema` is true only
// for an unknown or newer schema_version, which must not be treated as corrupt.
function validateDocument(doc) {
  if (!isPlainObject(doc)) return fail('not_object');
  if (!Number.isSafeInteger(doc.schema_version) || doc.schema_version !== SCHEMA_VERSION) {
    return Number.isSafeInteger(doc.schema_version) ? fail('unsupported_schema', true) : fail('shape_invalid');
  }
  if (!hasExactKeys(doc, KEY_SETS.document)) return fail('unknown_field');
  return validateBody(doc);
}

function validateBody(doc) {
  if (!isCount(doc.rev)) return fail('rev_invalid');
  if (!validateTeam(doc.team)) return fail('team_invalid');
  return validateArrays(doc) || validateRelations(doc) || validateOwnerInvariant(doc) || validateProjects(doc)
    || { ok: true };
}

// The explicit migration. Returns { ok: true, doc, upgraded } with a fresh
// version 2 document, or the failure `validateDocument` would give. A version 1
// document must pass every version 1 rule before it gains `projects: []`; the
// caller's object is never changed.
function upgradeDocument(doc) {
  if (isPlainObject(doc) && doc.schema_version === 1) {
    if (!hasExactKeys(doc, KEY_SETS.document_v1)) return fail('unknown_field');
    const upgraded = { ...doc, schema_version: SCHEMA_VERSION, projects: [] };
    const checked = validateBody(upgraded);
    return checked.ok ? { ok: true, doc: upgraded, upgraded: true } : checked;
  }
  const checked = validateDocument(doc);
  return checked.ok ? { ok: true, doc, upgraded: false } : checked;
}

module.exports = {
  SCHEMA_VERSION,
  ROLES,
  ASSIGNABLE_ROLES,
  MEMBER_STATES,
  PROJECT_ROLES,
  PROJECT_ID_PATTERN,
  GENERAL_PROJECT_ID,
  LOCAL_ACTOR,
  LIMITS,
  INVITE_KINDS,
  hasExactKeys,
  isCleanText,
  isCount,
  isPlainObject,
  isProjectId,
  emptyDocument,
  upgradeDocument,
  validateDocument,
};
