'use strict';

// Team boards T2 to T5 (row 151, plan PROJECT_BOARD_2026-11-13 sections 8.2 to 8.6): the team.board.* commands.
//
// The router has validated the closed params schema and run the one authorization function for the command's
// registry row (board.read, board.presence, board.write or board.admin; the resource is the project). A handler adds
// no role check of its own. It passes the caller's live member id (never a value from `params`) to the board store,
// and hands the store the router's own check (`recheck`, team-commands.js recheckFor) to run again inside the
// board's queue, together with "still the same active member": a member demoted, removed or revoked while a call
// waited is not served. A command that arrives without that check is refused.
//
// A board is always asked for by (project id, board id): the project is the one the router authorized, so a board
// id from another project reads as not found.
//
// The rules of a batch on a team board (`batchRules`), checked inside the board's queue with the other checks on
// every batch whatever way it comes (a member's batch, an accepted proposal, a revert):
//   - A chat card may point only at a conversation of that team project (plan section 8.7). An unknown conversation,
//     one in another project and one in no project get the one refusal `team_board_chat_outside_project`.
//   - A note another member holds (plan section 8.4, board-presence.js) is not edited or removed:
//     `team_board_note_locked` with `held_by`. Moving it is not an edit.
//
// Limits are this family's own, a member each (never the team command limiter, whose 30 a minute is below a board's
// working rate): 60 batches, 20 list changes (create, rename, delete, restore, revert), 120 reads, 60 proposal
// decisions and 120 presence calls a minute; a cursor is 600 a minute a device. A batch is at most 256 KiB of JSON.
// Idempotency: a batch by its batch id (the model's ring answers a repeat as a duplicate and writes nothing); the
// list changes and a revert through the router's receipt, so an exact retry answers as the first did.
// `team.board.apply` never uses a receipt: its answer carries the applied batch.
//
// `team.board.sync { board_id, after_rev }` (T3) answers the batches after a rev from the host's journal, in the
// host's order, in pages of at most 512 KiB (`more` says another page follows), or `snapshot: true` when the
// journal cannot serve the whole range: the client then reads the snapshot route. Its limit is its own (240 a
// minute a member), so catching up never spends the list reads. A read is checked again after the store
// answered: a member removed or revoked while it waited gets the refusal, not the data.
//
// Presence (T4, board-presence-ops.js: view, leave, cursor, lock, unlock) takes no queue: the checks run before the
// operation, and again after the one read it makes of the board store.
//
// Jenny's proposals (T5, board-proposals-host.js): `team.board.proposal.list`, and `.accept` (without `n`: every
// addition; with `n`: that one edit or removal, D16) and `.reject` (without `n`: everything still pending), for a
// writer whose device is viewing the board; the viewing record is checked again inside the queue with the rest.
//
// Audit first (T5, plan section 8.6): deleting and restoring a board, reverting a batch (`team.board.revert`, a
// project admin, while the journal still holds it) and a batch that removes 20 items or more each write their
// project audit entry inside the board's queue, once the change is known to apply and before its first write.
// When the entry cannot be written the change is refused (`team_audit_unavailable`).
//
// Logs carry the operation and a reason word only: never a board name, a card's text, an id or a path.

const { hostFailure } = require('../../api-contract');
const { createRateLimiter } = require('../rate-limit');
const { safeLogger } = require('../safe-logger');
const { isHostBatchId } = require('./board-host-journal');

const BATCH_MAX_BYTES = 256 * 1024;
const SYNC_PAGE_BYTES = 512 * 1024;
const BULK_REMOVAL_ITEMS = 20;
const BOARD_COMMAND_LIMITS = Object.freeze({
  apply: Object.freeze({ limit: 60, windowMs: 60_000, maxKeys: 64 }),
  change: Object.freeze({ limit: 20, windowMs: 60_000, maxKeys: 64 }),
  read: Object.freeze({ limit: 120, windowMs: 60_000, maxKeys: 64 }),
  sync: Object.freeze({ limit: 240, windowMs: 60_000, maxKeys: 64 }),
  decide: Object.freeze({ limit: 60, windowMs: 60_000, maxKeys: 64 }),
  presence: Object.freeze({ limit: 120, windowMs: 60_000, maxKeys: 64 }),
  cursor: Object.freeze({ limit: 600, windowMs: 60_000, maxKeys: 256 }), // a device, not a member
});

const forbidden = () => hostFailure('forbidden', 'role_forbidden');
const unavailable = () => hostFailure('unavailable', 'team_board_unavailable', '', true);
const auditUnavailable = () => hostFailure('unavailable', 'team_audit_unavailable');
const notViewing = () => hostFailure('forbidden', 'team_board_not_viewing');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const opsOf = (batch) => (Array.isArray(batch?.ops) ? batch.ops.filter(isObject) : []);

// The conversation ids a batch would put on the board: a chat card added, and a card's data edited to name one
// (`card.edit` merges its data into the card's). A chat card with no usable id yields `undefined`, which no
// project holds.
function chatSessionsOf(batch) {
  const named = [];
  for (const op of opsOf(batch)) {
    const data = op.op === 'card.add' && isObject(op.card) ? op.card.data : op.data;
    const chatCard = op.op === 'card.add' && isObject(op.card) && op.card.kind === 'chat';
    if (chatCard || (isObject(data) && Object.hasOwn(data, 'session_id'))) named.push(isObject(data) ? data.session_id : undefined);
  }
  return named;
}

// null when every conversation the batch names is in the project, else the refusal. A resolver that throws
// or answers anything but this project's id refuses.
function chatCardRefusal(batch, projectId, sessionProject) {
  const inProject = (sessionId) => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    try { return sessionProject(sessionId) === projectId; } catch { return false; }
  };
  return chatSessionsOf(batch).every(inProject) ? null : hostFailure('forbidden', 'team_board_chat_outside_project');
}

// null, or the refusal of a batch that edits or removes a note another member holds. A lock is a courtesy between
// members, not an access rule: a presence store that cannot answer holds nothing.
function lockRefusal(batch, boardId, actor, presence) {
  for (const op of opsOf(batch)) {
    if ((op.op !== 'card.edit' && op.op !== 'card.remove') || typeof op.id !== 'string') continue;
    let holder;
    try { holder = presence.lockHolder(boardId, op.id); } catch { holder = null; }
    if (typeof holder === 'string' && holder && holder !== actor) {
      return { ...hostFailure('forbidden', 'team_board_note_locked'), held_by: holder };
    }
  }
  return null;
}

/** The rules of a batch on a team board: (batch, { projectId, boardId, actor }) -> null or the refusal. */
function batchRules({ sessionProject, presence = null } = {}) {
  if (typeof sessionProject !== 'function') throw new TypeError('batchRules requires sessionProject.');
  return (batch, { projectId, boardId, actor } = {}) => chatCardRefusal(batch, projectId, sessionProject)
    ?? (presence ? lockRefusal(batch, boardId, actor, presence) : null);
}

function batchBytes(batch) {
  try { return Buffer.byteLength(JSON.stringify(batch), 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
}

const boardOf = (params) => ({ projectId: params.project_id, boardId: params.board_id });
const entryFor = (kind, params, actor, detail = null) => ({ kind, project_id: params.project_id, board_id: params.board_id,
  actor_member_id: actor, detail });

// operation -> { limit: which limiter it spends, receipt: answered through the router's receipt, run(call),
// check(call): a rule of the operation's own, run inside the queue after the role checks }.
// `call` is { boards, params, actor (the live member id), deviceId, recheck, record(entry): writes one audit entry,
// answering null or the refusal }.
function operationsFor({ batchRefusal, presence, proposals, presenceOperations }) {
  const viewing = ({ params, deviceId }) => (presence && presence.projectOf(params.board_id) === params.project_id
    && presence.isViewing(params.board_id, deviceId) ? null : notViewing());
  const decide = (verb) => ({ limit: 'decide', check: viewing, run: ({ params, actor, recheck }) => proposals.decide({
    ...boardOf(params), proposalId: params.proposal_id, actor, recheck, ...(params.n === undefined ? {} : { n: params.n }),
    action: verb === 'accept' && params.n === undefined ? 'accept_additions' : verb }) });
  return Object.freeze({
    'team.board.list': { limit: 'read', run: ({ boards, params }) => boards.list({ projectId: params.project_id }) },
    'team.board.trash': { limit: 'read', run: ({ boards, params }) => boards.listDeleted({ projectId: params.project_id }) },
    'team.board.sync': { limit: 'sync', run: async ({ boards, params }) => {
      const page = await boards.since({ ...boardOf(params), afterRev: params.after_rev, maxBytes: SYNC_PAGE_BYTES });
      if (page?.ok !== true) return page;
      return page.snapshot === true ? { ok: true, rev: page.rev, snapshot: true }
        : { ok: true, rev: page.rev, batches: page.batches, more: page.more === true };
    } },
    // Slice T9: the journal as a list people can read (who, when, counts of operations); a reader's, like the board.
    'team.board.history': { limit: 'read', run: async ({ boards, params }) => {
      const read = await boards.history(boardOf(params));
      return read?.ok === true ? { ok: true, rev: read.rev, changes: read.changes } : read;
    } },
    'team.board.create': { limit: 'change', receipt: true, run: async ({ boards, params, actor, recheck }) => {
      const made = await boards.create({ projectId: params.project_id, actor, recheck, name: params.name });
      return made?.ok === true ? { ok: true, board: made.board } : made;
    } },
    'team.board.rename': { limit: 'change', receipt: true, run: async ({ boards, params, actor, recheck }) => {
      const renamed = await boards.rename({ ...boardOf(params), actor, recheck, name: params.name });
      return renamed?.ok === true ? { ok: true, rev: renamed.rev } : renamed;
    } },
    'team.board.apply': { limit: 'apply',
      check: ({ params, actor }) => batchRefusal(params.batch, { ...boardOf(params), actor }),
      run: async ({ boards, params, actor, recheck, record }) => {
        if (batchBytes(params.batch) > BATCH_MAX_BYTES) return hostFailure('limit', 'team_board_batch_limit');
        // An id only the host writes (a revert, an accepted proposal) is what the history reads a batch's kind from.
        if (isHostBatchId(params.batch?.batch_id)) return hostFailure('invalid', 'team_board_batch_id_reserved');
        const audit = (event) => (event?.kind === 'apply' && event.removed >= BULK_REMOVAL_ITEMS
          ? record(entryFor('board_bulk_removed', params, actor, { items: event.removed })) : null);
        const applied = await boards.apply({ ...boardOf(params), actor, recheck, audit, batch: params.batch });
        return applied?.ok === true
          ? { ok: true, rev: applied.rev, applied: applied.applied, duplicate: applied.duplicate === true } : applied;
      } },
    'team.board.delete': { limit: 'change', receipt: true, run: async ({ boards, params, actor, recheck, record }) => {
      const removed = await boards.remove({ ...boardOf(params), actor, recheck,
        audit: () => record(entryFor('board_deleted', params, actor)) });
      return removed?.ok === true ? { ok: true } : removed;
    } },
    'team.board.restore': { limit: 'change', receipt: true, run: async ({ boards, params, actor, recheck, record }) => {
      const restored = await boards.restore({ ...boardOf(params), actor, recheck,
        audit: () => record(entryFor('board_restored', params, actor)) });
      return restored?.ok === true ? { ok: true, board: restored.board } : restored;
    } },
    // The batch a revert would write is the journal's inverse of that rev: the batch rules are asked about it.
    // The answer is counts only (a receipt holds 4 KiB): the batch itself reaches every client as `team_board_changed`.
    'team.board.revert': { limit: 'change', receipt: true, run: async ({ boards, params, actor, recheck, record }) => {
      const found = await boards.journalEntry({ ...boardOf(params), rev: params.rev });
      if (found?.ok !== true) return found;
      const reverted = await boards.revert({ ...boardOf(params), actor, rev: params.rev,
        recheck: () => recheck() ?? batchRefusal(found.entry?.inverse, { ...boardOf(params), actor }),
        audit: () => record(entryFor('board_batch_reverted', params, actor, { rev: params.rev })) });
      return reverted?.ok === true ? { ok: true, rev: reverted.rev, reverted: reverted.applied?.ops?.length ?? 0,
        skipped: reverted.skipped.length } : reverted;
    } },
    ...(proposals ? {
      'team.board.proposal.list': { limit: 'read', run: ({ params, recheck }) => proposals.list({ ...boardOf(params), recheck }) },
      'team.board.proposal.accept': decide('accept'),
      'team.board.proposal.reject': decide('reject'),
    } : {}),
    ...(presenceOperations ?? {}),
  });
}

// The limiters of the operations that only read, and of those that act at once (presence).
const READS = new Set(['read', 'sync']);
const LIVE = new Set(['presence', 'cursor']);

// The answer with the request id on a refusal; a model refusal keeps its `board` words beside `error`.
function withRequestId(answer, requestId) {
  if (answer === null || typeof answer !== 'object') return unavailableFor(requestId);
  if (answer.ok === true) return answer;
  if (answer.ok !== false || answer.error === null || typeof answer.error !== 'object') return unavailableFor(requestId);
  return { ...answer, error: { ...answer.error, request_id: requestId } };
}
function unavailableFor(requestId) {
  return hostFailure('unavailable', 'team_board_unavailable', requestId, true);
}

/**
 * boards: the host board store (team-boards.js). directory: the member directory (liveActor). sessionProject(id):
 * the project a conversation is in, or null (the authorizer's own resolver). audit(entry): appends one project audit
 * entry, answering { ok }. presence: the presence store (board-presence.js), presenceOperations: its five operations
 * (board-presence-ops.js), proposals: board-proposals-host.js; without them their operations are not offered.
 * `limits` may replace a limiter's numbers (tests). Answers { handles(operation), dispatch(command, context,
 * { recheck, runReceipt }) }.
 */
function createTeamBoardCommands({ boards, directory, sessionProject, audit, presence = null, presenceOperations = null,
  proposals = null, clock = Date.now, logger = null, limits = {} } = {}) {
  if (!boards || typeof boards.apply !== 'function' || typeof boards.list !== 'function') {
    throw new TypeError('createTeamBoardCommands requires the board store.');
  }
  if (!directory || typeof directory.liveActor !== 'function') throw new TypeError('createTeamBoardCommands requires a directory.');
  if (typeof sessionProject !== 'function') throw new TypeError('createTeamBoardCommands requires sessionProject.');
  if (typeof audit !== 'function') throw new TypeError('createTeamBoardCommands requires audit().');
  const log = safeLogger(logger);
  const limiters = Object.fromEntries(Object.entries(BOARD_COMMAND_LIMITS)
    .map(([name, numbers]) => [name, createRateLimiter({ ...numbers, ...(limits[name] ?? {}), clock })]));
  const operations = operationsFor({ batchRefusal: batchRules({ sessionProject, presence }), presence, proposals, presenceOperations });

  const handles = (operation) => typeof operation === 'string' && Object.hasOwn(operations, operation);

  // The caller as the directory has them now: an active member, or null.
  function liveMember(context) {
    const live = directory.liveActor(context?.deviceId);
    return live && typeof live.member_id === 'string' && live.member_id && live.state === 'active' ? live : null;
  }

  // null once the entry is in the project audit, else the refusal.
  function record(entry) {
    let written;
    try { written = audit(entry); } catch { written = null; }
    return written?.ok === true ? null : auditUnavailable();
  }

  async function answer(command, context, { recheck, runReceipt }) {
    const entry = operations[command.operation];
    const live = liveMember(context);
    if (!live || typeof recheck !== 'function') return forbidden();
    if (entry.receipt && typeof runReceipt !== 'function') return unavailable();
    if (limiters[entry.limit].take(entry.limit === 'cursor' ? context.deviceId : live.member_id) !== true) {
      return hostFailure('limit', 'team_board_rate_limit');
    }
    const call = { boards, params: command.params, actor: live.member_id, deviceId: context.deviceId, record };
    // Run by the store inside the board's queue, before its first write: the router's check, then the same member,
    // then the operation's own rule.
    const again = () => {
      const denied = recheck();
      if (denied !== null && denied !== undefined) return denied;
      if (liveMember(context)?.member_id !== live.member_id) return forbidden();
      return entry.check ? entry.check(call) : null;
    };
    const run = async () => {
      if (LIVE.has(entry.limit)) {
        // No queue: the checks first, and once more after the one read a presence operation makes of the store.
        const early = again();
        if (early !== null && early !== undefined) return withRequestId(early, command.request_id);
        call.boards = { get: async (args) => { const got = await boards.get(args); return again() ?? got; } };
      }
      const result = await entry.run({ ...call, recheck: again });
      // A read took no queue: the same check once more before its answer leaves.
      const late = READS.has(entry.limit) && result?.ok === true ? again() : null;
      return withRequestId(late !== null && late !== undefined ? late : result, command.request_id);
    };
    return entry.receipt ? runReceipt(command, context, run) : run();
  }

  async function dispatch(command, context, options = {}) {
    const requestId = command?.request_id;
    if (!handles(command?.operation)) return hostFailure('invalid', 'unsupported_operation', requestId);
    const entry = operations[command.operation];
    let result;
    try {
      result = withRequestId(await answer(command, context, options ?? {}), requestId);
    } catch {
      result = unavailableFor(requestId);
    }
    // A batch, a read or a presence call that went through is not logged (hundreds a minute a member); a list
    // change, a proposal decision and every refusal but a cursor's are.
    if (entry.limit !== 'cursor' && (result.ok !== true || entry.receipt || entry.limit === 'decide')) {
      log('INFO', 'team_board.command_answered', { operation: command.operation, ok: result.ok === true,
        ...(result.ok === true ? {} : { reason: result.error?.reason }) });
    }
    return result;
  }

  return Object.freeze({ dispatch, handles });
}

module.exports = { BATCH_MAX_BYTES, BOARD_COMMAND_LIMITS, BULK_REMOVAL_ITEMS, SYNC_PAGE_BYTES, batchRules, chatCardRefusal,
  createTeamBoardCommands };
