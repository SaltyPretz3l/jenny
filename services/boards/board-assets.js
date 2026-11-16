'use strict';

// The picture store for project boards (row 150 slice B7, plan PROJECT_BOARD_2026-11-13 sections 6.1, 6.4 and 6.6):
// <userData>/board-assets/<sha256>.<ext>, shared by every board (the same picture on two boards is one file), and
// unreferenced.json, the small index of when each unreferenced picture was first seen unreferenced. Which pictures
// are referenced, and when one goes, is board-asset-sweep.js; this file is IO only.
//
// - add(bytes): the size is checked before anything is hashed or copied (over the per-picture cap: `too_large`); the
//   type comes from the content only (board-image-info.js: `unsupported`, `dimensions`); the folder's total is
//   checked before a write (`full`). A picture already stored is a success and is not written again, and loses any
//   unreferenced clock. Writing is persist-then-rename through a temp name of FileJsonStore's stamped form
//   (`<name>.<ms>.<12 hex>.tmp`), which the orphaned-temp sweep recognises.
// - read(asset): the name is pattern-checked before any path is formed. A link or junction, at the folder or at a
//   file, is never followed: the folder answers `io`, a file `not_found`. The bytes are checked again by content.
// - Every answer is { ok: true, ... } or { ok: false, reason }; nothing here throws to a caller.
// Residual, as in board-store.js: a local process swapping a file for a link between the lstat and the read.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { FileJsonStore } = require('../backend/file-json-store');
const { renameWithRetrySync } = require('../backend/file-read-retry');
const { removeFileSync } = require('../fs-remove-no-follow');
const { LIMITS } = require('./board-model');
const ids = require('./board-ids');
const { MIME_BY_EXT, imageInfo } = require('./board-image-info');

const INDEX_SCHEMA_VERSION = 1;
const INDEX_MAX_ENTRIES = 20000;
const INDEX_READ_BYTES = 2 * 1024 * 1024;

const fail = (reason) => ({ ok: false, reason });
const codeOf = (error) => String(error?.code || error?.name || 'failed').slice(0, 40);

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function createBoardAssetStore({
  userDataPath,
  logger = () => {},
  maxBytes = LIMITS.image_asset_bytes,
  totalBytes = LIMITS.image_assets_total_bytes,
  fileStoreFactory = (filePath, options) => new FileJsonStore(filePath, options),
} = {}) {
  if (!userDataPath || typeof userDataPath !== 'string') throw new Error('userDataPath is required for the board asset store.');
  const root = path.resolve(userDataPath, ids.BOARD_ASSETS_DIR);
  const indexPath = path.join(root, ids.ASSET_INDEX_FILE);
  const log = (level, event, data) => { try { logger(level, event, data); } catch (_error) { /* never fails a call */ } };

  // 'ok', 'missing', or 'unsafe' (a link or not a directory); throws on any other error.
  function rootState() {
    try {
      const stat = fs.lstatSync(root);
      return stat.isSymbolicLink() || !stat.isDirectory() ? 'unsafe' : 'ok';
    } catch (error) {
      if (error && error.code === 'ENOENT') return 'missing';
      throw error;
    }
  }

  function ensureRoot() {
    if (rootState() === 'missing') fs.mkdirSync(root, { recursive: true });
    if (rootState() !== 'ok') throw Object.assign(new Error('board assets folder is unsafe'), { code: 'assets_root_unsafe' });
  }

  function statOrNull(filePath) {
    try {
      return fs.lstatSync(filePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /** The stored pictures: [{ asset, ext, name, bytes }], plain files only. A link, a temp or any other name is skipped. */
  function list() {
    let entries;
    try {
      if (rootState() !== 'ok') return [];
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (_error) {
      return [];
    }
    const found = [];
    for (const entry of entries) {
      const parsed = ids.parseAssetFileName(entry.name);
      if (!parsed) continue;
      try {
        const stat = fs.lstatSync(path.join(root, entry.name));
        if (stat.isFile() && !stat.isSymbolicLink()) found.push({ ...parsed, name: entry.name, bytes: stat.size });
      } catch (_error) {
        // Gone since the listing.
      }
    }
    return found;
  }

  function writeAtomic(target, bytes) {
    const temp = `${target}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let fd = null;
    try {
      fd = fs.openSync(temp, 'wx');
      let offset = 0;
      while (offset < bytes.byteLength) offset += fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      renameWithRetrySync(temp, target);
    } catch (error) {
      if (fd !== null) try { fs.closeSync(fd); } catch (_closeError) { /* already failing */ }
      try { removeFileSync(temp); } catch (_removeError) { /* the orphaned-temp sweep takes it */ }
      throw error;
    }
  }

  function add(value) {
    const bytes = asBytes(value);
    if (!bytes) return fail('invalid');
    if (bytes.byteLength > maxBytes) return fail('too_large');
    const info = imageInfo(bytes);
    if (!info.ok) return fail(info.reason);
    const asset = crypto.createHash('sha256').update(bytes).digest('hex');
    const name = `${asset}.${info.ext}`;
    const done = { ok: true, asset, ext: info.ext, mime: info.mime, width: info.width, height: info.height, bytes: bytes.byteLength };
    try {
      ensureRoot();
      const target = path.join(root, name);
      const existing = statOrNull(target);
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isFile()) return fail('io');
        forgetClock(asset);
        return done;
      }
      const used = list().reduce((sum, entry) => sum + entry.bytes, 0);
      if (used + bytes.byteLength > totalBytes) return fail('full');
      writeAtomic(target, bytes);
      return done;
    } catch (error) {
      log('WARN', 'boards.asset_write_failed', { code: codeOf(error) });
      return fail('io');
    }
  }

  function read(asset) {
    if (!ids.isAssetId(asset)) return fail('invalid');
    try {
      const state = rootState();
      if (state === 'missing') return fail('not_found');
      if (state === 'unsafe') return fail('io');
      for (const ext of ids.ASSET_EXTENSIONS) {
        const filePath = path.join(root, `${asset}.${ext}`);
        const stat = statOrNull(filePath);
        if (!stat) continue;
        if (stat.isSymbolicLink() || !stat.isFile()) return fail('not_found');
        if (stat.size > maxBytes) return fail('invalid');
        const bytes = fs.readFileSync(filePath);
        const info = imageInfo(bytes);
        if (!info.ok || info.ext !== ext) return fail('invalid');
        return { ok: true, bytes, mime: MIME_BY_EXT[ext] };
      }
      return fail('not_found');
    } catch (error) {
      log('WARN', 'boards.asset_read_failed', { code: codeOf(error) });
      return fail('io');
    }
  }

  /** Removes every stored file of one picture (no link followed); true when none is left. */
  function remove(asset) {
    if (!ids.isAssetId(asset)) return false;
    try {
      if (rootState() !== 'ok') return false;
      for (const ext of ids.ASSET_EXTENSIONS) removeFileSync(path.join(root, `${asset}.${ext}`));
      return true;
    } catch (error) {
      log('WARN', 'boards.asset_remove_failed', { code: codeOf(error) });
      return false;
    }
  }

  /**
   * The unreferenced clocks: { since: { <asset>: <ms> }, rebuilt }. A missing index is empty; a link, an oversize, a
   * corrupt or a foreign file is empty with rebuilt: true (the sweep writes a fresh one). Bounded to INDEX_MAX_ENTRIES.
   */
  function readIndex() {
    const since = {};
    try {
      if (rootState() !== 'ok') return { since, rebuilt: false };
      const stat = statOrNull(indexPath);
      if (!stat) return { since, rebuilt: false };
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > INDEX_READ_BYTES) return { since, rebuilt: true };
      const value = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      if (!value || value.schema_version !== INDEX_SCHEMA_VERSION || !value.since || typeof value.since !== 'object' || Array.isArray(value.since)) {
        return { since, rebuilt: true };
      }
      let count = 0;
      let rebuilt = false;
      for (const [asset, ms] of Object.entries(value.since)) {
        if (count >= INDEX_MAX_ENTRIES || !ids.isAssetId(asset) || !Number.isSafeInteger(ms) || ms < 0) { rebuilt = true; continue; }
        since[asset] = ms;
        count += 1;
      }
      return { since, rebuilt };
    } catch (_error) {
      return { since: {}, rebuilt: true };
    }
  }

  /** Writes the clocks persist-then-swap; false when it could not. A link at the index is replaced, never written through. */
  function writeIndex(since) {
    try {
      ensureRoot();
      const bounded = {};
      for (const [asset, ms] of Object.entries(since || {}).slice(0, INDEX_MAX_ENTRIES)) bounded[asset] = ms;
      fileStoreFactory(indexPath, { logger, redactReadErrors: true, compact: true })
        .writeImmediate({ schema_version: INDEX_SCHEMA_VERSION, since: bounded });
      return true;
    } catch (error) {
      log('WARN', 'boards.asset_index_write_failed', { code: codeOf(error) });
      return false;
    }
  }

  // A picture added again is referenced again (a card is about to name it): its clock starts over.
  function forgetClock(asset) {
    const index = readIndex();
    if (!Object.prototype.hasOwnProperty.call(index.since, asset)) return;
    delete index.since[asset];
    writeIndex(index.since);
  }

  return Object.freeze({ root, add, read, list, remove, readIndex, writeIndex });
}

module.exports = { INDEX_MAX_ENTRIES, createBoardAssetStore };
