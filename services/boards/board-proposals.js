'use strict';

/**
 * services/boards/board-proposals.js: Jenny's proposed board changes, stored per board and decided by a
 * person (plan PROJECT_BOARD_2026-11-13 section 7.5; slice C3). A friend module of board-service.js.
 *
 *   createBoardProposals({ service, store, getFiles, now, makeId, logger }) -> { record, list, decide, applyAuto }
 *
 *   record({ boardId, sessionId, messageId, text, sentWhole })
 *       reads the reply's closed `board` blocks once (board-proposal-reader.js), tries the additions on
 *       the model so a change the model refuses is kept as refused, and stores the proposal with id
 *       `<session>:<message>:1`. Recording the same reply again changes nothing. Earlier open proposals
 *       from the same chat become `superseded`. A reply with no block stores nothing.
 *   list({ boardId })
 *       { ok, proposals } newest first, each without its operations; the newest open one carries
 *       `preview`: where its new cards, groups and connections would land on the board as it stands.
 *   decide({ boardId, proposalId, action, n })
 *       accept_additions  every pending addition as ONE batch (one Undo step)
 *       accept            the edit or removal numbered `n`, as its own batch (D16)
 *       reject            the pending change numbered `n`; without `n`, every pending change
 *       A change whose target went or was changed since the proposal was made is skipped and says so.
 *   applyAuto({ boardId, proposalId })
 *       Full auto (slice C4): accept_additions without a person, for the turn hook only (no bridge call
 *       reaches it). The proposal keeps `auto: { applied, batch_id }`, so the page can say what Jenny did
 *       and offer Undo while that batch is still the board's newest change. Edits and removals wait (D16).
 *
 * A proposal changes a board only through `service.apply`, so the model, the journal and the board's
 * `changed` events are the ones every other edit uses. This module owns one file per board
 * (`<board>.proposals.json`, at most 20 proposals and 512 KiB, enforced by the store); when a new
 * proposal does not fit, closed proposals go first, oldest first, then the new one loses lines from
 * its end. Each board's calls run one after another.
 */

const fence = require('./board-fence');
const ids = require('./board-ids');
const model = require('./board-model');
const reader = require('./board-proposal-reader');
const { planAdditions, checkTarget, reasonOf } = require('./board-proposal-apply');

const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_FILE_CHECKS = 40;
const ACTIONS = new Set(['accept_additions', 'accept', 'reject']);
const OPEN_STATES = new Set(['pending', 'partly_accepted']);

function fail(reason) { return { ok: false, reason }; }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function countsOf(proposal) {
  const counts = { total: proposal.changes.length, pending: 0, additions: 0, edits: 0, removals: 0, applied: 0, refused: 0, skipped: 0, rejected: 0 };
  for (const change of proposal.changes) {
    if (change.state === 'pending') {
      counts.pending++;
      if (change.class === 'addition') counts.additions++; else if (change.class === 'edit') counts.edits++; else counts.removals++;
    } else if (hasCount(counts, change.state)) counts[change.state]++;
  }
  return counts;
}
function hasCount(counts, state) { return state === 'applied' || state === 'refused' || state === 'skipped' || state === 'rejected'; }

/** Open: there is something left for a person to decide (or, when every line was refused, to look at and dismiss). */
function isOpen(proposal) {
  if (!OPEN_STATES.has(proposal.state)) return false;
  return proposal.state === 'pending' || proposal.changes.some((change) => change.state === 'pending');
}

function settle(proposal) {
  if (proposal.state === 'superseded') return;
  const counts = countsOf(proposal);
  if (counts.pending > 0) proposal.state = counts.applied > 0 ? 'partly_accepted' : 'pending';
  else if (counts.applied === 0) proposal.state = 'rejected';
  else proposal.state = counts.rejected > 0 ? 'partly_accepted' : 'accepted';
}

function publicProposal(proposal) {
  return {
    id: proposal.id, sessionId: proposal.session_id, messageId: proposal.message_id, state: proposal.state, open: isOpen(proposal),
    createdAt: proposal.created_at, madeAgainstRev: proposal.made_against_rev, overflow: proposal.overflow || 0, counts: countsOf(proposal),
    auto: isObj(proposal.auto) && Number.isInteger(proposal.auto.applied) ? { applied: proposal.auto.applied, batchId: String(proposal.auto.batch_id || '') } : null,
    changes: proposal.changes.map((change) => ({ n: change.n, line: change.line, type: change.type, class: change.class,
      state: change.state, reason: change.reason || '', summary: change.summary || {} })),
    preview: null,
  };
}

function createBoardProposals(options = {}) {
  const { service, store } = options;
  const getFiles = typeof options.getFiles === 'function' ? options.getFiles : () => null;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const makeId = typeof options.makeId === 'function' ? options.makeId : () => require('node:crypto').randomUUID();
  const log = typeof options.logger === 'function' ? options.logger : () => {};
  const tails = new Map(); // board id -> the promise of its last call

  function serial(boardId, work) {
    const run = (tails.get(boardId) || Promise.resolve()).then(work, work);
    const tail = run.catch(() => {});
    tails.set(boardId, tail);
    void tail.then(() => { if (tails.get(boardId) === tail) tails.delete(boardId); });
    return run.catch((error) => { log('WARN', 'boards.proposals_failed', { code: error && error.code ? String(error.code) : 'unknown' }); return fail('io'); });
  }

  function readAll(boardId) {
    let read;
    try { read = store.readProposals(boardId); } catch (_error) { return []; }
    const list = read && read.status === 'ok' && Array.isArray(read.value) ? read.value : [];
    return list.filter((p) => isObj(p) && typeof p.id === 'string' && Array.isArray(p.changes));
  }

  /** Writes the list, making room as the header says. `fresh` is the proposal that may lose lines. */
  function writeAll(boardId, list, fresh) {
    let keep = list.slice();
    for (;;) {
      try { store.writeProposals(boardId, keep); return keep; } catch (error) {
        if (!error || error.code !== 'proposals_limit') throw error;
      }
      const closed = keep.findIndex((p) => p !== fresh && !isOpen(p));
      const other = closed >= 0 ? closed : keep.findIndex((p) => p !== fresh);
      if (other >= 0) { keep = keep.filter((_, i) => i !== other); continue; }
      if (!fresh || !fresh.changes.length) throw Object.assign(new Error('proposals do not fit'), { code: 'proposals_limit' });
      fresh.changes.pop();
      fresh.overflow = (fresh.overflow || 0) + 1;
    }
  }

  async function boardOf(boardId) {
    if (!ids.isBoardId(boardId)) return { failure: fail('invalid') };
    const got = await service.get({ boardId });
    if (!got || got.ok !== true) return { failure: fail(got && typeof got.reason === 'string' ? got.reason : 'not_found') };
    if (got.readOnly || !got.board) return { failure: fail('read_only') };
    return { board: got.board };
  }

  function announce(board) {
    try { service.emit('changed', { boardId: board.id, projectId: board.project_id, kind: 'proposals', rev: board.rev }); } catch (_error) { /* a listener's fault */ }
  }

  function context() { return { now: now().toISOString(), makeId }; }

  /* ---------------------------------------------------------------- record */

  async function checkFiles(boardId, bodies) {
    const out = new Map();
    const files = getFiles();
    for (const path of reader.filePaths(bodies).slice(0, MAX_FILE_CHECKS)) {
      let result;
      try { result = files ? await files.resolveFile({ boardId, path }) : null; } catch (_error) { result = null; }
      out.set(path, result || fail('unavailable'));
    }
    return out;
  }

  /** Marks what the model refuses today as refused, so the line is shown with its reason from the start. */
  function refuseEarly(board, changes) {
    const pending = changes.filter((change) => change.state === 'pending');
    const plan = planAdditions(board, pending.filter((change) => change.class === 'addition'), context());
    const reasons = new Map(plan.skipped.map((s) => [s.n, s.reason]));
    for (const change of pending) {
      let reason = reasons.get(change.n) || null;
      if (change.move || change.tidy) { // tried on the board the additions lead to: its group may be one of them
        const alone = planAdditions(plan.board, [change], context());
        if (alone.skipped.length) reason = alone.skipped[0].reason;
      } else if (change.class !== 'addition' && Array.isArray(change.ops) && change.type !== 'remove') {
        const tried = model.applyBatch(board, { batch_id: `try-${makeId()}`, board_id: board.id, actor: 'owner', ops: change.ops }, { now: now().toISOString(), authority: true });
        if (!tried.ok) reason = reasonOf(tried);
      }
      if (reason) { change.state = 'refused'; change.reason = reason; }
    }
  }

  function record(raw) {
    const args = isObj(raw) ? raw : {};
    if (!ids.isBoardId(args.boardId) || !TOKEN_RE.test(String(args.sessionId || '')) || !TOKEN_RE.test(String(args.messageId || ''))
      || typeof args.text !== 'string' || args.text.length > MAX_TEXT_CHARS) return Promise.resolve(fail('invalid'));
    const bodies = fence.boardBlockBodies(args.text);
    if (!bodies.length) return Promise.resolve({ ok: true, proposal: null });
    return serial(args.boardId, async () => {
      const opened = await boardOf(args.boardId);
      if (opened.failure) return opened.failure;
      const board = opened.board;
      const id = `${args.sessionId}:${args.messageId}:1`;
      const all = readAll(board.id);
      const known = all.find((p) => p.id === id);
      if (known) return { ok: true, proposal: publicProposal(known), duplicate: true };
      const read = reader.readProposal({ board, bodies, sketches: fence.sketchBlocks(args.text), makeId,
        sentWhole: Array.isArray(args.sentWhole) ? args.sentWhole : [], files: await checkFiles(board.id, bodies) });
      if (!read.changes.length) return { ok: true, proposal: null };
      refuseEarly(board, read.changes);
      const proposal = { id, session_id: args.sessionId, message_id: args.messageId, created_at: now().toISOString(),
        made_against_rev: board.rev, state: 'pending', overflow: read.overflow, changes: read.changes };
      for (const earlier of all) if (earlier.session_id === args.sessionId && isOpen(earlier)) earlier.state = 'superseded';
      writeAll(board.id, all.concat([proposal]), proposal);
      announce(board);
      return { ok: true, proposal: publicProposal(proposal) };
    });
  }

  /* ---------------------------------------------------------------- list */

  function previewOf(board, proposal) {
    const additions = proposal.changes.filter((change) => change.state === 'pending' && change.class === 'addition');
    if (!additions.length) return null;
    const plan = planAdditions(board, additions, context());
    const applied = new Set(plan.applied);
    const preview = { cards: [], groups: [], connectors: [] };
    const box = (card) => (card ? { x: card.x, y: card.y, w: card.w, h: card.h } : null);
    for (const change of additions) {
      const op = applied.has(change.n) && Array.isArray(change.ops) ? change.ops[0] : null;
      if (op && op.op === 'card.add') {
        const card = plan.board.cards[op.card.id];
        if (card) preview.cards.push({ n: change.n, kind: card.kind, x: card.x, y: card.y, w: card.w, h: card.h, groupId: card.group_id || '' });
      } else if (op && op.op === 'group.add') {
        const group = plan.board.groups[op.group.id];
        if (group) preview.groups.push({ n: change.n, id: group.id, x: group.x, y: group.y, w: group.w, h: group.h });
      } else if (op && op.op === 'connector.add') {
        const con = plan.board.connectors[op.connector.id];
        const from = con ? box(plan.board.cards[con.from]) : null;
        const to = con ? box(plan.board.cards[con.to]) : null;
        if (from && to) preview.connectors.push({ n: change.n, from, to, label: con.label || '', style: con.style, ends: con.ends });
      }
    }
    return preview;
  }

  function list(raw) {
    const boardId = isObj(raw) ? raw.boardId : null;
    if (!ids.isBoardId(boardId)) return Promise.resolve(fail('invalid'));
    return serial(boardId, async () => {
      const opened = await boardOf(boardId);
      if (opened.failure) return opened.failure;
      const all = readAll(boardId).slice().reverse();
      const proposals = all.map(publicProposal);
      const newest = all.findIndex(isOpen);
      if (newest >= 0) proposals[newest].preview = previewOf(opened.board, all[newest]);
      return { ok: true, proposals };
    });
  }

  /* ---------------------------------------------------------------- decide */

  // `changes`: how many of the proposal's changes the batch carries (the team host's audit entry says it).
  async function applyOps(board, ops, batchId = `proposal-${makeId()}`, changes = 1) {
    return service.apply({ boardId: board.id, batch: { batch_id: batchId, board_id: board.id, ops } }, { changes });
  }

  async function acceptAdditions(board, proposal) {
    const additions = proposal.changes.filter((change) => change.state === 'pending' && change.class === 'addition');
    if (!additions.length) return fail('nothing_pending');
    const plan = planAdditions(board, additions, context());
    let batchId = `proposal-${makeId()}`;
    if (plan.ops.length) {
      const outcome = await applyOps(board, plan.ops, batchId, plan.applied.length);
      if (!outcome || outcome.ok !== true) return fail(outcome && typeof outcome.reason === 'string' ? outcome.reason : 'io');
      if (outcome.undoable === false) batchId = ''; // no undo step was kept: nobody may offer Undo for this batch
    }
    const applied = new Set(plan.applied);
    const skipped = new Map(plan.skipped.map((s) => [s.n, s.reason]));
    for (const change of additions) {
      if (applied.has(change.n)) change.state = 'applied';
      else { change.state = 'skipped'; change.reason = skipped.get(change.n) || 'gone'; }
    }
    return { ok: true, applied: applied.size, skipped: additions.length - applied.size, batchId: plan.ops.length ? batchId : '' };
  }

  /** A move or a tidy: planned against the board as it is now, applied as its own batch (one Undo step). */
  async function acceptPlaced(board, change, proposal) {
    const plan = planAdditions(board, [change], context());
    if (plan.skipped.length) {
      const groupId = change.move ? change.move.group_id : change.tidy.group_id;
      const waits = proposal.changes.some((other) => other.state === 'pending' && other.class === 'addition' && Array.isArray(other.ops)
        && other.ops[0] && other.ops[0].op === 'group.add' && other.ops[0].group.id === groupId);
      if (waits) return fail('additions_first'); // its group is one of this proposal's additions, not accepted yet
      change.state = 'skipped';
      change.reason = plan.skipped[0].reason;
      return { ok: true, applied: 0, skipped: 1 };
    }
    if (plan.ops.length) {
      const outcome = await applyOps(board, plan.ops);
      if (!outcome || outcome.ok !== true) return fail(reasonOf(outcome));
    }
    change.state = 'applied';
    return { ok: true, applied: 1, skipped: 0 };
  }

  async function acceptOne(board, change, proposal) {
    if (!change || change.state !== 'pending' || change.class === 'addition') return fail('invalid');
    if (change.move || change.tidy) return acceptPlaced(board, change, proposal);
    if (!Array.isArray(change.ops)) return fail('invalid');
    const stale = checkTarget(board, change);
    if (stale) { change.state = 'skipped'; change.reason = stale; return { ok: true, applied: 0, skipped: 1 }; }
    const outcome = await applyOps(board, change.ops);
    if (outcome && outcome.ok === true) { change.state = 'applied'; return { ok: true, applied: 1, skipped: 0 }; }
    const reason = reasonOf(outcome);
    if (reason !== 'gone' && reason !== 'changed') return fail(reason);
    change.state = 'skipped';
    change.reason = reason;
    return { ok: true, applied: 0, skipped: 1 };
  }

  const decide = (raw) => decideAs(raw, false);
  const applyAuto = (raw) => decideAs({ boardId: isObj(raw) ? raw.boardId : null, proposalId: isObj(raw) ? raw.proposalId : null, action: 'accept_additions' }, true);

  function decideAs(raw, auto) {
    const args = isObj(raw) ? raw : {};
    if (!ids.isBoardId(args.boardId) || typeof args.proposalId !== 'string' || args.proposalId.length > 500 || !ACTIONS.has(args.action)
      || (args.n !== undefined && !(Number.isInteger(args.n) && args.n > 0))) return Promise.resolve(fail('invalid'));
    return serial(args.boardId, async () => {
      const opened = await boardOf(args.boardId);
      if (opened.failure) return opened.failure;
      const all = readAll(args.boardId);
      const proposal = all.find((p) => p.id === args.proposalId);
      if (!proposal) return fail('not_found');
      if (!isOpen(proposal)) return fail('closed');
      let result;
      if (args.action === 'accept_additions') result = await acceptAdditions(opened.board, proposal);
      else if (args.action === 'accept') result = await acceptOne(opened.board, proposal.changes.find((change) => change.n === args.n), proposal);
      else {
        const targets = proposal.changes.filter((change) => change.state === 'pending' && (args.n === undefined || change.n === args.n));
        if (args.n !== undefined && !targets.length) return fail('invalid');
        targets.forEach((change) => { change.state = 'rejected'; });
        result = { ok: true, applied: 0, skipped: 0 };
      }
      if (!result.ok) return result;
      if (auto && result.applied > 0) proposal.auto = { applied: result.applied, batch_id: result.batchId };
      settle(proposal);
      writeAll(args.boardId, all, null);
      const after = await boardOf(args.boardId);
      announce(after.board || opened.board);
      return { ok: true, proposal: publicProposal(proposal), applied: result.applied, skipped: result.skipped };
    });
  }

  return Object.freeze({ record, list, decide, applyAuto });
}

module.exports = { createBoardProposals, publicProposal, isOpen };
