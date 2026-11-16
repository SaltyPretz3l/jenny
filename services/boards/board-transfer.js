'use strict';

// Export and import of .jennyboard files in the main process (row 150 slice B10, plan PROJECT_BOARD_2026-11-13). The
// format is board-package.js; this file shows the dialogs and does the file IO, so no path ever comes from the renderer
// and the renderer only ever sees a base name.
//
// FRIEND OF board-service.js: storeImportedBoard() below uses the service's internals (_call, _run('index'), _purge,
// _projectKnown, _countLive, _newBoardId, _makeId, _stamp, _storeNewBoard) the way the service's own `create` and
// `duplicate` do, so the index, the cache and the `created` event behave exactly as for a new board. It lives here
// because board-service.js is at its line cap. A change to those internals must be made here too.
//
// - exportFile({ boardId }): get through the service (a read-only board can be exported when it could be read; no
//   board is `unreadable`), its pictures through the asset store's read (one that cannot be read is left out and
//   counted), pack, a save dialog named after the board, then persist-then-rename in the chosen folder (a temp name
//   beside the target; on failure the temp is removed). A folder inside the app's own data is refused `protected`.
// - importFile({ projectId }): an open dialog for one .jennyboard file; anything that is not a regular file (a link,
//   a junction, a directory) is refused `not_file`; the size is refused from lstat before reading and again on the
//   bytes actually read; then unpack, the pictures through the asset store's add (a refusal skips that picture and is
//   counted), and the board through the service. The project must exist and be under its cap, checked in the index
//   queue as create does. A name a live board of the project already has gets " (imported)", then a number.
// - Nothing from a file reaches a log line: sizes, counts and reason codes only.
// Residual, as in board-store.js: a local process swapping the picked file for a link between the lstat and the open.

const crypto = require('crypto');
const nodeFs = require('fs');
const path = require('path');
const { isChildPath } = require('../backend/path-utils');
const { removeFileSync } = require('../fs-remove-no-follow');
const model = require('./board-model');
const ids = require('./board-ids');
const pkg = require('./board-package');
const { MIME_BY_EXT } = require('./board-image-info');

const { LIMITS } = model;
const NAME_MAX = 200;
const FILE_NAME_MAX = 120;
const READ_CHUNK = 1024 * 1024;
const IMPORTED = ' (imported)';
const FILTERS = Object.freeze([{ name: 'Jenny board', extensions: ['jennyboard'] }]);
const EXT_BY_MIME = Object.freeze(Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext])));

const fail = (reason, extra) => (extra ? { ok: false, reason, ...extra } : { ok: false, reason });
const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';
const readArgs = (raw, keys) => (isPlainObject(raw) && Object.keys(raw).every((key) => keys.includes(key)) ? raw : null);
const codeOf = (error) => String(error?.code || error?.name || 'failed').slice(0, 40);

/** The board's name as a file name: no reserved characters, no trailing dot or space, never a device name. */
function safeFileName(name) {
  // eslint-disable-next-line no-control-regex -- control characters are not allowed in a file name.
  let base = String(name || '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim();
  base = base.slice(0, FILE_NAME_MAX).replace(/[. ]+$/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(base)) base = `board ${base}`;
  return base || 'board';
}

// Cuts a name so `suffix` fits in NAME_MAX, never splitting a surrogate pair.
function withSuffix(base, suffix) {
  let cut = base.slice(0, NAME_MAX - suffix.length);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + suffix;
}

function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 1; n < 1000; n += 1) {
    const candidate = withSuffix(base, n === 1 ? IMPORTED : `${IMPORTED} ${n}`);
    if (!taken.has(candidate)) return candidate;
  }
  return withSuffix(base, `${IMPORTED} ${Date.now()}`);
}

/**
 * The friend function (see the header): stores an imported board as `create` stores a new one. Resolves
 * { ok: true, board, skippedPictures } or a refusal; the cap is checked before any picture is stored.
 */
function storeImportedBoard(service, { projectId, text, assets, taken }) {
  return service._call(() => service._run('index', () => {
    service._purge();
    if (!service._projectKnown(projectId)) return fail('not_found');
    if (service._countLive(projectId) >= LIMITS.boards_per_project) return fail('limit', { limit: 'boards_per_project' });
    const unpacked = pkg.unpack(text, { makeId: () => service._makeId(), now: service._stamp(), projectId, newBoardId: service._newBoardId() });
    if (!unpacked.ok) return unpacked;
    let board = unpacked.board;
    const name = uniqueName(board.name, taken);
    if (name !== board.name) {
      const renamed = model.normalizeBoard({ ...board, name });
      if (!renamed.ok) return fail('invalid');
      board = renamed.board;
    }
    let skipped = 0;
    for (const picture of unpacked.pictures) {
      let added;
      try { added = assets.add(picture.bytes); } catch (_error) { added = null; }
      if (!added || added.ok !== true) skipped += 1;
    }
    const stored = service._storeNewBoard(board);
    return stored.ok ? { ok: true, board: stored.board, skippedPictures: skipped } : stored;
  }));
}

function createBoardTransfer({
  getService, getAssets, dialog, fs = nodeFs, now = () => new Date(), makeId = () => crypto.randomUUID(),
  logger = () => {}, protectedRoots = () => [], maxBytes = pkg.PACKAGE_MAX_BYTES,
} = {}) {
  if (typeof getService !== 'function' || typeof getAssets !== 'function' || !dialog) throw new Error('createBoardTransfer requires getService, getAssets and dialog.');
  const log = (level, event, data) => { try { logger(level, event, data); } catch (_error) { /* never fails a call */ } };

  function assetStore() {
    try { return getAssets(); } catch (error) { log('WARN', 'boards.transfer_assets_unavailable', { code: codeOf(error) }); return null; }
  }

  // The pictures the board's image cards name, each once: { assets, missing } or { tooLarge: true }.
  function collectPictures(board) {
    const wanted = [...new Set(Object.values(board.cards).filter((card) => card.kind === 'image').map((card) => card.data.asset))];
    const store = wanted.length ? assetStore() : null;
    const assets = [];
    let missing = 0;
    let estimate = 0;
    for (const asset of wanted) {
      const read = store ? store.read(asset) : null;
      const ext = read && read.ok ? EXT_BY_MIME[read.mime] : undefined;
      if (!ext) { missing += 1; continue; }
      estimate += Math.ceil(read.bytes.byteLength / 3) * 4;
      if (estimate > pkg.PACKAGE_MAX_BYTES) return { tooLarge: true };
      assets.push({ ext, bytes: read.bytes });
    }
    return { assets, missing };
  }

  function isProtected(target) {
    let roots;
    try { roots = protectedRoots() || []; } catch (_error) { roots = []; }
    return roots.some((root) => root && (path.resolve(root) === target || isChildPath(root, target)));
  }

  // Persist-then-rename beside the target; a failure removes the temp and throws.
  function writeWhole(target, text) {
    const temp = `${target}.${String(makeId()).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)}.tmp`;
    const bytes = Buffer.from(text, 'utf8');
    let fd = null;
    try {
      fd = fs.openSync(temp, 'wx');
      let offset = 0;
      while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temp, target);
      return bytes.length;
    } catch (error) {
      if (fd !== null) try { fs.closeSync(fd); } catch (_closeError) { /* already failing */ }
      try { removeFileSync(temp, { fsImpl: fs }); } catch (_removeError) { /* the orphaned-temp sweep takes it */ }
      throw error;
    }
  }

  async function exportFile(raw) {
    const args = readArgs(raw, ['boardId']);
    if (!args || !ids.isBoardId(args.boardId)) return fail('invalid');
    const got = await getService().get({ boardId: args.boardId });
    if (!got || got.ok !== true) return fail(got && typeof got.reason === 'string' ? got.reason : 'not_found');
    if (!got.board) return fail('unreadable');
    const pictures = collectPictures(got.board);
    if (pictures.tooLarge) return fail('too_large');
    const packed = pkg.pack({ board: got.board, assets: pictures.assets, now: now().toISOString() });
    if (!packed.ok) return fail(packed.reason === 'too_large' ? 'too_large' : 'unreadable');
    const picked = await dialog.showSaveDialog({ defaultPath: `${safeFileName(got.board.name)}.jennyboard`, filters: FILTERS });
    if (!picked || picked.canceled || typeof picked.filePath !== 'string' || !picked.filePath) return fail('cancelled');
    const target = path.resolve(picked.filePath);
    if (isProtected(target)) return fail('protected');
    try {
      const bytes = writeWhole(target, packed.text);
      log('INFO', 'boards.export_done', { bytes, pictures: pictures.assets.length, missing: pictures.missing });
    } catch (error) {
      log('WARN', 'boards.export_failed', { code: codeOf(error) });
      return fail('io');
    }
    const name = path.basename(target);
    return pictures.missing ? { ok: true, name, missingPictures: pictures.missing } : { ok: true, name };
  }

  // A regular file read whole, refused past maxBytes from its stat and again on what was read: { ok, text, bytes } | refusal.
  function readBounded(filePath) {
    let stat;
    try { stat = fs.lstatSync(filePath); } catch (_error) { return fail('not_file'); }
    if (stat.isSymbolicLink() || !stat.isFile()) return fail('not_file');
    if (stat.size > maxBytes) return fail('too_large');
    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const opened = fs.fstatSync(fd);
      if (!opened.isFile()) return fail('not_file');
      if (opened.size > maxBytes) return fail('too_large');
      const chunks = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK, maxBytes + 1 - total));
        const read = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (read <= 0) break;
        chunks.push(chunk.subarray(0, read));
        total += read;
        if (total > maxBytes) return fail('too_large');
      }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)); } catch (_error) { return fail('not_json'); }
      return { ok: true, text, bytes: total };
    } catch (error) {
      log('WARN', 'boards.import_read_failed', { code: codeOf(error) });
      return fail('io');
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch (_error) { /* nothing more to do */ }
    }
  }

  async function importFile(raw) {
    const args = readArgs(raw, ['projectId']);
    if (!args || !ids.isProjectId(args.projectId)) return fail('invalid');
    const service = getService();
    const before = await service.list({ projectId: args.projectId });
    if (!before || before.ok !== true) return fail(before && typeof before.reason === 'string' ? before.reason : 'io');
    if (before.boards.length >= LIMITS.boards_per_project) return fail('limit', { limit: 'boards_per_project' });
    const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: FILTERS });
    const filePath = picked && !picked.canceled && Array.isArray(picked.filePaths) ? picked.filePaths[0] : null;
    if (typeof filePath !== 'string' || !filePath) return fail('cancelled');
    const read = readBounded(path.resolve(filePath));
    if (!read.ok) {
      log('INFO', 'boards.import_refused', { reason: read.reason });
      return read;
    }
    const listed = await service.list({ projectId: args.projectId });
    const taken = new Set(listed && listed.ok === true ? listed.boards.map((board) => board.name) : []);
    const assets = assetStore();
    if (!assets) return fail('io');
    const result = await storeImportedBoard(service, { projectId: args.projectId, text: read.text, assets, taken });
    if (result.ok) {
      log('INFO', 'boards.import_done', { bytes: read.bytes, cards: Object.keys(result.board.cards).length, skipped: result.skippedPictures });
    } else {
      log('INFO', 'boards.import_refused', { reason: String(result.reason).slice(0, 40), bytes: read.bytes });
    }
    return result;
  }

  return Object.freeze({ exportFile, importFile });
}

module.exports = { createBoardTransfer };
