'use strict';

// Persistence for project boards (plan PROJECT_BOARD_2026-11-13, section 6.4). IO only: no
// validation of what a document says, no clock, no events (board-service.js owns those).
//
// Flat under <userData>/boards/ because orphan-temp handling takes one directory:
//   <board_id>.json            the document
//   <board_id>.journal.json    the undo journal
//   <board_id>.proposals.json  stored proposals: an opaque list here, capped at 20 and 512 KiB
//   index.json                 the board index (rebuilt by the service when missing or unreadable)
//   <live name>.aside-<ms>     a read-only board's file moved aside (slice B11): never listed, parsed or removed
//                              here; the picture cleanup scans its bytes for picture names (asideAssetRefs)
//
// - A board id passes the pattern in board-ids.js before any path is formed.
// - Writes are persist-then-swap through FileJsonStore.writeImmediate (temp, fsync, rename), as the
//   project note store does, so a failed write leaves the previous file and throws.
// - Reads never follow a link: a link at the boards directory or at a board file reads as `link`,
//   and a file is size-checked before it is parsed.
// - Removal goes through fs-remove-no-follow, refuses a boards directory that is a link (a removal
//   under it would land in the link's target), and takes the document last so a half-done removal
//   still has its document and is retried.
//
// Read results: { status: 'ok' | 'missing' | 'corrupt' | 'unreadable' | 'too_large' | 'link', value }.
// Residual: a local process swapping a file for a link between the lstat and the read is outside
// this guard, as in fs-remove-no-follow.

const fs = require('fs');
const path = require('path');
const { FileJsonStore } = require('../backend/file-json-store');
const { removeFileSync } = require('../fs-remove-no-follow');
const { LIMITS } = require('./board-model');
const ids = require('./board-ids');

const READ_LIMITS = Object.freeze({
  documentReadBytes: 4 * 1024 * 1024,
  journalReadBytes: 2 * 1024 * 1024,
  proposalsReadBytes: 1024 * 1024,
  indexReadBytes: 4 * 1024 * 1024,
});
// The most of one set-aside file the picture cleanup scans; a larger one holds the cleanup (nothing is removed).
const ASIDE_SCAN_BYTES = 16 * 1024 * 1024;
const ASIDE_MARK = '.aside-';
const HEX64_RE = /[0-9a-f]{64}/g;
// Proposals and journal first, the document last: see the header.
const REMOVAL_ORDER = Object.freeze(['proposals', 'journal', 'document']);

function codedError(ErrorType, code) {
  const error = new ErrorType(code === 'invalid_board_id' ? 'invalid board id' : code);
  error.code = code;
  return error;
}

function result(status, value = null) {
  return { status, value };
}

function createBoardStore({
  userDataPath,
  logger = () => {},
  fileStoreFactory = (filePath, options) => new FileJsonStore(filePath, options),
} = {}) {
  if (!userDataPath || typeof userDataPath !== 'string') {
    throw new Error('userDataPath is required for the board store.');
  }
  const root = path.resolve(userDataPath, ids.BOARDS_DIR);
  const storeOptions = { logger, redactReadErrors: true, compact: true };

  function boardFileName(boardId, kind) {
    if (!ids.isBoardId(boardId)) throw codedError(TypeError, 'invalid_board_id');
    return `${boardId}${ids.FILE_SUFFIXES[kind]}`;
  }

  // Belt and braces over the id pattern: the name must stay one entry directly under the root.
  function filePathFor(name) {
    const filePath = path.join(root, name);
    const relative = path.relative(root, filePath);
    if (!relative || relative !== name || path.isAbsolute(relative)) throw codedError(TypeError, 'invalid_board_id');
    return filePath;
  }

  // 'ok', 'missing', or 'unsafe' (a link or not a directory).
  function rootState() {
    try {
      const stat = fs.lstatSync(root);
      return stat.isSymbolicLink() || !stat.isDirectory() ? 'unsafe' : 'ok';
    } catch (error) {
      if (error && error.code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  function readJson(name, maxBytes) {
    let state;
    try {
      state = rootState();
    } catch (_error) {
      return result('unreadable');
    }
    if (state === 'missing') return result('missing');
    if (state === 'unsafe') return result('link');
    const filePath = filePathFor(name);
    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      return result(error && error.code === 'ENOENT' ? 'missing' : 'unreadable');
    }
    if (stat.isSymbolicLink()) return result('link');
    if (!stat.isFile()) return result('corrupt');
    if (stat.size > maxBytes) return result('too_large');
    const read = fileStoreFactory(filePath, storeOptions).readWithStatus(null);
    if (read.missing) return result('missing');
    if (read.corrupted) return result('corrupt');
    if (read.unreadable) return result('unreadable');
    return result('ok', read.value);
  }

  function writeJson(name, value) {
    if (rootState() === 'unsafe') throw codedError(Error, 'boards_root_unsafe');
    // A link at the file itself is replaced by the rename, never written through.
    fileStoreFactory(filePathFor(name), storeOptions).writeImmediate(value);
  }

  function writeProposals(boardId, list) {
    const name = boardFileName(boardId, 'proposals');
    if (!Array.isArray(list) || list.length > LIMITS.proposals
      || Buffer.byteLength(JSON.stringify(list), 'utf8') > LIMITS.proposals_bytes) {
      throw codedError(RangeError, 'proposals_limit');
    }
    writeJson(name, list);
  }

  function listDocumentIds() {
    let entries;
    try {
      if (rootState() !== 'ok') return [];
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_error) {
      return [];
    }
    const found = [];
    for (const entry of entries) {
      const parsed = entry.isFile() ? ids.parseBoardFileName(entry.name) : null;
      if (!parsed || parsed.kind !== 'document') continue;
      try {
        const stat = fs.lstatSync(path.join(root, entry.name));
        if (stat.isFile() && !stat.isSymbolicLink()) found.push({ id: parsed.id, mtimeMs: stat.mtimeMs });
      } catch (_error) {
        // Gone or unreadable since the listing: not a document this pass can use.
      }
    }
    return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  function removeBoardFiles(boardId) {
    const names = REMOVAL_ORDER.map((kind) => [kind, boardFileName(boardId, kind)]);
    let state;
    try {
      state = rootState();
    } catch (_error) {
      return { ok: false, failed: ['root'] };
    }
    if (state === 'missing') return { ok: true, failed: [] };
    if (state === 'unsafe') return { ok: false, failed: ['root'] };
    for (const [kind, name] of names) {
      try {
        removeFileSync(filePathFor(name));
      } catch (error) {
        // Stop here: the document stays until every other file of the board is gone.
        logger('WARN', 'boards.remove_failed', { kind, code: String(error?.code || 'failed') });
        return { ok: false, failed: [kind] };
      }
    }
    return { ok: true, failed: [] };
  }

  // A plain file directly under a boards directory that is no link, whose real path stays in that directory.
  function plainFileInRoot(filePath) {
    try {
      if (rootState() !== 'ok') return false;
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      return path.dirname(fs.realpathSync.native(filePath)) === fs.realpathSync.native(root);
    } catch (_error) {
      return false;
    }
  }

  // The entry's lstat, or null when there is none.
  function lstatOrNull(filePath) {
    try {
      return fs.lstatSync(filePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /** "Show file" (slice B11): the absolute path of a board's document when it is a plain file in the folder, else null. */
  function documentPath(boardId) {
    const filePath = filePathFor(boardFileName(boardId, 'document'));
    return plainFileInRoot(filePath) ? filePath : null;
  }

  /**
   * "Remove from list" (slice B11): renames a board's files to `<name>.aside-<ms>` (then `-1` to `-9` when that name is
   * taken) in the same folder. Nothing is copied, overwritten or deleted, and no link is followed. The document goes
   * first; null when it cannot (a link, no free name, a failed rename), and then nothing was touched. The journal and the
   * proposals file follow when they exist; one that is a link, whose aside name is taken or whose rename fails stays
   * where it is and is named in `failed`. Residual: a name taken between its check and the rename, as for the reads.
   */
  function setAsideFiles(boardId, stampMs) {
    const documentName = boardFileName(boardId, 'document');
    if (!Number.isSafeInteger(stampMs) || stampMs < 0) return null;
    const from = filePathFor(documentName);
    if (!plainFileInRoot(from)) return null;
    let suffix = null;
    try {
      for (let n = 0; n < 10 && !suffix; n += 1) {
        const candidate = `.aside-${stampMs}${n ? `-${n}` : ''}`;
        if (!lstatOrNull(filePathFor(documentName + candidate))) suffix = candidate;
      }
      if (!suffix) return null;
      fs.renameSync(from, filePathFor(documentName + suffix));
    } catch (error) {
      logger('WARN', 'boards.set_aside_failed', { kind: 'document', code: String(error?.code || 'failed') });
      return null;
    }
    const failed = [];
    for (const kind of ['journal', 'proposals']) {
      const name = boardFileName(boardId, kind);
      try {
        const stat = lstatOrNull(filePathFor(name));
        if (!stat) continue;
        if (stat.isSymbolicLink() || !stat.isFile() || lstatOrNull(filePathFor(name + suffix))) throw codedError(Error, 'not_movable');
        fs.renameSync(filePathFor(name), filePathFor(name + suffix));
      } catch (error) {
        logger('WARN', 'boards.set_aside_failed', { kind, code: String(error?.code || 'failed') });
        failed.push(kind);
      }
    }
    return { movedTo: documentName + suffix, failed };
  }

  /**
   * Every run of 64 hex characters in the files set aside in the folder: { ok, refs }. A set-aside board keeps its
   * pictures, and it may be damaged or from a newer Jenny, so the bytes are scanned and nothing is parsed (a run that
   * is no picture name only keeps more). ok is false when a file cannot be read whole; a link is not one of ours and
   * is passed over, never read.
   */
  function asideAssetRefs() {
    const refs = new Set();
    try {
      const state = rootState();
      if (state !== 'ok') return { ok: state === 'missing', refs };
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.name.includes(ASIDE_MARK)) continue;
        const filePath = path.join(root, entry.name);
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (stat.size > ASIDE_SCAN_BYTES) return { ok: false, refs };
        for (const match of fs.readFileSync(filePath, 'latin1').matchAll(HEX64_RE)) refs.add(match[0]);
      }
    } catch (_error) {
      return { ok: false, refs };
    }
    return { ok: true, refs };
  }

  return Object.freeze({
    root,
    limits: READ_LIMITS,
    readDocument: (boardId) => readJson(boardFileName(boardId, 'document'), READ_LIMITS.documentReadBytes),
    writeDocument: (boardId, board) => writeJson(boardFileName(boardId, 'document'), board),
    readJournal: (boardId) => readJson(boardFileName(boardId, 'journal'), READ_LIMITS.journalReadBytes),
    writeJournal: (boardId, journal) => writeJson(boardFileName(boardId, 'journal'), journal),
    readProposals: (boardId) => readJson(boardFileName(boardId, 'proposals'), READ_LIMITS.proposalsReadBytes),
    writeProposals,
    readIndex: () => readJson(ids.INDEX_FILE, READ_LIMITS.indexReadBytes),
    writeIndex: (index) => writeJson(ids.INDEX_FILE, index),
    listDocumentIds,
    removeBoardFiles,
    documentPath,
    setAsideFiles,
    asideAssetRefs,
  });
}

module.exports = { ASIDE_SCAN_BYTES, READ_LIMITS, createBoardStore };
