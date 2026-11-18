'use strict';

// The host's admin answers on the member side, rebuilt field by field before they reach the
// renderer (owner decision E49; the rules are in TEAM_MEMBERSHIP_SPEC "E49 as built"). No state.
// The table is closed: an operation with no row is refused, never passed through.

const { AUDIT_LIMITS } = require('../../server/team/audit-log');
const { isId } = require('../../server/team/ids');
const { MAX_INVITE_CHARS } = require('../../server/team/invites');
const {
  INVITE_KINDS, LIMITS, MEMBER_STATES, ROLES, isCleanText, isProjectId,
} = require('../../server/team/member-schema');
const { BAD, count, fields, flag, is, list, nullable, oneOf, record } = require('./answer-rules');
const { failureAnswer, invalidRequest } = require('./team-errors');

const INVALID_REASON = 'team_answer_invalid';
// A copy: server/team/member-schema.js does not export its device states.
const DEVICE_STATES = Object.freeze(['active', 'revoked']);
const FINGERPRINT = /^[0-9a-f]{10}$/u;
// An audit kind is checked as a word, not against the closed list: a newer host may write a kind this build does not know.
const KIND_WORD = /^[a-z][a-z0-9_]{0,63}$/u;
// Copies of the audit detail rule (server/team/audit-log.js `isDetail`, not exported).
const DETAIL = new RegExp(`^[A-Za-z0-9_=,.: -]{0,${AUDIT_LIMITS.MAX_DETAIL_CHARS}}$`, 'u');
const KEY_LIKE = /[A-Za-z0-9_-]{32,}/u;
const SECRET_PREFIX = /jteam(addr)?1_/iu;
const CONTROL = /\p{Cc}/u;

// A rule answers the checked value, or BAD (answer-rules.js, shared with project-answers.js).
const id = (kind) => is((value) => isId(kind, value));
const text = is(isCleanText);
const isFingerprint = (value) => typeof value === 'string' && FINGERPRINT.test(value);
const fingerprint = nullable(is(isFingerprint));
const inviteString = is((value) => typeof value === 'string' && value.length >= 1 && value.length <= MAX_INVITE_CHARS
  && !CONTROL.test(value));
const detail = nullable(is((value) => typeof value === 'string' && DETAIL.test(value) && !KEY_LIKE.test(value)
  && !SECRET_PREFIX.test(value)));

const DEVICE = {
  device_id: id('device'), label: text, state: oneOf(DEVICE_STATES), fingerprint, created_at: count,
  last_seen_at: nullable(count),
};
const MEMBER = { member_id: id('member'), display_name: text, role: oneOf(ROLES), state: oneOf(MEMBER_STATES) };
// What the owner sees of each member besides the base: present and checked as a group, or absent.
const OWNER_FIELDS = {
  created_at: count, admitted_at: nullable(count), devices: list(record(DEVICE), LIMITS.MAX_DEVICE_RECORDS),
};

function member(value) {
  const base = fields(value, MEMBER);
  if (base === BAD) return BAD;
  if (!Object.keys(OWNER_FIELDS).some((key) => Object.hasOwn(value, key))) return base;
  const owner = fields(value, OWNER_FIELDS);
  return owner === BAD ? BAD : { ...base, ...owner };
}

const INVITE = {
  invite_id: id('invite'), kind: oneOf(Object.keys(INVITE_KINDS)), role: oneOf(ROLES), member_id: nullable(id('member')),
  created_at: count, expires_at: count,
};
const ENTRY = {
  seq: is((value) => Number.isSafeInteger(value) && value >= 1), at: count,
  kind: is((value) => typeof value === 'string' && KIND_WORD.test(value)),
  actor_member_id: nullable(id('member')), subject_member_id: nullable(id('member')),
  subject_device_id: nullable(id('device')), name: nullable(text), detail, store_rev: count, applied: flag,
  project_id: nullable(is(isProjectId)),
};

// Host operation -> the documented fields of its success answer (without `ok`).
const ANSWERS = Object.freeze({
  'POST /api/v1/team/leave': {},
  'team.members.list': { team: record({ team_id: id('team'), name: text }), members: list(member, LIMITS.MAX_MEMBER_RECORDS) },
  'team.invite.create': { invite_id: id('invite'), expires_at: count },
  'team.invite.reveal': { invite: inviteString },
  'team.invite.revoke': {},
  'team.invite.list': { invites: list(record(INVITE), LIMITS.MAX_INVITE_RECORDS) },
  'team.device.invite': { invite_id: id('invite'), expires_at: count, invite: inviteString },
  'team.device.list': { devices: list(record({ member_id: id('member'), ...DEVICE }), LIMITS.MAX_DEVICE_RECORDS) },
  'team.device.revoke': {},
  'team.member.admit': { member_id: id('member'), state: oneOf(MEMBER_STATES) },
  'team.member.setRole': { member_id: id('member'), role: oneOf(ROLES) },
  'team.member.revoke': {},
  'team.owner.transfer': { member_id: id('member') },
  'team.audit.read': { entries: list(record(ENTRY), AUDIT_LIMITS.MAX_PAGE), next_cursor: nullable(count) },
  'team.rename': {},
  'team.member.profile': {},
});

/** The host's answer to `operation` as the renderer may see it: rebuilt, a checked failure, or the invalid failure. */
function adminAnswer(operation, answer) {
  if (!Object.hasOwn(ANSWERS, operation)) return invalidRequest(INVALID_REASON);
  if (!answer || answer.ok !== true) return failureAnswer(answer);
  const checked = fields(answer, ANSWERS[operation]);
  return checked === BAD ? invalidRequest(INVALID_REASON) : { ok: true, ...checked };
}

/** A manager's snapshot with its `team.status` facts and device fingerprint kept only when they pass the host's rules. */
function checkedTeam(row) {
  return {
    ...row,
    device_fingerprint: isFingerprint(row.device_fingerprint) ? row.device_fingerprint : null,
    team_name: isCleanText(row.team_name) ? row.team_name : null,
    role: ROLES.includes(row.role) ? row.role : null,
    member_state: MEMBER_STATES.includes(row.member_state) ? row.member_state : null,
  };
}

module.exports = { ADMIN_OPERATIONS: Object.freeze(Object.keys(ANSWERS)), adminAnswer, checkedTeam };
