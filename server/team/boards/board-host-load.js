'use strict';

// Team boards T1 (row 151): the host board store's memory and its loads from disk, split out of board-host-store.js
// (which owns the calls, queues and writes). A project's index is loaded on first use, reconciled with the documents
// on disk (a document the index does not list is added from the document; an entry whose document is gone is
// dropped) and rebuilt when missing or damaged; a newer index is refused and never rewritten. A board is loaded with
// its journal: a document that fails normalizeBoard, names another board or project, has a newer schema, is a link
// or is too large is `{ readOnly: reason }`; an index entry behind its document is repaired from it. At most
// CACHE_BOARDS boards stay in memory. A refusal is thrown as an `Answer` and answered as it is by the store's call.

const model = require('../../../services/boards/board-model');
const { logCode } = require('../../../services/host/durable-json');
const { hostFailure } = require('../../api-contract');
const { FILE_CAPS } = require('./board-host-files');
const idx = require('./board-host-index');
const journals = require('./board-host-journal');

const CACHE_BOARDS = 8;
const REMOVAL_ORDER = Object.freeze(['proposals', 'journal', 'document']);

const answers = Object.freeze({
  NOT_FOUND: () => hostFailure('forbidden', 'team_board_not_found'),
  INVALID: () => hostFailure('invalid', 'team_board_invalid'),
  LIMIT: () => hostFailure('limit', 'team_board_limit'),
  STORAGE: () => hostFailure('limit', 'team_board_storage_limit'),
  TRASH: () => hostFailure('limit', 'team_board_trash_limit'),
  READ_ONLY: () => hostFailure('conflict', 'team_board_read_only'),
  UNAVAILABLE: () => hostFailure('unavailable', 'team_board_unavailable', '', true),
});
const { NOT_FOUND, UNAVAILABLE } = answers;

const codeOf = (error) => (error?.overCap ? 'over_cap' : logCode(error?.code ?? null) ?? 'failed');

// A refusal thrown inside a call body and answered as it is.
class Answer extends Error {
  constructor(answer) {
    super('answer');
    this.answer = answer;
  }
}
const stop = (answer) => { throw new Answer(answer); };

function createBoardLoader({ files, log, nowIso }) {
  const projects = new Map(); // project id -> Map(board id -> index entry), loaded on first use
  const cache = new Map(); // `${project}/${board}` -> { board, journal } | { readOnly }, most recent last

  const cacheKey = (projectId, boardId) => `${projectId}/${boardId}`;
  function remember(projectId, boardId, value) {
    const key = cacheKey(projectId, boardId);
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > CACHE_BOARDS) cache.delete(cache.keys().next().value);
  }
  const forget = (projectId, boardId) => cache.delete(cacheKey(projectId, boardId));
  function forgetProject(projectId) {
    projects.delete(projectId);
    for (const key of [...cache.keys()]) if (key.startsWith(`${projectId}/`)) cache.delete(key);
  }

  /* -------------------------------------------------------------- index */

  const boardFile = (projectId, boardId, kind) => files.boardPath(projectId, boardId, kind);
  function diskBytes(projectId, boardId) {
    return REMOVAL_ORDER.reduce((sum, kind) => sum + (files.sizeOf(boardFile(projectId, boardId, kind)) ?? 0), 0);
  }

  // Writes the index; false (logged) when it did not land, and the project's memory goes so the next call reads
  // the disk again.
  function persistIndex(projectId, boards, serialized = files.serialize(idx.toDocument(boards))) {
    try {
      files.write(files.indexPath(projectId), serialized, FILE_CAPS.index);
      return true;
    } catch (error) {
      log('WARN', 'team_board.write_failed', { project_id: projectId, file: 'index', code: codeOf(error) });
      forgetProject(projectId);
      return false;
    }
  }

  function checkDocument(raw, projectId, boardId) {
    const normalized = model.normalizeBoard(raw);
    if (!normalized.ok) return { readOnly: normalized.reason === 'newer_schema' ? 'newer_schema' : 'corrupt' };
    if (normalized.board.id !== boardId) return { readOnly: 'corrupt' };
    if (normalized.board.project_id !== projectId) return { readOnly: 'project_mismatch' };
    return { board: normalized.board };
  }

  // An index entry for a document the index did not list (a crash before the index write, a lost index).
  function entryFromDisk(projectId, boardId) {
    const read = files.read(boardFile(projectId, boardId, 'document'), FILE_CAPS.document);
    if (read.status === 'transient') stop(UNAVAILABLE());
    const bytes = diskBytes(projectId, boardId);
    const opened = read.status === 'ok' ? checkDocument(read.value, projectId, boardId) : {};
    if (opened.board) return idx.entryFromBoard(opened.board, idx.oldestAuthor(opened.board), bytes);
    return idx.entryFromRaw(read.value, boardId, nowIso(), bytes);
  }

  function loadIndex(projectId) {
    const known = projects.get(projectId);
    if (known) return known;
    const read = files.read(files.indexPath(projectId), FILE_CAPS.index);
    if (read.status === 'link' || read.status === 'transient') stop(UNAVAILABLE());
    const parsed = read.status === 'ok' ? idx.readIndex(read.value) : { status: read.status, boards: null };
    if (parsed.status === 'newer') {
      log('WARN', 'team_board.index_newer', { project_id: projectId });
      stop(UNAVAILABLE());
    }
    const boards = parsed.boards || new Map();
    let onDisk;
    try { onDisk = files.listAllBoardIds(projectId); } catch { stop(UNAVAILABLE()); }
    if (onDisk === null) {
      // More entries than a listing may hold: "not listed" would not mean "gone", so nothing is dropped or rewritten.
      log('WARN', 'team_board.folder_too_large', { project_id: projectId });
      stop(UNAVAILABLE());
    }
    const present = new Set(onDisk);
    let dirty = parsed.status !== 'ok' && parsed.status !== 'missing';
    for (const id of [...boards.keys()]) {
      if (!present.has(id)) { boards.delete(id); dirty = true; }
    }
    for (const id of onDisk) {
      if (!boards.has(id)) { boards.set(id, entryFromDisk(projectId, id)); dirty = true; }
    }
    if (dirty) {
      log('WARN', 'team_board.index_rebuilt', { project_id: projectId, boards: boards.size });
      persistIndex(projectId, boards);
    }
    projects.set(projectId, boards);
    return boards;
  }

  // The project's index, or null when it has no folder (or only a folder whose name differs by case).
  function projectOrNull(projectId) {
    const state = files.projectState(projectId);
    if (state === 'ok') return loadIndex(projectId);
    forgetProject(projectId);
    if (state === 'missing' || state === 'clash') return null;
    return stop(state === 'invalid' ? NOT_FOUND() : UNAVAILABLE());
  }

  /* -------------------------------------------------------------- boards */

  // An index entry behind its document (a crash before the index write) is repaired from it.
  function repairEntry(projectId, boardId, boards, board) {
    const entry = boards.get(boardId);
    const bytes = diskBytes(projectId, boardId);
    if (!entry || (entry.rev === board.rev && entry.name === board.name && entry.updated_at === board.updated_at
      && entry.bytes === bytes)) return;
    Object.assign(entry, { rev: board.rev, name: board.name, updated_at: board.updated_at, bytes });
    persistIndex(projectId, boards);
  }

  // { board, journal } | { readOnly: reason } | { missing: true }
  function loadBoard(projectId, boardId, boards) {
    const known = cache.get(cacheKey(projectId, boardId));
    if (known) {
      remember(projectId, boardId, known);
      return known;
    }
    const read = files.read(boardFile(projectId, boardId, 'document'), FILE_CAPS.document);
    if (read.status === 'transient') stop(UNAVAILABLE());
    if (read.status === 'missing') return { missing: true };
    let loaded = read.status === 'ok' ? checkDocument(read.value, projectId, boardId)
      : { readOnly: read.status === 'link' ? 'unsafe' : read.status === 'too_large' ? 'too_large' : 'corrupt' };
    if (loaded.board) {
      const stored = files.read(boardFile(projectId, boardId, 'journal'), FILE_CAPS.journal);
      if (stored.status === 'transient') stop(UNAVAILABLE());
      const journal = stored.status === 'link' ? { status: 'link' }
        : journals.readJournal(stored.status === 'ok' ? stored.value : stored.status === 'missing' ? null : false, loaded.board.rev);
      if (journal.status === 'link' || journal.status === 'newer') {
        loaded = { readOnly: journal.status === 'link' ? 'unsafe' : 'newer_schema' };
      } else {
        if (journal.status === 'damaged') log('WARN', 'team_board.journal_damaged', { project_id: projectId, board_id: boardId });
        loaded = { board: loaded.board, journal: journal.journal };
        repairEntry(projectId, boardId, boards, loaded.board);
      }
    }
    if (loaded.readOnly) log('WARN', 'team_board.read_only', { project_id: projectId, board_id: boardId, reason: loaded.readOnly });
    // `unsafe` is also what a path check that could not finish answers (a lock on the folder): never remembered,
    // so the next call looks again.
    if (loaded.readOnly !== 'unsafe') remember(projectId, boardId, loaded);
    return loaded;
  }

  return { projects, remember, forget, forgetProject, boardFile, diskBytes, persistIndex, projectOrNull, loadBoard };
}

module.exports = { Answer, CACHE_BOARDS, REMOVAL_ORDER, answers, codeOf, createBoardLoader, stop };
