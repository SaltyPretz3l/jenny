'use strict';

// The team.* commands that travel through POST /api/v1/commands: roster,
// invites, devices, admit, role, revoke, audit, rename and owner transfer. The router has
// already validated the closed params schema and run the one authorization
// function (`identity`) for the command; the store repeats the owner-only rules
// behind it. A handler therefore adds no role check of its own: it passes the
// caller's live member id (never a value from `params`) to the store and returns
// what the store says.
//
// Mutations run through the router's receipt so an exact retry returns the
// first answer, and a committed mutation answers its own outcome: the store
// re-checks the actor inside the serialized mutation, so a second check after
// the commit could only misreport a change that happened. Reads and the two
// operations that carry an invite string (`team.invite.reveal`,
// `team.device.invite`) never use a receipt, so an invite string is never
// written to `command-receipts.json`.
//
// Logs carry the operation and a reason only: never a key, an invite string,
// a display name, a label, a team name or an address.

const { hostFailure } = require('../api-contract');
const { pickAddressHints } = require('./invites');
const { safeLogger } = require('./safe-logger');
const { deviceListView, inviteListView, rosterView } = require('./team-views');

// A store or invite service failure carries its own kind and reason; this adds
// the request id the command answer needs.
function withRequestId(answer, requestId) {
  if (!answer || answer.ok !== false) return answer;
  return { ok: false, error: { ...answer.error, request_id: requestId } };
}

function createTeamCommands({
  store, invites, directory, addresses = () => [], limiter = null, clock = Date.now, logger = null, chat = null,
} = {}) {
  if (!store || typeof store.snapshot !== 'function' || typeof store.rename !== 'function') {
    throw new TypeError('createTeamCommands requires a member store.');
  }
  if (!invites || typeof invites.create !== 'function') throw new TypeError('createTeamCommands requires an invite service.');
  if (!directory || typeof directory.liveActor !== 'function') throw new TypeError('createTeamCommands requires a directory.');
  if (chat !== null && (typeof chat?.dispatch !== 'function' || typeof chat.handles !== 'function')) {
    throw new TypeError('createTeamCommands chat needs dispatch and handles.');
  }
  const log = safeLogger(logger);

  // Address hints the invite codec accepts, at most four, in order. The address
  // list is lazy: the commands are built before the transport bridge exists.
  function hints() {
    try { return pickAddressHints(addresses()); } catch { return []; }
  }

  function snapshotOrFailure() {
    const doc = store.snapshot();
    return doc ? { doc } : { failure: store.open() };
  }

  // ------------------------------------------------------------------ reads

  const READS = {
    'team.members.list': ({ actor }) => {
      const { doc, failure } = snapshotOrFailure();
      return doc ? { ok: true, ...rosterView(doc, { owner: actor.owner }) } : failure;
    },
    'team.invite.reveal': ({ params }) => {
      const revealed = invites.reveal(params.invite_id);
      return revealed.ok ? { ok: true, invite: revealed.invite } : revealed;
    },
    'team.invite.list': () => {
      const { doc, failure } = snapshotOrFailure();
      return doc ? { ok: true, invites: inviteListView(doc, clock()) } : failure;
    },
    // A member cannot call `team.invite.reveal` (it is the owner's), so the
    // add-device invite is created and revealed in one call. If this answer is
    // lost the invite holds one of the member's three device slots until it
    // expires, 15 minutes after creation. A member revoked in between has no
    // live invite left, so the reveal refuses on its own.
    'team.device.invite': async ({ actor }) => {
      const created = await invites.create({ kind: 'add_device', actorMemberId: actor.member_id, hints: hints() });
      if (!created.ok) return created;
      const revealed = invites.reveal(created.invite_id);
      if (!revealed.ok) return revealed;
      return { ok: true, invite_id: created.invite_id, expires_at: created.expires_at, invite: revealed.invite };
    },
    'team.device.list': ({ actor }) => {
      const { doc, failure } = snapshotOrFailure();
      return doc ? { ok: true, devices: deviceListView(doc, { memberId: actor.member_id, owner: actor.owner }) } : failure;
    },
    'team.audit.read': ({ params }) => {
      const opened = store.open();
      if (!opened.ok) return opened;
      const page = store.audit.read({ cursor: params.cursor, limit: params.limit });
      return page.ok ? { ok: true, entries: page.entries, next_cursor: page.next_cursor } : page;
    },
  };

  // -------------------------------------------------------------- mutations

  const MUTATIONS = {
    'team.invite.create': async ({ params, actor }) => {
      const created = await invites.create({
        kind: 'new_member', actorMemberId: actor.member_id, role: params.role, ttlMs: params.ttl_ms, hints: hints(),
      });
      return created.ok ? { ok: true, invite_id: created.invite_id, expires_at: created.expires_at } : created;
    },
    'team.invite.revoke': async ({ params, actor }) => {
      const revoked = await invites.revoke({ actorMemberId: actor.member_id, inviteId: params.invite_id });
      return revoked.ok ? { ok: true } : revoked;
    },
    'team.device.revoke': async ({ params, actor }) => {
      const revoked = await store.revokeDevice({ actorMemberId: actor.member_id, deviceId: params.device_id });
      return revoked.ok ? { ok: true } : revoked;
    },
    'team.member.admit': async ({ params, actor }) => {
      const admitted = await store.admit({ actorMemberId: actor.member_id, memberId: params.member_id });
      return admitted.ok ? { ok: true, member_id: admitted.member_id, state: 'active' } : admitted;
    },
    'team.member.setRole': async ({ params, actor }) => {
      const changed = await store.setRole({
        actorMemberId: actor.member_id, memberId: params.member_id, role: params.role,
      });
      return changed.ok ? { ok: true, member_id: changed.member_id, role: params.role } : changed;
    },
    'team.member.revoke': async ({ params, actor }) => {
      const revoked = await store.revokeMember({ actorMemberId: actor.member_id, memberId: params.member_id });
      return revoked.ok ? { ok: true } : revoked;
    },
    'team.rename': async ({ params, actor }) => {
      const renamed = await store.rename({ actorMemberId: actor.member_id, name: params.name });
      return renamed.ok ? { ok: true } : renamed;
    },
    // One serialized store mutation swaps the two roles (old owner becomes a member).
    'team.owner.transfer': async ({ params, actor }) => {
      const moved = await store.transferOwner({ actorMemberId: actor.member_id, memberId: params.member_id });
      return moved.ok ? { ok: true, member_id: moved.member_id } : moved;
    },
  };

  async function dispatch(command, context, { runReceipt, canAdmit, publish } = {}) {
    const requestId = command.request_id;
    const operation = command.operation;
    // Chat keeps its own idempotency and limits: never the receipt store or the admin limiter.
    if (chat && chat.handles(operation)) {
      return withRequestId(await chat.dispatch(command, context, { canAdmit, publish }), requestId);
    }
    const read = Object.hasOwn(READS, operation) ? READS[operation] : null;
    const mutate = Object.hasOwn(MUTATIONS, operation) ? MUTATIONS[operation] : null;
    if (!read && !mutate) return hostFailure('invalid', 'unsupported_operation', requestId);

    const live = directory.liveActor(context?.deviceId);
    if (!live || typeof live.member_id !== 'string') return hostFailure('forbidden', 'role_forbidden', requestId);
    if (limiter && limiter.take(live.member_id) !== true) {
      log('WARN', 'team_command.rate_limited', { operation });
      return hostFailure('limit', 'team_rate_limit', requestId);
    }
    const call = { params: command.params, actor: { member_id: live.member_id, owner: live.role === 'owner' } };
    const answer = read
      ? withRequestId(await read(call), requestId)
      : await runReceipt(command, context, async () => withRequestId(await mutate(call), requestId));
    log('INFO', 'team_command.answered', { operation, ok: answer.ok === true, ...(answer.ok ? {} : { reason: answer.error?.reason }) });
    return answer;
  }

  return Object.freeze({ dispatch });
}

module.exports = { createTeamCommands };
