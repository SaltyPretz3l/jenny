'use strict';

// The local truth for project boards (plan PROJECT_BOARD_2026-11-13, sections 6.3, 6.4, 6.6, D13):
// the boards API (list, create, get, apply, undo, redo, rename, duplicate, delete, restore and the
// `changed` event) over board-store.js, every board rule from board-model.js. The clock, the id
// maker and the store come in as arguments.
//
// - Every call resolves; a refusal is { ok: false, reason }. isEnabled() false: 'disabled', nothing read.
// - The first call loads index.json (rebuilt from the documents when missing or unreadable),
//   reconciles it with the documents on disk (a restored backup, a crash between a document and an
//   index write) and purges stale tombstones.
// - One board is one serialized queue (`_run`); list, create and the project move share `index`.
// - apply writes the document, then the journal: a crash between them loses an undo step, never a
//   change. An inverse over the journal cap still applies, with undoable: false.
// - Redo is memory only (plan 6.3): REDO_MAX_ENTRIES and REDO_MAX_BYTES a board, REDO_BOARDS boards;
//   a new apply clears it. Normalized boards are cached for CACHE_BOARDS boards (the only writer).
// - A document that fails normalizeBoard is read-only: get says why, every mutation (delete and
//   duplicate too) is refused `read_only`, it is never rewritten or removed, and a project delete
//   moves only its index entry.
// - delete tombstones in the index; the three files go once the tombstone is older than
//   PURGE_AFTER_MS, checked on list, create and the first call after a start.

const { EventEmitter } = require('events');
const model = require('./board-model');
const ids = require('./board-ids');

const { LIMITS } = model;
const PURGE_AFTER_MS = 10 * 60 * 1000;
const INDEX_SCHEMA_VERSION = 1;
const JOURNAL_SCHEMA_VERSION = 1;
const REDO_MAX_ENTRIES = 50;
const REDO_MAX_BYTES = 1024 * 1024;
const REDO_BOARDS = 8;
const CACHE_BOARDS = 4;
const NAME_MAX = 200;
const MAX_ARG_DEPTH = 64;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const fail = (reason, extra) => (extra ? { ok: false, reason, ...extra } : { ok: false, reason });
const INVALID = () => fail('invalid');
const NOT_FOUND = () => fail('not_found');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPlainObject = (v) => isObj(v) && Object.prototype.toString.call(v) === '[object Object]';
const isIso = (v) => typeof v === 'string' && v.length <= 30 && ISO_RE.test(v);
const isRev = (v) => Number.isSafeInteger(v) && v >= 0;
const isName = (v) => typeof v === 'string' && v.length > 0 && v.length <= NAME_MAX;
const isNameArg = (args) => typeof args.name === 'string' && args.name.length <= NAME_MAX;
const codeOf = (error) => String(error?.code || error?.name || 'failed').slice(0, 40);

/** The argument object when it is a plain object holding only `keys`, else null. */
function readArgs(raw, keys) {
  return isPlainObject(raw) && Object.keys(raw).every((key) => keys.includes(key)) ? raw : null;
}

/**
 * An upper bound on the JSON size of untrusted input, walked without stringifying it: -1 past `cap`,
 * -2 nested deeper than MAX_ARG_DEPTH (a cycle too). Strings count UTF-16 units; the model's UTF-8
 * document check stays the authority.
 */
function boundedJsonSize(value, cap) {
  let total = 0;
  const stack = [[value, 0]];
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (depth > MAX_ARG_DEPTH) return -2;
    if (typeof item === 'string') total += item.length + 2;
    else if (item !== null && typeof item === 'object') {
      const isArray = Array.isArray(item);
      for (const key of Object.keys(item)) {
        total += isArray ? 1 : key.length + 4;
        stack.push([item[key], depth + 1]);
      }
      total += 2;
    } else total += 24;
    if (total > cap) return -1;
  }
  return total;
}

function entryOf(board, deletedAt = null) {
  return { id: board.id, project_id: board.project_id, name: board.name, rev: board.rev,
    created_at: board.created_at, updated_at: board.updated_at, deleted_at: deletedAt };
}

function readIndexEntry(id, raw) {
  if (!ids.isBoardId(id) || !isObj(raw) || !ids.isProjectId(raw.project_id) || !isName(raw.name) || !isRev(raw.rev)
    || !isIso(raw.created_at) || !isIso(raw.updated_at) || !(raw.deleted_at === null || isIso(raw.deleted_at))) return null;
  return { id, project_id: raw.project_id, name: raw.name, rev: raw.rev, created_at: raw.created_at,
    updated_at: raw.updated_at, deleted_at: raw.deleted_at };
}

function readJournalEntries(value, boardId) {
  if (!isObj(value) || value.schema_version !== JOURNAL_SCHEMA_VERSION || value.board_id !== boardId
    || !Array.isArray(value.entries)) return [];
  return value.entries.filter((entry) => isObj(entry) && typeof entry.batch_id === 'string' && entry.batch_id.length <= 200
    && isObj(entry.inverse) && Array.isArray(entry.inverse.ops)).slice(-LIMITS.journal_batches);
}

function publicEntry(entry) {
  return { id: entry.id, project_id: entry.project_id, name: entry.name, rev: entry.rev,
    created_at: entry.created_at, updated_at: entry.updated_at };
}

const byCreated = (a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : (a.created_at < b.created_at ? -1 : 1));

class BoardService extends EventEmitter {
  constructor({
    store, now = () => new Date(), makeId, isEnabled = () => true, projectExists = () => true,
    logger = () => {}, journalCaps = null, purgeAfterMs = PURGE_AFTER_MS,
  } = {}) {
    super();
    if (!store || typeof makeId !== 'function') throw new Error('BoardService requires a store and makeId.');
    this._store = store;
    this._now = now;
    this._makeId = makeId;
    this._isEnabled = isEnabled;
    this._projectExists = projectExists;
    this._logger = typeof logger === 'function' ? logger : () => {};
    this._journalCaps = journalCaps;
    this._purgeAfterMs = purgeAfterMs;
    this._index = null; // Map board id -> entry, loaded on the first call
    this._queues = new Map();
    this._cache = new Map(); // board id -> { board, journal }, most recent last
    this._redo = new Map(); // board id -> [{ inverse, bytes }], most recent last
  }

  /* ---------------------------------------------------------------- the boards API */

  list(raw) {
    const args = readArgs(raw, ['projectId']);
    if (!args || !ids.isProjectId(args.projectId)) return this._call(INVALID);
    return this._call(() => this._run('index', () => {
      this._purge();
      const boards = [...this._index.values()]
        .filter((entry) => !entry.deleted_at && entry.project_id === args.projectId).sort(byCreated).map(publicEntry);
      return { ok: true, boards };
    }));
  }

  create(raw) {
    const args = readArgs(raw, ['projectId', 'name']);
    if (!args || !ids.isProjectId(args.projectId) || !isName(args.name)) return this._call(INVALID);
    return this._call(() => this._run('index', () => {
      this._purge();
      if (!this._projectKnown(args.projectId)) return NOT_FOUND();
      if (this._countLive(args.projectId) >= LIMITS.boards_per_project) return fail('limit', { limit: 'boards_per_project' });
      const made = model.createBoard({ id: this._newBoardId(), project_id: args.projectId, name: args.name, now: this._stamp() });
      return made.ok ? this._storeNewBoard(made.board) : made;
    }));
  }

  get(raw) {
    return this._onBoard(raw, [], (args) => {
      const entry = this._index.get(args.boardId);
      if (!entry || entry.deleted_at) return NOT_FOUND();
      const loaded = this._load(args.boardId);
      if (loaded.missing) return NOT_FOUND();
      if (loaded.readOnly) return { ok: true, board: null, readOnly: true, reason: loaded.readOnly };
      return { ok: true, board: loaded.board, readOnly: false, ...this._undoState(args.boardId) };
    });
  }

  apply(raw) {
    // A batch over the document cap is refused before the model ever sees it.
    const shape = readArgs(raw, ['boardId', 'batch']);
    const size = shape && isPlainObject(shape.batch) ? boundedJsonSize(shape.batch, LIMITS.document_bytes) : -2;
    if (size === -1 && ids.isBoardId(shape.boardId)) return this._call(() => fail('limit', { limit: 'document_bytes', op_index: -1 }));
    const valid = () => size >= 0;
    return this._onBoard(raw, ['batch'], (args, board) => {
      const outcome = this._applyBatch(args.boardId, board, { ...args.batch, actor: 'owner' });
      if (outcome.ok && !outcome.duplicate) {
        this._emit({ boardId: args.boardId, projectId: outcome.board.project_id, kind: 'applied', rev: outcome.board.rev, applied: outcome.applied });
      }
      return outcome;
    }, { valid, open: true });
  }

  undo(raw) {
    return this._onBoard(raw, [], (args, board) => this._step(args.boardId, board, 'undo'), { open: true });
  }

  redo(raw) {
    return this._onBoard(raw, [], (args, board) => this._step(args.boardId, board, 'redo'), { open: true });
  }

  rename(raw) {
    return this._onBoard(raw, ['name'], (args, board) => {
      const batch = { batch_id: `rename-${this._makeId()}`, board_id: args.boardId, actor: 'owner',
        ops: [{ op: 'board.rename', name: args.name }] };
      const outcome = this._applyBatch(args.boardId, board, batch);
      if (!outcome.ok) return outcome;
      this._emit({ boardId: args.boardId, projectId: outcome.board.project_id, kind: 'renamed', rev: outcome.board.rev });
      return { ok: true, board: outcome.board };
    }, { valid: isNameArg, open: true });
  }

  duplicate(raw) {
    return this._onBoard(raw, ['name'], (args, board) => {
      if (this._countLive(board.project_id) >= LIMITS.boards_per_project) return fail('limit', { limit: 'boards_per_project' });
      const copy = this._copyBoard(board, args.name);
      return copy.ok ? this._storeNewBoard(copy.board) : copy;
    }, { valid: isNameArg, open: true });
  }

  delete(raw) {
    return this._onBoard(raw, [], (args) => {
      const entry = this._index.get(args.boardId);
      const nowMs = this._nowMs();
      entry.deleted_at = new Date(nowMs).toISOString();
      if (!this._persistIndex()) { entry.deleted_at = null; return fail('io'); }
      this._forget(args.boardId);
      this._emit({ boardId: args.boardId, projectId: entry.project_id, kind: 'deleted', rev: entry.rev });
      return { ok: true, restorableUntil: new Date(nowMs + this._purgeAfterMs).toISOString() };
    }, { open: true });
  }

  restore(raw) {
    return this._onBoard(raw, [], (args) => {
      const entry = this._index.get(args.boardId);
      if (!entry || !entry.deleted_at) return NOT_FOUND();
      if (this._countLive(entry.project_id) >= LIMITS.boards_per_project) return fail('limit');
      const loaded = this._load(args.boardId);
      if (loaded.missing) return NOT_FOUND();
      const deletedAt = entry.deleted_at;
      entry.deleted_at = null;
      if (!this._persistIndex()) { entry.deleted_at = deletedAt; return fail('io'); }
      this._emit({ boardId: args.boardId, projectId: entry.project_id, kind: 'restored', rev: entry.rev });
      return loaded.board ? { ok: true, board: loaded.board } : { ok: true, board: null, readOnly: true, reason: loaded.readOnly };
    });
  }

  /**
   * D13: a deleted project's boards (tombstoned ones too) move to General. Each document is rewritten
   * with the new project_id and the next rev through normalizeBoard (the model has no operation for
   * it); a read-only document keeps its bytes and only its index entry moves. The General cap does
   * not apply: a project delete never fails on it, and create refuses in General until it is under.
   */
  moveProjectBoards(projectId) {
    if (!ids.isProjectId(projectId)) return this._call(INVALID);
    return this._call(() => this._run('index', () => {
      const general = ids.GENERAL_PROJECT_ID;
      const events = [];
      let failed = 0;
      for (const [id, entry] of projectId === general ? [] : this._index) {
        if (entry.project_id !== projectId) continue;
        const loaded = this._load(id);
        if (loaded.board) {
          const next = model.normalizeBoard({ ...loaded.board, project_id: general, rev: loaded.board.rev + 1, updated_at: this._stamp() });
          if (!next.ok || !this._writeDocument(id, next.board)) { failed += 1; continue; }
          this._remember(id, next.board);
          Object.assign(entry, entryOf(next.board, entry.deleted_at));
        } else {
          entry.project_id = general;
        }
        events.push({ boardId: id, projectId: general, kind: 'moved', rev: entry.rev });
      }
      if (events.length) this._persistIndex();
      if (failed) this._log('WARN', 'boards.move_failed', { failed });
      for (const event of events) this._emit(event);
      return { ok: failed === 0, moved: events.length, failed };
    }));
  }

  /** The redo steps held in memory (plan 6.3), for the picture sweep (board-asset-sweep.js): undo can be redone. */
  redoInverses() { return [...this._redo.values()].flatMap((list) => list.map((item) => item.inverse)); }

  /* ---------------------------------------------------------------- calls and queues */

  _call(body) {
    let enabled;
    try { enabled = this._isEnabled() === true; } catch (_error) { enabled = false; }
    if (!enabled) return Promise.resolve(fail('disabled'));
    return Promise.resolve().then(body).catch((error) => {
      this._log('WARN', 'boards.call_failed', { code: codeOf(error) });
      return fail('io');
    });
  }

  _run(key, body) {
    const run = (this._queues.get(key) || Promise.resolve()).then(() => {
      this._ready();
      return body();
    });
    const settled = run.then(() => {}, () => {});
    this._queues.set(key, settled);
    settled.then(() => { if (this._queues.get(key) === settled) this._queues.delete(key); });
    return run;
  }

  // A call on one board: arguments checked first, then the board's queue; `open` hands the body a
  // board that exists, is not deleted and is not read-only.
  _onBoard(raw, extraKeys, body, { valid = () => true, open = false } = {}) {
    const args = readArgs(raw, ['boardId', ...extraKeys]);
    if (!args || !ids.isBoardId(args.boardId) || !valid(args)) return this._call(INVALID);
    return this._call(() => this._run(args.boardId, () => {
      if (!open) return body(args, null);
      const opened = this._open(args.boardId);
      return opened.failure || body(args, opened.board);
    }));
  }

  /* ---------------------------------------------------------------- index */

  _ready() {
    if (this._index) return;
    const index = new Map();
    const read = this._store.readIndex();
    const stored = read.status === 'ok' && isObj(read.value) && read.value.schema_version === INDEX_SCHEMA_VERSION
      && isObj(read.value.boards) ? read.value.boards : null;
    let dirty = !stored && read.status !== 'missing'; // no index and no documents: nothing to write yet
    for (const [id, raw] of Object.entries(stored || {})) {
      const entry = readIndexEntry(id, raw);
      if (entry) index.set(id, entry);
      else dirty = true;
    }
    const documents = this._store.listDocumentIds();
    const present = new Set(documents.map((doc) => doc.id));
    for (const id of [...index.keys()]) {
      if (present.has(id)) continue;
      index.delete(id);
      dirty = true;
    }
    for (const doc of documents) {
      if (index.has(doc.id)) continue;
      index.set(doc.id, this._entryFromDisk(doc));
      dirty = true;
    }
    this._index = index;
    if (dirty) this._persistIndex();
    this._purge();
  }

  // An index entry for a document the index did not list. A document the model refuses keeps what
  // can be trusted of its raw fields; past that it is listed by its file name, in General.
  _entryFromDisk({ id, mtimeMs }) {
    const read = this._store.readDocument(id);
    const normalized = read.status === 'ok' ? model.normalizeBoard(read.value) : null;
    if (normalized && normalized.ok && normalized.board.id === id) return entryOf(normalized.board);
    const raw = read.status === 'ok' && isObj(read.value) ? read.value : {};
    const stamp = new Date(Number.isFinite(mtimeMs) ? mtimeMs : this._nowMs()).toISOString();
    return { id, project_id: ids.isProjectId(raw.project_id) ? raw.project_id : ids.GENERAL_PROJECT_ID,
      name: isName(raw.name) ? raw.name : id, rev: isRev(raw.rev) ? raw.rev : 0,
      created_at: isIso(raw.created_at) ? raw.created_at : stamp, updated_at: isIso(raw.updated_at) ? raw.updated_at : stamp,
      deleted_at: null };
  }

  _persistIndex() {
    const boards = {};
    for (const [id, entry] of this._index) {
      boards[id] = { project_id: entry.project_id, name: entry.name, rev: entry.rev, created_at: entry.created_at,
        updated_at: entry.updated_at, deleted_at: entry.deleted_at };
    }
    try {
      this._store.writeIndex({ schema_version: INDEX_SCHEMA_VERSION, boards });
      return true;
    } catch (error) {
      this._log('WARN', 'boards.index_write_failed', { code: codeOf(error) });
      return false;
    }
  }

  _purge() {
    const cutoff = this._nowMs() - this._purgeAfterMs;
    let changed = false;
    for (const [id, entry] of [...this._index]) {
      if (!entry.deleted_at || Date.parse(entry.deleted_at) > cutoff) continue;
      this._forget(id);
      if (this._load(id).readOnly) {
        // It broke while it waited: never removed, so it comes back to the list read-only.
        entry.deleted_at = null;
        changed = true;
      } else if (this._store.removeBoardFiles(id).ok) {
        this._index.delete(id);
        changed = true;
      }
      this._forget(id);
    }
    if (changed) this._persistIndex();
  }

  _countLive(projectId) {
    let count = 0;
    for (const entry of this._index.values()) if (!entry.deleted_at && entry.project_id === projectId) count += 1;
    return count;
  }

  _projectKnown(projectId) {
    try { return this._projectExists(projectId) !== false; } catch (_error) { return true; }
  }

  _newBoardId() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const id = `board_${this._makeId()}`;
      if (ids.isBoardId(id) && !this._index.has(id)) return id;
    }
    throw Object.assign(new Error('no board id'), { code: 'board_id_unavailable' });
  }

  /* ---------------------------------------------------------------- documents and the journal */

  // { board } | { readOnly: 'corrupt' | 'newer_schema' } | { missing: true }
  _load(id) {
    const cached = this._cache.get(id);
    if (cached) {
      this._remember(id, cached.board);
      return { board: cached.board };
    }
    const read = this._store.readDocument(id);
    if (read.status === 'missing') return { missing: true };
    if (read.status !== 'ok') return { readOnly: 'corrupt' };
    const normalized = model.normalizeBoard(read.value);
    if (normalized.ok && normalized.board.id === id) {
      this._remember(id, normalized.board);
      return { board: normalized.board };
    }
    return { readOnly: normalized.reason === 'newer_schema' ? 'newer_schema' : 'corrupt' };
  }

  _open(id) {
    const entry = this._index.get(id);
    if (!entry || entry.deleted_at) return { failure: NOT_FOUND() };
    const loaded = this._load(id);
    if (loaded.missing) return { failure: NOT_FOUND() };
    return loaded.readOnly ? { failure: fail('read_only') } : { board: loaded.board };
  }

  _remember(id, board) {
    const record = this._cache.get(id) || { board, journal: undefined };
    record.board = board;
    this._cache.delete(id);
    this._cache.set(id, record);
    while (this._cache.size > CACHE_BOARDS) this._cache.delete(this._cache.keys().next().value);
  }

  _forget(id) {
    this._cache.delete(id);
    this._redo.delete(id);
  }

  _journal(id) {
    const record = this._cache.get(id);
    if (record && record.journal) return record.journal;
    const read = this._store.readJournal(id);
    const journal = read.status === 'ok' ? readJournalEntries(read.value, id) : [];
    if (read.status !== 'ok' && read.status !== 'missing') this._log('WARN', 'boards.journal_unreadable', { status: read.status });
    if (record) record.journal = journal;
    return journal;
  }

  _setJournal(id, entries) {
    const record = this._cache.get(id);
    if (record) record.journal = entries;
  }

  _writeJournal(id, entries) {
    try {
      this._store.writeJournal(id, { schema_version: JOURNAL_SCHEMA_VERSION, board_id: id, entries });
      return true;
    } catch (error) {
      this._log('WARN', 'boards.journal_write_failed', { code: codeOf(error) });
      return false;
    }
  }

  // Pushes one undo step; false when it was not kept (over the cap, or the journal write failed).
  _record(id, entry) {
    const pushed = model.pushJournal(this._journal(id), entry, this._journalCaps || undefined);
    if (!pushed.ok || !this._writeJournal(id, pushed.journal)) return false;
    this._setJournal(id, pushed.journal);
    return true;
  }

  _writeDocument(id, board) {
    try {
      this._store.writeDocument(id, board);
      return true;
    } catch (error) {
      this._log('WARN', 'boards.document_write_failed', { code: codeOf(error) });
      return false;
    }
  }

  // Document first; the cache and the index entry follow a write that landed.
  _commit(id, board) {
    if (!this._writeDocument(id, board)) return false;
    this._remember(id, board);
    const entry = this._index.get(id);
    if (entry) Object.assign(entry, entryOf(board, entry.deleted_at));
    this._persistIndex();
    return true;
  }

  _applyBatch(id, board, batch) {
    const result = model.applyBatch(board, batch, { now: this._stamp(), authority: true });
    if (!result.ok) return result;
    if (result.duplicate) {
      return { ok: true, board: result.board, applied: null, duplicate: true,
        undoable: this._journal(id).some((entry) => entry.batch_id === batch.batch_id), ...this._undoState(id) };
    }
    if (!this._commit(id, result.board)) return fail('io');
    this._redo.delete(id);
    const undoable = this._record(id, { batch_id: result.applied.batch_id, at: result.applied.now, inverse: result.inverse });
    return { ok: true, board: result.board, applied: result.applied, undoable, ...this._undoState(id) };
  }

  // Undo applies the newest journal entry's inverse and moves it to redo; redo is the mirror. A step
  // whose every operation was skipped changes nothing on the board and is still used up.
  _step(id, board, direction) {
    const journal = this._journal(id);
    const redo = this._redo.get(id) || [];
    const source = direction === 'undo' ? journal : redo;
    if (!source.length) return fail(direction === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo');
    const result = model.applyInverse(board, source[source.length - 1].inverse,
      { now: this._stamp(), authority: true, batch_id: `${direction}-${this._makeId()}` });
    if (!result.ok) return result;
    if (result.duplicate || !result.applied) return fail('io');
    const changed = result.applied.ops.length > 0;
    if (changed && !this._commit(id, result.board)) return fail('io');
    if (direction === 'undo') {
      // Memory follows the person's act even when the journal write fails; a restart reads the disk.
      this._writeJournal(id, journal.slice(0, -1));
      this._setJournal(id, journal.slice(0, -1));
      if (result.inverse) this._pushRedo(id, result.inverse);
    } else {
      redo.pop();
      if (result.inverse) this._record(id, { batch_id: result.applied.batch_id, at: result.applied.now, inverse: result.inverse });
    }
    if (changed) {
      this._emit({ boardId: id, projectId: result.board.project_id, kind: 'applied', rev: result.board.rev, applied: result.applied });
    }
    return { ok: true, board: result.board, applied: result.applied, skipped: result.skipped, ...this._undoState(id) };
  }

  _pushRedo(id, inverse) {
    const bytes = JSON.stringify(inverse).length;
    if (bytes > REDO_MAX_BYTES) return;
    const list = this._redo.get(id) || [];
    this._redo.delete(id);
    list.push({ inverse, bytes });
    let total = list.reduce((sum, item) => sum + item.bytes, 0);
    while (list.length > REDO_MAX_ENTRIES || total > REDO_MAX_BYTES) total -= list.shift().bytes;
    this._redo.set(id, list);
    while (this._redo.size > REDO_BOARDS) this._redo.delete(this._redo.keys().next().value);
  }

  _undoState(id) {
    return { canUndo: this._journal(id).length > 0, canRedo: (this._redo.get(id) || []).length > 0 };
  }

  // New board id, new item ids, the same aliases (and next_alias), no journal and no proposals.
  _copyBoard(source, name) {
    const fresh = new Map();
    const idFor = (old) => {
      if (!fresh.has(old)) fresh.set(old, this._makeId());
      return fresh.get(old);
    };
    const groups = {};
    for (const group of Object.values(source.groups)) groups[idFor(group.id)] = { ...group, id: idFor(group.id) };
    const cards = {};
    for (const card of Object.values(source.cards)) {
      cards[idFor(card.id)] = { ...card, id: idFor(card.id), group_id: card.group_id === null ? null : idFor(card.group_id), data: { ...card.data } };
    }
    const connectors = {};
    for (const con of Object.values(source.connectors)) {
      connectors[idFor(con.id)] = { ...con, id: idFor(con.id), from: idFor(con.from), to: idFor(con.to) };
    }
    const now = this._stamp();
    return model.normalizeBoard({ ...source, id: this._newBoardId(), name, rev: 0, created_at: now, updated_at: now,
      recent_batches: [], cards, connectors, groups });
  }

  _storeNewBoard(board) {
    if (!this._writeDocument(board.id, board)) return fail('io');
    this._remember(board.id, board);
    this._setJournal(board.id, []);
    this._index.set(board.id, entryOf(board));
    this._persistIndex();
    this._emit({ boardId: board.id, projectId: board.project_id, kind: 'created', rev: board.rev });
    return { ok: true, board };
  }

  /* ---------------------------------------------------------------- edges */

  _nowMs() { return this._now().getTime(); }

  _stamp() { return this._now().toISOString(); }

  _emit(event) {
    try { this.emit('changed', event); } catch (error) { this._log('WARN', 'boards.listener_failed', { code: codeOf(error) }); }
  }

  _log(level, event, data) {
    try { this._logger(level, event, data); } catch (_error) { /* A logger never fails a call. */ }
  }
}

const createBoardService = (options) => new BoardService(options);

module.exports = { BoardService, PURGE_AFTER_MS, REDO_MAX_BYTES, REDO_MAX_ENTRIES, createBoardService };
