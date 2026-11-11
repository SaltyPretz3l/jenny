'use strict';

// The closed table behind the `team.*` IPC methods. Every payload is checked in
// main before anything is sent: a plain object (or nothing, for `status`), only
// the listed fields, the team id pattern, the host's id patterns and bounded
// strings and integers; names and labels follow the host's own text rule. Each
// host-facing method maps to exactly one host
// operation; `join`, `status` and `removeTeam` are local. The host decides who
// may do what: nothing here knows a role. The `host*` methods (slice 1f-2) are
// handled in main by the team host controller (services/team/host/): this
// Jenny's own host, never a command sent to a host.

const { isId } = require('../../server/team/ids');
const { isCleanText } = require('../../server/team/member-schema');

const MAX_INVITE = 256;
const CONTROL = /\p{Cc}/u;

const inviteText = (value) => typeof value === 'string' && value.length >= 1 && value.length <= MAX_INVITE
  && !CONTROL.test(value);
// Display names, device labels and the team name: the host's rule (NFC, nothing invisible, 1 to 40 characters).
const name = (value) => isCleanText(value);
const id = (kind) => (value) => isId(kind, value);
const role = (value) => value === 'member' || value === 'read_only';
const integer = (min, max) => (value) => Number.isSafeInteger(value) && value >= min && value <= max;

const TEAM = { team_id: id('team') };

// method -> { fields: { name: check }, optional: [names] }
const METHODS = Object.freeze({
  join: { fields: { invite: inviteText, display_name: name, label: name } },
  status: { fields: {} },
  leave: { fields: { ...TEAM } },
  removeTeam: { fields: { ...TEAM } },
  members: { fields: { ...TEAM } },
  inviteCreate: { fields: { ...TEAM, role, ttl_ms: integer(60_000, 604_800_000) }, optional: ['ttl_ms'] },
  inviteReveal: { fields: { ...TEAM, invite_id: id('invite') } },
  inviteRevoke: { fields: { ...TEAM, invite_id: id('invite') } },
  inviteList: { fields: { ...TEAM } },
  deviceInvite: { fields: { ...TEAM } },
  deviceList: { fields: { ...TEAM } },
  deviceRevoke: { fields: { ...TEAM, device_id: id('device') } },
  memberAdmit: { fields: { ...TEAM, member_id: id('member') } },
  memberSetRole: { fields: { ...TEAM, member_id: id('member'), role } },
  memberRevoke: { fields: { ...TEAM, member_id: id('member') } },
  ownerTransfer: { fields: { ...TEAM, member_id: id('member') } },
  auditRead: { fields: { ...TEAM, cursor: integer(0, Number.MAX_SAFE_INTEGER), limit: integer(1, 100) },
    optional: ['cursor', 'limit'] },
  rename: { fields: { ...TEAM, name } },
  hostDeploy: { fields: { name, display_name: name, label: name } },
  hostStop: { fields: {} },
  hostStatus: { fields: {} },
  hostRecover: { fields: { display_name: name, label: name } },
});

// Methods that may be called with no payload (nothing, `null` or `{}`).
const EMPTY_PAYLOAD_METHODS = new Set(['status', 'hostStop', 'hostStatus']);

// The one host operation each method sends: a command operation, or the raw route for leave.
const HOST_OPERATIONS = Object.freeze({
  leave: 'POST /api/v1/team/leave',
  members: 'team.members.list',
  inviteCreate: 'team.invite.create',
  inviteReveal: 'team.invite.reveal',
  inviteRevoke: 'team.invite.revoke',
  inviteList: 'team.invite.list',
  deviceInvite: 'team.device.invite',
  deviceList: 'team.device.list',
  deviceRevoke: 'team.device.revoke',
  memberAdmit: 'team.member.admit',
  memberSetRole: 'team.member.setRole',
  memberRevoke: 'team.member.revoke',
  ownerTransfer: 'team.owner.transfer',
  auditRead: 'team.audit.read',
  rename: 'team.rename',
});

const LOCAL_METHODS = Object.freeze(['join', 'status', 'removeTeam']);
const HOST_METHODS = Object.freeze(['hostDeploy', 'hostStop', 'hostStatus', 'hostRecover']);

/** { ok: true, value } with exactly the allowed fields, or { ok: false }. */
function validatePayload(method, payload) {
  if (!Object.hasOwn(METHODS, method)) return { ok: false };
  const { fields, optional = [] } = METHODS[method];
  if (EMPTY_PAYLOAD_METHODS.has(method) && (payload === undefined || payload === null)) return { ok: true, value: {} };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false };
  if (Object.getPrototypeOf(payload) !== Object.prototype && Object.getPrototypeOf(payload) !== null) return { ok: false };
  const names = Object.keys(payload);
  if (names.some((name) => !Object.hasOwn(fields, name))) return { ok: false };
  const value = {};
  for (const [name, check] of Object.entries(fields)) {
    if (!Object.hasOwn(payload, name)) {
      if (optional.includes(name)) continue;
      return { ok: false };
    }
    if (!check(payload[name])) return { ok: false };
    value[name] = payload[name];
  }
  return { ok: true, value };
}

/** The host params for a command method: the validated payload without the team id. */
function hostParams(value) {
  const { team_id: _teamId, ...params } = value;
  return params;
}

module.exports = { HOST_METHODS, HOST_OPERATIONS, LOCAL_METHODS, METHODS, hostParams, validatePayload };
