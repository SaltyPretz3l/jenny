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
const { inviteContent, readInternetSetting } = require('./invites');
const { resolveCommand } = require('./operation-registry');
const { effectiveProjectRole } = require('./project-visibility');
const { routeDenial } = require('./route-guard');
const { safeLogger } = require('./safe-logger');
const { deviceListView, inviteListView, rosterView } = require('./team-views');

// A store or invite service failure carries its own kind and reason; this adds
// the request id the command answer needs.
function withRequestId(answer, requestId) {
  if (!answer || answer.ok !== false) return answer;
  return { ok: false, error: { ...answer.error, request_id: requestId } };
}

// The router's check again, for a chat command that awaited its channel's load: the
// context's guard (the one authorization function with this request's actor, read
// live) on every resource the command names, as the router's identity check asks.
// null when allowed, else that refusal; a context without a guard is refused.
function recheckFor(command, context) {
  return () => {
    const wanted = resolveCommand(command);
    if (!wanted) return hostFailure('forbidden', 'role_forbidden', command.request_id);
    for (const resource of wanted.resources) {
      const denied = routeDenial({ guard: context?.guard, requestId: command.request_id }, wanted.action, resource,
        { guardRequired: true });
      if (denied) return denied;
    }
    return null;
  };
}

const USAGE_TOTALS_MS = 7 * 24 * 60 * 60 * 1000;

// `internet()` is the host's internet joining setting (slice 5-3 takes it as an input; slice 5-5
// supplies it): null while off, so invites stay version 1 with today's hints, byte for byte.
// `usage()` answers the team engine usage log (usage-log.js) or null (slice 4e, read lazily: the log
// is opened after the commands are built).
function createTeamCommands({
  store, invites, directory, addresses = () => [], internet = () => null, settle = null, limiter = null, clock = Date.now,
  logger = null, chat = null, projects = null, nodes = null, usage = () => null, projectAudit = () => null,
  files = null, models = null, rules = null, boards = null, admitChatBoard = null,
} = {}) {
  if (!store || typeof store.snapshot !== 'function' || typeof store.rename !== 'function') {
    throw new TypeError('createTeamCommands requires a member store.');
  }
  if (!invites || typeof invites.create !== 'function') throw new TypeError('createTeamCommands requires an invite service.');
  if (!directory || typeof directory.liveActor !== 'function') throw new TypeError('createTeamCommands requires a directory.');
  if (chat !== null && (typeof chat?.dispatch !== 'function' || typeof chat.handles !== 'function')) {
    throw new TypeError('createTeamCommands chat needs dispatch and handles.');
  }
  if (nodes !== null && (typeof nodes?.dispatch !== 'function' || typeof nodes.handles !== 'function')) {
    throw new TypeError('createTeamCommands nodes needs dispatch and handles.');
  }
  if (boards !== null && (typeof boards?.dispatch !== 'function' || typeof boards.handles !== 'function')) {
    throw new TypeError('createTeamCommands boards needs dispatch and handles.');
  }
  if (projects !== null && (typeof projects?.dispatch !== 'function' || typeof projects.handles !== 'function'
    || typeof projects.isRead !== 'function')) {
    throw new TypeError('createTeamCommands projects needs dispatch, handles and isRead.');
  }
  const log = safeLogger(logger);

  // What a new invite carries: { ok, hints, internet } (invites.js inviteContent). The address list
  // is lazy: the commands are built before the transport bridge exists. A setting that cannot be
  // read is refused with `team_internet_invalid`, never issued as a version 1 invite. `settle` (optional)
  // resolves once the router has answered the port mapping request, or its own bound has passed: an invite
  // made a moment after internet joining went on would otherwise carry no public address.
  async function content() {
    if (settle) { try { await settle(); } catch { /* an invite is still made from what is known */ } }
    let listed;
    try { listed = addresses(); } catch { listed = []; }
    return inviteContent(readInternetSetting(internet), listed);
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
      const carried = await content();
      if (!carried.ok) return carried;
      const created = await invites.create({ kind: 'add_device', actorMemberId: actor.member_id, hints: carried.hints,
        internet: carried.internet });
      if (!created.ok) return created;
      const revealed = invites.reveal(created.invite_id);
      if (!revealed.ok) return revealed;
      return { ok: true, invite_id: created.invite_id, expires_at: created.expires_at, invite: revealed.invite };
    },
    'team.device.list': ({ actor }) => {
      const { doc, failure } = snapshotOrFailure();
      return doc ? { ok: true, devices: deviceListView(doc, { memberId: actor.member_id, owner: actor.owner }) } : failure;
    },
    // An entry that names a project goes only to a caller holding a row in it now (E30,
    // E31); the cursor moves by what the store read, so a page may come back short.
    'team.audit.read': ({ params, actor }) => {
      const opened = store.open();
      if (!opened.ok) return opened;
      const page = store.audit.read({ cursor: params.cursor, limit: params.limit });
      if (!page.ok) return page;
      const entries = page.entries.filter((entry) => entry.project_id == null
        || directory.projectRole(actor.member_id, entry.project_id) != null);
      return { ok: true, entries, next_cursor: page.next_cursor };
    },
    // Slice 4e: the owner's GPU use. Totals per member over the last 7 days and a page of rows, each
    // naming the hardware it ran on as this run has seen it (null when not). Never a prompt or a reply:
    // the log holds none. A log that cannot be read answers its failure.
    'team.pool.usage': ({ params }) => {
      let log;
      try { log = usage(); } catch { log = null; }
      if (!log || typeof log.read !== 'function') return hostFailure('unavailable', 'team_pool_unavailable');
      // The window is read on the log's own clock: the rows were stamped with it.
      const page = log.read({ cursor: params.cursor ?? null, limit: params.limit ?? 20, windowMs: USAGE_TOTALS_MS });
      if (!page.ok) return page;
      const rows = page.rows.map((row) => {
        const hardware = row.node_id && typeof nodes?.describeNode === 'function' ? nodes.describeNode(row.node_id) : null;
        return { ...row, node_member_id: hardware?.member_id ?? null, node_label: hardware?.label ?? null };
      });
      return { ok: true, totals: page.totals, rows, next_cursor: page.next_cursor };
    },
    // Slice 3-6b (E31): one project's audit log. The router's identity check already passed the
    // project.audit.read row (an admin of that project; the owner only with a row in it); the log
    // answers that project's entries only. A log that cannot be opened answers team_audit_unavailable.
    'team.project.audit.read': ({ params }) => {
      const audit = projectAudit();
      if (!audit) return hostFailure('unavailable', 'team_audit_unavailable');
      const page = audit.read({ projectId: params.project_id, afterSeq: params.after_seq ?? 0, limit: params.limit ?? 100 });
      return page.ok ? { ok: true, entries: page.entries, floor_seq: page.floor_seq, next_cursor: page.next } : page;
    },
  };

  // -------------------------------------------------------------- mutations

  const MUTATIONS = {
    'team.invite.create': async ({ params, actor }) => {
      const carried = await content();
      if (!carried.ok) return carried;
      const created = await invites.create({ kind: 'new_member', actorMemberId: actor.member_id, role: params.role,
        ttlMs: params.ttl_ms, hints: carried.hints, internet: carried.internet });
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
    // Slice 4e: the team model (null is Automatic), stored beside the team's name; the GPU list carries it.
    'team.pool.model.set': async ({ params, actor }) => {
      const set = await store.setTeamModel({ actorMemberId: actor.member_id, model: params.model });
      if (!set.ok) return set;
      nodes?.announce?.();
      return { ok: true };
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
    // The node commands (node-commands.js) keep their own idempotency and limits, as chat does (N17).
    if (nodes && nodes.handles(operation)) return withRequestId(await nodes.dispatch(command, context), requestId);
    // Chat keeps its own idempotency and limits: never the receipt store or the admin limiter.
    if (chat && chat.handles(operation)) {
      return withRequestId(await chat.dispatch(command, context,
        { canAdmit, publish, recheck: recheckFor(command, context) }), requestId);
    }
    // Boards (row 151 T2, boards/board-commands.js) keep their own limits too: a batch is idempotent by its batch id
    // and the list changes use the receipt. The store runs `recheck` again inside the board's queue.
    if (boards && boards.handles(operation)) {
      return boards.dispatch(command, context, { runReceipt, recheck: recheckFor(command, context) });
    }
    // The shared project commands (team-project-commands.js) take the same limiter, live actor and receipt.
    let read = Object.hasOwn(READS, operation) ? READS[operation] : null;
    let mutate = Object.hasOwn(MUTATIONS, operation) ? MUTATIONS[operation] : null;
    // Slice 3-8b: the project file commands (project-files.js) take the same path; so do the rules (3-12).
    // Slice 6-3: so do the model commands (model-commands.js), every one a read here: no receipt (the relay is
    // idempotent by request_id).
    const owner = [projects, files, rules, models].find((entry) => entry?.handles(operation));
    if (owner) {
      const project = (call) => owner.dispatch(command, call);
      read = owner.isRead(operation) ? project : null;
      mutate = read ? null : project;
    }
    if (!read && !mutate) return hostFailure('invalid', 'unsupported_operation', requestId);

    const live = directory.liveActor(context?.deviceId);
    if (!live || typeof live.member_id !== 'string') return hostFailure('forbidden', 'role_forbidden', requestId);
    // A family's fixed refusal (model sharing off or stopped) costs no rate-limit token.
    const refused = owner?.preflight ? owner.preflight() : null;
    if (refused) return withRequestId(refused, requestId);
    if (limiter && limiter.take(live.member_id) !== true) {
      log('WARN', 'team_command.rate_limited', { operation });
      return hostFailure('limit', 'team_rate_limit', requestId);
    }
    const call = { params: command.params,
      actor: { member_id: live.member_id, owner: live.role === 'owner', device_id: context.deviceId } };
    const answer = read
      ? withRequestId(await read(call), requestId)
      : await runReceipt(command, context, async () => withRequestId(await mutate(call), requestId));
    log('INFO', 'team_command.answered', { operation, ok: answer.ok === true, ...(answer.ok ? {} : { reason: answer.error?.reason }) });
    return answer;
  }

  // Slice 3-9: what `projects.list` adds on a team host, read once per list call. `roleOf` reports the
  // caller's effective role (a read-only team member reads `reader` whatever its row); it decides nothing
  // (the router's check already filtered the rows). The team owner with no row (General, a record the
  // reconcile has not bound) reads `owner`, the Roles table's own column. A caller the directory does not know reads no role.
  function projectListExtras(context) {
    const attempt = (read, fallback) => { try { return read(); } catch { return fallback; } };
    const filesSupported = attempt(() => files?.supported?.() === true, false);
    const live = attempt(() => directory.liveActor(context?.deviceId), null);
    const memberId = typeof live?.member_id === 'string' ? live.member_id : null;
    const owner = live?.role === 'owner';
    function roleOf(projectId) {
      if (!memberId) return null;
      return attempt(() => effectiveProjectRole(directory, live, projectId), null) ?? (owner ? 'owner' : null);
    }
    return { filesSupported, roleOf };
  }

  // Row 151 T5: `chat.send` with a board id asks the board host (boards/board-turn-ports.js `admitChat`).
  return Object.freeze({ dispatch, projectListExtras, ...(typeof admitChatBoard === 'function' ? { admitChatBoard } : {}) });
}

module.exports = { createTeamCommands };
