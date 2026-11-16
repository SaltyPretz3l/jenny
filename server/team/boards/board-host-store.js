'use strict';

// Team boards T1 (row 151, plan PROJECT_BOARD_2026-11-13 sections 8.1 to 8.3, D1, D16, D28, D29): the team host's
// board store over board-host-files.js; its memory and loads from disk are board-host-load.js. Every board rule comes
// from services/boards/board-model.js unchanged.
//
// - A board is addressed by (project id, board id), never by board id alone. An unknown project, an unknown board,
//   a board of another project, a board in the trash and a malformed id are one answer: team_board_not_found.
// - One board is one serialized queue; create, remove, restore and removeProject also serialize on the project.
//   `recheck` (the caller's authorization, slice T2) runs inside the queue; a check that answers at once is read in
//   the same stretch as everything after it up to the last write, so nothing changes between the check and the
//   writes (only a check that answers a promise is waited for). All checks run before the caller's audit and the
//   first write; once the document has landed the answer is success.
// - apply writes the document, then the journal, then the index. A journal or index write that fails after the
//   document landed is logged and the memory of that board (or project) is dropped: the next load raises the
//   journal's floor (since answers snapshot for the missing range) and repairs the index from the document.
// - A document that fails normalizeBoard, names another project, or has a newer schema is read-only: never
//   rewritten or removed (except by removeProject). A newer index makes the project unavailable and is never
//   rewritten; a missing or damaged one is rebuilt from the documents on disk.
// - The storage cap counts every index entry's `bytes`, trash included; a write that would grow the total past it
//   is refused before anything is written. A project holds at most idx.ENTRIES_MAX boards, live and in the trash
//   together, so its index stays under its file cap whatever a rename or a delete adds; the trash alone holds at
//   most `limits.trash`, which leaves room for every live board, so a delete is what a full trash refuses
//   (team_board_trash_limit) and never a create. A batch whose way back the
//   journal cannot keep is refused (limit `journal_bytes`): what an admin may revert is every batch in the journal.
//   A deleted board is kept 7 days, then removed by `sweep` (board-host-sweep.js, scheduled by the caller).
// - removeProject waits for the project's queues, then removes the folder without following a link; a write, a
//   read of one board or a create that arrives after it answers not found, `list` answers no boards and `usage`
//   zeros (the project's folder is never recreated in this process).
// - Logs carry ids, counts and reason words only.
// - assetRefs (slice T6) reads every board file of a project from disk, live and in the trash, and hands the
//   pictures they name to the caller's `use` in the same synchronous stretch; it writes nothing.

const { collectAssetRefs } = require('../../../services/boards/board-asset-sweep');
const ids = require('../../../services/boards/board-ids');
const model = require('../../../services/boards/board-model');
const { hostFailure } = require('../../api-contract');
const { FILE_CAPS, isTeamProjectId } = require('./board-host-files');
const idx = require('./board-host-index');
const journals = require('./board-host-journal');
const { Answer, answers, codeOf, createBoardLoader, stop } = require('./board-host-load');
const { createBoardSweep } = require('./board-host-sweep');

const { LIMITS } = model;
const { INVALID, LIMIT, NOT_FOUND, READ_ONLY, STORAGE, TRASH, UNAVAILABLE } = answers;
const REMOVED_MAX = 1024;
const PROPOSALS_SCHEMA_VERSION = 1;
const SINCE_DEFAULT_BYTES = 512 * 1024;
const SINCE_MAX_BYTES = 2 * 1024 * 1024;
// Model refusals that depend on the board's state, not on the batch's shape: answered `conflict`.
const CONFLICTS = new Set(['stale', 'exists', 'missing_target']);
// The applied operations that take an item off a board (the audit's "bulk removal" count).
const REMOVALS = new Set(['card.remove', 'connector.remove', 'group.remove']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const isRev = (v) => Number.isSafeInteger(v) && v >= 0;
const projectKey = (projectId) => `p:${projectId}`;
const boardKey = (projectId, boardId) => `b:${projectId}/${boardId}`;

/** The model's refusal as a host failure, the model's own words carried beside `error` as `board`. */
function refused(result) {
  const reason = typeof result.reason === 'string' ? result.reason : 'invalid';
  const conflict = CONFLICTS.has(reason) || (reason === 'limit' && result.limit !== 'batch_ops');
  return { ...hostFailure(conflict ? 'conflict' : 'invalid', 'team_board_refused'), board: {
    reason, detail: typeof result.detail === 'string' ? result.detail : null,
    limit: typeof result.limit === 'string' ? result.limit : null,
    index: Number.isInteger(result.op_index) ? result.op_index : null } };
}

function validProposals(list) {
  if (!Array.isArray(list) || list.length > LIMITS.proposals || !list.every(isPlainObject)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(list), 'utf8') <= LIMITS.proposals_bytes;
  } catch {
    return false;
  }
}

function createBoardHostStore({ files, clock, makeId, log, limits, onChange = null, pause }) {
  const queues = new Map();
  const removedAt = new Map(); // project id -> the ticket of its first removeProject
  let tickets = 0;

  /* -------------------------------------------------------------- calls, queues, time */

  async function call(body) {
    try {
      return await body();
    } catch (error) {
      if (error instanceof Answer) return error.answer;
      log('WARN', 'team_board.call_failed', { code: codeOf(error) });
      return UNAVAILABLE();
    }
  }

  function run(key, body) {
    const result = (queues.get(key) || Promise.resolve()).then(body);
    const settled = result.then(() => {}, () => {});
    queues.set(key, settled);
    settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return result;
  }

  const gone = (projectId, ticket) => removedAt.has(projectId) && removedAt.get(projectId) < ticket;

  // The one place a change is announced (slice T3, board-events.js): called inside the board's queue after the
  // write, so announcements leave in rev order whatever path the batch came by. It never fails the call.
  function announce(change) {
    if (typeof onChange !== 'function') return;
    try { onChange(change); } catch { log('WARN', 'team_board.announce_failed', { kind: change.kind }); }
  }

  function nowMs() {
    let value;
    try { value = clock(); } catch { value = Number.NaN; }
    if (!Number.isFinite(value) || value < 0) stop(UNAVAILABLE());
    return value;
  }
  const nowIso = () => new Date(nowMs()).toISOString();

  // Only `null` or `undefined` from the caller's check is "go on": a failure is answered as it is, and any other
  // value (false, 0, '', { ok: true }) is not a verdict this store can read, so it answers unavailable rather than
  // pass.
  const refusalOf = (verdict) => (verdict === null || verdict === undefined ? null
    : isPlainObject(verdict) && verdict.ok === false ? verdict : UNAVAILABLE());

  // `body` after the caller's check. A check that answers at once is followed by `body` in the same stretch: no
  // turn of the event loop, not even a microtask, lies between "allowed" and the writes. Only a promise is waited for.
  function checked(recheck, body) {
    if (recheck === undefined || recheck === null) return body();
    let verdict;
    try { verdict = recheck(); } catch { return UNAVAILABLE(); }
    if (verdict !== null && typeof verdict?.then === 'function') {
      return Promise.resolve(verdict).then((value) => refusalOf(value) ?? body(), () => UNAVAILABLE());
    }
    return refusalOf(verdict) ?? body();
  }

  // The refusal of a mutating call's actor, recheck or audit, before any queue: never defaulted, never skipped.
  const optionalFn = (value) => value === undefined || value === null || typeof value === 'function';
  function mutationRefusal(args) {
    if (!args || !journals.isToken(args.actor)) return INVALID();
    return optionalFn(args.recheck) && optionalFn(args.audit) && optionalFn(args.content) ? null : INVALID();
  }

  // Audit first (slice T5): a caller's `audit(event)` is called inside the board's queue once the change is known
  // to apply and before its first write. `event` is { kind: 'apply', removed } (how many items the batch removes),
  // { kind: 'revert', rev }, { kind: 'remove' }, { kind: 'restore' } or { kind: 'proposals' }. Only `null` or
  // `undefined` lets the write go on: a failure is answered as it is, and a throw or any other value is unavailable.
  function audited(args, event) {
    if (typeof args.audit !== 'function') return;
    let verdict;
    try { verdict = args.audit(event); } catch { stop(UNAVAILABLE()); }
    if (verdict === null || verdict === undefined) return;
    stop(isPlainObject(verdict) && verdict.ok === false ? verdict : UNAVAILABLE());
  }

  const loader = createBoardLoader({ files, log, nowIso });
  const { projects, remember, forget, forgetProject, boardFile, diskBytes, persistIndex, projectOrNull, loadBoard } = loader;

  // The board a call addresses: live (or, with `trash`, in the trash), with its document read.
  function openBoard(projectId, boardId, ticket, { trash = false } = {}) {
    if (!isTeamProjectId(projectId) || !ids.isBoardId(boardId) || gone(projectId, ticket)) stop(NOT_FOUND());
    const boards = projectOrNull(projectId) || stop(NOT_FOUND());
    const entry = boards.get(boardId);
    if (!entry || (entry.deleted_at !== null) !== trash) stop(NOT_FOUND());
    const loaded = loadBoard(projectId, boardId, boards);
    if (loaded.missing) {
      boards.delete(boardId);
      persistIndex(projectId, boards);
      stop(NOT_FOUND());
    }
    return { projectId, boardId, boards, entry, loaded };
  }

  const writable = (opened) => (opened.loaded.readOnly ? stop(READ_ONLY()) : opened.loaded);

  function checkStorage(boards, boardId, nextBytes) {
    const total = idx.totalBytes(boards);
    const next = total - (boards.get(boardId)?.bytes ?? 0) + nextBytes;
    if (next > limits.storageBytes && next > total) stop(STORAGE());
  }

  // The first write of a call: a failure answers unavailable and drops the board's memory.
  function writeFirst(projectId, boardId, kind, serialized) {
    try {
      files.write(boardFile(projectId, boardId, kind), serialized, FILE_CAPS[kind]);
    } catch (error) {
      log('WARN', 'team_board.write_failed', { project_id: projectId, board_id: boardId, file: kind, code: codeOf(error) });
      forget(projectId, boardId);
      stop(UNAVAILABLE());
    }
  }

  // A call on one board: arguments checked first, then the board's queue (and the project's with `project`).
  function onBoard(args, body, options = {}) {
    const ticket = ++tickets;
    const { projectId, boardId, recheck } = args;
    if (!isTeamProjectId(projectId) || !ids.isBoardId(boardId)) return Promise.resolve(NOT_FOUND());
    const inner = () => call(() => checked(recheck, () => body(openBoard(projectId, boardId, ticket, options))));
    return run(boardKey(projectId, boardId), options.project ? () => run(projectKey(projectId), inner) : inner);
  }

  // A read of one board: no queue, nothing written but repairs.
  function readBoard(args, body) {
    const ticket = ++tickets;
    const { projectId, boardId } = args;
    if (!isTeamProjectId(projectId) || !ids.isBoardId(boardId)) return Promise.resolve(NOT_FOUND());
    return call(() => body(openBoard(projectId, boardId, ticket)));
  }

  function applyIn(opened, args, batch) {
    const loaded = writable(opened);
    // A batch the journal still holds was applied: sent again, it is a duplicate past the model's ring of 32 ids too.
    if (journals.isToken(batch.batch_id) && journals.hasBatch(loaded.journal, batch.batch_id)) {
      return { ok: true, rev: loaded.board.rev, applied: null, duplicate: true };
    }
    const now = nowIso();
    // The acting member is the caller, and a restored card's creator is the journal's record, never the batch's.
    const forwarded = { ...batch, board_id: opened.boardId, actor: args.actor,
      ops: journals.withHostAttribution(loaded.journal, batch.ops) };
    delete forwarded.now;
    const result = model.applyBatch(loaded.board, forwarded, { now, authority: true });
    if (!result.ok) return refused(result);
    if (result.duplicate) return { ok: true, rev: loaded.board.rev, applied: null, duplicate: true };
    return commit(opened, args.actor, now, result,
      { kind: 'apply', removed: result.applied.ops.filter((op) => REMOVALS.has(op?.op)).length }, args);
  }

  // The write every applied batch takes, whichever way it came: every check, the caller's audit of `event`, then
  // document, journal, index and the announcement.
  function commit(opened, actor, now, result, event, args) {
    const { projectId, boardId, boards, entry, loaded } = opened;
    const journal = journals.pushEntry(loaded.journal, { rev: result.board.rev, batch_id: result.applied.batch_id, actor,
      at: now, applied: result.applied, inverse: result.inverse });
    // The journal must hold this batch with its way back, or an admin could not revert it (plan 8.6).
    if (result.inverse && !journals.findEntry(journal, result.board.rev)?.inverse) {
      stop(refused({ reason: 'limit', limit: 'journal_bytes' }));
    }
    const documentText = files.serialize(result.board);
    const journalText = files.serialize(journal);
    if (!documentText || !journalText || documentText.bytes > FILE_CAPS.document || journalText.bytes > FILE_CAPS.journal) {
      stop(UNAVAILABLE());
    }
    const proposalsBytes = files.sizeOf(boardFile(projectId, boardId, 'proposals')) ?? 0;
    checkStorage(boards, boardId, documentText.bytes + journalText.bytes + proposalsBytes);
    audited(args, event);
    writeFirst(projectId, boardId, 'document', documentText);
    remember(projectId, boardId, { board: result.board, journal: loaded.journal });
    try {
      files.write(boardFile(projectId, boardId, 'journal'), journalText, FILE_CAPS.journal);
      remember(projectId, boardId, { board: result.board, journal });
    } catch (error) {
      log('WARN', 'team_board.write_failed', { project_id: projectId, board_id: boardId, file: 'journal', code: codeOf(error) });
      forget(projectId, boardId);
    }
    Object.assign(entry, { rev: result.board.rev, name: result.board.name, updated_at: result.board.updated_at,
      bytes: diskBytes(projectId, boardId) });
    persistIndex(projectId, boards);
    // The same item `since` serves for this rev; a batch that renamed the board also changed the list.
    announce({ kind: 'applied', projectId, boardId, renamed: result.board.name !== loaded.board.name,
      item: { rev: result.board.rev, batch_id: result.applied.batch_id, actor, at: now,
        applied: structuredClone(result.applied) } });
    return { ok: true, rev: result.board.rev, applied: structuredClone(result.applied), duplicate: false };
  }

  function newBoardId(projectId, boards) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = `board_${makeId()}`;
      if (ids.isBoardId(id) && !boards.has(id) && !files.exists(boardFile(projectId, id, 'document'))) return id;
    }
    return stop(UNAVAILABLE());
  }

  /* -------------------------------------------------------------- the API */

  async function list(args, deleted = false) {
    const ticket = ++tickets;
    const projectId = args?.projectId;
    if (!isTeamProjectId(projectId)) return NOT_FOUND();
    return call(() => {
      const boards = gone(projectId, ticket) ? null : projectOrNull(projectId);
      return { ok: true, boards: boards ? idx.rows(boards, deleted) : [] };
    });
  }

  async function usage(args) {
    const ticket = ++tickets;
    const projectId = args?.projectId;
    if (!isTeamProjectId(projectId)) return NOT_FOUND();
    return call(() => {
      const boards = (gone(projectId, ticket) ? null : projectOrNull(projectId)) || new Map();
      return { ok: true, bytes: idx.totalBytes(boards), live: idx.liveCount(boards), deleted: boards.size - idx.liveCount(boards) };
    });
  }

  // The board a create stores: an empty one named `name`, or (the import route) what `content({ boardId, now })`
  // answers: { ok: true, board } read by the model again here, with this id and project, rev 0 and no batches.
  // A failure from `content` is answered as it is; a throw or any other value is unavailable.
  function firstBoard({ content, name }, projectId, boardId) {
    const now = nowIso();
    if (typeof content !== 'function') return model.createBoard({ id: boardId, project_id: projectId, name, now });
    let given;
    try { given = content({ boardId, now }); } catch { stop(UNAVAILABLE()); }
    if (!isPlainObject(given) || given.ok !== true) stop(isPlainObject(given) && given.ok === false && given.error ? given : UNAVAILABLE());
    const read = model.normalizeBoard(given.board);
    const framed = read.ok && read.board.id === boardId && read.board.project_id === projectId && read.board.rev === 0
      && read.board.recent_batches.length === 0 && idx.isName(read.board.name);
    return framed ? read : { ok: false };
  }

  async function create(args) {
    const refusal = mutationRefusal(args);
    if (refusal) return refusal;
    const { projectId, actor, recheck, name } = args;
    if (typeof args.content !== 'function' && !idx.isName(name)) return INVALID();
    const ticket = ++tickets;
    if (!isTeamProjectId(projectId)) return NOT_FOUND();
    return run(projectKey(projectId), () => call(() => checked(recheck, () => {
      if (gone(projectId, ticket)) stop(NOT_FOUND());
      const boards = projectOrNull(projectId) || (files.projectState(projectId) === 'missing' ? new Map() : stop(NOT_FOUND()));
      if (idx.liveCount(boards) >= LIMITS.boards_per_project) stop(LIMIT());
      if (boards.size >= limits.boards) stop(STORAGE()); // live and trash together; `remove` keeps the trash under its own cap
      const boardId = newBoardId(projectId, boards);
      const made = firstBoard(args, projectId, boardId);
      if (!made.ok) stop(INVALID());
      const documentText = files.serialize(made.board);
      const entry = idx.entryFromBoard(made.board, actor, documentText.bytes);
      const indexText = files.serialize(idx.toDocument(new Map(boards).set(boardId, entry)));
      if (indexText.bytes > FILE_CAPS.index) stop(STORAGE());
      checkStorage(boards, boardId, documentText.bytes);
      writeFirst(projectId, boardId, 'document', documentText);
      remember(projectId, boardId, { board: made.board, journal: journals.emptyJournal(0) });
      boards.set(boardId, entry);
      projects.set(projectId, boards);
      persistIndex(projectId, boards, indexText);
      log('INFO', 'team_board.created', { project_id: projectId, board_id: boardId });
      announce({ kind: 'list', projectId });
      return { ok: true, board: idx.publicRow(boardId, entry) };
    })));
  }

  function get(args) {
    return readBoard(args || {}, ({ entry, loaded }) => (loaded.readOnly
      ? { ok: true, board: null, rev: entry.rev, read_only: true, reason: loaded.readOnly }
      : { ok: true, board: structuredClone(loaded.board), rev: loaded.board.rev, read_only: false }));
  }

  async function apply(args) {
    const refusal = mutationRefusal(args);
    if (refusal) return refusal;
    if (!isPlainObject(args.batch)) return INVALID();
    return onBoard(args, (opened) => applyIn(opened, args, args.batch));
  }

  // Takes back the batch that made `rev`, while the journal still holds it (slice T5; the caller is a project admin).
  // The inverse is applied operation by operation: one whose item has since changed or gone is skipped and named in
  // `skipped`, the rest lands as one new batch under the caller's name. Nothing left to take back writes nothing.
  async function revert(args) {
    const refusal = mutationRefusal(args);
    if (refusal) return refusal;
    if (!isRev(args.rev) || args.rev < 1) return INVALID();
    return onBoard(args, (opened) => {
      const loaded = writable(opened);
      const inverse = journals.findEntry(loaded.journal, args.rev)?.inverse;
      if (!inverse) stop(NOT_FOUND());
      const now = nowIso();
      // The inverse is the host's own record of that batch: what it restores comes back as recorded, as it is.
      const result = model.applyInverse(loaded.board, { ...inverse, board_id: opened.boardId, actor: args.actor },
        { now, authority: true, batch_id: `revert-${args.rev}-${makeId()}` }); // the id names the rev (journal `history`)
      if (!result.ok) return refused(result);
      const skipped = result.skipped.map((skip) => ({ op: skip.op, id: skip.id, reason: skip.reason }));
      if (result.duplicate || !result.applied.ops.length) return { ok: true, rev: loaded.board.rev, applied: null, skipped };
      return { ...commit(opened, args.actor, now, result, { kind: 'revert', rev: args.rev }, args), skipped };
    });
  }

  async function rename(args) {
    const refusal = mutationRefusal(args);
    if (refusal) return refusal;
    if (!idx.isName(args.name)) return INVALID();
    return onBoard(args, (opened) => applyIn(opened, args,
      { batch_id: `rename-${makeId()}`, ops: [{ op: 'board.rename', name: args.name }] }));
  }

  async function remove(args) {
    const refusal = mutationRefusal(args);
    if (refusal) return refusal;
    return onBoard(args, (opened) => {
      writable(opened);
      if (opened.boards.size - idx.liveCount(opened.boards) >= limits.trash) stop(TRASH());
      audited(args, { kind: 'remove' });
      const deletedAt = nowIso();
      Object.assign(opened.entry, { deleted_at: deletedAt, deleted_by: args.actor });
      if (!persistIndex(opened.projectId, opened.boards)) stop(UNAVAILABLE());
      forget(opened.projectId, opened.boardId);
      log('INFO', 'team_board.removed', { project_id: opened.projectId, board_id: opened.boardId });
      announce({ kind: 'list', projectId: opened.projectId });
      return { ok: true };
    }, { project: true });
  }

  async function restore(args) {
    const refusal = mutationRefusal(args);
    if (refusal) return refusal;
    return onBoard(args, ({ projectId, boardId, boards, entry }) => {
      if (idx.liveCount(boards) >= LIMITS.boards_per_project) stop(LIMIT());
      audited(args, { kind: 'restore' });
      Object.assign(entry, { deleted_at: null, deleted_by: null });
      if (!persistIndex(projectId, boards)) stop(UNAVAILABLE());
      log('INFO', 'team_board.restored', { project_id: projectId, board_id: boardId });
      announce({ kind: 'list', projectId });
      return { ok: true, board: idx.publicRow(boardId, entry) };
    }, { project: true, trash: true });
  }

  async function since(args) {
    const { afterRev, maxBytes = SINCE_DEFAULT_BYTES } = args || {};
    if (!isTeamProjectId(args?.projectId) || !ids.isBoardId(args?.boardId)) return NOT_FOUND();
    if (!isRev(afterRev) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SINCE_MAX_BYTES) return INVALID();
    return readBoard(args, ({ entry, loaded }) => {
      if (loaded.readOnly) return { ok: true, rev: entry.rev, snapshot: true };
      const page = journals.since(loaded.journal, loaded.board.rev, afterRev, maxBytes);
      return page.snapshot ? { ok: true, rev: loaded.board.rev, snapshot: true }
        : { ok: true, rev: loaded.board.rev, batches: structuredClone(page.batches), more: page.more };
    });
  }

  // Who changed the board and how, newest first, in counts (slice T9; board-host-journal.js `history`).
  function history(args) {
    return readBoard(args || {}, ({ entry, loaded }) => (loaded.readOnly ? { ok: true, rev: entry.rev, changes: [] }
      : { ok: true, rev: loaded.board.rev, changes: journals.history(loaded.journal) }));
  }

  function journalEntry(args) {
    return readBoard(args || {}, ({ loaded }) => {
      const entry = !loaded.readOnly && isRev(args.rev) ? journals.findEntry(loaded.journal, args.rev) : null;
      return entry ? { ok: true, entry: structuredClone(entry) } : NOT_FOUND();
    });
  }

  function readProposals(args) {
    return readBoard(args || {}, ({ projectId, boardId }) => {
      const read = files.read(boardFile(projectId, boardId, 'proposals'), FILE_CAPS.proposals);
      if (read.status === 'missing') return { ok: true, proposals: [] };
      const value = read.value;
      if (read.status !== 'ok' || value.schema_version !== PROPOSALS_SCHEMA_VERSION || !validProposals(value.proposals)) {
        return UNAVAILABLE();
      }
      return { ok: true, proposals: value.proposals };
    });
  }

  async function writeProposals(args) {
    const refusal = mutationRefusal(args);
    if (refusal) return refusal;
    if (!validProposals(args.proposals)) return INVALID();
    const serialized = files.serialize({ schema_version: PROPOSALS_SCHEMA_VERSION, proposals: args.proposals });
    if (!serialized) return INVALID();
    return onBoard(args, (opened) => {
      writable(opened);
      const { projectId, boardId, boards, entry } = opened;
      const stored = files.read(boardFile(projectId, boardId, 'proposals'), FILE_CAPS.proposals);
      const version = stored.value?.schema_version;
      // A newer proposals file (or one that cannot be read safely) is never rewritten.
      if (stored.status === 'link' || stored.status === 'transient'
        || (Number.isSafeInteger(version) && version > PROPOSALS_SCHEMA_VERSION)) stop(UNAVAILABLE());
      const others = ['document', 'journal'].reduce((sum, kind) => sum + (files.sizeOf(boardFile(projectId, boardId, kind)) ?? 0), 0);
      checkStorage(boards, boardId, others + serialized.bytes);
      audited(args, { kind: 'proposals' });
      writeFirst(projectId, boardId, 'proposals', serialized);
      entry.bytes = diskBytes(projectId, boardId);
      persistIndex(projectId, boards);
      return { ok: true };
    });
  }

  const sweeper = createBoardSweep({ files, log, loader, nowMs, pause,
    isRemoved: (projectId) => removedAt.has(projectId),
    inProject: (projectId, body) => run(projectKey(projectId), () => call(body)) });
  const sweep = () => call(() => sweeper.sweep());

  async function removeProject(args) {
    const projectId = args?.projectId;
    if (!isTeamProjectId(projectId)) return { ok: true }; // no folder can exist for it
    const ticket = ++tickets;
    removedAt.set(projectId, Math.min(removedAt.get(projectId) ?? ticket, ticket));
    while (removedAt.size > REMOVED_MAX) removedAt.delete(removedAt.keys().next().value);
    const tails = [...queues].filter(([key]) => key === projectKey(projectId) || key.startsWith(`b:${projectId}/`))
      .map(([, tail]) => tail);
    await Promise.all(tails);
    return run(projectKey(projectId), () => call(async () => {
      const result = await files.removeProjectDir(projectId);
      forgetProject(projectId);
      if (result !== 'gone') stop(UNAVAILABLE());
      log('INFO', 'team_board.project_removed', { project_id: projectId });
      return { ok: true };
    }));
  }

  /* -------------------------------------------------------------- picture references (slice T6) */

  const notNewerThan = (version) => (raw) => !(Number.isSafeInteger(raw?.schema_version) && raw.schema_version > version);
  const sameBoard = (projectId, boardId) => (raw) => {
    const normalized = model.normalizeBoard(raw);
    return normalized.ok && normalized.board.id === boardId && normalized.board.project_id === projectId;
  };

  // Adds the `asset` strings of one stored file to `found`. A missing file adds nothing; a file that cannot be read
  // whole, fails `accept`, or is past the walk's bounds stops the scan (a partial view is no view).
  function collectFile(filePath, cap, found, accept = () => true) {
    const read = files.read(filePath, cap);
    if (read.status === 'missing') return;
    if (read.status !== 'ok' || !accept(read.value) || !collectAssetRefs(read.value, found)) stop(UNAVAILABLE());
  }

  // Every picture a project's board files name, from disk: the boards the index lists and every document in the
  // folder (a board the index lost), each with its journal and proposals. Writes nothing: no index repair.
  function scanAssetRefs(projectId) {
    const found = new Set();
    const state = files.projectState(projectId);
    if (state === 'missing' || state === 'clash') return found;
    if (state !== 'ok') stop(state === 'invalid' ? NOT_FOUND() : UNAVAILABLE());
    const index = files.read(files.indexPath(projectId), FILE_CAPS.index);
    if (index.status === 'link' || index.status === 'transient') stop(UNAVAILABLE());
    const parsed = index.status === 'ok' ? idx.readIndex(index.value) : { status: 'damaged', boards: null };
    if (parsed.status === 'newer') stop(UNAVAILABLE());
    let onDisk;
    try { onDisk = files.listAllBoardIds(projectId); } catch { onDisk = null; }
    if (onDisk === null) stop(UNAVAILABLE());
    for (const boardId of new Set([...(parsed.boards ? parsed.boards.keys() : []), ...onDisk])) {
      collectFile(boardFile(projectId, boardId, 'document'), FILE_CAPS.document, found, sameBoard(projectId, boardId));
      collectFile(boardFile(projectId, boardId, 'journal'), FILE_CAPS.journal, found, notNewerThan(journals.JOURNAL_SCHEMA_VERSION));
      collectFile(boardFile(projectId, boardId, 'proposals'), FILE_CAPS.proposals, found);
    }
    return found;
  }

  // { ok, assets: [sorted], result }: `use(set)` is called in the same synchronous stretch as the scan (no await
  // between the first read and its return), so no board write lands between "which pictures are named" and the
  // caller's decision. On any refusal `use` is not called.
  function assetRefs(args) {
    const ticket = ++tickets;
    const projectId = args?.projectId;
    const use = args?.use;
    if (!isTeamProjectId(projectId)) return Promise.resolve(NOT_FOUND());
    if (use !== undefined && typeof use !== 'function') return Promise.resolve(INVALID());
    return call(() => {
      if (gone(projectId, ticket)) stop(NOT_FOUND());
      const assets = [...scanAssetRefs(projectId)].sort();
      if (use === undefined) return { ok: true, assets };
      let result;
      try { result = use(new Set(assets)); } catch { stop(UNAVAILABLE()); }
      return { ok: true, assets, result };
    });
  }

  return Object.freeze({
    list: (args) => list(args, false), listDeleted: (args) => list(args, true), create, get, apply, revert, rename, remove,
    restore, since, history, journalEntry, readProposals, writeProposals, sweep, removeProject, usage, assetRefs,
  });
}

module.exports = { createBoardHostStore };
