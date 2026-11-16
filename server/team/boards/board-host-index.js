'use strict';

// Team boards T1 (row 151, plan PROJECT_BOARD_2026-11-13 section 8.1): a project's board index. Pure: no IO, no clock.
//
//   { schema_version: 1, boards: { <board_id>: { name, rev, created_at, updated_at, created_by, bytes, deleted_at,
//     deleted_by } } }
//
// `bytes` is the sum of the board's three files as last written; `deleted_at` and `deleted_by` are both null for a
// live board and both set for one in the trash. A newer index is refused (the caller never rewrites it); a damaged
// one is rebuilt from the documents on disk by the store.

const ids = require('../../../services/boards/board-ids');
const model = require('../../../services/boards/board-model');
const { isIso, isToken } = require('./board-host-journal');

const INDEX_SCHEMA_VERSION = 1;
const ENTRY_KEYS = Object.freeze(['name', 'rev', 'created_at', 'updated_at', 'created_by', 'bytes', 'deleted_at', 'deleted_by']);
const NAME_MAX = 200;
// The most one entry can take in the stored index (its key, a 200-character name at six bytes a character, three
// stamps, two 200-character tokens, two integers), and so how many boards a project may hold, live and in the trash
// together: with that many the index stays under its file cap whatever a rename or a delete adds to an entry.
const ENTRY_MAX_BYTES = 2048;
const INDEX_FILE_BYTES = 1024 * 1024;
const ENTRIES_MAX = Math.floor((INDEX_FILE_BYTES - 64) / ENTRY_MAX_BYTES);

const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const isRev = (v) => Number.isSafeInteger(v) && v >= 0;
// The model's single-line rule: no control character or line separator, and not empty.
const isName = (v) => model.isLine(v, NAME_MAX, false);
const isNullOr = (check) => (v) => v === null || check(v);

function validEntry(entry) {
  if (!isPlainObject(entry) || Object.keys(entry).length !== ENTRY_KEYS.length
    || !ENTRY_KEYS.every((key) => Object.hasOwn(entry, key))) return false;
  return isName(entry.name) && isRev(entry.rev) && isIso(entry.created_at) && isIso(entry.updated_at)
    && isNullOr(isToken)(entry.created_by) && isRev(entry.bytes) && isNullOr(isIso)(entry.deleted_at)
    && isNullOr(isToken)(entry.deleted_by) && (entry.deleted_at === null) === (entry.deleted_by === null);
}

/** { status: 'ok' | 'newer' | 'damaged', boards: Map<board_id, entry> | null } for a stored index document. */
function readIndex(raw) {
  const version = isPlainObject(raw) ? raw.schema_version : undefined;
  if (Number.isSafeInteger(version) && version > INDEX_SCHEMA_VERSION) return { status: 'newer', boards: null };
  if (!isPlainObject(raw) || version !== INDEX_SCHEMA_VERSION || !isPlainObject(raw.boards)
    || Object.keys(raw).length !== 2) return { status: 'damaged', boards: null };
  const boards = new Map();
  for (const [id, entry] of Object.entries(raw.boards)) {
    if (!ids.isBoardId(id) || !validEntry(entry)) return { status: 'damaged', boards: null };
    boards.set(id, { ...entry });
  }
  return { status: 'ok', boards };
}

function toDocument(boards) {
  const out = {};
  for (const [id, entry] of [...boards].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[id] = { name: entry.name, rev: entry.rev, created_at: entry.created_at, updated_at: entry.updated_at,
      created_by: entry.created_by, bytes: entry.bytes, deleted_at: entry.deleted_at, deleted_by: entry.deleted_by };
  }
  return { schema_version: INDEX_SCHEMA_VERSION, boards: out };
}

/** The author of the board's oldest card, the document's oldest information about who made it; else null. */
function oldestAuthor(board) {
  let oldest = null;
  for (const card of Object.values(board.cards || {})) {
    if (!oldest || card.created_at < oldest.created_at || (card.created_at === oldest.created_at && card.id < oldest.id)) {
      oldest = card;
    }
  }
  return oldest && isToken(oldest.created_by) ? oldest.created_by : null;
}

/** A live entry for a normalized document. */
function entryFromBoard(board, createdBy, bytes) {
  return { name: board.name, rev: board.rev, created_at: board.created_at, updated_at: board.updated_at,
    created_by: createdBy, bytes, deleted_at: null, deleted_by: null };
}

/** A live entry for a document the model refuses: what can be trusted of its raw fields, the rest from `fallback`. */
function entryFromRaw(raw, boardId, stamp, bytes) {
  const value = isPlainObject(raw) ? raw : {};
  return { name: isName(value.name) ? value.name : boardId, rev: isRev(value.rev) ? value.rev : 0,
    created_at: isIso(value.created_at) ? value.created_at : stamp, updated_at: isIso(value.updated_at) ? value.updated_at : stamp,
    created_by: null, bytes, deleted_at: null, deleted_by: null };
}

const byCreated = ([idA, a], [idB, b]) => (a.created_at === b.created_at ? (idA < idB ? -1 : 1) : (a.created_at < b.created_at ? -1 : 1));

function publicRow(id, entry) {
  return { id, name: entry.name, rev: entry.rev, created_at: entry.created_at, updated_at: entry.updated_at,
    created_by: entry.created_by };
}

/** The live rows (or, with `deleted`, the trash rows with their marks), oldest first. */
function rows(boards, deleted = false) {
  return [...boards].filter(([, entry]) => (entry.deleted_at !== null) === deleted).sort(byCreated)
    .map(([id, entry]) => (deleted ? { ...publicRow(id, entry), deleted_at: entry.deleted_at, deleted_by: entry.deleted_by }
      : publicRow(id, entry)));
}

const liveCount = (boards) => [...boards.values()].filter((entry) => entry.deleted_at === null).length;
const totalBytes = (boards) => [...boards.values()].reduce((sum, entry) => sum + entry.bytes, 0);

module.exports = {
  ENTRIES_MAX, ENTRY_MAX_BYTES, INDEX_FILE_BYTES, INDEX_SCHEMA_VERSION, entryFromBoard, entryFromRaw, isName, liveCount, oldestAuthor, publicRow, readIndex, rows,
  toDocument, totalBytes,
};
