'use strict';

// Team boards T5 (row 151, plan PROJECT_BOARD_2026-11-13 sections 8.5 and 8.6): Jenny's proposed changes to a
// team board, on the host.
//
// The proposal rules are the desktop's own (services/boards/board-proposals.js: how a reply's `board` block is
// read, what "accept additions", "accept one" and "reject" do, when a change is skipped, how room is made). This
// module runs that code against the host's board store for one call at a time, and adds what a team needs:
//
//   - A proposal lives only on a board of the conversation's own project. The caller gives (project, board); a
//     board id from another project reads as not found in the store.
//   - Every accepted change goes through the store's `apply`: the acting member is the one who accepted, the
//     caller's check runs again inside the board's queue, and the rules of a batch on a team board (the chat card
//     rule and the note locks, board-commands.js `batchRules`) are checked on the operations.
//   - One decision wins. Each board's proposal calls run one after another here, and each reads the stored
//     state first: a change that is no longer pending answers `team_board_proposal_closed`.
//   - Audit first (D16 on a team board: every edit and every removal is its own accept, so its own entry). The
//     entry is written inside the board's queue, once the change is known to apply and before the first write of
//     the decision. One decision writes one entry. When the audit cannot be written the decision is refused.
//   - Each stored proposal names the member whose turn produced it (`prompter_member_id`), for the audit.
//   - No Full auto: there is no path here that applies a proposal without a member's decision.
//   - A decision's batch has one id, made from the proposal and the pending changes the decision covers. When the
//     board took the batch and the list could not be written (`team_board.proposals_behind`), the change is still
//     offered; the same decision made again is answered by the board's journal as a duplicate while it holds the
//     batch (200 batches), so nothing is applied a second time, and the list is written then.
//
// A `file` line in a proposal is refused on a team board for now (nothing here resolves a project file).
// Logs carry a reason word only.

const { createHash } = require('node:crypto');

const { createBoardProposals } = require('../../../services/boards/board-proposals');
const model = require('../../../services/boards/board-model');
const { hostFailure } = require('../../api-contract');
const { isId, isSessionId } = require('../ids');
const { safeLogger } = require('../safe-logger');
const { answers } = require('./board-host-load');

const ACTIONS = Object.freeze(['accept_additions', 'accept', 'reject']);
const PROPOSAL_ID_MAX = 500;
// Room kept under the store's byte bound for the one field this module adds to a proposal.
const PROMPTER_ROOM = 256;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = () => hostFailure('conflict', 'team_board_proposal_closed');
const auditUnavailable = () => hostFailure('unavailable', 'team_audit_unavailable');

function fits(list) {
  if (!Array.isArray(list) || list.length > model.LIMITS.proposals) return false;
  try {
    return Buffer.byteLength(JSON.stringify(list), 'utf8') <= model.LIMITS.proposals_bytes - PROMPTER_ROOM;
  } catch {
    return false;
  }
}

// The desktop module's reason word as this host's refusal.
function refusalFor(reason) {
  switch (reason) {
    case 'not_found': return answers.NOT_FOUND();
    case 'read_only': return answers.READ_ONLY();
    case 'io': return answers.UNAVAILABLE();
    case 'closed':
    case 'nothing_pending':
    case 'invalid': return closed();
    case 'additions_first': return hostFailure('conflict', 'team_board_proposal_additions_first');
    default: return { ...hostFailure('conflict', 'team_board_refused'),
      board: { reason: typeof reason === 'string' ? reason : 'invalid', detail: null, limit: null, index: null } };
  }
}

// How many pending changes a decision covers; 0 means it has nothing left to decide.
function covered(proposal, action, n) {
  const pending = (Array.isArray(proposal.changes) ? proposal.changes : []).filter((change) => isObject(change) && change.state === 'pending');
  if (action === 'accept_additions') return pending.filter((change) => change.class === 'addition').length;
  if (action === 'accept') return pending.filter((change) => change.n === n && change.class !== 'addition').length;
  return n === undefined ? pending.length : pending.filter((change) => change.n === n).length;
}

// The one batch id of an accept: the board, the proposal, and the pending changes the decision covers.
function decisionBatchId(boardId, proposal, action, n) {
  const pending = (Array.isArray(proposal.changes) ? proposal.changes : []).filter((change) => isObject(change) && change.state === 'pending'
    && (action === 'accept_additions' ? change.class === 'addition' : change.n === n)).map((change) => change.n);
  return `proposal-${createHash('sha256').update(JSON.stringify([boardId, proposal.id, action, pending])).digest('hex').slice(0, 40)}`;
}

/**
 * boards: the host board store. audit(entry): appends one project audit entry, answering { ok }.
 * batchRefusal(batch, { projectId, boardId, actor }): board-commands.js's rule, null or the refusal.
 * announce(projectId, boardId): tells the project's members that the board's proposals changed.
 * Answers { record, list, decide }.
 */
function createHostProposals({ boards, audit, batchRefusal, announce = () => {}, clock = Date.now,
  makeId = () => require('node:crypto').randomUUID(), logger = null } = {}) {
  if (!boards || typeof boards.readProposals !== 'function' || typeof boards.writeProposals !== 'function') {
    throw new TypeError('createHostProposals requires the board store.');
  }
  if (typeof audit !== 'function' || typeof batchRefusal !== 'function') {
    throw new TypeError('createHostProposals requires audit() and the batch rule.');
  }
  const log = safeLogger(logger);
  const tails = new Map(); // project/board -> the promise of its last call

  function inLine(projectId, boardId, work) {
    const key = `${projectId}/${boardId}`;
    const run = (tails.get(key) || Promise.resolve()).then(work, work);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run.catch(() => { log('WARN', 'team_board.proposals_failed', {}); return answers.UNAVAILABLE(); });
  }

  // One call of the desktop module against the host's store. `scope`: { projectId, boardId, actor, recheck,
  // applyAudit, writeAudit, onApply, batchId }. Answers { refusal } or { result, stored } (the list as it is stored after the
  // call). `onApply(changes)` hears how many of the proposal's changes a batch carries, before the store is asked.
  // Once the board took the call's batch, the list is written without the caller's check (the decision it records
  // has been made and is on the board) and tried twice: a list left behind would offer the same change again.
  async function runLocal(scope, work) {
    const { projectId, boardId, actor, recheck } = scope;
    let landed = false;
    const read = await boards.readProposals({ projectId, boardId });
    if (read?.ok !== true) return { refusal: isObject(read?.error) ? read : answers.UNAVAILABLE() };
    const held = read.proposals;
    let next = null;
    let hostRefusal = null;
    const store = {
      readProposals: () => ({ status: 'ok', value: held }),
      writeProposals: (_boardId, list) => {
        if (!fits(list)) throw Object.assign(new Error('proposals do not fit'), { code: 'proposals_limit' });
        next = list;
      },
    };
    const service = {
      get: async () => {
        const got = await boards.get({ projectId, boardId });
        return got?.ok === true ? { ok: true, board: got.board, readOnly: got.read_only === true } : { ok: false, reason: 'not_found' };
      },
      apply: async ({ batch: made }, carries) => {
        if (typeof scope.onApply === 'function') scope.onApply(carries?.changes);
        const batch = scope.batchId ? { ...made, batch_id: scope.batchId } : made;
        const check = () => {
          const denied = typeof recheck === 'function' ? recheck() : null;
          return denied !== null && denied !== undefined ? denied : batchRefusal(batch, { projectId, boardId, actor });
        };
        const out = await boards.apply({ projectId, boardId, actor, recheck: check, audit: scope.applyAudit, batch });
        if (out?.ok === true) { landed = true; return { ok: true, undoable: false }; }
        // The model's refusal is the desktop module's to read (a change that is gone or was changed is skipped).
        if (out?.error?.reason === 'team_board_refused' && isObject(out.board)) {
          return { ok: false, reason: out.board.reason, ...(out.board.limit ? { limit: out.board.limit } : {}) };
        }
        hostRefusal = isObject(out?.error) ? out : answers.UNAVAILABLE();
        return { ok: false, reason: 'host' };
      },
      emit: () => {},
    };
    const local = createBoardProposals({ service, store, now: () => new Date(clock()), makeId });
    const result = await work(local, () => next);
    if (hostRefusal) return { refusal: hostRefusal };
    if (!result || result.ok !== true) return { refusal: refusalFor(result?.reason) };
    if (next !== null) {
      const write = () => boards.writeProposals({ projectId, boardId, actor, recheck: landed ? null : recheck,
        audit: scope.writeAudit, proposals: next });
      let wrote = await write();
      if (wrote?.ok !== true && landed) wrote = await write();
      if (wrote?.ok !== true) {
        if (landed) log('WARN', 'team_board.proposals_behind', { project_id: projectId, board_id: boardId });
        return { refusal: isObject(wrote?.error) ? wrote : answers.UNAVAILABLE() };
      }
      try { announce(projectId, boardId); } catch { /* the announcement is best effort */ }
    }
    return { result, stored: next ?? held };
  }

  const withPrompter = (proposal, stored) => {
    const prompter = stored.find((entry) => isObject(entry) && entry.id === proposal.id)?.prompter_member_id;
    return { ...proposal, prompterMemberId: isId('member', prompter) ? prompter : null };
  };

  /**
   * The reply of a completed turn, read once. `prompter` is the member who sent the turn; a turn with no member
   * author stores nothing. Answers as the desktop's `record`: { ok, proposal (or null), duplicate? }.
   */
  function record({ projectId, boardId, sessionId, messageId, text, sentWhole, prompter } = {}) {
    if (!isId('member', prompter) || !isSessionId(sessionId)) return Promise.resolve({ ok: false, reason: 'invalid' });
    return inLine(projectId, boardId, async () => {
      const ran = await runLocal({ projectId, boardId, actor: prompter }, async (local, written) => {
        const out = await local.record({ boardId, sessionId, messageId, text, sentWhole });
        if (out?.ok === true && out.proposal && out.duplicate !== true) {
          const fresh = (written() ?? []).find((entry) => entry.id === out.proposal.id);
          if (fresh) fresh.prompter_member_id = prompter;
        }
        return out;
      });
      if (ran.refusal) return { ok: false, reason: ran.refusal.error?.reason ?? 'io' };
      return ran.result.proposal ? { ...ran.result, proposal: withPrompter(ran.result.proposal, ran.stored) } : ran.result;
    });
  }

  /** { ok, proposals } newest first, as the desktop lists them, each with `prompterMemberId`. */
  function list({ projectId, boardId } = {}) {
    return inLine(projectId, boardId, async () => {
      const ran = await runLocal({ projectId, boardId }, (local) => local.list({ boardId }));
      if (ran.refusal) return ran.refusal;
      return { ok: true, proposals: ran.result.proposals.map((proposal) => withPrompter(proposal, ran.stored)) };
    });
  }

  /**
   * One member's decision. `actor` is the caller's live member id and `recheck` the caller's check, run again
   * inside the board's queue before each write. Answers { ok, proposal, applied, skipped } or the refusal.
   */
  function decide({ projectId, boardId, proposalId, action, n, actor, recheck } = {}) {
    if (typeof proposalId !== 'string' || !proposalId || proposalId.length > PROPOSAL_ID_MAX || !ACTIONS.includes(action)
      || (n !== undefined && !(Number.isSafeInteger(n) && n > 0)) || (action === 'accept' && n === undefined)
      || (action === 'accept_additions' && n !== undefined)) return Promise.resolve(answers.INVALID());
    if (!isId('member', actor) || typeof recheck !== 'function') return Promise.resolve(hostFailure('forbidden', 'role_forbidden'));
    return inLine(projectId, boardId, async () => {
      const before = await boards.readProposals({ projectId, boardId });
      if (before?.ok !== true) return isObject(before?.error) ? before : answers.UNAVAILABLE();
      const stored = before.proposals.find((entry) => isObject(entry) && entry.id === proposalId);
      if (!stored) return hostFailure('forbidden', 'team_board_proposal_not_found');
      const count = covered(stored, action, n);
      if (count === 0 || stored.state === 'superseded') return closed();
      if (!isId('member', stored.prompter_member_id) || !isSessionId(stored.session_id)) {
        return hostFailure('conflict', 'team_board_prompter_unknown');
      }
      // What the entry counts: the pending changes the decision covers, or fewer when the batch carries fewer
      // (an addition whose target went is skipped, not accepted).
      let carried = count;
      const entry = () => ({ kind: action === 'reject' ? 'board_proposal_rejected' : 'board_proposal_accepted', project_id: projectId,
        session_id: stored.session_id, board_id: boardId, actor_member_id: actor, prompter_member_id: stored.prompter_member_id,
        detail: { change: n ?? 0, count: carried } });
      let written = false;
      const auditOnce = () => {
        if (written) return null;
        let out;
        try { out = audit(entry()); } catch { out = null; }
        if (out?.ok !== true) return auditUnavailable();
        written = true;
        return null;
      };
      // An accept is recorded when its change is about to be written to the board, a reject when the proposal is.
      // An accept the board no longer takes (the item is gone or was changed) is skipped and writes no entry.
      const accepts = action !== 'reject';
      const onApply = (changes) => { if (Number.isSafeInteger(changes) && changes > 0 && changes < carried) carried = changes; };
      const ran = await runLocal({ projectId, boardId, actor, recheck, onApply, applyAudit: accepts ? auditOnce : null,
        writeAudit: accepts ? null : auditOnce, batchId: accepts ? decisionBatchId(boardId, stored, action, n) : null }, (local) => local.decide({ boardId, proposalId, action, ...(n === undefined ? {} : { n }) }));
      if (ran.refusal) return ran.refusal;
      return { ok: true, proposal: withPrompter(ran.result.proposal, ran.stored), applied: ran.result.applied, skipped: ran.result.skipped };
    });
  }

  return Object.freeze({ record, list, decide, resources: () => ({ lines: tails.size }) });
}

module.exports = { PROPOSAL_ACTIONS: ACTIONS, createHostProposals };
